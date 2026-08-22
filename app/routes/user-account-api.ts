/**
 * User account API - setting/regist/bind/view account routes
 * Re-implements 001 userSetting/userRegist/userBind controllers for 003
 */
import { Hono } from "hono";
import { authRequired, hashPassword, verifyPassword } from "../lib/auth";
import { getUserByUsername, userEdit, userSearch, getUserById, setUserOption, addAuditLog, getDeviceList, getUserLogs } from "../lib/db";
import { parseKodPassword, md5 } from "../lib/mcrypt";
import {
  getAppHost, renderCaptchaSvg, randomCaptcha, randomNumCode, storeImageCaptcha, checkImgCode,
  checkMsgCode, storeMsgCode, checkMsgFreq, checkInputFormat, buildUserInfo, buildLoginList, getSelfSessionSign,
} from "../lib/user-system";
import { getUserFileKey, getFileMimeType } from "../lib/r2";
import { t } from "../lib/i18n";
import { userDefaultInit } from "../lib/user-init";

type Vars = { currentUser: import("../lib/auth").AuthUser };
const accountApi = new Hono<{ Bindings: Env; Variables: Vars }>();

// ============ shared helpers ============

function ok(data: any = "", info?: any, infoMore?: any) {
  const res: any = { code: true, data: typeof data === "string" ? t(data) : data };
  if (info !== undefined) res.info = info;
  if (infoMore !== undefined) res.infoMore = infoMore;
  return res;
}

function fail(data: any = "explorer.error", code: boolean | number = false, info?: any) {
  const res: any = { code, data: typeof data === "string" ? t(data) : data };
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

async function getRegistConfig(db: D1Database) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'regist'").first<{ value: string }>();
  if (row) {
    try {
      return JSON.parse(row.value);
    } catch { /* fallthrough */ }
  }
  return { openRegist: "0", checkRegist: "0", sizeMax: "0", roleID: "", groupInfo: '{"1":""}', allowPhone: "1" };
}

// ============ user/view - checkCode / sendCode / qrcode / pluginDesc ============

