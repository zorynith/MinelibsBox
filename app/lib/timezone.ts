/**
 * 时区配置 (通用版)
 *
 * 配置来源优先级:
 *   1. 系统设置 settings.timezone   —— 管理员可通过 admin/setting/set 写入
 *   2. 环境变量 TIMEZONE            —— wrangler vars 里设置, 适合不想动数据库的部署
 *   3. 默认 "Asia/Shanghai"
 *
 * 取值支持两种写法:
 *   - IANA 时区名: "Asia/Shanghai" / "UTC" / "America/New_York"
 *   - UTC 偏移小时: "8" / "+8" / "-5" / "5.5"
 *
 * Worker 里的 Date 恒为 UTC, 所有"今天/时段/零点"的判断都要先换算到该时区。
 */
import { getSetting } from "./db";

export const DEFAULT_TIMEZONE = "Asia/Shanghai";

/** 数字型偏移(小时) → 分钟; 非数字返回 null */
function parseOffsetMinutes(tz: string): number | null {
  const s = String(tz || "").trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const hours = Number(s);
  if (!Number.isFinite(hours) || Math.abs(hours) > 14) return null;
  return hours * 60;
}

export function isValidTimezone(tz: string): boolean {
  const s = String(tz || "").trim();
  if (!s) return false;
  if (parseOffsetMinutes(s) !== null) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s });
    return true;
  } catch {
    return false;
  }
}

/** 读取生效时区 (设置 → env → 默认) */
export async function getTimezone(env: any, db?: D1Database): Promise<string> {
  try {
    const stored = db ? await getSetting(db, "timezone") : null;
    const value = String(stored ?? "").trim();
    if (value && isValidTimezone(value)) return value;
  } catch {
    /* 读设置失败时继续往下走 */
  }
  const fromEnv = String(env?.TIMEZONE ?? "").trim();
  if (fromEnv && isValidTimezone(fromEnv)) return fromEnv;
  return DEFAULT_TIMEZONE;
}

/** 该时刻在时区内的偏移(分钟, 东八区 = 480) */
export function tzOffsetMinutes(tz: string, date: Date = new Date()): number {
  const fixed = parseOffsetMinutes(tz);
  if (fixed !== null) return fixed;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour) % 24,
      Number(p.minute),
      Number(p.second)
    );
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** 时区内的日期(YYYY-MM-DD)与时间(HH:MM) */
export function tzParts(tz: string, date: Date = new Date()): { dateKey: string; hm: string } {
  const fixed = parseOffsetMinutes(tz);
  if (fixed !== null) {
    const shifted = new Date(date.getTime() + fixed * 60000);
    const iso = shifted.toISOString();
    return { dateKey: iso.slice(0, 10), hm: iso.slice(11, 16) };
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const p: Record<string, string> = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
    const hour = p.hour === "24" ? "00" : p.hour;
    return { dateKey: `${p.year}-${p.month}-${p.day}`, hm: `${hour}:${p.minute}` };
  } catch {
    const iso = date.toISOString();
    return { dateKey: iso.slice(0, 10), hm: iso.slice(11, 16) };
  }
}

/** 时区内某天 00:00 对应的 UTC 秒 */
export function tzDayStartSec(tz: string, date: Date = new Date()): number {
  const { dateKey } = tzParts(tz, date);
  const [y, m, d] = dateKey.split("-").map(Number);
  const guessMs = Date.UTC(y, m - 1, d, 0, 0, 0);
  const off = tzOffsetMinutes(tz, new Date(guessMs));
  return Math.floor((guessMs - off * 60000) / 1000);
}

/** 时区内 "YYYY-MM-DD" 当天 00:00 的 UTC 秒 */
export function tzDateStartSec(tz: string, dateKey: string): number {
  const m = String(dateKey || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return NaN;
  const guessMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
  const off = tzOffsetMinutes(tz, new Date(guessMs));
  return Math.floor((guessMs - off * 60000) / 1000);
}
