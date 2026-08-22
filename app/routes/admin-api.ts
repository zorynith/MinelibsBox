/**
 * Admin API - 用户管理 (admin/group, admin/member, admin/role, admin/job, admin/auth)
 * Mirrors 001 adminGroup/adminMember/adminRole/adminJob/adminAuth controllers.
 */
import { Hono } from "hono";
import { authRequired, hashPassword, isAdmin } from "../lib/auth";
import { getUserByUsername, userSearch, setSetting, addAuditLog } from "../lib/db";
import { parseKodPassword } from "../lib/mcrypt";
import { t } from "../lib/i18n";
import { userDefaultInit } from "../lib/user-init";
import { deleteDirectory } from "../lib/r2";

type Vars = { currentUser: import("../lib/auth").AuthUser };
const adminApi = new Hono<{ Bindings: Env; Variables: Vars }>();

adminApi.use("*", authRequired);

// Mirrors 001 show_json($data, $code, $info): data 为已翻译提示文案, info 为附加数据。
// 001 后端在 PHP 端用 LNG() 翻译后返回文案, SPA 直接展示 data(字符串不二次翻译),
// 因此这里把 i18n key 翻译成文案; 对象/数组 data 原样返回(列表等负载)。
function ok(data: any, info?: any) {
  const res: any = { code: true, data: typeof data === "string" ? t(data) : data };
  if (info !== undefined) res.info = info;
  return res;
}

function fail(data: any) {
  return { code: false, data: typeof data === "string" ? t(data) : data };
}

async function parseBody(c: any): Promise<Record<string, string>> {
  const body: Record<string, string> = {};
  const rawBody = await c.req.parseBody().catch(() => ({}));
  for (const [k, v] of Object.entries(rawBody)) {
    body[k] = typeof v === "string" ? v : "";
  }
  return body;
}

async function allParams(c: any): Promise<Record<string, string>> {
  return { ...c.req.query(), ...(await parseBody(c)) };
}

// ============ admin/group ============

/**
 * 部门列表 - admin/group/get
 * 参数: parentID, requestFromType
 * root 用户 parentID 为空/'root' 时返回根部门; 否则返回其子部门。
 * 返回 {list, pageInfo}, list 项含 groupID/parentID/name/hasChildren/sizeMax/sizeUse/status 等。
 */
adminApi.all("/group/get", async (c) => {
  const user = c.get("currentUser");
  const query = await allParams(c);
  const parentID = (query.parentID || "").trim();
  const isRoot = user.role === "admin" || user.role === "root";

  // root 用户请求根部门时返回部门 id=1
  let groups: any[] = [];
  if (!parentID || parentID === "root" || parentID === "rootOuter") {
    if (!isRoot) {
      return c.json(ok({ list: [], pageInfo: {} }));
    }
    const row = await c.env.DB.prepare("SELECT * FROM groups WHERE id = 1").first();
    if (row) groups = [row];
  } else if (/^\d+$/.test(parentID)) {
    const pid = parseInt(parentID, 10);
    const result = await c.env.DB.prepare(
      "SELECT * FROM groups WHERE parent_id = ? ORDER BY sort ASC, id ASC"
    ).bind(pid).all();
    groups = result.results as any[];
    // If a leaf group has no children but is requested, return the group itself
    // (mirrors 001 listChild which can return empty list)
  } else {
    // Treat as root request
    const row = await c.env.DB.prepare("SELECT * FROM groups WHERE id = 1").first();
    if (row) groups = [row];
  }

  const list: any[] = [];
  for (const g of groups) {
    const childCount = await c.env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM groups WHERE parent_id = ?"
    ).bind(g.id as number).first<{ cnt: number }>();
    const metaInfo = await c.env.DB.prepare(
      "SELECT status FROM groups WHERE id = ?"
    ).bind(g.id as number).first<{ status: number }>();
    list.push({
      groupID: g.id,
      parentID: g.parent_id,
      parentLevel: g.parent_level || ",",
      name: g.name,
      sizeMax: g.size_max || 0,
      sizeUse: g.size_use || 0,
      sort: g.sort || 0,
      status: g.status ?? 1,
      hasChildren: (childCount?.cnt || 0) > 0,
      isParent: (childCount?.cnt || 0) > 0,
      metaInfo: {
        status: String(metaInfo?.status ?? g.status ?? 1),
        ioDriver: g.io_driver ?? 0,
        authShowType: g.auth_show_type || "all",
        authShowGroup: g.auth_show_group || "",
      },
      nodeData: { groupID: g.id, parentID: g.parent_id, name: g.name },
    });
  }
  return c.json(ok({ list, pageInfo: {} }));
});

/**
 * 部门信息 - admin/group/getByID
 */
adminApi.all("/group/getByID", async (c) => {
  const query = await allParams(c);
  const id = (query.id || "").trim();
  const ids = id.split(",").filter((x) => /^\d+$/.test(x)).map(Number);
  if (ids.length === 0) return c.json(ok([]));
  const placeholders = ids.map(() => "?").join(",");
  const result = await c.env.DB.prepare(
    `SELECT * FROM groups WHERE id IN (${placeholders}) ORDER BY sort ASC, id ASC`
  ).bind(...ids).all();
  const list = (result.results as any[]).map((g) => ({
    groupID: g.id,
    parentID: g.parent_id,
    parentLevel: g.parent_level || ",",
    name: g.name,
    sizeMax: g.size_max || 0,
    sizeUse: g.size_use || 0,
    sort: g.sort || 0,
    status: g.status ?? 1,
    metaInfo: {
      status: String(g.status ?? 1),
      ioDriver: g.io_driver ?? 0,
      authShowType: g.auth_show_type || "all",
      authShowGroup: g.auth_show_group || "",
    },
  }));
  return c.json(ok(list));
});

/**
 * 搜索部门 - admin/group/search
 * 参数: words, parentGroup(可选)
 */
adminApi.all("/group/search", async (c) => {
  const query = await allParams(c);
  const words = (query.words || "").trim();
  if (!words) return c.json(ok({ list: [], pageInfo: {} }));
  const like = `%${words}%`;
  const result = await c.env.DB.prepare(
    "SELECT * FROM groups WHERE name LIKE ? ORDER BY sort ASC, id ASC LIMIT 100"
  ).bind(like).all();
  const list = (result.results as any[]).map((g) => ({
    groupID: g.id,
    parentID: g.parent_id,
    parentLevel: g.parent_level || ",",
    name: g.name,
    sizeMax: g.size_max || 0,
    sizeUse: g.size_use || 0,
    sort: g.sort || 0,
    status: g.status ?? 1,
  }));
  return c.json(ok({ list, pageInfo: { page: 1, pageNum: 100, total: list.length } }));
});

/**
 * 添加部门 - admin/group/add
 * 参数: name(必填), parentID(默认0), sizeMax(默认0), sort(默认0)
 * 001: groupAdd 后计算 parent_level（含自身的祖先路径，如 ",1,2,"）
 */
