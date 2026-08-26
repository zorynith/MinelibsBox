/**
 * AutoTask API - 计划任务 (复刻 001 admin/autoRun + admin/autoTask)
 *
 * - admin/autoRun/index: 检查所有启用的任务, 到期则执行 (外部 cron / 前端轮询触发)
 * - admin/autoTask/get|add|edit|enable|remove|run|taskSwitch|taskRestart|sort
 *
 * 任务周期 time 为 JSON 字符串, 支持:
 *   {"type":"minute","minute":"5"}                   每 N 分钟
 *   {"type":"day","day":"02:00"}                     每天 HH:MM
 *   {"type":"week","week":"1","day":"02:00"}         每周第 N 天 HH:MM (1=周一..7=周日)
 *   {"type":"month","month":"1","day":"02:00"}       每月第 N 日 HH:MM
 * type=url 执行 HTTP 请求; type=method 执行注册的 worker 内部任务处理器。
 */
import { Hono } from "hono";
import { authRequired, isAdmin, type AuthUser } from "../lib/auth";
import { getSetting, setSetting } from "../lib/db";
import { t } from "../lib/i18n";

type Vars = { currentUser: AuthUser };

const autoTaskApi = new Hono<{ Bindings: Env; Variables: Vars }>();

autoTaskApi.use("*", authRequired);

function ok(data: any, info?: any) {
  const res: any = { code: true, data: typeof data === "string" ? t(data) : data };
  if (info !== undefined) res.info = info;
  return res;
}

function fail(data: any) {
  return { code: false, data: typeof data === "string" ? t(data) : data };
}

async function parseBody(c: any): Promise<Record<string, string>> {
  const body: Record<string, string> = {};
  const rawBody = await c.req.parseBody().catch(() => ({}));
  for (const [k, v] of Object.entries(rawBody)) body[k] = typeof v === "string" ? v : "";
  return body;
}

async function allParams(c: any): Promise<Record<string, string>> {
  return { ...c.req.query(), ...(await parseBody(c)) };
}

/** 校验当前用户为系统管理员。 */
function adminGuard(c: any): boolean {
  return isAdmin(c.get("currentUser") as AuthUser);
}

// ============ 计划任务执行器 ============

/** 注册 type=method 任务的 worker 内部处理器。未来内置任务(备份等)在此注册。 */
const METHOD_HANDLERS: Record<string, (c: any) => Promise<boolean>> = {};

export function registerMethodTask(event: string, handler: (c: any) => Promise<boolean>) {
  METHOD_HANDLERS[event] = handler;
}

interface TaskRow {
  id: number;
  name: string;
  type: string;
  event: string;
  time: string;
  desc: string;
  enable: number;
  system: number;
  sort: number;
  last_time: number;
}

interface TaskTime {
  type?: string;
  month?: string;
  week?: string;
  day?: string;
  minute?: string;
}

function parseTaskTime(raw: string): TaskTime | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as TaskTime;
    return typeof obj === "object" && obj !== null ? obj : null;
  } catch {
    return null;
  }
}

/** 解析 "HH:MM" 时刻。 */
function parseHHMM(s: string | undefined): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || "").trim());
  if (!m) return null;
  return { h: parseInt(m[1], 10), m: parseInt(m[2], 10) };
}

