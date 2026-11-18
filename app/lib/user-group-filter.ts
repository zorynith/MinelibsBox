/**
 * 复刻 001 app/controller/filter/userGroup.class.php
 *
 * 用户部门查询/搜索/编辑处理:
 *  - 三权分立: 系统管理员设置用户角色及所在部门权限的还原与裁剪 (userAuthEditCheck)
 *  - 部门管理员: 只能操作自己为管理员的部门及子部门 (userGroupAdmin / allowViewGroup)
 *  - 列表过滤: 按用户可见部门范围过滤部门/成员列表 (filterGroupList / filterUserList)
 *
 * 001 的 Group/SystemRole/Auth 模型不在 src 目录内, 相关方法按调用契约在此实现:
 *  - groupMerge        : 有祖先包含关系时只保留最上层
 *  - parentInGroup      : 目标部门是否在自己可见/管理的部门子树内
 *  - groupShowRoot      : 部门可见根 (groupCompany 开启时为二级部门/子公司)
 *  - parentLevelArray   : ",1,10,11," -> ["1","10","11"]
 *  - findAuthMinDefault : 权限最小的权限组(新增部门权限时使用)
 *  - findRoleDefault    : 默认角色(最小普通用户角色)
 */
import type { AuthUser } from "./auth";
import { getSetting } from "./db";
import { t } from "./i18n";
import { AUTH_ROOT } from "./source-auth";
import { isAdminUser } from "./source";

export interface GroupAuthInfo {
  groupID: number;
  authID: number;
  auth: number;
  parentLevel: string;
}

export interface FilterConfig {
  /** 三权分立开关: 关闭后系统管理员无法设置用户角色及部门权限 */
  allowAllAction: boolean;
  /** 部门隔离时是否允许访问其他用户/部门 (开启后不做列表过滤) */
  memberAllowAll: boolean;
  /** 二级部门为子公司, 独立部门 */
  groupCompany: boolean;
}

interface CheckDef {
  group?: string;
  user?: string;
  userRole?: string;
  roleAuth?: string;
  groupArray?: string;
  read?: string;
  error?: string;
}

export interface FilterResult {
  params: Record<string, string>;
  deny?: any;
}

const CHECK_USER: Record<string, CheckDef> = {
  "admin.member.get": { group: "groupID", read: "allow", error: "list" },
  "admin.member.search": { group: "parentGroup", read: "allow", error: "list" },

  "admin.member.add": { groupArray: "groupInfo", userRole: "roleID" },
  "admin.member.addgroup": { groupArray: "groupInfo", user: "userID" },
  "admin.member.removegroup": { group: "groupID", user: "userID" },
  "admin.member.switchgroup": { group: "to", user: "userID" },

  "admin.member.edit": { groupArray: "groupInfo", user: "userID", userRole: "roleID" },
  "admin.member.status": { user: "userID" },
  "admin.member.remove": { user: "userID" },
};

const CHECK_GROUP: Record<string, CheckDef> = {
  "admin.group.get": { group: "parentID", read: "allow", error: "list" },
  "admin.group.search": { group: "parentGroup", read: "allow", error: "list" },

  "admin.group.add": { group: "parentID" },
  "admin.group.edit": { group: "groupID" },
  "admin.group.status": { group: "groupID" },
  "admin.group.remove": { group: "groupID" },
  "admin.group.sort": { group: "groupID" },
  // 001 中该 action 的 group 键重复定义, 后者生效;
  "admin.group.switchgroup": { group: "to" },

  // 部门公共标签: 获取, 修改;
  "explorer.taggroup.set": { group: "groupID" },
};

const CHECK_ROLE: Record<string, CheckDef> = {
  "admin.role.add": { roleAuth: "auth" },
  "admin.role.edit": { roleAuth: "auth" },
  "admin.role.remove": { userRole: "id" },
};

const SEARCH_ACTIONS = ["admin.member.search", "admin.group.search"];

/** 三权分立即将用户部门/角色设置还原时允许保留的字段 (001 userAuthEditCheck) */
const AUTH_EDIT_KEEP_KEY = [
  "userID",
  "groupInfo",
  "roleID",
  "HTTP_X_PLATFORM",
  "HTTP_X_PLATFORM_1",
  "CSRF_TOKEN",
  "URLrouter",
  "URLremote",
];

