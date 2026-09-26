/**
 * WebDAV 服务端 (复刻 001 plugins/webdav)。
 *
 * 001 webdavPlugin::route: MOD==='dav' 时 run('/index.php/dav/'),
 * plugin.webdav 时 run('/index.php/plugin/webdav/{name}/')。
 * 独立模块, 不走登录态, 权限在内部自行处理 (Basic Auth 或 session cookie)。
 *
 * 路径映射 (001 webdavServerKod::parsePath):
 *   pathAllow=='self' -> 根为 {source:home} (个人空间)
 *   pathAllow=='all'  -> 根为 {block:files} (第一层: 个人空间/我所在的部门)
 */
import { Hono } from "hono";
import type { AuthUser } from "../lib/auth";
import { verifyPassword } from "../lib/auth";
import { getUserByUsername, getUserById, getSession, getPluginMeta } from "../lib/db";
import { resolveFileSource } from "../lib/source";
import { keyFromBase, listDirectory, deleteDirectory, getFileMimeType } from "../lib/r2";
import { detectLang, loadLangPack } from "../lib/i18n-lang";
import { getSessionId } from "../lib/auth";

type Vars = { currentUser: AuthUser };

const DAV_XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>\n';

// ---------- 响应辅助 ----------

function davResponse(code: number, body?: string, headers?: Record<string, string>): Response {
  const h = new Headers(headers || {});
  h.set("Pragma", "no-cache");
  h.set("Cache-Control", "no-cache");
  h.set("X-DAV-BY", "kodbox");
  if (body !== undefined) {
    h.set("Content-Type", "application/xml; charset=utf-8");
    return new Response(DAV_XML_HEADER + body, { status: code, headers: h });
  }
  return new Response(null, { status: code, headers: h });
}

