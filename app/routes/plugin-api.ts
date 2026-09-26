/**
 * Plugin API - renders plugin viewer pages (pdfjs / officeViewer).
 *
 * The 003 SPA registers a plugin via core.openFile('{{pluginApi}}', ...) which
 * builds `/index.php?plugin/{name}/&path=..&name=..&ext=..`. The worker rewrite
 * turns that into `/api/plugin/{name}/`, so we render the viewer HTML here.
 *
 * Both viewers fetch the raw file through the authenticated `explorer/index/fileOut`
 * endpoint (same origin, session cookie), so the rendered page just needs the
 * file URL, file name and the correct static asset base paths.
 */
import { Hono } from "hono";
import { authRequired, getSessionId, verifyPassword } from "../lib/auth";
import type { AuthUser } from "../lib/auth";
import { getAppHost, getStaticHost } from "../lib/user-system";
import { detectLang, loadLangPack } from "../lib/i18n-lang";
import { loadPluginLang } from "../lib/plugins";
import { getFileMimeType, getUserFileKey, keyFromBase } from "../lib/r2";
import { getShareByHash } from "../lib/share";
import { getPluginMeta, getUserById, setPluginConfig, getUserByUsername } from "../lib/db";
import { md5, hmacMd5, mcryptEncode, mcryptDecode } from "../lib/mcrypt";
import { resolveFileSource } from "../lib/source";
import type { SourceRef } from "../lib/source";
import { AUTH_DOWNLOAD, AUTH_EDIT, AUTH_VIEW, getGroupAuthValue, getPersonalAuthValue, hasAuth } from "../lib/source-auth";
import { ioClientOf } from "../lib/io";
import type { IoClient } from "../lib/io";
import { parseShareLinkRel, joinShareRealPath } from "./share-api";

type Vars = { currentUser: AuthUser };
const pluginApi = new Hono<{ Bindings: Env; Variables: Vars }>();

// OnlyOffice 的文件下载/保存回调由 Document Server 匿名调用(无会话 cookie), 独立放行;
// 分享落地页(guest)打开 PDF/Office 等文件时, 插件预览页面也需要公开访问;
// 其余场景(主应用登录态)仍要求登录。
pluginApi.use("*", async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  const segs = pathname.split("/").filter(Boolean);
  const pname = segs[segs.length - 2];
  const pact = segs[segs.length - 1];
  if (pname === "OnlyOffice" && (pact === "file" || pact === "save")) return next();
  // 通用匿名文件流端点(001 filePathLinkOut): 外部服务/前端无会话 cookie, 用 fileView apiKey 签名
  if (pact === "fileOut") return next();
  // PDFTron 保存回调: WebViewer 在 static 域 iframe 内无会话 cookie, 用 fileView token 签名认证
  if (pname === "PDFTron" && pact === "save" && c.req.query("token")) return next();
  // Photopea 只读模式(分享 guest)的 saveImg 探活回调: 无 cookie, 应放行让 handler 返回 Unwritable;
  // 可写模式: static 域 iframe 无会话 cookie, 用 fileView token 签名认证
  if (pname === "Photopea" && pact === "saveImg" && (c.req.query("unwritable") || c.req.query("token"))) return next();
  // oauth 第三方登录回调: 第三方服务重定向回来无会话 cookie, 放行让前端 index.html 处理
  if (pname === "oauth" && pact === "callback") return next();
  const rawPath = c.req.query("path") || "";
  if (rawPath.indexOf("{shareItemLink:") === 0) return next();
  return authRequired(c, next);
});

// ---------- helpers ----------

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape for a single-quoted JS string literal. */
function jsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "");
}

