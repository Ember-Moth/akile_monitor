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

// ================================================================
// 常量
// ================================================================

/** monitorData Map 最大条目数，防止无限增长 */
const MONITOR_DATA_MAX_ENTRIES = 500;

/** 恢复快照时的最大存活时间（秒） */
const SNAPSHOT_MAX_AGE_SEC = 300;

/** 定时器间隔（毫秒） */
const ALARM_INTERVAL_MS = 20_000;

/** 离线检测阈值（秒） */
const OFFLINE_THRESHOLD_SEC = 60;

// ================================================================
// WebSocket attachment 类型
// ================================================================

/** 存储在 WebSocket attachment 中的状态，可跨休眠持久化 */
interface AgentAttachment {
  authed: boolean;
}

// ================================================================
// 辅助函数：tryDecompressStringMessage
// ================================================================

/**
 * 当 Go 客户端使用 TextMessage 发送 gzip 二进制数据时，
 * CF Workers 将文本帧以 UTF-8 解码为 string，可能损坏二进制内容。
 *
 * 此函数尝试多种策略从可能损坏的文本消息中提取 JSON：
 *   1. 直接解析为 JSON（如果数据根本未压缩）
 *   2. Latin-1 编码恢复字节 → gzip 解压
 *   3. UTF-8 编码 → gzip 解压（通常失败但作为兜底）
 *
 * @returns 解压/解析后的 JSON 字符串，或 null 表示全部失败
 */
async function tryDecompressStringMessage(
  message: string,
): Promise<string | null> {
  // 策略 1：直接尝试 JSON 解析（未压缩的纯 JSON 文本）
  try {
    JSON.parse(message);
    // 如果成功解析，说明是合法的 JSON 字符串，直接返回
    return message;
  } catch {
    // 不是合法 JSON，继续尝试其他策略
  }

  // 策略 2：将每个字符视为 Latin-1 字节值恢复原始二进制数据
  // 当 UTF-8 解码未严重损坏数据时（低 ASCII 区域），这可能有效
  try {
    const bytes = new Uint8Array(message.length);
    for (let i = 0; i < message.length; i++) {
      bytes[i] = message.charCodeAt(i) & 0xff;
    }
    const jsonStr = await decompressGzip(bytes.buffer as ArrayBuffer);
    // 验证解压结果是否为合法 JSON
    JSON.parse(jsonStr);
    return jsonStr;
  } catch {
    // Latin-1 恢复失败
  }

  // 策略 3：使用 TextEncoder 编码为 UTF-8 字节，再尝试解压
  try {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(message);
    const jsonStr = await decompressGzip(bytes.buffer as ArrayBuffer);
    JSON.parse(jsonStr);
    return jsonStr;
  } catch {
    // UTF-8 编码恢复也失败
  }

  return null;
}

// ================================================================
// MonitorDO 类
// ================================================================

/**
 * MonitorDO — 全局单例 Durable Object 实例，持有所有监控状态，
 * 并管理来自 Agent 和前端 Viewer 的 WebSocket 连接。
 *
 * 使用可休眠 WebSocket API，使 DO 在消息间隙可以从内存中驱逐，
 * 从而节省空闲部署的成本。
 *
 * 认证状态通过 ws.serializeAttachment / ws.deserializeAttachment
 * 持久化，确保 DO 休眠后唤醒时认证状态不丢失。
 */
export class MonitorDO implements DurableObject {
  // ── 运行时状态（内存中，替代内存 SQLite）──

  /** 服务器名称 → 最新 MonitorData JSON 字符串的映射 */
  private monitorData: Map<string, string> = new Map();

  /** 跟踪哪些服务器已知处于离线状态（用于 TG 通知） */
  private offlineMap: Map<string, boolean> = new Map();

  /** 是否已从持久化存储加载数据 */
  private initialized: boolean = false;

  /** 缓存的 Viewer 广播 payload，当 monitorData 更新时置为 null 以失效 */
  private cachedViewerPayload: string | null = null;

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

    // 以可休眠模式接受连接；标记为 "agent"
    this.state.acceptWebSocket(server, ["agent"]);

