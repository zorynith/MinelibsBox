/**
 * Source (virtual path prefix) resolution.
 *
 * Frontend virtual paths use `{source:home}` for the user's personal space and
 * `{source:ID}` for a department (group) shared space, where ID is the group id
 * (sourceID == groupID in this implementation). Every R2 storage operation
 * resolves its virtual path to a baseKey (storage root) + real relative path.
 */
import type { AuthUser } from "./auth";

export type SourceType = "user" | "group";

export interface SourceRef {
  sourceId: string;
  type: SourceType;
  baseKey: string;
  targetID: number;
  displayName: string;
  ioDriver?: number;
  authShowType?: string;
  authShowGroup?: string;
}

export type SourceResolve =
  | { ok: true; source: SourceRef; relPath: string }
  | { ok: false; error: string };

export function userSource(user: AuthUser): SourceRef {
  return {
    sourceId: "home",
    type: "user",
    baseKey: `${user.username}/`,
    targetID: user.id,
    displayName: "个人空间",
  };
}

export function isAdminUser(user: AuthUser): boolean {
  return user.role === "admin" || user.role === "root";
}

/** 提取真实相对路径: 去掉 `{source:...}` 等虚拟前缀, 保留以 `/` 开头的相对路径。 */
export function toRealPath(raw: string): string {
  const srcMatch = (raw || "").match(/^\{source:(home|\d+)\}(.*)$/);
  if (srcMatch) {
    const rest = srcMatch[2].replace(/^\/+/, "");
    return rest ? "/" + rest : "/";
  }
  let p = (raw || "").replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!p) p = "/";
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

/** 解析虚拟路径为 { source, relPath }。普通路径/`{source:home}` 落在个人空间; `{source:ID}` 落在部门空间。 */
export async function resolveFileSource(env: Env, user: AuthUser, raw: string): Promise<SourceResolve> {
  const srcMatch = (raw || "").match(/^\{source:(home|\d+)\}(.*)$/);
  if (!srcMatch) {
    return { ok: true, source: userSource(user), relPath: toRealPath(raw) };
  }
  const srcId = srcMatch[1];
  const rest = srcMatch[2].replace(/^\/+/, "");
  const relPath = rest ? "/" + rest : "/";
  if (srcId === "home") {
    return { ok: true, source: userSource(user), relPath };
  }

  const groupID = parseInt(srcId, 10);
  if (!Number.isInteger(groupID) || groupID <= 0) return { ok: false, error: "common.pathNotExists" };

  const group = await env.DB.prepare("SELECT id, name, status, io_driver, auth_show_type, auth_show_group FROM groups WHERE id = ?")
    .bind(groupID)
    .first()
    .catch(() => null);
  if (!group || (group as any).status === 0) return { ok: false, error: "common.pathNotExists" };

  if (!isAdminUser(user)) {
    const member = await env.DB.prepare("SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?")
      .bind(user.id, groupID)
      .first()
      .catch(() => null);
    if (!member) return { ok: false, error: "common.noPermission" };
  }

  return {
    ok: true,
    source: {
      sourceId: String(groupID),
      type: "group",
      baseKey: `__group__/${groupID}/`,
      targetID: groupID,
      displayName: (group as any).name as string,
      ioDriver: (group as any).io_driver ?? 0,
      authShowType: (group as any).auth_show_type || "all",
      authShowGroup: (group as any).auth_show_group || "",
    },
    relPath,
  };
}

/** 从父级链构造 group 元数据: groupPathRoot (逗号分隔 sourceID 链) 与 groupPathDisplay (斜杠分隔名称链)。 */
export function groupChainMeta(chain: { id: number; name: string }[]): { groupPathRoot: string; groupPathDisplay: string; parentLevel: string } {
  const ids = chain.map((g) => g.id);
  return {
    groupPathRoot: ids.join(",") + ",",
    groupPathDisplay: chain.map((g) => g.name).join("/"),
    parentLevel: "," + ids.join(",") + ",",
  };
}
