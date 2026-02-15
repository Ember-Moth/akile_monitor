// ============================================================
// utils.ts — Akile Monitor Worker 工具函数
// 从原始 Go 项目 tgbot.go 和 main.go 中移植而来
// ============================================================

/**
 * 将字节数格式化为人类可读的字符串
 * 移植自 Go `formatSize`（tgbot.go）
 *
 * @example formatSize(1073741824) => "1.00 GB"
 */
export function formatSize(size: number): string {
  if (size < 0) size = 0;

  const units = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
  let unitIndex = 0;
  let value = size;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  if (unitIndex === 0) {
    return `${value} B`;
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * 从 CPU 描述字符串中解析 CPU 核心数
 * 移植自 Go `parseCPU`（tgbot.go）
 *
 * 期望输入类似 "Intel Xeon 4 Virtual Core" 的字符串，
 * 提取 "Virtual Core" 前面的数字
 *
 * @example parseCPU("Intel(R) Xeon(R) CPU 4 Virtual Core") => 4
 * @example parseCPU("unknown") => 0
 */
export function parseCPU(cpu: string): number {
  const re = /(\d+)\s+Virtual\s+Core/i;
  const matches = cpu.match(re);
  if (matches && matches[1]) {
    const cores = parseInt(matches[1], 10);
    return isNaN(cores) ? 0 : cores;
  }
  return 0;
}

/**
 * 比较两个可能包含字母前缀 + 数字后缀的字符串，用于自然排序
 * 移植自 Go `compareStrings`（main.go）
 *
 * 预期排序示例："HK1" < "HK2" < "HK10" < "US1"
 *
 * @returns 负数表示 str1 < str2，0 表示相等，正数表示 str1 > str2
 */
export function compareStrings(str1: string, str2: string): number {
  // 移除所有空白字符（与 Go 实现保持一致）
  const s1 = str1.replace(/\s+/g, "");
  const s2 = str2.replace(/\s+/g, "");

  const re = /^([a-zA-Z]+)(\d*)$/;
  const matches1 = s1.match(re);
  const matches2 = s2.match(re);

  // 如果任一字符串不匹配预期格式，回退到通用自然排序比较
  if (!matches1 || !matches2) {
    return naturalCompare(s1, s2);
  }

  const letter1 = matches1[1];
  const letter2 = matches2[1];

  // 逐字符比较字母部分
  const minLen = Math.min(letter1.length, letter2.length);
  for (let i = 0; i < minLen; i++) {
    const c1 = letter1.charCodeAt(i);
    const c2 = letter2.charCodeAt(i);
    if (c1 < c2) return -1;
    if (c1 > c2) return 1;
  }

  // 字母部分相同但长度不等时，较短的排在前面
  if (letter1.length < letter2.length) return -1;
  if (letter1.length > letter2.length) return 1;

  // 字母部分完全相同，比较数字后缀
  const num1 = matches1[2] ? parseInt(matches1[2], 10) : 0;
  const num2 = matches2[2] ? parseInt(matches2[2], 10) : 0;

  if (num1 < num2) return -1;
  if (num1 > num2) return 1;

  return 0;
}

/**
 * 通用自然排序比较函数，用于处理不符合简单"字母+数字"模式的字符串
 * 将字符串拆分为字母和数字分段，逐对比较
 */
function naturalCompare(a: string, b: string): number {
  const tokenize = (s: string): (string | number)[] => {
    const tokens: (string | number)[] = [];
    const re = /(\d+)|(\D+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      if (m[1] !== undefined) {
        tokens.push(parseInt(m[1], 10));
      } else {
        tokens.push(m[2]);
      }
    }
    return tokens;
  };

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  const len = Math.min(tokensA.length, tokensB.length);
  for (let i = 0; i < len; i++) {
    const ta = tokensA[i];
    const tb = tokensB[i];

    // 如果两个都是数字，按数值比较
    if (typeof ta === "number" && typeof tb === "number") {
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      continue;
    }

    // 如果类型不同，数字排在字符串前面
    if (typeof ta !== typeof tb) {
      return typeof ta === "number" ? -1 : 1;
    }

    // 两个都是字符串，按字典序比较
    const sa = ta as string;
    const sb = tb as string;
    if (sa < sb) return -1;
    if (sa > sb) return 1;
  }

  // 所有已比较的分段都相等，较短的数组排在前面
  return tokensA.length - tokensB.length;
}

/**
 * 使用与原始 Go 服务端相同的自然排序逻辑，
 * 对包含 `Name`（或 `name`）字段的对象数组进行排序
 */
export function sortByName<T extends { Name?: string; name?: string }>(
  items: T[],
): T[] {
  return items.slice().sort((a, b) => {
    const nameA = a.Name ?? a.name ?? "";
    const nameB = b.Name ?? b.name ?? "";
    return compareStrings(nameA, nameB);
  });
}

/**
 * 计算"流量对等性"百分比 —— 衡量上传和下载流量的均衡程度
 * 100% 表示完全对称
 * 移植自 Go tgbot.go 中的逻辑
 */
export function trafficSymmetry(
  inTransfer: number,
  outTransfer: number,
): string {
  if (inTransfer === 0 && outTransfer === 0) return "N/A";
  if (inTransfer === 0 || outTransfer === 0) return "0.00%";

  const ratio =
    inTransfer > outTransfer
      ? outTransfer / inTransfer
      : inTransfer / outTransfer;

  return `${(ratio * 100).toFixed(2)}%`;
}

/**
 * 将运行时间（秒）格式化为人类可读的字符串
 * 例如 90061 => "1d 1h 1m 1s"
 */
export function formatUptime(seconds: number): string {
  if (seconds < 0) seconds = 0;

  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);

  return parts.join(" ");
}

/**
 * 获取当前 UTC 时间，格式为 "YYYY-MM-DD HH:mm:ss"
 * 用于 Telegram 消息，与 Go 的 "2006-01-02 15:04:05" 格式对应
 */
export function nowUTC(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/**
 * 使用 Web Streams DecompressionStream API（Workers 运行时支持）
 * 解压 gzip 压缩的 ArrayBuffer
 */
export async function decompressGzip(compressed: ArrayBuffer): Promise<string> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // 写入压缩数据并关闭
  writer.write(new Uint8Array(compressed));
  writer.close();

  // 读取所有解压后的分块
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.byteLength;
  }

  // 拼接并解码为字符串
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(result);
}
