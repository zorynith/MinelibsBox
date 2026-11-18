/**
 * API 签名 - 复刻 001 app/controller/user/index.class.php::apiSignMake / apiSignCheck
 *
 * 用于无 Cookie 场景(官方 APP / 第三方 / WebDAV / 插件)携带签名访问接口:
 *   index.php?explorer/index/fileOut&path=xxx&actionToken=<mcrypt>&actionKey=<hash>
 *
 * 签名规则(001):
 *   appSecret  = appKey ? systemOption.appKeySecret[appKey].appSecret : md5(systemPassword)
 *   keyList    = [strtolower(action), ...strtolower(参数名)]
 *   signArr    = [strtolower(action), appSecret, "参数名=base64(参数值)" ...]
 *   signToken  = md5(implode(';', signArr))
 *   actionToken= Mcrypt::encode(userID, signToken)     // 解密时校验 signToken
 *   actionKey  = hash_encode(implode(';', keyList))    // base64 后 + / = 替换为 _a _b _c
 *
 * 校验通过后以该 userID 建立临时身份(不写 Cookie、不影响已登录会话)。
 */
import type { Context } from "hono";
import { getSetting, getUserById } from "./db";
import { md5 } from "./mcrypt";
import { mcryptDecode, mcryptEncode } from "./mcrypt";
import type { AuthUser } from "./auth";
import { getAppHost } from "./user-system";