/** Load a raw template file from the static ASSETS binding. */
async function loadTemplate(assets: Fetcher, path: string): Promise<string | null> {
  try {
    const res = await assets.fetch(new Request(`https://assets.local/${path}`));
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function replaceAll(tpl: string, pairs: Array<[string, string]>): string {
  let out = tpl;
  for (const [k, v] of pairs) out = out.split(k).join(v);
  return out;
}

/** Build the file content URL used by pdf.js / weboffice fetch. */
function fileOutUrl(appHost: string, rawPath: string): string {
  const m = rawPath.match(/\{shareItemLink:([-\w]+)\}/);
  if (m) {
    // 分享落地页 guest 场景: 走公开的 share/fileOut, 无需登录。
    return `${appHost}index.php?explorer/share/fileOut&shareID=${encodeURIComponent(m[1])}&path=${encodeURIComponent(rawPath)}`;
  }
  return `${appHost}index.php?explorer/index/fileOut&path=${encodeURIComponent(rawPath)}`;
}

/** 浏览器同源请求用的根相对文件流 URL。线上 preview 转发时 appHost(X-Forwarded-Host)
 *  可能与浏览器地址栏域名不一致, 绝对 URL 会跨源 fetch 丢失 cookie 导致 401;
 *  根相对路径跟随当前 origin, 天然同源带 cookie。仅限浏览器同源场景
 *  (PDFTron initialDoc / Photopea fileUrl / drawio 等), 外部服务抓取仍用 fileOutUrl。 */
function fileOutRel(rawPath: string): string {
  const m = rawPath.match(/\{shareItemLink:([-\w]+)\}/);
  if (m) {
    return `/index.php?explorer/share/fileOut&shareID=${encodeURIComponent(m[1])}&path=${encodeURIComponent(rawPath)}`;
  }
  return `/index.php?explorer/index/fileOut&path=${encodeURIComponent(rawPath)}`;
}

/** 分享路径解析分享者真实 R2 key（仅文件）；非分享路径或目录返回 null。 */
async function shareFileKeyOf(env: Env, rawPath: string): Promise<string | null> {
  const m = rawPath.match(/\{shareItemLink:([-\w]+)\}/);
  if (!m) return null;
  const share = await getShareByHash(env.DB, m[1]);
  if (!share) return null;
  const rel = parseShareLinkRel(share, rawPath);
  if (rel === null || rel.endsWith("/")) return null;
  const owner = (await getUserById(env.DB, share.userID)) as { username: string } | null;
  if (!owner) return null;
  return getUserFileKey(owner.username, joinShareRealPath(share.sourcePath, rel));
}

/** 解析插件预览目标文件 R2 key：分享路径走分享者，普通路径走登录用户。 */
async function resolveFileKey(c: any, rawPath: string): Promise<string | null> {
  if (rawPath.indexOf("{shareItemLink:") === 0) {
    return shareFileKeyOf(c.env, rawPath);
  }
  const user = c.get("currentUser") as { username: string } | undefined;
  return user ? getUserFileKey(user.username, realPathOf(rawPath)) : null;
}

/** Resolve a frontend virtual path (e.g. {source:home}/桌面/) to its real R2 path (/桌面/). */
function realPathOf(raw: string): string {
  let p = (raw || "").replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!p) p = "/";
  const m = p.match(/^\{source:(home|\d+)\}(.*)$/);
  if (m) {
    const rest = m[2].replace(/^\/+/, "");
    return rest ? "/" + rest : "/";
  }
  if (p.startsWith("{")) return "/";
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

/** Minimal standalone error page for viewers (file missing / empty / no fallback). */
function errorPage(title: string, message: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${htmlEscape(title)}</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5}.box{text-align:center;padding:40px;background:#fff;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.1)}h1{font-size:20px;margin:0 0 12px;color:#333}p{font-size:14px;color:#666}</style>
</head><body><div class="box"><h1>${htmlEscape(title)}</h1><p>${htmlEscape(message)}</p></div></body></html>`;
}

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

/** Merge the few global i18n keys the officeViewer template needs into the plugin pack. */
async function officeViewerLng(assets: Fetcher, lang: string): Promise<Record<string, string>> {
  const pack = await loadPluginLang(assets, "officeViewer", lang);
  let commonEdit = lang === "en" ? "Edit" : "编辑";
  let wordLoading = lang === "en" ? "Loading..." : "加载中...";
  const global = await loadLangPack(assets, lang);
  if (global) {
    if (global["common.edit"]) commonEdit = global["common.edit"];
    if (global["explorer.wordLoading"]) wordLoading = global["explorer.wordLoading"];
  }
  pack["common.edit"] = commonEdit;
  pack["explorer.wordLoading"] = wordLoading;
  return pack;
}

// officeViewer ext -> front-end parser app (mirrors 001 webOffice/index.class.php)
const OFFICE_APP_MAP: Record<string, string> = {
  docx: "mammothjs",
  doc: "mammothjs",
  xlsx: "luckysheet",
  xls: "luckysheet",
  csv: "luckysheet",
  pptx: "pptxjs",
  ppt: "pptxjs",
};

/** JS/CSS assets for each officeViewer front-end parser (mirrors weboffice template switch). */
const OFFICE_APP_ASSETS: Record<string, Array<[string, "css" | "js"]>> = {
  mammothjs: [
    ["mammothjs/mammoth.browser.kod.1.4.20.min.js", "js"],
    ["mammothjs/index.css", "css"],
    ["mammothjs/index.js", "js"],
  ],
  luckysheet: [
    ["luckysheet/plugins/css/pluginsCss.css", "css"],
    ["luckysheet/plugins/plugins.css", "css"],
    ["luckysheet/css/luckysheet.css", "css"],
    ["luckysheet/assets/iconfont/iconfont.min.css", "css"],
    ["luckysheet/index.css", "css"],
    ["luckysheet/plugins/js/plugin.js", "js"],
    ["luckysheet/luckysheet.umd.js", "js"],
    ["luckysheet/luckyexcel.umd.min.js", "js"],
    ["sheetjs/xlsx.core.min.js", "js"],
    ["exceljs/exceljs.min.js", "js"],
    ["luckysheet/utils.js", "js"],
    ["luckysheet/index.js", "js"],
  ],
  pptxjs: [
    ["pptxjs/css/pptxjs.css", "css"],
    ["pptxjs/css/nv.d3.min.css", "css"],
    ["pptxjs/index.css", "css"],
    ["pptxjs/js/jquery-1.11.3.min.js", "js"],
    ["pptxjs/js/jszip.min.js", "js"],
    ["pptxjs/js/filereader.js", "js"],
    ["pptxjs/js/d3.min.js", "js"],
    ["pptxjs/js/nv.d3.min.js", "js"],
    ["pptxjs/js/dingbat.js", "js"],
    ["pptxjs/js/pptxjs.kod.1.21.1.min.js", "js"],
    ["pptxjs/js/divs2slides.min.js", "js"],
    ["pptxjs/utils.js", "js"],
    ["pptxjs/index.js", "js"],
  ],
  sheetjs: [
    ["sheetjs/index.css", "css"],
    ["sheetjs/xlsx.core.min.js", "js"],
    ["sheetjs/index.js", "js"],
  ],
};

function officeAppAssets(pluginHost: string, app: string): string {
  const assets = OFFICE_APP_ASSETS[app] || [];
  return assets
    .map(([rel, kind]) => {
      const src = pluginHost + "static/weboffice/" + rel;
      return kind === "css"
        ? `<link rel="stylesheet" href="${src}">`
        : `<script src="${src}"></script>`;
    })
    .join("\n\t");
}

// ---------- renderers ----------

/** 插件预览目标文件存在性检查 (R2 或 io 外链); 不存在返回 null。 */
async function pluginFileInfo(c: any, rawPath: string): Promise<{ size: number; contentType: string; lastModified: string | null } | null> {
  if (rawPath.indexOf("{shareItemLink:") === 0) {
    const key = await shareFileKeyOf(c.env, rawPath);
    if (!key) return null;
    const o = await c.env.FILES.head(key).catch(() => null);
    return o ? { size: o.size, contentType: o.httpMetadata?.contentType || "", lastModified: o.uploaded ? o.uploaded.toISOString() : null } : null;
  }
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!user) return null;
  const src = await resolveFileSource(c.env, user, rawPath);
  if (!src.ok) return null;
  const key = keyFromBase(src.source.baseKey, src.relPath);
  const io = ioClientOf(src.source);
  if (io) return io.head(key);
  const o = await c.env.FILES.head(key).catch(() => null);
  return o ? { size: o.size, contentType: o.httpMetadata?.contentType || "", lastModified: o.uploaded ? o.uploaded.toISOString() : null } : null;
}

async function renderPdfjs(c: any, params: { rawPath: string; fileName: string; appHost: string; staticPath: string; lang: string }) {
  const { rawPath, fileName, appHost, staticPath, lang } = params;
  const tpl = await loadTemplate(c.env.ASSETS, "plugins/pdfjs/static/pdfjs/viewer.tpl.html");
  if (!tpl) return c.json({ code: false, data: "pdfjs template not found" });

  const pluginHost = `${staticPath}plugins/pdfjs/`;
  const html = replaceAll(tpl, [
    ["@@fileName@@", htmlEscape(fileName)],
    ["@@pluginHost@@", pluginHost],
    ["@@staticPath@@", staticPath],
    ["@@appHost@@", appHost],
    ["@@lang@@", lang],
    ["@@canDownload@@", "1"],
    ["@@fileUrl@@", fileOutRel(rawPath)],
  ]);
  return c.body(html, 200, { "Content-Type": "text/html; charset=utf-8" });
}

async function renderOfficeViewer(c: any, params: { rawPath: string; fileName: string; ext: string; appHost: string; staticPath: string; lang: string }, lng: Record<string, string>) {
  const { rawPath, fileName, ext, appHost, staticPath, lang } = params;
  const title = lng["officeViewer.meta.name"] || "Office阅读器";

  const app = OFFICE_APP_MAP[ext];
  if (!app) {
    return c.body(errorPage(title, lng["officeViewer.main.invalidExt"] || `Unsupported file type: ${ext}`), 200, HTML_HEADERS);
  }

  // 文件检查：不存在或空文件直接报错，避免前端解析器死循环
  const info = await pluginFileInfo(c, rawPath);
  if (!info) {
    const global = await loadLangPack(c.env.ASSETS, lang);
    const msg = (global && global["common.pathNotExists"]) || "文件不存在";
    return c.body(errorPage(title, msg), 200, HTML_HEADERS);
  }
  if (info.size === 0) {
    return c.body(errorPage(title, lng["officeViewer.main.fileSizeErr"] || "文件已损坏（size=0），无法预览！"), 200, HTML_HEADERS);
  }

  const tpl = await loadTemplate(c.env.ASSETS, "plugins/officeViewer/static/weboffice/template.html");
  if (!tpl) return c.json({ code: false, data: "officeViewer template not found" });

  const pluginHost = `${staticPath}plugins/officeViewer/`;

  const html = replaceAll(tpl, [
    ["@@fileName@@", jsEscape(fileName)],
    ["@@fileNameHtml@@", htmlEscape(fileName)],
    ["@@fileUrl@@", jsEscape(fileOutRel(rawPath))],
    ["@@filePath@@", jsEscape(rawPath)],
    ["@@fileApp@@", app],
    ["@@fileExt@@", jsEscape(ext)],
    ["@@canWrite@@", "0"],
    ["@@fileAppBoxClass@@", `kod-${app}-box ${ext}`],
    ["@@pluginHost@@", pluginHost],
    ["@@pluginApi@@", `/index.php?plugin/officeViewer/`],
    ["@@staticPath@@", staticPath],
    ["@@appHost@@", appHost],
    ["@@lang@@", lang],
    ["@@LNG@@", JSON.stringify(lng)],
    ["@@commonEdit@@", lng["common.edit"] || "编辑"],
    ["@@appAssets@@", officeAppAssets(pluginHost, app)],
  ]);
  return c.body(html, 200, { "Content-Type": "text/html; charset=utf-8" });
}

async function renderSimpleClock(c: any, params: { staticPath: string }) {
  const { staticPath } = params;
  const tpl = await loadTemplate(c.env.ASSETS, "plugins/simpleClock/static/page.html");
  if (!tpl) return c.json({ code: false, data: "simpleClock template not found" });

  const pluginHost = `${staticPath}plugins/simpleClock/`;
  const html = replaceAll(tpl, [["@@pluginHost@@", pluginHost]]);
  return c.body(html, 200, { "Content-Type": "text/html; charset=utf-8" });
}

async function renderWebodf(c: any, params: { rawPath: string; fileName: string; ext: string; appHost: string; staticPath: string; lang: string }) {
  const { rawPath, fileName, ext, appHost, staticPath, lang } = params;
  const title = "Opendocument Viewer";

  // 文件检查：不存在或空文件直接报错
  const info = await pluginFileInfo(c, rawPath);
  if (!info) {
    const global = await loadLangPack(c.env.ASSETS, lang);
    const msg = (global && global["common.pathNotExists"]) || "文件不存在";
    return c.body(errorPage(title, msg), 200, HTML_HEADERS);
  }
  if (info.size === 0) {
    return c.body(errorPage(title, "文件已损坏（size=0），无法预览！"), 200, HTML_HEADERS);
  }

  const tpl = await loadTemplate(c.env.ASSETS, "plugins/webodf/static/template.html");
  if (!tpl) return c.json({ code: false, data: "webodf template not found" });

  const pluginHost = `${staticPath}plugins/webodf/`;
  const odtStyle = ext === "odt"
    ? `<style type="text/css">#theBODY{margin:0;padding:0;background:#f0f0f0;}#odf{text-align:center;width:100%;display:block !important;}#odf > div{text-align:center;width:100%;background:#f0f0f0 !important;}document{margin:20px 0;background:#fff;border-bottom:1px solid rgb(217,217,217);box-shadow:rgb(204,204,204) 0px 1px 6px;}</style>`
    : "";

  const html = replaceAll(tpl, [
    ["@@pluginHost@@", pluginHost],
    ["@@fileNameHtml@@", htmlEscape(fileName)],
    ["@@fileUrl@@", jsEscape(fileOutRel(rawPath))],
    ["@@odtStyle@@", odtStyle],
  ]);
  return c.body(html, 200, { "Content-Type": "text/html; charset=utf-8" });
}

// ---------- OnlyOffice 在线编辑器 ----------

const OFFICE_DOC_TYPES: Record<string, string[]> = {
  word: ["doc", "docx", "docm", "dot", "dotm", "dotx", "odt", "rtf", "txt", "html", "htm", "mht", "epub", "pdf", "djvu", "xps", "fodt", "ott"],
  cell: ["xls", "xlsx", "xlsm", "xlsb", "csv", "ods", "fods", "xlt", "xltm", "xltx", "ots"],
  slide: ["ppt", "pptx", "pptm", "pps", "ppsm", "ppsx", "pot", "potm", "potx", "odp", "fodp", "otp"],
};

function officeDocType(ext: string): string {
  for (const [t, exts] of Object.entries(OFFICE_DOC_TYPES)) if (exts.includes(ext)) return t;
  return "word";
}

/**
 * 读取 OnlyOffice 插件配置中的 Document Server 地址 (镜像 package.json 的 config)。
 * 001 zhtengw 原插件按站点协议选择: 站点 https 用 apiServer-https, http 用 apiServer-http。
 */
async function onlyOfficeApiServer(env: Env, appHost: string): Promise<string> {
  const meta = await getPluginMeta(env.DB, "OnlyOffice");
  const config = meta?.config || {};
  const http = String(config["apiServer-http"] || "").trim();
  const https = String(config["apiServer-https"] || "").trim();
  const server = appHost.startsWith("https://") ? (https || http) : (http || https);
  if (!server) return "";
  return server.indexOf("://") >= 0 ? server : (appHost.startsWith("https://") ? "https://" : "http://") + server;
}

/** 001 fileTypeAlias: 兼容扩展名映射到 OnlyOffice 可识别文件类型。 */
function officeFileTypeAlias(ext: string): string {
  if (".docm.dotm.dot.wps.wpt".indexOf("." + ext) !== -1) return "doc";
  if (".xlt.xltx.xlsm.et.ett".indexOf("." + ext) !== -1) return "xls";
  if (".pot.potx.pptm.ppsm.potm.dps.dpt".indexOf("." + ext) !== -1) return "ppt";
  return ext;
}

/** 001 editorOpt: chat/comments/help 逗号分隔开关; config 未配置时对齐 package.json 默认全开。 */
function officeEditorOpt(config: Record<string, any>): { chat: boolean; comments: boolean; help: boolean } {
  if (config.editorOpt === undefined) return { chat: true, comments: true, help: true };
  const opt = String(config.editorOpt).split(",").map((x) => x.trim()).filter(Boolean);
  return { chat: opt.includes("chat"), comments: opt.includes("comments"), help: opt.includes("help") };
}

/** 读取 fileView 插件 apiKey 作为匿名端点签名密钥 (与 explorer/api/view 的 checkFileViewToken 一致)。
 *  线上 Reset D1 后 apiKey 为空, 首次使用时自动生成并持久化, 避免外部服务抓取场景直接 500。 */
async function onlyOfficeApiKey(env: Env): Promise<string> {
  return ensureFileViewApiKey(env);
}

/** 确保 fileView 插件存在可用的 apiKey (缺失时自动生成持久化)。 */
async function ensureFileViewApiKey(env: Env): Promise<string> {
  const meta = await getPluginMeta(env.DB, "fileView");
  if (meta?.config?.apiKey) return String(meta.config.apiKey);
  const key = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const cur = await getPluginMeta(env.DB, "fileView");
  if (cur?.config?.apiKey) return String(cur.config.apiKey);
  await setPluginConfig(env.DB, "fileView", { apiKey: key });
  return key;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** OnlyOffice 匿名端点签名: token = sha256(path + timeTo + apiKey) 前 32 位。 */
async function onlyOfficeToken(env: Env, path: string, timeTo: number): Promise<string> {
  const apiKey = await onlyOfficeApiKey(env);
  return (await sha256Hex(path + String(timeTo) + apiKey)).slice(0, 32);
}

async function checkOnlyOfficeToken(env: Env, params: Record<string, any>): Promise<{ ok: true } | { ok: false; error: string }> {
  const path = String(params.path ?? "");
  if (!path) return { ok: false, error: "explorer.share.errorParam" };
  let token = "";
  try {
    const timeTo = parseInt(String(params.timeTo ?? ""), 10) || 0;
    token = await onlyOfficeToken(env, path, timeTo);
    if (token !== String(params.token ?? "")) return { ok: false, error: "token common.error" };
    if (timeTo && timeTo <= Math.floor(Date.now() / 1000)) return { ok: false, error: "token common.expired" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true };
}

/** 按 uid 查询用户并构造 AuthUser (匿名端点无会话上下文). */
async function authUserById(env: Env, uid: string | number): Promise<AuthUser | null> {
  const id = parseInt(String(uid), 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row: any = await getUserById(env.DB, id);
  if (!row) return null;
  return {
    id: row.id as number,
    username: row.username as string,
    nickname: (row.nickname as string) || (row.username as string),
    email: (row.email as string) || "",
    phone: (row.phone as string) || "",
    avatar: (row.avatar as string) || "",
    sex: (row.sex as number) || 0,
    role: (row.role as string) || "user",
    status: (row.status as number) ?? 1,
    config_json: (row.config_json as string) || "{}",
  };
}

/** {io:N} 外部存储: 返回统一 io 客户端; 系统内置 R2 存储返回 null。 */
function s3ConfigOf(source: SourceRef): IoClient | null {
  return ioClientOf(source);
}

/** R2 或 S3 对象以 inline 方式流式返回。 */
function fileStreamResponse(c: any, obj: any, name: string) {
  const headers = new Headers();
  headers.set("Content-Type", getFileMimeType(name));
  headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(name)}"`);
  headers.set("Cache-Control", "public, max-age=3600");
  if (obj.writeHttpMetadata) obj.writeHttpMetadata(headers);
  return new Response(obj.body, { headers });
}

/** 路径所属源的权限位掩码: 个人空间全权限, 部门空间走部门权限。 */
async function sourceAuthOf(env: Env, user: AuthUser, source: SourceRef): Promise<number> {
  if (source.type === "group") return getGroupAuthValue(env, user, source.targetID);
  return getPersonalAuthValue();
}

/** 校验 fileView token 后按 path+uid 流式返回文件(匿名端点共用)。 */
async function streamFileByToken(c: any, params: Record<string, any>): Promise<Response> {
  const path = String(params.path ?? "");
  if (!path) return c.json({ code: false, data: "explorer.share.errorParam" });
  const apiKey = await ensureFileViewApiKey(c.env);
  const timeTo = parseInt(String(params.timeTo ?? ""), 10) || 0;
  const token = (await sha256Hex(path + String(timeTo) + apiKey)).slice(0, 32);
  if (token !== String(params.token ?? "")) return c.json({ code: false, data: "token common.error" });
  if (timeTo && timeTo <= Math.floor(Date.now() / 1000)) return c.json({ code: false, data: "token common.expired" });

  const user = await authUserById(c.env, params.uid || "");
  if (!user) return c.json({ code: false, data: "common.pathNotExists" });

  const src = await resolveFileSource(c.env, user, path);
  if (!src.ok) return c.json({ code: false, data: src.error });
  if (!hasAuth(await sourceAuthOf(c.env, user, src.source), AUTH_VIEW)) {
    return c.json({ code: false, data: "common.noPermission" });
  }

  const key = keyFromBase(src.source.baseKey, src.relPath);
  const s3 = s3ConfigOf(src.source);
  let obj: any = null;
  if (s3) {
    const g = await s3.get(key).catch(() => null);
    if (g) obj = { body: g.body, writeHttpMetadata(_h: Headers) {} };
  } else {
    obj = await c.env.FILES.get(key).catch(() => null);
  }
  if (!obj) return c.json({ code: false, data: "Not found" });

  const name = String(params.name || path.split("/").filter(Boolean).pop() || "file");
  return fileStreamResponse(c, obj, name);
}

/** 001 filePathLinkOut: 用 fileView 插件 apiKey 签名生成匿名可访问的插件文件流 URL。
 *  仅外部服务(sharecad/毕升/Document Server)无 cookie 抓取场景需要; 浏览器直连场景用 fileOutUrl(带 cookie) 不依赖此端点。 */
async function fileViewLinkOut(c: any, rawPath: string, user: AuthUser, name?: string): Promise<string> {
  const apiKey = await ensureFileViewApiKey(c.env);
  const timeTo = Math.floor(Date.now() / 1000) + 7 * 86400;
  const token = (await sha256Hex(rawPath + String(timeTo) + apiKey)).slice(0, 32);
  const enc = encodeURIComponent;
  const pluginName = c.req.param("name") || "";
  let url = `${getAppHost(c)}index.php?plugin/${pluginName}/fileOut&path=${enc(rawPath)}&uid=${user.id}&timeTo=${timeTo}&token=${token}`;
  if (name) url += `&name=${enc(name)}`;
  return url;
}

/** PDFTron 保存回调匿名 URL: 与 fileOut 相同签名(token=sha256(path+timeTo+apiKey)),
 *  save handler 会独立校验用户写权限, token 只证明请求来自有效文件链接。
 *  解决 WebViewer 在 static 域 iframe 内无会话 cookie 导致的保存 401。
 *  传入 act 可生成其他插件(如 Photopea saveImg)的匿名保存 URL。 */
async function fileViewSaveUrl(c: any, rawPath: string, user: AuthUser, act = "save"): Promise<string> {
  const apiKey = await ensureFileViewApiKey(c.env);
  const timeTo = Math.floor(Date.now() / 1000) + 7 * 86400;
  const token = (await sha256Hex(rawPath + String(timeTo) + apiKey)).slice(0, 32);
  const enc = encodeURIComponent;
  const pluginName = c.req.param("name") || "";
  return `${getAppHost(c)}index.php?plugin/${pluginName}/${act}&path=${enc(rawPath)}&uid=${user.id}&timeTo=${timeTo}&token=${token}`;
}

/** OnlyOffice 匿名文件下载端点 (Document Server 无会话 cookie, 校验签名后按 path 解析 R2/S3)。 */
async function onlyOfficeFileHandler(c: any) {
  const params = c.req.query();
  const check = await checkOnlyOfficeToken(c.env, params);
  if (!check.ok) return c.json({ code: false, data: check.error });
  return streamFileByToken(c, { ...params, token: params.token, timeTo: params.timeTo, uid: params.uid });
}

/** OnlyOffice 保存回调端点 (status=2 时下载新文件写回 R2/S3), 契约返回 {"error":0}。 */
async function onlyOfficeSaveHandler(c: any) {
  const params = c.req.query();
  const check = await checkOnlyOfficeToken(c.env, params);
  if (!check.ok) return c.json({ error: 1, message: check.error });

  const rawPath = String(params.path ?? "");
  const user = await authUserById(c.env, params.uid || "");
  if (!user) return c.json({ error: 1, message: "user not found" });

  const body: any = await c.req.json().catch(() => null);
  if (!body || body.status !== 2 || !body.url) return c.json({ error: 0 });

  const src = await resolveFileSource(c.env, user, rawPath);
  if (!src.ok) return c.json({ error: 1, message: src.error });

  const content = await fetch(body.url).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  if (content === null) return c.json({ error: 1, message: "download failed" });

  const key = keyFromBase(src.source.baseKey, src.relPath);
  const s3 = s3ConfigOf(src.source);
  if (s3) {
    await s3.put(key, content, getFileMimeType(rawPath)).catch(() => {});
  } else {
    await c.env.FILES.put(key, content).catch(() => {});
  }
  return c.json({ error: 0 });
}

function isMobileUA(c: any): boolean {
  const ua = c.req.header("User-Agent") || "";
  return /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
}

/** 渲染 OnlyOffice 在线编辑器页面 (office.tpl.html 占位符替换)。 */
async function renderOnlyOffice(c: any, params: { rawPath: string; fileName: string; ext: string; appHost: string; staticPath: string; lang: string }) {
  const { rawPath, fileName, ext, appHost, lang } = params;
  const title = "ONLYOFFICE Document Server";

  const meta = await getPluginMeta(c.env.DB, "OnlyOffice");
  const config = meta?.config || {};

  // 001 原插件: 按站点协议选择 Document Server 地址
  const apiServer = await onlyOfficeApiServer(c.env, appHost);
  if (!apiServer) {
    return c.body(errorPage(title, "OnlyOffice 服务地址未配置，请先在插件管理中设置 apiServer"), 200, HTML_HEADERS);
  }

  const isShare = rawPath.indexOf("{shareItemLink:") === 0;
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!isShare && !user) return c.body(errorPage(title, "未登录"), 200, HTML_HEADERS);

  // 文件存在性检查 (R2 或 io 外链)
  const info = await pluginFileInfo(c, rawPath);
  if (!info) {
    const global = await loadLangPack(c.env.ASSETS, lang);
    const msg = (global && global["common.pathNotExists"]) || "文件不存在";
    return c.body(errorPage(title, msg), 200, HTML_HEADERS);
  }

  // 读写/下载权限: 分享 guest 只读不可下载; 登录用户按源权限位
  let canRead = true;
  let canWrite = false;
  let canDownload = false;
  let canPrint = false;
  if (!isShare && user) {
    const src = await resolveFileSource(c.env, user, rawPath);
    if (src.ok) {
      const auth = await sourceAuthOf(c.env, user, src.source);
      canRead = hasAuth(auth, AUTH_VIEW);
      canWrite = hasAuth(auth, AUTH_EDIT);
      canDownload = hasAuth(auth, AUTH_DOWNLOAD);
      canPrint = canDownload;
    }
  }
  if (!canRead) return c.body(errorPage(title, "没有预览权限"), 200, HTML_HEADERS);
  // 001 previewMode: 预览模式强制只读
  if (parseInt(String(config.previewMode ?? "0"), 10) === 1) canWrite = false;

  // 文档 key: 只读用内容变更时间/大小保证同文件同 key; 可编辑追加时间戳强制刷新
  const etag = String(info.lastModified || info.size || "");
  const docKey = canWrite ? md5(etag + String(Math.floor(Date.now() / 1000))) : md5(etag || rawPath);

  // 文件 URL / 保存回调 URL
  const timeTo = Math.floor(Date.now() / 1000) + 7 * 86400;
  let fileUrl: string;
  let callbackUrl = "";
  if (isShare) {
    fileUrl = fileOutUrl(appHost, rawPath);
  } else {
    const uid = String((user as AuthUser).id);
    const token = await onlyOfficeToken(c.env, rawPath, timeTo);
    const enc = encodeURIComponent;
    fileUrl = `${appHost}index.php?plugin/OnlyOffice/file&path=${enc(rawPath)}&uid=${uid}&timeTo=${timeTo}&token=${token}`;
    if (canWrite) {
      callbackUrl = `${appHost}index.php?plugin/OnlyOffice/save&path=${enc(rawPath)}&uid=${uid}&timeTo=${timeTo}&token=${token}`;
    }
  }

  const mode = canWrite ? "edit" : "view";
  const documentType = officeDocType(ext);
  const uidJs = isShare ? "guest" : String((user as AuthUser).id);
  const userName = isShare ? "guest" : ((user as AuthUser).nickname || (user as AuthUser).username);

  // 001 openWith=dialog: 紧凑显示 + 标题留空; 移动端同样紧凑
  const openWith = String(config.openWith || "dialog");
  const compact = openWith === "dialog" || isMobileUA(c);
  const docTitle = openWith === "dialog" ? " " : fileName;

  // 001 editorOpt: chat/comments/help 开关 (缺省对齐 package.json 默认全开)
  const editorOpt = officeEditorOpt(config);

  const tpl = await loadTemplate(c.env.ASSETS, "plugins/OnlyOffice/static/office.tpl.html");
  if (!tpl) return c.json({ code: false, data: "OnlyOffice template not found" });

  const j = (v: string) => JSON.stringify(v);
  const html = replaceAll(tpl, [
    ["@@apiServer@@", htmlEscape(apiServer.replace(/\/+$/, ""))],
    ["@@fileType@@", j(officeFileTypeAlias(ext))],
    ["@@key@@", j(docKey)],
    ["@@title@@", j(docTitle)],
    ["@@url@@", j(fileUrl)],
    ["@@canDownload@@", canDownload ? "1" : "0"],
    ["@@canEdit@@", canWrite ? "1" : "0"],
    ["@@canPrint@@", canPrint ? "1" : "0"],
    ["@@documentType@@", j(documentType)],
    ["@@type@@", j("desktop")],
    ["@@callbackUrl@@", j(callbackUrl)],
    ["@@lang@@", j(lang)],
    ["@@mode@@", j(mode)],
    ["@@UID@@", j(uidJs)],
    ["@@user@@", j(userName)],
    ["@@chat@@", editorOpt.chat ? "true" : "false"],
    ["@@comments@@", editorOpt.comments ? "true" : "false"],
    ["@@help@@", editorOpt.help ? "true" : "false"],
    ["@@compact@@", compact ? "1" : "0"],
  ]);
  return c.body(html, 200, HTML_HEADERS);
}

/** 读取目标文件文本内容 (分享路径走分享者 R2, 普通路径按登录用户源解析)。 */
async function readFileText(c: any, rawPath: string): Promise<string | null> {
  if (rawPath.indexOf("{shareItemLink:") === 0) {
    const key = await shareFileKeyOf(c.env, rawPath);
    if (!key) return null;
    const obj = await c.env.FILES.get(key).catch(() => null);
    return obj ? await obj.text() : null;
  }
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!user) return null;
  const src = await resolveFileSource(c.env, user, rawPath);
  if (!src.ok) return null;
  const key = keyFromBase(src.source.baseKey, src.relPath);
  const s3 = s3ConfigOf(src.source);
  if (s3) {
    const g = await s3.get(key).catch(() => null);
    return g ? await new Response(g.body).text() : null;
  }
  const obj = await c.env.FILES.get(key).catch(() => null);
  return obj ? await obj.text() : null;
}

// ---------- route ----------

/** 001 CADViewer: 302 重定向到 sharecad.org 在线查看 CAD/3D 文件。 */
async function renderCADViewer(c: any, params: { rawPath: string; fileName: string; appHost: string; lang: string }) {
  const { rawPath, fileName, appHost, lang } = params;
  const title = "CADViewer";
  const isShare = rawPath.indexOf("{shareItemLink:") === 0;
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!isShare && !user) return c.body(errorPage(title, "未登录"), 200, HTML_HEADERS);

  const key = await resolveFileKey(c, rawPath);
  const obj = key ? await c.env.FILES.head(key).catch(() => null) : null;
  if (!obj) {
    const global = await loadLangPack(c.env.ASSETS, lang);
    const msg = (global && global["common.pathNotExists"]) || "文件不存在";
    return c.body(errorPage(title, msg), 200, HTML_HEADERS);
  }

  const fileUrl = isShare
    ? fileOutUrl(appHost, rawPath)
    : await fileViewLinkOut(c, rawPath, user as AuthUser, fileName);
  const target = "https://sharecad.org/cadframe/load?url=" + encodeURIComponent(fileUrl);
  return c.redirect(target, 302);
}

/** 001 drawio: 嵌入官方 draw.io 编辑器, autosave/save 消息写回文件。 */
async function renderDrawio(c: any, params: { rawPath: string; fileName: string; appHost: string; staticPath: string; lang: string }) {
  const { rawPath, fileName, appHost, staticPath, lang } = params;
  const lng = await loadPluginLang(c.env.ASSETS, "drawio", lang);
  const title = lng["drawio.meta.title"] || "Draw.io";
  const isShare = rawPath.indexOf("{shareItemLink:") === 0;
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!isShare && !user) return c.body(errorPage(title, "未登录"), 200, HTML_HEADERS);

  const meta = await getPluginMeta(c.env.DB, "drawio");
  const config = meta?.config || {};
  const theme = String(config.theme || "kennedy").trim();
  const autoSave = parseInt(String(config.autoSave ?? "1"), 10) === 1;

  const content = await readFileText(c, rawPath);
  if (content === null) {
    const global = await loadLangPack(c.env.ASSETS, lang);
    const msg = (global && global["common.pathNotExists"]) || "文件不存在";
    return c.body(errorPage(title, msg), 200, HTML_HEADERS);
  }

  // 001: 仅登录可写用户显示嵌入编辑界面; 其余(分享/只读)显示只读预览
  let canWrite = false;
  if (!isShare) {
    const src = await resolveFileSource(c.env, user as AuthUser, rawPath);
    if (src.ok) canWrite = hasAuth(await sourceAuthOf(c.env, user as AuthUser, src.source), AUTH_EDIT);
  }

  const lngShort = lang.slice(0, 2);
  let serverAddr = String(config.serverAddr || "").trim();
  if (!serverAddr) serverAddr = "https://www.draw.io";
  if (canWrite) {
    serverAddr += `?embed=1&ui=${encodeURIComponent(theme)}&lang=${lngShort}&spin=1&proto=json&editable=false`;
  } else {
    serverAddr += `?embed=1&ui=${encodeURIComponent(theme)}&lang=${lngShort}&proto=json&lightbox=1&highlight=0000ff&layers=1&nav=1&chrome=0`;
  }

  const newfile = content.indexOf("<diagram") === -1;
  const global = await loadLangPack(c.env.ASSETS, lang);
  const lngSaving = (global && global["explorer.saving"]) || "文件保存中...";
  const lngSaved = (global && global["explorer.saved"]) || "保存成功";

  const pluginHost = `${staticPath}plugins/drawio/`;
  const saveUrl = `/index.php?plugin/drawio/save&path=${encodeURIComponent(rawPath)}`;

  const tpl = await loadTemplate(c.env.ASSETS, "plugins/drawio/static/template.html");
  if (!tpl) return c.json({ code: false, data: "drawio template not found" });

  const html = replaceAll(tpl, [
    ["@@editorJs@@", JSON.stringify(serverAddr)],
    ["@@newfileJs@@", newfile ? "true" : "false"],
    ["@@autosaveJs@@", autoSave ? "true" : "false"],
    ["@@contentJs@@", JSON.stringify(content)],
    ["@@saveUrl@@", jsEscape(saveUrl)],
    ["@@lngSaving@@", jsEscape(lngSaving)],
    ["@@lngSaved@@", jsEscape(lngSaved)],
    ["@@pluginHost@@", pluginHost],
  ]);
  return c.body(html, 200, HTML_HEADERS);
}

