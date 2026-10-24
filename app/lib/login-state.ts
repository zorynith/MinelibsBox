/**
 * 复刻 001 filter/userLoginState.class.php
 *
 * 同一账号同时登录数限制 (userLoginLimit, 0=不限制/上限 500), admin/guest 不限制;
 * 登录设备列表直接由 sessions 表派生 (ip/ua/platform/device/login_time)。
 */

import { getSetting } from "./db";
import { clientIp, getDevice, platformJsonOf } from "./user-check";
import { nowSec } from "./time";

const LIMIT_MAX = 500;
const DEFAULT_LIMIT = 5;

/**
 * 登录时执行并发登录限制 (001 checkLimit):
 * 排除当前 session, 保留最近 limit-1 个, 更早的踢下线;
 * 同时把当前设备的 ip/ua/platform/device 写入 session。
 */
export async function loginStateCheck(
  db: D1Database,
  userId: number,
  sessionId: string,
  req: Request,
): Promise<void> {
  // 排除 webdav Authorization 直接登录方式
  if (req.headers.get("authorization")) return;

  let limit = parseInt((await getSetting(db, "userLoginLimit")) ?? String(DEFAULT_LIMIT), 10);
  if (!Number.isFinite(limit) || limit < 0) limit = DEFAULT_LIMIT;
  if (limit === 0) limit = LIMIT_MAX;

  const role = await db
    .prepare("SELECT u.roleID, r.administrator, r.auth FROM users u LEFT JOIN roles r ON r.id = u.roleID WHERE u.id = ?")
    .bind(userId)
    .first<{ roleID: number; administrator: number; auth: string }>();

  const isRoot = Number(role?.administrator ?? 0) === 1;
  const authList = String(role?.auth ?? "")
    .replace(/^,+|,+$/g, "")
    .split(",")
    .filter(Boolean);
  // guest: 没有写入权限及新建权限
  const isGuest = !authList.includes("explorer.add") && !authList.includes("explorer.upload");
  if (isRoot || isGuest) limit = LIMIT_MAX;

  // 更早登录的排在前面; 超出 limit 的踢下线
  const rows = await db
    .prepare(
      "SELECT id FROM sessions WHERE user_id = ? AND id != ? AND expires_at > datetime('now') ORDER BY login_time ASC, created_at ASC",
    )
    .bind(userId, sessionId)
    .all<{ id: string }>();
  const list = rows.results || [];
  const indexFrom = Math.max(0, list.length - (limit - 1));
  for (let i = 0; i < indexFrom; i++) {
    await db.prepare("DELETE FROM sessions WHERE id = ?").bind(list[i].id).run();
  }

  const ip = clientIp(req);
  const ua = (req.headers.get("user-agent") || "") + ";";
  const platform = platformJsonOf(req);
  const device = getDevice(req);
  await db
    .prepare("UPDATE sessions SET ip = ?, ua = ?, platform = ?, device_json = ?, login_time = ? WHERE id = ?")
    .bind(ip, ua, platform, JSON.stringify(device), nowSec(), sessionId)
    .run();
}
