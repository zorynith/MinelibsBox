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
import { getTimezone } from "../lib/timezone";

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

function nowStr(tz = "Asia/Shanghai"): string {
  try {
    // sv-SE 的日期格式恰好是 "YYYY-MM-DD HH:MM:SS"
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
  }
}

// Worker 环境无操作系统信息(/proc 不可读), upTime 恒为 N/A
const UPTIME_UNAVAILABLE = "N/A";

// ============ admin/server/srvGet ============

/** 基础信息 + 缓存/数据库配置 (001 adminServer::get) */
export async function srvGetData(c: any): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {};
  data["base"] = await serverBaseInfo(c);
  data["cache"] = { cacheType: "file", sessionType: "file" };
  const dbInfo: Record<string, unknown> = { db_type: "sqlite", db_name: "d1", db_dsn: "sqlite:d1" };
  dbInfo["db_info"] = await getDbInfo(c);
  data["db"] = dbInfo;
  return data;
}

/** CPU/内存/磁盘/存储状态 (001 adminServer::getSrvState) */
export async function srvStateData(c: any): Promise<Record<string, unknown>> {
  const tz = (await getTimezone(c.env, c.env.DB).catch(() => "")) || "Asia/Shanghai";
  // Workers 无法读取 /proc, CPU 无法采样; 内存以 128MB 隔离上限作为总量占位
  return {
    cpu: 0,
    memory: { sizeTotal: 128 * 1024 * 1024, sizeUse: 0 },
    server: { sizeTotal: 0, sizeUse: 0 },
    default: { sizeTotal: 0, sizeUse: 0 },
    time: { time: nowStr(tz), upTime: UPTIME_UNAVAILABLE },
  };
}

adminServerApi.all("/server/srvGet", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  return c.json(ok(await srvGetData(c)));
});

// ============ admin/server/getSrvState ============

adminServerApi.all("/server/getSrvState", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  return c.json(ok(await srvStateData(c)));
});

// ============ admin/server/getServerInfo ============

export async function serverBaseInfo(c: any): Promise<Record<string, unknown>> {
  const req = c.req.raw;
  const url = new URL(req.url);
  const host = req.headers.get("host") || url.host || "";
  const serverSoftware = req.headers.get("cf-ray") ? "Cloudflare Workers" : "Workers (local dev)";
  const tz = (await getTimezone(c.env, c.env.DB).catch(() => "")) || "Asia/Shanghai";
  const clientIp =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "";
  const data: Record<string, unknown> = {
    server_state: {},
    server_info: {
      name: host,
      ip: clientIp,
      time: nowStr(tz),
      upTime: UPTIME_UNAVAILABLE,
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
      ip: clientIp,
      ua: req.headers.get("user-agent") || "",
      language: req.headers.get("accept-language") || "",
    },
  };
  return data;
}

// ============ admin/server/getDbInfo ============

// 逐表 COUNT(*) 在库大时非常慢, 会让 /setting/server 超过 Cloudflare 100s 限制(524)。
// 这里并行统计并加 5s 超时兜底, 结果在 isolate 内缓存 60s。
let dbInfoCache: { at: number; data: Record<string, unknown> } | null = null;
const DB_INFO_TTL = 60 * 1000;
const DB_INFO_TIMEOUT = 5000;

export async function getDbInfo(c: any): Promise<Record<string, unknown>> {
  if (dbInfoCache && Date.now() - dbInfoCache.at < DB_INFO_TTL) return dbInfoCache.data;
  const tables: any[] = (await c.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().catch(() => ({ results: [] as any[] }))).results || [];
  const counts = await Promise.race([
    Promise.all(
      tables.map((t) =>
        c.env.DB.prepare(`SELECT COUNT(*) AS total FROM "${t.name}"`).first().catch(() => null)
      )
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), DB_INFO_TIMEOUT)),
  ]);
  let rows = 0;
  if (counts) {
    for (const row of counts as any[]) rows += parseInt(String(row?.total ?? "0"), 10) || 0;
  }
  const data: Record<string, unknown> = {
    total_tables: tables.length,
    total_rows: rows,
    total_size: 0,
  };
  if (!counts) data.partial = true;
  dbInfoCache = { at: Date.now(), data };
  return data;
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

// ============ admin/server/getServerInfo ============

adminServerApi.all("/server/getServerInfo", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  return c.json(ok(await serverBaseInfo(c)));
});

// ============ admin/server/getDbInfo ============

adminServerApi.all("/server/getDbInfo", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  return c.json(ok(await getDbInfo(c)));
});

// ============ admin/server/_dbType ============

adminServerApi.all("/server/_dbType", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  return c.json(ok("sqlite"));
});

// ============ admin/server/recoverySave & recoveryFileSave ============

// 从备份恢复 (001 adminServer::recoverySave/recoveryFileSave: 完整恢复由 admin/backup 承担)
adminServerApi.all("/server/recoverySave", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  return c.json(fail("恢复请使用数据备份管理功能 (admin/backup)"));
});

adminServerApi.all("/server/recoveryFileSave", async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  return c.json(fail("恢复请使用数据备份管理功能 (admin/backup)"));
});

export { adminServerApi };