/** drawio 保存回调: POST body 为 draw.io xml 原文, 校验当前用户写权限后写回 R2/S3。 */
async function drawioSaveHandler(c: any): Promise<Response> {
  const rawPath = c.req.query("path") || "";
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!user || !rawPath) return c.body("", 200, { "Content-Type": "text/plain" });
  const src = await resolveFileSource(c.env, user, rawPath);
  if (!src.ok) return c.body("", 200, { "Content-Type": "text/plain" });
  if (!hasAuth(await sourceAuthOf(c.env, user, src.source), AUTH_EDIT)) {
    return c.body("", 200, { "Content-Type": "text/plain" });
  }

  const newcontent = await c.req.text();
  const key = keyFromBase(src.source.baseKey, src.relPath);
  const s3 = s3ConfigOf(src.source);
  if (s3) {
    await s3.put(key, newcontent, getFileMimeType(rawPath)).catch(() => {});
  } else {
    await c.env.FILES.put(key, newcontent).catch(() => {});
  }
  return c.body("", 200, { "Content-Type": "text/plain" });
}

/** 001 Photopea: 302 跳到本地 photopea 前端, saveImg 回写。 */
async function renderPhotopea(c: any, params: { rawPath: string; fileName: string; ext: string; appHost: string; staticPath: string; lang: string }) {
  const { rawPath, fileName, ext, appHost, staticPath, lang } = params;
  const lng = await loadPluginLang(c.env.ASSETS, "Photopea", lang);
  const title = lng["Photopea.meta.title"] || "Photopea";
  const isShare = rawPath.indexOf("{shareItemLink:") === 0;
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!isShare && !user) return c.body(errorPage(title, "未登录"), 200, HTML_HEADERS);

  const key = await resolveFileKey(c, rawPath);
  const obj = key ? await c.env.FILES.head(key).catch(() => null) : null;
  if (!obj) {
    const global = await loadLangPack(c.env.ASSETS, lang);
    const msg = (global && global["common.pathNotExists"]) || "文件不存在";
    return c.body(errorPage(title, msg), 200, HTML_HEADERS);
  }

  // WebViewer/Photopea 界面位于 GitHub Pages(static 域) iframe, 无会话 cookie,
  // 文件加载必须用带签名 token 的匿名 URL: 分享场景走公开 share/fileOut, 登录场景走 fileView apiKey 签名。
  const fileUrl = isShare
    ? fileOutUrl(appHost, rawPath) + "&name=/" + encodeURIComponent(fileName)
    : await fileViewLinkOut(c, rawPath, user as AuthUser, fileName);

  // 可写 → saveImg 写回; 只读/分享 → unwritable
  let canWrite = false;
  if (!isShare) {
    const src = await resolveFileSource(c.env, user as AuthUser, rawPath);
    if (src.ok) canWrite = hasAuth(await sourceAuthOf(c.env, user as AuthUser, src.source), AUTH_EDIT);
  }
  const enc = encodeURIComponent;
  const saveUrl = canWrite
    ? await fileViewSaveUrl(c, rawPath, user as AuthUser, "saveImg")
    : `/index.php?plugin/Photopea/saveImg&unwritable=1`;

  const meta = await getPluginMeta(c.env.DB, "Photopea");
  const config = meta?.config || {};
  const theme = String(config.theme ?? "1");

  const fullUri = JSON.stringify({
    files: [fileUrl],
    resources: [],
    server: { version: 1, url: saveUrl, formats: [ext] },
    environment: { theme, lang },
    script: "",
  });

  const target = `${staticPath}plugins/Photopea/static/photopea/#` + fullUri;
  return c.redirect(target, 302);
}