    // 设置初始 attachment：未认证状态
    // serializeAttachment 将状态持久化，确保跨休眠存活
    server.serializeAttachment({ authed: false } satisfies AgentAttachment);

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
   * 当收到 WebSocket 消息时调用（来自 Agent 或 Viewer）。
   *
   * 认证状态通过 WebSocket attachment 持久化，
   * 确保 DO 休眠后再唤醒时认证信息不丢失。
   */
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const tags = this.state.getTags(ws);
    const isAgent = tags.includes("agent");

    // ── Agent 连接 ──
    if (isAgent) {
      // 从 attachment 中读取认证状态（跨休眠安全）
      const attachment =
        (ws.deserializeAttachment() as AgentAttachment | null) ?? {
          authed: false,
        };

      if (attachment.authed) {
        // 已认证 → 处理监控数据
        await this.handleAgentData(ws, message);
        return;
      }

      // 未认证 → 第一条消息必须是 auth_secret
      const text =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);

      if (text !== this.env.AUTH_SECRET) {
        console.log("Agent 认证失败，关闭连接");
        ws.close(1008, "auth failed");
        return;
      }

      // 认证成功 — 将状态持久化到 attachment 中
      ws.serializeAttachment({ authed: true } satisfies AgentAttachment);
      ws.send("auth success");
      this.ensureAlarm();
      return;
    }

    // ── Viewer 连接 ──
    // 原始 Go 行为：Viewer 发送任意消息 → 服务端回复
    // 带 "data: " 前缀的所有当前数据
    if (tags.includes("viewer")) {
      const payload = this.getViewerPayload();
      try {
        ws.send("data: " + payload);
      } catch (err) {
        console.error("发送给 Viewer 失败:", err);
      }
      return;
    }
  }

  /**
   * 当 WebSocket 关闭时调用。
   *
   * 注意：此回调由运行时在 WS 已经关闭/正在关闭时触发，
   * 不应再次调用 ws.close()，否则会抛出异常。
   */
  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // WebSocket 已经在关闭流程中，不需要再次 close。
    // 仅做清理工作即可。
  }

  /**
   * 当 WebSocket 发生错误时调用
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket 错误:", error);
    try {
      ws.close(1011, "internal error");
    } catch {
      // 连接可能已经关闭，忽略
    }
  }

  // ================================================================
  // Agent 数据处理
  // ================================================================

  /**
   * 处理已认证 Agent 发送的监控数据消息。
   * 支持二进制帧（正确方式）和文本帧（Go 客户端的兼容方式）。
   */
  private async handleAgentData(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    try {
      let jsonStr: string;

      if (typeof message === "string") {
        // Go 客户端使用 websocket.TextMessage 发送 gzip 二进制数据，
        // CF Workers 将文本帧 UTF-8 解码为 string，可能损坏二进制内容。
        // 使用多策略容错解压函数处理。
        const result = await tryDecompressStringMessage(message);
        if (result === null) {
          console.error(
            "Agent 文本消息解压/解析全部失败，丢弃。长度:",
            message.length,
          );
          return;
        }
        jsonStr = result;
      } else {
        // 二进制帧 → gzip 压缩的 JSON（正确的发送方式）
        jsonStr = await decompressGzip(message);
      }

      const data: MonitorData = JSON.parse(jsonStr);

      if (!data.Host?.Name) {
        console.error("Agent 消息缺少 Host.Name");
        return;
      }

      // 检查并执行大小限制
      if (
        !this.monitorData.has(data.Host.Name) &&
        this.monitorData.size >= MONITOR_DATA_MAX_ENTRIES
      ) {
        console.warn(
          `monitorData 已达上限 (${MONITOR_DATA_MAX_ENTRIES})，拒绝新节点: ${data.Host.Name}`,
        );
        return;
      }

      // 存储到内存中（替代 SQLite 的 INSERT/UPDATE）
      this.monitorData.set(data.Host.Name, jsonStr);

      // 使缓存的 Viewer payload 失效
      this.cachedViewerPayload = null;

      // 广播给所有已连接的 Viewer
      this.broadcastToViewers();
    } catch (err) {
      console.error("Agent 消息处理错误:", err);
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
        OFFLINE_THRESHOLD_SEC,
      );
    }

    // 2. 持久化快照用于崩溃恢复
    await this.persistMonitorSnapshot();

    // 3. 如果仍有已连接的 Socket 或监控数据，重新调度定时器
    const sockets = this.state.getWebSockets();
    if (sockets.length > 0 || this.monitorData.size > 0) {
      this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
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
          return doJsonResponse({ success: false, error: "未知的操作" }, 400);
      }
    } catch (err) {
      console.error("RPC 错误:", err);
      return doJsonResponse({ success: false, error: String(err) }, 500);
    }
  }

  /** GET /hook — 以 JSON 数组形式返回所有监控数据 */
  private rpcFetchData(): Response {
    const monitors = this.getAllMonitorData();
    return doJsonResponse({ success: true, data: monitors });
  }

  /** GET /info — 从持久化存储返回所有主机元信息 */
  private async rpcGetInfo(): Promise<Response> {
    const allHosts = await this.loadAllHostInfo();
    return doJsonResponse({ success: true, data: allHosts });
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

    return doJsonResponse({ success: true, data: "ok" });
  }

  /** POST /delete — 从内存监控数据中移除一台服务器 */
  private async rpcDeleteHost(req: DeleteHostRequest): Promise<Response> {
    const name = req.name;

    if (!this.monitorData.has(name)) {
      return doJsonResponse({ success: false, error: "未找到" }, 404);
    }

    this.monitorData.delete(name);
    this.offlineMap.delete(name);

    // 使缓存的 Viewer payload 失效
    this.cachedViewerPayload = null;

    // 同时移除持久化的快照条目
    await this.state.storage.delete(`monitor:${name}`);

    return doJsonResponse({ success: true, data: "ok" });
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
   * 获取 Viewer 广播 payload（带缓存）。
   * 当 monitorData 更新时 cachedViewerPayload 被置 null，
   * 下次调用会重新构建。避免每条 Agent 消息都全量序列化。
   */
  private getViewerPayload(): string {
    if (this.cachedViewerPayload === null) {
      const monitors = this.getAllMonitorData();
      this.cachedViewerPayload = JSON.stringify(monitors);
    }
    return this.cachedViewerPayload;
  }

  /**
   * 广播当前数据给所有已连接的 Viewer。
   * 每当 Agent 发送新数据时调用，提供实时推送更新给前端。
   */
  private broadcastToViewers(): void {
    const viewers = this.state.getWebSockets("viewer");
    if (viewers.length === 0) return;

    const payload = "data: " + this.getViewerPayload();

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
   *
   * 使用批量 put 减少 I/O 次数。
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

    // 收集需要删除的过时条目
    const keysToDelete: string[] = [];

    for (const [key, value] of entries) {
      try {
        const m: MonitorData = JSON.parse(value);
        if (m.Host?.Name && m.TimeStamp > now - SNAPSHOT_MAX_AGE_SEC) {
          this.monitorData.set(m.Host.Name, value);
        } else {
          // 过时数据
          keysToDelete.push(key);
        }
      } catch {
        keysToDelete.push(key);
      }
    }

    // 批量删除过时/损坏的条目
    if (keysToDelete.length > 0) {
      await this.state.storage.delete(keysToDelete);
    }
  }

  /**
   * 确保定时器已调度。在第一个 Agent 连接认证成功时调用。
   * 使用 async/await 替代裸 .then()，附带错误处理。
   */
  private ensureAlarm(): void {
    (async () => {
      try {
        const currentAlarm = await this.state.storage.getAlarm();
        if (currentAlarm === null) {
          await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
        }
      } catch (err) {
        console.error("ensureAlarm 失败:", err);
      }
    })();
  }
}

// ================================================================
// 辅助函数：JSON 响应构建器（DO 内部使用）
// ================================================================

function doJsonResponse(
  body: DOResponse | object,
  status: number = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
