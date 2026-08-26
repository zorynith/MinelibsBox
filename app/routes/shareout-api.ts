import { Hono } from "hono";
import type { Context } from "hono";
import { getSetting } from "../lib/db";

// 站间联合分享 (explorer/shareOut): 匿名接口, 均通过签名/密钥校验。
// 密钥交换方案对齐 001 Mcrypt 语义(明文+过期时间戳+HMAC), worker 间可互操作。
type Vars = { currentUser: import("../lib/auth").AuthUser };
export const shareOutRouter = new Hono<{ Bindings: Env; Variables: Vars }>();

const MCRYPT_SECRET = "kodShareOut";

async function hmacHex(keyStr: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(keyStr), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  let b = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  return atob(b);
}

/** 001 Mcrypt::encode(data,key,expire): 签名(可选过期秒), 返回 base64url token */
async function mcryptEncode(data: string, key: string, expireSec = 0): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  const payload = expireSec > 0 ? `${data}\n${ts}\n${expireSec}` : data;
  const sig = await hmacHex(key, payload);
  return b64urlEncode(payload + "|" + sig);
}

/** 001 Mcrypt::decode(token,key): 校验签名与过期时间, 返回明文; 失败返回空 */
async function mcryptDecode(token: string, key: string): Promise<string> {
  if (!token) return "";
  try {
    const full = b64urlDecode(token);
    const lastSep = full.lastIndexOf("|");
    if (lastSep < 0) return "";
    const payload = full.slice(0, lastSep);
    const sig = full.slice(lastSep + 1);
    const expect = await hmacHex(key, payload);
    if (sig !== expect) return "";
    if (payload.includes("\n")) {
      const parts = payload.split("\n");
      if (parts.length !== 3) return "";
      const ts = parseInt(parts[1], 10);
      const expire = parseInt(parts[2], 10);
      if (Math.floor(Date.now() / 1000) > ts + expire) return "";
      return parts[0];
    }
    return payload;
  } catch {
    return "";
  }
}

// 限流: 同一 siteFrom 10 秒内最多 5 次
const shareOutCallMap = new Map<string, number[]>();
function rateLimit(siteFrom: string): boolean {
  const now = Date.now();
  const list = (shareOutCallMap.get(siteFrom) || []).filter((t) => now - t < 10000);
  if (list.length >= 5) return false;
  list.push(now);
  shareOutCallMap.set(siteFrom, list);
  return true;
}

async function bodyParams(c: Context): Promise<Record<string, string>> {
  const body: Record<string, string> = {};
  try {
    const raw = (await c.req.parseBody()) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") body[k] = v;
    }
  } catch {
    /* ignore */
  }
  for (const [k, v] of Object.entries(c.req.query())) body[k] = v;
  return body;
}

// 权限映射: read/write -> 当前站点 auth 记录 id
async function findAuthMax(c: Context, need: number, exclude: number): Promise<number> {
  const rows = await c.env.DB.prepare("SELECT id, auth FROM auths").all();
  let best = 0;
  let bestAuth = -1;
  for (const r of rows.results as any[]) {
    const a = r.auth as number;
    if ((a & need) === need && (a & exclude) === 0 && a > bestAuth) {
      bestAuth = a;
      best = r.id as number;
    }
  }
  return best;
}

async function authListMake(c: Context): Promise<Record<string, number>> {
  const read = await findAuthMax(c, 7, 56); // SHOW|VIEW|DOWNLOAD, 排除 UPLOAD|EDIT|REMOVE
  const write = await findAuthMax(c, 63, 33554432); // SHOW|VIEW|DOWNLOAD|UPLOAD|EDIT|REMOVE, 排除 ROOT
  return { read, write };
}

interface ShareOutParam {
  _authTo: Array<{ targetType: number; targetID: number; authID: number }>;
  _shareTarget: Array<{ target: string; secret: string; auth: string; authID: number; to: string }>;
  siteFrom: string;
  siteTo: string;
  shareID: number;
  shareHash: string;
  shareUser: string;
  sourceInfo: Record<string, unknown>;
}

