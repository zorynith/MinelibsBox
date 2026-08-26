/**
 * Admin Share API - 分享管理 (复刻 001 admin/share)
 *  - get: table=report 举报列表 / shareID 分享详情 / 否则分享列表(时间+类型+用户+关键词过滤)
 *  - remove: 取消分享
 *  - status: 举报处理
 */
import { Hono } from "hono";
import { authRequired, isAdmin } from "../lib/auth";
import type { AuthUser } from "../lib/auth";
import { getUserById } from "../lib/db";
import { getShareById, removeShares, resolveShareSource, shareOptions } from "../lib/share";

type Vars = { currentUser: AuthUser };
const adminShareApi = new Hono<{ Bindings: Env; Variables: Vars }>();

adminShareApi.use("*", authRequired);

function ok(data: any, info?: any) {
  const res: any = { code: true, data };
  if (info !== undefined) res.info = info;
  return res;
}
function fail(data: any) {
  return { code: false, data };
}

async function allParams(c: any): Promise<Record<string, string>> {
  const body = await c.req.parseBody().catch(() => ({}));
  const merged: Record<string, string> = { ...c.req.query() };
  for (const [k, v] of Object.entries(body)) merged[k] = typeof v === "string" ? v : "";
  return merged;
}

/** 分享者信息 (001 listDataApply 的 userInfo) */
async function shareUserInfoOf(db: D1Database, userID: number): Promise<Record<string, unknown>> {
  const u: any = await getUserById(db, userID).catch(() => null);
  const name = u?.nickname || u?.username || "";
  return { userID, name, nickName: name, avatar: u?.avatar || "" };
}

/** 分享条目封装: share 行 + options 对象 + 分享者 + 来源文件信息 */
async function buildShareItem(env: Env, db: D1Database, row: any): Promise<Record<string, unknown>> {
  const owner: any = await getUserById(db, parseInt(String(row.userID ?? "0"), 10) || 0).catch(() => null);
  const source = owner ? await resolveShareSource(env, { username: owner.username }, row).catch(() => null) : null;
  const isFolder = String(row.sourcePath || "").endsWith("/");
  return {
    ...row,
    options: shareOptions(row),
    userInfo: await shareUserInfoOf(db, row.userID),
    sourceInfo: source ? { type: source.type, name: source.name, path: source.realPath, isFolder } : null,
  };
}

/** 构造 listAll 查询条件(分享列表与举报列表共用) */
function buildListClauses(params: Record<string, string>, prefix = "s.", includeWords = true): { where: string[]; binds: (string | number)[] } {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  const type = params.type || "";
  if (type === "link") {
    where.push(`${prefix}isLink = 1`);
  } else if (type === "shareTo") {
    where.push(`${prefix}isShareTo = 1`);
  }
  if (params.userID) {
    where.push(`${prefix}userID = ?`);
    binds.push(parseInt(params.userID, 10) || 0);
  }
  if (includeWords && params.words) {
    where.push(`${prefix}title LIKE ?`);
    binds.push(`%${params.words}%`);
  }
  return { where, binds };
}

function buildTimeClause(params: Record<string, string>): { sql: string; binds: (string | number)[] } {
  const binds: (string | number)[] = [];
  let sql = "";
  const f = params.timeFrom;
  const t = params.timeTo;
  if (f) {
    sql += " AND createTime >= ?";
    binds.push(/^\d{10}$/.test(f) ? new Date(parseInt(f, 10) * 1000).toISOString() : f);
  }
  if (t) {
    sql += " AND createTime <= ?";
    binds.push(/^\d{10}$/.test(t) ? new Date(parseInt(t, 10) * 1000).toISOString() : t);
  }
  return { sql, binds };
}

// ============ admin/share/get ============

