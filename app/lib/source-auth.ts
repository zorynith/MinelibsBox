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
