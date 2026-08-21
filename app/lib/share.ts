/**
 * Share (外链分享 / 内部协作分享) 数据访问与工具
 *
 * 复刻 001 的 explorer/userShare 与 explorer/share 逻辑，后端数据落在 D1 `share` 表。
 * 表结构与 001 share 表对齐（shareID/shareHash/userID/sourceID/sourcePath/...）。
 *
 * 前端契约要点：
 *  - 外链落地页 hash 路由 `#s/<shareHash>`，所有请求带 shareID=<shareHash>。
 *  - 「我分享的」列表路径为 {userShare}/（全部）、{userShareLink}/（仅外链），
 *    列表项点击后进入 {shareItem:<shareID>}/ 目录。
 *  - 外链落地页根路径 {shareItemLink:<shareHash>}/。
 */
import { md5, mcryptDecode } from "./mcrypt";

export interface ShareRow {
  shareID: number;
  title: string;
  shareHash: string;
  userID: number;
  sourceID: string;
  sourcePath: string;
  url: string;
  isLink: number;
  isShareTo: number;
  password: string;
  timeTo: number;
  numView: number;
  numDownload: number;
  options: string;
  createTime: string;
  modifyTime: string;
}

/** 规范化分享源路径（相对路径，去掉首尾多余斜杠，目录保留尾斜杠）。 */
export function normShareSourcePath(p: string, isFolder = false): string {
  let s = (p || "/").replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!s) s = "/";
  if (!s.startsWith("/")) s = "/" + s;
  if (isFolder && !s.endsWith("/")) s += "/";
  return s;
}

