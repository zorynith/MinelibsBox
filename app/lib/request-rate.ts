/**
 * 复刻 001 filter/userRequest.class.php::checkRequestMany
 *
 * 请求频率限制: 常规接口 requestPerMinuteMax, 高频接口 requestAllowPerMinuteMax;
 * 两项都配置后才生效; 管理员不受限制; 按 session (无 session 时按 IP) 记录最近请求时间。
 */

import { clientIp } from "./user-check";

/** 001 ingoreActions (小写) - 走 requestAllowPerMinuteMax */
const IGNORE_ACTIONS = new Set([
  "explorer.index.mkdir",
  "explorer.list.path",
  "explorer.index.mkfile",
  "explorer.upload.fileupload",
  "explorer.index.fileout",
  "explorer.share.file",
  "explorer.share.fileout",
  "explorer.share.fileupload",
  "user.setting.taskaction",
]);

const WINDOW_SECONDS = 5;

function actionOf(path: string): string {
  let clean = path.replace(/^\/+|\/+$/g, "");
  let segs = clean.split("/");
  if (segs[0] === "api") segs = segs.slice(1);
  let mod = (segs[0] || "").toLowerCase();
  let st = (segs[1] || "").toLowerCase();
  const act = (segs[2] || "").toLowerCase();
  if (mod === "seo") {
    mod = "explorer";
    st = "seo";
  } else if (mod === "shareout") {
    mod = "explorer";
    st = "shareout";
  }
  return `${mod}.${st}.${act}`;
}

function sessionIdOf(req: Request): string {
  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)kod_session=([^;]+)/);
  return m ? m[1] : "";
}

async function isRootSession(db: D1Database, sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  const row = await db
    .prepare(
      `SELECT u.role, u.roleID, r.administrator FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN roles r ON r.id = u.roleID
        WHERE s.id = ? AND s.expires_at > datetime('now')`,
    )
    .bind(sessionId)
    .first<{ role: string; roleID: number; administrator: number }>()
    .catch(() => null);
  if (!row) return false;
  return row.role === "admin" || row.role === "root" || Number(row.roleID) === 1 || Number(row.administrator) === 1;
}

/**
 * 检查请求频率; 返回 true 表示请求过于频繁需要拦截。
 * 001 返回 show_json("request too many!", false)。
 */
export async function requestRateLimited(c: any): Promise<boolean> {
  const db: D1Database = c.env.DB;
  let normalMax = 0;
  let allowMax = 0;
  try {
    const rows = await db
      .prepare("SELECT key, value FROM settings WHERE key IN ('requestPerMinuteMax','requestAllowPerMinuteMax')")
      .all<{ key: string; value: string }>();
    const map: Record<string, string> = {};
    for (const r of rows.results || []) map[r.key] = String(r.value ?? "");
    normalMax = parseInt(map.requestPerMinuteMax ?? "0", 10) || 0;
    allowMax = parseInt(map.requestAllowPerMinuteMax ?? "0", 10) || 0;
  } catch {
    return false;
  }
  // 001: 任一未配置则不限制
  if (!normalMax || !allowMax) return false;

  const req: Request = c.req.raw;
  const sessionId = sessionIdOf(req);
  if (await isRootSession(db, sessionId)) return false;

  const action = actionOf(c.req.path);
  const key = IGNORE_ACTIONS.has(action) ? "userRequestAllow" : "userRequest";
  const max = key === "userRequestAllow" ? allowMax : normalMax;
  const owner = sessionId ? `s:${sessionId}` : `ip:${clientIp(req)}`;
  const rateKey = `${owner}:${key}`;

  const row = await db
    .prepare("SELECT times FROM request_rate WHERE rate_key = ?")
    .bind(rateKey)
    .first<{ times: string }>()
    .catch(() => null);
  let times: number[] = [];
  if (row?.times) {
    try {
      const parsed = JSON.parse(row.times);
      if (Array.isArray(parsed)) times = parsed.map((n) => Number(n)).filter((n) => Number.isFinite(n));
    } catch {
      times = [];
    }
  }

  const now = Date.now() / 1000;
  times.push(now);
  const lastNumber = Math.trunc((max * WINDOW_SECONDS) / 60);
  const count = times.length;
  let blocked = false;
  if (lastNumber <= 0) {
    // 001 在此配置下等价于不限制 (列表被清空)
    times = [];
  } else if (count > lastNumber) {
    const idx = count - lastNumber + 1;
    const timeUse = idx >= 0 && idx < count ? times[count - 1] - times[idx] : Infinity;
    times = times.slice(1, 1 + lastNumber);
    if (timeUse < WINDOW_SECONDS) blocked = true;
  }

  await db
    .prepare(
      "INSERT INTO request_rate (rate_key, times, updated_at) VALUES (?, ?, ?) ON CONFLICT(rate_key) DO UPDATE SET times = excluded.times, updated_at = excluded.updated_at",
    )
    .bind(rateKey, JSON.stringify(times), Math.floor(now))
    .run()
    .catch(() => {});
  // 清理一天未活跃的记录
  await db
    .prepare("DELETE FROM request_rate WHERE updated_at < ?")
    .bind(Math.floor(now) - 86400)
    .run()
    .catch(() => {});

  return blocked;
}