function trueValue(v: unknown): boolean {
  return v === 1 || v === true || String(v) === "1";
}

/** 读取 filter 相关配置 (001 config/setting.php 的默认值) */
export async function filterConfig(db: D1Database): Promise<FilterConfig> {
  const rows = await db
    .prepare("SELECT key, value FROM settings WHERE key IN ('ADMIN_ALLOW_ALL_ACTION','GROUP_MEMBER_ALLOW_ALL','groupCompany')")
    .all<{ key: string; value: string }>()
    .catch(() => ({ results: [] as { key: string; value: string }[] }));
  const map: Record<string, string> = {};
  for (const r of rows.results || []) map[r.key] = String(r.value ?? "");
  return {
    allowAllAction: map.ADMIN_ALLOW_ALL_ACTION === undefined || map.ADMIN_ALLOW_ALL_ACTION === "" ? true : trueValue(map.ADMIN_ALLOW_ALL_ACTION),
    memberAllowAll: map.GROUP_MEMBER_ALLOW_ALL === undefined || map.GROUP_MEMBER_ALLOW_ALL === "" ? false : trueValue(map.GROUP_MEMBER_ALLOW_ALL),
    groupCompany: map.groupCompany === undefined || map.groupCompany === "" ? false : trueValue(map.groupCompany),
  };
}

/** 001 parentLevelArray: ",1,10,11," -> ["1","10","11"] */
export function parentLevelArray(level: string | null | undefined): string[] {
  return String(level ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "0");
}

/** 部门的祖先链(含自身); 老数据 parent_level 可能为空 */
export async function groupParents(db: D1Database, groupID: number | string): Promise<string[]> {
  const id = String(groupID);
  if (!id || !/^\d+$/.test(id)) return [];
  const row = await db
    .prepare("SELECT parent_level FROM groups WHERE id = ?")
    .bind(parseInt(id, 10))
    .first<{ parent_level: string }>()
    .catch(() => null);
  const list = parentLevelArray(row?.parent_level);
  if (!list.includes(id)) list.push(id);
  return list;
}

/** 001 Group::groupMerge: 有包含关系时只保留最上层 */
export async function groupMerge(db: D1Database, ids: Array<number | string>): Promise<string[]> {
  const list = [...new Set(ids.map((v) => String(v)).filter((v) => v && v !== "0"))];
  if (list.length < 2) return list;
  const parentsMap = new Map<string, string[]>();
  for (const id of list) parentsMap.set(id, await groupParents(db, id));
  const out: string[] = [];
  for (const id of list) {
    const parents = parentsMap.get(id) || [];
    const hasAncestor = parents.some((p) => p !== id && list.includes(p));
    if (!hasAncestor) out.push(id);
  }
  return out;
}

/** 001 Group::groupShowRoot: 部门可见根 (groupCompany 关闭时可见根为根部门) */
export async function groupShowRoot(
  db: D1Database,
  groupID: number | string,
  groupCompany: boolean,
): Promise<string[]> {
  if (!groupCompany) return ["1"];
  const parents = (await groupParents(db, groupID)).filter((p) => p !== "1");
  if (parents.length) return [parents[0]];
  return ["1"];
}

/** 用户部门信息 (001 Session kodUser.groupInfo) */
export async function userGroupInfo(db: D1Database, userID: number): Promise<GroupAuthInfo[]> {
  const rows = await db
    .prepare(
      `SELECT ug.group_id AS groupID, ug.authID AS authID, g.parent_level AS parentLevel, a.auth AS auth
       FROM user_groups ug
       LEFT JOIN groups g ON g.id = ug.group_id
       LEFT JOIN auths a ON a.id = ug.authID
       WHERE ug.user_id = ? ORDER BY ug.sort ASC, ug.group_id ASC`,
    )
    .bind(userID)
    .all<any>()
    .catch(() => ({ results: [] as any[] }));
  return (rows.results || []).map((r: any) => ({
    groupID: Number(r.groupID) || 0,
    authID: Number(r.authID) || 0,
    auth: parseInt(String(r.auth ?? 0), 10) || 0,
    parentLevel: String(r.parentLevel ?? ""),
  }));
}