/** 001 hash_encode */
export function hashEncode(str: string): string {
  return b64Utf8(str).replace(/\+/g, "_a").replace(/\//g, "_b").replace(/=/g, "_c");
}

/** 001 hash_decode */
export function hashDecode(str: string): string {
  const b64 = (str || "").replace(/_a/g, "+").replace(/_b/g, "/").replace(/_c/g, "=");
  return utf8FromB64(b64);
}

function b64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function utf8FromB64(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/** PHP base64_encode(原始字节) */
function phpBase64(str: string): string {
  return b64Utf8(str);
}

/**
 * 001 appKeySecret: 未指定 appKey 时使用 md5(systemPassword);
 * 指定时从系统配置 appKeySecret 中读取 [appKey].appSecret。
 */
export async function appKeySecret(db: D1Database, appKey = ""): Promise<string> {
  if (!appKey) {
    const systemPassword = String((await getSetting(db, "systemPassword", true)) ?? "");
    return md5(systemPassword);
  }
  const raw = await getSetting(db, "appKeySecret", true);
  if (!raw) return "";
  try {
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    const item = list && typeof list === "object" ? (list as any)[appKey] : null;
    return item && typeof item === "object" ? String(item.appSecret ?? "") : "";
  } catch {
    return "";
  }
}

/** PHP rawurlencode (空格 %20, 转义 ! ' ( ) * 等) */
export function phpRawUrlEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
}

/** PHP http_build_query (key=rawurlencode(value) 以 & 连接) */
export function httpBuildQuery(args: Record<string, unknown>): string {
  return Object.keys(args)
    .map((k) => `${k}=${phpRawUrlEncode(String(args[k] ?? ""))}`)
    .join("&");
}

/** 001 user/index::accessToken — 用 systemPassword 派生密钥加密会话签名。 */
export async function makeAccessToken(db: D1Database, sessionSign: string): Promise<string> {
  const systemPassword = (await getSetting(db, "systemPassword", true)) ?? "";
  const pass = md5("kodbox_" + systemPassword).substring(0, 15);
  return mcryptEncode(sessionSign, pass, 3600 * 24 * 30);
}

/** 001 user/index::accessTokenCheck — 校验 accessToken 是否对应当前会话签名。 */
export async function checkAccessToken(db: D1Database, token: string, sessionSign: string): Promise<boolean> {
  if (!token || token.length > 500) return false;
  const systemPassword = (await getSetting(db, "systemPassword", true)) ?? "";
  const pass = md5("kodbox_" + systemPassword).substring(0, 15);
  const decoded = mcryptDecode(token, pass);
  return !!decoded && decoded === sessionSign;
}

/** 生成 actionToken/actionKey 查询串 (001 签名核心) */
function signQuery(action: string, args: Record<string, string | number>, appSecret: string, userID: number | string): string {
  const keyList = [action.toLowerCase()];
  const signArr = [action.toLowerCase(), appSecret];
  let param = "";
  for (const [key, val] of Object.entries(args)) {
    const value = String(val);
    keyList.push(key.toLowerCase());
    signArr.push(key.toLowerCase() + "=" + phpBase64(value));
    param += key + "=" + phpRawUrlEncode(value) + "&";
  }
  const signToken = md5(signArr.join(";"));
  const actionToken = mcryptEncode(String(userID), signToken, 0);
  const actionKey = hashEncode(keyList.join(";"));
  return param + "actionToken=" + actionToken + "&actionKey=" + actionKey;
}

export interface ApiSignOptions {
  appKey?: string;
  /** 001 第 5 个参数: 强制使用 index.php? 形式(跨域 options 请求) */
  uriIndex?: boolean;
  /** 兼容旧签名: 直接指定站点前缀 (不传则取自当前请求) */
  appHost?: string;
  /** 兼容旧签名: 用户 id */
  userID?: number | string;
}

/**
 * 不持有请求上下文时的签名 URL 生成 (与 apiSignMake(c,...) 等价)。
 * 001 中 plugins/webdav、fileThumb 等在非 action 上下文调用 apiSignMake。
 */
export async function apiSignUrl(
  db: D1Database,
  action: string,
  args: Record<string, string | number>,
  opts: ApiSignOptions & { appHost: string }
): Promise<string> {
  const appSecret = await appKeySecret(db, opts.appKey || "");
  const host = opts.appHost.endsWith("/") ? opts.appHost : opts.appHost + "/";
  if (!appSecret || !opts.userID) {
    return host + "index.php?" + action + "&" + httpBuildQuery(args);
  }
  return host + "index.php?" + action + "&" + signQuery(action, args, appSecret, opts.userID);
}

/**
 * 001 apiSignMake: 生成带签名的接口 URL。
 * 未登录或无 appSecret 时返回普通 URL (001 语义)。
 */
export async function apiSignMake(
  c: Context,
  action: string,
  args: Record<string, string | number>,
  userID: number,
  options: ApiSignOptions = {},
): Promise<string> {
  const db = c.env.DB;
  const appSecret = await appKeySecret(db, options.appKey || "");
  const host = options.appHost || getAppHost(c) || "/";
  const base = host.endsWith("/") ? host : host + "/";
  const uid = options.userID ?? userID;
  if (!appSecret || !uid) {
    return `${base}index.php?${action}&${httpBuildQuery(args)}`;
  }
  return `${base}index.php?${action}&${signQuery(action, args, appSecret, uid)}`;
}

/** 读取 query + body 参数 (等价 001 $this->in) */
async function readParams(c: Context): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) out[k] = v;
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return out;
  const ct = (c.req.header("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const fd = await c.req.raw.clone().formData();
      for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : "";
    } else if (ct.includes("application/json")) {
      const txt = await c.req.raw.clone().text();
      const obj = JSON.parse(txt);
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) out[k] = v == null ? "" : String(v);
      }
    }
  } catch {
    // 忽略 body 解析异常
  }
  return out;
}

/** 由请求路径解析 001 的 action (mod/st/act, 与签名一致的小写形式) */
function actionOf(c: Context): string {
  const clean = c.req.path.replace(/^\/+|\/+$/g, "");
  let segs = clean.split("/");
  if (segs[0] === "api") segs = segs.slice(1);
  let mod = (segs[0] || "").toLowerCase();
  let st = (segs[1] || "").toLowerCase();
  const act = (segs[2] || "").toLowerCase();
  if (mod === "seo") {
    mod = "explorer";
    st = "seo";
  } else if (mod === "shareout") {
    mod = "explorer";
    st = "shareout";
  }
  return `${mod}/${st}/${act}`;
}

