/**
 * Comment API - 复刻 001 comment 控制器 (comment/index + comment/topic)。
 *
 * 前端契约 (panel-chat 聊天面板):
 *  - listData: 评论列表, 支持 targetType+targetID / userID / pid, idFrom/idTo 增量分页;
 *    返回 { list, pageInfo:{totalNum,pageNum,page,pageTotal} }, list 按 commentID 升序(前端 reverse 显示)。
 *  - add: content + pid(回复时), 返回新评论(含 user)。
 *  - remove / prasise / edit / listByUser / listSelf / listChildren。
 *
 * 权限 (对齐 001 comment/auth):
 *  - 目标类型仅允许 TYPE_SOURCE(1) 文件 / TYPE_SHARE(2) 分享。
 *  - 001 通过 Source pathInfo 校验 comment/edit 权限位; worker 以虚拟路径驱动、无 sourceID->path 反查,
 *    故 TYPE_SOURCE 放宽为"登录 + 目标合法"(前端已按 pathInfo comment 权限控制评论入口),
 *    TYPE_SHARE 校验分享存在。
 *  - 编辑/删除评论: 仅本人或 admin。
 */
import { Hono } from "hono";
import { authRequired, isAdmin } from "../lib/auth";
import { getShareById } from "../lib/share";

type Vars = { currentUser: import("../lib/auth").AuthUser };
const commentApi = new Hono<{ Bindings: Env; Variables: Vars }>();

const TYPE_SOURCE = 1;
const TYPE_SHARE = 2;
const TYPE_USER = 3;
const TYPE_GROUP = 4;

// ============ helpers ============

function ok(data: any = "", info?: any) {
  const res: any = { code: true, data };
  if (info !== undefined) res.info = info;
  return res;
}

function fail(data: string = "explorer.error", code: boolean = false, info?: any) {
  const res: any = { code, data };
  if (info !== undefined) res.info = info;
  return res;
}