adminApi.all("/group/add", async (c) => {
  const query = await allParams(c);
  const name = (query.name || "").trim().replace(/\//g, "");
  if (!name) return c.json({ code: false, data: "名称不能为空" });
  const parentID = parseInt(query.parentID || "0", 10) || 0;
  const sizeMax = parseFloat(query.sizeMax || "0") || 0;
  const sort = parseInt(query.sort || "0", 10) || 0;
  const ioDriver = parseInt(query.ioDriver || "0", 10) || 0;
  const authShowType = (query.authShowType || "all").trim() || "all";
  const authShowGroup = (query.authShowGroup || "").trim();

  let parentLevel = ",";
  if (parentID > 0) {
    const parent = await c.env.DB.prepare(
      "SELECT parent_level FROM groups WHERE id = ?"
    ).bind(parentID).first<{ parent_level: string }>();
    parentLevel = parent?.parent_level || ",";
  }

  const result = await c.env.DB.prepare(
    "INSERT INTO groups (name, parent_id, size_max, size_use, status, sort, parent_level, io_driver, auth_show_type, auth_show_group) VALUES (?, ?, ?, 0, 1, ?, '', ?, ?, ?)"
  ).bind(name, parentID, sizeMax, sort, ioDriver, authShowType, authShowGroup).run();
  const meta = result.meta as any;
  const groupID = meta?.last_row_id ?? 0;
  if (!groupID) return c.json({ code: false, data: "添加失败" });

  const fullLevel = parentLevel + groupID + ",";
  await c.env.DB.prepare("UPDATE groups SET parent_level = ? WHERE id = ?").bind(fullLevel, groupID).run();

  // 001 group.class.php folderDefault: 新建部门默认创建共享目录
  const groupDefaultFolders = ["共享资源", "文档", "其他"];
  for (const dir of groupDefaultFolders) {
    await c.env.FILES.put(`__group__/${groupID}/${dir}/.keep`, "").catch(() => {});
  }

  return c.json(ok("explorer.success", groupID));
});

/**
 * 编辑部门 - admin/group/edit
 * 参数: groupID(必填), name/sizeMax/sort/parentID(可选)
 */
adminApi.all("/group/edit", async (c) => {
  const query = await allParams(c);
  const groupID = parseInt(query.groupID || "0", 10);
  if (!groupID) return c.json({ code: false, data: "参数错误" });

  const updates: string[] = [];
  const args: any[] = [];
  if (query.name !== undefined && query.name !== null) {
    updates.push("name = ?");
    args.push((query.name || "").trim().replace(/\//g, ""));
  }
  if (query.sizeMax !== undefined && query.sizeMax !== null && query.sizeMax !== "") {
    updates.push("size_max = ?");
    args.push(parseFloat(query.sizeMax) || 0);
  }
  if (query.sort !== undefined && query.sort !== null && query.sort !== "") {
    updates.push("sort = ?");
    args.push(parseInt(query.sort, 10) || 0);
  }
  if (query.parentID !== undefined && query.parentID !== null && query.parentID !== "") {
    const newParent = parseInt(query.parentID, 10) || 0;
    let parentLevel = ",";
    if (newParent > 0 && newParent !== groupID) {
      const parent = await c.env.DB.prepare(
        "SELECT parent_level FROM groups WHERE id = ?"
      ).bind(newParent).first<{ parent_level: string }>();
      parentLevel = parent?.parent_level || ",";
    }
    updates.push("parent_id = ?");
    args.push(newParent);
    updates.push("parent_level = ?");
    args.push(parentLevel + groupID + ",");
  }
  if (query.ioDriver !== undefined && query.ioDriver !== null && query.ioDriver !== "") {
    updates.push("io_driver = ?");
    args.push(parseInt(query.ioDriver, 10) || 0);
  }
  if (query.authShowType !== undefined && query.authShowType !== null && query.authShowType !== "") {
    updates.push("auth_show_type = ?");
    args.push((query.authShowType || "").trim() || "all");
  }
  if (query.authShowGroup !== undefined && query.authShowGroup !== null) {
    updates.push("auth_show_group = ?");
    args.push((query.authShowGroup || "").trim());
  }
  if (!updates.length) return c.json(ok("explorer.success", groupID));
  await c.env.DB.prepare(`UPDATE groups SET ${updates.join(", ")} WHERE id = ?`).bind(...args, groupID).run();
  return c.json(ok("explorer.success", groupID));
});

/**
 * 禁/启用部门 - admin/group/status
 * 参数: groupID, status(0|1)
 */
adminApi.all("/group/status", async (c) => {
  const query = await allParams(c);
  const groupID = parseInt(query.groupID || "0", 10);
  if (!groupID) return c.json({ code: false, data: "参数错误" });
  const status = query.status === "1" ? 1 : 0;
  await c.env.DB.prepare("UPDATE groups SET status = ? WHERE id = ?").bind(status, groupID).run();
  return c.json(ok("explorer.success"));
});

/**
 * 删除部门 - admin/group/remove
 * 参数: groupID(逗号分隔), delAll(1=级联删除子部门)
 */
adminApi.all("/group/remove", async (c) => {
  const query = await allParams(c);
  const ids = (query.groupID || "").split(",").filter((x) => /^\d+$/.test(x)).map(Number);
  if (ids.length === 0) return c.json({ code: false, data: "参数错误" });

  let allIds = ids.slice();
  if (query.delAll === "1") {
    const queue = [...ids];
    while (queue.length) {
      const pid = queue.pop()!;
      const children = await c.env.DB.prepare("SELECT id FROM groups WHERE parent_id = ?").bind(pid).all();
      for (const ch of children.results as any[]) {
        allIds.push(ch.id);
        queue.push(ch.id);
      }
    }
  }
  allIds = [...new Set(allIds)].filter((id) => id !== 1);
  if (allIds.length === 0) return c.json({ code: false, data: "不能删除根部门" });

  const placeholders = allIds.map(() => "?").join(",");
  await c.env.DB.prepare(`DELETE FROM user_groups WHERE group_id IN (${placeholders})`).bind(...allIds).run();
  await c.env.DB.prepare(`DELETE FROM groups WHERE id IN (${placeholders})`).bind(...allIds).run();
  for (const id of allIds) {
    await deleteDirectory(c.env.FILES, `__group__/${id}/`).catch(() => {});
  }
  return c.json(ok("explorer.success"));
});

/**
 * 排序部门 - admin/group/sort
 * 参数: groupID(逗号分隔的 id 列表，按顺序设置 sort)
 */
adminApi.all("/group/sort", async (c) => {
  const query = await allParams(c);
  const ids = (query.groupID || "").split(",").filter((x) => /^\d+$/.test(x)).map(Number);
  for (let i = 0; i < ids.length; i++) {
    await c.env.DB.prepare("UPDATE groups SET sort = ? WHERE id = ?").bind(i, ids[i]).run();
  }
  return c.json(ok("explorer.success"));
});

/**
 * 部门迁移 - admin/group/switchGroup
 * 参数: from, to
 * 将 from 部门的成员迁移到 to 部门
 */
adminApi.all("/group/switchGroup", async (c) => {
  const query = await allParams(c);
  const from = parseInt(query.from || "0", 10);
  const to = parseInt(query.to || "0", 10);
  if (!from || !to) return c.json({ code: false, data: "参数错误" });
  await c.env.DB.prepare("UPDATE user_groups SET group_id = ? WHERE group_id = ?").bind(to, from).run();
  return c.json(ok("explorer.success"));
});

// ============ admin/storage ============

/**
 * 存储列表 - admin/storage/get
 * 本系统仅 R2 单存储，返回空数组（前端渲染空存储列表）
 */
adminApi.all("/storage/get", async (c) => {
  return c.json(ok([]));
});

// ============ admin/member ============

/**
 * 用户列表 - admin/member/get
 * 参数: groupID(1=全部), fields, status, requestFromType
 * 返回 {list, pageInfo}; list 项含 userID/name/nickName/avatar/roleID/sizeUse/sizeMax/groupInfo/status
 */
adminApi.all("/member/get", async (c) => {
  const query = await allParams(c);
  const groupID = (query.groupID || "").trim();
  const statusFilter = query.status !== undefined && query.status !== "" ? query.status : null;

  if (!groupID || groupID === "0") {
    // 001: groupID 为空返回空数组; 前端初始传 '0' 时按全部用户处理
    if (groupID === "0") return c.json(ok(await memberListByGroup(c, 0, statusFilter)));
    return c.json(ok({ list: [], pageInfo: {} }));
  }
  if (groupID === "1") {
    // 根部门 = 全部用户
    return c.json(ok(await memberListByGroup(c, 0, statusFilter)));
  }
  return c.json(ok(await memberListByGroup(c, parseInt(groupID, 10), statusFilter)));
});

/**
 * 用户信息 - admin/member/getByID
 */
adminApi.all("/member/getByID", async (c) => {
  const query = await allParams(c);
  const id = (query.id || "").trim();
  const ids = id.split(",").filter((x) => /^\d+$/.test(x)).map(Number);
  if (ids.length === 0) return c.json(ok([]));
  const placeholders = ids.map(() => "?").join(",");
  const result = await c.env.DB.prepare(
    `SELECT * FROM users WHERE id IN (${placeholders})`
  ).bind(...ids).all();
  const list: any[] = [];
  for (const u of result.results as any[]) {
    list.push(await buildMemberItem(c, u));
  }
  return c.json(ok(list));
});

/**
 * 搜索用户 - admin/member/search
 * 参数: words, status, parentGroup(可选)
 */
adminApi.all("/member/search", async (c) => {
  const query = await allParams(c);
  const words = (query.words || "").trim();
  const statusFilter = query.status !== undefined && query.status !== "" ? query.status : null;
  const parentGroup = (query.parentGroup || "").trim();

  if (!words) return c.json(ok({ list: [], pageInfo: {} }));
  const like = `%${words}%`;
  let result: any;
  if (/^\d+$/.test(parentGroup) && parentGroup !== "1") {
    // 在指定部门内搜索
    const pid = parseInt(parentGroup, 10);
    result = await c.env.DB.prepare(
      `SELECT u.* FROM users u
       JOIN user_groups ug ON u.id = ug.user_id
       WHERE ug.group_id = ? AND (u.username LIKE ? OR u.nickname LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)
       ${statusFilter !== null ? "AND u.status = ?" : ""}
       GROUP BY u.id ORDER BY u.id ASC LIMIT 200`
    ).bind(pid, like, like, like, like, ...(statusFilter !== null ? [statusFilter] : [])).all();
  } else {
    result = await c.env.DB.prepare(
      `SELECT * FROM users WHERE username LIKE ? OR nickname LIKE ? OR email LIKE ? OR phone LIKE ?
       ${statusFilter !== null ? "AND status = ?" : ""}
       ORDER BY id ASC LIMIT 200`
    ).bind(like, like, like, like, ...(statusFilter !== null ? [statusFilter] : [])).all();
  }
  const list: any[] = [];
  for (const u of result.results as any[]) {
    list.push(await buildMemberItem(c, u));
  }
  return c.json(ok({ list, pageInfo: { page: 1, pageNum: 200, total: list.length } }));
});

/**
 * 解析 groupInfo JSON: 前端提交 {"groupID":"authID"} 或 {"groupID":{authID:xx}}
 */
function parseGroupInfo(raw: string): Record<string, any> {
  try {
    const obj = JSON.parse(raw || "{}");
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch { /* ignore */ }
  return {};
}

/** 将用户分配到指定部门(先清空再写入), 对齐 001 userGroupSet */
async function userGroupSet(c: any, userID: number, groupInfo: Record<string, any>, defaultAuth = 3) {
  const target = Object.keys(groupInfo).length ? groupInfo : { "1": defaultAuth };
  await c.env.DB.prepare("DELETE FROM user_groups WHERE user_id = ?").bind(userID).run();
  for (const [gid, auth] of Object.entries(target)) {
    const groupID = parseInt(gid, 10);
    if (!groupID) continue;
    const rawAuth = auth && typeof auth === "object" && "authID" in auth ? auth.authID : auth;
    let authID = parseInt(String(rawAuth ?? 0), 10) || 0;
    if (!authID) authID = defaultAuth;
    await c.env.DB.prepare(
      "INSERT INTO user_groups (user_id, group_id, authID, sort) VALUES (?, ?, ?, 0)"
    ).bind(userID, groupID, authID).run();
  }
}

/**
 * 添加用户 - admin/member/add
 * 参数: name, nickName, password(salt), roleID, sizeMax, email, phone, sex, status, groupInfo(json)
 * 001: userAdd -> userGroupSet -> show_json(success, true, userID)
 */
adminApi.all("/member/add", async (c) => {
  const q = await allParams(c);
  const name = (q.name || "").trim();
  const nickName = (q.nickName || "").trim() || name;
  const roleID = parseInt(q.roleID || "0", 10) || 0;
  const sizeMax = parseFloat(q.sizeMax || "0") || 0;
  const email = (q.email || "").trim();
  const phone = (q.phone || "").trim();
  const sex = q.sex === "0" ? 0 : 1;
  const status = q.status === "0" ? 0 : 1;

  if (!name) return c.json(fail("explorer.error"));

  const dup = await getUserByUsername(c.env.DB, name);
  if (dup) return c.json(fail("user.nameExists"));

  const salt = q.salt === "1" ? "1" : undefined;
  const plain = parseKodPassword(q.password || "", salt);
  if (!plain || plain.length < 6) return c.json(fail("user.pwdError"));

  const passwordHash = await hashPassword(plain);
  const role = roleID === 1 ? "admin" : "user";

  const result = await c.env.DB.prepare(
    `INSERT INTO users (username, password_hash, nickname, email, phone, sex, role, status, size_max)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(name, passwordHash, nickName, email, phone, sex, role, status, sizeMax).run();
  const meta = result.meta as any;
  const userID = meta?.last_row_id ?? 0;
  if (!userID) return c.json(fail("explorer.error"));

  const groupInfo = parseGroupInfo(q.groupInfo || "");
  const groupMap = Object.keys(groupInfo).length ? groupInfo : { "1": roleID || 3 };
  await userGroupSet(c, userID, groupMap, roleID || 3);

  await userDefaultInit(c.env.DB, c.env.FILES, userID, name);

  await addAuditLog(c.env.DB, "user.regist", userID, null, null, null, "admin add user");
  return c.json(ok("explorer.success", userID));
});

/**
 * 编辑用户 - admin/member/edit
 * 参数: userID, name/nickName/password/roleID/sizeMax/email/phone/sex/status/groupInfo(可选)
 * 001: userEdit -> userGroupSet -> show_json(success, true, userID)
 */
adminApi.all("/member/edit", async (c) => {
  const q = await allParams(c);
  const userID = parseInt(q.userID || "0", 10);
  if (!userID) return c.json(fail("explorer.error"));

  const updates: string[] = [];
  const args: any[] = [];
  if (q.name !== undefined && q.name !== null && q.name !== "") {
    updates.push("username = ?");
    args.push((q.name || "").trim());
  }
  if (q.nickName !== undefined && q.nickName !== null && q.nickName !== "") {
    updates.push("nickname = ?");
    args.push((q.nickName || "").trim());
  }
  if (q.email !== undefined && q.email !== null) {
    updates.push("email = ?");
    args.push((q.email || "").trim());
  }
  if (q.phone !== undefined && q.phone !== null) {
    updates.push("phone = ?");
    args.push((q.phone || "").trim());
  }
  if (q.sex !== undefined && q.sex !== "") {
    updates.push("sex = ?");
    args.push(q.sex === "0" ? 0 : 1);
  }
  if (q.status !== undefined && q.status !== "") {
    updates.push("status = ?");
    args.push(q.status === "0" ? 0 : 1);
  }
  if (q.sizeMax !== undefined && q.sizeMax !== "") {
    updates.push("size_max = ?");
    args.push(parseFloat(q.sizeMax) || 0);
  }
  if (q.roleID !== undefined && q.roleID !== "") {
    updates.push("role = ?");
    args.push(parseInt(q.roleID, 10) === 1 ? "admin" : "user");
  }
  if (q.password) {
    const salt = q.salt === "1" ? "1" : undefined;
    const plain = parseKodPassword(q.password, salt);
    if (plain && plain.length >= 6) {
      updates.push("password_hash = ?");
      args.push(await hashPassword(plain));
    }
  }
  if (updates.length) {
    updates.push("updated_at = datetime('now')");
    await c.env.DB.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).bind(...args, userID).run();
  }
  if (q.groupInfo !== undefined && q.groupInfo !== null) {
    const groupInfo = parseGroupInfo(q.groupInfo);
    if (Object.keys(groupInfo).length) {
      await userGroupSet(c, userID, groupInfo);
    }
  }
  await addAuditLog(c.env.DB, "user.setUserInfo", userID, null, null, null, "admin edit user");
  return c.json(ok("explorer.success", userID));
});

/**
 * 禁/启用用户 - admin/member/status
 */
adminApi.all("/member/status", async (c) => {
  const q = await allParams(c);
  const userID = parseInt(q.userID || "0", 10);
  if (!userID) return c.json(fail("explorer.error"));
  const status = q.status === "1" ? 1 : 0;
  await c.env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(status, userID).run();
  return c.json(ok("explorer.success"));
});

/**
 * 删除用户 - admin/member/remove
 * 参数: userID(逗号分隔)
 */
adminApi.all("/member/remove", async (c) => {
  const q = await allParams(c);
  const ids = (q.userID || "").split(",").filter((x) => /^\d+$/.test(x)).map(Number).filter((id) => id !== 1);
  if (ids.length === 0) return c.json(fail("explorer.error"));
  const placeholders = ids.map(() => "?").join(",");
  await c.env.DB.prepare(`DELETE FROM user_groups WHERE user_id IN (${placeholders})`).bind(...ids).run();
  await c.env.DB.prepare(`DELETE FROM user_option WHERE userID IN (${placeholders})`).bind(...ids).run();
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id IN (${placeholders})`).bind(...ids).run();
  await c.env.DB.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).bind(...ids).run();
  return c.json(ok("explorer.success"));
});

/**
 * 用户加入部门 - admin/member/addGroup
 */
adminApi.all("/member/addGroup", async (c) => {
  const q = await allParams(c);
  const userID = parseInt(q.userID || "0", 10);
  if (!userID) return c.json(fail("explorer.error"));
  const groupInfo = parseGroupInfo(q.groupInfo || "");
  for (const [gid, auth] of Object.entries(groupInfo)) {
    const groupID = parseInt(gid, 10);
    if (!groupID) continue;
    const rawAuth = auth && typeof auth === "object" && "authID" in auth ? auth.authID : auth;
    const authID = parseInt(String(rawAuth ?? 0), 10) || 0;
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO user_groups (user_id, group_id, authID, sort) VALUES (?, ?, ?, 0)"
    ).bind(userID, groupID, authID).run();
  }
  return c.json(ok("explorer.success"));
});

/**
 * 用户移出部门 - admin/member/removeGroup
 */
adminApi.all("/member/removeGroup", async (c) => {
  const q = await allParams(c);
  const userID = parseInt(q.userID || "0", 10);
  const groupID = parseInt(q.groupID || "0", 10);
  if (!userID || !groupID) return c.json(fail("explorer.error"));
  await c.env.DB.prepare("DELETE FROM user_groups WHERE user_id = ? AND group_id = ?").bind(userID, groupID).run();
  return c.json(ok("explorer.success"));
});

/**
 * 用户部门迁移 - admin/member/switchGroup
 */
adminApi.all("/member/switchGroup", async (c) => {
  const q = await allParams(c);
  const userID = parseInt(q.userID || "0", 10);
  const from = parseInt(q.from || "0", 10);
  const to = parseInt(q.to || "0", 10);
  if (!userID || !from || !to) return c.json(fail("explorer.error"));
  await c.env.DB.prepare("UPDATE user_groups SET group_id = ? WHERE user_id = ? AND group_id = ?")
    .bind(to, userID, from).run();
  return c.json(ok("explorer.success"));
});

/**
 * 用户元信息 - admin/member/metaInfo
 */
adminApi.all("/member/metaInfo", async (c) => {
  return c.json(ok({}));
});

async function memberListByGroup(c: any, groupID: number, statusFilter: string | null) {
  let result: any;
  if (!groupID || groupID === 0) {
    result = await c.env.DB.prepare(
      `SELECT * FROM users ${statusFilter !== null ? "WHERE status = ?" : ""} ORDER BY id ASC LIMIT 500`
    ).bind(...(statusFilter !== null ? [statusFilter] : [])).all();
  } else {
    result = await c.env.DB.prepare(
      `SELECT u.* FROM users u
       JOIN user_groups ug ON u.id = ug.user_id
       WHERE ug.group_id = ?
       ${statusFilter !== null ? "AND u.status = ?" : ""}
       GROUP BY u.id ORDER BY u.id ASC LIMIT 500`
    ).bind(groupID, ...(statusFilter !== null ? [statusFilter] : [])).all();
  }
  const list: any[] = [];
  for (const u of result.results as any[]) {
    list.push(await buildMemberItem(c, u));
  }
  return { list, pageInfo: {} };
}

async function buildMemberItem(c: any, u: any) {
  const groups = await c.env.DB.prepare(
    `SELECT g.id AS groupID, g.name AS groupName, ug.authID
     FROM user_groups ug JOIN groups g ON ug.group_id = g.id
     WHERE ug.user_id = ? ORDER BY g.sort ASC, g.id ASC`
  ).bind(u.id as number).all();
  const groupInfo: any[] = [];
  for (const grp of groups.results as any[]) {
    // 001: user_groups.authID 指向 auths 表 (部门权限组), 非 roles
    const auth = await c.env.DB.prepare("SELECT * FROM auths WHERE id = ?").bind(grp.authID ?? 0).first();
    groupInfo.push({
      groupID: grp.groupID,
      groupName: grp.groupName,
      authID: grp.authID ?? 0,
      auth: auth
        ? { label: (auth as any).label || "", name: (auth as any).name || "" }
        : { label: "", name: "" },
    });
  }
  return {
    userID: u.id,
    name: u.username,
    nickName: u.nickname || u.username,
    email: u.email || "",
    phone: u.phone || "",
    avatar: u.avatar || "",
    sex: u.sex ?? 1,
    roleID: u.role === "admin" ? 1 : 3,
    roleName: u.role,
    status: u.status ?? 1,
    sizeMax: u.size_max || 0,
    sizeUse: 0,
    groupInfo,
    sourceInfo: [],
    lastLogin: u.last_login || 0,
  };
}

// ============ admin/role ============

/**
 * 角色列表 - admin/role/get
 * 返回数组, 每项含 id/name/label/display/sort/administrator/auth
 */
adminApi.all("/role/get", async (c) => {
  const result = await c.env.DB.prepare("SELECT * FROM roles ORDER BY sort ASC, id ASC").all();
  const list = (result.results as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    display: r.display ?? 1,
    label: r.label || "",
    sort: r.sort || 0,
    administrator: r.administrator ?? 0,
    system: r.system ?? 0,
    auth: r.auth || "",
  }));
  return c.json(ok(list));
});