// checkCode - image captcha (GET image)
accountApi.get("/view/checkCode", async (c) => {
  const code = randomCaptcha(4);
  await storeImageCaptcha(c, code);
  const svg = renderCaptchaSvg(code);
  return c.body(svg, 200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
});

// sendCode - send message/email verification code (login/findPwd/regist)
accountApi.post("/view/sendCode", async (c) => {
  const body = await parseBody(c);
  const type = body.type;
  const input = (body.input || "").trim();
  const source = body.source || "";
  const checkCode = body.checkCode || "";

  if (type !== "email" && type !== "phone") return c.json(fail("common.invalid"));
  if (!input) return c.json(fail("common.invalid"));
  if (!checkInputFormat(type, input)) {
    const text = type + (type === "phone" ? "Number" : "");
    return c.json(fail("common.invalid" + "common." + text));
  }
  if (!["setting", "regist", "findpwd", "deregist"].includes(source)) {
    return c.json(fail("common.invalidRequest"));
  }

  // image captcha check
  const cap = await checkImgCode(c, checkCode);
  if (!cap.ok) return c.json(fail(cap.msg, false, "10011"));

  // regist: check openRegist
  const regist = await getRegistConfig(c.env.DB);
  if (source === "regist") {
    if (regist.openRegist !== "1") return c.json(fail("user.registNotAllow"));
    const exists = await userSearch(c.env.DB, { [type]: input }, "userID");
    if (exists) {
      return c.json(fail("common." + type + "user.registed"));
    }
  }
  // findpwd: check user exists
  if (source === "findpwd") {
    const userID = body.userID || "0";
    if (userID === "0") {
      const exists = await userSearch(c.env.DB, { [type]: input }, "userID");
      if (!exists) return c.json(fail("common." + type + "common.error"));
    }
  }

  // frequency check
  const freqOk = await checkMsgFreq(c, type, input, source);
  if (!freqOk) return c.json(fail("user.codeErrorFreq"));

  // generate code, store (real email/sms sending placeholder - configure later)
  const code = randomNumCode(6);
  await storeMsgCode(c, type, code, source, input);
  await checkMsgFreq(c, type, input, source, true);
  return c.json(ok({ send: true, code }));
});

// uploadBindaryCheck - returns [ok]/[error]
accountApi.all("/view/uploadBindaryCheck", async (c) => {
  const raw = await c.req.text().catch(() => "");
  return c.body(raw.trim() === "[uploadCheck]" ? "[ok]" : "[error]", 200, { "Content-Type": "text/plain" });
});

// qrcode - redirect to third-party QR generator
accountApi.get("/view/qrcode", async (c) => {
  const url = c.req.query("url") || "";
  if (!url) return c.json(fail("common.invalid"));
  return c.redirect("https://api.pwmqr.com/qrcode/create/?url=" + encodeURIComponent(url));
});

// pluginDesc - plugin readme (simplified)
accountApi.get("/view/pluginDesc", async (c) => {
  const callback = c.req.query("callback") || "";
  if (!/^[0-9a-zA-Z_.]+$/.test(callback)) return c.body("calllback error!");
  return c.body(`${callback}("${btoa("")}")`, 200, { "Content-Type": "application/javascript" });
});

// ============ user/bind - sendMsg ============

// sendMsg - bind email/phone verification code (个人设置绑定)
accountApi.post("/bind/sendMsg", authRequired, async (c) => {
  const user = c.get("currentUser");
  const body = await parseBody(c);
  const type = body.type;
  const input = (body.input || "").trim();
  const checkCode = body.checkCode || "";

  if (type !== "email" && type !== "phone") return c.json(fail("common.invalid"));
  if (!input || !checkInputFormat(type, input)) {
    const text = type + (type === "phone" ? "Number" : "");
    return c.json(fail("common.invalid" + "common." + text));
  }

  const cap = await checkImgCode(c, checkCode);
  if (!cap.ok) return c.json(fail(cap.msg, false, "10011"));

  // already bound to self
  if (type === "email" && user.email === input) return c.json(fail("common." + type + "user.binded"));
  if (type === "phone" && user.phone === input) return c.json(fail("common." + type + "user.binded"));
  // bound to another user
  const other = await userSearch(c.env.DB, { [type]: input }, "name,nickName");
  if (other) {
    const text = type === "phone" ? "ERROR_USER_EXIST_PHONE" : "ERROR_USER_EXIST_EMAIL";
    return c.json(fail(text + "."));
  }

  const freqOk = await checkMsgFreq(c, type, input, "bind");
  if (!freqOk) return c.json(fail("user.codeErrorFreq"));

  const code = randomNumCode(6);
  await storeMsgCode(c, type, code, "setting", input);
  await checkMsgFreq(c, type, input, "bind", true);
  return c.json(ok({ send: true, code }));
});

// ============ user/setting ============

// setConfig - save user options (key/value, comma-separated multi)
accountApi.post("/setting/setConfig", authRequired, async (c) => {
  const user = c.get("currentUser");
  const body = await parseBody(c);
  const keyStr = body.key || "";
  const valueStr = body.value || "";
  const keys = keyStr.split(",").map((s) => s.trim()).filter(Boolean);
  const values = valueStr.split(",");
  if (keys.length === 0) return c.json(fail("common.invalid"));

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = values[i] !== undefined ? values[i] : "";
    await setUserOption(c.env.DB, user.id, k, v);
  }
  return c.json(ok("explorer.settingSuccess"));
});