/** Photopea 保存回调: POST 流前 2000 字节为 JSON 头, 剩余为图片二进制, 写回 R2/S3。
 *  认证优先取 token(static 域 iframe 无会话 cookie), 无 token 时回退会话 cookie。 */
async function photopeaSaveHandler(c: any): Promise<Response> {
  if (c.req.query("unwritable")) return c.json({ message: "Unwritable!" });
  const rawPath = c.req.query("path") || "";
  let user = c.get("currentUser") as AuthUser | undefined;
  const uid = String(c.req.query("uid") || "");
  const token = String(c.req.query("token") || "");
  const timeTo = parseInt(String(c.req.query("timeTo") || ""), 10) || 0;
  if (!user && uid && token) {
    const apiKey = await ensureFileViewApiKey(c.env);
    const expect = (await sha256Hex(rawPath + String(timeTo) + apiKey)).slice(0, 32);
    if (expect === token && (!timeTo || timeTo > Math.floor(Date.now() / 1000))) {
      const u = await authUserById(c.env, uid);
      if (u) user = u;
    }
  }
  if (!user || !rawPath) return c.json({ message: "Unwritable!" });

  const src = await resolveFileSource(c.env, user, rawPath);
  if (!src.ok) return c.json({ message: "Unwritable!" });
  if (!hasAuth(await sourceAuthOf(c.env, user, src.source), AUTH_EDIT)) {
    return c.json({ message: "Unwritable!" });
  }

  const body = await c.req.arrayBuffer();
  const content = body.slice(2000);
  const key = keyFromBase(src.source.baseKey, src.relPath);
  const s3 = s3ConfigOf(src.source);
  if (s3) {
    await s3.put(key, content, getFileMimeType(rawPath)).catch(() => {});
  } else {
    await c.env.FILES.put(key, content).catch(() => {});
  }
  return c.json({ message: "Saved!" });
}

