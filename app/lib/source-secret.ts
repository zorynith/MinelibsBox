/**
 * 文档密级 (复刻 001 SourceSecret 模型与 explorer/index::sourceSecretApply)。
 *
 * - 密级按 sourceID (worker 中为虚拟路径的 FNV-1a hash) 存于 source_secret 表;
 * - typeID 指向系统设置 sourceSecretList 中的一项, 空值表示取消密级(删行);
 * - 仅当 targetType == 'group' && 系统开启 sourceSecret && (管理员 || 白名单用户) 时才落库,
 *   但无论是否落库, meta 中的 user_sourceSecret 都必须摘除 (001 先 unset 再做条件判断)。
 * - 列表/详情读取时把 typeID 注入 metaInfo.user_sourceSecret, 前端按 sourceSecretList 渲染徽标。
 */
import { getSetting } from "./db";
import { isAdminUser } from "./source";
import type { AuthUser } from "./auth";

export const SOURCE_SECRET_META_KEY = "user_sourceSecret";

export interface SourceSecretRow {
  sourceID: string;
  typeID: string;
  createUser: number;
}

/** 001 systemOption.sourceSecret == '1' 才启用密级。 */
export async function sourceSecretEnabled(db: D1Database): Promise<boolean> {
  const v = await getSetting(db, "sourceSecret", true);
  return String(v ?? "0") === "1";
}

/** 001 sourceSecretApply 的权限条件: 系统管理员或 sourceSecretSetUser 白名单用户。 */
export async function sourceSecretAllowSet(db: D1Database, user: AuthUser): Promise<boolean> {
  if (!(await sourceSecretEnabled(db))) return false;
  if (isAdminUser(user)) return true;
  const allow = String((await getSetting(db, "sourceSecretSetUser", true)) || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allow.includes(String(user.id));
}

export async function getSourceSecret(db: D1Database, sourceID: string | number): Promise<SourceSecretRow | null> {
  const row = await db
    .prepare("SELECT sourceID, typeID, createUser FROM source_secret WHERE sourceID = ?")
    .bind(String(sourceID))
    .first<SourceSecretRow>()
    .catch(() => null);
  return row ?? null;
}

/** 批量读取 sourceID -> typeID, 供列表注入 (分块 IN 查询)。 */
export async function getSourceSecretMap(db: D1Database, sourceIDs: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ids = [...new Set(sourceIDs.filter((s) => s !== ""))];
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    try {
      const rows = (await db
        .prepare(`SELECT sourceID, typeID FROM source_secret WHERE sourceID IN (${placeholders})`)
        .bind(...chunk)
        .all()) as unknown as { results: { sourceID: string; typeID: string }[] };
      for (const r of rows.results) {
        if (String(r.typeID || "") !== "") map.set(String(r.sourceID), String(r.typeID));
      }
    } catch {
      /* 查询失败不影响列表 */
    }
  }
  return map;
}

/** 写入/更新/删除密级 (001 SourceSecret::insert/update/remove)。 */
export async function setSourceSecret(
  db: D1Database,
  sourceID: string | number,
  typeID: string,
  createUser: number
): Promise<void> {
  const sid = String(sourceID);
  const now = Math.floor(Date.now() / 1000);
  if (!typeID) {
    await db.prepare("DELETE FROM source_secret WHERE sourceID = ?").bind(sid).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO source_secret (sourceID, typeID, createUser, createTime, modifyTime) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sourceID) DO UPDATE SET typeID = excluded.typeID, createUser = excluded.createUser, modifyTime = excluded.modifyTime`
    )
    .bind(sid, typeID, createUser, now, now)
    .run();
}

/**
 * 001 explorerIndex::sourceSecretApply: 从 meta 中摘出 user_sourceSecret 并按条件落库。
 * 与 001 一致: 无论条件是否满足, 该 key 都必须从 meta 中移除 (不能写进 source_meta)。
 */
export async function applySourceSecret(
  db: D1Database,
  user: AuthUser,
  sourceID: string | number,
  targetType: string,
  meta: Record<string, any>
): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(meta, SOURCE_SECRET_META_KEY)) return;
  const typeID = String(meta[SOURCE_SECRET_META_KEY] ?? "");
  delete meta[SOURCE_SECRET_META_KEY];
  if (targetType !== "group") return;
  if (!(await sourceSecretAllowSet(db, user))) return;
  await setSourceSecret(db, sourceID, typeID, user.id);
}

/** 单个列表项/详情项: 注入 metaInfo.user_sourceSecret。 */
export async function applySourceSecretItem(
  db: D1Database,
  item: Record<string, any> | null | undefined
): Promise<void> {
  if (!item || item.sourceID === undefined || item.sourceID === null) return;
  // 部门节点 (sourceID 为 group id, 非路径 hash) 不参与
  if (item.sourceRoot === "groupPath") return;
  const row = await getSourceSecret(db, item.sourceID);
  if (!row || !row.typeID) return;
  item.metaInfo = { ...(item.metaInfo as Record<string, any> || {}), [SOURCE_SECRET_META_KEY]: row.typeID };
}

/** 批量列表项: 一次性读取 source_secret, 避免逐项查询。 */
export async function applySourceSecretBatch(
  db: D1Database,
  items: Array<Record<string, any> | null | undefined>
): Promise<void> {
  const candidates = items.filter(
    (i): i is Record<string, any> => !!i && i.sourceID !== undefined && i.sourceID !== null && i.sourceRoot !== "groupPath"
  );
  if (candidates.length === 0) return;
  const map = await getSourceSecretMap(db, candidates.map((i) => String(i.sourceID)));
  if (map.size === 0) return;
  for (const item of candidates) {
    const typeID = map.get(String(item.sourceID));
    if (!typeID) continue;
    item.metaInfo = { ...(item.metaInfo as Record<string, any> || {}), [SOURCE_SECRET_META_KEY]: typeID };
  }
}
