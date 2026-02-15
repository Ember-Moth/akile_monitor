// ============================================================
// telegram.ts — Telegram Bot 通知工具
// 从原始 Go 项目 tgbot.go 中移植而来
// ============================================================

import { MonitorData } from "./types";
import {
  formatSize,
  parseCPU,
  trafficSymmetry,
  nowUTC,
  formatUptime,
} from "./utils";

/**
 * 通过 Bot API 向 Telegram 聊天发送文本消息
 *
 * @param token  - Telegram Bot API 令牌
 * @param chatId - 数字聊天 ID（字符串形式）
 * @param text   - 要发送的消息文本
 */
export async function sendTGMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  if (!token || !chatId || chatId === "0") return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: parseInt(chatId, 10),
        text,
        parse_mode: undefined, // 纯文本，与原始 Go 行为保持一致
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`Telegram 发送消息失败: ${resp.status} ${body}`);
    }
  } catch (err) {
    console.error("Telegram 发送消息错误:", err);
  }
}

/**
 * 格式化所有服务器的汇总统计消息
 * 对应 Go 中 `/akall` 命令处理器（tgbot.go）
 *
 * @param monitors - 当前所有 MonitorData 条目的数组
 * @returns 格式化的多行统计字符串
 */
export function formatAllServersMessage(monitors: MonitorData[]): string {
  let online = 0;
  let cpuCores = 0;
  let memTotal = 0;
  let memUsed = 0;
  let swapTotal = 0;
  let swapUsed = 0;
  let downSpeed = 0;
  let upSpeed = 0;
  let downFlow = 0;
  let upFlow = 0;

  const now = Math.floor(Date.now() / 1000);

  for (const m of monitors) {
    if (m.TimeStamp > now - 30) {
      online++;
    }

    if (m.Host?.CPU?.length > 0) {
      cpuCores += parseCPU(m.Host.CPU[0]);
    }

    memTotal += m.Host?.MemTotal ?? 0;
    memUsed += m.State?.MemUsed ?? 0;
    swapTotal += m.Host?.SwapTotal ?? 0;
    swapUsed += m.State?.SwapUsed ?? 0;
    downSpeed += m.State?.NetInSpeed ?? 0;
    upSpeed += m.State?.NetOutSpeed ?? 0;
    downFlow += m.State?.NetInTransfer ?? 0;
    upFlow += m.State?.NetOutTransfer ?? 0;
  }

  const memPercent =
    memTotal > 0 ? ((memUsed / memTotal) * 100).toFixed(2) + "%" : "N/A";
  const swapPercent =
    swapTotal > 0 ? ((swapUsed / swapTotal) * 100).toFixed(2) + "%" : "N/A";

  const duideng = trafficSymmetry(downFlow, upFlow);

  return `统计信息
===========================
服务器数量： ${monitors.length}
在线服务器： ${online}
CPU核心数： ${cpuCores}
内存： ${memPercent} [${formatSize(memUsed)}/${formatSize(memTotal)}]
交换分区： ${swapPercent} [${formatSize(swapUsed)}/${formatSize(swapTotal)}]
下行速度： ↓${formatSize(downSpeed)}/s
上行速度： ↑${formatSize(upSpeed)}/s
下行流量： ↓${formatSize(downFlow)}
上行流量： ↑${formatSize(upFlow)}
流量对等性： ${duideng}

更新于：${nowUTC()} UTC`;
}

/**
 * 格式化单个服务器的状态消息
 * 对应 Go `formatServerMessage`（tgbot.go）
 *
 * @param serverName - 服务器显示名称
 * @param m          - 该服务器的 MonitorData
 * @returns 格式化的状态字符串
 */
export function formatServerMessage(
  serverName: string,
  m: MonitorData,
): string {
  const host = m.Host;
  const state = m.State;

  const cpuCores = host?.CPU?.length > 0 ? parseCPU(host.CPU[0]) : 0;

  const memTotal = host?.MemTotal ?? 0;
  const memUsed = state?.MemUsed ?? 0;
  const swapTotal = host?.SwapTotal ?? 0;
  const swapUsed = state?.SwapUsed ?? 0;

  const memPercent =
    memTotal > 0 ? ((memUsed / memTotal) * 100).toFixed(2) + "%" : "N/A";
  const swapPercent =
    swapTotal > 0 ? ((swapUsed / swapTotal) * 100).toFixed(2) + "%" : "N/A";

  const duideng = trafficSymmetry(
    state?.NetInTransfer ?? 0,
    state?.NetOutTransfer ?? 0,
  );

  return `服务器: ${serverName}
CPU核心数: ${cpuCores}
内存: ${memPercent} [${formatSize(memUsed)}/${formatSize(memTotal)}]
交换分区: ${swapPercent} [${formatSize(swapUsed)}/${formatSize(swapTotal)}]
下行速度: ↓${formatSize(state?.NetInSpeed ?? 0)}/s
上行速度: ↑${formatSize(state?.NetOutSpeed ?? 0)}/s
下行流量: ↓${formatSize(state?.NetInTransfer ?? 0)}
上行流量: ↑${formatSize(state?.NetOutTransfer ?? 0)}
流量对等性: ${duideng}
运行时间: ${formatUptime(state?.Uptime ?? 0)}

更新于: ${nowUTC()} UTC`;
}

/**
 * 构建离线通知消息
 *
 * @param name - 服务器名称
 * @returns 带 ❌ 表情的通知字符串
 */
export function offlineMessage(name: string): string {
  return `❌ ${name} 离线了`;
}

/**
 * 构建上线通知消息
 *
 * @param name - 服务器名称
 * @returns 带 ✅ 表情的通知字符串
 */
export function onlineMessage(name: string): string {
  return `✅ ${name} 上线了`;
}

/**
 * 处理所有当前 MonitorData 条目，检测上线/离线状态变化。
 * 对任何状态变更发送 Telegram 通知。
 *
 * 此函数替代原始 Go main.go 中每 20 秒轮询一次的 goroutine。
 * 在 Worker 架构中，由 Durable Object 的 alarm() 调用。
 *
 * @param monitors     - 当前 MonitorData 条目数组
 * @param offlineMap   - 可变映射，跟踪已知离线的服务器（名称 -> 布尔值）
 * @param token        - Telegram Bot API 令牌
 * @param chatId       - 通知目标聊天 ID
 * @param thresholdSec - 超过多少秒无更新视为离线（默认 60）
 */
export async function checkOfflineStatus(
  monitors: MonitorData[],
  offlineMap: Map<string, boolean>,
  token: string,
  chatId: string,
  thresholdSec: number = 60,
): Promise<void> {
  if (!token || !chatId || chatId === "0") return;

  const now = Math.floor(Date.now() / 1000);

  const notifications: Promise<void>[] = [];

  for (const m of monitors) {
    const name = m.Host?.Name;
    if (!name) continue;

    const isStale = m.TimeStamp < now - thresholdSec;

    if (isStale) {
      // 服务器疑似离线
      if (!offlineMap.get(name)) {
        offlineMap.set(name, true);
        notifications.push(sendTGMessage(token, chatId, offlineMessage(name)));
      }
    } else {
      // 服务器在线
      if (offlineMap.get(name)) {
        offlineMap.delete(name);
        notifications.push(sendTGMessage(token, chatId, onlineMessage(name)));
      }
    }
  }

  // 并发发送所有通知
  if (notifications.length > 0) {
    await Promise.allSettled(notifications);
  }
}