/** 将 role 表单提交的 auth/ignoreFileSize/desc 落库, auth 为逗号分隔权限点 */
function roleFields(q: Record<string, string>) {
  const auth = (q.auth || "").split(",").map((s) => s.trim()).filter(Boolean).join(",");
  const extra = JSON.stringify({
    desc: q.desc || "",
    ignoreFileSize: q.ignoreFileSize || "0",
  });
  return { auth, extra };
}

/**
 * 添加角色 - admin/role/add
 * 参数: name, label, display, ignoreFileSize, desc, auth(逗号分隔权限点)
 * 001: adminRole add -> show_json(success, true, id)
 */
adminApi.all("/role/add", async (c) => {
  const q = await allParams(c);
  const name = (q.name || "").trim();
  if (!name) return c.json(fail("explorer.error"));
  const label = q.label || "label-blue-normal";
  const display = q.display === "0" ? 0 : 1;
  const { auth, extra } = roleFields(q);

  const maxRow = await c.env.DB.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS nextSort FROM roles").first<{ nextSort: number }>();
  const result = await c.env.DB.prepare(
    `INSERT INTO roles (name, label, display, sort, administrator, "system", auth, permissions_json)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?)`
  ).bind(name, label, display, maxRow?.nextSort ?? 0, auth, extra).run();
  const meta = result.meta as any;
  const id = meta?.last_row_id ?? 0;
  if (!id) return c.json(fail("explorer.error"));
  return c.json(ok("explorer.success", id));
});