// setUserInfo - change nickName/email/phone/password
accountApi.post("/setting/setUserInfo", authRequired, async (c) => {
  const user = c.get("currentUser");
  const body = await parseBody(c);
  const type = body.type || "";
  const limit = ["nickName", "email", "phone", "password"];
  if (!limit.includes(type)) return c.json(fail("common.invalid"));

  let input = "";
  if (type !== "password") {
    input = (body.input || "").trim();
    try { input = decodeURIComponent(input); } catch { /* keep raw */ }
    input = input.replace(/<[^>]*>/g, "").trim();
  }

  if (type === "email" || type === "phone") {
    // verify message code (default 000 when not set)
    const msgCode = body.msgCode || "000";
    if (input === (type === "email" ? user.email : user.phone)) {
      return c.json(fail("common." + type + "user.binded"));
    }
    // check not used by another user
    const other = await userSearch(c.env.DB, { [type]: input }, "name,nickName");
    if (other) return c.json(fail("common." + type + "common.error"));
    const check = await checkMsgCode(c, type, msgCode, "setting", input);
    if (!check.ok) return c.json(fail(check.msg));
  }

  if (type === "password") {
    const newpwd = body.newpwd || "";
    const oldpwd = body.oldpwd || "";
    const plainNew = parseKodPassword(newpwd, "1");
    const plainOld = parseKodPassword(oldpwd, "1");
    if (!plainNew) return c.json(fail("user.oldPwdError"));
    // verify old password
    const row = await getUserById(c.env.DB, user.id);
    if (!row) return c.json(fail("explorer.error"));
    const oldValid = await verifyPassword(plainOld, row.password_hash as string);
    if (!oldValid) return c.json(fail("user.oldPwdError"));
    const newHash = await hashPassword(plainNew);
    await userEdit(c.env.DB, user.id, { password_hash: newHash });
    await addAuditLog(c.env.DB, "user.setUserInfo", user.id, null, null, null, "change password");
    const info = await buildUserInfo(c, user.id);
    return c.json(ok("explorer.success", info));
  }

  // nickName/email/phone
  if (type === "nickName" && !input) return c.json(fail("user.nickNameError"));
  await userEdit(c.env.DB, user.id, { [type === "nickName" ? "nickName" : type]: input });
  await addAuditLog(c.env.DB, "user.setUserInfo", user.id, null, null, null, `set ${type}`);
  const info = await buildUserInfo(c, user.id);
  return c.json(ok("explorer.success", info));
});

// changePassword - reset password requires bound email/phone
accountApi.post("/setting/changePassword", authRequired, async (c) => {
  const user = c.get("currentUser");
  if (!user.email && !user.phone) {
    return c.json(fail("请先绑定邮箱或手机号!"));
  }
  return c.json(ok(""));
});

// findPassword - step1 check & get token / step2 reset
// Registered on both /setting/findPassword (登录态) and /index/findPassword (找回密码两步)
async function findPasswordHandler(c: any) {
  const body = await parseBody(c);
  const token = body.token || "";

  if (!token) {
    // step1: verify account + msgCode, return token
    const type = body.type || "";
    const input = (body.input || "").trim();
    const msgCode = body.msgCode || "";
    if ((type !== "phone" && type !== "email") || !input || !msgCode) {
      return c.json(fail("common.invalid"));
    }
    const res = await userSearch(c.env.DB, { [type]: input }, "userID");
    if (!res) return c.json(fail("user.notBind"));
    const check = await checkMsgCode(c, type, msgCode, "findpwd", input);
    if (!check.ok) return c.json(fail(check.msg));

    const uid = (res as any).id ?? (res as any).userID;
    const tokenData = {
      type, input, userID: uid, time: Math.floor(Date.now() / 1000),
    };
    const pass = md5("findpwd_" + [type, input, uid, tokenData.time].join("_"));
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO verify_code (code_key, type, code, cnt, time) VALUES (?, 'findpwd', ?, 0, ?)"
    ).bind(`findpwd_${pass}`, JSON.stringify(tokenData), tokenData.time).run();
    return c.json(ok(pass));
  }

  // step2: reset password
  const password = body.password || "";
  const plainPassword = parseKodPassword(password, body.salt === "1" ? "1" : "");
  if (!plainPassword) return c.json(fail("user.pwdNotNull"));
  const row = (await c.env.DB.prepare("SELECT code, time FROM verify_code WHERE code_key = ? AND type = 'findpwd'").bind(`findpwd_${token}`).first()) as { code: string; time: number } | null;
  if (!row) return c.json(fail("common.errorExpiredRequest"));
  let cache: any = null;
  try { cache = JSON.parse(row.code); } catch { /* invalid */ }
  if (!cache || !cache.type || !cache.input || !cache.userID || !cache.time) {
    return c.json(fail("common.illegalRequest"));
  }
  if (cache.time < Math.floor(Date.now() / 1000) - 60 * 10) {
    return c.json(fail("common.expiredRequest"));
  }
  const res = await userSearch(c.env.DB, { [cache.type]: cache.input }, "userID");
  const resId = (res as any)?.id ?? (res as any)?.userID;
  if (!res || String(resId) !== String(cache.userID)) {
    return c.json(fail("common.illegalRequest"));
  }
  await c.env.DB.prepare("DELETE FROM verify_code WHERE code_key = ?").bind(`findpwd_${token}`).run();
  const newHash = await hashPassword(plainPassword);
  await userEdit(c.env.DB, resId as number, { password_hash: newHash });
  await addAuditLog(c.env.DB, "user.findPassword", resId as number, null, null, null, "reset password");
  return c.json(ok("explorer.success"));
}

