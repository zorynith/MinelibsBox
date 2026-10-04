/**
 * 加密文件夹 (folder password) - 复刻 001 explorer/listPassword.class.php
 *
 * 001 通过 io_source_meta 的 folderPassword/folderPasswordDesc/
 * folderPasswordTimeTo/folderPasswordUser 记录文件夹密码; 会话通过
 * Session key `folderPassword_{sourceID}` 记录已通过校验的密码。
 *
 * worker 以虚拟路径的 FNV-1a hash 作为 sourceID (与 explorer-api fileSourceID 一致),
 * 上层文件夹链由虚拟路径逐级截取得到。
 */
import type { AuthUser } from "./auth";
import type { SourceRef } from "./source";
import { isAdminUser } from "./source";
import { getGroupAuthValue, hasAuth, AUTH_EDIT } from "./source-auth";
import { getFolderPasswordSession, setFolderPasswordSession } from "./db";

const FOLDER_PASSWORD_KEYS = ["folderPassword", "folderPasswordDesc", "folderPasswordTimeTo", "folderPasswordUser"] as const;

export interface FolderPasswordInfo {
  sourceID: number;
  folderPassword: string;
  folderPasswordDesc: string;
  folderPasswordTimeTo: number;
  folderPasswordUser?: string;
}

/** 与 explorer-api.ts fileSourceID 完全一致的 FNV-1a 32 位 hash。 */
export function folderSourceID(path: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 由文件路径得到其所在目录的虚拟路径 (以 `/` 结尾)。 */
export function parentVirtualDir(path: string): string {
  const p = (path || "").replace(/\\/g, "/");
  if (!p || p.endsWith("/")) return p;
  const idx = p.lastIndexOf("/");
  return idx < 0 ? "" : p.slice(0, idx + 1);
}

/**
 * 构建虚拟目录的祖先链 (含自身), 顺序为 根 -> 当前, 每项以 `/` 结尾。
 * 例: `{source:5}/a/b/` => [`{source:5}/`, `{source:5}/a/`, `{source:5}/a/b/`]
 */
export function folderPathChain(virtualDir: string): string[] {
  const m = (virtualDir || "").match(/^\{source:(home|\d+)\}/);
  if (!m) return [];
  const prefix = m[0];
  const rest = virtualDir.slice(prefix.length).replace(/^\/+|\/+$/g, "");
  const segs = rest ? rest.split("/").filter(Boolean) : [];
  const chain = [prefix + "/"];
  let acc = prefix;
  for (const s of segs) {
    acc += "/" + s;
    chain.push(acc + "/");
  }
  return chain;
}

/** 001 checkAuthNeed: 拥有编辑以上权限 / 个人空间本人 / 管理员则忽略密码。 */
async function checkAuthNeed(env: Env, user: AuthUser, source: SourceRef): Promise<boolean> {
  if (!source) return false;
  if (isAdminUser(user)) return false;
  if (source.type === "user") return false; // 个人空间本人可编辑
  if (source.type !== "group") return false; // 仅部门/用户共享空间需要密码
  const authValue = await getGroupAuthValue(env, user, source.targetID);
  return !hasAuth(authValue, AUTH_EDIT);
}

/**
 * 向上查找最近一层设置了密码的文件夹 (001 folderPasswordFind)。
 * 返回最靠近当前目录的未过期密码配置; 无则返回 null。
 */
async function folderPasswordFind(env: Env, virtualDir: string): Promise<FolderPasswordInfo | null> {
  const chain = folderPathChain(virtualDir);
  if (chain.length === 0) return null;

  const ids = chain.map(folderSourceID);
  const idPh = ids.map(() => "?").join(",");
  const keyPh = FOLDER_PASSWORD_KEYS.map(() => "?").join(",");
  const rows: any = await env.DB.prepare(
    `SELECT sourceID, key, value FROM source_meta WHERE sourceID IN (${idPh}) AND key IN (${keyPh})`
  ).bind(...ids.map(String), ...FOLDER_PASSWORD_KEYS).all().catch(() => ({ results: [] }));

  const byID = new Map<string, Record<string, string>>();
  for (const r of rows.results || []) {
    const map = byID.get(String(r.sourceID)) || {};
    map[String(r.key)] = String(r.value ?? "");
    byID.set(String(r.sourceID), map);
  }

  const now = Math.floor(Date.now() / 1000);
  const reversed = [...chain].reverse(); // 当前 -> 根
  for (const vpath of reversed) {
    const sid = folderSourceID(vpath);
    const meta = byID.get(String(sid));
    if (!meta || !meta.folderPassword) continue;
    const timeTo = parseInt(meta.folderPasswordTimeTo || "0", 10) || 0;
    if (timeTo > 0 && timeTo < now) continue; // 已过期
    return {
      sourceID: sid,
      folderPassword: meta.folderPassword,
      folderPasswordDesc: meta.folderPasswordDesc || "",
      folderPasswordTimeTo: timeTo,
      folderPasswordUser: meta.folderPasswordUser || undefined,
    };
  }
  return null;
}

/**
 * 001 listPassword::checkAllowPassword: 返回需要密码的文件夹信息 (未通过校验);
 * 已通过 (本请求携带正确密码或会话已记录) 时返回 null。
 */
export async function checkAllowPassword(
  env: Env,
  user: AuthUser,
  source: SourceRef,
  virtualDir: string,
  inputPw = "",
): Promise<FolderPasswordInfo | null> {
  if (!virtualDir) return null;
  if (!(await checkAuthNeed(env, user, source))) return null;
  const info = await folderPasswordFind(env, virtualDir);
  if (!info) return null;
  if (inputPw && inputPw === info.folderPassword) {
    await setFolderPasswordSession(env.DB, user.id, info.sourceID, info.folderPassword).catch(() => {});
    return null;
  }
  const stored = await getFolderPasswordSession(env.DB, user.id, info.sourceID).catch(() => null);
  if (stored && stored === info.folderPassword) return null;
  return info;
}

/** 输出给前端的 folderPasswordNeed (隐藏真实密码, 对齐 001 appendSafe unset folderPassword)。 */
export function folderPasswordNeed(info: FolderPasswordInfo): Record<string, unknown> {
  const { folderPassword: _pw, ...rest } = info;
  return rest;
}

/**
 * 001 authCheck 子目录检测: 文件夹本身无密码, 但内部存在需要密码的子文件夹时告警。
 * 仅对系统内置存储做有界扫描 (外部存储无法枚举), 返回第一个未通过校验的子文件夹。
 */
export async function folderPasswordChildNeed(
  env: Env,
  user: AuthUser,
  source: SourceRef,
  virtualDir: string,
): Promise<FolderPasswordInfo | null> {
  if (!virtualDir || !(await checkAuthNeed(env, user, source))) return null;
  if (source.type !== "group") return null;
  if (source.system !== 1 && source.ioDriver) return null; // 仅内置 R2 存储可扫描
  const self = await folderPasswordFind(env, virtualDir);
  if (self) return null; // 当前层已有密码, 交由 checkAllowPassword 处理

  const chain = folderPathChain(virtualDir);
  const prefixPath = chain[chain.length - 1] || "";
  if (!prefixPath) return null;

  const basePrefix = (source.baseKey || "").replace(/\/+$/, "") + "/";
  const realDir = virtualDir.replace(/^\{source:[^}]+\}/, "").replace(/^\/+/, "");
  const scanPrefix = basePrefix + realDir;
  const objList: string[] = [];
  let cursor: string | undefined;
  let rounds = 0;
  try {
    do {
      const listed = await env.FILES.list({ prefix: scanPrefix, cursor, limit: 1000 });
      for (const o of listed.objects) objList.push(o.key);
      rounds++;
      cursor = listed.truncated && rounds < 20 ? listed.cursor : undefined;
    } while (cursor);
  } catch {
    return null;
  }

  const seen = new Set<string>();
  const candidates: { sid: number; vpath: string }[] = [];
  for (const key of objList) {
    if (!key.startsWith(scanPrefix)) continue;
    // 相对当前目录的内层路径 (不含当前目录名本身)
    const inner = key.slice(scanPrefix.length);
    const isDir = inner.endsWith("/");
    const segs = inner.split("/").filter(Boolean);
    if (!isDir) segs.pop(); // 文件: 去掉文件名, 仅保留目录层; 目录占位(key 以 / 结尾)则全部保留
    let acc = prefixPath.replace(/\/+$/, "");
    for (const s of segs) {
      acc += "/" + s;
      const vpath = acc + "/";
      if (seen.has(vpath)) continue;
      seen.add(vpath);
      candidates.push({ sid: folderSourceID(vpath), vpath });
      if (candidates.length >= 5000) break;
    }
    if (candidates.length >= 5000) break;
  }
  if (candidates.length === 0) return null;

  const ids = candidates.map((c) => c.sid);
  const idPh = ids.map(() => "?").join(",");
  const rows: any = await env.DB.prepare(
    `SELECT sourceID, key, value FROM source_meta WHERE sourceID IN (${idPh}) AND key IN (?, ?, ?, ?)`
  ).bind(...ids.map(String), ...FOLDER_PASSWORD_KEYS).all().catch(() => ({ results: [] }));
  const byID = new Map<string, Record<string, string>>();
  for (const r of rows.results || []) {
    const map = byID.get(String(r.sourceID)) || {};
    map[String(r.key)] = String(r.value ?? "");
    byID.set(String(r.sourceID), map);
  }
  const now = Math.floor(Date.now() / 1000);
  for (const c of candidates) {
    const meta = byID.get(String(c.sid));
    if (!meta || !meta.folderPassword) continue;
    const timeTo = parseInt(meta.folderPasswordTimeTo || "0", 10) || 0;
    if (timeTo > 0 && timeTo < now) continue;
    const stored = await getFolderPasswordSession(env.DB, user.id, c.sid).catch(() => null);
    if (stored === meta.folderPassword) continue;
    return {
      sourceID: c.sid,
      folderPassword: meta.folderPassword,
      folderPasswordDesc: meta.folderPasswordDesc || "",
      folderPasswordTimeTo: timeTo,
      folderPasswordUser: meta.folderPasswordUser || undefined,
    };
  }
  return null;
}
