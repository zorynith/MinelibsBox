import { getSetting } from "./db";

/**
 * 复刻 001 `size_format($bytes, $precision = 2)`：
 * 单位表 PB/TB/GB/MB/kB/'B '（'B ' 带一个尾随空格），按单位降序取第一个
 * `bytes >= 单位基数` 的分支，`round(bytes / 基数, precision)` 与单位用空格拼接。
 */
export function sizeFormat(bytes: number, precision = 2): string {
  if (bytes == 0) return "0 B";
  const units: [string, number][] = [
    ["PB", 1099511627776 * 1024],
    ["TB", 1099511627776],
    ["GB", 1073741824],
    ["MB", 1048576],
    ["kB", 1024],
    ["B ", 1],
  ];
  for (const [unit, mag] of units) {
    if (bytes >= mag) {
      const f = Math.pow(10, precision);
      return Math.round((bytes / mag) * f) / f + " " + unit;
    }
  }
  return "";
}

/**
 * 读取 filter/limit 相关配置项（单位为 GB 的数值），换算为字节数。
 * 与 001 `floatval($config['settings'][$key]) * 1024 * 1024 * 1024` 一致；
 * 未配置或为 0 时返回 0（表示不做限制）。
 */
export async function gbLimit(db: D1Database, key: string): Promise<number> {
  const raw = await getSetting(db, key);
  const gb = parseFloat(raw ?? "0");
  if (!gb || Number.isNaN(gb)) return 0;
  return gb * 1024 * 1024 * 1024;
}