/** 解析 share.options 字段（JSON 字符串）。 */
export function shareOptions(row: Pick<ShareRow, "options">): Record<string, any> {
  if (!row.options) return {};
  try {
    const o = JSON.parse(row.options);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function rowToShare(r: Record<string, unknown>): ShareRow {
  return {
    shareID: Number(r.shareID),
    title: String(r.title || ""),
    shareHash: String(r.shareHash || ""),
    userID: Number(r.userID),
    sourceID: String(r.sourceID || "0"),
    sourcePath: String(r.sourcePath || ""),
    url: String(r.url || ""),
    isLink: Number(r.isLink) || 0,
    isShareTo: Number(r.isShareTo) || 0,
    password: String(r.password || ""),
    timeTo: Number(r.timeTo) || 0,
    numView: Number(r.numView) || 0,
    numDownload: Number(r.numDownload) || 0,
    options: String(r.options || "{}"),
    createTime: String(r.createTime || ""),
    modifyTime: String(r.modifyTime || ""),
  };
}

export async function getShareByHash(db: D1Database, hash: string): Promise<ShareRow | null> {
  if (!hash) return null;
  const r = await db.prepare("SELECT * FROM share WHERE shareHash = ? LIMIT 1").bind(hash).first<Record<string, unknown>>();
  return r ? rowToShare(r) : null;
}

export async function getShareById(db: D1Database, id: number): Promise<ShareRow | null> {
  if (!Number.isFinite(id) || id <= 0) return null;
  const r = await db.prepare("SELECT * FROM share WHERE shareID = ? LIMIT 1").bind(id).first<Record<string, unknown>>();
  return r ? rowToShare(r) : null;
}

/** 通过来源路径查询外链分享（文件不带尾斜杠 / 目录带尾斜杠 均匹配）。 */
export async function getShareBySourcePath(db: D1Database, userId: number, sourcePath: string): Promise<ShareRow | null> {
  const p = normShareSourcePath(sourcePath).replace(/\/+$/, "");
  const r = await db
    .prepare("SELECT * FROM share WHERE userID = ? AND isLink = 1 AND (sourcePath = ? OR sourcePath = ?) LIMIT 1")
    .bind(userId, p, p + "/")
    .first<Record<string, unknown>>();
  return r ? rowToShare(r) : null;
}

/** 用户的外链分享列表（"我分享的" / "外链分享"）。 */
export async function listUserShares(db: D1Database, userId: number, linkOnly = false): Promise<ShareRow[]> {
  const rows = linkOnly
    ? await db.prepare("SELECT * FROM share WHERE userID = ? AND isLink = 1 ORDER BY modifyTime DESC").bind(userId).all<Record<string, unknown>>()
    : await db.prepare("SELECT * FROM share WHERE userID = ? AND (isLink = 1 OR isShareTo = 1) ORDER BY modifyTime DESC").bind(userId).all<Record<string, unknown>>();
  return (rows.results || []).map(rowToShare);
}

/** 新增分享，返回 shareID。 */
export async function addShare(
  db: D1Database,
  data: {
    userID: number;
    title: string;
    shareHash: string;
    sourcePath: string;
    isLink: number;
    isShareTo: number;
    password?: string;
    timeTo?: number;
    options?: Record<string, any>;
    url?: string;
  }
): Promise<number> {
  const now = new Date().toISOString();
  const opts = data.options || {};
  const res = await db
    .prepare(
      `INSERT INTO share (title, shareHash, userID, sourceID, sourcePath, url, isLink, isShareTo, password, timeTo, numView, numDownload, options, createTime, modifyTime)
       VALUES (?, ?, ?, '0', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
    )
    .bind(
      data.title,
      data.shareHash,
      data.userID,
      normShareSourcePath(data.sourcePath),
      data.url || "",
      data.isLink,
      data.isShareTo,
      data.password || "",
      data.timeTo || 0,
      JSON.stringify(opts),
      now,
      now
    )
    .run();
  return Number(res.meta.last_row_id);
}

/** 编辑分享（仅更新传入字段；timeTo/options/password/title/shareHash 为 undefined 时不改）。 */
export async function editShare(
  db: D1Database,
  id: number,
  data: Partial<{ title: string; shareHash: string; password: string; timeTo: number; options: Record<string, any>; url: string }>
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const push = (field: string, v: unknown) => {
    sets.push(`${field} = ?`);
    binds.push(v);
  };
  if (data.title !== undefined) push("title", data.title);
  if (data.shareHash !== undefined) push("shareHash", data.shareHash);
  if (data.password !== undefined) push("password", data.password);
  if (data.timeTo !== undefined) push("timeTo", data.timeTo);
  if (data.url !== undefined) push("url", data.url);
  if (data.options !== undefined) push("options", JSON.stringify(data.options || {}));
  if (sets.length === 0) return;
  sets.push("modifyTime = ?");
  binds.push(new Date().toISOString());
  binds.push(id);
  await db.prepare(`UPDATE share SET ${sets.join(", ")} WHERE shareID = ?`).bind(...binds).run();
}

/** 删除分享（校验归属由调用方负责）。 */
export async function removeShares(db: D1Database, ids: number[]): Promise<void> {
  const list = ids.filter((n) => Number.isFinite(n) && n > 0);
  if (list.length === 0) return;
  const ph = list.map(() => "?").join(",");
  await db.prepare(`DELETE FROM share WHERE shareID IN (${ph})`).bind(...list).run();
}

export async function incNumView(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE share SET numView = numView + 1 WHERE shareID = ?").bind(id).run();
}

export async function incNumDownload(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE share SET numDownload = numDownload + 1 WHERE shareID = ?").bind(id).run();
}

const HASH_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

/** 生成不重复的分享 hash（8~10 位，001 风格）。 */
export async function generateShareHash(db: D1Database): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const len = 8 + Math.floor(Math.random() * 3);
    let h = "";
    for (let j = 0; j < len; j++) h += HASH_CHARS[Math.floor(Math.random() * HASH_CHARS.length)];
    if (!(await getShareByHash(db, h))) return h;
  }
  return "s" + Math.floor(Date.now() / 1000).toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

// ============ 分享密码解锁（无状态签名 cookie） ============
// 001 用 PHP Session（Share_password_<shareID>）记忆"已解锁"；003 无服务端会话，
// 改用带签名的 cookie 记录已解锁的 shareHash 列表，跨请求保持等价效果。

const UNLOCK_COOKIE = "kod_share_pass";
const UNLOCK_SECRET = "DEV-MB-0001|kodSharePass|";
const UNLOCK_MAX = 20;

function signUnlock(payload: string): string {
  return md5(payload + UNLOCK_SECRET);
}

/** 读取已解锁的 shareHash 集合。 */
export function getUnlockedShares(c: any): Set<string> {
  const cookie = c.req.header("Cookie") || "";
  const m = cookie.match(new RegExp(`${UNLOCK_COOKIE}=([^;]+)`));
  if (!m || !m[1]) return new Set();
  const dot = m[1].indexOf(".");
  if (dot <= 0) return new Set();
  const payload = m[1].slice(0, dot);
  const sig = m[1].slice(dot + 1);
  if (signUnlock(payload) !== sig) return new Set();
  try {
    const arr = JSON.parse(decodeURIComponent(escape(atob(payload))));
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** 记录某个分享已通过密码验证。 */
export function setSharePassUnlocked(c: any, shareHash: string): void {
  const set = getUnlockedShares(c);
  set.add(shareHash);
  const arr = Array.from(set).slice(-UNLOCK_MAX);
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(arr))));
  const val = `${payload}.${signUnlock(payload)}`;
  c.header("Set-Cookie", `${UNLOCK_COOKIE}=${val}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`, { append: true });
}

// ============ 分享源 ============

/** 校验分享源仍存在（R2 head），返回源信息（type/name/...），不存在返回 null。 */
export async function resolveShareSource(
  env: Env,
  owner: { username: string },
  share: ShareRow
): Promise<{ type: "folder" | "file"; name: string; realPath: string } | null> {
  const path = normShareSourcePath(share.sourcePath);
  const isFolder = path.endsWith("/");
  const { getUserFileKey } = await import("./r2");
  if (isFolder) {
    const key = getUserFileKey(owner.username, path);
    const listed = await env.FILES.list({ prefix: key, limit: 1 });
    if (listed.objects.length > 0 || (listed.delimitedPrefixes || []).length > 0) {
      return { type: "folder", name: path.split("/").filter(Boolean).pop() || path, realPath: path };
    }
    return null;
  }
  const obj = await env.FILES.head(getUserFileKey(owner.username, path));
  if (!obj) return null;
  return { type: "file", name: path.split("/").filter(Boolean).pop() || path, realPath: path };
}

/** 分享根路径（外链路径格式，001 一致）。 */
export function shareLinkRoot(shareHash: string): string {
  return `{shareItemLink:${shareHash}}/`;
}