accountApi.post("/setting/findPassword", findPasswordHandler);
accountApi.post("/index/findPassword", findPasswordHandler);

// setHeadImage - set avatar from uploaded link
accountApi.post("/setting/setHeadImage", authRequired, async (c) => {
  const user = c.get("currentUser");
  const body = await parseBody(c);
  const link = (body.link || "").trim();
  const appHost = getAppHost(c);
  if (!link) return c.json(fail("common.illegalRequest"));
  let avatar = link;
  if (link.startsWith(appHost)) {
    avatar = link.replace(appHost, "./");
  } else if (!link.startsWith("./")) {
    return c.json(fail("common.illegalRequest"));
  }
  await userEdit(c.env.DB, user.id, { avatar });
  await addAuditLog(c.env.DB, "user.setHeadImage", user.id, null, null, null, avatar);
  const info = await buildUserInfo(c, user.id);
  return c.json(ok(link, info));
});

// uploadHeadImage - upload avatar image to R2 (webuploader binary form)
accountApi.post("/setting/uploadHeadImage", authRequired, async (c) => {
  const user = c.get("currentUser");
  const formData = await c.req.formData().catch(() => null);
  if (!formData) return c.json(fail("only support image"));
  const file = formData.get("file") as File | null;
  if (!file) return c.json(fail("only support image"));

  const ext = (file.name || "").split(".").pop()?.toLowerCase() || "webp";
  if (!["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"].includes(ext)) {
    return c.json(fail("only support image"));
  }
  try {
    const key = getUserFileKey(user.username, `.system/avatar/avata-${user.id}.${ext}`);
    await c.env.FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || getFileMimeType(file.name) } });
    const appHost = getAppHost(c);
    const downloadPath = `${appHost}explorer/fileProxy?path=${encodeURIComponent(`.system/avatar/avata-${user.id}.${ext}`)}`;
    await addAuditLog(c.env.DB, "user.uploadHeadImage", user.id, null, null, null, key);
    // Frontend expects {code:true, info:{downloadPath}} (uploadViewEvent itemUploadSuccess passes serverData.info to the callback)
    return c.json({ code: true, info: { downloadPath } });
  } catch (err: any) {
    return c.json(fail(err.message));
  }
});

// userChart - personal space usage statistics
accountApi.post("/setting/userChart", authRequired, async (c) => {
  const user = c.get("currentUser");
  const row = await getUserById(c.env.DB, user.id);
  const sizeMax = row?.size_max || 0;
  const chart = {
    fileTypeAll: { title: "All", size: 0 },
    others: { title: "其他", size: 0 },
    fileType: {},
  };
  return c.json(ok(chart));
});

// userLog - personal operation logs
accountApi.post("/setting/userLog", authRequired, async (c) => {
  const user = c.get("currentUser");
  const body = await parseBody(c);
  const page = Math.max(1, parseInt(body.page || "1", 10) || 1);
  const pageNum = Math.max(1, parseInt(body.pageNum || "10", 10) || 10);
  const type = body.type || "";

  const logs = await getUserLogs(c.env.DB, user.id, page, pageNum, type === "user.index.loginSubmit" ? "user.index.loginSubmit" : undefined);
  // Frontend expects {list, pageInfo:{totalNum, pageNum, pageTotal, page}}
  return c.json(ok(logs.list, {
    totalNum: logs.total, pageNum, pageTotal: Math.ceil(logs.total / pageNum), page,
  }));
});

// userDevice - login devices (last 3 months)
accountApi.post("/setting/userDevice", authRequired, async (c) => {
  const user = c.get("currentUser");
  const fromTime = Math.floor(Date.now() / 1000) - 3600 * 24 * 30 * 3;
  const list = await getDeviceList(c.env.DB, user.id, fromTime);
  return c.json(ok(list, {
    totalNum: list.length, pageNum: list.length, pageTotal: Math.max(1, Math.ceil(list.length / Math.max(1, list.length))), page: 1,
  }));
});

// userLoginList - online devices of current account
accountApi.post("/setting/userLoginList", authRequired, async (c) => {
  const user = c.get("currentUser");
  const selfSign = await getSelfSessionSign(c);
  const list = await buildLoginList(c, user.id);
  for (const item of list) {
    if (item.sign === selfSign) item.isSelf = true;
  }
  return c.json(ok(list));
});

