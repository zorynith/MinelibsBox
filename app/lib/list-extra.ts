/**
 * 列表项附加字段注入 (001 explorer/list::parseData 的对应实现):
 *
 * - `applyShareInfoBatch`  复刻 `explorer/userShare::shareAppendItem`
 *   → 给每个列表项补 `sourceInfo.shareInfo` (外链/协作角标、分享列、取消分享等前端逻辑依赖)。
 * - `applyHistoryCountBatch` 复刻 `explorer/list::addHistoryCount` / `fileInfoAddHistory`
 *   → 给文件项补 `historyCount` (历史版本角标、属性面板页签、右键菜单依赖)。
 */
import { shareOptions } from "./share";

/** 001 userShare::shareAppendItem — 我的分享按 sourcePath 建索引后逐项匹配。 */
export async function applyShareInfoBatch(
  db: D1Database,
  userID: number,
  items: Array<Record<string, any> | null | undefined>
): Promise<void> {
  const targets = items.filter((i): i is Record<string, any> => !!i);
  if (targets.length === 0) return;

  const rows = (await db
    .prepare("SELECT * FROM share WHERE userID = ? AND (isLink = 1 OR isShareTo = 1)")
    .bind(userID)
    .all()
    .catch(() => ({ results: [] }))) as unknown as { results: Record<string, any>[] };
  if (!rows.results || rows.results.length === 0) return;

  const index = new Map<string, Record<string, any>>();
  // 001 个人空间的分享 sourcePath 不带 {source:home} 前缀, 需单独按相对路径建索引
  const homeIndex = new Map<string, Record<string, any>>();
  for (const row of rows.results) {
    const sourcePath = String(row.sourcePath || "");
    if (!sourcePath) continue;
    // 001 shareFilterShow: 下发前剔除密码等敏感字段
    const info: Record<string, any> = { ...row, options: shareOptions(row as any) };
    delete info.password;
    const bare = sourcePath.replace(/\/+$/, "");
    index.set(sourcePath, info);
    index.set(bare, info);
    index.set(bare + "/", info);
    if (!sourcePath.startsWith("{")) {
      homeIndex.set(bare, info);
      homeIndex.set(bare + "/", info);
    }
  }
  if (index.size === 0) return;

  for (const item of targets) {
    const sourceInfo = (item.sourceInfo as Record<string, any>) || {};
    if (sourceInfo.shareInfo) continue; // 001: 已存在时不覆盖 (分享列表根项自带 shareInfo)
    const path = String(item.path || "");
    if (!path) continue;
    const bare = path.replace(/\/+$/, "");
    let hit = index.get(path) || index.get(bare) || index.get(bare + "/");
    if (!hit && path.startsWith("{source:home}")) {
      const rel = path.replace(/^\{source:home\}/, "");
      const relBare = rel.replace(/\/+$/, "");
      hit = homeIndex.get(rel) || homeIndex.get(relBare) || homeIndex.get(relBare + "/");
    }
    if (!hit) continue;
    item.sourceInfo = { ...sourceInfo, shareInfo: hit };
  }
}

/** 001 list::addHistoryCount — 按路径统计历史版本数, 默认 0。 */
export async function applyHistoryCountBatch(
  db: D1Database,
  items: Array<Record<string, any> | null | undefined>
): Promise<void> {
  const files = items.filter(
    (i): i is Record<string, any> => !!i && i.type === "file" && typeof i.path === "string" && i.path !== ""
  );
  if (files.length === 0) return;

  // 001: 分享态路径 ({shareLink}/{shareItem}) 不统计
  const counted = files.filter((i) => !/^\{(shareLink|shareItem):/.test(String(i.path)));
  const paths = [...new Set(counted.map((i) => String(i.path)))];
  const countMap = new Map<string, number>();
  const CHUNK = 100;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    try {
      const rows = (await db
        .prepare(`SELECT path, COUNT(*) AS c FROM source_history WHERE path IN (${placeholders}) GROUP BY path`)
        .bind(...chunk)
        .all()) as unknown as { results: { path: string; c: number }[] };
      for (const r of rows.results) countMap.set(String(r.path), Number(r.c) || 0);
    } catch {
      /* 统计失败不影响列表 */
    }
  }

  // 001: 每个文件项都显式写入 historyCount (无历史为 0)
  for (const item of files) {
    item.historyCount = countMap.get(String(item.path)) || 0;
  }
}
