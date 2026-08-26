/**
 * 部门公共标签 (GroupTag) 存取辅助 - 对齐 001 explorer/tagGroup.
 *
 * 存储:
 *   - group_meta (key='groupTag')     保存部门标签定义 {group:[],list:[]}
 *   - group_tag_file                  保存 文件sourceID(hash) -> tagID 关联
 */
import type { AuthUser } from "./auth";
import { getGroupAuthValue, AUTH_ROOT } from "./source-auth";
import { isAdminUser } from "./source";

export interface GroupTagItem {
  id: string;
  name: string;
  style?: string;
  group?: string;
  sort?: number;
  [k: string]: any;
}
export interface GroupTagGroup {
  id: string;
  name: string;
  [k: string]: any;
}
export interface GroupTagData {
  group: GroupTagGroup[];
  list: GroupTagItem[];
  _hasDiff: boolean;
  idMax?: number;
  [k: string]: any;
}

const GROUP_TAG_KEY = "groupTag";

/** 用户是否为指定部门管理员 (root 权限或系统管理员)。 */
export async function isGroupAdmin(env: Env, user: AuthUser, groupID: number): Promise<boolean> {
  if (isAdminUser(user)) return true;
  const auth = await getGroupAuthValue(env, user, groupID);
  return (auth & AUTH_ROOT) === AUTH_ROOT;
}

/** 读取部门标签定义; 无记录或旧数据时自动补全并落库。 */
export async function getGroupTag(db: D1Database, groupID: number): Promise<GroupTagData> {
  const row = await db.prepare("SELECT value FROM group_meta WHERE groupID = ? AND key = ?")
    .bind(groupID, GROUP_TAG_KEY).first<{ value: string }>();
  const raw = row ? safeJson(row.value) : null;

  if (raw && raw._hasDiff) {
    if (!Array.isArray(raw.list)) raw.list = [];
    if (!Array.isArray(raw.group)) raw.group = [];
    return raw as GroupTagData;
  }

  const data: GroupTagData = { group: [], list: [], _hasDiff: true };
  if (raw) {
    if (Array.isArray(raw.list)) data.list = raw.list;
    if (Array.isArray(raw.group)) data.group = raw.group;
    delete data.idMax;
    // 旧数据处理: 自动补 id, 修正 tag.group 引用
    data.list = arrayAutoIDFor(data.list, "id", "number");
    data.group = arrayAutoIDFor(data.group, "id", "number");
    const groupMap: Record<string, string> = {};
    for (const g of data.group) if (g && g.id) groupMap[String(g.id)] = String(g.id);
    for (const tag of data.list) {
      if (tag && tag.group !== undefined) {
        const g = groupMap[String(tag.group)];
        tag.group = g || "1";
      }
    }
  }
  await db.prepare(
    `INSERT INTO group_meta (groupID, key, value, createTime, modifyTime) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(groupID, key) DO UPDATE SET value = excluded.value, modifyTime = excluded.modifyTime`
  ).bind(groupID, GROUP_TAG_KEY, JSON.stringify(data), Date.now(), Date.now()).run();
  return data;
}

/** 保存部门标签定义。 */
export async function setGroupTag(db: D1Database, groupID: number, data: GroupTagData): Promise<void> {
  await db.prepare(
    `INSERT INTO group_meta (groupID, key, value, createTime, modifyTime) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(groupID, key) DO UPDATE SET value = excluded.value, modifyTime = excluded.modifyTime`
  ).bind(groupID, GROUP_TAG_KEY, JSON.stringify(data), Date.now(), Date.now()).run();
}

/** 删除被移除标签对文档的关联 (001 tagSetCheck 中 removeByTag)。 */
export async function removeTagAssoc(db: D1Database, groupID: number, tagID: string): Promise<void> {
  await db.prepare("DELETE FROM group_tag_file WHERE groupID = ? AND tagID = ?").bind(groupID, tagID).run();
}

/** 添加文件(sourceID hash)到标签。 */
export async function addFileToTag(db: D1Database, groupID: number, path: string, tagID: string): Promise<void> {
  await db.prepare(
    `INSERT INTO group_tag_file (groupID, path, tagID, createTime) VALUES (?, ?, ?, ?)
     ON CONFLICT(groupID, path, tagID) DO UPDATE SET tagID = excluded.tagID`
  ).bind(groupID, path, tagID, Date.now()).run();
}

/** 将文件从标签移除。 */
export async function removeFileFromTag(db: D1Database, groupID: number, path: string, tagID: string): Promise<void> {
  await db.prepare("DELETE FROM group_tag_file WHERE groupID = ? AND path = ? AND tagID = ?")
    .bind(groupID, path, tagID).run();
}

/** sourceID(hash) -> tagID[] 映射 (对齐 001 sourceTagList)。 */
export async function sourceTagMap(db: D1Database, groupID: number): Promise<Record<string, string[]>> {
  const res = await db.prepare("SELECT path, tagID FROM group_tag_file WHERE groupID = ?")
    .bind(groupID).all<{ path: string; tagID: number }>();
  const map: Record<string, string[]> = {};
  for (const r of res.results) {
    if (!map[r.path]) map[r.path] = [];
    map[r.path].push(String(r.tagID));
  }
  return map;
}

/** 格式化标签数组: tag.group 替换为 groupInfo 对象 (对齐 001 getTags)。 */
export function getTags(tagData: GroupTagData, tagIDs: string[]): GroupTagItem[] {
  if (!tagIDs || !tagData.list || tagData.list.length === 0) return [];
  const groupMap: Record<string, GroupTagGroup> = {};
  for (const g of tagData.group || []) if (g && g.id) groupMap[String(g.id)] = g;
  const tagMap: Record<string, GroupTagItem> = {};
  for (const t of tagData.list) if (t && t.id) tagMap[String(t.id)] = t;

  const result: GroupTagItem[] = [];
  for (const tagID of tagIDs) {
    const info = tagMap[tagID];
    if (!info) continue;
    const item: GroupTagItem = { ...info };
    if (item.group !== undefined && groupMap[String(item.group)]) {
      item.groupInfo = groupMap[String(item.group)];
    }
    delete item.group;
    result.push(item);
  }
  return result;
}

function arrayAutoIDFor(arr: any[], idKey: string, type: string): any[] {
  // 轻量实现: 缺失 id 的项分配数字 id (max+1)
  let max = 1;
  for (const v of arr) if (v && v[idKey]) max = Math.max(max, parseInt(String(v[idKey]), 10) || 0);
  for (const v of arr) {
    if (v && !v[idKey]) v[idKey] = String(++max);
  }
  return arr;
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