// userLogoutSet - kick a device offline
accountApi.post("/setting/userLogoutSet", authRequired, async (c) => {
  const user = c.get("currentUser");
  const body = await parseBody(c);
  const sign = body.sign || "";
  if (!sign) return c.json(fail("common.invalid"));
  const selfSign = await getSelfSessionSign(c);
  if (sign === selfSign) return c.json(fail("common.invalid"));
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?").bind(sign, user.id).run();
  return c.json(ok("explorer.success"));
});

// notice - system notices (simplified)
accountApi.post("/setting/notice", async (c) => {
  const body = await parseBody(c);
  const action = body.action || "get";
  if (action === "get") {
    return c.json(ok({ list: [] }));
  }
  return c.json(ok("explorer.success"));
});

// ============ user/regist ============

// regist - register a new user
accountApi.post("/regist/regist", async (c) => {
  const body = await parseBody(c);
  const type = body.type || "";
  const input = (body.input || "").trim();
  const name = body.name || input;
  const nickName = (body.nickName || "").trim();
  const password = body.password || "";
  const msgCode = body.msgCode || "";

  const regist = await getRegistConfig(c.env.DB);
  if (regist.openRegist !== "1") return c.json(fail("user.registNotAllow"));

  if ((type !== "email" && type !== "phone") || !input) {
    return c.json(fail("common.invalid"));
  }
  if (!checkInputFormat(type, input)) {
    const text = type + (type === "phone" ? "Number" : "");
    return c.json(fail("common.invalid" + "common." + text));
  }
  if (!msgCode) return c.json(fail("user.inputVerifyCode"));

  const check = await checkMsgCode(c, type, msgCode, "regist", input);
  if (!check.ok) return c.json(fail(check.msg));

  const plainPassword = parseKodPassword(password, body.salt === "1" ? "1" : "");
  if (!plainPassword || plainPassword.length < 6) return c.json(fail("user.pwdError"));

  // duplicate check
  const dupName = await getUserByUsername(c.env.DB, name);
  if (dupName) return c.json(fail("user.nameExists"));
  const dupBind = await userSearch(c.env.DB, { [type]: input }, "userID");
  if (dupBind) return c.json(fail("common." + type + "common.error"));

  const passwordHash = await hashPassword(plainPassword);
  const result = await c.env.DB.prepare(
    `INSERT INTO users (username, password_hash, nickname, email, phone, role, status, size_max)
     VALUES (?, ?, ?, ?, ?, 'user', ?, ?)`
  ).bind(
    name,
    passwordHash,
    nickName || name,
    type === "email" ? input : "",
    type === "phone" ? input : "",
    regist.checkRegist === "1" ? 0 : 1,
    parseFloat(regist.sizeMax) || 0
  ).run();

  const meta = result.meta as any;
  const userID = meta?.last_row_id ?? 0;
  await addAuditLog(c.env.DB, "user.regist", userID, null, null, null, `regist by ${type}`);
  await userDefaultInit(c.env.DB, c.env.FILES, userID, name);
  let groupInfo: Record<string, any> = {};
  try {
    groupInfo = JSON.parse(regist.groupInfo || "{}");
  } catch { /* ignore */ }
  const hasValidAuth = Object.values(groupInfo).some((a) => {
    const ra = a && typeof a === "object" && "authID" in a ? a.authID : a;
    return parseInt(String(ra ?? 0), 10) > 0;
  });
  const target = hasValidAuth ? groupInfo : { "1": 3 };
  for (const [gid, auth] of Object.entries(target)) {
    const groupID = parseInt(gid, 10);
    if (!groupID) continue;
    const rawAuth = auth && typeof auth === "object" && "authID" in auth ? auth.authID : auth;
    const authID = parseInt(String(rawAuth ?? 0), 10) || 0;
    await c.env.DB.prepare(
      "INSERT INTO user_groups (user_id, group_id, authID, sort) VALUES (?, ?, ?, 0)"
    ).bind(userID, groupID, authID).run();
  }
  const code = regist.checkRegist === "1" ? false : true;
  const msg = regist.checkRegist === "1" ? "user.registSuccessuser.waitCheck" : "user.registSuccess";
  return c.json({ code, data: msg, info: userID });
});

export { accountApi };
