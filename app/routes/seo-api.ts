/**
 * Seo API - 搜索引擎优化页面 (复刻 001 explorer/seo)
 *
 * 匿名路由(不经过 authRequired): 供搜索引擎抓取外链分享页面与文件。
 *  - siteMap: allowSEO != 1 时 404; st=index 分享列表 / st=share 分享内容 / st=file 分享文件下载
 *  - makeFooter / echoContent: 模板片段(HTML 字符串)
 */
import { Hono } from "hono";
import { keyFromBase } from "../lib/r2";
import { resolveFileSource } from "../lib/source";
import type { AuthUser } from "../lib/auth";
import { getSetting } from "../lib/db";

const seoApi = new Hono<{ Bindings: Env }>();

type AppContext = any;

/** 001 is_text_file: 按扩展名判断文本文件 */
const SEO_TEXT_EXTS = new Set([
  "txt", "md", "markdown", "html", "htm", "xml", "json", "js", "mjs", "cjs", "css", "scss", "less",
  "ts", "tsx", "jsx", "vue", "php", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "hpp", "cs",
  "sh", "bat", "ps1", "sql", "yml", "yaml", "ini", "conf", "cfg", "log", "csv", "gitignore", "env",
  "license", "readme", "conf", "diff", "patch",
]);
const SEO_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "bmp", "ico", "gif", "webp"]);
const SEO_MOVIE_EXTS = new Set(["mov", "mp4", "webm", "m4v", "mkv"]);
const SEO_PAGE_SIZE = 15;

function escHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sizeFormat(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

async function seoShareByHash(env: Env, hash: string): Promise<any | null> {
  if (!hash) return null;
  const row = await env.DB.prepare("SELECT * FROM share WHERE shareHash = ?")
    .bind(hash)
    .first()
    .catch(() => null);
  return row || null;
}

/** 从 users 表取分享者身份, 用于解析分享源文件路径 */
async function seoShareUser(env: Env, userID: number): Promise<AuthUser> {
  const row: any = await env.DB.prepare("SELECT id, username, nickname, email, phone, avatar, role, status FROM users WHERE id = ?")
    .bind(userID)
    .first()
    .catch(() => null);
  const nickname = row?.nickname || row?.username || "guest";
  return {
    id: row ? row.id : 0,
    username: row?.username || "guest",
    nickname,
    email: row?.email || "",
    phone: row?.phone || "",
    avatar: row?.avatar || "",
    sex: 0,
    role: row && (row.role === "admin" || row.role === "root") ? "admin" : "user",
    status: row ? row.status : 0,
    config_json: "",
  };
}

/** 001 seo shareCheck: 校验分享有效性, 返回错误信息或 false */
function seoShareCheck(shareInfo: any): string | false {
  if (!shareInfo) return "分享不存在或已失效";
  let options: Record<string, any> = {};
  try {
    options = JSON.parse(shareInfo.options || "{}");
  } catch {
    options = {};
  }
  const timeTo = parseInt(String(shareInfo.timeTo ?? 0), 10) || 0;
  if (timeTo && timeTo < Math.floor(Date.now() / 1000)) return "分享已过期";
  if (shareInfo.password) return "该分享需要密码访问";
  if (String(options.notDownload) === "1") return "该分享不允许下载";
  if (String(options.onlyLogin) === "1") return "该分享仅限登录用户访问";
  const downloadNumber = parseInt(String(options.downloadNumber ?? "0"), 10) || 0;
  const numDownload = parseInt(String(shareInfo.numDownload ?? "0"), 10) || 0;
  if (downloadNumber && numDownload >= downloadNumber) return "分享下载次数已达上限";
  return false;
}

/** 解析分享源文件信息: 返回 { key, size, type, ext, name, isFolder } 或 null */
async function seoResolvePath(c: AppContext, shareInfo: any, viewPath: string): Promise<any | null> {
  const user = await seoShareUser(c.env, parseInt(String(shareInfo.userID ?? "0"), 10) || 0);
  const fullPath = String(shareInfo.sourcePath || "") + (viewPath ? "/" + viewPath : "");
  const src = await resolveFileSource(c.env, user, fullPath);
  if (!src.ok) return null;
  const key = keyFromBase(src.source.baseKey, src.relPath);
  const name = (src.relPath.split("/").filter(Boolean).pop() || shareInfo.title || "file");
  const extMatch = name.match(/\.([^./]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : "";

  if (src.relPath.endsWith("/") || src.relPath === "/") {
    const listed = await c.env.FILES.list({ prefix: key.endsWith("/") ? key : key + "/", limit: 1 }).catch(() => null);
    if (!listed || listed.objects.length === 0) return null;
    return { key, name, type: "folder", ext: "", size: 0, isFolder: true };
  }
  const head = await c.env.FILES.head(key).catch(() => null);
  if (!head) return null;
  return { key, name, type: "file", ext, size: head.size, isFolder: false, uploaded: head.uploaded };
}

function seoShareLink(shareInfo: any, viewPath = "", page = "share", keep = false): string {
  const view = viewPath ? "&view=" + encodeURIComponent(viewPath).replace(/%2F/gi, "/") : "";
  const keepQ = keep ? "&keep=1" : "";
  return `/seo/siteMap?st=${page}&act=${encodeURIComponent(shareInfo.shareHash)}${view}${keepQ}`;
}

/** 分享条目 HTML (shareMakeItem) */
function seoShareMakeItem(shareInfo: any): string {
  const link = seoShareLink(shareInfo);
  const size = sizeFormat(parseInt(String(shareInfo.size ?? "0"), 10) || 0);
  const user = shareInfo.nickName || shareInfo.userName || shareInfo.name || "";
  const time = (shareInfo.createTime || "").toString().slice(0, 16).replace("T", " ");
  const type = shareInfo.fileType || "file";
  const ext = type === "folder" ? "folder" : shareInfo.fileExt || "";
  return `
		<li class="file-item">
			<a class="file-link" href="${link}"></a>
			<span class="title-item item-name">
				<i class="path-ico"><i class="x-item-icon x-${escHtml(ext)} small"></i></i>
				<a href="${link}">${escHtml(shareInfo.title || "")}</a>
			</span>
			<span class="title-item item-user">${escHtml(user)}</span>
			<span class="title-item item-size">${size}</span>
			<span class="title-item item-time">${escHtml(time)}</span>
		</li>`;
}

/** 分享列表页 HTML (shareList) */
async function seoShareList(c: AppContext): Promise<string> {
  const params = c.req.query();
  const page = Math.max(parseInt(params.page || "1", 10) || 1, 1);
  const now = Math.floor(Date.now() / 1000);
  const where = `WHERE isLink = 1 AND password = '' AND (timeTo = 0 OR timeTo > ${now})`;
  const countRow: any = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM share ${where}`).first().catch(() => null);
  const total = parseInt(countRow?.total ?? "0", 10) || 0;
  const pageTotal = Math.max(1, Math.ceil(total / SEO_PAGE_SIZE));
  const offset = (page - 1) * SEO_PAGE_SIZE;
  const rows: any[] = (await c.env.DB.prepare(
    `SELECT * FROM share ${where} ORDER BY createTime DESC LIMIT ? OFFSET ?`
  ).bind(SEO_PAGE_SIZE, offset).all().catch(() => ({ results: [] as any[] }))).results || [];

  const userCache: Record<string, AuthUser> = {};
  let listHtml = "";
  for (const row of rows) {
    const uid = parseInt(String(row.userID ?? "0"), 10) || 0;
    if (!userCache[uid]) userCache[uid] = await seoShareUser(c.env, uid);
    const u = userCache[uid];
    const pathInfo = await seoResolvePath(c, row, "");
    let fileType = "file";
    let fileExt = "";
    let size = 0;
    if (pathInfo) {
      fileType = pathInfo.type;
      fileExt = pathInfo.ext;
      size = pathInfo.size;
    }
    listHtml += seoShareMakeItem({ ...row, size, nickName: u.nickname, userName: u.nickname, fileType, fileExt });
  }
  if (!listHtml) {
    listHtml = "<div class='grey-6 align-center mt-30'>没有数据</div>";
  } else {
    listHtml = `
			<li class="file-item header">
				<span class="title-item item-name">名称</span>
				<span class="title-item item-user">分享者</span>
				<span class="title-item item-size">大小</span>
				<span class="title-item item-time">分享时间</span>
			</li>` + listHtml;
  }

  // 分页 makePage
  let pageHtml = "";
  if (pageTotal > 1) {
    const linkPre = "/seo/siteMap?st=index&page=";
    let items = "";
    for (let i = 1; i <= pageTotal; i++) {
      if (i === page) items += `<a href="${linkPre}${i}" class="current">${i}</a>\n`;
      else items += `<a href="${linkPre}${i}">${i}</a>\n`;
    }
    if (pageTotal > SEO_PAGE_SIZE) {
      items = `<a href="${linkPre}1" class="page-first">首页</a>\n` + items;
      items += `<a href="${linkPre}${pageTotal}" class="page-last">末页</a>\n`;
    }
    pageHtml = `<div class="page-box">\n${items}<span class="page-info-text">${pageTotal}页 (${total}项)</span>\n</div>`;
  }
  return `<h3>外链分享</h3><ul class="list-file list-file-share">${listHtml}</ul>${pageHtml}`;
}

/** 分享文件夹子文件列表 HTML (shareViewFolder) */
async function seoShareViewFolder(c: AppContext, shareInfo: any, pathInfo: any): Promise<string> {
  const prefix = pathInfo.key.endsWith("/") ? pathInfo.key : pathInfo.key + "/";
  const listed = await c.env.FILES.list({ prefix, limit: 2000 }).catch(() => null);
  const objects = listed?.objects || [];
  const viewPath = ""; // 由调用方拼入 shareLink
  let listHtml = "";
  const rows: Array<{ key: string; name: string; type: string; ext: string; size: number }> = [];
  for (const o of objects) {
    const rel = o.key.slice(prefix.length);
    if (!rel || rel.startsWith(".")) continue;
    const name = rel.split("/").filter(Boolean)[0] || rel;
    const isFolder = rel.endsWith("/") || o.key.endsWith("/");
    if (isFolder) {
      rows.push({ key: o.key, name, type: "folder", ext: "folder", size: 0 });
      continue;
    }
    const extMatch = name.match(/\.([^./]+)$/);
    rows.push({ key: o.key, name, type: "file", ext: extMatch ? extMatch[1].toLowerCase() : "", size: o.size });
  }
  // 001: 文件夹按 name 排序, 文件按 name 排序 (KodSort::arraySort)
  const folders = rows.filter((r) => r.type === "folder").sort((a, b) => a.name.localeCompare(b.name));
  const files = rows.filter((r) => r.type === "file").sort((a, b) => a.name.localeCompare(b.name));
  const listAll = [...folders, ...files].slice(0, 2000);
  for (const p of listAll) {
    const rel = p.name;
    const link = seoShareLink(shareInfo, rel);
    const size = p.type === "folder" ? "" : sizeFormat(p.size);
    const ext = p.type === "folder" ? "folder" : p.ext;
    listHtml += `
			<li class="file-item ${p.type}">
				<a class="file-link" href="${link}"></a>
				<span class="title-item item-name">
					<i class="path-ico"><i class="x-item-icon x-${escHtml(ext)} small"></i></i>
					<a href="${link}">${escHtml(p.name)}</a>
				</span>
				<span class="title-item item-size">${size}</span>
				<span class="title-item item-time"></span>
			</li>`;
  }
  if (!listAll.length) {
    listHtml = "<div class='grey-6 align-center mt-30'>没有数据</div>";
  } else {
    listHtml = `
			<li class="file-item header">
				<span class="title-item item-name">名称</span>
				<span class="title-item item-size">大小</span>
				<span class="title-item item-time">修改时间</span>
			</li>` + listHtml;
  }
  void viewPath;
  return `\n<ul class="list-file list-file-folder">${listHtml}</ul>\n`;
}

/** 分享内容页 HTML (shareView) */
async function seoShareView(c: AppContext, hash: string): Promise<{ html: string; status: number }> {
  const params = c.req.query();
  const viewPath = String(params.view || "").replace(/^\/+|\/+$/g, "");
  const shareInfo = await seoShareByHash(c.env, hash);
  const err = seoShareCheck(shareInfo);
  if (err) {
    return { html: `<div class="info-alert info-alert-red"><p>${escHtml(err)}</p></div>`, status: 404 };
  }
  const linkPage = seoShareLink(shareInfo);
  const pathInfo = await seoResolvePath(c, shareInfo, viewPath);
  if (!pathInfo) {
    return { html: `<div class="info-alert info-alert-red"><p>路径不存在</p></div>`, status: 404 };
  }

  let shareDesc = seoShareMakeItem({ ...shareInfo, size: pathInfo.size, fileType: pathInfo.type, fileExt: pathInfo.ext });
  let addressHtml = `<a href="${linkPage}">${escHtml(shareInfo.title || "")}</a>`;
  if (viewPath) {
    const parts = viewPath.split("/").filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc = acc ? acc + "/" + part : part;
      addressHtml += ` / <a href="${seoShareLink(shareInfo, acc)}">${escHtml(part)}</a>`;
    }
  }
  let html = `
		<div class="share-header-info">${shareDesc}</div>
		<div class="address-info">位置: ${addressHtml}</div>`;

  const linkFile = seoShareLink(shareInfo, viewPath, "file");
  if (pathInfo.type === "folder") {
    html += await seoShareViewFolder(c, shareInfo, pathInfo);
  } else if (SEO_TEXT_EXTS.has(pathInfo.ext)) {
    const obj = await c.env.FILES.get(pathInfo.key, { range: { length: 500 * 1024 } }).catch(() => null);
    const content = obj ? await obj.text().catch(() => "") : "";
    html += `<p><pre class="the-code"><code>${escHtml(content)}</code></pre></p>`;
  } else if (SEO_IMAGE_EXTS.has(pathInfo.ext)) {
    html += `<p class="content-file"><img src="${linkFile}" /></p>`;
  } else if (SEO_MOVIE_EXTS.has(pathInfo.ext)) {
    html += `<video class="content-file" src="${linkFile}" controls="controls"></video>`;
  } else {
    html += `
			<div class="content-download">
				<a class="kui-btn kui-btn-blue" href="${linkFile}" target="_blank">下载</a>
				<div class="grey-6">该文件类型暂不支持在线预览</div>
			</div>`;
  }
  return { html, status: 200 };
}

async function seoShareFileOut(c: AppContext, hash: string): Promise<Response> {
  const params = c.req.query();
  const viewPath = String(params.view || "").replace(/^\/+|\/+$/g, "");
  const shareInfo = await seoShareByHash(c.env, hash);
  const err = seoShareCheck(shareInfo);
  if (err) return c.text("Not allow!", 404);
  const pathInfo = await seoResolvePath(c, shareInfo, viewPath);
  if (!pathInfo || pathInfo.type !== "file") return c.text("Not allow!", 404);
  const obj = await c.env.FILES.get(pathInfo.key).catch(() => null);
  if (!obj) return c.text("Not allow!", 404);
  const headers = new Headers();
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(pathInfo.name)}"`);
  obj.writeHttpMetadata(headers);
  return new Response(obj.body, { headers });
}

/** 渲染整个 SEO 页面外壳 */
function seoPage(title: string, bodyHtml: string): Response {
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<style>
	body{position:relative !important;width:auto;height:auto;background:#f0f2f5;overflow:auto !important;padding:20px;font-family:Arial,"Microsoft YaHei",sans-serif;}
	.page-view-search{max-width:960px;margin:0 auto;background:#fff;padding:20px;border-radius:6px;}
	.page-footer{display:block !important;text-align:center;color:#aaa;margin-top:16px;}
	.page-footer h3{display:inline-block;font-size:13px;font-weight:400;margin:0 8px;}
	.list-file{list-style:none;padding:0;margin:0;}
	.list-file li{padding:8px 10px;border-bottom:1px solid #eee;position:relative;}
	.list-file li.header{background:#fafafa;font-weight:600;}
	.title-item{display:inline-block;vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
	.item-name{width:52%;}.item-user{width:16%;}.item-size{width:10%;}.item-time{width:18%;}
	.list-file-folder .item-name{width:76%;}.list-file-folder .item-size{width:12%;}
	.file-link{position:absolute;inset:0;opacity:0;}
	.info-alert-red{background:#fdecea;border:1px solid #f5c6cb;color:#b02a37;padding:12px;border-radius:4px;}
	.address-info{margin:10px 0;color:#888;}
	.address-info a{color:#0d6efd;text-decoration:none;}
	.content-file{text-align:center;} .content-file img{max-width:100%;}
	.the-code{background:#f6f8fa;padding:12px;border-radius:4px;overflow:auto;font-size:13px;}
	.page-box{text-align:center;margin-top:14px;color:#888;}
	.page-box a{margin:0 4px;color:#0d6efd;text-decoration:none;}.page-box a.current{font-weight:700;}
	.content-download{text-align:center;padding:30px;}
	.kui-btn-blue{background:#0d6efd;color:#fff;padding:10px 26px;border-radius:4px;text-decoration:none;display:inline-block;}
	.grey-6{color:#888;margin-top:8px;}
</style>
</head>
<body>
	<div class="page-view-search">${bodyHtml}
		<div class="page-footer">
			<h3><a href="https://github.com/kalcaddle/kodbox" target="_blank">Powered by MinelibsBox</a></h3>
		</div>
	</div>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function seoAllowCheck(c: AppContext): Promise<boolean> {
  const allowSEO = await getSetting(c.env.DB, "allowSEO").catch(() => null);
  return String(allowSEO ?? "") === "1";
}

// ============ routes ============
// 挂载于 apiRoutes "/seo" 前缀下(URL /seo/...), 不经过任何 authRequired

seoApi.all("/check", async (c) => {
  return c.json({ code: true, data: "ok" });
});

seoApi.get("/makeFooter", async (c) => {
  const html = "<div class='page-footer' style='display:none;'>\n\t<h3>Powered by <a href='https://github.com/kalcaddle/kodbox' target='_blank'>MinelibsBox</a></h3>\n</div>";
  return c.text(html);
});

seoApi.get("/echoContent", async (c) => {
  return c.text("");
});

seoApi.get("/siteMap", async (c) => {
  if (!(await seoAllowCheck(c))) {
    return new Response("Not allow robots!", { status: 404 });
  }
  const params = c.req.query();
  const st = params.st || "index";
  const act = params.act || "";
  try {
    if (st === "index") {
      return seoPage("外链分享", await seoShareList(c));
    }
    if (st === "share") {
      const r = await seoShareView(c, act);
      return seoPage("分享预览", r.html);
    }
    if (st === "file") {
      return await seoShareFileOut(c, act);
    }
  } catch (err: any) {
    return new Response("Internal Error", { status: 500 });
  }
  return new Response("Not allow robots!", { status: 404 });
});

export { seoApi };
