/**
 * Admin Task API - 后台任务管理 (复刻 001 admin/task)
 *  - taskList: 任务列表(补分享者信息, 清理 kill/超时任务, 最多50), root 附后台运行状态
 *  - taskKillAll: 终止全部任务后返回任务列表
 *  - taskAction: action= get|kill|stop|restart, id
 */
import { Hono } from "hono";
import { authRequired, isAdmin } from "../lib/auth";
import type { AuthUser } from "../lib/auth";
import { getUserById } from "../lib/db";

type Vars = { currentUser: AuthUser };
const adminTaskApi = new Hono<{ Bindings: Env; Variables: Vars }>();

adminTaskApi.use("*", authRequired);

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

/** 已完成任务的临时结果缓存 (复刻 001 Cache::result_<id>) */
const taskResultCache = new Map<number, string>();

/** 读取后台任务状态信息 (root 专属): autoTask / taskQueue */
async function taskQueueInfo(db: D1Database): Promise<Record<string, unknown>> {
  const autoRow: any = await db.prepare("SELECT COUNT(*) AS total FROM system_task WHERE enable = 1").first().catch(() => null);
  const queueRow: any = await db.prepare("SELECT COUNT(*) AS total, MAX(timeUpdate) AS lastRun FROM task WHERE status IN ('waiting','running')").first().catch(() => null);
  return {
    autoTask: parseInt(String(autoRow?.total ?? "0"), 10) || 0,
    taskQueue: parseInt(String(queueRow?.total ?? "0"), 10) || 0,
    taskQueueLastRun: queueRow?.lastRun || 0,
    taskQueueThread: 0,
  };
}

/** 001 taskListUser: 查询任务列表并按 001 规则清理过期任务 */
async function taskListUser(db: D1Database, userID: number | false): Promise<any[]> {
  const now = Math.floor(Date.now() / 1000);
  const where = userID ? "WHERE userID = ?" : "";
  const binds = userID ? [userID] : [];
  const rows: any[] = (await db.prepare(`SELECT * FROM task ${where}`).bind(...binds).all().catch(() => ({ results: [] as any[] }))).results || [];
  const keep: any[] = [];
  for (const row of rows) {
    const timeUpdate = parseInt(String(row.timeUpdate ?? "0"), 10) || 0;
    const killStale = row.status === "kill" && now - timeUpdate >= 10;
    const timeoutStale = now - timeUpdate >= 600;
    if (killStale || timeoutStale) {
      await db.prepare("DELETE FROM task WHERE id = ?").bind(row.id).run().catch(() => null);
      continue;
    }
    keep.push(row);
  }
  return keep;
}

async function taskListData(c: any, userID: number | false): Promise<{ list: Record<string, unknown>[]; taskInfo: Record<string, unknown> | null }> {
  const rows = await taskListUser(c.env.DB, userID);
  const list: Record<string, unknown>[] = [];
  for (const row of rows.slice(0, 50)) {
    let userInfo: Record<string, unknown> = { userID: row.userID, name: "", nickName: "" };
    const u: any = await getUserById(c.env.DB, parseInt(String(row.userID ?? "0"), 10) || 0).catch(() => null);
    if (u) {
      const name = u.nickname || u.username || "";
      userInfo = { userID: row.userID, name, nickName: name, avatar: u.avatar || "" };
    }
    list.push({ ...row, userInfo });
  }
  const user = c.get("currentUser");
  const taskInfo = user.role === "root" || user.role === "admin" ? await taskQueueInfo(c.env.DB) : null;
  return { list, taskInfo };
}

// ============ admin/task/taskList ============

adminTaskApi.all("/task/taskList", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  const params = await allParams(c);
  const uid = params.userID ? parseInt(params.userID, 10) || 0 : false;
  const { list, taskInfo } = await taskListData(c, uid);
  return c.json(ok(list, taskInfo));
});

// ============ admin/task/taskKillAll ============

adminTaskApi.all("/task/taskKillAll", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  const params = await allParams(c);
  const uid = params.userID ? parseInt(params.userID, 10) || 0 : false;
  const where = uid ? "WHERE userID = ?" : "";
  const binds = uid ? [uid] : [];
  await c.env.DB.prepare(`UPDATE task SET status = 'kill' ${where}`).bind(...binds).run().catch(() => null);
  const { list, taskInfo } = await taskListData(c, uid);
  return c.json(ok(list, taskInfo));
});

// ============ admin/task/taskAction ============

adminTaskApi.all("/task/taskAction", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  const params = await allParams(c);
  const action = params.action || "";
  const id = parseInt(params.id || "0", 10) || 0;
  if (!["get", "kill", "stop", "restart"].includes(action)) return c.json(fail("common.notExists"));

  const row: any = await c.env.DB.prepare("SELECT * FROM task WHERE id = ?").bind(id).first().catch(() => null);
  let taskInfo: any = row || null;
  let result: any = null;

  if (!taskInfo) {
    if (action === "get") {
      const cached = taskResultCache.get(id);
      if (cached) {
        taskResultCache.delete(id);
        let data: any = cached;
        try {
          data = JSON.parse(cached);
        } catch {
          // keep raw
        }
        return c.json(ok(data, "task_finished"));
      }
    }
    return c.json(fail("common.notExists"));
  }

  const now = Math.floor(Date.now() / 1000);
  switch (action) {
    case "get": {
      let res: any = row;
      if (taskResultCache.has(id)) {
        try {
          res = { ...row, result: JSON.parse(taskResultCache.get(id) || "{}") };
        } catch {
          res = { ...row, result: taskResultCache.get(id) };
        }
        taskResultCache.delete(id);
      }
      result = res;
      break;
    }
    case "stop":
      await c.env.DB.prepare("UPDATE task SET status = 'stop', timeUpdate = ? WHERE id = ?").bind(now, id).run().catch(() => null);
      result = true;
      break;
    case "restart":
      await c.env.DB.prepare("UPDATE task SET status = 'waiting', timeUpdate = ? WHERE id = ?").bind(now, id).run().catch(() => null);
      result = true;
      break;
    case "kill":
      await c.env.DB.prepare("UPDATE task SET status = 'kill', timeUpdate = ? WHERE id = ?").bind(now, id).run().catch(() => null);
      result = true;
      break;
    default:
      break;
  }
  return c.json(ok(result, taskInfo));
});

export { adminTaskApi };
