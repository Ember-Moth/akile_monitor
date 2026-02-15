// ============================================================
// index.ts — Cloudflare Worker 入口
//
// 处理 HTTP 路由、CORS、认证，并将请求转发到
// 单例 MonitorDO Durable Object。
//
// 路由映射（对应原始 Go 服务端）：
//   GET  /monitor  → WebSocket 升级 → DO Agent 连接
//   GET  /ws       → WebSocket 升级 → DO Viewer 连接
//   GET  /info     → 主机元信息列表
//   POST /info     → 更新主机元信息（需认证）
//   GET  /hook     → 拉取所有监控数据（需令牌）
//   POST /delete   → 删除主机条目（需认证）
// ============================================================

import { MonitorDO } from "./monitor-do";
import { Env, UpdateInfoRequest, DeleteHostRequest } from "./types";

export { MonitorDO };

// ================================================================
// CORS 辅助函数
// ================================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

/** 为响应添加 CORS 头 */
function corsify(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** 处理 CORS 预检请求 */
function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

// ================================================================
// JSON 响应辅助函数
// ================================================================

/**
 * 构建 JSON 响应并附加 CORS 头。
 * 直接对 data 做 JSON.stringify，与 Go 的 c.JSON(status, data) 行为一致：
 *   - 传入字符串 → 输出 JSON 字符串，如 "ok"
 *   - 传入数组   → 输出 JSON 数组，如 [{...}]
 *   - 传入对象   → 输出 JSON 对象，如 {...}
 */
function jsonResponse(data: unknown, status: number = 200): Response {
  return corsify(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// ================================================================
// Durable Object Stub 辅助函数
// ================================================================

/**
 * 获取单例 MonitorDO 的 stub。
 * 使用固定 ID 名称，确保所有请求都路由到同一个 DO 实例，
 * 该实例持有所有监控状态（与原始 Go 单进程服务端架构一致）。
 */
function getMonitorDO(env: Env): DurableObjectStub {
  const id = env.MONITOR_DO.idFromName("singleton");
  return env.MONITOR_DO.get(id);
}

/**
 * 向 Durable Object 发送内部 RPC 请求
 */
async function doRPC(
  env: Env,
  action: string,
  payload: Record<string, unknown> = {},
): Promise<Response> {
  const stub = getMonitorDO(env);
  const rpcBody = JSON.stringify({ action, ...payload });

  const response = await stub.fetch("https://do/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rpcBody,
  });

  return response;
}

// ================================================================
// 路由：Agent WebSocket 升级（/monitor）
// ================================================================

/** 处理 Agent 的 WebSocket 升级请求 */
async function handleAgentWebSocket(
  request: Request,
  env: Env,
): Promise<Response> {
  // 验证是否为 WebSocket 升级请求
  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return jsonResponse("Expected WebSocket upgrade", 426);
  }

  const stub = getMonitorDO(env);

  // 将 WebSocket 升级请求转发到 Durable Object
  // DO 路径 /ws/agent 用于区分 Agent 连接
  return stub.fetch("https://do/ws/agent", {
    method: "GET",
    headers: request.headers,
  });
}

// ================================================================
// 路由：Viewer WebSocket 升级（/ws）
// ================================================================

/** 处理前端 Viewer 的 WebSocket 升级请求 */
async function handleViewerWebSocket(
  request: Request,
  env: Env,
): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return jsonResponse("Expected WebSocket upgrade", 426);
  }

  const stub = getMonitorDO(env);

  // 将 WebSocket 升级请求转发到 Durable Object
  // DO 路径 /ws/viewer 用于区分 Viewer 连接
  return stub.fetch("https://do/ws/viewer", {
    method: "GET",
    headers: request.headers,
  });
}

// ================================================================
// 路由：GET /info — 获取所有主机元信息列表
// ================================================================

async function handleGetInfo(env: Env): Promise<Response> {
  const doResponse = await doRPC(env, "getInfo");
  const result = await doResponse.json<{
    success: boolean;
    data?: unknown;
    error?: string;
  }>();

  if (!result.success) {
    // 与 Go 一致：出错时返回字符串 "[]" 而非空数组
    // Go 原始代码：c.JSON(200, "[]")
    return jsonResponse("[]");
  }

  // 直接返回数组，与原始 Go 行为一致（c.JSON(200, ret)）
  return jsonResponse(result.data ?? []);
}

// ================================================================
// 路由：POST /info — 更新主机元信息（需认证）
// ================================================================