/** 自己所在为管理员的部门 (001 userGroupAdmin) */
export async function userGroupAdmin(db: D1Database, user: AuthUser): Promise<string[]> {
  if (isAdminUser(user)) return ["1"];
  const list = await userGroupInfo(db, user.id);
  const adminIDs = list.filter((g) => (g.auth & AUTH_ROOT) === AUTH_ROOT).map((g) => String(g.groupID));
  return groupMerge(db, adminIDs);
}

/** 自己所在部门 (001 userGroupAt): 有包含关系时只显示最上层 */
export async function userGroupAt(db: D1Database, user: AuthUser): Promise<string[]> {
  const list = await userGroupInfo(db, user.id);
  return groupMerge(db, list.map((g) => String(g.groupID)));
}

/** 自己可见的部门 (001 userGroupRootShow): 所在部门向上回溯 */
export async function userGroupRootShow(db: D1Database, user: AuthUser, cfg: FilterConfig): Promise<string[]> {
  const list = await userGroupInfo(db, user.id);
  const result: string[] = [];
  for (const g of list) {
    result.push(...(await groupShowRoot(db, g.groupID, cfg.groupCompany)));
  }
  return groupMerge(db, result);
}

/** 当前用户是否有操作该部门的权限 */
export async function allowChangeGroup(db: D1Database, user: AuthUser, groupID: unknown): Promise<boolean> {
  return (await allowViewGroup(db, await userGroupAdmin(db, user), groupID)) === true;
}

/** 当前用户是否有操作该用户的权限 */
export async function allowChangeUser(db: D1Database, user: AuthUser, userID: unknown): Promise<boolean> {
  return (await allowViewUser(db, await userGroupAdmin(db, user), userID)) === true;
}

/**
 * 检测自己是否有权限获取指定部门信息。
 * returnAllow 为 true 时返回有权限访问的部分部门 id (逗号分隔), 否则返回全部是否都有权限。
 */
export async function allowViewGroup(
  db: D1Database,
  selfGroup: string[],
  groups: unknown,
  returnAllow = false,
): Promise<boolean | string> {
  if (!selfGroup || selfGroup.length === 0) return false;
  let allowAll = true;
  const allowHas: string[] = [];
  for (const theID of String(groups ?? "").replace(/^,+|,+$/g, "").split(",")) {
    const id = theID.trim();
    if (!id) continue;
    const parents = await groupParents(db, id);
    if (parents.some((p) => selfGroup.includes(p))) {
      allowHas.push(id);
    } else {
      allowAll = false;
      if (!returnAllow) return false;
    }
  }
  return returnAllow ? allowHas.join(",") : allowAll;
}

/** 检测自己是否有权限获取指定用户信息 */
export async function allowViewUser(
  db: D1Database,
  selfGroup: string[],
  users: unknown,
  returnAllow = false,
): Promise<boolean | string> {
  if (!selfGroup || selfGroup.length === 0) return false;
  let allowAll = true;
  const allowHas: string[] = [];
  for (const theID of String(users ?? "").replace(/^,+|,+$/g, "").split(",")) {
    const id = theID.trim();
    if (!id) continue;
    const groups = await userGroupIDs(db, parseInt(id, 10) || 0);
    const allow = await allowViewGroup(db, selfGroup, groups.join(","), true);
    if (typeof allow === "string" && allow) {
      allowHas.push(id);
    } else {
      allowAll = false;
      if (!returnAllow) return false;
    }
  }
  return returnAllow ? allowHas.join(",") : allowAll;
}

/** 用户所在部门 id 列表 */
async function userGroupIDs(db: D1Database, userID: number): Promise<number[]> {
  if (!userID) return [];
  const rows = await db
    .prepare("SELECT group_id FROM user_groups WHERE user_id = ?")
    .bind(userID)
    .all<{ group_id: number }>()
    .catch(() => ({ results: [] as { group_id: number }[] }));
  return (rows.results || []).map((r) => Number(r.group_id) || 0).filter(Boolean);
}