export interface ApiSignResult {
  user?: AuthUser;
  error?: string;
  /** 是否检测到签名参数(用于 CORS / 免 CSRF 判断) */
  signed: boolean;
}

/**
 * 001 apiSignCheck: 校验签名并以该用户身份执行本次请求。
 * 带 accessToken 时优先使用 accessToken(001 语义), 不处理签名。
 */
export async function apiSignCheck(c: Context): Promise<ApiSignResult> {
  // 先只看 query, 避免对普通(含大文件上传)请求解析 body
  const query = c.req.query();
  if (query.accessToken) return { signed: false };

  let params: Record<string, string> = query;
  if (!query.actionToken || !query.actionKey) {
    const method = c.req.method.toUpperCase();
    if (method === "GET" || method === "HEAD") return { signed: false };
    const len = parseInt(c.req.header("content-length") || "0", 10);
    if (len > 200000) return { signed: false };
    params = await readParams(c);
  }

  const actionToken = params.actionToken || "";
  const actionKey = params.actionKey || "";
  const appKey = params.appKey || "";
  if (!actionToken || !actionKey) return { signed: false };
  if (actionToken.length > 500) return { signed: false };

  const appSecret = await appKeySecret(c.env.DB, appKey);
  if (!appSecret) return { signed: false };

  const action = actionOf(c);
  const keyList = hashDecode(actionKey).split(";");
  const signArr = [action, appSecret];
  if (keyList[0] !== action) return { signed: true, error: "" };

  for (let i = 1; i < keyList.length; i++) {
    const key = keyList[i];
    signArr.push(key.toLowerCase() + "=" + phpBase64(params[key] ?? ""));
  }
  const signToken = md5(signArr.join(";"));
  const userID = parseInt(mcryptDecode(actionToken, signToken), 10) || 0;
  if (!userID) return { signed: true, error: "explorer.systemError.[apiSignCheck]" };

  // 当前为自己时沿用当前 session (001)
  const current = c.get("currentUser") as AuthUser | undefined;
  if (current && current.id === userID) return { signed: true, user: current };

  const row = await getUserById(c.env.DB, userID);
  if (!row) return { signed: true, error: "explorer.systemError.[apiSignCheck]" };
  const user: AuthUser = {
    id: Number(row.id),
    username: String(row.username ?? ""),
    nickname: String(row.nickname ?? row.username ?? ""),
    email: String(row.email ?? ""),
    phone: String(row.phone ?? ""),
    avatar: String(row.avatar ?? ""),
    sex: Number(row.sex ?? 1) || 1,
    role: String(row.role ?? "user"),
    status: Number(row.status ?? 1) || 1,
    config_json: String(row.config_json ?? "{}"),
  };
  return { signed: true, user };
}

/**
 * 001 apiSignCheck 的纯参数版本: 仅解析/校验签名, 不注入身份。
 * 供插件、WebDAV 等需要自行判断调用方的场景使用。
 */
export async function apiSignParse(
  db: D1Database,
  input: Record<string, unknown>,
  currentAction: string,
): Promise<{ userID: number; action: string; keys: string[] } | null> {
  if (input.accessToken) return null;
  const actionToken = String(input.actionToken ?? "");
  const actionKey = String(input.actionKey ?? "");
  const appKey = String(input.appKey ?? "");
  if (!actionToken || !actionKey) return null;
  if (actionToken.length > 500) return null;

  const appSecret = await appKeySecret(db, appKey);
  if (!appSecret) return null;

  const action = currentAction.replace(/\./g, "/").toLowerCase();
  const keyList = hashDecode(actionKey).split(";");
  if (keyList[0] !== action) return null;

  const signArr = [action, appSecret];
  for (let i = 1; i < keyList.length; i++) {
    signArr.push(keyList[i].toLowerCase() + "=" + phpBase64(String(input[keyList[i]] ?? "")));
  }
  const userID = parseInt(mcryptDecode(actionToken, md5(signArr.join(";"))), 10) || 0;
  if (!userID) return null;
  return { userID, action: currentAction, keys: keyList.slice(1) };
}