adminShareApi.all("/share/get", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  const params = await allParams(c);

  // 举报列表
  if (params.table === "report") {
    const { where, binds } = buildListClauses(params, "s.", false);
    const stBinds: (string | number)[] = [];
    let stSql = "";
    if (params.status !== undefined && params.status !== "") {
      stSql = " AND r.status = ?";
      stBinds.push(parseInt(params.status, 10) || 0);
    }
    const words = params.words || "";
    let wsql = "";
    const wbinds: (string | number)[] = [];
    if (words) {
      wsql = " AND (r.reason LIKE ? OR s.title LIKE ?)";
      wbinds.push(`%${words}%`, `%${words}%`);
    }
    const base = `FROM share_report r JOIN share s ON r.shareID = s.shareID JOIN users u ON r.userID = u.id WHERE 1=1 ${where.length ? "AND " + where.join(" AND ") : ""} ${stSql} ${wsql}`;
    const page = Math.max(parseInt(params.page || "1", 10) || 1, 1);
    const pageNum = Math.max(parseInt(params.pageNum || "20", 10) || 20, 1);
    const tc = buildTimeClause(params);
    const countRow: any = await c.env.DB.prepare(`SELECT COUNT(*) AS total ${base}`).bind(...binds, ...stBinds, ...wbinds).first().catch(() => null);
    const total = parseInt(countRow?.total ?? "0", 10) || 0;
    const pageTotal = Math.max(1, Math.ceil(total / pageNum));
    const rows: any[] = (await c.env.DB.prepare(
      `SELECT r.id, r.shareID, r.reason, r.status, r.createTime AS reportTime, s.title, s.shareHash, s.sourcePath, s.isLink, s.isShareTo, s.userID AS ownerID, u.nickname AS reportUser ${base} ORDER BY r.createTime DESC LIMIT ? OFFSET ?`
    ).bind(...binds, ...stBinds, ...wbinds, pageNum, (page - 1) * pageNum).all().catch(() => ({ results: [] as any[] }))).results || [];
    return c.json(ok({
      list: rows,
      pageInfo: { page, pageTotal, pageNum, totalNum: total },
    }));
  }

  // 分享详情
  if (params.shareID) {
    const row = await getShareById(c.env.DB, parseInt(params.shareID, 10) || 0);
    if (!row) return c.json(ok(null));
    return c.json(ok(await buildShareItem(c.env, c.env.DB, row)));
  }

  // 分享列表
  const { where, binds } = buildListClauses(params);
  const tc = buildTimeClause(params);
  const page = Math.max(parseInt(params.page || "1", 10) || 1, 1);
  const pageNum = Math.max(parseInt(params.pageNum || "20", 10) || 20, 1);
  const base = `FROM share s WHERE 1=1 ${where.length ? "AND " + where.join(" AND ") : ""} ${tc.sql}`;
  const countRow: any = await c.env.DB.prepare(`SELECT COUNT(*) AS total ${base}`).bind(...binds, ...tc.binds).first().catch(() => null);
  const total = parseInt(countRow?.total ?? "0", 10) || 0;
  const pageTotal = Math.max(1, Math.ceil(total / pageNum));
  const rows: any[] = (await c.env.DB.prepare(
    `SELECT s.* ${base} ORDER BY s.createTime DESC LIMIT ? OFFSET ?`
  ).bind(...binds, ...tc.binds, pageNum, (page - 1) * pageNum).all().catch(() => ({ results: [] as any[] }))).results || [];
  const list: Record<string, unknown>[] = [];
  for (const row of rows) list.push(await buildShareItem(c.env, c.env.DB, row));
  return c.json(ok({
    list,
    pageInfo: { page, pageTotal, pageNum, totalNum: total },
  }));
});

// ============ admin/share/remove ============

adminShareApi.all("/share/remove", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  const params = await allParams(c);
  const id = parseInt(params.id || "0", 10) || 0;
  if (!id) return c.json(fail("explorer.error"));
  await removeShares(c.env.DB, [id]);
  return c.json(ok("explorer.success"));
});

// ============ admin/share/status ============

adminShareApi.all("/share/status", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  const params = await allParams(c);
  const id = parseInt(params.id || "0", 10) || 0;
  const status = parseInt(params.status ?? "", 10);
  if (!id || Number.isNaN(status)) return c.json(fail("explorer.error"));
  const res = await c.env.DB.prepare("UPDATE share_report SET status = ? WHERE id = ?")
    .bind(status, id).run().catch(() => null);
  if (!res) return c.json(fail("explorer.error"));
  return c.json(ok("explorer.success"));
});

export { adminShareApi };
