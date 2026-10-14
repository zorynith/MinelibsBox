/**
 * CSRF 防护 - 复刻 001 app/controller/filter/post.class.php
 *
 * 001 机制:
 *  - csrfProtect != '1' 时不校验;
 *  - UA 含 kodbox/okhttp/kodcloud 时跳过 (APP/PC 客户端);
 *  - plugin 模块跳过 (插件内部自行处理);
 *  - fileupload / explorer.shareout 走 CORS 直传逻辑 (webdav-kodbox 客户端跳过);
 *  - allowGetArr 白名单 (按 MOD.ST + ACT, 或 MOD 为 * );
 *  - authNotNeedLogin 通配白名单 (MOD.* / MOD.ST.* / 精确 action);
 *  - 最终校验 in.CSRF_TOKEN 与 Cookie CSRF_TOKEN 一致, 带 accessToken 时跳过;
 *  - 失败删除 CSRF_TOKEN cookie 并返回 show_json('CSRF_TOKEN error!', false)。
 *
 * CSRF_TOKEN cookie 由 001 user/index initSession 用 rand_string(16) 生成, 非 HttpOnly。
 */

import type { Context } from "hono";
import { getSetting } from "./db";

// 001 rand_string(16) 默认 charset (去掉了易混淆字符 oOLl 与数字 0/1)
const CSRF_CHARS = "ABCDEFGHIJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

export function randomCsrfToken(len = 16): string {
  let out = "";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) out += CSRF_CHARS[bytes[i] % CSRF_CHARS.length];
  return out;
}

export function readCsrfCookie(c: Context): string {
  const cookie = c.req.header("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)CSRF_TOKEN=([^;]*)/);
  return match ? match[1] : "";
}

export function setCsrfCookie(c: Context, token: string) {
  c.header("Set-Cookie", `CSRF_TOKEN=${token}; Path=/; SameSite=Lax`, { append: true });
}

export function clearCsrfCookie(c: Context) {
  c.header("Set-Cookie", "CSRF_TOKEN=; Path=/; Max-Age=0; SameSite=Lax", { append: true });
}

/** 001 allowGetArr: MOD.ST => ACT 列表 (小写), '*' 代表全部 */
const ALLOW_GET: Record<string, string> = {
  "explorer.fileview": "index",
  "explorer.history": "fileout",
  "explorer.index": "fileout,filedownload,fileoutby,filedownloadremove",
  "explorer.share": "fileout,filedownload,fileoutby,zipdownload,filedownloadremove,file",
  "admin.setting": "get,server",
  "admin.repair": "*",
  "install.index": "*",
  "user.index": "index,autologin,loginsubmit,logout",
  "user.view": "*",
  "user.sso": "*",
  "test": "*",
  "sitemap": "*",
};

/** 001 authNotNeedLogin: user.* / user.index.* / 精确 action (小写) */
const AUTH_NOT_NEED_LOGIN: string[] = [
  "user.index.*",
  "user.bind.*",
  "user.sso.*",
  "user.regist.*",
  "user.view.*",
  "explorer.share.*",
  "explorer.shareout.*",
  "sitemap.*",
  "install.*",
  "plugin.*",
  "comment.index.listdata",
  "comment.index.listchildren",
  "comment.index.test",
];

interface ResolvedAction {
  mod: string;
  st: string;
  act: string;
  action: string;
}

/**
 * 从 Worker 请求路径解析 001 的 MOD/ST/ACT。
 * Worker 用独立前缀 /seo、/shareOut 承载 001 的 explorer/seo、explorer/shareOut。
 */
function resolveAction(path: string): ResolvedAction {
  const clean = path.replace(/^\/+|\/+$/g, "");
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
  return { mod, st, act, action: `${mod}.${st}.${act}` };
}

/**
 * 读取请求体中的参数 (等价 001 $_POST)。为避免与大文件上传冲突,
 * multipart 仅在体积较小时解析 (上传场景 CSRF_TOKEN 走 query)。
 * 使用 raw.clone() 读取, 不影响后续 handler 读取原始 body。
 */
async function readBodyParams(c: Context): Promise<Record<string, string>> {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return {};
  const ct = (c.req.header("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/x-www-form-urlencoded")) {
      const fd = await c.req.raw.clone().formData();
      const out: Record<string, string> = {};
      for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : "";
      return out;
    }
    if (ct.includes("multipart/form-data")) {
      const len = parseInt(c.req.header("content-length") || "0", 10);
      if (len && len < 200000) {
        const fd = await c.req.raw.clone().formData();
        const out: Record<string, string> = {};
        for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : "";
        return out;
      }
      return {};
    }
    if (ct.includes("application/json")) {
      const txt = await c.req.raw.clone().text();
      const obj = JSON.parse(txt);
      if (obj && typeof obj === "object") {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj)) out[k] = v == null ? "" : String(v);
        return out;
      }
    }
  } catch {
    // 解析失败按无 body 处理
  }
  return {};
}

/**
 * CSRF 校验。返回 null 表示通过 (或无需校验);
 * 返回 "error" 表示 001 checkCsrfToken 校验失败 (调用方负责删除 cookie 并返回错误)。
 */
export async function csrfCheck(c: Context): Promise<"error" | null> {
  const csrfOn = String((await getSetting(c.env.DB, "csrfProtect")) ?? "1");
  if (csrfOn !== "1") return null;

  const ua = (c.req.header("user-agent") || "").toLowerCase();
  if (ua.includes("kodbox") || ua.includes("okhttp") || ua.includes("kodcloud")) return null;

  const { mod, st, act, action } = resolveAction(c.req.path);
  if (mod === "plugin") return null;

  const stMod = `${mod}.${st}`;

  // allowGetArr 白名单
  const methods = ALLOW_GET[stMod];
  if (methods !== undefined && (methods === "*" || methods.split(",").includes(act))) {
    return null;
  }

  // authNotNeedLogin 白名单
  for (const pattern of AUTH_NOT_NEED_LOGIN) {
    const item = pattern.split(".");
    if (item.length === 2 && item[0] === mod && item[1] === "*") return null;
    if (item.length === 3 && item[0] === mod && item[1] === st && item[2] === "*") return null;
  }
  if (AUTH_NOT_NEED_LOGIN.includes(action)) return null;

  const body = await readBodyParams(c);
  const param = (name: string) => (c.req.query(name) ?? "") || body[name] || "";

  // fileupload / explorer.shareout: webdav-kodbox 直传跳过 (CORS 由全局中间件处理)
  if (act === "fileupload" || stMod === "explorer.shareout") {
    if (param("clientFrom") === "webdav-kodbox") return null;
  }

  // checkCsrfToken
  if (param("accessToken")) return null;
  const token = param("CSRF_TOKEN");
  const cookieToken = readCsrfCookie(c);
  if (!token || token !== cookieToken) return "error";

  return null;
}