/** URL-safe base64 (UTF-8 安全, 对齐 PHP base64_encode)。 */
function b64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64Decode(b64: string): string {
  let b = b64;
  const mod = b.length % 4;
  if (mod === 2) b += "==";
  else if (mod === 3) b += "=";
  const bin = atob(b);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 001 bisheng: 302 跳到毕升 Office 编辑器, filePost 供毕升拉取 options, save 回调写回。 */
async function renderBisheng(c: any, params: { rawPath: string; fileName: string; ext: string; appHost: string; staticPath: string; lang: string }) {
  const { rawPath, fileName, ext, appHost, staticPath, lang } = params;
  const lng = await loadPluginLang(c.env.ASSETS, "bisheng", lang);
  const title = lng["bisheng.meta.title"] || "Bisheng Office";
  const isShare = rawPath.indexOf("{shareItemLink:") === 0;
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!isShare && !user) return c.body(errorPage(title, "未登录"), 200, HTML_HEADERS);

  const meta = await getPluginMeta(c.env.DB, "bisheng");
  const config = meta?.config || {};
  const apiServer = String(config.apiServer || "").replace(/\/+$/, "");
  if (!apiServer) return c.body(errorPage(title, "bisheng Document Server is not available."), 200, HTML_HEADERS);
  const apiKey = String(config.apiKey || "");
  const previewMode = parseInt(String(config.previewMode ?? "0"), 10) === 1;

  const key = await resolveFileKey(c, rawPath);
  const obj = key ? await c.env.FILES.head(key).catch(() => null) : null;
  if (!obj) {
    const global = await loadLangPack(c.env.ASSETS, lang);
    const msg = (global && global["common.pathNotExists"]) || "文件不存在";
    return c.body(errorPage(title, msg), 200, HTML_HEADERS);
  }

  const fileUrl = isShare
    ? fileOutUrl(appHost, rawPath)
    : await fileViewLinkOut(c, rawPath, user as AuthUser, fileName);

  const viewtype = c.req.query("viewtype") || "";
  const pdfViewer = viewtype === "pdf";

  let canRead = true;
  let canWrite = false;
  if (!isShare) {
    const src = await resolveFileSource(c.env, user as AuthUser, rawPath);
    if (src.ok) {
      const auth = await sourceAuthOf(c.env, user as AuthUser, src.source);
      canRead = hasAuth(auth, AUTH_VIEW);
      canWrite = hasAuth(auth, AUTH_EDIT);
    }
  }
  if (!canRead) return c.body(errorPage(title, "没有预览权限"), 200, HTML_HEADERS);

  // 001: 默认最低权限 FILE_READ; 可读追加下载/打印; 可写且非预览模式追加写权限
  const privilege = ["FILE_READ"];
  if (canRead) privilege.push("FILE_DOWNLOAD", "FILE_PRINT");
  const openEditor = !previewMode && canWrite && !pdfViewer;
  if (openEditor) privilege.push("FILE_WRITE");

  const enc = encodeURIComponent;
  const docId = md5(rawPath);
  const uidJs = isShare ? "guest" : String((user as AuthUser).id);
  const nickName = isShare ? "guest" : ((user as AuthUser).nickname || (user as AuthUser).username) + " (" + (user as AuthUser).username + ")";

  const options: any = {
    doc: { docId, title: fileName, fetchUrl: fileUrl, callback: "", pdf_viewer: pdfViewer },
    user: { uid: uidJs, nickName, avatar: isShare ? "" : (user as AuthUser).avatar, privilege },
  };
  if (openEditor) {
    options.doc.callback = `${appHost}index.php?plugin/bisheng/save&path=${enc(rawPath)}&api=${enc(apiServer)}`;
  }

  const data = b64Encode(JSON.stringify(options));
  const postUrl = `${appHost}index.php?plugin/bisheng/filePost&data=${data}`;
  const callURL = b64Encode(postUrl);
  const editorBase = apiServer + (openEditor ? "/apps/editor/openEditor?callURL=" : "/apps/editor/openPreview?callURL=");
  let target = editorBase + callURL;
  if (apiKey) target += "&sign=" + hmacMd5(apiKey, callURL);
  return c.redirect(target, 302);
}

/** bisheng filePost: 返回 base64 解码后的 options JSON (毕升前端拉取文档信息)。 */
async function bishengFilePostHandler(c: any): Promise<Response> {
  const data = c.req.query("data") || "";
  let decoded = "";
  try {
    decoded = b64Decode(data);
  } catch {
    return c.json({ code: false, data: "bad data" });
  }
  return c.body(decoded, 200, { "Content-Type": "application/json; charset=utf-8" });
}

/** bisheng save 回调: 毕升返回 docURL, 从 api 服务下载新文档写回 R2/S3。 */
async function bishengSaveHandler(c: any): Promise<Response> {
  const rawPath = c.req.query("path") || "";
  const api = c.req.query("api") || "";
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!user || !rawPath || !api) return c.text('{"error":0}', 200, { "Content-Type": "application/json" });

  let data: any = null;
  try {
    data = await c.req.json();
  } catch {
    return c.text('{"error":0}', 200, { "Content-Type": "application/json" });
  }
  if (!data || !data.data || data.data.unchanged || !data.data.docURL) {
    return c.text('{"error":0}', 200, { "Content-Type": "application/json" });
  }

  const src = await resolveFileSource(c.env, user, rawPath);
  if (!src.ok) return c.text('{"error":0}', 200, { "Content-Type": "application/json" });
  if (!hasAuth(await sourceAuthOf(c.env, user, src.source), AUTH_EDIT)) {
    return c.text('{"error":0}', 200, { "Content-Type": "application/json" });
  }

  const content = await fetch(api + data.data.docURL)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null);
  if (content === null) return c.text('{"error":0}', 200, { "Content-Type": "application/json" });

  const key = keyFromBase(src.source.baseKey, src.relPath);
  const s3 = s3ConfigOf(src.source);
  if (s3) {
    await s3.put(key, content, getFileMimeType(rawPath)).catch(() => {});
  } else {
    await c.env.FILES.put(key, content).catch(() => {});
  }
  return c.text('{"error":0}', 200, { "Content-Type": "application/json" });
}

/** 001 PDFTron: 本地 WebViewer 渲染 PDF, 可写用户可批注并保存回原文件。 */
async function renderPdfTron(c: any, params: { rawPath: string; fileName: string; appHost: string; staticPath: string; lang: string }) {
  const { rawPath, fileName, appHost, staticPath, lang } = params;
  const lng = await loadPluginLang(c.env.ASSETS, "PDFTron", lang);
  const title = lng["PDFTron.meta.title"] || "PDFTron WebViewer";
  const isShare = rawPath.indexOf("{shareItemLink:") === 0;
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!isShare && !user) return c.body(errorPage(title, "未登录"), 200, HTML_HEADERS);

  const key = await resolveFileKey(c, rawPath);
  const obj = key ? await c.env.FILES.head(key).catch(() => null) : null;
  if (!obj) {
    const global = await loadLangPack(c.env.ASSETS, lang);
    const msg = (global && global["common.pathNotExists"]) || "文件不存在";
    return c.body(errorPage(title, msg), 200, HTML_HEADERS);
  }

  const meta = await getPluginMeta(c.env.DB, "PDFTron");
  const config = meta?.config || {};
  const licenseKey = config.licenseKey ?? null;
  const darktheme = parseInt(String(config.darktheme ?? "0"), 10) === 1;
  const savetofile = parseInt(String(config.savetofile ?? "0"), 10) === 1;

  // WebViewer UI 位于 GitHub Pages(static 域) iframe, 无会话 cookie, 数据请求必须用带签名 token 的匿名 URL:
  // 分享场景走公开 share/fileOut, 登录场景走 fileView apiKey 签名(跨域可用)。
  const fileUrl = isShare
    ? fileOutUrl(appHost, rawPath)
    : await fileViewLinkOut(c, rawPath, user as AuthUser, fileName);

  // 001: guest 只读; 登录用户按源权限位
  let canRead = true;
  let canWrite = false;
  if (!isShare) {
    const src = await resolveFileSource(c.env, user as AuthUser, rawPath);
    if (src.ok) {
      const auth = await sourceAuthOf(c.env, user as AuthUser, src.source);
      canRead = hasAuth(auth, AUTH_VIEW);
      canWrite = hasAuth(auth, AUTH_EDIT);
    }
  }
  const isViewOnly = !canRead;
  const userName = isShare ? "guest" : ((user as AuthUser).username || "guest");
  const viewerLang = lang.replace("-", "_").toLowerCase();
  const enc = encodeURIComponent;
  const saveUrl = canWrite && !isShare
    ? await fileViewSaveUrl(c, rawPath, user as AuthUser)
    : "";

  const global = await loadLangPack(c.env.ASSETS, lang);
  const lngSave = (global && global["common.save"]) || "保存";
  const lngSaveSuccess = (global && global["explorer.saveSuccess"]) || "保存成功!";
  const lngError = (global && global["explorer.error"]) || "操作失败！";

  const pluginHost = `${staticPath}plugins/PDFTron/`;
  const tpl = await loadTemplate(c.env.ASSETS, "plugins/PDFTron/static/template.html");
  if (!tpl) return c.json({ code: false, data: "PDFTron template not found" });

  const html = replaceAll(tpl, [
    ["@@pluginHost@@", pluginHost],
    ["@@configUrl@@", `${pluginHost}config.js`],
    ["@@licenseKeyJs@@", JSON.stringify(licenseKey)],
    ["@@fileUrl@@", jsEscape(fileUrl)],
    ["@@isReadOnlyJs@@", canWrite ? "false" : "true"],
    ["@@enableMeasurementJs@@", canWrite ? "true" : "false"],
    ["@@enableRedactionJs@@", canWrite ? "true" : "false"],
    ["@@annotationUserJs@@", JSON.stringify(userName)],
    ["@@lang@@", jsEscape(viewerLang)],
    ["@@darkthemeJs@@", darktheme ? "true" : "false"],
    ["@@isViewOnlyJs@@", isViewOnly ? "true" : "false"],
    ["@@canWriteJs@@", canWrite ? "true" : "false"],
    ["@@savetofileJs@@", savetofile ? "true" : "false"],
    ["@@saveUrl@@", jsEscape(saveUrl)],
    ["@@lngSave@@", jsEscape(lngSave)],
    ["@@lngSaveSuccess@@", jsEscape(lngSaveSuccess)],
    ["@@lngError@@", jsEscape(lngError)],
  ]);
  return c.body(html, 200, HTML_HEADERS);
}