function errorBody(title: string, desc: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<D:error xmlns:D="DAV:" xmlns:S="http://kodcloud.com"><S:exception>${esc(title)}</S:exception><S:message>${esc(desc)}</S:message></D:error>`;
}

// ---------- 认证 ----------

function rowToUser(row: any): AuthUser {
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

/** Basic Auth 或 session cookie 认证, 返回 AuthUser 或 null。 */
async function webdavAuth(env: Env, request: Request): Promise<AuthUser | null> {
  // 1. session cookie (已登录场景)
  const cookie = request.headers.get("cookie") || "";
  const sid = (cookie.match(/(?:^|;\s*)kod_session=([^;]+)/) || [])[1] || "";
  if (sid) {
    const session = await getSession(env.DB, sid);
    if (session) return rowToUser(session);
  }
  // 2. Basic Auth
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  let decoded = "";
  try {
    decoded = atob(m[1].trim());
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  let username = decoded.slice(0, idx);
  const password = decoded.slice(idx + 1);
  // 001: webdav 挂载中文用户名编码处理 '$$'+rawurlencode
  if (username.startsWith("$$")) {
    try {
      username = decodeURIComponent(username.slice(2));
    } catch {
      /* ignore */
    }
  }
  // Windows: 'DOMAIN\user' 取 '\' 之后
  const pos = username.lastIndexOf("\\");
  if (pos >= 0) username = username.slice(pos + 1);

  const row = await getUserByUsername(env.DB, username);
  if (!row) return null;
  if (!(await verifyPassword(password, (row as any).password_hash))) return null;
  return rowToUser(row);
}

// ---------- 路径解析 ----------

/** webdav 请求路径中的相对路径 (去前缀, 未解码前先解)。 */
function davRelPath(url: URL): string {
  const path = url.pathname;
  let m = path.match(/\/index\.php\/dav\/(.*)$/);
  if (!m) m = path.match(/\/dav\/(.*)$/);
  if (!m) m = path.match(/\/index\.php\/plugin\/webdav\/[^/]*\/(.*)$/);
  if (!m) m = path.match(/\/plugin\/webdav\/[^/]*\/(.*)$/);
  let rel = m ? m[1] : "";
  try {
    rel = decodeURIComponent(rel);
  } catch {
    /* keep raw */
  }
  return rel.replace(/\/+/g, "/");
}

/** 个人空间根虚拟路径。 */
function personalRoot(): string {
  return "{source:home}/";
}

/** {block:files} 第一层: 个人空间 + 我所在的部门。返回 [{name, path}]。 */
async function blockFilesRoot(env: Env, user: AuthUser, lang: string): Promise<Array<{ name: string; path: string }>> {
  const global = await loadLangPack(env.ASSETS, lang);
  const rootName = (global && global["explorer.toolbar.rootPath"]) || "个人空间";
  const list: Array<{ name: string; path: string }> = [{ name: rootName, path: "{source:home}/" }];
  // 我所在的部门
  const groups = await env.DB.prepare(
    "SELECT g.id, g.name FROM groups g JOIN user_groups ug ON g.id = ug.group_id WHERE ug.user_id = ? AND g.status = 1"
  )
    .bind(user.id)
    .all<{ id: number; name: string }>()
    .catch(() => null);
  if (groups && groups.results) {
    for (const g of groups.results) {
      list.push({ name: g.name, path: `{source:${g.id}}/` });
    }
  }
  return list;
}

/**
 * webdav 相对路径 -> 虚拟路径。
 * pathAllow=='self': 直接映射到 {source:home}。
 * pathAllow=='all' : 第一段为 {block:files} 虚拟目录名, 映射到对应 source。
 * 返回 null 表示不存在/无权限。
 */
async function resolveDavVirtualPath(
  env: Env,
  user: AuthUser,
  davRel: string,
  config: Record<string, any>,
  lang: string
): Promise<string | null> {
  const pathAllow = String(config.pathAllow || "all");
  const rel = davRel.replace(/^\/+/, "").replace(/\/+$/, "");

  if (pathAllow === "self") {
    return rel ? `{source:home}/${rel}` : "{source:home}/";
  }

  // all: {block:files}
  if (!rel) return "{block:files}";
  const segs = rel.split("/");
  const root = await blockFilesRoot(env, user, lang);
  const first = root.find((r) => r.name === segs[0]);
  if (!first) return null;
  const rest = segs.slice(1).join("/");
  return rest ? `${first.path}${rest}` : first.path;
}

/** 解析为 source + relPath; 虚拟块根 {block:files} 特殊处理 (返回 block:true)。 */
type DavResolve =
  | { ok: true; source: import("../lib/source").SourceRef; relPath: string; block?: boolean }
  | { ok: false; error: string; block?: boolean };

async function resolveDavSource(env: Env, user: AuthUser, virtual: string): Promise<DavResolve> {
  if (virtual === "{block:files}") {
    return { ok: true, source: { sourceId: "files", type: "user", baseKey: "", targetID: user.id, displayName: "全部文件" } as any, relPath: "/", block: true };
  }
  const r = await resolveFileSource(env, user, virtual);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, source: r.source, relPath: r.relPath };
}

// ---------- 文件操作辅助 ----------

function nameOf(relPath: string): string {
  return relPath.split("/").filter(Boolean).pop() || "";
}

/** R2 或 io 是否存在 (文件或目录)。 */
async function davExists(env: Env, source: import("../lib/source").SourceRef, relPath: string): Promise<"file" | "folder" | null> {
  // 存储根 (个人空间/部门根) 始终存在, 即使为空
  if (relPath === "/" || relPath === "") return "folder";
  const key = keyFromBase(source.baseKey, relPath);
  // 目录: 以 / 结尾
  if (relPath.endsWith("/")) {
    const dirKey = key.endsWith("/") ? key : key + "/";
    const listed = await env.FILES.list({ prefix: dirKey, delimiter: "/", limit: 1 });
    if ((listed.delimitedPrefixes && listed.delimitedPrefixes.length) || (listed.objects && listed.objects.length)) return "folder";
    return null;
  }
  const head = await env.FILES.head(key).catch(() => null);
  if (head) return "file";
  // 也可能是目录占位 key/ (以 / 结尾)
  const dirKey = key + "/";
  const listed = await env.FILES.list({ prefix: dirKey, delimiter: "/", limit: 1 });
  if ((listed.delimitedPrefixes && listed.delimitedPrefixes.length) || (listed.objects && listed.objects.length)) return "folder";
  return null;
}

/** 列出目录: 返回 [{name, type, size, modifyTime}]。 */
async function davListDir(
  env: Env,
  source: import("../lib/source").SourceRef,
  relPath: string
): Promise<Array<{ name: string; type: "file" | "folder"; size: number; modifyTime: Date }>> {
  const dirPath = relPath.endsWith("/") ? relPath.slice(0, -1) : relPath;
  const { folders, files } = await listDirectory(env.FILES, source.baseKey, dirPath || "/");
  const out: Array<{ name: string; type: "file" | "folder"; size: number; modifyTime: Date }> = [];
  for (const f of folders) {
    const name = f.key.split("/").filter(Boolean).pop() || "";
    out.push({ name, type: "folder", size: 0, modifyTime: f.uploaded || new Date() });
  }
  for (const f of files) {
    const name = f.key.split("/").filter(Boolean).pop() || "";
    if (!name || name === ".keep") continue;
    out.push({ name, type: "file", size: f.size || 0, modifyTime: f.uploaded || new Date() });
  }
  return out;
}

// ---------- PROPFIND XML ----------

function gmDate(d: Date): string {
  return d.toUTCString().replace(/GMT$/, "GMT");
}

function itemXml(davRoot: string, rel: string, isFolder: boolean, size: number, modifyTime: Date): string {
  const href = davRoot + rel + (isFolder && rel !== "" ? "/" : "");
  const mtime = gmDate(modifyTime);
  const creation = modifyTime.toISOString().replace(/\.\d+Z$/, "Z");
  const resourcetype = isFolder
    ? "<D:resourcetype><D:collection/></D:resourcetype><D:getcontenttype>httpd/unix-directory</D:getcontenttype>"
    : "<D:resourcetype/><D:getcontenttype>" + getFileMimeType(rel) + "</D:getcontenttype>";
  return `\n<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:getlastmodified>${mtime}</D:getlastmodified><D:creationdate>${creation}</D:creationdate><D:getcontentlength>${isFolder ? 0 : size}</D:getcontentlength>${resourcetype}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

// ---------- 主 handler ----------

async function handleDav(request: Request, env: Env, ctx: any, c?: any): Promise<Response> {
  const method = request.method.toUpperCase();
  const url = new URL(request.url);

  // 插件配置: 未开启直接 404
  const meta = await getPluginMeta(env.DB, "webdav");
  const config = meta?.config || {};
  if (String(config.isOpen ?? "0") !== "1") {
    return davResponse(404, errorBody("ObjectNotFound", "not open webdav"));
  }

  // OPTIONS 无需认证 (001: OPTIONS 在 checkUser 之前返回)
  if (method === "OPTIONS") {
    return davResponse(200, undefined, {
      "DAV": "1, 2, 3, extended-kodbox",
      "MS-Author-Via": "DAV",
      "Allow": "OPTIONS, PROPFIND, PROPPATCH, MKCOL, GET, PUT, DELETE, COPY, MOVE, LOCK, UNLOCK, HEAD",
      "Accept-Ranges": "bytes",
      "Content-Length": "0",
    });
  }

  const user = await webdavAuth(env, request);
  if (!user) {
    return davResponse(401, undefined, { "WWW-Authenticate": 'Basic realm="kodbox"' });
  }

  const lang = c ? detectLang(c) : "zh-CN";
  const davRel = davRelPath(url);
  const virtual = await resolveDavVirtualPath(env, user, davRel, config, lang);
  if (virtual === null) {
    return davResponse(404, errorBody("ObjectNotFound", "not exist"));
  }
  const resolved = await resolveDavSource(env, user, virtual);
  if (!resolved.ok) {
    return davResponse(404, errorBody("ObjectNotFound", resolved.error));
  }
  const source = resolved.source;
  const relPath = resolved.relPath;

  // {block:files} 根: 只支持 PROPFIND 列出虚拟目录
  if (resolved.block) {
    if (method === "PROPFIND") {
      const root = await blockFilesRoot(env, user, lang);
      let out = "";
      const hrefBase = url.origin + "/index.php/dav/";
      for (const r of root) {
        out += itemXml(hrefBase, r.name, true, 0, new Date());
      }
      return davResponse(207, `<D:multistatus xmlns:D="DAV:">${out}\n</D:multistatus>`);
    }
    return davResponse(405);
  }

  const isRoot = relPath === "/" || relPath === "";

  switch (method) {
    case "PROPFIND": {
      const depth = request.headers.get("Depth") || "0";
      const exists = await davExists(env, source, relPath);
      if (!exists) return davResponse(404, errorBody("ObjectNotFound", "not exist"));
      const davRoot = url.origin + "/index.php/dav/";
      const cur = davRel.replace(/\/+$/, "");
      let out = "";
      if (exists === "file") {
        const key = keyFromBase(source.baseKey, relPath);
        const head = await env.FILES.head(key).catch(() => null);
        out += itemXml(davRoot, cur, false, head?.size || 0, head?.uploaded || new Date());
      } else {
        // 文件夹: 自身 + 子项
        out += itemXml(davRoot, cur, true, 0, new Date());
        if (depth !== "0") {
          const items = await davListDir(env, source, relPath);
          for (const it of items) {
            out += itemXml(davRoot, cur ? cur + "/" + it.name : it.name, it.type === "folder", it.size, it.modifyTime);
          }
        }
      }
      const code = davRel.endsWith(".xbel") ? 200 : 207;
      return davResponse(code, `<D:multistatus xmlns:D="DAV:">${out}\n</D:multistatus>`);
    }

    case "PROPPATCH": {
      const out = `\n<D:response><D:href>${url.pathname}</D:href><D:propstat><D:prop><m:Win32LastAccessTime xmlns:m="urn:schemas-microsoft-com:" /><m:Win32CreationTime xmlns:m="urn:schemas-microsoft-com:" /><m:Win32LastModifiedTime xmlns:m="urn:schemas-microsoft-com:" /><m:Win32FileAttributes xmlns:m="urn:schemas-microsoft-com:" /></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
      return davResponse(207, `<D:multistatus xmlns:D="DAV:">${out}\n</D:multistatus>`);
    }

    case "GET": {
      const key = keyFromBase(source.baseKey, relPath);
      const obj = await env.FILES.get(key).catch(() => null);
      if (!obj) return davResponse(404, errorBody("ObjectNotFound", "not exist"));
      const headers = new Headers();
      headers.set("Content-Type", getFileMimeType(nameOf(relPath)));
      headers.set("Accept-Ranges", "bytes");
      headers.set("ETag", `"${obj.httpEtag || obj.etag || ""}"`);
      return new Response(obj.body, { headers });
    }

    case "HEAD": {
      const key = keyFromBase(source.baseKey, relPath);
      const obj = await env.FILES.head(key).catch(() => null);
      if (!obj) return davResponse(404);
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": getFileMimeType(nameOf(relPath)),
          "Content-Length": String(obj.size || 0),
          "Accept-Ranges": "bytes",
          "ETag": `"${obj.httpEtag || obj.etag || ""}"`,
        },
      });
    }

    case "PUT": {
      const body = await request.arrayBuffer();
      const key = keyFromBase(source.baseKey, relPath);
      await env.FILES.put(key, body);
      return davResponse(201);
    }

    case "DELETE": {
      const exists = await davExists(env, source, relPath);
      if (!exists) return davResponse(404, errorBody("ObjectNotFound", "not exist"));
      const key = keyFromBase(source.baseKey, relPath);
      if (exists === "folder") {
        const prefix = key.endsWith("/") ? key : key + "/";
        await deleteDirectory(env.FILES, prefix);
      } else {
        await env.FILES.delete(key);
      }
      return davResponse(200);
    }

    case "MKCOL": {
      if (await davExists(env, source, relPath)) return davResponse(201);
      const dirKey = keyFromBase(source.baseKey, relPath + "/");
      await env.FILES.put(dirKey, "");
      return davResponse(201);
    }

    case "MOVE": {
      const dest = request.headers.get("Destination") || "";
      let destRel = "";
      try {
        const du = new URL(dest);
        destRel = davRelPath(du);
      } catch {
        return davResponse(400);
      }
      const destVirtual = await resolveDavVirtualPath(env, user, destRel, config, lang);
      if (destVirtual === null) return davResponse(404);
      const destResolved = await resolveDavSource(env, user, destVirtual);
      if (!destResolved.ok || destResolved.block) return davResponse(404);
      const destSource = destResolved.source;
      const destPath = destResolved.relPath;

      const exists = await davExists(env, source, relPath);
      if (!exists) return davResponse(404);
      const srcKey = keyFromBase(source.baseKey, relPath);
      const dstKey = keyFromBase(destSource.baseKey, destPath);
      if (exists === "folder") {
        const prefix = srcKey.endsWith("/") ? srcKey : srcKey + "/";
        const destPrefix = dstKey.endsWith("/") ? dstKey : dstKey + "/";
        await copyR2Prefix(env.FILES, prefix, destPrefix);
        await deleteDirectory(env.FILES, prefix);
      } else {
        const obj = await env.FILES.get(srcKey).catch(() => null);
        if (!obj) return davResponse(404);
        await env.FILES.put(dstKey, obj.body);
        await env.FILES.delete(srcKey);
      }
      return davResponse(201);
    }

    case "COPY": {
      const dest = request.headers.get("Destination") || "";
      let destRel = "";
      try {
        const du = new URL(dest);
        destRel = davRelPath(du);
      } catch {
        return davResponse(400);
      }
      const destVirtual = await resolveDavVirtualPath(env, user, destRel, config, lang);
      if (destVirtual === null) return davResponse(404);
      const destResolved = await resolveDavSource(env, user, destVirtual);
      if (!destResolved.ok || destResolved.block) return davResponse(404);
      const destSource = destResolved.source;
      const destPath = destResolved.relPath;

      const exists = await davExists(env, source, relPath);
      if (!exists) return davResponse(404);
      const srcKey = keyFromBase(source.baseKey, relPath);
      const dstKey = keyFromBase(destSource.baseKey, destPath);
      if (exists === "folder") {
        const prefix = srcKey.endsWith("/") ? srcKey : srcKey + "/";
        const destPrefix = dstKey.endsWith("/") ? dstKey : dstKey + "/";
        await copyR2Prefix(env.FILES, prefix, destPrefix);
      } else {
        const obj = await env.FILES.get(srcKey).catch(() => null);
        if (!obj) return davResponse(404);
        await env.FILES.put(dstKey, obj.body);
      }
      return davResponse(201);
    }

    case "LOCK": {
      const token = makeLockToken();
      const body = `<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>infinity</d:depth><d:lockroot><d:href>${url.pathname}</d:href></d:lockroot><d:timeout>Infinite</d:timeout><d:locktoken><d:href>opaquelocktoken:${token}</d:href></d:locktoken></d:activelock></d:lockdiscovery></d:prop>`;
      return davResponse(201, body, { "Lock-Token": `<opaquelocktoken:${token}>` });
    }

    case "UNLOCK": {
      return davResponse(204);
    }

    default:
      return davResponse(405);
  }
}

/** 递归复制 R2 前缀 (目录)。 */
async function copyR2Prefix(bucket: R2Bucket, prefix: string, destPrefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const o of listed.objects) {
      const rel = o.key.slice(prefix.length);
      const obj = await bucket.get(o.key).catch(() => null);
      if (obj) await bucket.put(destPrefix + rel, obj.body);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

function makeLockToken(): string {
  const r = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${r()}${r()}-${r()}-${r()}-${r()}-${r()}${r()}${r()}`;
}

const webdavApi = new Hono<{ Bindings: Env; Variables: Vars }>();

webdavApi.on(["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "PROPFIND", "PROPPATCH", "MKCOL", "MOVE", "COPY", "LOCK", "UNLOCK"], "/*", async (c) => {
  return handleDav(c.req.raw, c.env, c.executionCtx, c);
});

export { webdavApi };
