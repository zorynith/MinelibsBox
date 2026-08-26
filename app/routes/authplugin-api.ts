/**
 * User AuthPlugin API - 插件权限检测
 * Mirrors 001 user/authPlugin.class.php: checkAuth 判断某插件对当前用户是否可用,
 * checkAuthValue 解析插件权限配置 {"all","user","group","role"} 检测用户归属。
 */
import { Hono } from "hono";
import { authRequired } from "../lib/auth";
import { getPluginMeta } from "../lib/db";

type Vars = { currentUser: import("../lib/auth").AuthUser };

const authPluginApi = new Hono<{ Bindings: Env; Variables: Vars }>();

async function reqParams(c: any): Promise<Record<string, string>> {
  const body = await c.req.parseBody().catch(() => ({}));
  return { ...body, ...c.req.query() };
}

/** 当前用户的部门 id 列表 */
async function userGroupIds(c: any, userID: number): Promise<number[]> {
  const rows = await c.env.DB.prepare("SELECT group_id FROM user_groups WHERE user_id = ?")
    .bind(userID).all().catch(() => ({ results: [] as any[] }));
  return (rows.results || []).map((r: any) => r.group_id);
}

/** 001 checkAuthValue: 解析插件权限配置并检测用户归属。 */
async function checkAuthValue(c: any, auth: unknown, user: Vars["currentUser"]): Promise<boolean> {
  let parsed: Record<string, any> | null = null;
  if (typeof auth === "string") {
    try {
      parsed = JSON.parse(auth);
    } catch {
      parsed = null;
    }
  } else if (auth && typeof auth === "object") {
    parsed = auth as Record<string, any>;
  }
  if (!parsed) return false;
  if (parsed.all === "1") return true; // 全部(含未登录)
  if (!user) return false;

  const isRoot = user.role === "admin" || user.role === "root";
  if (parsed.user === "all") return true;
  if (parsed.user === "admin" && isRoot) return true;
  if (parsed.role === "1" && isRoot) return true;

  const groupIds = await userGroupIds(c, user.id);
  const userList = (parsed.user ? String(parsed.user).split(",") : []).map((x) => parseInt(x, 10)).filter(Number.isInteger);
  const groupList = (parsed.group ? String(parsed.group).split(",") : []).map((x) => parseInt(x, 10)).filter(Number.isInteger);
  const roleList = (parsed.role ? String(parsed.role).split(",") : []).map((x) => parseInt(x, 10)).filter(Number.isInteger);

  if (userList.includes(user.id)) return true;
  if (roleList.includes(user.role === "admin" || user.role === "root" ? 1 : 3)) return true;
  if (groupList.some((gid) => groupIds.includes(gid))) return true;
  return false;
}

/** 001 checkAuth: 插件存在且启用, 并按权限配置判断当前用户可用性。 */
async function checkAuth(c: any, appName: string, user: Vars["currentUser"]): Promise<{ ok: boolean; error?: string }> {
  const meta = await getPluginMeta(c.env.DB, appName);
  // 001: 插件不存在则放行(转发接口); worker 未收录的插件同样放行
  if (meta.status === 1 && !(await pluginConfigHas(c, appName))) {
    return { ok: true };
  }
  if (meta.status === 0) {
    return { ok: false, error: "admin.plugin.closedError" };
  }
  const config = meta.config || {};
  if (config.pluginAuthOpen) return { ok: true };
  if (user.role === "admin" || user.role === "root") return { ok: true };
  if (config.pluginAuth) {
    return { ok: await checkAuthValue(c, config.pluginAuth, user) };
  }
  return { ok: false };
}

/** 插件是否被 worker 收录(ASSETS 提供) */
async function pluginConfigHas(c: any, appName: string): Promise<boolean> {
  try {
    const res = await c.env.ASSETS.fetch(new Request(`https://assets.local/plugins/${appName}/package.json`));
    return res.ok;
  } catch {
    return false;
  }
}

// ============ routes ============

authPluginApi.all("/authPlugin/checkAuth", authRequired, async (c) => {
  const params = await reqParams(c);
  const user = c.get("currentUser");
  const appName = params.appName || "";
  const result = await checkAuth(c, appName, user);
  return c.json({ code: result.ok, data: result.ok ? 1 : (result.error ?? "explorer.noPermissionAction") });
});

authPluginApi.all("/authPlugin/checkAuthValue", authRequired, async (c) => {
  const params = await reqParams(c);
  const user = c.get("currentUser");
  const ok = await checkAuthValue(c, params.auth, user);
  return c.json({ code: true, data: ok ? 1 : 0 });
});

authPluginApi.all("/authPlugin/autoCheck", authRequired, async (c) => {
  const params = await reqParams(c);
  const user = c.get("currentUser");
  const appName = params.appName || "";
  if (appName) {
    const result = await checkAuth(c, appName, user);
    if (!result.ok) {
      const msg = result.error ?? "explorer.noPermissionAction";
      const isGet = c.req.method === "GET";
      return isGet
        ? c.json({ code: false, data: `${msg}; ${appName}` })
        : c.json({ code: false, data: msg });
    }
  }
  return c.json({ code: true, data: "ok" });
});

export { authPluginApi };