/** PDFTron 保存回调: POST body 为二进制 PDF (含批注), 校验写权限后写回 R2/S3。
 *  认证优先取 token(WebViewer 无会话 cookie), 无 token 时回退会话 cookie。 */
async function pdfTronSaveHandler(c: any): Promise<Response> {
  const rawPath = c.req.query("path") || "";
  let user = c.get("currentUser") as AuthUser | undefined;
  const uid = String(c.req.query("uid") || "");
  const token = String(c.req.query("token") || "");
  const timeTo = parseInt(String(c.req.query("timeTo") || ""), 10) || 0;
  if (!user && uid && token) {
    const apiKey = await ensureFileViewApiKey(c.env);
    const expect = (await sha256Hex(rawPath + String(timeTo) + apiKey)).slice(0, 32);
    if (expect === token && (!timeTo || timeTo > Math.floor(Date.now() / 1000))) {
      const u = await authUserById(c.env, uid);
      if (u) user = u;
    }
  }
  if (!user || !rawPath) return c.text('{"error":0}', 200, { "Content-Type": "application/json" });

  const src = await resolveFileSource(c.env, user, rawPath);
  if (!src.ok) return c.text('{"error":0}', 200, { "Content-Type": "application/json" });
  if (!hasAuth(await sourceAuthOf(c.env, user, src.source), AUTH_EDIT)) {
    return c.text('{"error":0}', 200, { "Content-Type": "application/json" });
  }

  const pdfStream = await c.req.arrayBuffer();
  if (!pdfStream || pdfStream.byteLength === 0) {
    return c.text('{"error":0}', 200, { "Content-Type": "application/json" });
  }
  const key = keyFromBase(src.source.baseKey, src.relPath);
  const s3 = s3ConfigOf(src.source);
  if (s3) {
    await s3.put(key, pdfStream, getFileMimeType(rawPath)).catch(() => {});
  } else {
    await c.env.FILES.put(key, pdfStream).catch(() => {});
  }
  return c.text('{"error":0}', 200, { "Content-Type": "application/json" });
}

/** 001 officeLive: index() 直接 302 跳转到外部预览服务(微软 Office Online 等),
 *  src 参数为匿名可访问的文件流 URL(外部服务无会话 cookie, 需 fileView apiKey 签名)。 */
async function renderOfficeLive(c: any, params: { rawPath: string; fileName: string; appHost: string }) {
  const { rawPath, fileName, appHost } = params;
  if (!rawPath) return c.json({ code: false, data: "explorer.share.errorParam" });

  const isShare = rawPath.indexOf("{shareItemLink:") === 0;
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!isShare && !user) return c.body(errorPage("officeLive", "未登录"), 200, HTML_HEADERS);

  const meta = await getPluginMeta(c.env.DB, "officeLive");
  const config = meta?.config || {};
  const apiServer = String(config.apiServer || "https://view.officeapps.live.com/op/embed.aspx?src=");

  const fileUrl = isShare
    ? fileOutUrl(appHost, rawPath)
    : await fileViewLinkOut(c, rawPath, user as AuthUser, fileName);

  return c.redirect(apiServer + encodeURIComponent(fileUrl), 302);
}

// ---------- yzOffice 永中在线预览 (复刻 001 plugins/yzOffice) ----------

const YZ_OFFICE_UPLOAD = "https://www.yozodcs.com/fcscloud/file/upload";
const YZ_OFFICE_CONVERT = "https://www.yozodcs.com/fcscloud/composite/convert";
const YZ_OFFICE_TTL = 2 * 3600;

/** 插件运行时缓存读取 (镜像 001 Cache::get, 跨 isolate 存 D1)。 */
async function pluginCacheGet(db: D1Database, id: string): Promise<any | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(`SELECT data FROM plugin_cache WHERE id = ? AND expire_at > ?`)
    .bind(id, now)
    .first()
    .catch(() => null);
  if (!row) return null;
  try {
    return JSON.parse((row as { data: string }).data);
  } catch {
    return null;
  }
}

/** 插件运行时缓存写入 (镜像 001 Cache::set)。 */
async function pluginCacheSet(db: D1Database, id: string, value: any, ttlSec = YZ_OFFICE_TTL): Promise<void> {
  const expireAt = Math.floor(Date.now() / 1000) + ttlSec;
  await db
    .prepare(
      `INSERT INTO plugin_cache (id, data, expire_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, expire_at = excluded.expire_at`
    )
    .bind(id, JSON.stringify(value), expireAt)
    .run()
    .catch(() => null);
}

