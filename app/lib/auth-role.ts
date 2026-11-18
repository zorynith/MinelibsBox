/**
 * 角色级权限拦截 (001 explorer/auth.class.php::can → Action('user.authRole')->canCheckRole)。
 *
 * 001 的权限判定是两层:
 *   1) 角色权限点 (roles.auth, 如 explorer.download) —— "这个角色的用户能不能做这类操作";
 *   2) 文档权限位 (source_auth / 部门权限, 8 个位) —— "这个用户对这份文档有没有该权限"。
 * 本文件只负责第 1 层; 第 2 层在 explorer-api 的 requireSourceAuth 里。
 */
import { AUTH_ROLE_ACTION, AUTH_ALLOW_ACTION, AUTH_ROLE_ACTION_KEEP_TRUE } from "./auth-role-config";
import type { AuthUser } from "./auth";

const actionKeyCache = new Map<string, string[]>();

/** `${controller}.${action}` (小写) -> 归属的角色权限点列表。 */
function permissionKeysOf(actionKey: string): string[] {
  const cached = actionKeyCache.get(actionKey);
  if (cached) return cached;
  const keys: string[] = [];
  for (const [perm, controllers] of Object.entries(AUTH_ROLE_ACTION)) {
    if (!controllers) continue;
    for (const [controller, actions] of Object.entries(controllers)) {
      for (const act of String(actions || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        if (`${controller}.${act}`.toLowerCase() === actionKey) keys.push(perm);
      }
    }
  }
  actionKeyCache.set(actionKey, keys);
  return keys;
}

export function roleIdOf(user: AuthUser): number {
  const raw = Number((user as any).roleID);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return user.role === "root" || user.role === "admin" ? 1 : 3;
}

export function isAdministrator(user: AuthUser): boolean {
  return roleIdOf(user) === 1;
}

/** 角色权限点缓存 (roles 表很少变更; 60s 内存缓存, 避免每次请求都查 D1) */
const roleCache = new Map<number, { at: number; perms: Set<string> }>();

/** 读取角色的权限点集合 (roles.auth 逗号分隔); 管理员视为拥有全部。 */
export async function rolePermissions(db: D1Database, user: AuthUser): Promise<Set<string>> {
  if (isAdministrator(user)) return new Set(Object.keys(AUTH_ROLE_ACTION));
  const rid = roleIdOf(user);
  const cached = roleCache.get(rid);
  if (cached && Date.now() - cached.at < 60_000) return cached.perms;
  const row = await db
    .prepare("SELECT auth FROM roles WHERE id = ?")
    .bind(rid)
    .first<{ auth: string }>()
    .catch(() => null);
  const list = String(row?.auth || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const perms = new Set(list);
  roleCache.set(rid, { at: Date.now(), perms });
  return perms;
}

/** 角色权限变更后清缓存 (admin 保存角色权限时调用) */
export function clearRolePermissionCache(): void {
  roleCache.clear();
}

/**
 * 001 authCan 的等价实现: 该用户能否执行 controller.action。
 * 未登记在 AUTH_ROLE_ACTION 里的动作不拦截 (与 001 一致, 由文档权限位负责)。
 */
export async function roleAllowsAction(
  db: D1Database,
  user: AuthUser,
  controller: string,
  action: string
): Promise<boolean> {
  if (isAdministrator(user)) return true;
  const key = `${controller}.${action}`.toLowerCase();
  if (AUTH_ALLOW_ACTION.some((a) => a.toLowerCase() === key)) return true;
  const perms = permissionKeysOf(key);
  if (perms.length === 0) return true;
  const owned = await rolePermissions(db, user);
  if (perms.some((p) => AUTH_ROLE_ACTION_KEEP_TRUE.includes(p))) {
    return perms.some((p) => owned.has(p));
  }
  return perms.some((p) => owned.has(p));
}

/** 用户是否具备某个角色权限点 (如 admin.storage.edit)。 */
export async function hasRolePermission(db: D1Database, user: AuthUser, perm: string): Promise<boolean> {
  const owned = await rolePermissions(db, user);
  return owned.has(perm);
}
