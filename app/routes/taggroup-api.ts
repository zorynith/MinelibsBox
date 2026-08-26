/**
 * 部门公共标签 (explorer/tagGroup) 与最近分享目标 (explorer/userShareTarget).
 *
 * 对齐 001 app/controller/explorer/tagGroup.class.php 与 userShareTarget.class.php。
 * 前端调用格式与 explorer 其他接口一致 (POST form-urlencoded, 数组为 JSON 字符串)。
 */
import { Hono } from "hono";
import { authRequired } from "../lib/auth";
import { getGroupAuthValue, AUTH_EDIT, AUTH_ROOT } from "../lib/source-auth";
import { getUserOption, setUserOption } from "../lib/db";
import {
  getGroupTag,
  setGroupTag,
  removeTagAssoc,
  addFileToTag,
  removeFileFromTag,
  isGroupAdmin,
} from "../lib/group-tag";
import type { GroupTagData } from "../lib/group-tag";
import { diffApply } from "../lib/kod-diff";

type Vars = { currentUser: import("../lib/auth").AuthUser };
const tagGroupApi = new Hono<{ Bindings: Env; Variables: Vars }>();
tagGroupApi.use("*", authRequired);

async function parseBody(c: any) {
  const form = await c.req.parseBody();
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(form)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** 部门是否存在且启用。 */
async function groupExists(c: any, groupID: number): Promise<boolean> {
  const row = await c.env.DB.prepare("SELECT id FROM groups WHERE id = ? AND status = 1").bind(groupID).first();
  return !!row;
}

function tagSetCheck(data: GroupTagData): string | null {
  if (!data || !Array.isArray(data.list)) return "参数错误";
  const idList: string[] = [];
  const nameList: string[] = [];
  for (const tag of data.list) {
    if (!tag || !tag.id) return "参数错误";
    if (idList.includes(String(tag.id))) return "参数错误";
    if (nameList.includes(String(tag.name))) return "参数错误";
    idList.push(String(tag.id));
    nameList.push(String(tag.name));
  }
  return null;
}

// ============ tagGroup ============

/** 获取部门标签定义 */
tagGroupApi.all("/tagGroup/get", authRequired, async (c) => {
  const body = await parseBody(c);
  const groupID = parseInt(body.groupID || "0", 10);
  if (!(groupID > 0) || !(await groupExists(c, groupID))) {
    return c.json({ code: false, data: "参数错误" });
  }
  const tagList = await getGroupTag(c.env.DB, groupID);
  return c.json({ code: true, data: tagList });
});

/** 保存部门标签定义 (仅部门管理员) */
tagGroupApi.all("/tagGroup/set", authRequired, async (c) => {
  const user = c.get("currentUser");
  const body = await parseBody(c);
  const groupID = parseInt(body.groupID || "0", 10);
  let diff: any = null;
  try {
    diff = body.diff ? JSON.parse(body.diff) : null;
  } catch {
    return c.json({ code: false, data: "参数错误" });
  }
  if (!(groupID > 0) || !(await groupExists(c, groupID))) {
    return c.json({ code: false, data: "参数错误" });
  }
  if (!(await isGroupAdmin(c.env, user, groupID))) {
    return c.json({ code: false, data: "无权操作" });
  }

  const dataLike = {
    group: [{ _idKey_: "id", _autoID_: "number" }],
    list: [{ _idKey_: "id", _autoID_: "number" }],
  };
  const listData = await getGroupTag(c.env.DB, groupID);
  const value = diffApply(listData, diff, dataLike) as GroupTagData;

  // 新建分组时处理: 标签的 _groupAddTemp 指向临时分组
  if (Array.isArray(value.list)) {
    for (const item of value.list) {
      if (item && item._groupAddTemp) {
        const group = (value.group || []).find((g) => g && g._groupAddTemp === item._groupAddTemp);
        if (group && group.id) item.group = group.id;
      }
      if (item) delete item._groupAddTemp;
    }
  }
  if (Array.isArray(value.group)) {
    for (const item of value.group) if (item) delete item._groupAddTemp;
  }

  const checkErr = tagSetCheck(value);
  if (checkErr) return c.json({ code: false, data: checkErr });

  // 标签被删除: 解除对应文档关联 (001 tagSetCheck)
  const beforeList = await getGroupTag(c.env.DB, groupID);
  const keepIds = new Set((value.list || []).map((t) => String(t.id)));
  for (const tag of beforeList.list || []) {
    if (!keepIds.has(String(tag.id))) {
      await removeTagAssoc(c.env.DB, groupID, String(tag.id));
    }
  }

  await setGroupTag(c.env.DB, groupID, value);
  const result = await getGroupTag(c.env.DB, groupID);
  return c.json({ code: true, data: result });
});

/** 添加文档到标签 (对齐 filesAddToTag; files 为逗号分隔 sourceID) */
tagGroupApi.all("/tagGroup/filesAddToTag", authRequired, async (c) => {
  const user = c.get("currentUser");
  const body = await parseBody(c);
  const groupID = parseInt(body.groupID || "0", 10);
  const tagID = String(body.tagID || "").trim();
  const files = String(body.files || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!(groupID > 0) || !tagID || files.length === 0 || !(await groupExists(c, groupID))) {
    return c.json({ code: false, data: "参数错误" });
  }
  if (!(await fileEditAllow(c, user, groupID))) {
    return c.json({ code: false, data: "无权操作" });
  }
  for (const file of files) {
    await addFileToTag(c.env.DB, groupID, file, tagID);
  }
  return c.json({ code: true, data: "success" });
});

/** 将文档从标签移除 */
tagGroupApi.all("/tagGroup/filesRemoveFromTag", authRequired, async (c) => {
  const user = c.get("currentUser");
  const body = await parseBody(c);
  const groupID = parseInt(body.groupID || "0", 10);
  const tagID = String(body.tagID || "").trim();
  const files = String(body.files || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!(groupID > 0) || !tagID || files.length === 0 || !(await groupExists(c, groupID))) {
    return c.json({ code: false, data: "参数错误" });
  }
  if (!(await fileEditAllow(c, user, groupID))) {
    return c.json({ code: false, data: "无权操作" });
  }
  for (const file of files) {
    await removeFileFromTag(c.env.DB, groupID, file, tagID);
  }
  return c.json({ code: true, data: "success" });
});

/** 文档标签编辑权限: 部门内具有编辑/管理权限即可 (对齐 001 checkAuth 的 fileCanWrite 近似)。 */
async function fileEditAllow(c: any, user: any, groupID: number): Promise<boolean> {
  const auth = await getGroupAuthValue(c.env, user, groupID);
  return (auth & (AUTH_EDIT | AUTH_ROOT)) !== 0;
}

// ============ userShareTarget ============

const SHARE_TARGET_TYPE = "shareTarget";

/** 读取已保存的分享目标 (UserOption type=shareTarget key=saveData)。 */
async function shareSaveData(c: any): Promise<Record<string, any>> {
  const user = c.get("currentUser");
  const raw = await getUserOption(c.env.DB, user.id, "saveData", SHARE_TARGET_TYPE);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 获取最近分享目标 (对齐 001 userShareTarget/get; worker 无 share_to 统计, 返回保存目标)。 */
tagGroupApi.all("/userShareTarget/get", authRequired, async (c) => {
  const saveData = await shareSaveData(c);
  const result: any[] = [];
  for (const key of Object.keys(saveData)) {
    const value = saveData[key];
    value.nodeAddClass = "node-share-item-store";
    value.icon = '<i class="font-icon ri-team-fill"></i>';
    result.push(value);
  }
  return c.json({ code: true, data: result });
});

/** 保存最近分享目标 (name/authTo; authTo 为空则删除)。 */
tagGroupApi.all("/userShareTarget/save", authRequired, async (c) => {
  const user = c.get("currentUser");
  const body = await parseBody(c);
  const name = String(body.name || "").trim();
  if (!name) return c.json({ code: false, data: "参数错误" });
  const authTo = String(body.authTo || "").trim();
  const beforeName = String(body.beforeName || "").trim();

  const saveData = await shareSaveData(c);
  if (beforeName) delete saveData[beforeName];
  const data = { name, authTo, modifyTime: Math.floor(Date.now() / 1000) };
  if (!authTo) {
    delete saveData[name];
  } else {
    saveData[name] = data;
  }

  await setUserOption(c.env.DB, user.id, "saveData", JSON.stringify(saveData), SHARE_TARGET_TYPE);

  const result: any[] = [];
  for (const key of Object.keys(saveData)) {
    const value = saveData[key];
    value.nodeAddClass = "node-share-item-store";
    value.icon = '<i class="font-icon ri-team-fill"></i>';
    result.push(value);
  }
  return c.json({ code: true, data: result });
});

export { tagGroupApi };