async function pluginCacheDel(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM plugin_cache WHERE id = ?`).bind(id).run().catch(() => null);
}

/** yzOffice 任务缓存 key: 按用户 + 真实文件路径隔离 (镜像 001 cacheTask = md5(cachePath+hash(filePath)))。 */
function yzOfficeTaskKey(userID: number, rawPath: string): string {
  return "yzOffice:" + userID + ":" + md5(realPathOf(rawPath));
}

/** 读取 R2/S3 文件原始字节 (供上传到第三方转换服务)。 */
async function readFileBytes(c: any, user: AuthUser, rawPath: string, name?: string): Promise<{ buf: ArrayBuffer; name: string } | null> {
  const src = await resolveFileSource(c.env, user, rawPath);
  if (!src.ok) return null;
  const key = keyFromBase(src.source.baseKey, src.relPath);
  const s3 = s3ConfigOf(src.source);
  let buf: ArrayBuffer | null = null;
  if (s3) {
    const g = await s3.get(key).catch(() => null);
    if (g) buf = await new Response(g.body).arrayBuffer();
  } else {
    const o = await c.env.FILES.get(key).catch(() => null);
    if (o) buf = await o.arrayBuffer();
  }
  if (!buf) return null;
  const fname = name || src.relPath.split("/").filter(Boolean).pop() || "file";
  return { buf, name: fname };
}

/** 001 yzOffice upload(): multipart 上传文件到 yozodcs, 返回 { data: 响应JSON }。 */
async function yzOfficeUpload(c: any, user: AuthUser, rawPath: string, name: string): Promise<{ data: any } | null> {
  const f = await readFileBytes(c, user, rawPath, name);
  if (!f) return null;
  const fd = new FormData();
  fd.append("file", new Blob([f.buf]), f.name);
  const res = await fetch(YZ_OFFICE_UPLOAD, { method: "POST", body: fd }).catch(() => null);
  if (!res || !res.ok) return null;
  const j = await res.json().catch(() => null);
  if (!j) return null;
  return { data: j };
}

/** 001 yzOffice convert(): 用上传返回的 srcRelativePath 触发转换, 返回 { data: 响应JSON }。 */
async function yzOfficeConvert(task: any): Promise<{ data: any } | null> {
  const rel = task?.steps?.[0]?.result?.data?.data;
  if (!rel) return null;
  const body = new URLSearchParams({
    srcRelativePath: String(rel),
    convertType: "61",
    isDccAsync: "1",
    isCopy: "1",
    isShowTitle: "0",
    isDelSrc: "1",
  }).toString();
  const res = await fetch(YZ_OFFICE_CONVERT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body,
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const j = await res.json().catch(() => null);
  if (!j) return null;
  return { data: j };
}

function yzOfficeNewTask(rawPath: string): any {
  return {
    currentStep: 0,
    success: 0,
    taskUuid: md5(rawPath + String(Date.now()) + String(Math.random())),
    steps: [
      { name: "upload", process: "uploadProcess", status: 0, result: "" },
      { name: "convert", process: "convert", status: 0, result: "" },
    ],
  };
}

/** 001 yzOffice runTask(): 顺序执行 upload/convert 两步并把状态持久化, 返回最终 task 或错误。 */
async function yzOfficeRunTask(c: any, user: AuthUser, rawPath: string, fileName: string): Promise<{ task?: any; error?: string }> {
  const key = yzOfficeTaskKey(user.id, rawPath);
  let task = await pluginCacheGet(c.env.DB, key);
  if (!task || !Array.isArray(task.steps)) {
    task = yzOfficeNewTask(rawPath);
  }

  for (let i = task.currentStep || 0; i < task.steps.length; i++) {
    const item = task.steps[i];
    task.currentStep = i;
    if (item.status === 2) continue;
    const result = item.name === "upload" ? await yzOfficeUpload(c, user, rawPath, fileName) : await yzOfficeConvert(task);
    if (!result || result.data === undefined) {
      await pluginCacheSet(c.env.DB, key, task);
      return { error: "explorer.error" };
    }
    item.result = result.data;
    item.status = 2;
    await pluginCacheSet(c.env.DB, key, task);
  }

  task.currentStep = task.steps.length - 1;
  task.success = 1;
  await pluginCacheSet(c.env.DB, key, task);
  return { task };
}

/** 001 yzOffice index(): 未转换完成渲染进度页, 已完成 302 跳转 viewUrl。 */
async function renderYzOffice(c: any, params: { rawPath: string; fileName: string; appHost: string; staticPath: string; lang: string }) {
  const { rawPath, fileName, appHost, staticPath, lang } = params;
  const lng = await loadPluginLang(c.env.ASSETS, "yzOffice", lang);
  const title = lng["yzOffice.meta.title"] || "永中office在线预览";
  const isShare = rawPath.indexOf("{shareItemLink:") === 0;
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!rawPath) return c.body(errorPage(title, "explorer.share.errorParam"), 200, HTML_HEADERS);
  if (!isShare && !user) return c.body(errorPage(title, "未登录"), 200, HTML_HEADERS);

  // 已完成: 读取缓存的 viewUrl
  if (user) {
    const key = yzOfficeTaskKey(user.id, rawPath);
    const task = await pluginCacheGet(c.env.DB, key);
    if (task && task.success) {
      const info = task.steps[task.steps.length - 1]?.result;
      const viewUrl = info && info.data && info.data.viewUrl;
      if (info && (info.errorcode || !viewUrl)) {
        await pluginCacheDel(c.env.DB, key);
        return c.body(errorPage(title, info.message || lng["yzOffice.Main.invalidUrl"] || "无效的请求地址"), 200, HTML_HEADERS);
      }
      if (viewUrl) return c.redirect(viewUrl, 302);
    }
  }

  const tpl = await loadTemplate(c.env.ASSETS, "plugins/yzOffice/static/index.html");
  if (!tpl) return c.json({ code: false, data: "yzOffice template not found" });

  const pluginHost = `${staticPath}plugins/yzOffice/`;
  const apiBase = `${appHost}index.php?plugin/yzOffice/`;

  const html = replaceAll(tpl, [
    ["@@title@@", htmlEscape(title)],
    ["@@pluginHost@@", pluginHost],
    ["@@appName@@", htmlEscape(lng["yzOffice.meta.name"] || "永中office")],
    ["@@pathJs@@", jsEscape(rawPath)],
    ["@@apiBase@@", jsEscape(apiBase)],
    ["@@lngTransfer@@", htmlEscape(lng["yzOffice.Main.transfer"] || "1.数据传输中,请稍后...")],
    ["@@LNG@@", JSON.stringify({
      error: lng["explorer.error"] || (lang === "en" ? "Operation failed" : "操作失败！"),
      transfer: lng["yzOffice.Main.transfer"] || "1.数据传输中,请稍后...",
      converting: lng["yzOffice.Main.converting"] || "2.文件转换中,请稍后...",
      uploadError: lng["yzOffice.Main.uploadError"] || "上传失败!",
      convert: lng["yzOffice.Main.convert"] || "正在转换,请稍后...",
      transferAgain: lng["yzOffice.Main.transferAgain"] || "重新转换",
    })],
  ]);
  return c.body(html, 200, HTML_HEADERS);
}

/** 001 yzOffice task(): 触发/轮询转换任务; 前端每 600ms 调用一次。 */
async function yzOfficeTaskHandler(c: any): Promise<Response> {
  const rawPath = c.req.query("path") || "";
  const fileName = c.req.query("name") || "";
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!user) return c.json({ code: false, data: "common.noPermission" });
  if (!rawPath) return c.json({ code: false, data: "explorer.share.errorParam" });
  const res = await yzOfficeRunTask(c, user, rawPath, fileName);
  if (res.error) return c.json({ code: false, data: res.error });
  return c.json({ code: true, data: res.task });
}

/** 001 yzOffice restart(): 清除任务缓存, 允许重新转换。 */
async function yzOfficeRestartHandler(c: any): Promise<Response> {
  const rawPath = c.req.query("path") || "";
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!user || !rawPath) return c.json({ code: false, data: "explorer.share.errorParam" });
  await pluginCacheDel(c.env.DB, yzOfficeTaskKey(user.id, rawPath));
  return c.json({ code: true, data: "success" });
}

/** 001 yzOffice getFile(): 代理 viewUrl 同源子资源(字体/图片等)。 */
async function yzOfficeGetFileHandler(c: any): Promise<Response> {
  const rawPath = c.req.query("path") || "";
  const file = c.req.query("file") || "";
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!user || !rawPath || !file) return c.json({ code: false, data: "explorer.share.errorParam" });
  const task = await pluginCacheGet(c.env.DB, yzOfficeTaskKey(user.id, rawPath));
  const viewUrl = task?.steps?.slice(-1)?.[0]?.result?.data?.viewUrl;
  if (!viewUrl) return c.json({ code: false, data: "explorer.error" });
  const base = String(viewUrl).replace(/\/[^/]*$/, "/");
  let target = "";
  try {
    target = new URL(file.replace(/^\.\//, ""), base).toString();
  } catch {
    return c.json({ code: false, data: "explorer.share.errorParam" });
  }
  const res = await fetch(target).catch(() => null);
  if (!res || !res.ok) return c.json({ code: false, data: "common.pathNotExists" });
  const headers = new Headers();
  const ct = res.headers.get("Content-Type");
  if (ct) headers.set("Content-Type", ct);
  return new Response(res.body, { status: res.status, headers });
}

// ---------- fileThumb 文件封面/缩略图 (复刻 001 plugins/fileThumb) ----------

// 001 fileThumb $webExts: 浏览器可直接预览的图片格式, 无 ImageMagick/imaginary 时直接输出原图
const FILETHUMB_WEB_EXTS = ["gif", "png", "bmp", "jpe", "jpeg", "jpg", "webp", "avif"];

/**
 * 001 fileThumbPlugin::cover: 生成/输出文件缩略图。
 * Cloudflare Workers 无 ImageMagick/ffmpeg 二进制, 等价于 001 未安装时:
 *   - 浏览器可预览的图片直接输出原图;
 *   - 其余格式 (psd/ai/pdf 等) 返回 convert error。
 */
async function fileThumbCoverHandler(c: any): Promise<Response> {
  const rawPath = c.req.query("path") || "";
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!user || !rawPath) return c.body("Invalid file path: " + rawPath, 200, { "Content-Type": "text/plain" });

  const src = await resolveFileSource(c.env, user, rawPath);
  if (!src.ok) return c.body("Invalid file path: " + rawPath, 200, { "Content-Type": "text/plain" });

  const name = src.relPath.split("/").filter(Boolean).pop() || "file";
  const ext = (name.split(".").pop() || "").toLowerCase();

  const key = keyFromBase(src.source.baseKey, src.relPath);
  const s3 = s3ConfigOf(src.source);
  let obj: any = null;
  if (s3) {
    const g = await s3.get(key).catch(() => null);
    if (g) obj = { body: g.body, writeHttpMetadata(_h: Headers) {} };
  } else {
    obj = await c.env.FILES.get(key).catch(() => null);
  }
  if (!obj) return c.body("Invalid file path: " + rawPath, 200, { "Content-Type": "text/plain" });

  if (FILETHUMB_WEB_EXTS.includes(ext)) {
    return fileStreamResponse(c, obj, name);
  }
  return c.body("convert error!", 200, { "Content-Type": "text/plain" });
}

/** 001 fileThumbPlugin::videoSmall: 视频转码, 无 ffmpeg 时直接返回 (等价于 001 getFFmpeg()==false)。 */
async function fileThumbVideoSmallHandler(c: any): Promise<Response> {
  return c.body("", 200, { "Content-Type": "application/json" });
}

// ---------- adminer 数据库管理 (复刻 001 plugins/adminer) ----------
// 001 里 adminer 是 PHP(Adminer) 管理 MySQL; Workers 无 PHP/MySQL, 改用 D1。
// 前端 main.js url 用 {{pluginApi}} 指向 worker 后端, 这里渲染 Adminer 主题的 D1 管理页。

function adminerIsAdmin(user: AuthUser | undefined): boolean {
  return !!user && (user.role === "admin" || user.role === "root");
}

/** 列出 D1 全部表 (sqlite_master)。 */
async function adminerTablesHandler(c: any): Promise<Response> {
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!adminerIsAdmin(user)) return c.json({ code: false, data: "explorer.noPermissionAction" });
  const r = await c.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().catch(() => null);
  return c.json({ code: true, data: r ? (r.results as Array<{ name: string }>).map((x) => x.name) : [] });
}

/** 执行 SQL (SELECT 返回结果集, 其余返回影响行数)。 */
async function adminerQueryHandler(c: any): Promise<Response> {
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!adminerIsAdmin(user)) return c.json({ code: false, data: "explorer.noPermissionAction" });
  let sql = c.req.query("sql") || "";
  if (!sql) {
    try {
      const body = await c.req.json();
      sql = String((body as any).sql || "");
    } catch {
      /* no body */
    }
  }
  if (!sql) return c.json({ code: false, data: "empty sql" });
  const trimmed = sql.trim();
  const lower = trimmed.toLowerCase();
  const isSelect = /^(select|pragma|with|explain|values)/.test(lower);
  try {
    if (isSelect) {
      const r = await c.env.DB.prepare(trimmed).all();
      return c.json({ code: true, data: { columns: r.results.length ? Object.keys(r.results[0]) : [], rows: r.results } });
    }
    const r = await c.env.DB.prepare(trimmed).run();
    return c.json({ code: true, data: { changes: r.meta?.changes ?? r.meta?.last_row_id ?? 0 } });
  } catch (e: any) {
    return c.json({ code: false, data: String(e?.message || e) });
  }
}

/** 渲染 Adminer 主题的 D1 管理页 (001 adminer/index.php 语义: 仅管理员可访问)。 */
async function renderAdminer(c: any): Promise<Response> {
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!adminerIsAdmin(user)) {
    return c.body(errorPage("Adminer", "no permission"), 200, HTML_HEADERS);
  }
  const appHost = getAppHost(c);
  const staticPath = getStaticHost(c);
  const pluginHost = `${staticPath}plugins/adminer/`;
  const apiBase = `${appHost}index.php?plugin/adminer/`;

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Adminer</title>
<link rel="stylesheet" href="${pluginHost}adminer/adminer.css">
</head>
<body>
<div id="menu">
  <h1><a href="javascript:void(0)">D1</a><span id="h1">D1</span></h1>
  <p class="links"><a href="javascript:void(0)" onclick="loadTables()">Refresh</a></p>
  <div id="tables"><p class="error">Loading tables...</p></div>
</div>
<div id="content">
  <div id="breadcrumb">SQL command</div>
  <form id="sqlForm" onsubmit="return runSql()">
    <textarea id="sql" name="query" rows="6" cols="80" style="width:100%"></textarea>
    <p><input type="submit" value="Execute"> <input type="button" value="Clear" onclick="clearAll()"></p>
  </form>
  <div id="result"></div>
</div>
<script>
var apiBase = ${JSON.stringify(apiBase)};
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function api(path, body){
  var opt = body ? {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), credentials:'include'} : {credentials:'include'};
  return fetch(apiBase + path, opt).then(function(r){return r.json();});
}
function loadTables(){
  api('tables').then(function(res){
    var el = document.getElementById('tables'); el.innerHTML = '';
    if(!res || !res.code){ el.innerHTML = '<p class="error">'+esc(res&&res.data)+'</p>'; return; }
    var tables = res.data || [];
    if(!tables.length){ el.innerHTML = '<p>No tables</p>'; return; }
    tables.forEach(function(t){
      var a = document.createElement('a');
      a.href = 'javascript:void(0)';
      a.textContent = t;
      a.title = t;
      a.onclick = function(){ showTable(t); };
      el.appendChild(a);
    });
  });
}
function showTable(name){
  runSql('SELECT * FROM "'+name.replace(/"/g,'""')+'" LIMIT 50');
  document.getElementById('sql').value = 'SELECT * FROM "'+name.replace(/"/g,'""')+'" LIMIT 50';
}
function clearAll(){ document.getElementById('sql').value=''; document.getElementById('result').innerHTML=''; }
function runSql(sqlOverride){
  var sql = sqlOverride || document.getElementById('sql').value;
  if(!sql.trim()) return false;
  document.getElementById('result').innerHTML = '<p>Running...</p>';
  api('query', {sql: sql}).then(function(res){
    var el = document.getElementById('result');
    if(!res || !res.code){ el.innerHTML = '<p class="error">'+esc(res&&res.data)+'</p>'; return; }
    var d = res.data;
    if(d && d.rows){
      var html = '<table class="nowrap checkable"><thead><tr>';
      (d.columns||[]).forEach(function(c){ html += '<th>'+esc(c)+'</th>'; });
      html += '</tr></thead><tbody>';
      d.rows.forEach(function(row){
        html += '<tr>';
        (d.columns||[]).forEach(function(c){ html += '<td>'+esc(row[c])+'</td>'; });
        html += '</tr>';
      });
      html += '</tbody></table><p>' + d.rows.length + ' rows</p>';
      el.innerHTML = html;
    } else if(d && d.changes !== undefined){
      el.innerHTML = '<p>'+d.changes+' row(s) affected</p>';
    } else {
      el.innerHTML = '<p>OK</p>';
    }
  });
  return false;
}
loadTables();
</script>
</body>
</html>`;
  return c.body(html, 200, HTML_HEADERS);
}