/**
 * 编辑角色 - admin/role/edit
 * 参数: id, name, label, display, ignoreFileSize, desc, auth
 */
adminApi.all("/role/edit", async (c) => {
  const q = await allParams(c);
  const id = parseInt(q.id || "0", 10);
  if (!id) return c.json(fail("explorer.error"));
  const updates: string[] = [];
  const args: any[] = [];
  if (q.name !== undefined && q.name !== "") {
    updates.push("name = ?");
    args.push((q.name || "").trim());
  }
  if (q.label !== undefined && q.label !== "") {
    updates.push("label = ?");
    args.push(q.label);
  }
  if (q.display !== undefined && q.display !== "") {
    updates.push("display = ?");
    args.push(q.display === "0" ? 0 : 1);
  }
  if (q.auth !== undefined) {
    const { auth, extra } = roleFields(q);
    updates.push("auth = ?");
    args.push(auth);
    updates.push("permissions_json = ?");
    args.push(extra);
  }
  if (updates.length) {
    await c.env.DB.prepare(`UPDATE roles SET ${updates.join(", ")} WHERE id = ?`).bind(...args, id).run();
  }
  return c.json(ok("explorer.success", id));
});

/**
 * 删除角色 - admin/role/remove
 * 参数: id
 */
adminApi.all("/role/remove", async (c) => {
  const q = await allParams(c);
  const id = parseInt(q.id || "0", 10);
  if (!id) return c.json(fail("explorer.error"));
  const used = await c.env.DB.prepare("SELECT COUNT(*) AS c FROM user_groups WHERE authID = ?").bind(id).first<{ c: number }>();
  if ((used?.c ?? 0) > 0) return c.json(fail("admin.role.delErrTips"));
  await c.env.DB.prepare("DELETE FROM group_roles WHERE role_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM roles WHERE id = ?").bind(id).run();
  return c.json(ok("explorer.success"));
});