/** 本地日期键 YYYY-MM-DD。 */
function dateKey(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** 判断任务是否到期 (nowSec 秒时间戳)。 */
export function taskDue(task: Pick<TaskRow, "time" | "last_time">, nowSec: number): boolean {
  const time = parseTaskTime(task.time);
  if (!time) return false;
  const type = time.type || "minute";
  const last = Number(task.last_time) || 0;

  if (type === "minute") {
    const interval = Math.max(1, parseInt(time.minute || "1", 10) || 1) * 60;
    return nowSec - last >= interval;
  }

  const hm = parseHHMM(time.day);
  if (!hm) return false;
  // 定点类型: 当日该时刻已过且今天尚未执行过
  if (dateKey(last) === dateKey(nowSec)) return false;
  const now = new Date(nowSec * 1000);
  if (minutesOfDay(now) < hm.h * 60 + hm.m) return false;

  if (type === "day") return true;
  if (type === "week") {
    let wd = now.getDay();
    if (wd === 0) wd = 7;
    return wd === parseInt(time.week || "0", 10);
  }
  if (type === "month") {
    return now.getDate() === parseInt(time.month || "0", 10);
  }
  return false;
}

/** 计算任务下次执行时间的可读描述。 */
export function taskNextTime(task: Pick<TaskRow, "time">): string {
  const time = parseTaskTime(task.time);
  if (!time) return "";
  const type = time.type || "minute";
  if (type === "minute") return `every ${parseInt(time.minute || "1", 10) || 1} min`;
  const hm = parseHHMM(time.day);
  if (!hm) return "";
  const hh = String(hm.h).padStart(2, "0");
  const mm = String(hm.m).padStart(2, "0");
  if (type === "day") return `every day ${hh}:${mm}`;
  if (type === "week") return `every week day ${time.week || "-"} ${hh}:${mm}`;
  if (type === "month") return `every month day ${time.month || "-"} ${hh}:${mm}`;
  return "";
}

/** 执行单个任务, 返回 {code, data}。执行成功后更新 last_time。 */
async function runTask(c: any, task: TaskRow): Promise<{ code: boolean; data: string }> {
  let res: { code: boolean; data: string };
  if (task.type === "url") {
    try {
      const r = await fetch(task.event, { method: "GET", signal: AbortSignal.timeout(30000) });
      res = { code: r.ok, data: r.ok ? "ok" : `HTTP ${r.status}` };
    } catch {
      res = { code: false, data: "network error" };
    }
  } else {
    const handler = METHOD_HANDLERS[task.event];
    if (!handler) {
      res = { code: false, data: `[${task.event}] method not exists!` };
    } else {
      try {
        res = { code: await handler(c), data: "ok" };
      } catch {
        res = { code: false, data: "error" };
      }
    }
  }
  if (res.code) {
    await c.env.DB.prepare("UPDATE system_task SET last_time = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000), task.id).run();
  }
  return res;
}

async function getTask(db: D1Database, id: number): Promise<TaskRow | null> {
  return (await db.prepare("SELECT * FROM system_task WHERE id = ?").bind(id).first()) as unknown as TaskRow | null;
}

/** add/edit 时校验任务值: url 类型校验地址, method 类型校验处理器存在。 */
function checkEvent(c: any, type: string, event: string): string | null {
  if (type === "url") {
    try {
      const u = new URL(event);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "url error!";
      return null;
    } catch {
      return "url error!";
    }
  }
  if (!METHOD_HANDLERS[event]) return `[${event}] method not exists!`;
  return null;
}

// ============ admin/autoRun ============

/**
 * 自动执行入口 (001 adminAutoRun::index 绑定日志 hook 并让任务循环执行)。
 * 检查所有启用任务, 到期即执行; 返回本次执行摘要。
 */
autoTaskApi.all("/autoRun/index", async (c) => {
  const user = c.get("currentUser") as AuthUser;
  const now = Math.floor(Date.now() / 1000);
  const rows = (await c.env.DB.prepare("SELECT * FROM system_task WHERE enable = 1 ORDER BY sort ASC, id ASC").all()) as unknown as {
    results: TaskRow[];
  };
  const summary: { id: number; name: string; event: string; type: string; run: boolean; code: boolean; data: string }[] = [];
  for (const task of rows.results) {
    if (!taskDue(task, now)) continue;
    const res = await runTask(c, task);
    summary.push({
      id: task.id,
      name: task.name,
      event: task.event,
      type: task.type,
      run: true,
      code: res.code,
      data: res.data,
    });
  }
  const result = {
    user: user?.username || "",
    runCount: summary.length,
    list: summary,
  };
  return c.json(ok(result));
});

// ============ admin/autoTask ============

/** 计划任务列表 - admin/autoTask/get */
autoTaskApi.all("/autoTask/get", async (c) => {
  if (!adminGuard(c)) return c.json(fail("common.invalidRequest"));
  const rows = (await c.env.DB.prepare("SELECT * FROM system_task ORDER BY sort ASC, id ASC").all()) as unknown as {
    results: TaskRow[];
  };
  const list = rows.results.map((r) => ({
    ...r,
    nextTime: taskNextTime(r),
  }));
  return c.json(ok(list));
});

/** 添加计划任务 - admin/autoTask/add */
autoTaskApi.all("/autoTask/add", async (c) => {
  if (!adminGuard(c)) return c.json(fail("common.invalidRequest"));
  const q = await allParams(c);
  const name = (q.name || "").trim();
  const type = (q.type || "").trim();
  const event = (q.event || "").trim();
  const time = (q.time || "").trim();
  if (!name || !type || !event || !time) return c.json(fail("common.invalidParam"));
  if (!parseTaskTime(time)) return c.json(fail("common.invalidParam"));
  const err = checkEvent(c, type, event);
  if (err) return c.json(fail(err));

  const dup = await c.env.DB.prepare("SELECT id FROM system_task WHERE name = ?").bind(name).first();
  if (dup) return c.json(fail("explorer.repeatError"));

  const maxRow = await c.env.DB.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS nextSort FROM system_task").first<{ nextSort: number }>();
  const result = await c.env.DB.prepare(
    "INSERT INTO system_task (name, type, event, time, desc, enable, system, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(name, type, event, time, q.desc || "", q.enable === "1" ? 1 : 0, q.system === "1" ? 1 : 0, maxRow?.nextSort ?? 0).run();
  const meta = result.meta as any;
  return c.json(ok("explorer.success", meta?.last_row_id ?? 0));
});

/** 更新计划任务 - admin/autoTask/edit */
autoTaskApi.all("/autoTask/edit", async (c) => {
  if (!adminGuard(c)) return c.json(fail("common.invalidRequest"));
  const q = await allParams(c);
  const id = parseInt(q.id || "0", 10);
  if (!id) return c.json(fail("common.invalidParam"));
  const name = (q.name || "").trim();
  const type = (q.type || "").trim();
  const event = (q.event || "").trim();
  const time = (q.time || "").trim();
  if (!name || !type || !event || !time) return c.json(fail("common.invalidParam"));
  if (!parseTaskTime(time)) return c.json(fail("common.invalidParam"));
  const err = checkEvent(c, type, event);
  if (err) return c.json(fail(err));

  const result = await c.env.DB.prepare(
    "UPDATE system_task SET name = ?, type = ?, event = ?, time = ?, desc = ?, enable = ? WHERE id = ?"
  ).bind(name, type, event, time, q.desc || "", q.enable === "1" ? 1 : 0, id).run();
  return c.json(ok(result.meta?.changes ? "explorer.success" : "explorer.error"));
});

/** 启动/关闭任务 - admin/autoTask/enable */
autoTaskApi.all("/autoTask/enable", async (c) => {
  if (!adminGuard(c)) return c.json(fail("common.invalidRequest"));
  const q = await allParams(c);
  const id = parseInt(q.id || "0", 10);
  if (!id) return c.json(fail("common.invalidParam"));
  const enable = q.enable === "1" || q.enable === "true" ? 1 : 0;
  const result = await c.env.DB.prepare("UPDATE system_task SET enable = ? WHERE id = ?").bind(enable, id).run();
  return c.json(ok(result.meta?.changes ? "explorer.success" : "explorer.error"));
});

/** 删除计划任务 - admin/autoTask/remove */
autoTaskApi.all("/autoTask/remove", async (c) => {
  if (!adminGuard(c)) return c.json(fail("common.invalidRequest"));
  const q = await allParams(c);
  const id = parseInt(q.id || "0", 10);
  if (!id) return c.json(fail("common.invalidParam"));
  const result = await c.env.DB.prepare("DELETE FROM system_task WHERE id = ?").bind(id).run();
  return c.json(ok(result.meta?.changes ? "explorer.success" : "explorer.error"));
});

/** 手动立即执行某个任务 - admin/autoTask/run */
autoTaskApi.all("/autoTask/run", async (c) => {
  if (!adminGuard(c)) return c.json(fail("common.invalidRequest"));
  const q = await allParams(c);
  const id = parseInt(q.id || "0", 10);
  const task = id ? await getTask(c.env.DB, id) : null;
  if (!task) return c.json(fail("explorer.error"));
  const res = await runTask(c, task);
  return c.json(res.code ? ok("explorer.success") : fail(res.data));
});

/** 开启/关闭计划任务总开关 - admin/autoTask/taskSwitch */
autoTaskApi.all("/autoTask/taskSwitch", async (c) => {
  if (!adminGuard(c)) return c.json(fail("common.invalidRequest"));
  const q = await allParams(c);
  const status = q.status === "1" || q.status === "true" ? "1" : "0";
  const delay = parseInt(q.delay || "10", 10) || 10;
  await setSetting(c.env.DB, "autoTaskStatus", status);
  await setSetting(c.env.DB, "autoTaskDelay", String(delay));
  return c.json(ok({ status, delay }));
});

/** 重启计划任务 - admin/autoTask/taskRestart (worker 无常驻进程, 等价确认开关状态) */
autoTaskApi.all("/autoTask/taskRestart", async (c) => {
  if (!adminGuard(c)) return c.json(fail("common.invalidRequest"));
  const status = (await getSetting(c.env.DB, "autoTaskStatus")) ?? "1";
  const delay = (await getSetting(c.env.DB, "autoTaskDelay")) ?? "10";
  return c.json(ok({ status, delay }));
});

/** 拖拽排序 - admin/autoTask/sort (ids 逗号分隔) */
autoTaskApi.all("/autoTask/sort", async (c) => {
  if (!adminGuard(c)) return c.json(fail("common.invalidRequest"));
  const q = await allParams(c);
  const ids = (q.ids || "").split(",").filter((x) => /^\d+$/.test(x)).map(Number);
  for (let i = 0; i < ids.length; i++) {
    await c.env.DB.prepare("UPDATE system_task SET sort = ? WHERE id = ?").bind(i, ids[i]).run();
  }
  return c.json(ok("explorer.success"));
});

export { autoTaskApi };