// ---------- client 客户端/扫码登录 (复刻 001 plugins/client) ----------

async function clientAllParams(c: any): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query() as Record<string, string>)) out[k] = v;
  try {
    const body = await c.req.parseBody();
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  } catch {
    /* no body */
  }
  return out;
}

/** 001 clientPlugin::qrcodeToken: 生成二维码 token (POST), 返回 currentKey+token。 */
async function clientQrcodeTokenHandler(c: any): Promise<Response> {
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!user) return c.json({ code: false, data: "user.loginFirst" });
  const currentKey = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  const sessionId = getSessionId(c) || "";
  await pluginCacheSet(c.env.DB, `clientQrcode:${currentKey}`, {
    count: 0,
    time: Math.floor(Date.now() / 1000),
    sessionId,
  }, 600);
  const token = mcryptEncode(sessionId, currentKey);
  return c.json({ code: true, data: currentKey + token });
}

/** 001 clientPlugin::checkPass: 校验登录密码 (POST sign/pass), pass 为 authCrypt.encode(明文, sign)。 */
async function clientCheckPassHandler(c: any): Promise<Response> {
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!user) return c.json({ code: false, data: "user.loginFirst" });
  const p = await clientAllParams(c);
  const sign = p.sign || "";
  const pass = p.pass || "";
  const password = mcryptDecode(pass, sign);
  if (!password) return c.json({ code: false, data: "ERROR_USER_PASSWORD_ERROR" });
  const row = await getUserByUsername(c.env.DB, user.username);
  if (!row || !(await verifyPassword(password, (row as any).password_hash))) {
    return c.json({ code: false, data: "ERROR_USER_PASSWORD_ERROR" });
  }
  return c.json({ code: true, data: "explorer.success" });
}

/** 001 clientPlugin::check: 检查扫码登录状态 (GET)。 */
async function clientCheckHandler(c: any): Promise<Response> {
  const user = c.get("currentUser") as AuthUser | undefined;
  if (user) return c.json({ code: true, data: "explorer.success" });
  return c.json({ code: false, data: null });
}

/** 001 clientPlugin::loginWeb / loginApp: 扫码登录确认 (POST token)。 */
async function clientLoginAppHandler(c: any): Promise<Response> {
  const p = await clientAllParams(c);
  const token = p.token || "";
  const currentKey = token.slice(0, 8);
  const raw = token.slice(8);
  if (!currentKey || !raw) return c.json({ code: false, data: "client.app.scanError" });
  const state = await pluginCacheGet(c.env.DB, `clientQrcode:${currentKey}`);
  if (!state || !state.sessionId) return c.json({ code: false, data: "client.app.scanError(disable)" });
  if (Math.floor(Date.now() / 1000) - Number(state.time || 0) > 300) {
    return c.json({ code: false, data: "client.app.scanError(timeout)" });
  }
  const sessionId = mcryptDecode(raw, currentKey);
  if (!sessionId || sessionId !== state.sessionId) {
    return c.json({ code: false, data: "client.app.scanError(sign)" });
  }
  // 已登录用户信息回传, 供 web 端 session 确认
  const user = c.get("currentUser") as AuthUser | undefined;
  if (!user) return c.json({ code: false, data: "user.loginFirst" });
  await pluginCacheSet(c.env.DB, `clientQrcode:${currentKey}`, { ...state, loginUser: { id: user.id, username: user.username } }, 600);
  return c.json({ code: true, data: "explorer.success" });
}

// ---------- oauth 第三方登录回调页 (复刻 001 plugins/oauth callback) ----------

async function oauthCallbackHandler(c: any): Promise<Response> {
  const tpl = await loadTemplate(c.env.ASSETS, "plugins/oauth/static/oauth/index.html");
  if (!tpl) return c.json({ code: false, data: "oauth template not found" });
  return c.body(tpl, 200, { "Content-Type": "text/html; charset=utf-8" });
}

// ---------- msgWarning 通知中心 (复刻 001 plugins/msgWarning) ----------

async function msgWarningNoticeHandler(c: any): Promise<Response> {
  // 001 msgWarning 通知依赖计划任务与预警规则表; 云端无预警数据时返回空列表
  return c.json({ code: true, data: [] });
}

async function msgWarningTaskInfoHandler(c: any): Promise<Response> {
  return c.json({ code: true, data: null });
}

// ---------- storeImport 存储导入 (复刻 001 plugins/storeImport) ----------

async function storeImportCheckHandler(c: any): Promise<Response> {
  // 001 storeImport 扫描对象存储构建索引; 云端对象存储扫描返回基础统计
  return c.json({ code: true, data: { folder: 0, file: 0 } });
}

async function storeImportLogGetHandler(c: any): Promise<Response> {
  return c.json({ code: true, data: [] });
}

pluginApi.all("/:name", (c) => pluginHandler(c));
pluginApi.all("/:name/", (c) => pluginHandler(c));
pluginApi.all("/:name/:act", (c) => pluginHandler(c));

async function pluginHandler(c: any) {
  const name = c.req.param("name");
  const act = c.req.param("act") || "";
  const rawPath = c.req.query("path") || "";
  const fileName = c.req.query("name") || "";
  const ext = (c.req.query("ext") || "").toLowerCase();

  const appHost = getAppHost(c);
  const staticPath = getStaticHost(c);
  // 已登录用户优先用其 DB 中保存的语言配置兜底(cookie kodUserLanguage 缺失时,
  // 避免被浏览器 Accept-Language 覆盖成英文/其他语言)。
  const curUser = c.get("currentUser") as AuthUser | undefined;
  let userConfigLang = "";
  if (curUser && curUser.config_json) {
    try {
      userConfigLang = String(JSON.parse(curUser.config_json).language || "");
    } catch {
      userConfigLang = "";
    }
  }
  const lang = detectLang(c, userConfigLang);

  // 通用匿名文件流端点(001 filePathLinkOut 契约, fileView apiKey 签名, 中间件已放行)
  if (act === "fileOut") return streamFileByToken(c, c.req.query());

  if (name === "pdfjs") {
    return renderPdfjs(c, { rawPath, fileName, appHost, staticPath, lang });
  }

  if (name === "simpleClock") {
    return renderSimpleClock(c, { staticPath });
  }

  if (name === "webodf") {
    return renderWebodf(c, { rawPath, fileName, ext, appHost, staticPath, lang });
  }

  if (name === "officeViewer") {
    if (act === "editApp") {
      // no office editor is configured; keep the viewer read-only
      return c.json({ code: false, data: "没有有效的文件编辑方式" });
    }
    const lng = await officeViewerLng(c.env.ASSETS, lang);
    const title = lng["officeViewer.meta.name"] || "Office阅读器";
    // wb 解析失败后前端会带着 skip=wb 重新加载；没有其他 fallback 方式时直接报错，避免死循环
    if (c.req.query("skip") === "wb") {
      return c.body(errorPage(title, lng["officeViewer.main.invalidType"] || "无法预览"), 200, HTML_HEADERS);
    }
    return renderOfficeViewer(c, { rawPath, fileName, ext, appHost, staticPath, lang }, lng);
  }

  if (name === "OnlyOffice") {
    // file/save 为匿名端点(中间件已放行), 这里独立处理
    if (act === "file") return onlyOfficeFileHandler(c);
    if (act === "save") return onlyOfficeSaveHandler(c);
    return renderOnlyOffice(c, { rawPath, fileName, ext, appHost, staticPath, lang });
  }

  if (name === "CADViewer") {
    return renderCADViewer(c, { rawPath, fileName, appHost, lang });
  }

  if (name === "drawio") {
    if (act === "save") return drawioSaveHandler(c);
    return renderDrawio(c, { rawPath, fileName, appHost, staticPath, lang });
  }

  if (name === "Photopea") {
    if (act === "saveImg") return photopeaSaveHandler(c);
    return renderPhotopea(c, { rawPath, fileName, ext, appHost, staticPath, lang });
  }

  if (name === "bisheng") {
    if (act === "save") return bishengSaveHandler(c);
    if (act === "filePost") return bishengFilePostHandler(c);
    return renderBisheng(c, { rawPath, fileName, ext, appHost, staticPath, lang });
  }

  if (name === "PDFTron") {
    if (act === "save") return pdfTronSaveHandler(c);
    return renderPdfTron(c, { rawPath, fileName, appHost, staticPath, lang });
  }

  if (name === "officeLive") {
    return renderOfficeLive(c, { rawPath, fileName, appHost });
  }

  if (name === "yzOffice") {
    if (act === "task") return yzOfficeTaskHandler(c);
    if (act === "restart") return yzOfficeRestartHandler(c);
    if (act === "getFile") return yzOfficeGetFileHandler(c);
    return renderYzOffice(c, { rawPath, fileName, appHost, staticPath, lang });
  }

  if (name === "fileThumb") {
    if (act === "cover") return fileThumbCoverHandler(c);
    if (act === "videoSmall") return fileThumbVideoSmallHandler(c);
    return c.json({ code: false, data: "未知插件" });
  }

  if (name === "adminer") {
    if (act === "tables") return adminerTablesHandler(c);
    if (act === "query") return adminerQueryHandler(c);
    return renderAdminer(c);
  }

  if (name === "client") {
    if (act === "qrcodeToken") return clientQrcodeTokenHandler(c);
    if (act === "checkPass") return clientCheckPassHandler(c);
    if (act === "check") return clientCheckHandler(c);
    if (act === "loginWeb" || act === "loginApp") return clientLoginAppHandler(c);
    return c.json({ code: false, data: "未知插件" });
  }

  if (name === "oauth") {
    if (act === "callback") return oauthCallbackHandler(c);
    return c.json({ code: false, data: "未知插件" });
  }

  if (name === "msgWarning") {
    if (act === "notice" || act === "autoTask") return msgWarningNoticeHandler(c);
    if (act === "taskInfo") return msgWarningTaskInfoHandler(c);
    return c.json({ code: false, data: "未知插件" });
  }

  if (name === "storeImport") {
    if (act === "check") return storeImportCheckHandler(c);
    if (act === "logGet") return storeImportLogGetHandler(c);
    return c.json({ code: false, data: "未知插件" });
  }

  return c.json({ code: false, data: "未知插件" });
}

export { pluginApi };
