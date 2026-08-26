/**
 * Admin Server API - 服务器信息与缓存/数据库配置 (复刻 001 admin/server)
 *  - srvGet: 服务器基础信息 + 缓存配置 + 数据库信息
 *  - getSrvState: CPU/内存/磁盘/存储状态 (Worker 环境无 OS, 结构占位)
 *  - getServerInfo / getDbInfo: 服务器与数据库详情
 *  - dbSave: D1(sqlite) 场景提示不支持切换
 *  - cacheSave: file 缓存成功, redis/memcached 不支持
 *  - srvPinfo: 环境信息占位
 */
import { Hono } from "hono";
import { authRequired, isAdmin } from "../lib/auth";
import type { AuthUser } from "../lib/auth";

type Vars = { currentUser: AuthUser };
const adminServerApi = new Hono<{ Bindings: Env; Variables: Vars }>();

adminServerApi.use("*", authRequired);

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

function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Worker 环境无操作系统信息(/proc 不可读), upTime 恒为 unavailable
const UPTIME_UNAVAILABLE = "unavailable";

// ============ admin/server/srvGet ============

adminServerApi.all("/server/srvGet", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  const data: Record<string, unknown> = {};
  data["base"] = await serverBaseInfo(c);
  data["cache"] = { cacheType: "file", sessionType: "file" };
  const dbInfo: Record<string, unknown> = { db_type: "sqlite", db_name: "d1", db_dsn: "sqlite:d1" };
  dbInfo["db_info"] = await getDbInfo(c);
  data["db"] = dbInfo;
  return c.json(ok(data));
});

// ============ admin/server/getSrvState ============

adminServerApi.all("/server/getSrvState", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  const data = {
    cpu: 0,
    memory: { sizeTotal: 0, sizeUse: 0 },
    server: { sizeTotal: 0, sizeUse: 0 },
    default: { sizeTotal: 0, sizeUse: 0 },
    time: { time: nowStr(), upTime: UPTIME_UNAVAILABLE },
  };
  return c.json(ok(data));
});

// ============ admin/server/getServerInfo ============

async function serverBaseInfo(c: any): Promise<Record<string, unknown>> {
  const req = c.req.raw;
  const url = new URL(req.url);
  const host = req.headers.get("host") || url.host || "";
  const serverSoftware = req.headers.get("cf-ray") ? "Cloudflare Workers" : "Workers (local dev)";
  const data: Record<string, unknown> = {
    server_state: {},
    server_info: {
      name: host,
      ip: req.headers.get("cf-connecting-ip") || "",
      time: nowStr(),
      upTime: "",
      softWare: serverSoftware,
      phpVersion: "workerd",
      system: "Cloudflare Workers",
      webPath: "/",
    },
    php_info: {
      detail: "srvPinfo",
      version: "workerd",
      memory_limit: "128M",
      post_max_size: "100M",
      upload_max_filesize: "100M",
      max_execution_time: "30s",
      max_input_time: "30s",
      disable_functions: "",
      php_ext: "",
      php_ext_need: {},
    },
    db_cache_info: {
      db: "SQLite (D1)",
      cache: "File",
    },
    client_info: {
      ip: req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "",
      ua: req.headers.get("user-agent") || "",
      language: req.headers.get("accept-language") || "",
    },
  };
  return data;
}

// ============ admin/server/getDbInfo ============

async function getDbInfo(c: any): Promise<Record<string, unknown>> {
  const tables: any[] = (await c.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().catch(() => ({ results: [] as any[] }))).results || [];
  let rows = 0;
  for (const t of tables) {
    const row: any = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM "${t.name}"`).first().catch(() => null);
    rows += parseInt(String(row?.total ?? "0"), 10) || 0;
  }
  return { total_tables: tables.length, total_rows: rows, total_size: 0 };
}

// ============ admin/server/dbSave ============

adminServerApi.all("/server/dbSave", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  const params = await allParams(c);
  const dbType = params.db_dsn || params.db_type || "sqlite";
  // 001: sqlite 下切换数据库直接提示需其他类型
  if (dbType === "sqlite") {
    return c.json(fail("admin.setting.dbNeedOthers"));
  }
  return c.json(fail("common.env.invalidExt"));
});

// ============ admin/server/cacheSave ============

adminServerApi.all("/server/cacheSave", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  const params = await allParams(c);
  const check = params.check === "1" || params.check === "true";
  const type = check ? params.type : params.cacheType;
  if (type && type !== "file") {
    // Worker 环境无 redis/memcached
    if (check) return c.json(fail("admin.install.cacheError"));
    return c.json(fail("common.env.invalidExt"));
  }
  return c.json(ok("explorer.success"));
});

// ============ admin/server/srvPinfo ============

adminServerApi.all("/server/srvPinfo", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  const base = await serverBaseInfo(c);
  return c.json(ok(base));
});

export { adminServerApi };