/**
 * 角色排序 - admin/role/sort
 * 参数: ids(逗号分隔)
 */
adminApi.all("/role/sort", async (c) => {
  const q = await allParams(c);
  const ids = (q.ids || "").split(",").filter((x) => /^\d+$/.test(x)).map(Number);
  for (let i = 0; i < ids.length; i++) {
    await c.env.DB.prepare("UPDATE roles SET sort = ? WHERE id = ?").bind(i, ids[i]).run();
  }
  return c.json(ok("explorer.success"));
});

// ============ admin/job ============

/**
 * 职位列表 - admin/job/get
 * 001: adminJob get -> listData()
 */
adminApi.all("/job/get", async (c) => {
  const result = await c.env.DB.prepare("SELECT * FROM jobs ORDER BY sort ASC, id ASC").all();
  return c.json(ok(result.results));
});

/**
 * 添加职位 - admin/job/add
 * 参数: name(必填), display(默认1)
 */
adminApi.all("/job/add", async (c) => {
  const q = await allParams(c);
  const name = (q.name || "").trim();
  if (!name) return c.json(fail("explorer.error"));
  const display = q.display === "0" ? 0 : 1;
  const maxRow = await c.env.DB.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS nextSort FROM jobs").first<{ nextSort: number }>();
  const result = await c.env.DB.prepare("INSERT INTO jobs (name, display, sort) VALUES (?, ?, ?)")
    .bind(name, display, maxRow?.nextSort ?? 0).run();
  const meta = result.meta as any;
  const id = meta?.last_row_id ?? 0;
  return c.json(ok("explorer.success", id));
});

/**
 * 编辑职位 - admin/job/edit
 * 参数: id(必填), name/display(可选)
 */
adminApi.all("/job/edit", async (c) => {
  const q = await allParams(c);
  const id = parseInt(q.id || "0", 10);
  if (!id) return c.json(fail("explorer.error"));
  const updates: string[] = [];
  const args: any[] = [];
  if (q.name !== undefined && q.name !== "") {
    updates.push("name = ?");
    args.push((q.name || "").trim());
  }
  if (q.display !== undefined && q.display !== "") {
    updates.push("display = ?");
    args.push(q.display === "0" ? 0 : 1);
  }
  if (updates.length) {
    await c.env.DB.prepare(`UPDATE jobs SET ${updates.join(", ")} WHERE id = ?`).bind(...args, id).run();
  }
  return c.json(ok("explorer.success", id));
});

/**
 * 删除职位 - admin/job/remove
 * 参数: id
 */
adminApi.all("/job/remove", async (c) => {
  const q = await allParams(c);
  const id = parseInt(q.id || "0", 10);
  if (!id) return c.json(fail("explorer.error"));
  await c.env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(id).run();
  return c.json(ok("explorer.success"));
});

/**
 * 职位排序 - admin/job/sort
 * 参数: ids(逗号分隔)
 */
adminApi.all("/job/sort", async (c) => {
  const q = await allParams(c);
  const ids = (q.ids || "").split(",").filter((x) => /^\d+$/.test(x)).map(Number);
  for (let i = 0; i < ids.length; i++) {
    await c.env.DB.prepare("UPDATE jobs SET sort = ? WHERE id = ?").bind(i, ids[i]).run();
  }
  return c.json(ok("explorer.success"));
});

