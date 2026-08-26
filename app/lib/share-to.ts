/**
 * share_to 关联表辅助 - 对齐 001 share_to (内部协作分享目标)。
 *
 * targetType: 1=user 2=group (对齐 001 SourceModel::TYPE_USER/TYPE_GROUP)。
 * authTo 参数格式: [{"targetType":"1","targetID":"23","authID":"1"},...]
 */
import type { ShareRow } from "./share";

export const SHARE_TO_USER = 1;
export const SHARE_TO_GROUP = 2;

export interface ShareToRow {
  id: number;
  shareID: number;
  targetType: number;
  targetID: number;
  authID: number;
  authDefine: number;
  createTime: number;
  modifyTime: number;
}

export interface AuthToItem {
  targetType: string;
  targetID: string;
  authID?: string;
  [k: string]: any;
}

/** 解析前端 authTo 参数（JSON 字符串或数组）。 */
export function parseAuthTo(raw: any): AuthToItem[] {
  if (Array.isArray(raw)) return raw.filter((i) => i && i.targetType !== undefined && i.targetID !== undefined);
  if (typeof raw !== "string" || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((i) => i && i.targetType !== undefined && i.targetID !== undefined);
  } catch {
    return [];
  }
}

function rowToShareTo(r: Record<string, unknown>): ShareToRow {
  return {
    id: Number(r.id),
    shareID: Number(r.shareID),
    targetType: Number(r.targetType),
    targetID: Number(r.targetID),
    authID: Number(r.authID || 0),
    authDefine: Number(r.authDefine || 0),
    createTime: Number(r.createTime || 0),
    modifyTime: Number(r.modifyTime || 0),
  };
}

/** 查询分享的协作目标列表。 */
export async function getShareToList(db: D1Database, shareID: number): Promise<ShareToRow[]> {
  const res = await db.prepare("SELECT * FROM share_to WHERE shareID = ?").bind(shareID).all<Record<string, unknown>>();
  return (res.results || []).map(rowToShareTo);
}

/** 覆盖写 share_to 目标（先删后插）。 */
export async function replaceShareTo(db: D1Database, shareID: number, authTo: AuthToItem[]): Promise<void> {
  await db.prepare("DELETE FROM share_to WHERE shareID = ?").bind(shareID).run();
  const now = Date.now();
  for (const item of authTo) {
    await db
      .prepare(
        `INSERT INTO share_to (shareID, targetType, targetID, authID, authDefine, createTime, modifyTime)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .bind(shareID, parseInt(String(item.targetType), 10) || 0, parseInt(String(item.targetID), 10) || 0, parseInt(String(item.authID || "0"), 10) || 0, now, now)
      .run();
  }
}

/** 按 shareID 集合删除目标（配合取消分享）。 */
export async function removeShareToByShareIds(db: D1Database, shareIDs: number[]): Promise<void> {
  if (shareIDs.length === 0) return;
  const placeholders = shareIDs.map(() => "?").join(",");
  await db.prepare(`DELETE FROM share_to WHERE shareID IN (${placeholders})`).bind(...shareIDs).run();
}

/** 分享给我的列表: 目标含当前用户或其所在部门。 */
export async function listShareToMe(db: D1Database, userId: number, groupIDs: number[]): Promise<ShareRow[]> {
  const binds: unknown[] = [SHARE_TO_USER, userId];
  let sql = `
    SELECT s.* FROM share s
    JOIN share_to st ON st.shareID = s.shareID
    WHERE s.isShareTo = 1 AND st.targetType = ? AND st.targetID = ?`;
  if (groupIDs.length > 0) {
    const placeholders = groupIDs.map(() => "?").join(",");
    sql += ` UNION
      SELECT s.* FROM share s
      JOIN share_to st ON st.shareID = s.shareID
      WHERE s.isShareTo = 1 AND st.targetType = ${SHARE_TO_GROUP} AND st.targetID IN (${placeholders})`;
    binds.push(...groupIDs);
  }
  sql += " ORDER BY modifyTime DESC";
  const res = await db.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  const seen = new Set<number>();
  const rows: ShareRow[] = [];
  for (const r of res.results || []) {
    const id = Number(r.shareID);
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      shareID: id,
      title: String(r.title || ""),
      shareHash: String(r.shareHash || ""),
      userID: Number(r.userID),
      sourceID: String(r.sourceID || "0"),
      sourcePath: String(r.sourcePath || ""),
      url: String(r.url || ""),
      isLink: Number(r.isLink) || 0,
      isShareTo: Number(r.isShareTo) || 0,
      password: String(r.password || ""),
      timeTo: Number(r.timeTo) || 0,
      numView: Number(r.numView) || 0,
      numDownload: Number(r.numDownload) || 0,
      options: String(r.options || "{}"),
      createTime: String(r.createTime || ""),
      modifyTime: String(r.modifyTime || ""),
    });
  }
  return rows;
}