/** 角色的权限点列表 */
async function roleAuthOf(db: D1Database, user: AuthUser): Promise<string[]> {
  const row = await db
    .prepare("SELECT roleID, role FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ roleID: number; role: string }>()
    .catch(() => null);
  const roleID = Number(row?.roleID) || (row?.role === "admin" || row?.role === "root" ? 1 : 0);
  if (!roleID) return [];
  const role = await db
    .prepare("SELECT auth FROM roles WHERE id = ?")
    .bind(roleID)
    .first<{ auth: string }>()
    .catch(() => null);
  return String(role?.auth ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 001 authCan: 当前用户角色是否包含指定权限点 */
export async function authCan(db: D1Database, user: AuthUser, action: string): Promise<boolean> {
  if (user.role === "root") return true;
  const list = await roleAuthOf(db, user);
  return list.includes(action);
}

/**
 * 权限修改删除范围处理 (001 roleActionAllow):
 * 只能操作权限包含内容小于等于自己权限包含内容的类型。
 */
export async function roleActionAllow(db: D1Database, user: AuthUser, actions: unknown): Promise<boolean> {
  const list = String(actions ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) return true;
  const selfActions = await roleAuthOf(db, user);
  return list.every((a) => selfActions.includes(a));
}

/** 001 allowChangeUserRole: 系统管理员角色不允许非系统管理员获取/设置 */
export async function allowChangeUserRole(
  db: D1Database,
  user: AuthUser,
  roleID: unknown,
  cfg: FilterConfig,
): Promise<boolean> {
  const id = parseInt(String(roleID ?? "0"), 10) || 0;
  if (isAdminUser(user) || !id) return true;
  const role = await db
    .prepare("SELECT administrator, auth FROM roles WHERE id = ?")
    .bind(id)
    .first<{ administrator: number; auth: string }>()
    .catch(() => null);
  if (role && Number(role.administrator) === 1) return false;
  if (!cfg.allowAllAction) return true;
  return roleActionAllow(db, user, role?.auth ?? "");
}

/** 001 findAuthMinDefault: 权限最小的权限组 */
export async function findAuthMinDefault(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT id FROM auths ORDER BY auth ASC, id ASC LIMIT 1")
    .first<{ id: number }>()
    .catch(() => null);
  return Number(row?.id) || 3;
}

/** 001 findRoleDefault: 默认角色(最小普通用户角色) */
export async function findRoleDefault(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT id FROM roles WHERE administrator = 0 ORDER BY sort ASC, id ASC LIMIT 1")
    .first<{ id: number }>()
    .catch(() => null);
  return Number(row?.id) || 3;
}

function parseGroupInfo(raw: unknown): Record<string, any> {
  try {
    const obj = JSON.parse(String(raw ?? "{}"));
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, any>;
  } catch {
    /* ignore */
  }
  return {};
}

function authIDOf(v: any): string {
  const raw = v && typeof v === "object" && "authID" in v ? v.authID : v;
  return String(raw ?? "");
}

/**
 * 001 userAuthEditKeepGroupInfo: 三权分立即只能修改所在部门 / 或只能修改所在部门权限。
 * onlyAuth: 只能修改已有部门的权限(移除设置中不存在的部门, 保留已有部门与原权限)
 * onlyEdit: 只能修改所在部门, 不能修改部门权限(新部门使用默认最小权限)
 */
export async function userAuthEditKeepGroupInfo(
  db: D1Database,
  params: Record<string, string>,
  groupInfoKey: string,
  userID: unknown,
  type: "onlyAuth" | "onlyEdit",
): Promise<void> {
  if (!groupInfoKey || params[groupInfoKey] === undefined) return;
  const authSet = parseGroupInfo(params[groupInfoKey]);
  const uid = parseInt(String(userID ?? "0"), 10) || 0;
  const oldList = uid ? await userGroupInfo(db, uid) : [];
  const groupAuth: Record<string, GroupAuthInfo> = {};
  for (const g of oldList) groupAuth[String(g.groupID)] = g;
  const defaultAuth = await findAuthMinDefault(db);

  if (type === "onlyAuth") {
    for (const groupID of Object.keys(authSet)) {
      if (!groupAuth[groupID]) delete authSet[groupID];
    }
    for (const [groupID, info] of Object.entries(groupAuth)) {
      if (authSet[groupID] === undefined) authSet[groupID] = String(info.authID);
    }
  } else {
    let isGroupAppend = String(params.groupInfoAppend ?? "") === "1";
    if (String(params.__action ?? "").toLowerCase() === "admin.member.addgroup") isGroupAppend = true;
    for (const groupID of Object.keys(authSet)) {
      authSet[groupID] = groupAuth[groupID] ? String(groupAuth[groupID].authID) : String(defaultAuth);
    }
    if (isGroupAppend) {
      for (const [groupID, info] of Object.entries(groupAuth)) {
        if (authSet[groupID] === undefined) authSet[groupID] = String(info.authID);
      }
    }
  }
  params[groupInfoKey] = JSON.stringify(authSet);
}

/**
 * 001 allowChangeGroupArray: 修改所在部门及权限时检测
 * (不允许删除/添加用户在自己非部门管理员的部门)
 */
export async function allowChangeGroupArray(
  db: D1Database,
  user: AuthUser,
  params: Record<string, string>,
  check: CheckDef,
): Promise<boolean> {
  const groupInfoKey = check.groupArray || "";
  if (!groupInfoKey || params[groupInfoKey] === undefined) return true;
  const authSet = parseGroupInfo(params[groupInfoKey]);
  const userID = check.user ? params[check.user] : undefined;
  const uid = parseInt(String(userID ?? "0"), 10) || 0;
  const oldList = uid ? await userGroupInfo(db, uid) : [];
  const groupAuth: Record<string, GroupAuthInfo> = {};
  for (const g of oldList) groupAuth[String(g.groupID)] = g;
  const hasUser = oldList.length > 0;
  let allow = true;
  const adminGroup = await userGroupAdmin(db, user);

  const canChange = async (groupID: string) => (await allowViewGroup(db, adminGroup, groupID, false)) === true;

  for (const [groupID, auth] of Object.entries(authSet)) {
    if (hasUser && groupAuth[groupID] && String(groupAuth[groupID].authID) === authIDOf(auth)) continue;
    if (!(await canChange(groupID))) {
      allow = false;
      break;
    }
  }
  if (!hasUser) return allow;

  let isGroupAppend = String(params.groupInfoAppend ?? "") === "1";
  if (String(params.__action ?? "").toLowerCase() === "admin.member.addgroup") isGroupAppend = true;

  // 其他自己无权限部门: 不允许删除, 不允许修改;
  for (const [groupID, info] of Object.entries(groupAuth)) {
    if (isGroupAppend && !authSet[groupID]) authSet[groupID] = String(info.authID);
    if (await canChange(groupID)) continue;
    if (!authSet[groupID]) authSet[groupID] = String(info.authID);
  }
  for (const [groupID, auth] of Object.entries(authSet)) {
    if (await canChange(groupID)) continue;
    if (String(groupAuth[groupID]?.authID ?? "") !== authIDOf(auth)) {
      allow = false;
      break;
    }
  }
  params[groupInfoKey] = JSON.stringify(authSet);
  return allow;
}

/**
 * 001 userAuthEditCheck: 三权分立系统管理员.
 * 返回是否允许; 同时按 001 语义裁剪 params (移除 roleID / 还原 groupInfo)。
 */
export async function userAuthEditCheck(
  db: D1Database,
  user: AuthUser,
  action: string,
  params: Record<string, string>,
  cfg: FilterConfig,
): Promise<boolean> {
  let allowUserAuth = await authCan(db, user, "admin.member.userAuth");
  let allowUserEdit = await authCan(db, user, "admin.member.userEdit");
  if (isAdminUser(user)) {
    allowUserEdit = true;
    allowUserAuth = cfg.allowAllAction;
  }
  if (allowUserEdit && allowUserAuth) return true;
  if (!allowUserEdit && !allowUserAuth) return true;

  const userCheckActions: Record<string, CheckDef> = {
    "admin.member.add": { groupArray: "groupInfo", userRole: "roleID" },
    "admin.member.removegroup": {},
    "admin.member.switchgroup": {},
    "admin.member.edit": { groupArray: "groupInfo", userRole: "roleID" },
    "admin.member.status": {},
    "admin.member.remove": {},
  };
  const userCheck = userCheckActions[action];
  if (!userCheck) return true;
  const groupInfoKey = userCheck.groupArray || "";

  // 不允许编辑用户,仅允许设置用户权限(安全保密员角色)
  if (!allowUserEdit && allowUserAuth) {
    if (action !== "admin.member.edit") return false;
    for (const key of Object.keys(params)) {
      if (!AUTH_EDIT_KEEP_KEY.includes(key)) delete params[key];
    }
    await userAuthEditKeepGroupInfo(db, params, groupInfoKey, params["userID"], "onlyAuth");
    return true;
  }

  // 允许编辑用户,不允许设置用户权限(用户管理员; 系统管理员-启用三权分立时)
  if (allowUserEdit && !allowUserAuth) {
    if (params["roleID"] !== undefined) delete params["roleID"];
    if (action === "admin.member.add") params["roleID"] = String(await findRoleDefault(db));
    await userAuthEditKeepGroupInfo(db, params, groupInfoKey, params["userID"], "onlyEdit");
    return true;
  }
  return true;
}

/** 001 checkError: 无 error 配置直接报无权限; 列表类返回空结果 */
export function checkErrorResult(check: CheckDef): any {
  if (!check || !check.error) {
    return { code: false, data: t("explorer.noPermissionAction") };
  }
  const result = check.error === "listSimple"
    ? []
    : { list: [], pageInfo: { page: 1, totalNum: 0, pageTotal: 0 } };
  return { code: true, data: result, info: "empty" };
}

/** 001 checkItemRead: 部门/成员列表读取范围检测 */
async function checkItemRead(
  db: D1Database,
  user: AuthUser,
  params: Record<string, string>,
  check: CheckDef,
  cfg: FilterConfig,
): Promise<boolean> {
  const groupList = await userGroupInfo(db, user.id);
  if (!groupList.length) return false; // 不在任何部门则不支持用户及部门查询
  const groupArray = await userGroupRootShow(db, user, cfg);
  let groupID = check.group ? String(params[check.group] ?? "") : "";
  if (groupID === "root" || groupID === "rootOuter") groupID = "";
  if (!check.group) return true;
  if (!groupID) return true;
  return (await allowViewGroup(db, groupArray, groupID, false)) === true;
}

/** 001 checkItem: 单个 action 的权限检测; 同时按 001 语义修改 params */
async function checkItem(
  db: D1Database,
  user: AuthUser,
  action: string,
  params: Record<string, string>,
  check: CheckDef,
  cfg: FilterConfig,
): Promise<boolean> {
  if (check.read === "allow") {
    // 部门管理员,从后台搜索部门; 仅限在有权限的部门中搜索
    const isFromAdmin = String(params["requestFromType"] ?? "") === "admin";
    const isSearch = SEARCH_ACTIONS.includes(action);
    if (isSearch && isFromAdmin && params[check.group || ""] === undefined) {
      params[check.group || ""] = (await userGroupAdmin(db, user)).join(",");
    }
    return checkItemRead(db, user, params, check, cfg);
  }

  let allow = true;
  if (check.group) {
    const groupID = params[check.group];
    allow = (await allowChangeGroup(db, user, groupID)) === true;
    const adminGroup = await userGroupAdmin(db, user);
    // 自己为管理员的根部门: 禁用编辑与删除
    const disableAction = ["admin.group.edit", "admin.group.remove"];
    if (disableAction.includes(action) && adminGroup.includes(String(groupID ?? ""))) allow = false;
  }
  if (allow) allow = await userAuthEditCheck(db, user, action, params, cfg);
  if (allow && check.user) allow = (await allowChangeUser(db, user, params[check.user])) === true;
  if (allow && check.userRole) allow = await allowChangeUserRole(db, user, params[check.userRole], cfg);
  if (allow && check.roleAuth && params["roleID"] !== undefined) {
    allow = await roleActionAllow(db, user, params[check.roleAuth]);
  }
  if (allow && check.groupArray) allow = await allowChangeGroupArray(db, user, params, check);
  return allow;
}

/**
 * 入口: 复刻 filter/userGroup::check。
 * 返回裁剪后的 params 与拒绝响应(deny 为 show_json 等价负载)。
 */
export async function userGroupFilter(
  c: any,
  action: string,
  input: Record<string, string>,
): Promise<FilterResult> {
  const params: Record<string, string> = { ...input };
  const user: AuthUser | undefined = c.get("currentUser");
  if (!user) return { params, deny: { code: false, data: t("user.loginFirst") } };

  const db: D1Database = c.env.DB;
  const cfg = await filterConfig(db);
  const actionLower = action.toLowerCase();
  params.__action = actionLower;

  if (isAdminUser(user)) {
    if (cfg.allowAllAction) return { params };
    await userAuthEditCheck(db, user, actionLower, params, cfg);
    return { params };
  }

  const check = CHECK_USER[actionLower] || CHECK_GROUP[actionLower] || CHECK_ROLE[actionLower];
  if (!check) return { params };

  const allow = await checkItem(db, user, actionLower, params, check, cfg);
  if (allow) return { params };
  return { params, deny: checkErrorResult(check) };
}

/**
 * 001 adminGroup/adminMember::showGroupfilterAllow:
 * 按当前用户可见部门范围过滤部门列表。
 */
export async function filterGroupList(
  db: D1Database,
  user: AuthUser,
  list: any[],
  cfg: FilterConfig,
): Promise<any[]> {
  if (cfg.memberAllowAll) return list;
  if (!list || !list.length || isAdminUser(user)) return list;
  const rootShow = await userGroupRootShow(db, user, cfg);
  const result: any[] = [];
  for (const group of list) {
    if (!group || !group.groupID || group.groupID === "-") {
      if (Array.isArray(group?.children)) group.children = await filterGroupList(db, user, group.children, cfg);
      result.push(group);
      continue;
    }
    const parents = await groupParents(db, String(group.parentLevel ?? "") + String(group.groupID) + ",");
    if (parents.some((p) => rootShow.includes(p))) result.push(group);
  }
  return result;
}

/**
 * 001 adminMember::showUserfilterAllow:
 * 按当前用户可见部门范围过滤成员; 有部门管理权限且来自后台时返回完整信息,
 * 否则精简为 userID/avatar/name/nickName/sex/groupInfo。
 */
export async function filterUserList(
  db: D1Database,
  user: AuthUser,
  list: any[],
  params: Record<string, string>,
  cfg: FilterConfig,
): Promise<any[]> {
  if (cfg.memberAllowAll) return list;
  if (!list || !list.length || isAdminUser(user)) return list;
  const rootShow = await userGroupRootShow(db, user, cfg);
  const adminGroup = await userGroupAdmin(db, user);
  const requestAdmin = String(params["requestFromType"] ?? "") === "admin";

  const result: any[] = [];
  for (const item of list) {
    const groupParentAll: string[] = [];
    for (const info of item?.groupInfo || []) {
      const parents = await groupParents(db, String(info?.groupID ?? ""));
      for (const p of parents) if (!groupParentAll.includes(p)) groupParentAll.push(p);
      const gid = String(info?.groupID ?? "");
      if (gid && !groupParentAll.includes(gid)) groupParentAll.push(gid);
    }
    const allowShow = groupParentAll.some((p) => rootShow.includes(p));
    const allowFull = groupParentAll.some((p) => adminGroup.includes(p));
    if (!allowShow) continue;
    if (allowFull && requestAdmin) {
      result.push(item);
      continue;
    }
    const allowField = ["userID", "avatar", "name", "nickName", "sex", "groupInfo"];
    const simple: Record<string, any> = {};
    for (const key of allowField) simple[key] = item?.[key];
    result.push(simple);
  }
  return result;
}

/**
 * 001 Model('Auth') 可见权限组: 系统管理员可见全部, 其他用户仅可见权限不超过自己的权限组。
 */
export async function authAllowList(db: D1Database, user: AuthUser): Promise<any[]> {
  const rows = await db.prepare("SELECT * FROM auths ORDER BY sort ASC, id ASC").all<any>();
  const list = rows.results || [];
  if (isAdminUser(user)) return list;
  const adminGroup = await userGroupAdmin(db, user);
  let selfAuth = 0;
  for (const gid of adminGroup) {
    const row = await db
      .prepare("SELECT a.auth AS auth FROM user_groups ug JOIN auths a ON a.id = ug.authID WHERE ug.user_id = ? AND ug.group_id = ?")
      .bind(user.id, parseInt(gid, 10) || 0)
      .first<{ auth: number }>()
      .catch(() => null);
    selfAuth |= parseInt(String(row?.auth ?? 0), 10) || 0;
  }
  return list.filter((a: any) => ((parseInt(String(a.auth ?? 0), 10) || 0) & ~selfAuth) === 0);
}