async function handleUpdateInfo(request: Request, env: Env): Promise<Response> {
  let body: UpdateInfoRequest;

  try {
    body = await request.json<UpdateInfoRequest>();
  } catch {
    // 与 Go 一致：c.JSON(400, "bad request")，返回纯字符串
    return jsonResponse("bad request", 400);
  }

  // 认证检查 — 与 Go 一致：c.JSON(401, "auth failed")
  if (body.auth_secret !== env.AUTH_SECRET) {
    return jsonResponse("auth failed", 401);
  }

  const doResponse = await doRPC(env, "updateInfo", {
    name: body.name,
    due_time: body.due_time,
    buy_url: body.buy_url,
    seller: body.seller,
    price: body.price,
  });

  const result = await doResponse.json<{
    success: boolean;
    data?: unknown;
    error?: string;
  }>();

  if (!result.success) {
    return jsonResponse("internal error", 500);
  }

  // 与 Go 一致：c.JSON(200, "ok")
  return jsonResponse("ok");
}

// ================================================================
// 路由：GET /hook — 拉取所有监控数据（需令牌认证）
// ================================================================

async function handleHook(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  // 与 Go 一致：c.JSON(401, "auth failed")
  if (token !== env.HOOK_TOKEN) {
    return jsonResponse("auth failed", 401);
  }

  const doResponse = await doRPC(env, "fetchData");
  const result = await doResponse.json<{
    success: boolean;
    data?: unknown;
    error?: string;
  }>();

  if (!result.success) {
    return jsonResponse([], 200);
  }

  // 与 Go 一致：c.JSON(200, data)
  // Go 的 fetchData() 返回 []M 的 JSON，c.JSON 直接序列化输出
  // 这里 result.data 已经是 MonitorData[]，直接返回
  return jsonResponse(result.data ?? []);
}

// ================================================================
// 路由：POST /delete — 删除主机条目（需认证）
// ================================================================

async function handleDeleteHost(request: Request, env: Env): Promise<Response> {
  let body: DeleteHostRequest;

  try {
    body = await request.json<DeleteHostRequest>();
  } catch {
    // 与 Go 一致：c.JSON(400, "bad request")
    return jsonResponse("bad request", 400);
  }

  // 与 Go 一致：c.JSON(401, "auth failed")
  if (body.auth_secret !== env.AUTH_SECRET) {
    return jsonResponse("auth failed", 401);
  }

  const doResponse = await doRPC(env, "deleteHost", { name: body.name });
  const result = await doResponse.json<{
    success: boolean;
    data?: unknown;
    error?: string;
  }>();

  if (!result.success) {
    if (doResponse.status === 404) {
      // 与 Go 一致：c.JSON(404, "not found")
      return jsonResponse("not found", 404);
    }
    return jsonResponse("internal error", 500);
  }

  // 与 Go 一致：c.JSON(200, "ok")
  return jsonResponse("ok");
}

// ================================================================
// Worker 主 fetch 处理器 — 路由分发
// ================================================================

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    // 处理 CORS 预检请求
    if (request.method === "OPTIONS") {
      return handleOptions();
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 解析可配置的 URI 路径（带默认值）
    const updateUri = env.UPDATE_URI || "/monitor";
    const webUri = env.WEB_URI || "/ws";
    const hookUri = env.HOOK_URI || "/hook";

    try {
      // ── WebSocket 路由 ──
      if (request.method === "GET" && path === updateUri) {
        return await handleAgentWebSocket(request, env);
      }

      if (request.method === "GET" && path === webUri) {
        return await handleViewerWebSocket(request, env);
      }

      // ── REST API 路由 ──
      if (path === "/info") {
        if (request.method === "GET") {
          return await handleGetInfo(env);
        }
        if (request.method === "POST") {
          return await handleUpdateInfo(request, env);
        }
        return jsonResponse("Method not allowed", 405);
      }

      if (request.method === "GET" && path === hookUri) {
        return await handleHook(request, env);
      }

      if (request.method === "POST" && path === "/delete") {
        return await handleDeleteHost(request, env);
      }

      // ── 健康检查 / 根路径 ──
      if (request.method === "GET" && path === "/") {
        return jsonResponse({
          name: "akile-monitor",
          version: "2.0.0",
          runtime: "cloudflare-workers",
          status: "running",
        });
      }

      // ── 404 兜底 ──
      return corsify(new Response("Not Found", { status: 404 }));
    } catch (err) {
      console.error("未处理的错误:", err);
      return jsonResponse("Internal Server Error", 500);
    }
  },
} satisfies ExportedHandler<Env>;
