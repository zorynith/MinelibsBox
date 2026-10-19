/** 时间戳工具：001 前端 dateShow/dateFormat 期望 Unix 秒。 */

/** 当前 Unix 秒。 */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 将 Date / 毫秒数 / 秒数 / ISO 字符串 / D1 datetime("YYYY-MM-DD HH:MM:SS") 统一转为 Unix 秒。
 * 空值返回当前时间。
 */
export function toUnix(v: Date | number | string | null | undefined): number {
  if (v === null || v === undefined || v === "") return nowSec();
  if (v instanceof Date) {
    const ms = v.getTime();
    return Number.isNaN(ms) ? nowSec() : Math.floor(ms / 1000);
  }
  if (typeof v === "number") return Math.floor(v > 1e12 ? v / 1000 : v);
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? Math.floor(n / 1000) : n;
  }
  const norm = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const ms = new Date(norm).getTime();
  return Number.isNaN(ms) ? nowSec() : Math.floor(ms / 1000);
}

/**
 * 表单日期时间输入转 Unix 秒（001 时区 Asia/Shanghai）。
 * 纯数字按秒/毫秒处理，无时区的 "YYYY-MM-DD HH:MM(:SS)" 按 UTC+8 解释。
 */
export function toUnixCN(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === "") return nowSec();
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return toUnix(s);
  const norm = s.includes("T") ? s : s.replace(" ", "T");
  const hasTz = /([zZ]|[+-]\d{2}:?\d{2})$/.test(norm);
  const ms = new Date(hasTz ? norm : norm + "+08:00").getTime();
  return Number.isNaN(ms) ? nowSec() : Math.floor(ms / 1000);
}

