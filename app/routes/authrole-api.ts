/**
 * User AuthRole API - 角色权限拦截与查询
 * Mirrors 001 user/authRole.class.php: 解析用户角色权限点 -> {info, allowAction, roleList},
 * 并提供 authCan 系列查询(内部权限判断用)。
 */
import { Hono } from "hono";
import { authRequired } from "../lib/auth";
import {
  AUTH_ROLE_ACTION,
  AUTH_ALLOW_ACTION,
  AUTH_ROLE_ACTION_KEEP_TRUE,
  AUTH_ALIAS,
  AUTH_ACTION_MAP,
} from "../lib/auth-role-config";

type Vars = { currentUser: import("../lib/auth").AuthUser };

const authRoleApi = new Hono<{ Bindings: Env; Variables: Vars }>();

/** worker users.role -> roles.id: admin/root=1(Administrator), 其余=3(默认用户) */
function roleIdOf(user: Vars["currentUser"]): number {
  return user.role === "admin" || user.role === "root" ? 1 : 3;
}

/** 递归求权限点的所有上层依赖 (001 authCheckAliasParent)。 */
function authAliasParents(key: string, result: Record<string, boolean> = {}): string[] {
  const parents = AUTH_ALIAS[key];
  if (!parents) return Object.keys(result);
  for (const p of parents) {
    if (result[p]) continue;
    result[p] = true;
    authAliasParents(p, result);
  }
  return Object.keys(result);
}

/** 权限前置依赖过滤: 依赖点都具备时才算拥有 (001 authCheckAlias)。 */
function authCheckAlias(auth: string): string[] {
  const authList = auth.split(",").map((s) => s.trim()).filter(Boolean);
  const userRoleAllow: string[] = [];
  for (const action of authList) {
    const needAuth = authAliasParents(action, {});
    if (needAuth.length === 0) {
      userRoleAllow.push(action);
      continue;
    }
    if (needAuth.every((a) => authList.includes(a))) {
      userRoleAllow.push(action);
    }
  }
  return userRoleAllow;
}

/** 解析用户角色权限 -> {info, allowAction, roleList} (001 userRoleAuth)。 */
/** 兼容 GET query 与 POST body 的参数获取 (001 $this->in)。 */
async function reqParams(c: any): Promise<Record<string, string>> {
  const body = await c.req.parseBody().catch(() => ({}));
  return { ...body, ...c.req.query() };
}

async function userRoleAuth(c: any, roleID?: number): Promise<any> {
  const user = c.get("currentUser");
  const id = roleID ?? roleIdOf(user);
  const role = await c.env.DB.prepare("SELECT * FROM roles WHERE id = ?").bind(id).first().catch(() => null);
  if (!role) return null;

  const userRoleAllow = authCheckAlias(String((role as any).auth || ""));
  const authRoleList: Record<string, number> = {};
  const allowAction: Record<string, number> = {};
  for (const [perm, modelActions] of Object.entries(AUTH_ROLE_ACTION)) {
    const enable = userRoleAllow.includes(perm) ? 1 : 0;
    authRoleList[perm] = enable;
    if (!modelActions) continue;
    const actionArray: string[] = [];
    for (const [controller, stActions] of Object.entries(modelActions)) {
      if (!stActions) continue;
      for (const action of stActions.split(",").filter(Boolean)) {
        actionArray.push(`${controller}.${action}`);
      }
    }
    for (const action of actionArray) {
      const lower = action.toLowerCase();
      if (allowAction[lower] == null) {
        allowAction[lower] = enable;
        continue;
      }
      if (AUTH_ROLE_ACTION_KEEP_TRUE.includes(perm)) {
        if (enable) allowAction[lower] = enable;
        continue;
      }
      if (allowAction[lower]) allowAction[lower] = enable;
    }
  }
  for (const action of AUTH_ALLOW_ACTION) allowAction[action.toLowerCase()] = 1;
  return { info: role, allowAction, roleList: authRoleList };
}

/** 001 authCan: root 不受限, 否则角色权限点==1。 */
async function authCan(c: any, action: string): Promise<boolean> {
  const user = c.get("currentUser");
  if (user.role === "root") return true;
  const role = await userRoleAuth(c);
  return role?.roleList?.[action] === 1;
}

/** 001 userRoleGet: 指定用户角色信息; 用户不存在/无角色/禁用时返回 false。 */
async function userRoleGet(c: any, userID: number): Promise<any> {
  const user = await c.env.DB.prepare("SELECT id, username, role, status FROM users WHERE id = ?")
    .bind(userID).first().catch(() => null);
  if (!user || !user.username) return false;
  const roleId = (user as any).role === "admin" || (user as any).role === "root" ? 1 : 3;
  const role = await userRoleAuth(c, roleId);
  if (!role) return false;
  if (Number((user as any).status) === 0) return false;
  return role;
}

// ============ routes ============

authRoleApi.all("/authRole/userRoleAuth", authRequired, async (c) => {
  const params = await reqParams(c);
  const roleID = params.roleID ? parseInt(params.roleID, 10) : undefined;
  const role = roleID ? await userRoleAuth(c, roleID) : await userRoleAuth(c);
  return c.json({ code: true, data: role ?? null });
});

authRoleApi.all("/authRole/authCan", authRequired, async (c) => {
  const params = await reqParams(c);
  const action = params.action || "";
  const ok = await authCan(c, action);
  return c.json({ code: true, data: ok ? 1 : 0 });
});

authRoleApi.all("/authRole/authCanSearch", authRequired, async (c) => {
  return c.json({ code: true, data: (await authCan(c, "explorer.search")) ? 1 : 0 });
});

authRoleApi.all("/authRole/authCanRead", authRequired, async (c) => {
  return c.json({ code: true, data: (await authCan(c, "explorer.view")) ? 1 : 0 });
});

authRoleApi.all("/authRole/authCanEdit", authRequired, async (c) => {
  return c.json({ code: true, data: (await authCan(c, "explorer.edit")) ? 1 : 0 });
});

authRoleApi.all("/authRole/authCanDownload", authRequired, async (c) => {
  return c.json({ code: true, data: (await authCan(c, "explorer.download")) ? 1 : 0 });
});

authRoleApi.all("/authRole/authCanUser", authRequired, async (c) => {
  const params = await reqParams(c);
  const action = params.action || "";
  const userID = params.userID ? parseInt(params.userID, 10) : 0;
  if (!action || !userID) return c.json({ code: true, data: 0 });
  const role = await userRoleGet(c, userID);
  if (!role) return c.json({ code: true, data: 0 });
  if (Number((role as any).info?.administrator) === 1) return c.json({ code: true, data: 1 });
  return c.json({ code: true, data: role.roleList?.[action] === 1 ? 1 : 0 });
});

authRoleApi.all("/authRole/userRoleGet", authRequired, async (c) => {
  const params = await reqParams(c);
  const userID = params.userID ? parseInt(params.userID, 10) : 0;
  const role = userID ? await userRoleGet(c, userID) : false;
  return c.json({ code: true, data: role ?? false });
});

authRoleApi.all("/authRole/canCheckRole", authRequired, async (c) => {
  const params = await reqParams(c);
  const action = params.action || "";
  const perms = AUTH_ACTION_MAP[action];
  if (!perms) return c.json({ code: true, data: 1 });
  for (const p of perms) {
    if (await authCan(c, p)) return c.json({ code: true, data: 1 });
  }
  return c.json({ code: true, data: 0 });
});

export { authRoleApi };
