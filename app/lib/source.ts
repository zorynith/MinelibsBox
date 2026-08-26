/**
 * Source (virtual path prefix) resolution.
 *
 * Frontend virtual paths use `{source:home}` for the user's personal space and
 * `{source:ID}` for a department (group) shared space, where ID is the group id
 * (sourceID == groupID in this implementation). Every R2 storage operation
 * resolves its virtual path to a baseKey (storage root) + real relative path.
 */
import type { AuthUser } from "./auth";
import { getUserOption } from "./db";

export type SourceType = "user" | "group" | "io" | "safe";

export interface SourceRef {
  sourceId: string;
  type: SourceType;
  baseKey: string;
  targetID: number;
  displayName: string;
  ioDriver?: number;
  authShowType?: string;
  authShowGroup?: string;
  /** 仅 {io:N} 外部存储: io_source 记录 id */
  ioType?: number;
  /** 存储驱动名: minio/s3/... */
  driver?: string;
  /** 存储连接配置 (含 secret, 仅服务端使用) */
  ioConfig?: Record<string, unknown>;
  /** 是否为系统内置存储(R2 本地) */
  system?: number;
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

/** 提取真实相对路径: 去掉 `{source:...}`/`{io:N}` 等虚拟前缀, 保留以 `/` 开头的相对路径。 */
export function toRealPath(raw: string): string {
  const srcMatch = (raw || "").match(/^\{source:(home|\d+)\}(.*)$/);
  if (srcMatch) {
    const rest = srcMatch[2].replace(/^\/+/, "");
    return rest ? "/" + rest : "/";
  }
  const ioMatch = (raw || "").match(/^\{io:\d+\}(.*)$/);
  if (ioMatch) {
    const rest = ioMatch[1].replace(/^\/+/, "");
    return rest ? "/" + rest : "/";
  }
  let p = (raw || "").replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!p) p = "/";
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

/** 解析虚拟路径为 { source, relPath }。普通路径/`{source:home}` 落在个人空间; `{source:ID}` 落在部门空间; `{io:N}` 落在外部存储挂载。 */
export async function resolveFileSource(env: Env, user: AuthUser, raw: string): Promise<SourceResolve> {
  // 私密保险箱: {block:safe}/... 落在独立 baseKey, 且必须先解锁
  const safeMatch = (raw || "").match(/^\{block:safe\}(?:\/(.*))?$/);
  if (safeMatch) {
    const unlocked = await getUserOption(env.DB, user.id, "safe_unlocked", "safe");
    if (unlocked !== "1") return { ok: false, error: "保险箱未解锁" };
    const rest = (safeMatch[1] || "").replace(/^\/+/, "");
    return {
      ok: true,
      source: {
        sourceId: "safe",
        type: "safe",
        baseKey: `__safe__/${user.id}/`,
        targetID: user.id,
        displayName: "私密保险箱",
      },
      relPath: rest ? "/" + rest : "/",
    };
  }
  const ioMatch = (raw || "").match(/^\{io:(\d+)\}(.*)$/);
  if (ioMatch) {
    return resolveIoSource(env, user, ioMatch[1], ioMatch[2]);
  }
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

/** {io:N} → io_source 记录 → baseKey 派生自 config.basePath */
async function resolveIoSource(env: Env, user: AuthUser, rawId: string, restPath: string): Promise<SourceResolve> {
  const ioID = parseInt(rawId, 10);
  if (!Number.isInteger(ioID) || ioID <= 0) return { ok: false, error: "common.pathNotExists" };
  const io = await env.DB.prepare("SELECT id, name, driver, is_default, system, config FROM io_source WHERE id = ? AND status = 1")
    .bind(ioID)
    .first()
    .catch(() => null);
  if (!io) return { ok: false, error: "common.pathNotExists" };
  // 非管理员禁止直接浏览系统内置存储(R2 本地), 避免绕过个人空间前缀直接访问全部数据
  if (parseInt(String((io as any).system ?? "0"), 10) === 1 && !isAdminUser(user)) {
    return { ok: false, error: "common.noPermission" };
  }
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse((io as any).config || "{}");
  } catch {
    config = {};
  }
  // ftp/sftp 依赖出站 TCP, 当前 Worker 部署环境无法连接, 浏览/操作直接提示
  if (["ftp", "sftp"].includes(String((io as any).driver || "").toLowerCase())) {
    return { ok: false, error: "FTP/SFTP 驱动需要出站 TCP 连接, 当前云端部署环境不支持" };
  }
  const base = String(config.basePath || "").replace(/^\/+|\/+$/g, "");
  const baseKey = base ? base + "/" : "";
  const rel = (restPath || "").replace(/^\/+/, "");
  return {
    ok: true,
    source: {
      sourceId: String(ioID),
      type: "io",
      baseKey,
      targetID: ioID,
      displayName: (io as any).name as string,
      ioType: ioID,
      driver: (io as any).driver as string,
      ioConfig: config,
      system: parseInt(String((io as any).system ?? "0"), 10),
    },
    relPath: rel ? "/" + rel : "/",
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
