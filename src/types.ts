// ============================================================
// types.ts — Akile Monitor Worker 共享类型定义
// 直接映射自原始 Go 项目中 client/model/model.go 的模型
// 以及 main.go 中的服务端结构体
// ============================================================

/**
 * 对应 Go `model.HostState`（client/model/model.go）
 * 监控 Agent 上报的实时系统指标
 */
export interface HostState {
  CPU: number; // CPU 使用率百分比 (0-100)
  MemUsed: number; // 已用内存（字节）
  SwapUsed: number; // 已用交换分区（字节）
  NetInTransfer: number; // 累计网络接收字节数
  NetOutTransfer: number; // 累计网络发送字节数
  NetInSpeed: number; // 当前下载速度（字节/秒）
  NetOutSpeed: number; // 当前上传速度（字节/秒）
  Uptime: number; // 系统运行时间（秒）
  Load1: number; // 1 分钟平均负载
  Load5: number; // 5 分钟平均负载
  Load15: number; // 15 分钟平均负载
}

/**
 * 对应 Go `model.Host`（client/model/model.go）
 * 监控 Agent 上报的静态主机信息
 */
export interface Host {
  Name: string;
  Platform: string;
  PlatformVersion: string;
  CPU: string[]; // 例如 ["Intel Xeon 4 Virtual Core"]
  MemTotal: number; // 总内存（字节）
  SwapTotal: number; // 总交换分区（字节）
  Arch: string; // 例如 "x86_64"
  Virtualization: string; // 例如 "kvm"、"docker"
  BootTime: number; // 上次启动的 Unix 时间戳
}

/**
 * 对应 Go `M` 结构体（main.go）
 * Agent 发送并存储在内存中的完整监控数据包
 */
export interface MonitorData {
  Host: Host;
  State: HostState;
  TimeStamp: number; // Unix 时间戳（秒）
}

/**
 * 对应 Go `Data` 结构体（main.go）
 * 数据库行：以服务器名称为键存储序列化的 MonitorData
 */
export interface DataEntry {
  Name: string;
  Data: string; // JSON 序列化的 MonitorData
}

/**
 * 对应 Go `Host` 结构体（main.go 中文件数据库的版本）
 * 主机元信息 —— 持久化存储在 Durable Object Storage 中的商业/运营信息
 */
export interface HostInfo {
  name: string;
  due_time: number; // 到期时间戳
  buy_url: string; // 购买链接
  seller: string; // 卖家 / 服务商
  price: string; // 价格字符串
}

/**
 * 对应 Go `UpdateRequest`（main.go）
 * POST /info 更新主机元信息的请求体
 */
export interface UpdateInfoRequest {
  auth_secret: string;
  name: string;
  due_time: number;
  buy_url: string;
  seller: string;
  price: string;
}

/**
 * 对应 Go `DeleteHostRequest`（main.go）
 * POST /delete 删除主机的请求体
 */
export interface DeleteHostRequest {
  auth_secret: string;
  name: string;
}

// ============================================================
// Durable Object 内部使用的类型
// ============================================================

/**
 * 附加在 Durable Object 内部 WebSocket 连接上的标签
 * 用于区分 Agent 连接和前端 Viewer 连接
 */
export type WebSocketTag = "agent" | "viewer";

/**
 * 在 wrangler.toml 中声明并由运行时注入的环境变量绑定
 */
export interface Env {
  // Durable Object 绑定
  MONITOR_DO: DurableObjectNamespace;

  // 配置变量（来自 wrangler.toml 的 [vars] 或 secrets）
  AUTH_SECRET: string;
  HOOK_TOKEN: string;
  ENABLE_TG: string; // "true" | "false"
  TG_TOKEN: string;
  TG_CHAT_ID: string; // 数字 Chat ID 的字符串形式
  UPDATE_URI: string; // 默认 "/monitor"
  WEB_URI: string; // 默认 "/ws"
  HOOK_URI: string; // 默认 "/hook"
}

/**
 * Worker fetch 处理器与 Durable Object 之间通信所用的内部消息信封
 */
export interface DORequest {
  action: string;
  [key: string]: unknown;
}

/**
 * Durable Object 数据查询响应的结构
 */
export interface DOResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}
