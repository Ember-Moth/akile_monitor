// ============================================================
// monitor-do.ts — Durable Object: MonitorDO
//
// 这是 Akile Monitor 服务端的有状态核心。
// 它替代了原始 Go 项目中的以下组件：
//   - 内存 SQLite（Data 表）    → this.monitorData Map
//   - 文件 SQLite（Host 表）    → Durable Object Storage
//   - WebSocket /monitor 端点   → 可休眠 WS（标签 "agent"）
//   - WebSocket /ws 端点        → 可休眠 WS（标签 "viewer"）
//   - 离线检测 goroutine        → alarm() API
//
// 架构：
//   Worker fetch() → 获取单例 DO stub → 将请求转发到此处。
//   此 DO 同时处理 WebSocket 升级和 REST 风格的内部 RPC。
// ============================================================

import {
  Env,
  MonitorData,
  HostInfo,
  UpdateInfoRequest,
  DeleteHostRequest,
  DOResponse,
} from "./types";
import { decompressGzip, sortByName, compareStrings } from "./utils";
import { checkOfflineStatus } from "./telegram";

/**
 * MonitorDO — 全局单例 Durable Object 实例，持有所有监控状态，
 * 并管理来自 Agent 和前端 Viewer 的 WebSocket 连接。
 *
 * 使用可休眠 WebSocket API，使 DO 在消息间隙可以从内存中驱逐，
 * 从而节省空闲部署的成本。
 */
export class MonitorDO implements DurableObject {
  // ── 运行时状态（内存中，替代内存 SQLite）──

  /** 服务器名称 → 最新 MonitorData JSON 字符串的映射 */
  private monitorData: Map<string, string> = new Map();

  /** 跟踪哪些服务器已知处于离线状态（用于 TG 通知） */
  private offlineMap: Map<string, boolean> = new Map();

  /** 是否已从持久化存储加载主机信息 */
  private initialized: boolean = false;

  /** 用于跟踪哪些 Agent WebSocket 已完成认证的集合 */
  private authedAgents: Set<WebSocket> = new Set();

