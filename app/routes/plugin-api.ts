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
import { authRequired } from "../lib/auth";
import type { AuthUser } from "../lib/auth";
import { getAppHost, getStaticHost } from "../lib/user-system";
import { detectLang, loadLangPack } from "../lib/i18n-lang";
import { loadPluginLang } from "../lib/plugins";
import { getUserFileKey } from "../lib/r2";
import { getShareByHash } from "../lib/share";
import { getUserById } from "../lib/db";
import { parseShareLinkRel, joinShareRealPath } from "./share-api";

type Vars = { currentUser: AuthUser };
const pluginApi = new Hono<{ Bindings: Env; Variables: Vars }>();

// 分享落地页(guest)打开 PDF/Office 等文件时, 插件预览页面需要公开访问;
// 其余场景(主应用登录态)仍要求登录。
pluginApi.use("*", async (c, next) => {
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
    ["@@fileUrl@@", fileOutUrl(appHost, rawPath)],
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
  const key = await resolveFileKey(c, rawPath);
  const obj = key ? await c.env.FILES.head(key).catch(() => null) : null;
  if (!obj) {
    const global = await loadLangPack(c.env.ASSETS, lang);
    const msg = (global && global["common.pathNotExists"]) || "文件不存在";
    return c.body(errorPage(title, msg), 200, HTML_HEADERS);
  }
  if (obj.size === 0) {
    return c.body(errorPage(title, lng["officeViewer.main.fileSizeErr"] || "文件已损坏（size=0），无法预览！"), 200, HTML_HEADERS);
  }

  const tpl = await loadTemplate(c.env.ASSETS, "plugins/officeViewer/static/weboffice/template.html");
  if (!tpl) return c.json({ code: false, data: "officeViewer template not found" });

  const pluginHost = `${staticPath}plugins/officeViewer/`;

  const html = replaceAll(tpl, [
    ["@@fileName@@", jsEscape(fileName)],
    ["@@fileNameHtml@@", htmlEscape(fileName)],
    ["@@fileUrl@@", jsEscape(fileOutUrl(appHost, rawPath))],
    ["@@filePath@@", jsEscape(rawPath)],
    ["@@fileApp@@", app],
    ["@@fileExt@@", jsEscape(ext)],
    ["@@canWrite@@", "0"],
    ["@@fileAppBoxClass@@", `kod-${app}-box ${ext}`],
    ["@@pluginHost@@", pluginHost],
    ["@@pluginApi@@", `${appHost}index.php?plugin/officeViewer/`],
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
  const key = await resolveFileKey(c, rawPath);
  const obj = key ? await c.env.FILES.head(key).catch(() => null) : null;
  if (!obj) {
    const global = await loadLangPack(c.env.ASSETS, lang);
    const msg = (global && global["common.pathNotExists"]) || "文件不存在";
    return c.body(errorPage(title, msg), 200, HTML_HEADERS);
  }
  if (obj.size === 0) {
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
    ["@@fileUrl@@", jsEscape(fileOutUrl(appHost, rawPath))],
    ["@@odtStyle@@", odtStyle],
  ]);
  return c.body(html, 200, { "Content-Type": "text/html; charset=utf-8" });
}

// ---------- route ----------

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
  const lang = detectLang(c);

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

  return c.json({ code: false, data: "未知插件" });
}

export { pluginApi };