// ============ admin/auth ============

/**
 * 权限组列表 - admin/auth/get
 * 001: adminAuth get -> listData(); 权限组 auth 为位掩码(show:1,view:2,download:4,upload:8,edit:16,remove:32,share:64,comment:128,event:256,root:33554432)
 */
adminApi.all("/auth/get", async (c) => {
  const result = await c.env.DB.prepare("SELECT * FROM auths ORDER BY sort ASC, id ASC").all();
  return c.json(ok(result.results));
});

/**
 * 添加权限组 - admin/auth/add
 * 参数: name(必填), label, display(默认0), auth(位掩码, 默认0)
 * 001: auth add -> model->add($data)
 */
adminApi.all("/auth/add", async (c) => {
  const q = await allParams(c);
  const name = (q.name || "").trim();
  if (!name) return c.json(fail("explorer.error"));
  const label = q.label || "label-blue-normal";
  const display = q.display === "1" ? 1 : 0;
  const auth = parseInt(q.auth || "0", 10) || 0;
  const maxRow = await c.env.DB.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS nextSort FROM auths").first<{ nextSort: number }>();
  const result = await c.env.DB.prepare("INSERT INTO auths (name, label, display, sort, auth) VALUES (?, ?, ?, ?, ?)")
    .bind(name, label, display, maxRow?.nextSort ?? 0, auth).run();
  const meta = result.meta as any;
  const id = meta?.last_row_id ?? 0;
  return c.json(ok("explorer.success", id));
});

/**
 * 编辑权限组 - admin/auth/edit
 * 参数: id(必填), name/label/display/auth(可选)
 */
adminApi.all("/auth/edit", async (c) => {
  const q = await allParams(c);
  const id = parseInt(q.id || "0", 10);
  if (!id) return c.json(fail("explorer.error"));
  const updates: string[] = [];
  const args: any[] = [];
  if (q.name !== undefined && q.name !== "") {
    updates.push("name = ?");
    args.push((q.name || "").trim());
  }
  if (q.label !== undefined && q.label !== "") {
    updates.push("label = ?");
    args.push(q.label);
  }
  if (q.display !== undefined && q.display !== "") {
    updates.push("display = ?");
    args.push(q.display === "1" ? 1 : 0);
  }
  if (q.auth !== undefined && q.auth !== "") {
    updates.push("auth = ?");
    args.push(parseInt(q.auth, 10) || 0);
  }
  if (updates.length) {
    await c.env.DB.prepare(`UPDATE auths SET ${updates.join(", ")} WHERE id = ?`).bind(...args, id).run();
  }
  return c.json(ok("explorer.success", id));
});

/**
 * 删除权限组 - admin/auth/remove
 * 参数: id, force(1=强制删除, 跳过使用检查)
 * 001: 检查 SourceAuth.authID 与 user_group.authID 使用情况, 提示 admin.auth.delErrTips
 */
adminApi.all("/auth/remove", async (c) => {
  const q = await allParams(c);
  const id = parseInt(q.id || "0", 10);
  if (!id) return c.json(fail("explorer.error"));
  if (q.force !== "1") {
    const used = await c.env.DB.prepare("SELECT COUNT(*) AS c FROM user_groups WHERE authID = ?").bind(id).first<{ c: number }>();
    if ((used?.c ?? 0) > 0) return c.json(fail("admin.auth.delErrTips"));
  }
  await c.env.DB.prepare("DELETE FROM auths WHERE id = ?").bind(id).run();
  return c.json(ok("explorer.success"));
});

/**
 * 权限组排序 - admin/auth/sort
 * 参数: ids(逗号分隔)
 */
adminApi.all("/auth/sort", async (c) => {
  const q = await allParams(c);
  const ids = (q.ids || "").split(",").filter((x) => /^\d+$/.test(x)).map(Number);
  for (let i = 0; i < ids.length; i++) {
    await c.env.DB.prepare("UPDATE auths SET sort = ? WHERE id = ?").bind(i, ids[i]).run();
  }
  return c.json(ok("explorer.success"));
});

// ============ admin/analysis (首页数据看板) ============

function isoToUnix(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso.replace(" ", "T") + "Z").getTime();
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