  // ── 由运行时注入 ──
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // 恢复上次休眠周期中持久化的内存监控数据（尽力恢复）
    this.state.blockConcurrencyWhile(async () => {
      await this.restoreMonitorSnapshot();
      this.initialized = true;
    });
  }

  // ================================================================
  // fetch() — Worker 转发过来的所有请求的入口
  // ================================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── WebSocket 升级路径 ──
    if (request.headers.get("Upgrade") === "websocket") {
      if (path === "/ws/agent") {
        return this.handleAgentWebSocket(request);
      }
      if (path === "/ws/viewer") {
        return this.handleViewerWebSocket(request);
      }
      return new Response("未知的 WebSocket 路径", { status: 404 });
    }

    // ── 来自 Worker 的内部 REST 风格 RPC ──
    if (request.method === "POST" && path === "/rpc") {
      return this.handleRPC(request);
    }

    return new Response("未找到", { status: 404 });
  }

  // ================================================================
  // WebSocket：Agent 连接（对应原始 Go 的 /monitor）
  // ================================================================

  private handleAgentWebSocket(_request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // 以可休眠模式接受连接；标记为 "agent" + "unauthed"
    this.state.acceptWebSocket(server, ["agent", "unauthed"]);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ================================================================
  // WebSocket：Viewer / 前端连接（对应原始 Go 的 /ws）
  // ================================================================

  private handleViewerWebSocket(_request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // 以可休眠模式接受连接；标记为 "viewer"
    this.state.acceptWebSocket(server, ["viewer"]);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ================================================================
  // 可休眠 WebSocket 事件处理器
  // ================================================================

  /**
   * 当收到 WebSocket 消息时调用（来自 Agent 或 Viewer）
   */
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const tags = this.state.getTags(ws);
    const isAgent = tags.includes("agent");
    const isUnauthed = tags.includes("unauthed");

    // ── Agent 连接 ──
    if (isAgent) {
      // 第一步：认证（第一条消息必须是 auth_secret）
      if (isUnauthed) {
        const text =
          typeof message === "string"
            ? message
            : new TextDecoder().decode(message);

        if (text !== this.env.AUTH_SECRET) {
          console.log("Agent 认证失败，关闭连接");
          ws.close(1008, "auth failed");
          return;
        }

        // 认证成功 — 由于无法在 accept 之后修改标签，
        // 我们使用内存中的 Set 来跟踪已认证的 Agent。
        // 一旦认证通过，后续消息将被放行。
        this.authedAgents.add(ws);

        ws.send("auth success");
        this.ensureAlarm();
        return;
      }

      // 第二步：必须已认证才能发送数据
      if (!this.authedAgents.has(ws)) {
        // 仍标记为未认证但不是第一条消息，不应发生
        ws.close(1008, "auth required");
        return;
      }

      // 第三步：解压 gzip 数据包并存储
      try {
        let jsonStr: string;

        if (typeof message === "string") {
          // 可能是未压缩的数据（不太可能，但优雅处理）
          jsonStr = message;
        } else {
          // 二进制 → gzip 压缩的 JSON（标准 Agent 行为）
          jsonStr = await decompressGzip(message);
        }

        const data: MonitorData = JSON.parse(jsonStr);

        if (!data.Host?.Name) {
          console.error("Agent 消息缺少 Host.Name");
          return;
        }

        // 存储到内存中（替代 SQLite 的 INSERT/UPDATE）
        this.monitorData.set(data.Host.Name, jsonStr);

        // 广播给所有已连接的 Viewer
        this.broadcastToViewers();
      } catch (err) {
        console.error("Agent 消息处理错误:", err);
      }

      return;
    }

    // ── Viewer 连接 ──
    // 原始 Go 行为：Viewer 发送任意消息 → 服务端回复
    // 带 "data: " 前缀的所有当前数据
    if (tags.includes("viewer")) {
      const payload = this.buildViewerPayload();
      try {
        ws.send("data: " + payload);
      } catch (err) {
        console.error("发送给 Viewer 失败:", err);
      }
      return;
    }
  }

  /**
   * 当 WebSocket 关闭时调用
   */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    // 清理已认证 Agent 的跟踪记录
    this.authedAgents.delete(ws);
    ws.close(code, reason);
  }

  /**
   * 当 WebSocket 发生错误时调用
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket 错误:", error);
    this.authedAgents.delete(ws);
    try {
      ws.close(1011, "internal error");
    } catch {
      // 连接已经关闭
    }
  }

  // ================================================================
  // 定时器 — 周期性离线检测（替代 Go goroutine）
  // ================================================================

  /**
   * 定时器每约 20 秒触发一次，执行以下任务：
   * 1. 检测上线/离线状态变化并发送 TG 通知
   * 2. 将 monitorData 快照持久化到 Durable Storage（崩溃恢复）
   * 3. 如果仍有活跃连接，重新调度定时器
   */
  async alarm(): Promise<void> {
    // 1. 离线检测 + Telegram 通知
    if (
      this.env.ENABLE_TG === "true" &&
      this.env.TG_CHAT_ID &&
      this.env.TG_CHAT_ID !== "0"
    ) {
      const monitors = this.getAllMonitorData();
      await checkOfflineStatus(
        monitors,
        this.offlineMap,
        this.env.TG_TOKEN,
        this.env.TG_CHAT_ID,
        60, // 阈值秒数，与 Go 的 60 秒检查保持一致
      );
    }

    // 2. 持久化快照用于崩溃恢复
    await this.persistMonitorSnapshot();

    // 3. 如果仍有已连接的 Socket 或监控数据，重新调度定时器
    const sockets = this.state.getWebSockets();
    if (sockets.length > 0 || this.monitorData.size > 0) {
      this.state.storage.setAlarm(Date.now() + 20_000); // 20 秒
    }
  }

  // ================================================================
  // 内部 RPC 处理器（由 Worker 为 REST 端点调用）
  // ================================================================

  private async handleRPC(request: Request): Promise<Response> {
    try {
      const body = await request.json<{
        action: string;
        [k: string]: unknown;
      }>();

      switch (body.action) {
        case "fetchData":
          return this.rpcFetchData();

        case "getInfo":
          return this.rpcGetInfo();

        case "updateInfo":
          return this.rpcUpdateInfo(body as unknown as UpdateInfoRequest);

        case "deleteHost":
          return this.rpcDeleteHost(body as unknown as DeleteHostRequest);

        default:
          return jsonResponse({ success: false, error: "未知的操作" }, 400);
      }
    } catch (err) {
      console.error("RPC 错误:", err);
      return jsonResponse({ success: false, error: String(err) }, 500);
    }
  }

  /** GET /hook — 以 JSON 数组形式返回所有监控数据 */
  private rpcFetchData(): Response {
    const monitors = this.getAllMonitorData();
    return jsonResponse({ success: true, data: monitors });
  }

  /** GET /info — 从持久化存储返回所有主机元信息 */
  private async rpcGetInfo(): Promise<Response> {
    const allHosts = await this.loadAllHostInfo();
    return jsonResponse({ success: true, data: allHosts });
  }

  /** POST /info — 创建或更新主机元信息 */
  private async rpcUpdateInfo(req: UpdateInfoRequest): Promise<Response> {
    const hostInfo: HostInfo = {
      name: req.name,
      due_time: req.due_time,
      buy_url: req.buy_url,
      seller: req.seller,
      price: req.price,
    };

    await this.state.storage.put(`host:${req.name}`, JSON.stringify(hostInfo));

    return jsonResponse({ success: true, data: "ok" });
  }

  /** POST /delete — 从内存监控数据中移除一台服务器 */
  private async rpcDeleteHost(req: DeleteHostRequest): Promise<Response> {
    const name = req.name;

    if (!this.monitorData.has(name)) {
      return jsonResponse({ success: false, error: "未找到" }, 404);
    }

    this.monitorData.delete(name);
    this.offlineMap.delete(name);

    // 同时移除持久化的快照条目
    await this.state.storage.delete(`monitor:${name}`);

    return jsonResponse({ success: true, data: "ok" });
  }

  // ================================================================
  // 数据辅助方法
  // ================================================================

  /**
   * 从内存 Map 中收集所有 MonitorData 条目，按名称排序
   */
  private getAllMonitorData(): MonitorData[] {
    const entries: { Name: string; data: MonitorData }[] = [];

    for (const [name, jsonStr] of this.monitorData) {
      try {
        const m: MonitorData = JSON.parse(jsonStr);
        entries.push({ Name: name, data: m });
      } catch {
        // 跳过损坏的条目
      }
    }

    // 使用与 Go 服务端相同的自然排序算法
    entries.sort((a, b) => compareStrings(a.Name, b.Name));

    return entries.map((e) => e.data);
  }

  /**
   * 构建发送给 Viewer WebSocket 客户端的 JSON 数据包。
   * 与 Go `fetchData()` 函数的输出格式一致。
   */
  private buildViewerPayload(): string {
    const monitors = this.getAllMonitorData();
    return JSON.stringify(monitors);
  }

  /**
   * 广播当前数据给所有已连接的 Viewer。
   * 每当 Agent 发送新数据时调用，提供实时推送更新给前端。
   */
  private broadcastToViewers(): void {
    const viewers = this.state.getWebSockets("viewer");
    if (viewers.length === 0) return;

    const payload = "data: " + this.buildViewerPayload();

    for (const ws of viewers) {
      try {
        ws.send(payload);
      } catch (err) {
        // 客户端可能已断开连接；将由 webSocketClose 清理
        console.error("广播发送错误:", err);
      }
    }
  }

  /**
   * 从持久化存储加载所有 HostInfo 条目。
   * 键以 "host:" 为前缀。
   */
  private async loadAllHostInfo(): Promise<HostInfo[]> {
    const entries = await this.state.storage.list<string>({
      prefix: "host:",
    });
    const hosts: HostInfo[] = [];

    for (const [, value] of entries) {
      try {
        hosts.push(JSON.parse(value));
      } catch {
        // 跳过损坏的条目
      }
    }

    return hosts;
  }

  // ================================================================
  // 持久化辅助方法（内存监控数据的崩溃恢复）
  // ================================================================

  /**
   * 将当前 monitorData 持久化到 Durable Storage，
   * 以便在 DO 驱逐/重启后存活。
   */
  private async persistMonitorSnapshot(): Promise<void> {
    const puts: Record<string, string> = {};

    for (const [name, jsonStr] of this.monitorData) {
      puts[`monitor:${name}`] = jsonStr;
    }

    if (Object.keys(puts).length > 0) {
      await this.state.storage.put(puts);
    }
  }

  /**
   * 在 DO 初始化时从持久化存储恢复 monitorData。
   * 仅恢复 5 分钟以内的条目，避免在长时间中断后显示过时数据。
   */
  private async restoreMonitorSnapshot(): Promise<void> {
    const entries = await this.state.storage.list<string>({
      prefix: "monitor:",
    });

    const now = Math.floor(Date.now() / 1000);
    const maxAge = 300; // 5 分钟

    for (const [key, value] of entries) {
      try {
        const m: MonitorData = JSON.parse(value);
        if (m.Host?.Name && m.TimeStamp > now - maxAge) {
          this.monitorData.set(m.Host.Name, value);
        } else {
          // 过时数据 — 清理掉
          await this.state.storage.delete(key);
        }
      } catch {
        await this.state.storage.delete(key);
      }
    }
  }

  /**
   * 确保定时器已调度。在第一个 Agent 连接时调用，
   * 或在需要启动离线检测周期时调用。
   */
  private ensureAlarm(): void {
    this.state.storage.getAlarm().then((currentAlarm) => {
      if (currentAlarm === null) {
        this.state.storage.setAlarm(Date.now() + 20_000);
      }
    });
  }
}

// ================================================================
// 辅助函数：JSON 响应构建器
// ================================================================

function jsonResponse(
  body: DOResponse | object,
  status: number = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