// 001 shareParamParse: 签名校验 + 限流 + target/auth 解析
async function shareParamParse(c: Context, inData: Record<string, string>): Promise<ShareOutParam | { error: string }> {
  const siteFrom = (inData.siteFrom || "").replace(/\/+$/, "");
  const siteTo = (inData.siteTo || "").replace(/\/+$/, "");
  const shareID = parseInt(inData.shareID || "0", 10);
  const shareHash = inData.shareHash || "";
  const shareUser = inData.shareUser || "";
  let sourceInfo: Record<string, unknown> = {};
  let shareOut: Array<{ target: string; secret: string; auth: string }> = [];
  try {
    sourceInfo = JSON.parse(inData.sourceInfo || "{}");
  } catch {
    /* ignore */
  }
  try {
    shareOut = JSON.parse(inData.shareOut || "[]");
  } catch {
    /* ignore */
  }

  const allowRecive = (await getSetting(c.env.DB, "shareOutAllowRecive")) || "";
  if (allowRecive !== "1") return { error: "explorer.shareOut.errorDisableReceive" };

  const checkKey = await mcryptDecode(inData._check || "", MCRYPT_SECRET);
  if (checkKey !== siteFrom) return { error: "explorer.share.errorParam" };
  if (!rateLimit(siteFrom)) return { error: "explorer.shareOut.errorCallLimit" };

  const authList = await authListMake(c);
  const _shareTarget: ShareOutParam["_shareTarget"] = [];
  const _authTo: ShareOutParam["_authTo"] = [];
  const seen = new Set<string>();

  for (const item of shareOut) {
    const target = item.target || "";
    let targetType = 1; // 001 SourceModel::TYPE_USER
    let targetID = 0;
    if (target.startsWith("user:")) {
      const name = target.slice(5);
      const u: any = await c.env.DB.prepare("SELECT id FROM users WHERE username = ? OR nickname = ? LIMIT 1").bind(name, name).first().catch(() => null);
      if (u) targetID = u.id as number;
    } else if (target.startsWith("group:")) {
      const name = target.slice(6);
      const g: any = await c.env.DB.prepare("SELECT id FROM groups WHERE name = ? LIMIT 1").bind(name).first().catch(() => null);
      if (g) {
        targetID = g.id as number;
        targetType = 2; // 001 SourceModel::TYPE_GROUP
      }
    } else {
      const u: any = await c.env.DB.prepare("SELECT id FROM users WHERE username = ? OR email = ? OR nickname = ? LIMIT 1").bind(target, target, target).first().catch(() => null);
      if (u) targetID = u.id as number;
    }
    const authID = authList[item.auth] || 0;
    const dedupKey = `${targetType}-${targetID}`;
    if (!targetID || !authID || seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    _shareTarget.push({
      target,
      secret: item.secret || "",
      auth: item.auth || "",
      authID,
      to: `${target}@${siteTo}`,
    });
    _authTo.push({ targetType, targetID, authID });
  }

  return { _authTo, _shareTarget, siteFrom, siteTo, shareID, shareHash, shareUser, sourceInfo };
}

function failMsg(err: string): { code: boolean; data: string } {
  return { code: false, data: err };
}

// ==================== 接收端接口 ====================

// 检测是否允许接收外站联合分享
shareOutRouter.post("/shareCheck", async (c) => {
  const inData = await bodyParams(c);
  const data = await shareParamParse(c, inData);
  if ("error" in data) return c.json(failMsg(data.error));
  if (!data._authTo.length) return c.json(failMsg("explorer.shareOut.errorTarget"));
  return c.json({ code: true, data: "ok:check" });
});

// 接收处理: 自动生成协作分享(独立IO)
shareOutRouter.post("/shareMake", async (c) => {
  const inData = await bodyParams(c);
  const data = await shareParamParse(c, inData);
  if ("error" in data) return c.json(failMsg(data.error));

  const siteFrom = data.siteFrom;
  const sourcePath = `share@${data.shareID}@${siteFrom}`;
  let shareFind: any = await c.env.DB.prepare("SELECT shareID FROM share WHERE userID = 0 AND sourcePath = ? LIMIT 1").bind(sourcePath).first().catch(() => null);

  if (!data._authTo.length) {
    if (shareFind) await c.env.DB.prepare("DELETE FROM share WHERE shareID = ?").bind(shareFind.shareID).run();
    if (!inData.shareOut) return c.json({ code: true, data: "ok" });
    return c.json(failMsg("explorer.shareOut.errorTarget"));
  }

  // 检测来源站点并验证其启用了外部站点分享
  const apiFrom = `${siteFrom}/index.php?shareOut/sendCheckAllow`;
  let response: any = null;
  try {
    const res = await fetch(apiFrom, { signal: AbortSignal.timeout(6000) });
    response = await res.json();
  } catch {
    /* ignore */
  }
  if (!response || response.info !== "kodbox") return c.json(failMsg("explorer.shareOut.errorNetwork," + siteFrom));
  if (!response.code) return c.json(failMsg(String(response.data)));

  const options = {
    site: siteFrom,
    shareID: data.shareID,
    shareHash: data.shareHash,
    shareUser: data.shareUser,
    sourceInfo: data.sourceInfo,
    shareTarget: data._shareTarget,
  };
  const authToJson = JSON.stringify(data._authTo);

  let shareID: number;
  if (shareFind) {
    shareID = shareFind.shareID as number;
    await c.env.DB.prepare("UPDATE share SET isShareTo = 1, password = '__SHSRE_OUTER__', sourcePath = ?, options = ?, modifyTime = datetime('now') WHERE shareID = ?")
      .bind(sourcePath, JSON.stringify(options), shareID)
      .run();
    // 001 share.authTo 存于 options; worker 用 share_to 表承载接收方
    await c.env.DB.prepare("DELETE FROM share_to WHERE shareID = ?").bind(shareID).run();
  } else {
    const r = await c.env.DB.prepare("INSERT INTO share (title, shareHash, userID, sourceID, sourcePath, url, isLink, isShareTo, password, options, createTime, modifyTime) VALUES ('', '', 0, '0', ?, '', 0, 1, '__SHSRE_OUTER__', ?, datetime('now'), datetime('now'))")
      .bind(sourcePath, JSON.stringify(options))
      .run();
    shareID = Number((r as any).meta?.last_row_id || r.meta?.changes || 0);
    const row: any = await c.env.DB.prepare("SELECT shareID FROM share WHERE sourcePath = ? ORDER BY shareID DESC LIMIT 1").bind(sourcePath).first().catch(() => null);
    if (row) shareID = row.shareID as number;
  }

  for (const item of data._authTo) {
    await c.env.DB.prepare("INSERT OR REPLACE INTO share_to (shareID, targetType, targetID, authID, createTime, modifyTime) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(shareID, item.targetType, item.targetID, item.authID, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000))
      .run();
  }

  return c.json({ code: true, data: `ok:${shareFind ? "edit" : "add"};shareID=${shareID}` });
});

// apiKey 检测 (管理员后台添加授信站点时)
shareOutRouter.post("/shareCheckApiKey", async (c) => {
  const inData = await bodyParams(c);
  const configAllowRecive = (await getSetting(c.env.DB, "shareOutAllowRecive")) || "";
  const configApiKey = (await getSetting(c.env.DB, "shareOutSiteApiKey")) || "";
  if (configAllowRecive !== "1") return c.json(failMsg("explorer.shareOut.errorDisableReceive"));
  const checkKey = await mcryptDecode(inData.apiKey || "", MCRYPT_SECRET);
  if (!configApiKey || configApiKey !== checkKey) return c.json(failMsg("explorer.shareOut.errorApiKey"));
  return c.json({ code: true, data: "ok:check" });
});

// 授信目标站点组织架构获取 (sk 签名)
shareOutRouter.post("/shareSafeGroup", async (c) => {
  const inData = await bodyParams(c);
  const configAllowRecive = (await getSetting(c.env.DB, "shareOutAllowRecive")) || "";
  const configApiKey = (await getSetting(c.env.DB, "shareOutSiteApiKey")) || "";
  if (configAllowRecive !== "1") return c.json(failMsg("explorer.shareOut.errorDisableReceive"));
  const checkKey = await mcryptDecode(inData.sk || "", configApiKey);
  if (!configApiKey || checkKey !== "kodShareOutGroup") return c.json(failMsg("explorer.shareOut.errorApiKey(timeout)"));

  const siteIndex = inData.siteIndex || "";
  const method = inData.method || "";
  let rows: any[] = [];
  if (method === "groupList") {
    const parentID = parseInt(inData.parentID || "0", 10);
    const parent: any = await c.env.DB.prepare("SELECT id, name, parent_id FROM groups WHERE id = ?").bind(parentID).first().catch(() => null);
    const list = await c.env.DB.prepare("SELECT id, name, parent_id FROM groups WHERE parent_id = ? ORDER BY id").bind(parentID).all();
    for (const g of list.results as any[]) {
      rows.push({ groupID: g.id, name: g.name, groupPath: parent ? `${parent.name}/${g.name}` : g.name, hasChildren: 0, hasChildrenMember: 0, siteIndex });
    }
  } else if (method === "groupSearch") {
    const words = `%${inData.words || ""}%`;
    const list = await c.env.DB.prepare("SELECT id, name, parent_id FROM groups WHERE name LIKE ? ORDER BY id").bind(words).all();
    for (const g of list.results as any[]) {
      rows.push({ groupID: g.id, name: g.name, groupPath: g.name, hasChildren: 0, hasChildrenMember: 0, siteIndex });
    }
  } else if (method === "memberList") {
    const groupID = parseInt(inData.groupID || "0", 10);
    const list = await c.env.DB.prepare(
      "SELECT u.id AS userID, u.username AS name, u.nickname AS nickName, u.avatar AS avatar FROM user_groups ug JOIN users u ON u.id = ug.user_id WHERE ug.group_id = ? ORDER BY u.id"
    )
      .bind(groupID)
      .all();
    for (const u of list.results as any[]) {
      rows.push({ userID: u.userID, name: u.name, nickName: u.nickName, avatar: u.avatar, siteIndex });
    }
  } else if (method === "memberSearch") {
    const words = `%${inData.words || ""}%`;
    const list = await c.env.DB.prepare("SELECT id AS userID, username AS name, nickname AS nickName, avatar AS avatar FROM users WHERE username LIKE ? OR nickname LIKE ? ORDER BY id").bind(words, words).all();
    for (const u of list.results as any[]) {
      rows.push({ userID: u.userID, name: u.name, nickName: u.nickName, avatar: u.avatar, siteIndex });
    }
  } else {
    return c.json(failMsg("method error!"));
  }
  return c.json({ code: true, data: { list: rows } });
});

// 接收端: 成员用户退出协作处理 (向发起端请求)
shareOutRouter.post("/shareUserExit", async (c) => {
  const inData = await bodyParams(c);
  const siteFrom = (inData.siteFrom || "").replace(/\/+$/, "");
  const shareID = parseInt(inData.shareID || "0", 10);
  const secret = inData.secret || "";
  if (!siteFrom || !shareID || !secret) return c.json({ code: false, data: false });
  const apiFrom = `${siteFrom}/index.php?shareOut/sendShareUserExit`;
  try {
    const res = await fetch(apiFrom, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `shareID=${shareID}&secret=${encodeURIComponent(secret)}`,
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    return c.json(data);
  } catch {
    return c.json({ code: false, data: false });
  }
});

// ==================== 发送方接口 ====================

// 接收时向发起站点的能力探测
shareOutRouter.all("/sendCheckAllow", async (c) => {
  const shareLinkAllow = (await getSetting(c.env.DB, "shareLinkAllow")) || "";
  const shareOutAllowSend = (await getSetting(c.env.DB, "shareOutAllowSend")) || "";
  if (shareLinkAllow !== "1") return c.json({ code: false, data: "explorer.shareOut.errorDisableShare", info: "kodbox" });
  if (shareOutAllowSend !== "1") return c.json({ code: false, data: "explorer.shareOut.errorDisableSend", info: "kodbox" });
  return c.json({ code: true, data: "ok:check", info: "kodbox" });
});

// 分享端: 成员用户退出协作处理
shareOutRouter.post("/sendShareUserExit", async (c) => {
  const shareLinkAllow = (await getSetting(c.env.DB, "shareLinkAllow")) || "";
  const shareOutAllowSend = (await getSetting(c.env.DB, "shareOutAllowSend")) || "";
  if (shareLinkAllow !== "1") return c.json({ code: false, data: "explorer.shareOut.errorDisableShare", info: "kodbox" });
  if (shareOutAllowSend !== "1") return c.json({ code: false, data: "explorer.shareOut.errorDisableSend", info: "kodbox" });

  const inData = await bodyParams(c);
  const shareID = parseInt(inData.shareID || "0", 10);
  const secret = inData.secret || "";
  const shareInfo: any = await c.env.DB.prepare("SELECT * FROM share WHERE shareID = ?").bind(shareID).first().catch(() => null);
  if (!shareInfo) return c.json({ code: false, data: "explorer.share.notExist", info: "kodbox" });

  let shareOut: any[] = [];
  try {
    shareOut = JSON.parse(shareInfo.options || "{}").shareOut || [];
  } catch {
    /* ignore */
  }
  const shareOutNew = shareOut.filter((item: any) => item.secret !== secret);
  if (shareOutNew.length === shareOut.length) return c.json({ code: false, data: "explorer.share.notExist", info: "kodbox" });

  let options: Record<string, unknown> = {};
  try {
    options = JSON.parse(shareInfo.options || "{}");
  } catch {
    /* ignore */
  }
  if (shareOutNew.length) options.shareOut = shareOutNew;
  else delete options.shareOut;
  await c.env.DB.prepare("UPDATE share SET isLink = 1, options = ?, modifyTime = datetime('now') WHERE shareID = ?").bind(JSON.stringify(options), shareID).run();
  return c.json({ code: true, data: "ok", info: "kodbox" });
});