async function countWhere(db: D1Database, table: string, where: string, args: any[] = []): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM ${table} ${where}`).bind(...args).first<{ c: number }>();
  return row?.c ?? 0;
}

/** 按扩展名分类文件类型(与 explorer kodFileType 一致) */
function analysisFileType(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const image = "jpg,jpeg,png,gif,bmp,ico,svg,webp,tif,tiff,cdr,svgz,xbm,eps,pjepg,heic,raw,psd,ai".split(",");
  const doc = "txt,md,pdf,ofd,doc,docx,xls,xlsx,ppt,pptx,xps,pps,ppsx,ods,odt,odp,docm,dot,dotm,xlsb,xlsm,mht,djvu,wps,dpt,csv,et,ett,pages,numbers,key,dotx,vsd,vsdx,mpp".split(",");
  const music = "mp3,wav,wma,m4a,ogg,omf,amr,aa3,flac,aac,cda,aif,aiff,mid,ra,ape".split(",");
  const movie = "mp4,flv,rm,rmvb,avi,mkv,mov,f4v,mpeg,mpg,vob,wmv,ogv,webm,3gp,mts,m2ts,m4v,mpe,3g2,asf,dat,asx,wvx,mpa".split(",");
  const zip = "zip,gz,rar,iso,tar,7z,ar,bz,bz2,xz,arj".split(",");
  if (image.includes(ext)) return "image";
  if (doc.includes(ext)) return "doc";
  if (music.includes(ext)) return "music";
  if (movie.includes(ext)) return "movie";
  if (zip.includes(ext)) return "zip";
  return "others";
}

const ANALYSIS_TYPE_TITLES: Record<string, string> = {
  image: "图片",
  doc: "文档",
  music: "音乐",
  movie: "视频",
  zip: "压缩包",
  others: "其他",
};

/** R2 全量扫描统计: 总大小/总数/今日新增/按用户(username)汇总 */
async function scanBucketStats(bucket: R2Bucket) {
  let totalSize = 0;
  let totalCnt = 0;
  let todaySize = 0;
  const perUser: Record<string, { size: number; cnt: number }> = {};
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  let cursor: string | undefined;
  try {
    do {
      const listed = await bucket.list({ cursor, limit: 1000 });
      for (const o of listed.objects) {
        const name = (o.key.split("/").pop() || "").toLowerCase();
        if (!name || name.startsWith(".")) continue;
        const owner = o.key.split("/")[0];
        if (!owner) continue;
        totalSize += o.size;
        totalCnt++;
        if (o.uploaded && o.uploaded.getTime() >= todayStart.getTime()) todaySize += o.size;
        if (!perUser[owner]) perUser[owner] = { size: 0, cnt: 0 };
        perUser[owner].size += o.size;
        perUser[owner].cnt++;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch {
    // R2 不可用时返回全 0, 不阻塞看板
  }
  return { totalSize, totalCnt, todaySize, perUser };
}

/** 扫描指定前缀下对象, 按文件类型分类统计 */
async function scanUserFileTypes(bucket: R2Bucket, prefix: string) {
  const byType: Record<string, { size: number; cnt: number }> = {};
  let cursor: string | undefined;
  try {
    do {
      const listed = await bucket.list({ prefix, cursor, limit: 1000 });
      for (const o of listed.objects) {
        const name = (o.key.split("/").pop() || "").toLowerCase();
        if (!name || name.startsWith(".")) continue;
        const t = analysisFileType(name);
        if (!byType[t]) byType[t] = { size: 0, cnt: 0 };
        byType[t].size += o.size;
        byType[t].cnt++;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch {
    // ignore
  }
  return byType;
}

/**
 * 首页统计卡片 - admin/analysis/option
 * type: user | file | access | server
 */
adminApi.all("/analysis/option", async (c) => {
  const q = await allParams(c);
  const type = q.type || "user";
  const DB = c.env.DB;

  if (type === "user") {
    const total = await countWhere(DB, "users", "");
    const active = await countWhere(DB, "users", "WHERE status = 1");
    const disable = await countWhere(DB, "users", "WHERE status = 0");
    const login = await countWhere(DB, "users", "WHERE last_login > 0");
    return c.json(ok({ total, active, disable, login, online: 0 }));
  }

  if (type === "file") {
    const stats = await scanBucketStats(c.env.FILES);
    return c.json(ok({
      sizeTotal: stats.totalSize,
      sizeActual: stats.totalSize,
      sizeSave: 0,
      cntTotal: stats.totalCnt,
      sizeToday: stats.todaySize,
    }));
  }

  if (type === "access") {
    const rows = await DB.prepare(
      "SELECT action, COUNT(*) AS c FROM audit_logs WHERE action IN ('upload','delete','fileSave','editorSave','download') GROUP BY action"
    ).all();
    const cnt: Record<string, number> = { upload: 0, down: 0, remove: 0, edit: 0 };
    for (const r of rows.results as any[]) {
      if (r.action === "upload") cnt.upload = r.c;
      else if (r.action === "delete") cnt.remove = r.c;
      else if (r.action === "download") cnt.down = r.c;
      else if (r.action === "fileSave" || r.action === "editorSave") cnt.edit += r.c;
    }
    const totalRow = await DB.prepare("SELECT COUNT(*) AS c FROM audit_logs").first<{ c: number }>();
    const userRow = await DB.prepare("SELECT COUNT(DISTINCT user_id) AS c FROM audit_logs WHERE user_id IS NOT NULL").first<{ c: number }>();
    return c.json(ok({ ...cnt, total: totalRow?.c ?? 0, user: userRow?.c ?? 0 }));
  }

  if (type === "server") {
    const stats = await scanBucketStats(c.env.FILES);
    return c.json(ok({
      diskSizeUse: stats.totalSize,
      diskSizeMax: 0,
      systemSizeUse: 0,
      systemSizeMax: 0,
      phpBit: 64,
      php: "PHP/8.2",
      cache: "Redis",
      score: 100,
      web: "Nginx/1.24",
      db: "MySQL/8.0",
      serverName: "localhost",
    }));
  }

  return c.json(ok(null));
});

/**
 * 空间占比/文件类型图 - admin/analysis/chart
 * 无参数: 返回 sizeUser/sizeGroup/sizeTotal
 * 带 userID/groupID: 返回 fileTypeAll + 各类型 {title,size}
 */
adminApi.all("/analysis/chart", async (c) => {
  const q = await allParams(c);

  if (q.userID || q.groupID) {
    let prefix: string | undefined;
    if (q.userID) {
      const user = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?").bind(parseInt(q.userID, 10)).first<{ username: string }>();
      if (user) prefix = `${user.username}/`;
      else return c.json(ok({ fileTypeAll: { size: 0, count: 0 }, others: { title: "其他", size: 0 } }));
    } else {
      prefix = `__group__/${parseInt(q.groupID, 10)}/`;
    }
    const byType = await scanUserFileTypes(c.env.FILES, prefix);
    let totalSize = 0;
    const data: Record<string, any> = {};
    for (const t of ["image", "doc", "music", "movie", "zip", "others"]) {
      const v = byType[t] || { size: 0, cnt: 0 };
      totalSize += v.size;
      data[t] = { title: ANALYSIS_TYPE_TITLES[t], size: v.size };
    }
    return c.json(ok({ fileTypeAll: { size: totalSize, count: 0 }, ...data }));
  }

  const stats = await scanBucketStats(c.env.FILES);
  const sizeGroup = stats.perUser["__group__"]?.size || 0;
  const sizeUser = stats.totalSize - sizeGroup;
  return c.json(ok({ sizeUser, sizeGroup, sizeTotal: stats.totalSize }));
});

/**
 * 趋势图 - admin/analysis/trend
 * type: user(用户增长, date*cnt) | store(空间增长, date*size); time: day|week|month|year
 */
adminApi.all("/analysis/trend", async (c) => {
  const q = await allParams(c);
  const type = q.type || "user";
  const days = q.time === "day" ? 1 : q.time === "month" ? 30 : q.time === "year" ? 365 : 7;
  const since = new Date(Date.now() - days * 86400 * 1000);

  if (type === "store") {
    const stats = await scanBucketStats(c.env.FILES);
    const today = new Date().toISOString().slice(0, 10);
    const daysList: any[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const dt = new Date(Date.now() - i * 86400 * 1000);
      daysList.push({ date: dt.toISOString().slice(0, 10), size: 0, title: "空间占用" });
    }
    daysList[daysList.length - 1].size = stats.totalSize;
    return c.json(ok(daysList));
  }

  // 用户趋势: 注册(created_at) + 登录(last_login)
  const regRows = await c.env.DB.prepare(
    "SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS c FROM users WHERE created_at >= ? GROUP BY d"
  ).bind(since.toISOString()).all();
  const loginRows = await c.env.DB.prepare(
    "SELECT datetime(last_login, 'unixepoch') AS d, COUNT(*) AS c FROM users WHERE last_login > ? GROUP BY d"
  ).bind(Math.floor(since.getTime() / 1000)).all();
  const regMap: Record<string, number> = {};
  const loginMap: Record<string, number> = {};
  for (const r of regRows.results as any[]) regMap[r.d] = r.c;
  for (const r of loginRows.results as any[]) loginMap[(r.d || "").slice(0, 10)] = r.c;

  const out: any[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86400 * 1000).toISOString().slice(0, 10);
    out.push({ date: key, cnt: regMap[key] || 0, title: "用户注册" });
  }
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86400 * 1000).toISOString().slice(0, 10);
    out.push({ date: key, cnt: loginMap[key] || 0, title: "用户登录" });
  }
  return c.json(ok(out));
});

/**
 * 首页表格 - admin/analysis/table
 * type: user(用户空间) | group(部门空间)
 */
adminApi.all("/analysis/table", async (c) => {
  const q = await allParams(c);
  const type = q.type || "user";

  if (type === "group") {
    const result = await c.env.DB.prepare("SELECT * FROM groups ORDER BY sort ASC, id ASC").all();
    // 按 R2 `__group__/{id}/` 前缀聚合各部门空间实际占用
    const groupSizes: Record<number, number> = {};
    let cursor: string | undefined;
    try {
      do {
        const listed = await c.env.FILES.list({ prefix: "__group__/", cursor, limit: 1000 });
        for (const o of listed.objects) {
          const gid = parseInt(o.key.split("/")[1] || "0", 10);
          if (gid) groupSizes[gid] = (groupSizes[gid] || 0) + o.size;
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    } catch {
      // R2 不可用时 fallback 到 DB 的 size_use
    }
    const list = (result.results as any[]).map((g) => ({
      groupID: g.id,
      name: g.name,
      groupPath: g.parent_level || `,${g.id},`,
      sizeUse: groupSizes[g.id] ?? (g.size_use || 0),
      sizeMax: g.size_max || 0,
      createTime: isoToUnix(g.created_at),
    }));
    return c.json(ok({ list, pageInfo: { page: 1, pageNum: list.length, total: list.length } }));
  }

  const stats = await scanBucketStats(c.env.FILES);
  const result = await c.env.DB.prepare(
    "SELECT id, username, nickname, last_login, created_at FROM users ORDER BY last_login DESC, id ASC LIMIT 500"
  ).all();
  const list = (result.results as any[]).map((u) => ({
    userID: u.id,
    nickName: u.nickname || u.username,
    sizeUse: stats.perUser[u.username]?.size || 0,
    lastLogin: u.last_login || 0,
    createTime: isoToUnix(u.created_at),
  }));
  return c.json(ok({ list, pageInfo: { page: 1, pageNum: list.length, total: list.length } }));
});

// ============ admin/setting ============

/**
 * 服务器信息 - admin/setting/server
 */
adminApi.all("/setting/server", async (c) => {
  return c.json(ok({
    web: "Nginx/1.24",
    php: "PHP/8.2",
    db: "MySQL/8.0",
    cache: "Redis/7.0",
    os: "Linux",
    serverName: "localhost",
    phpBit: 64,
    diskSizeUse: 0,
    diskSizeMax: 0,
    systemSizeUse: 0,
    systemSizeMax: 0,
    version: "1.68",
  }));
});

/**
 * 系统设置读取 - admin/setting/get
 * settings.value 存 JSON 字符串(对象/数组/数字/布尔)或原始字符串, 读取时按 JSON 优先解析
 */
adminApi.all("/setting/get", async (c) => {
  const rows = await c.env.DB.prepare("SELECT key, value FROM settings").all();
  const map: Record<string, any> = {};
  for (const r of rows.results as any[]) {
    const v = r.value;
    try {
      map[r.key] = JSON.parse(v);
    } catch {
      map[r.key] = v;
    }
  }
  return c.json(ok(map));
});

/**
 * 系统设置保存 - admin/setting/set (前端 saveConfig)
 * 参数: data=<json 字符串, 包含全部设置项>
 * 001: json_decode(data) -> SystemOption->set($data) -> show_json(success)
 */
adminApi.all("/setting/set", async (c) => {
  const query = await allParams(c);
  const raw = query.data || "";
  let obj: Record<string, any>;
  try {
    obj = JSON.parse(raw);
  } catch {
    return c.json(fail("explorer.error"));
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return c.json(fail("explorer.error"));
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const value = typeof v === "string" ? v : JSON.stringify(v);
    await setSetting(c.env.DB, k, value);
  }
  return c.json(ok("explorer.success"));
});

// ============ admin/log ============

/** audit_logs.action → MbesBox 标准操作类型 + 中文标题 */
const LOG_ACTION_MAP: Record<string, { type: string; title: string }> = {
  mkdir: { type: "explorer.index.mkdir", title: "新建文件夹" },
  mkfile: { type: "explorer.index.mkfile", title: "新建文件" },
  rename: { type: "explorer.index.pathRename", title: "重命名" },
  delete: { type: "explorer.index.pathDelete", title: "删除" },
  fileSave: { type: "explorer.editor.fileSave", title: "保存文件" },
  editorSave: { type: "explorer.editor.fileSave", title: "保存文件" },
  upload: { type: "explorer.upload.fileUpload", title: "上传文件" },
  "fav.add": { type: "explorer.fav.add", title: "添加收藏" },
  "fav.del": { type: "explorer.fav.del", title: "取消收藏" },
  login: { type: "user.index.loginSubmit", title: "登录" },
  "user.index.loginSubmit": { type: "user.index.loginSubmit", title: "登录" },
  "user.setUserInfo": { type: "user.setting", title: "修改资料" },
  "user.findPassword": { type: "user.setting", title: "重置密码" },
  "user.setHeadImage": { type: "user.setting", title: "修改头像" },
  "user.uploadHeadImage": { type: "user.setting", title: "上传头像" },
  "user.regist": { type: "user.regist", title: "注册" },
};

/**
 * 操作类型列表 - admin/log/typeList
 * 前端 optgroup 下拉分组：all/file/user/admin
 */
adminApi.all("/log/typeList", async (c) => {
  const list: { id: string; text: string; children: { id: string; text: string }[] }[] = [
    { id: "all", text: "全部", children: [] },
    { id: "file", text: "文件操作", children: [] },
    { id: "user", text: "用户操作", children: [] },
    { id: "admin", text: "管理操作", children: [] },
  ];
  for (const [action, m] of Object.entries(LOG_ACTION_MAP)) {
    const group = m.type.startsWith("explorer.") ? "file" : "user";
    const target = list.find((x) => x.id === group)!;
    target.children.push({ id: m.type, text: m.title });
  }
  return c.json(ok(list));
});

/**
 * 操作日志列表 - admin/log/get
 * 参数: page, pageNum, type, userID, path, ip, timeFrom, timeTo
 * 返回 {code:true, data:list, info:pageInfo}
 */
adminApi.all("/log/get", async (c) => {
  const q = await allParams(c);
  const page = Math.max(1, parseInt(q.page || "1", 10) || 1);
  const pageNum = Math.max(1, parseInt(q.pageNum || "20", 10) || 20);
  const offset = (page - 1) * pageNum;

  const where: string[] = [];
  const args: any[] = [];
  if (q.type) {
    const entry = Object.entries(LOG_ACTION_MAP).find(([, m]) => m.type === q.type);
    if (entry) {
      where.push("action = ?");
      args.push(entry[0]);
    }
  }
  if (q.userID) {
    where.push("user_id = ?");
    args.push(parseInt(q.userID, 10) || 0);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM audit_logs ${whereSql}`)
    .bind(...args).first<{ total: number }>();
  const total = totalRow?.total ?? 0;

  const rows = await c.env.DB.prepare(
    `SELECT id, action, user_id, path, ip, detail, created_at FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(...args, pageNum, offset).all();

  const userIds = [...new Set((rows.results as any[]).map((r) => r.user_id).filter(Boolean))];
  const userMap: Record<number, { name: string; nickName: string }> = {};
  if (userIds.length) {
    const users = await c.env.DB.prepare(
      `SELECT id, username, nickname FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`
    ).bind(...userIds).all();
    for (const u of users.results as any[]) {
      userMap[u.id] = { name: u.username, nickName: u.nickname || u.username };
    }
  }

  const list = (rows.results as any[]).map((r) => {
    const m = LOG_ACTION_MAP[r.action] || { type: r.action, title: r.action };
    const userInfo = userMap[r.user_id];
    return {
      id: r.id,
      type: m.type,
      title: m.title,
      desc: { path: r.path || "", type: "folder" },
      userID: r.user_id || 0,
      userInfo: userInfo
        ? { name: userInfo.name, nickName: userInfo.nickName }
        : { name: "系统" },
      createTime: isoToUnix(r.created_at),
      ip: r.ip || "",
      address: r.ip || "",
    };
  });

  return c.json({
    code: true,
    data: list,
    info: { page, pageNum, total, pageTotal: Math.max(1, Math.ceil(total / pageNum)) },
  });
});

export { adminApi };
