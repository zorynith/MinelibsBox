/**
 * 用户系统通知 (复刻 001 admin/notice::noticeGet/noticeEdit/noticeRemove)
 * 与 001 一致: 扫描公告(enable=1, time<=now, auth 匹配) 写入用户通知表(去重),
 * 返回未删除的用户通知列表; edit 标记已读, remove 删除(缺省清空)。
 * 该逻辑同时服务 user/setting/notice 与 admin/notice/noticeGet|noticeEdit|noticeRemove。
 */
import type { Context } from "hono";
import type { AuthUser } from "./auth";
import { t } from "./i18n";

type NoticeContext = Context<{ Bindings: Env; Variables: { currentUser: AuthUser } }>;

function ok(data: any) {
  return { code: true, data: typeof data === "string" ? t(data) : data };
}
function fail(data: any) {
  return { code: false, data: typeof data === "string" ? t(data) : data };
}

export function noticeAuthCheck(user: AuthUser, auth: string): boolean {
  if (user.role === "admin" || user.role === "root") return true;
  if (!auth) return true;
  let obj: Record<string, any> = {};
  try {
    const parsed = JSON.parse(auth);
    if (parsed && typeof parsed === "object") obj = parsed;
  } catch {
    return true;
  }
  if (obj.all === "1" || obj.all === 1) return true;
  if (obj.user === "all") return true;
  if (obj.user === "admin") return user.role === "admin" || user.role === "root";
  const users = String(obj.user || "").split(",").filter(Boolean);
  if (users.map(Number).includes(user.id)) return true;
  const roles = String(obj.role || "").split(",").filter(Boolean).map(Number);
  const roleID = user.role === "admin" ? 1 : 3;
  if (roles.includes(roleID)) return true;
  return false;
}

export async function handleUserNotice(
  c: NoticeContext,
  user: AuthUser,
  action: string,
  id: number
): Promise<Response> {
  if (action === "get") {
    const ts = Math.floor(Date.now() / 1000);
    const now = ts;

    // 单条详情: 前端点开公告调用 action=get&id=x, 期望返回含 content 的单条对象
    if (id) {
      const rec = await c.env.DB.prepare(
        'SELECT id, noticeID, name, content, time, type, level, status, "delete" FROM user_notice WHERE id = ? AND userID = ?'
      )
        .bind(id, user.id)
        .first<Record<string, unknown>>();
      if (rec) {
        return c.json(ok({
          id: Number(rec.id),
          noticeID: Number(rec.noticeID),
          name: rec.name,
          content: rec.content,
          time: Number(rec.time || 0),
          type: Number(rec.type ?? 1),
          level: Number(rec.level ?? 0),
          status: Number(rec.status ?? 0),
          delete: Number(rec.delete ?? 0),
        }));
      }
      const n = await c.env.DB.prepare("SELECT * FROM notice WHERE id = ?").bind(id).first<Record<string, unknown>>();
      if (n && Number(n.enable ?? 0) === 1 && Number(n.time || 0) <= now && noticeAuthCheck(user, String(n.auth || ""))) {
        return c.json(ok({
          id: Number(n.id),
          noticeID: Number(n.id),
          name: n.name,
          content: n.content,
          time: Number(n.time || 0),
          type: Number(n.type ?? 1),
          level: Number(n.level ?? 0),
          status: 0,
          delete: 0,
        }));
      }
      return c.json(fail("common.notExists"));
    }

    const notices = await c.env.DB.prepare("SELECT * FROM notice WHERE enable = 1 ORDER BY sort ASC, id ASC").all<Record<string, unknown>>().catch(() => ({ results: [] }));
    for (const n of notices.results || []) {
      if (Number(n.time || 0) > now) continue;
      if (!noticeAuthCheck(user, String(n.auth || ""))) continue;
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO user_notice (userID, noticeID, name, content, time, type, level, status, "delete", createTime)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
      )
        .bind(user.id, Number(n.id), n.name, n.content, Number(n.time || 0), Number(n.type ?? 1), Number(n.level ?? 0), ts)
        .run();
    }
    const rows = await c.env.DB.prepare(
      `SELECT id, noticeID, name, content, time, type, level, status, "delete" FROM user_notice
       WHERE userID = ? AND "delete" = 0 ORDER BY time DESC, id DESC`
    )
      .bind(user.id)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] }));
    return c.json(ok((rows.results || []).map((r) => ({
      id: Number(r.id),
      noticeID: Number(r.noticeID),
      name: r.name,
      content: r.content,
      time: Number(r.time || 0),
      type: Number(r.type ?? 1),
      level: Number(r.level ?? 0),
      status: Number(r.status ?? 0),
      delete: Number(r.delete ?? 0),
    }))));
  }

  if (action === "edit") {
    if (!id) return c.json(fail("explorer.share.errorParam"));
    await c.env.DB.prepare('UPDATE user_notice SET status = 1 WHERE id = ? AND userID = ?').bind(id, user.id).run();
    return c.json(ok("explorer.success"));
  }

  if (action === "remove") {
    if (id) {
      await c.env.DB.prepare('UPDATE user_notice SET "delete" = 1 WHERE id = ? AND userID = ?').bind(id, user.id).run();
    } else {
      await c.env.DB.prepare('UPDATE user_notice SET "delete" = 1 WHERE userID = ?').bind(user.id).run();
    }
    return c.json(ok("explorer.success"));
  }

  return c.json(fail("common.invalidParam"));
}
