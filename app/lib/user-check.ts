/**
 * 复刻 001 filter/userCheck.class.php
 *
 * - password/passwordTips: 密码强度校验 (none/strong/strongMore)
 * - ipCheck: 全局 IP+设备黑名单 (仅 userSelect.all=1 的规则)
 * - userLoginCheck: 登录时按 用户/部门/角色 + 设备 + IP 白/黑名单 组合限制
 * - userLoginLockCheck: 密码连续错误锁定账号 (按 userID+IP)
 */

import { getSetting } from "./db";
import { t } from "./i18n";
import { nowSec } from "./time";

const DEFAULT_PASSWORD_RULE = "strongMore";
const LOGIN_LOCK_CACHE_TTL = 600;

export interface LoginDevice {
  type: string; // web/pc/app/Webdav
  system: string; // windows/mac/android/ios
  systemVersion: string;
  appVersion: string;
  moreInfo?: any;
}

function b64DecodeUtf8(raw: string): string {
  try {
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/** 客户端 IP (001 get_client_ip) */
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xf = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  if (xf) return xf;
  return "";
}

/** 设备类型 (001 filterUserCheck::getDevice) */
export function getDevice(req: Request): LoginDevice {
  const ua = req.headers.get("user-agent") || "";
  const device: LoginDevice = { type: "web", system: "", systemVersion: "", appVersion: "" };

  // 新版 APP 对 X-Platform 做了 base64 编码
  let platformRaw = req.headers.get("x-platform-1") || "";
  if (platformRaw) platformRaw = b64DecodeUtf8(platformRaw);
  else platformRaw = req.headers.get("x-platform") || "";
  let platform: any = false;
  if (platformRaw) {
    try {
      platform = JSON.parse(platformRaw);
    } catch {
      platform = false;
    }
  }

  // pc: windows/mac (Electron)
  if (/kodcloud/i.test(ua) && /electron/i.test(ua)) {
    device.type = "pc";
    device.system = /windows/i.test(ua) ? "windows" : /mac os/i.test(ua) ? "mac" : "";
  }
  // ios APP 原生
  if (ua.includes("kodCloud-System:iOS")) {
    device.type = "app";
    device.system = "ios";
    const ver = ua.match(/softwareVerison:(.*);/);
    device.systemVersion = ver ? ver[1] : "";
    const appVer = ua.match(/AppVersion:(.*);/);
    device.appVersion = appVer ? appVer[1] : "";
  }
  // app: ios/android
  if (platform && typeof platform === "object") {
    device.type = "app";
    device.system = String(platform.system ?? "").toLowerCase();
    device.systemVersion = String(platform.systemVersion ?? "").toLowerCase();
    device.appVersion = String(platform.appVersion ?? "").toLowerCase();
    device.moreInfo = platform;
    if (device.system.includes("android")) device.system = "android";
  }
  return device;
}

/** ip2long: 非法返回 0 */
export function ip2long(ip: string): number {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return 0;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return 0;
    const v = parseInt(p, 10);
    if (v < 0 || v > 255) return 0;
    n = n * 256 + v;
  }
  return n;
}

