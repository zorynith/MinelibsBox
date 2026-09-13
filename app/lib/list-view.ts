/**
 * 文件夹列表视图偏好 (复刻 001 explorer/listView.class.php)
 *
 * 存储: user_option(type='folderInfo'), key = listType | listSort, value = JSON 对象
 *   { "<storePath>": "<value>", ... }  最近 200 条, 越靠后越新
 * listType 值: list | icon:SIZE | split
 * listSort 值: name:up / type:down / size:up / modifyTime:up
 *
 * 优先级: 指定自己 > 指定最近上级 > 默认 (读取时沿路径父链由深到浅查找)
 */
import { getUserOption, setUserOption, deleteUserOption } from "./db";

const MAX_RECORD = 200;
const LIST_TYPE = "listType";
const LIST_SORT = "listSort";
const LIST_TYPE_KEEP = "listTypeKeep";
const LIST_SORT_KEEP = "listSortKeep";
const OPTION_TYPE = "folderInfo";

/** 规范化存储路径: 去尾部斜杠后补一个斜杠。 */
export function normalizeListViewPath(path: string): string {
  return (path || "/").replace(/\/+$/, "") + "/";
}

/** 由具体到上级的路径链: ["/a/b/", "/a/", "/"]。 */
export function listViewPathChain(path: string): string[] {
  const body = normalizeListViewPath(path).replace(/\/+$/, "");
  const parts = body.split("/");
  const chain: string[] = [];
  for (let i = parts.length; i > 0; i--) {
    chain.push(parts.slice(0, i).join("/") + "/");
  }
  return chain;
}

async function readMap(db: D1Database, userId: number, key: string): Promise<Record<string, string>> {
  const raw = await getUserOption(db, userId, key, OPTION_TYPE);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, string>;
  } catch {
    /* ignore corrupt value */
  }
  return {};
}

/** 清空列表视图偏好 (001 dataSave clearListView=1)。 */
export async function listViewClear(db: D1Database, userId: number): Promise<void> {
  await deleteUserOption(db, userId, LIST_TYPE, OPTION_TYPE);
  await deleteUserOption(db, userId, LIST_SORT, OPTION_TYPE);
}

/**
 * 保存列表视图偏好 (001 dataSave)。
 * 兼容 setConfig 传入 { key, value, path } 或 { listViewKey, listViewValue, listViewPath }。
 */
export async function listViewSave(
  db: D1Database,
  userId: number,
  p: { key?: string; value?: string; path?: string; clearListView?: string; listViewKey?: string; listViewValue?: string; listViewPath?: string }
): Promise<boolean> {
  if (String(p.clearListView ?? "") === "1") {
    await listViewClear(db, userId);
    return true;
  }
  const key = String(p.listViewKey ?? p.key ?? "");
  const value = String(p.listViewValue ?? p.value ?? "");
  const path = String(p.listViewPath ?? p.path ?? "");
  if (key !== LIST_TYPE && key !== LIST_SORT) return false;
  if (!path) return false;

  const allow = key === LIST_TYPE
    ? (await getUserOption(db, userId, LIST_TYPE_KEEP)) !== "0"
    : (await getUserOption(db, userId, LIST_SORT_KEEP)) !== "0";
  if (!allow) return true;

  const storePath = normalizeListViewPath(path);
  const map = await readMap(db, userId, key);
  delete map[storePath];
  const keys = Object.keys(map);
  if (keys.length >= MAX_RECORD) {
    const drop = keys.slice(0, keys.length - MAX_RECORD + 1);
    for (const d of drop) delete map[d];
  }
  map[storePath] = value;
  await setUserOption(db, userId, key, JSON.stringify(map), OPTION_TYPE);
  return true;
}

/**
 * 计算给定路径应生效的列表视图字段 (001 listDataSet)。
 * 返回 listType/listIconSize/listSortField/listSortOrder 的子集。
 */
export async function listViewApply(db: D1Database, userId: number, path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const listTypeAllow = (await getUserOption(db, userId, LIST_TYPE_KEEP)) !== "0";
  const listSortAllow = (await getUserOption(db, userId, LIST_SORT_KEEP)) !== "0";
  if (!listTypeAllow && !listSortAllow) return out;

  const chain = listViewPathChain(path);

  if (listTypeAllow) {
    const typeMap = await readMap(db, userId, LIST_TYPE);
    let found = "";
    for (const p of chain) {
      if (typeMap[p]) {
        found = typeMap[p];
        break;
      }
    }
    const info = found.split(":");
    if (info[0]) out.listType = info[0];
    if (info.length === 2 && info[0] === "icon" && info[1]) out.listIconSize = info[1];
  }

  if (listSortAllow) {
    const sortMap = await readMap(db, userId, LIST_SORT);
    let found = "";
    for (const p of chain) {
      if (sortMap[p]) {
        found = sortMap[p];
        break;
      }
    }
    const info = found.split(":");
    if (info.length === 2) {
      out.listSortField = info[0];
      out.listSortOrder = info[1];
    }
  }

  return out;
}