async function parseBody(c: any): Promise<Record<string, string>> {
  const body: Record<string, string> = {};
  const rawBody = await c.req.parseBody().catch(() => ({}));
  for (const [k, v] of Object.entries(rawBody)) {
    body[k] = typeof v === "string" ? v : "";
  }
  return body;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 目标类型合法性检测 (001 checkType: 仅 Source / Share 可评论)。 */
function checkType(targetType: number, targetID: number): string | null {
  if ((targetType !== TYPE_SOURCE && targetType !== TYPE_SHARE) || !targetType || !targetID) {
    return "common.invalidParam";
  }
  return null;
}

/** 评论权限 - 查看列表。TYPE_SHARE 校验分享存在。 */
async function checkView(env: Env, user: import("../lib/auth").AuthUser, targetType: number, targetID: number): Promise<string | null> {
  const err = checkType(targetType, targetID);
  if (err) return err;
  if (targetType === TYPE_SHARE) {
    const share = await getShareById(env.DB, targetID);
    if (!share) return "common.notExists";
  }
  return null;
}

/** 评论权限 - 添加/点赞。 */
async function checkEdit(env: Env, user: import("../lib/auth").AuthUser, targetType: number, targetID: number): Promise<string | null> {
  return checkView(env, user, targetType, targetID);
}

/** 编辑/删除评论: 本人或 admin。 */
function checkSelf(user: import("../lib/auth").AuthUser, commentUserID: number): boolean {
  return isAdmin(user) || user.id === commentUserID;
}

/** 轻量用户对象 (001 评论 user 字段)。 */
async function commentUser(env: Env, userID: number): Promise<Record<string, unknown>> {
  const row: any = await env.DB.prepare("SELECT id, username, nickname, email, phone, avatar FROM users WHERE id = ?")
    .bind(userID)
    .first()
    .catch(() => null);
  if (!row) {
    return { userID: 0, name: "", nickName: "", avatar: "" };
  }
  return {
    userID: row.id,
    name: row.username,
    nickName: row.nickname || row.username,
    nickname: row.nickname || row.username,
    email: row.email || "",
    phone: row.phone || "",
    avatar: row.avatar || "",
  };
}

/** 批量用户 Map (评论列表 user 信息)。 */
async function commentUserMap(env: Env, ids: number[]): Promise<Map<number, Record<string, unknown>>> {
  const map = new Map<number, Record<string, unknown>>();
  const uniq = Array.from(new Set(ids.filter((n) => Number.isFinite(n) && n > 0)));
  if (uniq.length === 0) return map;
  const ph = uniq.map(() => "?").join(",");
  const rows = (await env.DB.prepare(
    `SELECT id, username, nickname, email, phone, avatar FROM users WHERE id IN (${ph})`
  )
    .bind(...uniq)
    .all<Record<string, unknown>>()
    .catch(() => ({ results: [] }))) as any;
  for (const r of rows.results || []) {
    map.set(Number(r.id), {
      userID: r.id,
      name: r.username,
      nickName: r.nickname || r.username,
      nickname: r.nickname || r.username,
      email: r.email || "",
      phone: r.phone || "",
      avatar: r.avatar || "",
    });
  }
  return map;
}

/** 组装单条评论为前端格式 (含 user / parentComment)。 */
async function decorateComment(env: Env, row: any, userMap?: Map<number, Record<string, unknown>>): Promise<Record<string, unknown>> {
  const map = userMap || await commentUserMap(env, [Number(row.userID)]);
  const item: Record<string, unknown> = {
    commentID: Number(row.commentID),
    pid: Number(row.pid),
    userID: Number(row.userID),
    targetType: Number(row.targetType),
    targetID: Number(row.targetID),
    content: row.content,
    praiseCount: Number(row.praiseCount || 0),
    commentCount: Number(row.commentCount || 0),
    status: Number(row.status ?? 1),
    modifyTime: Number(row.modifyTime || 0),
    createTime: Number(row.createTime || 0),
    user: map.get(Number(row.userID)) || { userID: Number(row.userID), name: "", nickName: "", avatar: "" },
  };
  if (Number(row.pid) > 0) {
    const parent: any = await env.DB.prepare("SELECT * FROM comment WHERE commentID = ?").bind(Number(row.pid)).first().catch(() => null);
    if (parent) {
      const pmap = userMap || await commentUserMap(env, [Number(parent.userID)]);
      item.parentComment = {
        commentID: Number(parent.commentID),
        pid: Number(parent.pid),
        userID: Number(parent.userID),
        content: parent.content,
        createTime: Number(parent.createTime || 0),
        user: pmap.get(Number(parent.userID)) || { userID: Number(parent.userID), name: "", nickName: "", avatar: "" },
      };
    }
  }
  return item;
}

/**
 * 评论查询核心 (001 CommentModel::listData)。
 * where: targetType+targetID / userID / pid; idFrom/idTo 增量; page/pageNum 分页。
 */
async function listComments(env: Env, where: { targetType?: number; targetID?: number; userID?: number; pid?: number }, opt: { idFrom?: number; idTo?: number; pageNum?: number; page?: number }): Promise<{ list: any[]; pageInfo: any }> {
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (where.pid !== undefined) {
    conds.push("pid = ?");
    binds.push(where.pid);
  } else if (where.userID !== undefined) {
    conds.push("userID = ?");
    binds.push(where.userID);
  } else {
    conds.push("targetType = ?", "targetID = ?");
    binds.push(where.targetType, where.targetID);
  }
  // 目标点赞记录 (starTarget 存于 comment 表 pid=0 content='') 不进入评论列表
  if (where.pid === undefined) {
    conds.push("content != ''");
  }
  if (opt.idFrom) {
    conds.push("commentID > ?");
    binds.push(opt.idFrom);
  }
  if (opt.idTo) {
    conds.push("commentID < ?");
    binds.push(opt.idTo);
  }

  const pageNum = Math.max(1, opt.pageNum || 50);
  const page = Math.max(1, opt.page || 1);
  const whereSql = conds.join(" AND ");

  const totalRow: any = await env.DB.prepare(`SELECT COUNT(*) AS c FROM comment WHERE ${whereSql}`).bind(...binds).first().catch(() => null);
  const totalNum = Number(totalRow?.c || 0);

  const rows = await env.DB.prepare(
    `SELECT * FROM comment WHERE ${whereSql} ORDER BY commentID ASC LIMIT ? OFFSET ?`
  )
    .bind(...binds, pageNum, (page - 1) * pageNum)
    .all<Record<string, unknown>>()
    .catch(() => ({ results: [] }));

  const ids = (rows.results || []).map((r) => Number(r.userID));
  const userMap = await commentUserMap(env, ids);
  const list: any[] = [];
  for (const r of rows.results || []) {
    list.push(await decorateComment(env, r, userMap));
  }
  return {
    list,
    pageInfo: {
      totalNum,
      pageNum,
      page,
      pageTotal: Math.max(1, Math.ceil(totalNum / pageNum)),
    },
  };
}

/** 读取某讨论主题的已读位置 (001 Cache, worker 用内存 Map)。 */
const chatReadLast = new Map<string, number>();
function chatReadKey(userID: number): string {
  return `userChatReadLast_${userID}`;
}

// ============ comment/index ============

// 评论列表
commentApi.post("/index/listData", authRequired, async (c) => {
  const user = c.get("currentUser");
  const p = await parseBody(c);
  const targetType = parseInt(p.targetType, 10) || 0;
  const targetID = parseInt(p.targetID, 10) || 0;
  const idFrom = parseInt(p.idFrom, 10) || 0;
  const idTo = parseInt(p.idTo, 10) || 0;

  const err = await checkView(c.env, user, targetType, targetID);
  if (err) return c.json(fail(err));

  // 自动标记已读 (001: 非首屏向后加载时标记该主题已读)
  if (!idFrom && !!idTo) {
    const maxRow: any = await c.env.DB.prepare(
      `SELECT MAX(commentID) AS m FROM comment WHERE targetType = ? AND targetID = ?`
    )
      .bind(targetType, targetID)
      .first()
      .catch(() => null);
    const key = chatReadKey(user.id);
    const prev = chatReadLast.get(key) || 0;
    chatReadLast.set(key, Math.max(prev, Number(maxRow?.m || 0)));
  }

  const result = await listComments(c.env, { targetType, targetID }, {
    idFrom: idFrom || 0,
    idTo: idTo || 0,
    pageNum: parseInt(p.pageNum, 10) || 0,
    page: parseInt(p.page, 10) || 0,
  });
  return c.json(ok(result));
});

// 添加评论
commentApi.post("/index/add", authRequired, async (c) => {
  const user = c.get("currentUser");
  const p = await parseBody(c);
  const targetType = parseInt(p.targetType, 10) || 0;
  const targetID = parseInt(p.targetID, 10) || 0;
  const content = (p.content || "").trim();
  const pid = parseInt(p.pid, 10) || 0;

  const err = await checkEdit(c.env, user, targetType, targetID);
  if (err) return c.json(fail(err));
  if (!content) return c.json(fail("common.invalidParam"));

  const ts = nowSec();
  const res: any = await c.env.DB.prepare(
    `INSERT INTO comment (pid, userID, targetType, targetID, content, praiseCount, commentCount, status, modifyTime, createTime)
     VALUES (?, ?, ?, ?, ?, 0, 0, 1, ?, ?)`
  )
    .bind(pid, user.id, targetType, targetID, content, ts, ts)
    .run();
  const commentID = Number(res.meta?.last_row_id ?? 0);

  if (pid > 0) {
    await c.env.DB.prepare("UPDATE comment SET commentCount = commentCount + 1, modifyTime = ? WHERE commentID = ?")
      .bind(ts, pid)
      .run();
  }

  const row: any = await c.env.DB.prepare("SELECT * FROM comment WHERE commentID = ?").bind(commentID).first().catch(() => null);
  const item = row ? await decorateComment(c.env, row) : null;
  return c.json(ok(item || {}));
});

// 编辑评论
commentApi.post("/index/edit", authRequired, async (c) => {
  const user = c.get("currentUser");
  const p = await parseBody(c);
  const id = parseInt(p.id, 10) || 0;
  const content = (p.content || "").trim();
  if (!id) return c.json(fail("common.invalidParam"));
  if (!content) return c.json(fail("common.invalidParam"));

  const row: any = await c.env.DB.prepare("SELECT * FROM comment WHERE commentID = ?").bind(id).first().catch(() => null);
  if (!row) return c.json(fail("common.notExists"));
  if (!checkSelf(user, Number(row.userID))) return c.json(fail("explorer.noPermissionAction"));

  await c.env.DB.prepare("UPDATE comment SET content = ?, modifyTime = ? WHERE commentID = ?")
    .bind(content, nowSec(), id)
    .run();
  return c.json(ok("explorer.success"));
});

// 删除评论
commentApi.post("/index/remove", authRequired, async (c) => {
  const user = c.get("currentUser");
  const p = await parseBody(c);
  const id = parseInt(p.id, 10) || 0;
  if (!id) return c.json(fail("common.invalidParam"));

  const row: any = await c.env.DB.prepare("SELECT * FROM comment WHERE commentID = ?").bind(id).first().catch(() => null);
  if (!row) return c.json(fail("common.notExists"));
  if (!checkSelf(user, Number(row.userID))) return c.json(fail("explorer.noPermissionAction"));

  // 级联删除子评论与点赞
  const childRows: any = await c.env.DB.prepare("SELECT commentID FROM comment WHERE pid = ?").bind(id).all().catch(() => ({ results: [] }));
  const childIds = (childRows.results || []).map((r: any) => Number(r.commentID));
  const delIds = [id, ...childIds];
  const ph = delIds.map(() => "?").join(",");
  await c.env.DB.prepare(`DELETE FROM comment WHERE commentID IN (${ph})`).bind(...delIds).run();
  await c.env.DB.prepare(`DELETE FROM comment_praise WHERE commentID IN (${ph})`).bind(...delIds).run();

  if (Number(row.pid) > 0) {
    const cnt = 1 + childIds.length;
    await c.env.DB.prepare("UPDATE comment SET commentCount = MAX(commentCount - ?, 0), modifyTime = ? WHERE commentID = ?")
      .bind(cnt, nowSec(), Number(row.pid))
      .run();
  }
  return c.json(ok("explorer.success"));
});

// 点赞/取消赞评论
commentApi.post("/index/prasise", authRequired, async (c) => {
  const user = c.get("currentUser");
  const p = await parseBody(c);
  const id = parseInt(p.id, 10) || 0;
  if (!id) return c.json(fail("common.invalidParam"));

  const row: any = await c.env.DB.prepare("SELECT * FROM comment WHERE commentID = ?").bind(id).first().catch(() => null);
  if (!row) return c.json(fail("common.notExists"));
  const err = await checkEdit(c.env, user, Number(row.targetType), Number(row.targetID));
  if (err) return c.json(fail(err));

  const praised: any = await c.env.DB.prepare("SELECT id FROM comment_praise WHERE commentID = ? AND userID = ?")
    .bind(id, user.id)
    .first()
    .catch(() => null);
  const ts = nowSec();
  let count = Number(row.praiseCount || 0);
  let status = 0;
  if (praised) {
    await c.env.DB.prepare("DELETE FROM comment_praise WHERE commentID = ? AND userID = ?").bind(id, user.id).run();
    count = Math.max(count - 1, 0);
    status = 0;
  } else {
    await c.env.DB.prepare("INSERT INTO comment_praise (commentID, userID, createTime, modifyTime) VALUES (?, ?, ?, ?)")
      .bind(id, user.id, ts, ts)
      .run();
    count = count + 1;
    status = 1;
  }
  await c.env.DB.prepare("UPDATE comment SET praiseCount = ?, modifyTime = ? WHERE commentID = ?").bind(count, ts, id).run();
  return c.json(ok({ count, status }));
});

// 点赞评论的用户列表
commentApi.post("/index/prasiseUserList", authRequired, async (c) => {
  const p = await parseBody(c);
  const id = parseInt(p.id, 10) || 0;
  if (!id) return c.json(ok({ count: 0, userList: [] }));
  const rows: any = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.nickname, u.avatar FROM comment_praise cp
     LEFT JOIN users u ON u.id = cp.userID WHERE cp.commentID = ? ORDER BY cp.id ASC`
  )
    .bind(id)
    .all<Record<string, unknown>>()
    .catch(() => ({ results: [] }));
  const userList = (rows.results || []).map((r: any) => ({
    userID: Number(r.id),
    name: r.username,
    nickName: r.nickname || r.username,
    avatar: r.avatar || "",
  }));
  return c.json(ok({ count: userList.length, userList }));
});

// 直接点赞目标对象 (001 starTarget; 目标点赞记录存 comment 表 pid=0 content='')
commentApi.post("/index/starTarget", authRequired, async (c) => {
  const user = c.get("currentUser");
  const p = await parseBody(c);
  const targetType = parseInt(p.targetType, 10) || 0;
  const targetID = parseInt(p.targetID, 10) || 0;
  const err = await checkEdit(c.env, user, targetType, targetID);
  if (err) return c.json(fail(err));

  const ts = nowSec();
  const target: any = await c.env.DB.prepare(
    `SELECT commentID FROM comment WHERE targetType = ? AND targetID = ? AND pid = 0 AND content = '' ORDER BY commentID ASC LIMIT 1`
  )
    .bind(targetType, targetID)
    .first()
    .catch(() => null);

  const praised: any = await (target
    ? c.env.DB.prepare("SELECT id FROM comment_praise WHERE commentID = ? AND userID = ?").bind(Number(target.commentID), user.id).first().catch(() => null)
    : Promise.resolve(null));

  let targetID2: number;
  if (target) {
    targetID2 = Number(target.commentID);
  } else {
    const ins: any = await c.env.DB.prepare(
      `INSERT INTO comment (pid, userID, targetType, targetID, content, praiseCount, commentCount, status, modifyTime, createTime)
       VALUES (0, ?, ?, ?, '', 0, 0, 1, ?, ?)`
    )
      .bind(user.id, targetType, targetID, ts, ts)
      .run();
    targetID2 = Number(ins.meta?.last_row_id ?? 0);
  }

  let count = 0;
  if (praised) {
    await c.env.DB.prepare("DELETE FROM comment_praise WHERE commentID = ? AND userID = ?").bind(targetID2, user.id).run();
  } else {
    await c.env.DB.prepare("INSERT INTO comment_praise (commentID, userID, createTime, modifyTime) VALUES (?, ?, ?, ?)")
      .bind(targetID2, user.id, ts, ts)
      .run();
  }
  const cntRow: any = await c.env.DB.prepare("SELECT COUNT(*) AS c FROM comment_praise WHERE commentID = ?").bind(targetID2).first().catch(() => null);
  count = Number(cntRow?.c || 0);
  await c.env.DB.prepare("UPDATE comment SET praiseCount = ? WHERE commentID = ?").bind(count, targetID2).run();

  const userList = await starUserList(c.env, targetID2);
  return c.json(ok({ count, userList }));
});

async function starUserList(env: Env, commentID: number): Promise<Record<string, unknown>[]> {
  const rows: any = await env.DB.prepare(
    `SELECT u.id, u.username, u.nickname, u.avatar FROM comment_praise cp
     LEFT JOIN users u ON u.id = cp.userID WHERE cp.commentID = ? ORDER BY cp.id ASC`
  )
    .bind(commentID)
    .all<Record<string, unknown>>()
    .catch(() => ({ results: [] }));
  return (rows.results || []).map((r: any) => ({
    userID: Number(r.id),
    name: r.username,
    nickName: r.nickname || r.username,
    avatar: r.avatar || "",
  }));
}

// 目标点赞用户列表
commentApi.post("/index/starTargetUserList", authRequired, async (c) => {
  const p = await parseBody(c);
  const targetType = parseInt(p.targetType, 10) || 0;
  const targetID = parseInt(p.targetID, 10) || 0;
  const target: any = await c.env.DB.prepare(
    `SELECT commentID FROM comment WHERE targetType = ? AND targetID = ? AND pid = 0 AND content = '' ORDER BY commentID ASC LIMIT 1`
  )
    .bind(targetType, targetID)
    .first()
    .catch(() => null);
  if (!target) return c.json(ok({ count: 0, userList: [] }));
  const userList = await starUserList(c.env, Number(target.commentID));
  return c.json(ok({ count: userList.length, userList }));
});

// 查询用户评论
commentApi.post("/index/listByUser", authRequired, async (c) => {
  const user = c.get("currentUser");
  if (!isAdmin(user)) return c.json(fail("explorer.noPermissionAction"));
  const p = await parseBody(c);
  const userID = parseInt(p.userID, 10) || 0;
  if (!userID) return c.json(fail("common.invalidParam"));
  const result = await listComments(c.env, { userID }, {
    pageNum: parseInt(p.pageNum, 10) || 0,
    page: parseInt(p.page, 10) || 0,
  });
  return c.json(ok(result));
});

// 自己的评论
commentApi.post("/index/listSelf", authRequired, async (c) => {
  const user = c.get("currentUser");
  const p = await parseBody(c);
  const result = await listComments(c.env, { userID: user.id }, {
    pageNum: parseInt(p.pageNum, 10) || 0,
    page: parseInt(p.page, 10) || 0,
  });
  return c.json(ok(result));
});

// 评论的子评论
commentApi.post("/index/listChildren", authRequired, async (c) => {
  const p = await parseBody(c);
  const pid = parseInt(p.pid, 10) || 0;
  if (!pid) return c.json(fail("common.invalidParam"));
  const parent: any = await c.env.DB.prepare("SELECT * FROM comment WHERE commentID = ?").bind(pid).first().catch(() => null);
  if (!parent) return c.json(fail("common.notExists"));
  const err = await checkView(c.env, c.get("currentUser"), Number(parent.targetType), Number(parent.targetID));
  if (err) return c.json(fail(err));
  const result = await listComments(c.env, { pid }, {
    pageNum: parseInt(p.pageNum, 10) || 0,
    page: parseInt(p.page, 10) || 0,
  });
  return c.json(ok(result));
});

// ============ comment/topic ============
// 001 topic.chatTopic() 恒空 (该版本聊天主题已停用), index/notify/readAll 返回空列表。
// read 记录某主题已读位置 (供 listData 自动标记已读使用)。

commentApi.post("/topic/index", authRequired, async (c) => {
  return c.json(ok([]));
});

commentApi.post("/topic/notify", authRequired, async (c) => {
  return c.json(ok([]));
});

commentApi.post("/topic/readAll", authRequired, async (c) => {
  return c.json(ok([]));
});

commentApi.post("/topic/read", authRequired, async (c) => {
  const user = c.get("currentUser");
  const p = await parseBody(c);
  const targetType = parseInt(p.targetType, 10) || 0;
  const targetID = parseInt(p.targetID, 10) || 0;
  if (!targetType || !targetID) return c.json(fail("common.invalidParam"));
  const maxRow: any = await c.env.DB.prepare(
    `SELECT MAX(commentID) AS m FROM comment WHERE targetType = ? AND targetID = ?`
  )
    .bind(targetType, targetID)
    .first()
    .catch(() => null);
  const key = chatReadKey(user.id);
  const prev = chatReadLast.get(key) || 0;
  chatReadLast.set(key, Math.max(prev, Number(maxRow?.m || 0)));
  return c.json(ok("explorer.success"));
});

export { commentApi };