/** IP 规则匹配: 单 IP / IP 前缀 / 区间 (中划线), 逗号或换行分隔 */
export function checkIP(ip: string, check: string | null | undefined): boolean {
  const ipLong = ip2long(ip);
  if (!ip || !ipLong) return false;
  const text = String(check ?? "").replace(/[,|\r]/g, "\n");
  for (const rawLine of text.replace(/^\s+|\s+$/g, "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (ip === line) return true;
    // 前缀匹配 (非完整 4 段 IP)
    if (line.split(".").length !== 4 && ip.slice(0, line.length) === line) return true;
    const range = line.split("-");
    if (range.length !== 2) continue;
    const start = ip2long(range[0]);
    const end = ip2long(range[1]);
    if (ipLong >= start && ipLong <= end) return true;
  }
  return false;
}

/** 设备规则匹配 */
export function checkDevice(device: LoginDevice, check: string | null | undefined): boolean {
  const all = "web,pc-windows,pc-mac,app-android,app-ios,Webdav";
  const rule = String(check ?? "");
  if (rule === all) return true;
  const system = device.system ? "-" + device.system : "";
  const currentType = device.type + system;
  return rule.includes(currentType);
}

/** 密码强度: none 不限制 / strong ≥6 且含数字和字母 / strongMore ≥8 且 4 类中至少 3 类 */
export function passwordCheck(password: string, rule: string): boolean {
  if (!rule || rule === "none") return true;
  // 001 使用 strlen(), 按字节计数
  const length = new TextEncoder().encode(password).length;
  const hasNumber = /\d/.test(password);
  const hasChar = /[A-Za-z]/.test(password);
  const hasCharBig = /[A-Z]/.test(password);
  const hasCharSmall = /[a-z]/.test(password);
  const hasCharOthers = /[~!@#$%^&*]/.test(password);

  if (rule === "strong" && length >= 6 && hasNumber && hasChar) return true;
  if (rule === "strongMore" && length >= 8) {
    let classCnt = 0;
    if (hasNumber) classCnt++;
    if (hasCharBig) classCnt++;
    if (hasCharSmall) classCnt++;
    if (hasCharOthers) classCnt++;
    if (classCnt >= 3) return true;
  }
  return false;
}

/** 密码强度提示 (001 passwordTips) */
export function passwordTips(rule: string, lang = "zh-CN"): string {
  const desc: Record<string, string> = {
    strong: t("admin.setting.passwordRuleStrongDesc", lang),
    strongMore: t("admin.setting.passwordRuleStrongMoreDesc", lang),
  };
  const error = t("user.passwordCheckError", lang);
  const errorMore = desc[rule] ? ";<br/>" + desc[rule] : "";
  return error + errorMore;
}

/** 读取当前密码规则 */
export async function passwordRuleOf(db: D1Database): Promise<string> {
  const rule = await getSetting(db, "passwordRule");
  return rule === null ? DEFAULT_PASSWORD_RULE : rule;
}

/**
 * 密码强度校验入口: 通过返回 null, 否则返回提示文案。
 * 调用点与 001 一致: 用户注册 / 修改密码 / 找回密码 / 管理员添加用户 / 管理员修改用户。
 */
export async function passwordError(db: D1Database, password: string, lang = "zh-CN"): Promise<string | null> {
  const rule = await passwordRuleOf(db);
  if (!rule || rule === "none") return null;
  if (passwordCheck(password, rule)) return null;
  return passwordTips(rule, lang);
}

/**
 * 密码连续错误锁定 (001 userLoginLockCheck)。
 * valid=true 时清除记录；valid=false 时累计次数并在达到上限后锁定。
 * 返回 null 表示放行，否则返回锁定提示。
 */
export async function loginLockCheck(
  db: D1Database,
  userId: number,
  ip: string,
  valid: boolean,
  lang = "zh-CN",
): Promise<string | null> {
  const errorLock = (await getSetting(db, "passwordErrorLock")) ?? "1";
  if (errorLock === "0") return null;
  if (!userId) return null;

  const lockNumber = parseInt((await getSetting(db, "passwordLockNumber")) ?? "5", 10) || 5;
  const lockTime = parseInt((await getSetting(db, "passwordLockTime")) ?? "60", 10) || 60;
  const key = `user_login_lock_${userId}_${ip}`;

  const row = await db.prepare("SELECT times FROM login_lock WHERE lock_key = ?").bind(key).first<{ times: string }>();
  let item: number[] = [];
  if (row?.times) {
    try {
      const parsed = JSON.parse(row.times);
      if (Array.isArray(parsed)) item = parsed.map((n) => Number(n)).filter((n) => Number.isFinite(n));
    } catch {
      item = [];
    }
  }

  const now = nowSec();
  const last = item.length ? item[item.length - 1] : 0;
  if (item.length >= lockNumber && now - last <= lockTime) {
    return t("ERROR_USER_LOGIN_LOCK", lang);
  }

  if (valid) {
    await db.prepare("DELETE FROM login_lock WHERE lock_key = ?").bind(key).run();
    return null;
  }

  // 超出锁定时间则重新计数; 达到上限时移除最早一条
  if (now - last > lockTime) item = [];
  if (item.length >= lockNumber) item.shift();
  item.push(now);
  await db
    .prepare(
      "INSERT INTO login_lock (lock_key, times, updated_at) VALUES (?, ?, ?) ON CONFLICT(lock_key) DO UPDATE SET times = excluded.times, updated_at = excluded.updated_at",
    )
    .bind(key, JSON.stringify(item), now)
    .run();
  // 顺带清理过期记录 (001 Cache TTL 600s)
  await db.prepare("DELETE FROM login_lock WHERE updated_at < ?").bind(now - LOGIN_LOCK_CACHE_TTL).run().catch(() => {});
  return null;
}

/** 规则中的 userSelect 是否命中当前用户 (001 user.authPlugin::checkAuthValue) */
function authValueMatch(userSelect: any, user: { id: number; roleID: number; isRoot: boolean; groups: number[] }): boolean {
  let auth = userSelect;
  if (typeof auth === "string") {
    try {
      auth = JSON.parse(auth);
    } catch {
      auth = null;
    }
  }
  if (!auth || typeof auth !== "object") return false;
  if (String(auth.all) === "1") return true;
  if (String(auth.user) === "all") return true;
  if (String(auth.user) === "admin" && user.isRoot) return true;
  if (String(auth.role) === "1" && user.isRoot) return true;

  const split = (v: any): string[] => (v ? String(v).split(",").filter(Boolean) : []);
  if (split(auth.user).includes(String(user.id))) return true;
  if (split(auth.role).includes(String(user.roleID))) return true;
  const groupIds = split(auth.group);
  if (groupIds.some((g) => user.groups.includes(Number(g)))) return true;
  return false;
}

async function loginUserInfo(
  db: D1Database,
  userId: number,
): Promise<{ id: number; roleID: number; isRoot: boolean; groups: number[] } | null> {
  const row = await db
    .prepare("SELECT id, roleID, role FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: number; roleID: number; role: string }>();
  if (!row) return null;
  const groups = await db
    .prepare("SELECT group_id FROM user_groups WHERE user_id = ?")
    .bind(userId)
    .all<{ group_id: number }>();
  const groupIds = (groups.results || []).map((g) => Number(g.group_id));
  let isRoot = row.role === "admin" || row.role === "root" || Number(row.roleID) === 1;
  if (!isRoot) {
    const role = await db
      .prepare("SELECT administrator FROM roles WHERE id = ?")
      .bind(Number(row.roleID) || 0)
      .first<{ administrator: number }>()
      .catch(() => null);
    if (role && Number(role.administrator) === 1) isRoot = true;
  }
  return { id: Number(row.id), roleID: Number(row.roleID) || 0, isRoot, groups: groupIds };
}

interface LoginLimitConfig {
  ignored: boolean;
  list: any[] | null;
}

/** 一次查询读取登录限制相关设置, 避免全局中间件每请求多次读库 */
async function loginLimitConfig(db: D1Database): Promise<LoginLimitConfig> {
  const map: Record<string, string> = {};
  try {
    const rows = await db
      .prepare("SELECT key, value FROM settings WHERE key IN ('loginIpCheckIgnore','loginCheckAllow')")
      .all<{ key: string; value: string }>();
    for (const r of rows.results || []) map[r.key] = String(r.value ?? "");
  } catch {
    // 读库失败时按未配置处理, 避免拖垮所有接口
    return { ignored: false, list: null };
  }
  const ignored = map.loginIpCheckIgnore === "1";
  let list: any[] | null = null;
  if (map.loginCheckAllow) {
    try {
      const parsed = JSON.parse(map.loginCheckAllow);
      if (Array.isArray(parsed) && parsed.length) list = parsed;
    } catch {
      list = null;
    }
  }
  return { ignored, list };
}

/**
 * 全局 IP 黑名单 (001 ipCheck): 仅处理 userSelect.all=1 的黑名单规则。
 * 返回 null 表示放行, 否则返回拒绝提示。
 */
export async function loginIpAllowed(db: D1Database, req: Request, lang = "zh-CN"): Promise<string | null> {
  const cfg = await loginLimitConfig(db);
  if (cfg.ignored) return null;
  const list = cfg.list;
  if (!list) return null;

  const ip = clientIp(req);
  if (!ip || ip === "127.0.0.1") return null;
  const device = getDevice(req);

  for (const item of list) {
    if (String(item?.loginIpCheck) !== "2") continue;
    let userSelect: any = item?.userSelect;
    if (typeof userSelect === "string") {
      try {
        userSelect = JSON.parse(userSelect);
      } catch {
        userSelect = null;
      }
    }
    if (!userSelect || String(userSelect.all ?? "0") === "0") continue;
    if (checkDevice(device, item?.device) && checkIP(ip, item?.disableIp)) {
      return t("ERROR_IP_NOT_ALLOW", lang) + "; IP: " + ip;
    }
  }
  return null;
}

/**
 * 登录限制 (001 userLoginCheck): 按规则列表找到第一条命中当前用户的规则并判定。
 * 返回 null 表示放行, 否则返回拒绝提示。
 */
export async function userLoginCheck(
  db: D1Database,
  userId: number,
  req: Request,
  lang = "zh-CN",
): Promise<string | null> {
  const cfg = await loginLimitConfig(db);
  if (cfg.ignored) return null;
  const list = cfg.list;
  if (!list) return null;

  const info = await loginUserInfo(db, userId);
  if (!info) return null;

  const ip = clientIp(req);
  const device = getDevice(req);
  const error = t("ERROR_IP_NOT_ALLOW", lang);
  const rootIpAdd = "\n10.0.0.0-10.255.255.255\n192.168.0.0-192.168.255.255";

  for (const item of list) {
    if (!authValueMatch(item?.userSelect, info)) continue;

    let allowIp = true;
    const allowDevice = checkDevice(device, item?.device);
    if (String(item?.loginIpCheck) === "1") {
      // 系统管理员允许内网登录
      const allowList = String(item?.loginIpAllow ?? "") + (info.isRoot ? rootIpAdd : "");
      allowIp = checkIP(ip, allowList);
    } else if (String(item?.loginIpCheck) === "2") {
      if (checkIP(ip, item?.disableIp)) return allowDevice ? error : null;
    }
    return allowDevice && allowIp ? null : error;
  }
  return null;
}
