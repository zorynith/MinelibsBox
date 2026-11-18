/**
 * 部门空间权限检测 (对齐 001 SourceAuth / filterAuth 权限位)。
 *
 * 权限位定义 (与前端 authDefine 一致):
 *   show:1  view:2  download:4  upload:8  edit:16  remove:32
 *   share:64  comment:128  event:256  root:33554432
 *
 * 用户在部门内的权限由 user_groups.authID -> auths.auth 位掩码决定;
 * admin/root 用户绕过部门权限检测 (isRoot / ADMIN_ALLOW_SOURCE)。
 */
import type { AuthUser } from "./auth";
import { isAdminUser } from "./source";
import { pathSourceID } from "./source";
import type { SourceRef } from "./source";
import { isAdministrator, hasRolePermission } from "./auth-role";

export const AUTH_SHOW = 1;
export const AUTH_VIEW = 2;
export const AUTH_DOWNLOAD = 4;
export const AUTH_UPLOAD = 8;
export const AUTH_EDIT = 16;
export const AUTH_REMOVE = 32;
export const AUTH_SHARE = 64;
export const AUTH_COMMENT = 128;
export const AUTH_EVENT = 256;
export const AUTH_ROOT = 33554432;
export const AUTH_ALL = AUTH_ROOT + 511; // 完全控制

/** 获取用户在指定部门的权限位掩码; 非成员返回 0; admin 返回全权限。 */
export async function getGroupAuthValue(env: Env, user: AuthUser, groupID: number): Promise<number> {
  if (isAdminUser(user)) return AUTH_ALL;
  const row: any = await env.DB.prepare(
    `SELECT a.auth AS auth FROM user_groups ug
     LEFT JOIN auths a ON a.id = ug.authID
     WHERE ug.user_id = ? AND ug.group_id = ? AND ug.group_id > 0`
  )
    .bind(user.id, groupID)
    .first()
    .catch(() => null);
  if (!row) return 0;
  return parseInt(row.auth ?? "0", 10) || 0;
}

/** 用户个人空间视为完全可管理。 */
export function getPersonalAuthValue(): number {
  return AUTH_ALL;
}

/** 位掩码是否包含指定权限位。 */
export function hasAuth(authValue: number, bit: number): boolean {
  return (authValue & bit) === bit;
}

/** 把相对路径换算成 001 虚拟路径前缀, 便于按路径 hash 定位文档/祖先目录的 source_auth。 */
export function sourceVpathPrefix(source: SourceRef): string {
  if (source.type === "user") return "{source:home}";
  if (source.type === "group") return `{source:${source.targetID}}`;
  if (source.type === "io") return `{io:${source.ioType ?? source.sourceId}}`;
  return "{block:safe}";
}

/** 祖先目录的 sourceID 列表 (由近到远); 根目录不参与继承 (001 IO::infoAuth)。 */
export function ancestorSourceIDs(source: SourceRef, relPath: string): number[] {
  const prefix = sourceVpathPrefix(source);
  const trimmed = relPath.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  const out: number[] = [];
  for (let i = parts.length - 1; i >= 1; i--) {
    out.push(pathSourceID(prefix + "/" + parts.slice(0, i).join("/") + "/"));
  }
  return out;
}

/** 查询文档(sourceID)对当前用户(或用户所在部门)的单独权限覆盖; 无覆盖返回 null。 */
export async function getUserSourceAuthOverride(
  env: Env,
  user: AuthUser,
  sourceID: number
): Promise<number | null> {
  const rows = await env.DB.prepare(
    "SELECT authID, authDefine FROM source_auth WHERE sourceID = ? AND (targetType = 1 AND targetID = ? OR targetType = 2)"
  )
    .bind(String(sourceID), user.id)
    .all<{ authID: number; authDefine: number }>()
    .catch(() => null);
  if (!rows || rows.results.length === 0) return null;
  let result = 0;
  for (const row of rows.results) {
    if (row.authID) {
      const a = await env.DB.prepare("SELECT auth FROM auths WHERE id = ?").bind(row.authID).first<{ auth: number }>().catch(() => null);
      if (a) result |= Number(a.auth) || 0;
    }
    if (row.authDefine) result |= Number(row.authDefine) || 0;
  }
  return result;
}

/**
 * 用户在指定 source 上的权限位掩码 (001 IO::infoAuth):
 * 个人空间/保险箱=全权限; 部门空间=文档自身权限 > 父级继承 > 部门默认权限; io 挂载仅管理员可操作。
 */
export async function sourceAuthValueOf(
  env: Env,
  user: AuthUser,
  source: SourceRef,
  sourceID?: number,
  relPath?: string
): Promise<number> {
  if (source.type === "user") return getPersonalAuthValue();
  // 001 auth.class.php: io/物理路径仅管理员(或具备 admin.storage.edit)才可操作
  if (source.type === "io") {
    if (isAdministrator(user) || (await hasRolePermission(env.DB, user, "admin.storage.edit"))) {
      return getPersonalAuthValue();
    }
    return 0;
  }
  // 私密保险箱: 本人全权限
  if (source.type === "safe") return getPersonalAuthValue();
  if (sourceID) {
    const override = await getUserSourceAuthOverride(env, user, sourceID);
    if (override !== null) return override;
    if (relPath) {
      for (const sid of ancestorSourceIDs(source, relPath)) {
        const inherited = await getUserSourceAuthOverride(env, user, sid);
        if (inherited !== null) return inherited;
      }
    }
  }
  return getGroupAuthValue(env, user, source.targetID);
}
