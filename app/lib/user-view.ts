/**
 * 复刻 001 user/view 与 explorer/list::pathInfoCover 的封面 URL 自适应逻辑。
 *
 * - parseUserViewUrl  对应 001 user.view::parseUrl: 把封面等资源 URL 重写到当前站点 host;
 * - applyPathInfoCover 对应 001 explorer.list::pathInfoCover: 有 user_sourceCover 时输出
 *   fileThumbCover=1 与 fileThumb(parseUrl 后的绝对地址), 供前端列表图标显示自定义封面。
 */
import { getSetting, getSourceMetaValue } from "./db";
import { mcryptDecode } from "./mcrypt";

/** 001 user.view::parseUrl — 自适应重写资源 URL 的 host。 */
export async function parseUserViewUrl(db: D1Database, link: string, appHost: string): Promise<string> {
  if (!link || !link.trim()) return "";
  // 以 / 开头的绝对路径 -> 当前 HOST
  if (link.charAt(0) === "/") return appHost + link.slice(1);
  if (link.startsWith("./")) return appHost + link.slice(2);
  if (link.startsWith(appHost)) return link;

  // 域名切换情况处理 (用户头像/封面等 url 缓存情况处理)
  if (link.includes("explorer/share/file&hash")) {
    let u: URL;
    let base: URL;
    try {
      u = new URL(link);
      base = new URL(appHost);
    } catch {
      return link;
    }
    // 站点 path 不同则不再继续自适应
    if ((base.pathname || "/") !== (u.pathname || "/")) return link;
    const hash = u.searchParams.get("hash");
    if (!hash) return link;
    const systemPassword = (await getSetting(db, "systemPassword")) || "";
    const pathTrue = await mcryptDecode(hash, systemPassword);
    if (!pathTrue) return link;
    const linkPort = u.port && u.port !== "80" ? ":" + u.port : "";
    const linkHost = u.protocol + "//" + u.hostname + linkPort + "/";
    return link.replace(linkHost, appHost);
  }
  return link;
}

/** 单个列表项: 有 user_sourceCover 时补 fileThumbCover/fileThumb。 */
export async function applyPathInfoCover(
  db: D1Database,
  item: Record<string, any> | null | undefined,
  appHost: string
): Promise<void> {
  if (!item || item.fileThumb) return;
  let cover = "";
  if (item.metaInfo && typeof item.metaInfo === "object") {
    cover = String(item.metaInfo.user_sourceCover || "");
  }
  if (!cover && item.sourceID !== undefined && item.sourceID !== null) {
    cover = (await getSourceMetaValue(db, item.sourceID, "user_sourceCover")) || "";
  }
  if (!cover) return;
  item.fileThumbCover = "1";
  item.fileThumb = await parseUserViewUrl(db, cover, appHost);
}

/** 批量列表项: 一次性读取 user_sourceCover, 避免逐项查询。 */
export async function applyPathInfoCoverBatch(
  db: D1Database,
  items: Array<Record<string, any> | null | undefined>,
  appHost: string
): Promise<void> {
  const candidates = items.filter((i): i is Record<string, any> => !!i && !i.fileThumb && i.sourceID !== undefined && i.sourceID !== null);
  if (candidates.length === 0) return;

  const idMap = new Map<string, Record<string, any>[]>();
  for (const item of candidates) {
    const key = String(item.sourceID);
    const arr = idMap.get(key);
    if (arr) arr.push(item);
    else idMap.set(key, [item]);
  }
  const ids = [...idMap.keys()];
  const coverMap = new Map<string, string>();
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    try {
      const rows = (await db
        .prepare(`SELECT sourceID, value FROM source_meta WHERE key = 'user_sourceCover' AND sourceID IN (${placeholders})`)
        .bind(...chunk)
        .all()) as unknown as { results: { sourceID: string; value: string }[] };
      for (const r of rows.results) {
        if (r.value) coverMap.set(String(r.sourceID), r.value);
      }
    } catch {
      /* 忽略查询失败, 封面缺失不影响列表 */
    }
  }

  for (const [key, arr] of idMap) {
    const cover = coverMap.get(key);
    if (!cover) continue;
    const thumb = await parseUserViewUrl(db, cover, appHost);
    for (const item of arr) {
      item.fileThumbCover = "1";
      item.fileThumb = thumb;
    }
  }
}
