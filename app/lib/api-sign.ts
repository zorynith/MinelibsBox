/**
 * API 签名工具 - 复刻 001 user/index 的 apiSignMake / apiSignCheck /
 * appKeySecret / accessToken / accessTokenCheck (app/controller/user/index.class.php)。
 *
 * 这些是 001 内部辅助方法 (通过 Action('user.index')->xxx() 调用, 非 HTTP action):
 * - 外部集成 (plugins/webdav、fileThumb、分享外链、编辑器刷新) 用 apiSignMake 生成
 *   带签名 actionToken/actionKey 的 URL;
 * - 框架在每次请求 init() 中调用 apiSignCheck(), 校验签名并临时以目标用户身份执行。
 *
 * Worker 端主认证仍以会话 id 为准 (见 app/lib/auth.ts 的 accessToken=会话 id 约定),
 * 本模块保留 001 的签名算法, 供需要相同签名的内部调用/插件使用。
 */
import { md5, mcryptEncode, mcryptDecode } from "./mcrypt";
import { getSetting } from "./db";

/** 001 helper.function.php: hash_encode — 把 base64 的 + / = 替换为 _a _b _c。 */
export function hashEncode(str: string): string {
  return str.replace(/\+/g, "_a").replace(/\//g, "_b").replace(/=/g, "_c");
}

/** 001 helper.function.php: hash_decode — hash_encode 的逆操作。 */
export function hashDecode(str: string): string {
  return str.replace(/_a/g, "+").replace(/_b/g, "/").replace(/_c/g, "=");
}

/** PHP base64_encode(原始字节) 的等价实现 (UTF-8 安全)。 */
function phpBase64Encode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** PHP rawurlencode 的等价实现 (空格 %20, 转义 ! ' ( ) * 等)。 */
function phpRawUrlEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
}

/** PHP http_build_query 的等价实现 (key=rawurlencode(value) 以 & 连接)。 */
export function httpBuildQuery(args: Record<string, unknown>): string {
  return Object.keys(args)
    .map((k) => `${k}=${phpRawUrlEncode(String(args[k] ?? ""))}`)
    .join("&");
}

/** 001 user/index::appKeySecret — 未传 appKey 时用 systemPassword 派生, 否则读 appKeySecret 配置。 */
export async function appKeySecret(db: D1Database, appKey = ""): Promise<string> {
  if (!appKey) {
    const systemPassword = (await getSetting(db, "systemPassword")) ?? "";
    return md5(systemPassword);
  }
  const raw = (await getSetting(db, "appKeySecret")) ?? "";
  try {
    const appList = JSON.parse(raw);
    const item = appList && typeof appList === "object" ? appList[appKey] : null;
    if (!item || typeof item !== "object") return "";
    return String((item as Record<string, unknown>).appSecret ?? "");
  } catch {
    return "";
  }
}

/** 001 user/index::accessToken — 用 systemPassword 派生密钥加密会话签名。 */
export async function makeAccessToken(db: D1Database, sessionSign: string): Promise<string> {
  const systemPassword = (await getSetting(db, "systemPassword")) ?? "";
  const pass = md5("kodbox_" + systemPassword).substring(0, 15);
  return mcryptEncode(sessionSign, pass, 3600 * 24 * 30);
}

/** 001 user/index::accessTokenCheck — 校验 accessToken 是否对应当前会话签名。 */
export async function checkAccessToken(db: D1Database, token: string, sessionSign: string): Promise<boolean> {
  if (!token || token.length > 500) return false;
  const systemPassword = (await getSetting(db, "systemPassword")) ?? "";
  const pass = md5("kodbox_" + systemPassword).substring(0, 15);
  const decoded = mcryptDecode(token, pass);
  return !!decoded && decoded === sessionSign;
}

export interface ApiSignOptions {
  /** 生成 URL 时使用的站点前缀 (APP_HOST)。 */
  appHost: string;
  /** 有效用户 id; 为空则退化为普通 URL。 */
  userID?: number | string;
  /** 应用 appKey (多应用密钥)。 */
  appKey?: string;
  /** true 时返回带 index.php 的 URL (跨域 OPTIONS 场景)。 */
  uriIndex?: boolean;
}

/**
 * 001 user/index::apiSignMake — 生成带 actionToken/actionKey 的签名 URL。
 * 无 appSecret 或未登录时退化为 `{appHost}index.php?{action}&{query}`。
 */
export async function apiSignMake(
  db: D1Database,
  action: string,
  args: Record<string, unknown>,
  opts: ApiSignOptions
): Promise<string> {
  const appSecret = await appKeySecret(db, opts.appKey);
  if (!appSecret || !opts.userID) {
    return opts.appHost + "index.php?" + action + "&" + httpBuildQuery(args);
  }

  const keyList = [action.toLowerCase()];
  const signArr = [action.toLowerCase(), appSecret];
  let param = "";
  for (const key of Object.keys(args)) {
    const val = String(args[key] ?? "");
    keyList.push(key.toLowerCase());
    signArr.push(key.toLowerCase() + "=" + phpBase64Encode(val));
    param += key + "=" + phpRawUrlEncode(val) + "&";
  }
  const signToken = md5(signArr.join(";"));
  const actionKey = hashEncode(keyList.join(";"));
  const actionToken = mcryptEncode(String(opts.userID), signToken, 0);
  // 001 用 Mcrypt::encode(userID, signToken, 0, md5(appSecret)); keyc 由密文自带, 解码端可还原,
  // 因此 worker 端同样以 mcryptEncode 输出即可自洽。
  param += "actionToken=" + actionToken + "&actionKey=" + actionKey;
  if (opts.uriIndex) return opts.appHost + "index.php?" + action + "&" + param;
  return opts.appHost + "index.php?" + action + "&" + param;
}

export interface ApiSignResult {
  userID: number;
  action: string;
  /** 签名覆盖的参数键 (小写)。 */
  keys: string[];
}

/**
 * 001 user/index::apiSignCheck — 解析并校验 actionToken/actionKey。
 * 校验通过返回 userID 与签名 action; 失败返回 null。
 * accessToken 优先: 携带 accessToken 时不走签名校验 (与 001 一致)。
 */
export async function apiSignCheck(
  db: D1Database,
  input: Record<string, unknown>,
  currentAction: string
): Promise<ApiSignResult | null> {
  if (input.accessToken) return null;
  const actionToken = String(input.actionToken ?? "");
  const actionKey = String(input.actionKey ?? "");
  const appKey = String(input.appKey ?? "");
  const appSecret = await appKeySecret(db, appKey);
  if (!actionToken || !actionKey || !appSecret) return null;
  if (actionToken.length > 500) return null;

  const action = currentAction.replace(/\./g, "/").toLowerCase();
  const keyList = hashDecode(actionKey).split(";");
  const signArr = [action, appSecret];
  if (keyList[0] !== action) return null;
  for (let i = 1; i < keyList.length; i++) {
    const key = keyList[i];
    signArr.push(key + "=" + phpBase64Encode(String(input[key] ?? "")));
  }
  const signToken = md5(signArr.join(";"));
  const userID = mcryptDecode(actionToken, signToken);
  if (!userID || !/^\d+$/.test(userID)) return null;
  return { userID: parseInt(userID, 10), action: currentAction, keys: keyList.slice(1) };
}
