/**
 * 分享路由：explorer/share/*（外链落地页，公开）+ explorer/userShare/*（分享管理，需登录）
 *
 * 复刻 001 的 explorer/share 与 explorer/userShare 控制器。
 * 前端契约（decoded from static/app/dist）：
 *  - 外链落地页 hash 路由 `#s/<shareHash>`，落地页 pathModel 所有请求自动附带 shareID=<shareHash>。
 *  - 落地页 API：get / pathList / pathInfo / fileOut / fileOutBy / fileDownload / fileGet / fileSave /
 *    fileUpload / mkdir / mkfile / pathRename / pathDelete / report / zipDownload / unzipList。
 *  - 管理 API：userShare/get|add|edit|del|shareDisplay|shareExit（POST form，accessToken 自动带上）。
 *  - 错误码：30100 不存在、30101 过期、30102 下载超限、30103 需登录、30104 需密码。
 */
import { Hono } from "hono";
import { authOptional, authRequired, getSessionId } from "../lib/auth";
import type { AuthUser } from "../lib/auth";
import { getUserById, addAuditLog, getSetting, getUserOption, setUserOption } from "../lib/db";
import { getAppHost } from "../lib/user-system";
import { t } from "../lib/i18n";
import { getUserFileKey, listDirectory, getFileMimeType, keyFromBase } from "../lib/r2";
import { resolveFileSource } from "../lib/source";
import type { SourceRef } from "../lib/source";
import { ioClientOf } from "../lib/io";
import { getGroupAuthValue } from "../lib/source-auth";
import { md5, mcryptDecode, mcryptEncode } from "../lib/mcrypt";
import JSZip from "jszip";
import { readZipCentralDirectory } from "../lib/zip-central";
import type { ZipCentralRangeResult } from "../lib/zip-central";
import { safeZipEntryName, zipDecodeFileName, parseZipInnerPath, fileOutHandler } from "./explorer-api";
import type { ShareRow } from "../lib/share";
import {
  shareOptions,
  getShareByHash,
  getShareById,
  getShareBySourcePath,
  listUserShares,
  addShare,
  editShare,
  removeShares,
  incNumView,
  incNumDownload,
  generateShareHash,
  normShareSourcePath,
  resolveShareSource,
  resolveShareStorage,
  shareLinkRoot,
  getUnlockedShares,
  setSharePassUnlocked,
  parsePublishPath,
} from "../lib/share";
import { parseAuthTo, getShareToList, replaceShareTo, removeShareToByShareIds } from "../lib/share-to";
import { sendCheckAuth, sendShareSiteAppend } from "./shareout-api";
type Vars = { currentUser?: AuthUser };
type AppContext = any;

// ============ 分享相关 i18n（与 001 config/i18n/zh-CN 保持一致） ============

const L = {  notExist: "分享不存在！",
  expiredTips: "抱歉，该分享已过期,请联系分享者！",
  downExceedTips: "抱歉，该分享下载次数超过分享者设置的上限",
  loginTips: "抱歉，该分享必须登录用户才能访问！",
  needPwd: "该分享需要密码",
  errorPwd: "密码错误!",
  noDownTips: "抱歉，该分享被设置为不允许下载！",
  noViewTips: "抱歉，该分享被设置为不允许预览！",
  noPermission: "没有该操作权限",
  noPermissionWriteAll: "没有写权限",
  pathNotExists: "该路径不存在！",
  error: "操作失败",
  success: "操作成功",
};

// ============ helpers ============

/** 把 ReadableStream 收集为 Uint8Array。 */
async function shareStreamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { chunks.push(value); total += value.byteLength; }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) { out.set(ch, off); off += ch.byteLength; }
  return out;
}

/** 分享源 + 子路径 → 完整 relPath（目录保留尾斜杠）。 */
function shareJoinRel(baseRel: string, rel: string, isDir = false): string {
  const base = baseRel.replace(/\/+$/, "");
  if (!rel) return isDir ? base + "/" : base;
  return isDir ? base + "/" + rel.replace(/\/+$/, "") + "/" : base + "/" + rel;
}

/** 计算存储 key：io 挂载用 baseKey，个人空间用 username 前缀（发布目录 relPath 已是完整 key）。 */
function shareKeyOf(owner: AuthUser, source: SourceRef | null, relPath: string): string {
  if (source) return keyFromBase(source.baseKey, relPath);
  if (relPath.startsWith("__publish__/")) return relPath;
  return getUserFileKey(owner.username, relPath);
}

/** head 分享对象（R2 或外部挂载）。 */
async function shareHeadOf(env: Env, owner: AuthUser, source: SourceRef | null, relPath: string): Promise<{ size: number; contentType: string; lastModified: string | null } | null> {
  const key = shareKeyOf(owner, source, relPath);
  const io = source ? ioClientOf(source) : null;
  if (io) return io.head(key).catch(() => null);
  const o = await env.FILES.head(key).catch(() => null);
  if (!o) return null;
  return { size: o.size, contentType: o.httpMetadata?.contentType || "", lastModified: o.uploaded ? o.uploaded.toISOString() : null };
}

/** 读取分享对象完整字节（R2 或外部挂载）。 */
async function shareReadBytes(env: Env, owner: AuthUser, source: SourceRef | null, relPath: string): Promise<Uint8Array | null> {
  const key = shareKeyOf(owner, source, relPath);
  const io = source ? ioClientOf(source) : null;
  if (io) {
    const g = await io.get(key).catch(() => null);
    if (!g) return null;
    return shareStreamBytes(g.body);
  }
  const o = await env.FILES.get(key).catch(() => null);
  if (!o) return null;
  return new Uint8Array(await o.arrayBuffer());
}

/** 列出分享目录（R2 或外部挂载）。 */
async function shareListDir(env: Env, owner: AuthUser, source: SourceRef | null, relPath: string): Promise<{ folders: { name: string }[]; files: { name: string; size: number; uploaded?: string }[] } | null> {
  const key = shareKeyOf(owner, source, relPath);
  const prefix = key.endsWith("/") ? key : key + "/";
  const io = source ? ioClientOf(source) : null;
  if (io) {
    const listed = await io.list(prefix).catch(() => null);
    if (!listed) return null;
    const folders = listed.folders.map((k) => ({ name: k.split("/").filter(Boolean).pop() || k }));
    // 过滤目录占位对象自身 (key 恰等于 prefix), 对齐 explorer list/path 的处理
    const files = listed.files
      .filter((f) => f.key !== prefix && f.key !== prefix.replace(/\/$/, ""))
      .map((f) => ({ name: f.key.split("/").pop() || f.key, size: f.size }));
    return { folders, files };
  }
  const listed = await env.FILES.list({ prefix, delimiter: "/" });
  const folders = (listed.delimitedPrefixes || []).map((p) => ({ name: p.split("/").filter(Boolean).pop() || p }));
  const files = listed.objects.filter((o) => o.key !== prefix).map((o) => ({ name: o.key.split("/").pop() || o.key, size: o.size, uploaded: o.uploaded ? o.uploaded.toISOString() : undefined }));
  return { folders, files };
}

/** 分享项真实路径 → R2 key：发布临时目录展开为 __publish__ 前缀，其余为用户空间。 */
export function shareStorageKey(username: string, realPath: string): string {
  const pub = parsePublishPath(realPath);
  if (pub) {
    const rest = realPath.slice(realPath.indexOf("}") + 1).replace(/^\/+/, "");
    return pub.key + (rest ? "/" + rest : "");
  }
  return getUserFileKey(username, realPath);
}

/** Merge query + form-encoded body + json body into a single params object. */
async function reqParams(c: AppContext): Promise<Record<string, any>> {
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(c.req.query())) result[k] = v;

  const method = c.req.method;
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const ct = c.req.header("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await c.req.json().catch(() => ({}));
      if (j && typeof j === "object") Object.assign(result, j);
    } else {
      const body = await c.req.parseBody().catch(() => ({}));
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (typeof v === "string") result[k] = v;
      }
    }
  }
  return result;
}

/** 虚拟路径 {source:home}/xxx 等 → 真实相对路径。 */
function toRealPath(p: string): string {
  let s = (p || "/").replace(/\\/g, "/").replace(/\/+/g, "/");
  const src = s.match(/^\{source:(home|\d+)\}(.*)$/);
  if (src) s = src[2].replace(/^\/+/, "") || "/";
  if (s.startsWith("{")) return "/";
  if (!s.startsWith("/")) s = "/" + s;
  return s;
}

/** 解析请求中的分享 hash（shareID 参数 / {shareItemLink:hash} 路径 / dataArr[0].path）。 */
function parseShareID(params: Record<string, any>): string {
  if (typeof params.shareID === "string" && params.shareID) return params.shareID;
  const path = typeof params.path === "string" ? params.path : "";
  const m = path.match(/\{shareItemLink:([-\w]+)\}/);
  if (m) return m[1];
  if (params.dataArr) {
    try {
      const arr = JSON.parse(params.dataArr);
      if (Array.isArray(arr) && arr[0] && typeof arr[0].path === "string") {
        const m2 = arr[0].path.match(/\{shareItemLink:([-\w]+)\}/);
        if (m2) return m2[1];
      }
    } catch {
      /* ignore */
    }
  }
  return "";
}

/** 校验并解析外链路径为相对分享根的路径；不匹配返回 null。 */
export function parseShareLinkRel(share: ShareRow, path: string): string | null {
  const prefix = `{shareItemLink:${share.shareHash}}`;
  if (typeof path !== "string" || !path.startsWith(prefix)) return null;
  return path.slice(prefix.length).replace(/^\/+/, "");
}

/** 分享根真实路径 + 相对子路径 → 真实路径（目录保留尾斜杠）。 */
export function joinShareRealPath(sourcePath: string, rel: string, isDir = false): string {
  const base = normShareSourcePath(sourcePath).replace(/\/+$/, "");
  if (!rel) return isDir ? base + "/" : base;
  return isDir ? base + "/" + rel.replace(/\/+$/, "") + "/" : base + "/" + rel;
}

/** 解码前端提交的分享密码（authCrypt.encode(pwd, md5(kodID))）。 */
function decodeSharePassword(pwd: string): string {
  const kodID = "DEV-MB-0001";
  return mcryptDecode(pwd, md5(kodID));
}

/** 001 parseName：长度>3 截断打码。 */
function maskName(name: string): string {
  if (!name) return "";
  return name.length > 3 ? name.slice(0, 3) + "***" : name;
}

/** 分享者用户信息（落地页 header 显示）。 */
function shareUserInfo(user: AuthUser): Record<string, unknown> {
  const name = user.nickname || user.username;
  return {
    userID: user.id,
    name: user.username,
    nickname: name,
    nameDisplay: maskName(name),
    avatar: user.avatar || "",
  };
}

/** 分享是否允许编辑（canEditSave + 系统开关）。 */
async function shareCanEdit(env: Env, share: ShareRow): Promise<boolean> {
  const opts = shareOptions(share);
  if (opts.canEditSave !== "1") return false;
  const allowEdit = (await getSetting(env.DB, "shareLinkAllowEdit")) ?? "1";
  return allowEdit !== "0";
}

/** 组装落地页列表项（外链路径）。 */
function shareItemInfo(
  share: ShareRow,
  sourceName: string,
  o: { name: string; relPath: string; isFolder: boolean; size: number; modifyTime: string; canEdit: boolean }
): Record<string, unknown> {
  const root = shareLinkRoot(share.shareHash);
  const rel = o.relPath || "";
  // 文件夹: root 本身以 / 结尾, rel 空时不再追加; 文件: root + rel
  const path = o.isFolder ? root + (rel ? rel.replace(/\/+$/, "") + "/" : "") : root + rel;
  const pathDisplay = sourceName + (rel ? "/" + rel : "") + (o.isFolder ? "/" : "");
  // type 为基础类型(file/folder, 与 001 IO::info 一致), ext 才是扩展名;
  // 落地页据此判断文件/文件夹分享, 应用类型(如 doc/image)属于 UI 展示, 不应覆盖 type。
  return {
    name: o.name,
    path,
    pathDisplay,
    type: o.isFolder ? "folder" : "file",
    isFolder: o.isFolder,
    ext: o.isFolder ? "folder" : (o.name.includes(".") ? o.name.split(".").pop()!.toLowerCase() : ""),
    size: o.size,
    modifyTime: o.modifyTime,
    createTime: o.modifyTime,
    sourceID: share.sourceID,
    isReadable: true,
    isWriteable: o.canEdit,
  };
}

/** 落地页 get 返回的完整数据。 */
async function buildSharePageData(
  env: Env,
  share: ShareRow,
  owner: AuthUser,
  source: { type: "folder" | "file"; name: string; realPath: string },
  storage?: { source: SourceRef | null; relPath: string }
): Promise<Record<string, unknown>> {
  const canEdit = await shareCanEdit(env, share);
  let size = 0;
  let modifyTime = share.modifyTime;
  if (source.type === "file") {
    const head = storage ? await shareHeadOf(env, owner, storage.source, storage.relPath) : null;
    if (head) {
      size = head.size;
      if (head.lastModified) modifyTime = head.lastModified;
    } else if (!storage) {
      const obj = await env.FILES.head(shareStorageKey(owner.username, source.realPath));
      if (obj) {
        size = obj.size;
        if (obj.uploaded) modifyTime = new Date(obj.uploaded).toISOString();
      }
    }
  }
  const info: Record<string, unknown> = {
    shareHash: share.shareHash,
    title: share.title,
    isLink: share.isLink,
    timeTo: share.timeTo,
    numView: share.numView,
    numDownload: share.numDownload,
    options: shareOptions(share),
    createTime: share.createTime,
    sourceInfo: shareItemInfo(share, source.name, {
      name: source.name,
      relPath: "",
      isFolder: source.type === "folder",
      size,
      modifyTime,
      canEdit,
    }),
    shareUser: shareUserInfo(owner),
  };
  if (source.type === "file" && shareOptions(share).notDownload !== "1") {
    const fileOutPath = shareLinkRoot(share.shareHash);
    info["downloadPath"] =
      `explorer/share/fileOut?shareID=${encodeURIComponent(share.shareHash)}` +
      `&path=${encodeURIComponent(fileOutPath)}` +
      `&name=${encodeURIComponent("/" + source.name)}`;
    (info.sourceInfo as Record<string, unknown>)["downloadPath"] = info["downloadPath"];
  }
  return info;
}

/** 管理场景分享信息（share 行 + 源信息）。 */
async function buildManageShareInfo(env: Env, share: ShareRow, source: { type: "folder" | "file"; name: string; realPath: string } | null): Promise<Record<string, unknown>> {
  const shareToList = await getShareToList(env.DB, share.shareID);
  const authList = shareToList.map((t) => ({
    targetType: String(t.targetType),
    targetID: String(t.targetID),
    authID: String(t.authID),
    authDefine: t.authDefine,
  }));
  const info: Record<string, unknown> = {
    shareID: share.shareID,
    title: share.title,
    shareHash: share.shareHash,
    userID: share.userID,
    sourceID: share.sourceID,
    sourcePath: share.sourcePath,
    url: share.url,
    isLink: share.isLink,
    isShareTo: share.isShareTo,
    authList,
    password: share.password,
    timeTo: share.timeTo,
    numView: share.numView,
    numDownload: share.numDownload,
    options: shareOptions(share),
    createTime: share.createTime,
    modifyTime: share.modifyTime,
    sourceInfo: source
      ? {
          name: source.name,
          path: source.realPath,
          type: source.type,
          isFolder: source.type === "folder",
          ext: source.type === "folder" ? "folder" : (source.name.includes(".") ? source.name.split(".").pop()!.toLowerCase() : ""),
          size: 0,
          modifyTime: share.modifyTime,
          isReadable: true,
          isWriteable: true,
        }
      : {
          // 源解析失败（如历史数据 sourcePath 格式异常 / 源已被删除）时返回占位 sourceInfo，
          // 避免前端据此提示"该路径不存在"阻断分享管理。
          name: share.sourcePath.split("/").filter(Boolean).pop() || share.title || "分享",
          path: share.sourcePath,
          type: "folder",
          isFolder: true,
          ext: "folder",
          size: 0,
          modifyTime: share.modifyTime,
          isReadable: true,
          isWriteable: true,
        },
  };
  return sendShareSiteAppend(env, info);
}

/** 错误响应（对齐 001 show_json：{code, data, info}）。 */
function shareError(c: AppContext, code: number | false, msg: string, info?: any) {
  return { ok: false as const, response: c.json({ code, data: msg, info }) };
}

type InitResult =
  | { ok: true; share: ShareRow; owner: AuthUser; source: { type: "folder" | "file"; name: string; realPath: string }; storage: { source: SourceRef | null; relPath: string } }
  | { ok: false; response: Response };

/**
 * 分享信息初始化（001 initShare）：
 * 存在性 → 分享者有效性 → 源存在性 → 过期 → 下载次数 → 需登录 → 密码。
 */
async function initShare(c: AppContext, params: Record<string, any>): Promise<InitResult> {
  const hash = parseShareID(params);
  const share = await getShareByHash(c.env.DB, hash);
  if (!share || share.isLink !== 1) return shareError(c, 30100, L.notExist);

  const owner = (await getUserById(c.env.DB, share.userID)) as AuthUser | null;
  if (!owner || (owner.status ?? 1) !== 1) return shareError(c, 30100, L.notExist);

  const storage = await resolveShareStorage(c.env, owner, share);
  if (!storage) return shareError(c, 30100, L.notExist);
  const source = { type: storage.type, name: storage.name, realPath: storage.realPath };

  const opts = shareOptions(share);
  const now = Math.floor(Date.now() / 1000);
  if (share.timeTo && share.timeTo > 0 && share.timeTo < now) {
    const info = await buildSharePageData(c.env, share, owner, source, { source: storage.source, relPath: storage.relPath });
    return shareError(c, 30101, L.expiredTips, info);
  }
  // 外站联合分享鉴权 (001 shareOuterAuth): 校验通过则跳过下载次数/登录/密码限制。
  const outerAuth = await sendCheckAuth(c.env, share, typeof params.sk === "string" ? params.sk : "");
  if (outerAuth) {
    (share as unknown as { __outerAuth?: string }).__outerAuth = outerAuth;
    return { ok: true, share, owner, source, storage: { source: storage.source, relPath: storage.relPath } };
  }
  if (opts.downloadNumber && Number(opts.downloadNumber) <= share.numDownload) {
    const info = await buildSharePageData(c.env, share, owner, source, { source: storage.source, relPath: storage.relPath });
    return shareError(c, 30102, L.downExceedTips, info);
  }

  const user = c.get("currentUser") as AuthUser | undefined;
  if (opts.onlyLogin === "1" && !user) {
    const info = await buildSharePageData(c.env, share, owner, source, { source: storage.source, relPath: storage.relPath });
    return shareError(c, 30103, L.loginTips, info);
  }

  if (share.password) {
    const unlocked = getUnlockedShares(c).has(share.shareHash);
    if (!unlocked) {
      const pwd = params.password;
      if (typeof pwd === "string" && pwd.length > 0 && pwd.length < 500) {
        const decoded = decodeSharePassword(pwd);
        if (decoded && decoded === share.password) {
          setSharePassUnlocked(c, share.shareHash);
        } else {
          return shareError(c, false, L.errorPwd);
        }
      } else {
        const info = await buildSharePageData(c.env, share, owner, source, { source: storage.source, relPath: storage.relPath });
        return shareError(c, 30104, L.needPwd, info);
      }
    }
  }

  return { ok: true, share, owner, source, storage: { source: storage.source, relPath: storage.relPath } };
}

/** 权限检测（001 authCheck）：notView/notDownload/上传/编辑。返回错误消息或 null。 */
function authCheck(c: AppContext, share: ShareRow, act: string, params: Record<string, any>): string | null {
  const opts = shareOptions(share);
  let canUpload = opts.canUpload === "1";
  let canEdit = opts.canEditSave === "1";
  let canView = opts.notView !== "1";
  let canDownload = opts.notDownload !== "1";
  // 外站联合分享通过鉴权后按外站权限放开 (001 shareOuterAuth)
  const outerAuth = (share as unknown as { __outerAuth?: string }).__outerAuth;
  if (outerAuth === "read" || outerAuth === "write") {
    canView = true;
    canDownload = true;
  }
  if (outerAuth === "write") {
    canEdit = true;
    canUpload = true;
  }

  const actionUpload = ["fileupload", "mkdir", "mkfile"];
  const actionEdit = ["fileupload", "mkdir", "mkfile", "pathrename", "pathdelete", "pathcopy", "pathcute", "pathcuteto", "pathcopyto", "pathpast", "filesave"];

  const isDownload = (act === "fileout" && params.download === "1") || act === "filedownload" || act === "zipdownload";
  if (!canDownload && isDownload) return L.noDownTips;
  if (!canView && ["fileget", "fileout", "unziplist"].includes(act)) return L.noViewTips;

  if (actionUpload.includes(act) && !canEdit) {
    if (!canUpload) return L.noPermissionWriteAll;
  }
  if (actionEdit.includes(act) && !actionUpload.includes(act)) {
    if (!canEdit) return L.noPermissionWriteAll;
  }
  return null;
}

/** 分享文件流（inline/attachment）。 */
async function shareFileOutHandler(c: AppContext, disposition: "inline" | "attachment") {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return await tipsHtml(c, init.response);
  const { share, owner, storage } = init;
  const rel = parseShareLinkRel(share, typeof params.path === "string" ? params.path : "");
  if (rel === null) return c.json({ code: false, data: L.noPermission });

  const isDir = rel === "" ? init.source.type === "folder" : false;
  if (isDir) return c.json({ code: false, data: L.pathNotExists });

  const errMsg = authCheck(c, share, disposition === "attachment" ? "filedownload" : "fileout", params);
  if (errMsg) return await tipsHtml(c, c.json({ code: false, data: errMsg }));

  const fullRel = shareJoinRel(storage.relPath, rel);
  const io = storage.source ? ioClientOf(storage.source) : null;
  const key = shareKeyOf(owner, storage.source, fullRel);

  const isDownload = disposition === "attachment" || params.download === "1";
  if (isDownload) await incNumDownload(c.env.DB, share.shareID);

  const fileName = fullRel.split("/").filter(Boolean).pop() || "file";
  let name = typeof params.name === "string" && params.name ? params.name.replace(/^\/+/, "") : fileName;
  if (!name) name = fileName;

  const headers = new Headers();
  headers.set("Content-Type", getFileMimeType(name));
  headers.set("Content-Disposition", `${disposition}; filename="${encodeURIComponent(name)}"`);
  if (disposition === "inline") headers.set("Cache-Control", "public, max-age=3600");

  if (io) {
    const g = await io.get(key).catch(() => null);
    if (!g) return await tipsHtml(c, c.json({ code: false, data: L.pathNotExists }));
    if (g.contentType) headers.set("Content-Type", g.contentType);
    return new Response(g.body, { headers });
  }
  const obj = await c.env.FILES.get(key).catch(() => null);
  if (!obj) return await tipsHtml(c, c.json({ code: false, data: L.pathNotExists }));
  obj.writeHttpMetadata(headers);
  return new Response(obj.body, { headers });
}

/** 出错时展示 HTML 提示页（001 show_tips，用于 fileOut/fileDownload 等直接请求）。 */
async function tipsHtml(c: AppContext, res: Response): Promise<Response> {
  let msg = "请求失败";
  try {
    const clone = res.clone();
    const body: any = await clone.json().catch(() => null);
    if (body && typeof body.data === "string" && body.data) msg = body.data;
  } catch {
    /* ignore */
  }
  return new Response(
    `<html><head><meta charset="utf-8"><title>MbesBox</title><style>body{font-family:sans-serif;text-align:center;padding-top:100px;color:#666}</style></head><body>${msg}</body></html>`,
    { headers: { "Content-Type": "text/html;charset=utf-8" } }
  );
}

/** 读取 dataArr 参数（JSON 字符串或数组）。 */
function parseDataArr(dataArr: any): { path: string }[] {
  let arr = dataArr;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: { path: string }[] = [];
  for (const it of arr) {
    if (typeof it === "string" && it) out.push({ path: it });
    else if (it && typeof it.path === "string" && it.path) out.push({ path: it.path });
  }
  return out;
}

/** 从列表项/路径中提取 shareID。 */
function extractShareID(item: any): number | null {
  if (typeof item === "number") return Number.isFinite(item) && item > 0 ? item : null;
  if (typeof item === "string") {
    const n = parseInt(item, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (item && typeof item === "object") {
    if (item.shareID) {
      const n = parseInt(String(item.shareID), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (typeof item.path === "string") {
      const m = item.path.match(/\{shareItem:(\d+)\}/);
      if (m) return parseInt(m[1], 10);
    }
  }
  return null;
}

/** 协作分享可设置的权限位不能超过自己在文档的权限 (001 userShare::checkSetAuthAllow)。 */
async function checkSetAuthAllow(env: Env, user: AuthUser, path: string, authTo: any[]): Promise<boolean> {
  if (!authTo || authTo.length === 0) return true;
  // 仅部门文档需要检查(个人空间/io 全权限)
  const groupMatch = path.match(/^\{source:(\d+)\}/);
  if (!groupMatch) return true;
  const groupID = parseInt(groupMatch[1], 10);
  const selfAuth = await getGroupAuthValue(env, user, groupID);
  for (const item of authTo) {
    if (!item || !item.authID) continue;
    const row = await env.DB.prepare("SELECT auth FROM auths WHERE id = ?").bind(Number(item.authID)).first<{ auth: number }>().catch(() => null);
    if (!row) continue;
    const targetAuth = Number(row.auth) || 0;
    if ((targetAuth | selfAuth) !== selfAuth) return false;
  }
  return true;
}

/** 分享者空间下真实路径是否可作为分享源（支持个人空间 / 部门空间 / io 挂载）。 */
async function resolveShareSourceForUser(env: Env, user: AuthUser, path: string): Promise<{ type: "folder" | "file"; name: string; realPath: string } | null> {
  // 部门/io 虚拟路径: 用 resolveFileSource 解析到 baseKey + relPath
  if (path.startsWith("{source:") || path.startsWith("{io:")) {
    const r = await resolveFileSource(env, user, path);
    if (!r.ok) return null;
    const rel = r.relPath;
    const isFolder = rel.endsWith("/");
    const key = keyFromBase(r.source.baseKey, rel);
    const io = ioClientOf(r.source);
    if (isFolder) {
      const prefix = key.endsWith("/") ? key : key + "/";
      if (io) {
        const listed = await io.list(prefix).catch(() => null);
        if (!listed || (listed.folders.length === 0 && listed.files.length === 0)) return null;
      } else {
        const listed = await env.FILES.list({ prefix, limit: 1 });
        if (listed.objects.length === 0 && (listed.delimitedPrefixes || []).length === 0) return null;
      }
      const name = rel === "/" ? r.source.displayName : rel.split("/").filter(Boolean).pop() || rel;
      return { type: "folder", name, realPath: path };
    }
    if (io) {
      const head = await io.head(key).catch(() => null);
      if (!head) return null;
    } else {
      const obj = await env.FILES.head(key);
      if (!obj) return null;
    }
    const name = rel.split("/").filter(Boolean).pop() || rel;
    return { type: "file", name, realPath: path };
  }

  // 个人空间: 相对路径 (001 中 sourcePath 对文件夹带尾斜杠)
  const norm = normShareSourcePath(path);
  const dirPath = norm.endsWith("/") ? norm : norm + "/";
  const dirKey = getUserFileKey(user.username, dirPath);
  const dirListed = await env.FILES.list({ prefix: dirKey, limit: 1 });
  if (dirListed.objects.length > 0 || (dirListed.delimitedPrefixes || []).length > 0) {
    const name = dirPath.split("/").filter(Boolean).pop() || dirPath;
    return { type: "folder", name, realPath: dirPath };
  }
  const filePath = norm.replace(/\/+$/, "");
  const obj = await env.FILES.head(getUserFileKey(user.username, filePath));
  if (!obj) return null;
  const name = filePath.split("/").filter(Boolean).pop() || filePath;
  return { type: "file", name, realPath: filePath };
}

// ============ 路由 ============

const shareApi = new Hono<{ Bindings: Env; Variables: Vars }>();
shareApi.use("/share/*", authOptional);
shareApi.use("/userShare/*", authRequired);
shareApi.use("/userShareGroup/*", authRequired);
shareApi.use("/userShareUser/*", authRequired);

// ---------- 外链落地页（公开） ----------

// file - 通用加密外链落地 (001 explorer/share::file; path 由 hash 解密)
shareApi.all("/share/file", async (c) => {
  const params = await reqParams(c);
  const hash = typeof params.hash === "string" ? params.hash : "";
  if (!hash || hash.length > 5000) return c.json({ code: false, data: L.pathNotExists });
  const pass = (await getSetting(c.env.DB, "systemPassword")) || "";
  const path = hash ? mcryptDecode(hash, pass) : "";
  if (!path) return c.json({ code: false, data: "common.pathNotExists" });
  const isDownload = String(params.download ?? "") === "1";
  const downFilename = typeof params.downFilename === "string" ? params.downFilename : "";
  const rawName = typeof params.name === "string" ? params.name.replace(/^\/+/, "") : "";
  const name = downFilename || rawName || undefined;
  return fileOutHandler(c, isDownload ? "attachment" : "inline", { path, name });
});

// get - 分享信息（落地页初始化）
shareApi.all("/share/get", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  await incNumView(c.env.DB, init.share.shareID);
  return c.json({ code: 1, data: await buildSharePageData(c.env, init.share, init.owner, init.source, init.storage) });
});

// pathList - 目录浏览
shareApi.all("/share/pathList", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const { share, owner, source, storage } = init;

  const rawPath = typeof params.path === "string" ? params.path : "";
  const rel = parseShareLinkRel(share, rawPath);
  if (rel === null) return c.json({ code: false, data: L.noPermission });

  const fullDir = shareJoinRel(storage.relPath, rel, true);
  const virtualDir = shareLinkRoot(share.shareHash) + (rel ? rel.replace(/\/+$/, "") + "/" : "");
  const canEdit = await shareCanEdit(c.env, share);

  try {
    const list = await shareListDir(c.env, owner, storage.source, fullDir);
    if (!list) return c.json({ code: false, data: L.pathNotExists });
    const { folders, files } = list;

    const folderList = folders
      .filter((f) => f.name && !f.name.startsWith("."))
      .map((f) =>
        shareItemInfo(share, source.name, {
          name: f.name,
          relPath: (rel ? rel.replace(/\/+$/, "") + "/" : "") + f.name,
          isFolder: true,
          size: 0,
          modifyTime: new Date().toISOString(),
          canEdit,
        })
      );

    const fileList = files
      .filter((f) => f.name !== ".keep" && !f.name.startsWith("."))
      .map((f) =>
        shareItemInfo(share, source.name, {
          name: f.name,
          relPath: (rel ? rel.replace(/\/+$/, "") + "/" : "") + f.name,
          isFolder: false,
          size: f.size,
          modifyTime: f.uploaded ? f.uploaded : new Date().toISOString(),
          canEdit,
        })
      );

    const curRel = rel.replace(/\/+$/, "");
    const current = {
      name: curRel ? curRel.split("/").pop()! : source.name,
      path: virtualDir,
      pathDisplay: source.name + (curRel ? "/" + curRel : "") + "/",
      type: "folder",
      isFolder: true,
      isWriteable: canEdit,
      isReadable: true,
    };

    const totalNum = folderList.length + fileList.length;
    return c.json({
      code: 1,
      data: {
        current,
        folderList,
        fileList,
        groupList: [],
        pageInfo: { totalNum, pageNum: 500, page: 1, pageTotal: 1 },
        thisPath: rawPath || shareLinkRoot(share.shareHash),
      },
    });
  } catch (err: any) {
    return c.json({ code: false, data: err.message });
  }
});

// pathInfo - 文件/文件夹详情（单文件附 downloadPath）
shareApi.all("/share/pathInfo", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const { share, owner, source, storage } = init;

  const items = parseDataArr(params.dataArr);
  if (items.length === 0) return c.json({ code: false, data: L.error });

  const canEdit = await shareCanEdit(c.env, share);
  const result: Record<string, unknown>[] = [];
  for (const item of items) {
    const rel = parseShareLinkRel(share, item.path);
    if (rel === null) continue;
    // 空 rel 表示分享源本身（文件分享的根路径）
    const isFolder = rel.endsWith("/") || (rel === "" && init.source.type === "folder");
    const fullRel = shareJoinRel(storage.relPath, rel, isFolder);
    const name = rel === "" ? source.name : rel.replace(/\/+$/, "").split("/").pop() || "";
    if (isFolder) {
      const list = await shareListDir(c.env, owner, storage.source, fullRel);
      if (!list || (list.folders.length === 0 && list.files.length === 0)) continue;
      result.push(
        shareItemInfo(share, source.name, {
          name,
          relPath: rel.replace(/\/+$/, ""),
          isFolder: true,
          size: 0,
          modifyTime: new Date().toISOString(),
          canEdit,
        })
      );
    } else {
      const head = await shareHeadOf(c.env, owner, storage.source, fullRel);
      if (!head) continue;
      const info = shareItemInfo(share, source.name, {
        name,
        relPath: rel,
        isFolder: false,
        size: head.size,
        modifyTime: head.lastModified || new Date().toISOString(),
        canEdit,
      });
      const outerAuth = (share as unknown as { __outerAuth?: string }).__outerAuth;
      const canDownload = shareOptions(share).notDownload !== "1" || !!outerAuth;
      if (canDownload) {
        const fileOutPath = shareLinkRoot(share.shareHash) + rel;
        info["downloadPath"] =
          `explorer/share/fileOut?shareID=${encodeURIComponent(share.shareHash)}` +
          `&path=${encodeURIComponent(fileOutPath)}` +
          `&name=${encodeURIComponent("/" + name)}`;
      }
      result.push(info);
    }
  }

  if (items.length === 1) {
    if (result.length === 0) return c.json({ code: false, data: L.pathNotExists });
    return c.json({ code: 1, data: result[0] });
  }
  return c.json({ code: 1, data: result });
});

// fileOut / fileOutBy / fileDownload - 文件输出
shareApi.all("/share/fileOut", (c) => shareFileOutHandler(c, "inline"));
shareApi.all("/share/fileDownload", (c) => shareFileOutHandler(c, "attachment"));

// 001 explorer/share::{link,linkFile,linkSafe,linkOut} 外链生成 (匿名, authOptional)
shareApi.all("/share/link", async (c) => {
  const params = await reqParams(c);
  const path = typeof params.path === "string" ? params.path : "";
  if (!path) return c.text("");
  return c.text(await link(c.env, getAppHost(c), path, typeof params.downFilename === "string" ? params.downFilename : ""));
});
shareApi.all("/share/linkFile", async (c) => {
  const params = await reqParams(c);
  const file = typeof params.file === "string" ? params.file : "";
  if (!file) return c.text("");
  return c.text(await linkFile(c.env, getAppHost(c), file, typeof params.addParam === "string" ? params.addParam : ""));
});
shareApi.all("/share/linkSafe", async (c) => {
  const params = await reqParams(c);
  const path = typeof params.path === "string" ? params.path : "";
  if (!path) return c.text("");
  const user = c.get("currentUser") as AuthUser | undefined;
  return c.text(await linkSafe(c, user, path, typeof params.downFilename === "string" ? params.downFilename : ""));
});
shareApi.all("/share/linkOut", async (c) => {
  const params = await reqParams(c);
  const path = typeof params.path === "string" ? params.path : "";
  if (!path) return c.text("");
  const token = params.token === "1" || params.token === "true" || params.token === true;
  return c.text(await linkOut(c, path, token));
});

shareApi.all("/share/fileOutBy", async (c) => {
  // 文档内相对资源：path 指向分享文档，add 为相对父级路径
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return await tipsHtml(c, init.response);
  const { share, owner, storage } = init;
  const rel = parseShareLinkRel(share, typeof params.path === "string" ? params.path : "");
  if (rel === null) return c.json({ code: false, data: L.noPermission });

  let realRel = rel;
  if (typeof params.add === "string" && params.add) {
    const add = params.add.replace(/^\/+/, "").replace(/\\/g, "/");
    const parent = rel.replace(/\/[^/]*$/, "");
    realRel = (parent ? parent + "/" : "") + add;
  }

  const errMsg = authCheck(c, share, "fileout", params);
  if (errMsg) return await tipsHtml(c, c.json({ code: false, data: errMsg }));

  const fullRel = shareJoinRel(storage.relPath, realRel);
  const io = storage.source ? ioClientOf(storage.source) : null;
  const key = shareKeyOf(owner, storage.source, fullRel);

  const name = realRel.split("/").filter(Boolean).pop() || "file";
  const headers = new Headers();
  headers.set("Content-Type", getFileMimeType(name));
  headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(name)}"`);
  headers.set("Cache-Control", "public, max-age=3600");

  if (io) {
    const g = await io.get(key).catch(() => null);
    if (!g) return await tipsHtml(c, c.json({ code: false, data: L.pathNotExists }));
    if (g.contentType) headers.set("Content-Type", g.contentType);
    return new Response(g.body, { headers });
  }
  const obj = await c.env.FILES.get(key).catch(() => null);
  if (!obj) return await tipsHtml(c, c.json({ code: false, data: L.pathNotExists }));
  obj.writeHttpMetadata(headers);
  return new Response(obj.body, { headers });
});

// ============ 分享页 zip 浏览 (001 explorer/share unzipList + fileGetHash) ============

/** central directory 条目 -> 前端 unzipList 列表格式 (对齐 explorer/index/unzipList) */
function shareZipList(entries: Array<{ name: string; dir: boolean; size: number; mtimeSec: number }>): Record<string, unknown>[] {
  const list: Record<string, unknown>[] = [];
  for (let i = 0; i < entries.length; i++) {
    const en = entries[i];
    const filename = safeZipEntryName(en.name);
    if (!filename) continue;
    list.push({
      filename,
      stored_filename: filename,
      folder: en.dir,
      index: i,
      mtime: en.mtimeSec,
      size: en.size,
    });
  }
  return list;
}

/** 分享场景 Range 读取 (R2 或外部挂载, central directory 快速列目录) */
async function shareRangeRead(c: AppContext, owner: AuthUser, source: SourceRef | null, relPath: string, start: number, endInclusive: number): Promise<ZipCentralRangeResult> {
  const key = shareKeyOf(owner, source, relPath);
  const io = source ? ioClientOf(source) : null;
  if (io) {
    const g = await io.get(key, { range: [start, endInclusive] }).catch(() => null);
    if (!g) return { bytes: null, totalSize: null };
    return { bytes: await shareStreamBytes(g.body), totalSize: g.totalSize ?? null };
  }
  const head = await c.env.FILES.head(key).catch(() => null);
  if (!head) return { bytes: null, totalSize: null };
  const r = await c.env.FILES.get(key, { range: { offset: start, length: endInclusive - start + 1 } }).catch(() => null);
  if (!r) return { bytes: null, totalSize: null };
  return { bytes: new Uint8Array(await r.arrayBuffer()), totalSize: head.size };
}

/** 定位分享 zip 文件并返回其 key + 全量字节 (R2 或外部挂载) */
async function shareZipObject(c: AppContext, owner: AuthUser, storage: { source: SourceRef | null; relPath: string }, rel: string): Promise<{ key: string; bytes: Uint8Array } | null> {
  const fullRel = shareJoinRel(storage.relPath, rel);
  const io = storage.source ? ioClientOf(storage.source) : null;
  const key = shareKeyOf(owner, storage.source, fullRel);
  if (io) {
    const g = await io.get(key).catch(() => null);
    if (!g) return null;
    return { key, bytes: await shareStreamBytes(g.body) };
  }
  const obj = await c.env.FILES.get(key).catch(() => null);
  if (!obj) return null;
  const bytes = await obj.arrayBuffer().catch(() => null);
  if (!bytes) return null;
  return { key, bytes: new Uint8Array(bytes) };
}

/** 读取分享 zip 内单个文件内容 (按 index 数组末位); 非 zip 内文件返回 null */
async function shareFileGetZipInner(c: AppContext, share: ShareRow, owner: AuthUser, storage: { source: SourceRef | null; relPath: string }, rawPath: string): Promise<Response | null> {
  const zipInner = parseZipInnerPath(rawPath);
  if (!zipInner) return null;
  const rel = parseShareLinkRel(share, zipInner.zipPath);
  if (rel === null) return null;
  const zo = await shareZipObject(c, owner, storage, rel);
  if (!zo) return null;
  const zip = await JSZip.loadAsync(zo.bytes, { decodeFileName: zipDecodeFileName });
  const entries = Object.values(zip.files);
  const last = zipInner.indexArray[zipInner.indexArray.length - 1];
  const entry = entries[last];
  if (!entry || entry.dir) return null;
  const entryBytes = await entry.async("uint8array").catch(() => null);
  if (!entryBytes) return null;
  const name = zipInner.name || safeZipEntryName(entry.name);
  const content = new TextDecoder().decode(entryBytes);
  return c.json({
    code: true,
    data: {
      name,
      path: rawPath,
      pathDisplay: name,
      ext: name.includes(".") ? name.split(".").pop()!.toLowerCase() : "",
      size: entryBytes.byteLength,
      charset: "utf-8",
      base64: "0",
      pageInfo: { page: 1, pageNum: 1, pageTotal: 1 },
      content,
    },
  });
}

// fileGet - 读取文本内容（编辑器预览）
shareApi.all("/share/fileGet", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const { share, owner, storage } = init;
  const errMsg = authCheck(c, share, "fileget", params);
  if (errMsg) return c.json({ code: false, data: errMsg });

  const path = typeof params.path === "string" ? params.path : "";
  // zip 预览面板内条目: path 是完整 unzipList URL 串
  const zipRes = await shareFileGetZipInner(c, share, owner, storage, path);
  if (zipRes) return zipRes;

  const rel = parseShareLinkRel(share, path);
  if (rel === null) return c.json({ code: false, data: L.pathNotExists });
  // 空 rel 表示分享源本身（文件分享的根路径）
  const fullRel = shareJoinRel(storage.relPath, rel);
  const bytes = await shareReadBytes(c.env, owner, storage.source, fullRel);
  if (!bytes) return c.json({ code: false, data: L.pathNotExists });
  const head = await shareHeadOf(c.env, owner, storage.source, fullRel);

  const name = rel.split("/").filter(Boolean).pop() || (rel === "" ? share.title : "");
  const content = new TextDecoder().decode(bytes);
  return c.json({
    code: 1,
    data: {
      name,
      path: shareLinkRoot(share.shareHash) + rel,
      pathDisplay: share.title + "/" + rel,
      ext: name.includes(".") ? name.split(".").pop()!.toLowerCase() : "",
      size: head?.size ?? bytes.byteLength,
      charset: "utf-8",
      base64: "0",
      pageInfo: { page: 1, pageNum: 1, pageTotal: 1 },
      content,
    },
  });
});

// fileSave - 保存文本内容
shareApi.all("/share/fileSave", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const { share, owner } = init;
  const errMsg = authCheck(c, share, "filesave", params);
  if (errMsg) return c.json({ code: false, data: errMsg });

  const rel = parseShareLinkRel(share, typeof params.path === "string" ? params.path : "");
  if (rel === null) return c.json({ code: false, data: L.pathNotExists });
  let content = typeof params.content === "string" ? params.content : "";
  if (params.base64 === "1") content = decodeBase64(content);
  const realPath = joinShareRealPath(share.sourcePath, rel);
  const key = shareStorageKey(owner.username, realPath);
  await c.env.FILES.put(key, content);
  await addAuditLog(c.env.DB, "shareFileSave", owner.id, realPath, null, null, null);
  return c.json({ code: 1, data: "ok", info: shareLinkRoot(share.shareHash) + rel });
});

// mkdir / mkfile / pathRename / pathDelete - 编辑操作（canEditSave）
shareApi.all("/share/mkdir", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const { share, owner } = init;
  const errMsg = authCheck(c, share, "mkdir", params);
  if (errMsg) return c.json({ code: false, data: errMsg });

  const rel = parseShareLinkRel(share, typeof params.path === "string" ? params.path : "");
  if (rel === null) return c.json({ code: false, data: L.noPermission });
  const realDir = joinShareRealPath(share.sourcePath, rel, true);
  await c.env.FILES.put(getUserFileKey(owner.username, realDir + ".keep"), "");
  return c.json({ code: 1, data: "ok", info: realDir });
});

shareApi.all("/share/mkfile", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const { share, owner } = init;
  const errMsg = authCheck(c, share, "mkfile", params);
  if (errMsg) return c.json({ code: false, data: errMsg });

  const rel = parseShareLinkRel(share, typeof params.path === "string" ? params.path : "");
  if (rel === null || !rel) return c.json({ code: false, data: L.pathNotExists });
  let content = typeof params.content === "string" ? params.content : "";
  if (params.base64 === "1") content = decodeBase64(content);
  const realPath = joinShareRealPath(share.sourcePath, rel);
  await c.env.FILES.put(shareStorageKey(owner.username, realPath), content);
  return c.json({ code: 1, data: "ok", info: shareLinkRoot(share.shareHash) + rel });
});

shareApi.all("/share/pathRename", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const { share, owner } = init;
  const errMsg = authCheck(c, share, "pathrename", params);
  if (errMsg) return c.json({ code: false, data: errMsg });

  const rel = parseShareLinkRel(share, typeof params.path === "string" ? params.path : "");
  const newName = typeof params.newName === "string" ? params.newName : "";
  if (rel === null || !rel || !newName || newName.includes("/")) return c.json({ code: false, data: "参数错误" });

  const isFolder = rel.endsWith("/");
  const realPath = joinShareRealPath(share.sourcePath, rel, isFolder);
  const parent = realPath.substring(0, realPath.lastIndexOf("/") + 1);
  const newPath = parent + newName + (isFolder ? "/" : "");
  const oldKey = shareStorageKey(owner.username, realPath);
  const newKey = getUserFileKey(owner.username, newPath);

  if (isFolder) {
    const prefix = oldKey.endsWith("/") ? oldKey : oldKey + "/";
    const destPrefix = newKey.endsWith("/") ? newKey : newKey + "/";
    let cursor: string | undefined;
    do {
      const batch = await c.env.FILES.list({ prefix, cursor });
      for (const o of batch.objects) {
        const relPath = o.key.slice(prefix.length);
        const data = await c.env.FILES.get(o.key);
        if (data) {
          await c.env.FILES.put(destPrefix + relPath, data.body, { httpMetadata: o.httpMetadata, customMetadata: o.customMetadata });
          await c.env.FILES.delete(o.key);
        }
      }
      cursor = batch.truncated ? batch.cursor : undefined;
    } while (cursor);
  } else {
    const obj = await c.env.FILES.get(oldKey);
    if (obj) {
      await c.env.FILES.put(newKey, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
      await c.env.FILES.delete(oldKey);
    }
  }
  return c.json({ code: 1, data: "ok", info: shareLinkRoot(share.shareHash) + rel });
});

shareApi.all("/share/pathDelete", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const { share, owner } = init;
  const errMsg = authCheck(c, share, "pathdelete", params);
  if (errMsg) return c.json({ code: false, data: errMsg });

  const items = parseDataArr(params.dataArr);
  if (items.length === 0) return c.json({ code: false, data: "参数错误" });
  for (const item of items) {
    const rel = parseShareLinkRel(share, item.path);
    if (rel === null) return c.json({ code: false, data: L.noPermission });
    const isFolder = rel.endsWith("/");
    const realPath = joinShareRealPath(share.sourcePath, rel, isFolder);
    const key = shareStorageKey(owner.username, realPath);
    if (isFolder) {
      await deleteR2Directory(c.env.FILES, key.endsWith("/") ? key : key + "/");
    } else {
      await c.env.FILES.delete(key);
    }
  }
  return c.json({ code: 1, data: "ok" });
});

// pathCopy / pathCute - 复制/剪切到剪贴板（存 shareClip Cookie，兼容未登录访客）
shareApi.all("/share/pathCopy", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const errMsg = authCheck(c, init.share, "pathcopy", params);
  if (errMsg) return c.json({ code: false, data: errMsg });
  const items = parseDataArr(params.dataArr);
  if (items.length === 0) return c.json({ code: false, data: L.error });
  for (const it of items) {
    if (parseShareLinkRel(init.share, it.path) === null) return c.json({ code: false, data: L.noPermission });
  }
  setShareClip(c, "copy", items);
  return c.json({ code: 1, data: "复制成功" });
});

shareApi.all("/share/pathCute", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const errMsg = authCheck(c, init.share, "pathcute", params);
  if (errMsg) return c.json({ code: false, data: errMsg });
  const items = parseDataArr(params.dataArr);
  if (items.length === 0) return c.json({ code: false, data: L.error });
  for (const it of items) {
    if (parseShareLinkRel(init.share, it.path) === null) return c.json({ code: false, data: L.noPermission });
  }
  setShareClip(c, "cute", items);
  return c.json({ code: 1, data: "剪切成功" });
});

// pathPast - 从剪贴板粘贴（或 pathCopyTo/pathCuteTo 显式指定来源）
shareApi.all("/share/pathPast", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const errMsg = authCheck(c, init.share, "pathpast", params);
  if (errMsg) return c.json({ code: false, data: errMsg });
  const clip = getShareClip(c);
  if (clip.list.length === 0) return c.json({ code: false, data: "剪贴板为空" });
  const res = await runSharePaste(c, init, params, clip.type === "cute" ? "cute" : "copy", clip.list);
  if (clip.type === "cute") clearShareClip(c);
  return res;
});

// pathCopyTo / pathCuteTo - 直接复制/移动到目标目录
shareApi.all("/share/pathCopyTo", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const errMsg = authCheck(c, init.share, "pathcopyto", params);
  if (errMsg) return c.json({ code: false, data: errMsg });
  return runSharePaste(c, init, params, "copy", parseDataArr(params.dataArr));
});

shareApi.all("/share/pathCuteTo", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const errMsg = authCheck(c, init.share, "pathcuteto", params);
  if (errMsg) return c.json({ code: false, data: errMsg });
  return runSharePaste(c, init, params, "cute", parseDataArr(params.dataArr));
});

// fileUpload - 分享上传（目标为分享者空间，canEdit/canUpload 控制）
shareApi.post("/share/fileUpload", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const { share, owner } = init;
  const errMsg = authCheck(c, share, "fileupload", params);
  if (errMsg) return c.json({ code: false, data: errMsg });

  const contentType = c.req.header("Content-Type") || "";
  let path = "/", name = "", size = 0, chunk = 0, chunks = 1, chunkSizeParam = 0, checkType = "";
  let file: File | null = null;

  const isMultipart = contentType.includes("multipart/form-data");
  const isUrlencoded = contentType.includes("application/x-www-form-urlencoded");
  if (!isMultipart && !isUrlencoded) {
    // sendAsBinary 模式: 表单参数拼入 URL query, 请求体为文件二进制流
    // (浏览器请求 Content-Type 为文件自身 MIME, 如 text/plain; 而非 application/octet-stream)
    const q = c.req.query();
    path = q.path || "/";
    name = q.name || "";
    size = parseInt(q.size || "0", 10);
    chunk = parseInt(q.chunk || "0", 10);
    chunks = parseInt(q.chunks || "1", 10);
    chunkSizeParam = parseInt(q.chunkSize || "0", 10);
    checkType = q.checkType || "";
    if (name) {
      const buf = await c.req.arrayBuffer();
      file = new File([buf], name, { type: q.type || "application/octet-stream" });
    }
  } else {
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    path = str("path") || "/";
    name = str("name");
    size = parseInt(str("size") || "0", 10);
    chunk = parseInt(str("chunk") || "0", 10);
    chunks = parseInt(str("chunks") || "1", 10);
    chunkSizeParam = parseInt(str("chunkSize") || "0", 10);
    checkType = str("checkType");
    file = body["file"] instanceof File ? (body["file"] as File) : null;
  }
  if (chunkSizeParam > 0 && size > 0 && chunkSizeParam >= size) chunks = 1;

  if (checkType) {
    return c.json({
      code: 1,
      data: "success",
      info: {
        checkChunkArray: {},
        checkFileHash: { hashSimple: null, hashMd5: null },
        uploadLinkInfo: false,
        uploadToKod: true,
        uploadChunkSize: "10",
        kodDriverType: "Local",
      },
    });
  }
  if (!file) return c.json({ code: false, data: "No file" });

  const rel = parseShareLinkRel(share, path);
  if (rel === null) return c.json({ code: false, data: L.noPermission });
  const realDir = joinShareRealPath(share.sourcePath, rel, true);
  const fileName = name || file.name;
  const key = getUserFileKey(owner.username, realDir + fileName);

  try {
    if (chunks > 1) {
      // 分片上传: 每个分片独立暂存为临时对象, 全部到达后按序流式合并,
      // 规避 R2 multipart 每 part 最小 5MiB 的限制(前端默认分片仅 2MB)。
      const sessionId = await sha256Hex(`${owner.username}|${realDir}|${fileName}|${size}`);
      const tmpPrefix = getUserFileKey(owner.username, `/.upload_tmp/${sessionId}/`);
      const chunkKey = `${tmpPrefix}chunk_${chunk}`;
      const mergedKey = `${tmpPrefix}merged`;

      if (chunk === 0 && (await c.env.FILES.head(mergedKey))) {
        const staleKeys = await listAllKeys(c.env.FILES, tmpPrefix);
        if (staleKeys.length > 0) await c.env.FILES.delete(staleKeys);
      }

      await c.env.FILES.put(chunkKey, file.stream(), { httpMetadata: { contentType: file.type || getFileMimeType(fileName) } });

      const chunkKeys: string[] = [];
      for (let i = 0; i < chunks; i++) chunkKeys.push(`${tmpPrefix}chunk_${i}`);
      let allPresent = true;
      for (const k of chunkKeys) {
        if (!(await c.env.FILES.head(k))) {
          allPresent = false;
          break;
        }
      }
      if (!allPresent) {
        return c.json({ code: 1, data: `chunk_success_${chunk}` });
      }

      const mergedObj = await c.env.FILES.head(mergedKey);
      if (!mergedObj) {
        try {
          await mergeChunks(c.env.FILES, chunkKeys, size, key, { httpMetadata: { contentType: file.type || getFileMimeType(fileName) } });
          await c.env.FILES.put(mergedKey, "1");
        } catch (err) {
          if (!(await c.env.FILES.head(mergedKey))) throw err;
        }
      }

      const tmpKeys = await listAllKeys(c.env.FILES, tmpPrefix);
      if (tmpKeys.length > 0) await c.env.FILES.delete(tmpKeys);
    } else {
      await c.env.FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || getFileMimeType(fileName) } });
    }
    await addAuditLog(c.env.DB, "shareUpload", owner.id, realDir + fileName, null, null, `Size: ${size || file.size}`);
    return c.json({ code: 1, data: "上传成功", info: shareLinkRoot(share.shareHash) + rel.replace(/\/+$/, "") + "/" + fileName });
  } catch (err: any) {
    return c.json({ code: false, data: err.message });
  }
});

// report - 举报分享
shareApi.all("/share/report", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  await addAuditLog(c.env.DB, "shareReport", null, init.share.sourcePath, null, null, `type:${params.type || ""} desc:${params.desc || ""}`);
  return c.json({ code: true, data: "OK" });
});

// zipDownload - 客户端打包文件清单（zipClient=1，复刻 001 share::zipDownload 客户端分支）
shareApi.all("/share/zipDownload", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const errMsg = authCheck(c, init.share, "zipdownload", params);
  if (errMsg) return c.json({ code: false, data: errMsg });
  if (String(params.zipClient) !== "1") return c.json({ code: false, data: "暂不支持" });

  const items = parseDataArr(params.dataArr);
  if (items.length === 0) return c.json({ code: false, data: L.error });
  const out: Record<string, unknown>[] = [];
  for (const it of items) {
    const rel = parseShareLinkRel(init.share, it.path);
    if (rel === null) continue;
    const name = rel ? rel.replace(/\/+$/, "").split("/").pop()! : init.source.name;
    await shareZipCollect(c, init.owner, init.share, init.source, init.storage, rel, "/" + name, out);
  }
  return c.json({ code: true, data: out });
});
// unzipList / unzipListHash - 返回分享 zip 内文件列表 (扁平数组, 对齐前端 makeTree)
async function shareUnzipListHandler(c: AppContext): Promise<Response> {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const { share, owner, storage } = init;
  const errMsg = authCheck(c, share, "fileget", params);
  if (errMsg) return c.json({ code: false, data: errMsg });

  const path = typeof params.path === "string" ? params.path : "";
  const rel = parseShareLinkRel(share, path);
  if (rel === null) return c.json({ code: false, data: L.pathNotExists });
  const fullRel = shareJoinRel(storage.relPath, rel);

  // 优先只读 central directory (Range 下载, 规避全量下载慢)
  const central = await readZipCentralDirectory({
    readRange: (s, e) => shareRangeRead(c, owner, storage.source, fullRel, s, e),
  }).catch(() => null);
  if (central && central.length > 0) return c.json({ code: true, data: shareZipList(central) });

  // 回退: 全量下载 + JSZip 解析
  const zo = await shareZipObject(c, owner, storage, rel);
  if (!zo) return c.json({ code: false, data: L.pathNotExists });
  const zip = await JSZip.loadAsync(zo.bytes, { decodeFileName: zipDecodeFileName });
  const entries = Object.values(zip.files);
  const list = shareZipList(entries.map((e: any) => ({
    name: e.name,
    dir: e.dir,
    size: e.dir ? 0 : ((e._data?.uncompressedSize ?? 0)),
    mtimeSec: e.date ? Math.floor(e.date.getTime() / 1000) : 0,
  })));
  return c.json({ code: true, data: list });
}

shareApi.all("/share/unzipList", shareUnzipListHandler);
shareApi.all("/share/unzipListHash", shareUnzipListHandler);

// fileGetHash - 压缩包内文本文件请求 (001 分享页 zip 内文件读取, 复用 fileGet 的 zip 分支)
shareApi.all("/share/fileGetHash", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const { share, owner, storage } = init;
  const errMsg = authCheck(c, share, "fileget", params);
  if (errMsg) return c.json({ code: false, data: errMsg });
  const path = typeof params.path === "string" ? params.path : "";
  const zipRes = await shareFileGetZipInner(c, share, owner, storage, path);
  if (zipRes) return zipRes;
  return c.json({ code: false, data: L.pathNotExists });
});
// fileDownloadRemove - 下载 explorer/index/zipDownload 生成的临时 zip (带登录态), 下载后删除
shareApi.all("/share/fileDownloadRemove", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const path = typeof params.path === "string" ? params.path : "";
  if (!user || !path) return c.json({ code: false, data: L.pathNotExists });
  const src = await resolveFileSource(c.env, user, path);
  if (!src.ok) return c.json({ code: false, data: src.error });
  const key = keyFromBase(src.source.baseKey, src.relPath);
  const obj = await c.env.FILES.get(key).catch(() => null);
  if (!obj) return c.json({ code: false, data: L.pathNotExists });
  const name = path.split("/").filter(Boolean).pop() || "archive.zip";
  await c.env.FILES.delete(key).catch(() => undefined);
  const headers = new Headers();
  headers.set("Content-Type", "application/zip");
  headers.set("Content-Disposition", `attachment; filename="${encodeURIComponent(name)}"`);
  headers.set("Cache-Control", "no-store");
  obj.writeHttpMetadata(headers);
  return new Response(obj.body, { headers });
});

// ---------- 分享管理（需登录） ----------

// get - 通过路径获取分享；没有则返回 false
shareApi.all("/userShare/get", async (c) => {
  const user = c.get("currentUser")!;
  const params = await reqParams(c);
  const path = typeof params.path === "string" ? params.path : "";
  if (!path) return c.json({ code: true, data: false });

  // "我分享的"/"外链分享" 列表里的项 path 是 {shareItem:<id>} 虚拟路径（非真实 sourcePath），
  // 编辑分享/快速复制外链时前端会据此调用，这里先解析虚拟路径按 shareID 直查，避免误判为"无分享"。
  let share: ShareRow | null = null;
  const itemMatch = path.match(/^\{shareItem:(\d+)\}/);
  if (itemMatch) {
    const item = await getShareById(c.env.DB, parseInt(itemMatch[1], 10));
    if (item && item.userID === user.id) share = item;
  } else {
    share = await getShareBySourcePath(c.env.DB, user.id, path);
  }
  if (!share) return c.json({ code: true, data: false });

  const source = await resolveShareSourceForUser(c.env, user, share.sourcePath);
  return c.json({ code: true, data: await buildManageShareInfo(c.env, share, source) });
});

// add - 新增分享
shareApi.all("/userShare/add", async (c) => {
  const user = c.get("currentUser")!;
  const params = await reqParams(c);
  const path = typeof params.path === "string" ? params.path : "";
  if (!path) return c.json({ code: false, data: "参数错误" });
  // 保险箱内容不支持分享 (001 listSafe.authCheck)
  if (path.startsWith("{block:safe}")) return c.json({ code: false, data: "保险箱内容不支持分享" });
  const isLink = String(params.isLink) === "1" ? 1 : 0;

  // 解析分享源（个人空间/部门空间/io 挂载），部门/io 保留虚拟前缀
  const srcRes = await resolveFileSource(c.env, user, path);
  if (!srcRes.ok) return c.json({ code: false, data: L.pathNotExists });
  const src = srcRes.source;
  const relPath = srcRes.relPath;
  const srcIsFolder = relPath.endsWith("/");
  const existKey = keyFromBase(src.baseKey, relPath);
  const srcIo = src.type === "io" ? ioClientOf(src) : null;
  if (srcIsFolder) {
    const prefix = existKey.endsWith("/") ? existKey : existKey + "/";
    if (srcIo) {
      const listed = await srcIo.list(prefix).catch(() => null);
      if (!listed || (listed.folders.length === 0 && listed.files.length === 0)) return c.json({ code: false, data: L.pathNotExists });
    } else {
      const listed = await c.env.FILES.list({ prefix, limit: 1 });
      if (listed.objects.length === 0 && (listed.delimitedPrefixes || []).length === 0) return c.json({ code: false, data: L.pathNotExists });
    }
  } else {
    if (srcIo) {
      const head = await srcIo.head(existKey).catch(() => null);
      if (!head) return c.json({ code: false, data: L.pathNotExists });
    } else {
      const obj = await c.env.FILES.head(existKey);
      if (!obj) return c.json({ code: false, data: L.pathNotExists });
    }
  }
  const srcName = relPath === "/" ? src.displayName : relPath.split("/").filter(Boolean).pop() || "";
  const sourcePath = src.type === "group" ? `{source:${src.sourceId}}${relPath}` : src.type === "io" ? `{io:${src.sourceId}}${relPath}` : relPath;
  const source: { type: "folder" | "file"; name: string; realPath: string } = { type: srcIsFolder ? "folder" : "file", name: srcName, realPath: sourcePath };

  let options: Record<string, any> = {};
  if (typeof params.options === "string" && params.options) {
    try {
      const o = JSON.parse(params.options);
      if (o && typeof o === "object") options = o;
    } catch {
      /* ignore */
    }
  }

  if (isLink) {
    const shareLinkAllow = (await getSetting(c.env.DB, "shareLinkAllow")) ?? "1";
    if (shareLinkAllow === "0") return c.json({ code: false, data: "外链分享已关闭" });
    const password = typeof params.password === "string" ? params.password : "";
    const allowEmpty = (await getSetting(c.env.DB, "shareLinkPasswordAllowEmpty")) ?? "1";
    if (allowEmpty === "0" && !password) return c.json({ code: false, data: "密码不能为空" });
    const allowGuest = (await getSetting(c.env.DB, "shareLinkAllowGuest")) ?? "1";
    if (allowGuest === "0") options["onlyLogin"] = "1";
  }

  const title = typeof params.title === "string" && params.title ? params.title : source.name;
  const timeTo = parseInt(String(params.timeTo ?? "0"), 10) || 0;
  const shareHash = await generateShareHash(c.env.DB);

  // 内部协作分享: authTo 目标 (isShareTo=1)
  const authTo = parseAuthTo(params.authTo);
  const isShareTo = authTo.length > 0 ? 1 : 0;

  // 协作分享可设置的权限不能超过自己在文档的权限 (001 checkSetAuthAllow)
  if (authTo.length > 0) {
    const allow = await checkSetAuthAllow(c.env, user, path, authTo);
    if (!allow) return c.json({ code: false, data: "admin.auth.errorAdmin" });
  }

  const id = await addShare(c.env.DB, {
    userID: user.id,
    title,
    shareHash,
    sourcePath: source.realPath,
    isLink,
    isShareTo,
    password: typeof params.password === "string" ? params.password : "",
    timeTo,
    options,
  });
  if (authTo.length > 0) await replaceShareTo(c.env.DB, id, authTo);
  const share = await getShareById(c.env.DB, id);
  if (!share) return c.json({ code: false, data: L.error });
  return c.json({ code: true, data: await buildManageShareInfo(c.env, share, source) });
});

// edit - 编辑分享
shareApi.all("/userShare/edit", async (c) => {
  const user = c.get("currentUser")!;
  const params = await reqParams(c);
  const shareID = parseInt(String(params.shareID ?? ""), 10);
  if (!Number.isFinite(shareID) || shareID <= 0) return c.json({ code: false, data: "参数错误" });

  const share = await getShareById(c.env.DB, shareID);
  if (!share || share.userID !== user.id) return c.json({ code: false, data: L.noPermission });

  const data: Record<string, any> = {};
  if (params.title !== undefined && params.title !== null && String(params.title) !== "") data.title = String(params.title);
  if (params.shareHash !== undefined && params.shareHash !== null && String(params.shareHash) !== "") {
    data.shareHash = String(params.shareHash).replace(/[^\w\-\._]/g, "_").slice(0, 45);
  }
  if (params.password !== undefined && params.password !== null) data.password = String(params.password);
  if (params.timeTo !== undefined && params.timeTo !== null) data.timeTo = parseInt(String(params.timeTo), 10) || 0;
  if (params.options !== undefined && params.options !== null) {
    let options: Record<string, any> = {};
    if (typeof params.options === "string" && params.options) {
      try {
        const o = JSON.parse(params.options);
        if (o && typeof o === "object") options = o;
      } catch {
        /* ignore */
      }
    } else if (typeof params.options === "object") {
      options = params.options;
    }
    data.options = options;
  }
  if (Object.keys(data).length > 0) await editShare(c.env.DB, shareID, data);

  // 内部协作目标更新 (authTo 为空数组表示清空)
  if (params.authTo !== undefined && params.authTo !== null) {
    const authTo = parseAuthTo(params.authTo);
    if (authTo.length > 0) {
      await replaceShareTo(c.env.DB, shareID, authTo);
      await c.env.DB.prepare("UPDATE share SET isShareTo = 1 WHERE shareID = ?").bind(shareID).run();
    } else {
      await replaceShareTo(c.env.DB, shareID, []);
      await c.env.DB.prepare("UPDATE share SET isShareTo = 0 WHERE shareID = ?").bind(shareID).run();
    }
  }

  const updated = await getShareById(c.env.DB, shareID);
  const source = updated ? await resolveShareSourceForUser(c.env, user, updated.sourcePath) : null;
  if (!updated) return c.json({ code: false, data: L.error });
  return c.json({ code: true, data: await buildManageShareInfo(c.env, updated, source) });
});

// del - 批量取消分享
shareApi.all("/userShare/del", async (c) => {
  const user = c.get("currentUser")!;
  const params = await reqParams(c);
  let list: any[] = params.dataArr;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) list = [];
  if (list.length === 0) return c.json({ code: false, data: "参数错误" });

  const ids: number[] = [];
  for (const item of list) {
    const id = extractShareID(item);
    if (id === null) continue;
    const share = await getShareById(c.env.DB, id);
    if (!share || share.userID !== user.id) continue;
    ids.push(id);
  }
  await removeShares(c.env.DB, ids);
  await removeShareToByShareIds(c.env.DB, ids);
  return c.json({ code: true, data: L.success });
});

// shareDisplay - 隐藏/显示 "分享给我的" 列表项 (001 explorer/userShare::shareDisplay)
shareApi.all("/userShare/shareDisplay", async (c) => {
  const user = c.get("currentUser")!;
  const params = await reqParams(c);
  const shareArr = parseJsonArray(params.shareArr);
  const isHide = String(params.isHide ?? "1") === "1";
  const hide = await getUserShareHide(c.env.DB, user.id);
  for (const raw of shareArr) {
    const key = String(raw);
    if (isHide) hide[key] = "1";
    else delete hide[key];
  }
  await setUserOption(c.env.DB, user.id, "hideList", JSON.stringify(hide), "shareToMe");
  return c.json({ code: true, data: L.success });
});

// shareExit - 退出与我协作的分享 (001 explorer/userShare::shareExit)
shareApi.all("/userShare/shareExit", async (c) => {
  const user = c.get("currentUser")!;
  const params = await reqParams(c);
  const shareArr = parseJsonArray(params.shareArr);
  const errors: string[] = [];
  for (const raw of shareArr) {
    const shareID = parseInt(String(raw), 10);
    const share = await getShareById(c.env.DB, shareID);
    if (!share || share.isShareTo !== 1) {
      errors.push(t("explorer.share.notExist"));
      continue;
    }
    const targets = await getShareToList(c.env.DB, shareID);
    const selfIndex = targets.findIndex((tt) => tt.targetType === 1 && tt.targetID === user.id);
    if (selfIndex < 0) {
      errors.push("share target not include you");
      continue;
    }
    const rest = targets.filter((_, i) => i !== selfIndex);
    if (rest.length === 0 && share.isLink === 0) {
      await removeShares(c.env.DB, [shareID]);
      await removeShareToByShareIds(c.env.DB, [shareID]);
    } else {
      await replaceShareTo(
        c.env.DB,
        shareID,
        rest.map((tt) => ({ targetType: String(tt.targetType), targetID: String(tt.targetID), authID: String(tt.authID) }))
      );
    }
  }
  const ok = errors.length === 0;
  return c.json({ code: ok, data: ok ? L.success : errors.join(",") });
});

// shareToMe - 与我协作内容（list / group / user 三种展示方式，001 explorer/userShare::shareToMe）
shareApi.all("/userShare/shareToMe", async (c) => {
  const user = c.get("currentUser")!;
  const params = await reqParams(c);
  const type = typeof params.type === "string" ? params.type : "";
  return c.json({ code: true, data: await shareToMeDispatch(c.env, user, type) });
});

// ============ 与我协作：按组织架构/按分享者（001 explorer/userShareGroup、explorer/userShareUser）============

shareApi.all("/userShareGroup/get", async (c) => {
  const user = c.get("currentUser")!;
  const params = await reqParams(c);
  const id = typeof params.id === "string" ? params.id : "";
  return c.json({ code: true, data: await userShareGroupGet(c.env, user, id) });
});

shareApi.all("/userShareUser/get", async (c) => {
  const user = c.get("currentUser")!;
  const params = await reqParams(c);
  const id = typeof params.id === "string" ? params.id : "";
  return c.json({ code: true, data: await userShareUserGet(c.env, user, id) });
});

// ============ 导出（供 explorer-api 虚拟路径使用） ============

/** 解析分享项的虚拟路径：{shareItem:<id>}/<相对子路径>。 */
export function parseShareItemPath(p: string): { shareID: number; rel: string } | null {
  const m = p.match(/^\{shareItem:(\d+)\}(.*)$/);
  if (!m) return null;
  return { shareID: parseInt(m[1], 10), rel: m[2].replace(/^\/+/, "") };
}

/** "我分享的"/"外链分享" 虚拟目录列表数据。 */
export async function listUserShareVirtual(
  env: Env,
  user: AuthUser,
  thisPath: string,
  linkOnly: boolean
): Promise<Record<string, unknown>> {
  const shares = await listUserShares(env.DB, user.id, linkOnly);
  const folderList: Record<string, unknown>[] = [];
  const fileList: Record<string, unknown>[] = [];

  for (const share of shares) {
    const source = await resolveShareSource(env, user, share);
    if (!source) continue;
    const isFolder = source.type === "folder";
    const itemPath = `{shareItem:${share.shareID}}` + (isFolder ? "/" : "");
    const base: Record<string, unknown> = {
      name: source.name,
      path: itemPath,
      pathDisplay: itemPath.replace(/^\{shareItem:\d+\}/, share.title || source.name),
      type: isFolder ? "folder" : "file",
      isFolder,
      isWriteable: true,
      isReadable: true,
      shareID: share.shareID,
      shareCreateTime: share.createTime,
      shareModifyTime: share.modifyTime,
      sharePathFrom: "分享者(" + (user.nickname || user.username) + ")",
      shareUser: shareUserInfo(user),
      shareFromShow: true,
      sourceInfo: {
        shareInfo: { ...share, options: shareOptions(share) },
        shareIsRoot: true,
      },
    };
    (isFolder ? folderList : fileList).push(base);
  }

  return {
    current: {
      name: linkOnly ? "外链分享" : "我分享的",
      path: thisPath,
      pathDisplay: linkOnly ? "外链分享" : "我分享的",
      type: "folder",
      isFolder: true,
      isWriteable: true,
      isReadable: true,
    },
    folderList,
    fileList,
    groupList: [],
    pageInfo: { totalNum: folderList.length + fileList.length, pageNum: 500, page: 1, pageTotal: 1 },
    thisPath,
    targetSpace: { sizeMax: 0, sizeUse: 0 },
  };
}

/** 当前用户所在部门 id 列表（直接成员关系）。 */
async function getUserGroupIds(db: D1Database, userId: number): Promise<number[]> {
  const rows = (await db
    .prepare("SELECT group_id FROM user_groups WHERE user_id = ?")
    .bind(userId)
    .all()) as unknown as { results: { group_id: number }[] };
  return rows.results.map((r) => r.group_id);
}

/** 用户所在的部门树根部门 id（parent_id = 0 的部门；沿 parentLevel 向上取首个）。 */
async function getUserRootGroup(db: D1Database, userId: number): Promise<number | null> {
  const groupIds = await getUserGroupIds(db, userId);
  if (groupIds.length === 0) return null;
  const placeholders = groupIds.map(() => "?").join(",");
  const groups = (await db
    .prepare(`SELECT id, parent_id, parent_level FROM groups WHERE id IN (${placeholders})`)
    .bind(...groupIds)
    .all()) as unknown as { results: { id: number; parent_id: number; parent_level: string }[] };
  const root = groups.results.find((g) => g.parent_id === 0);
  if (root) return root.id;
  const chain = groups.results
    .map((g) => parseInt(g.parent_level.split(",")[0], 10) || 0)
    .filter((id) => id > 0);
  return chain[0] ?? null;
}

/** 用户的部门树根及全部祖先/自身部门（用于 share_to group 命中判断）。 */
async function getUserGroupTree(db: D1Database, userId: number): Promise<number[]> {
  const groupIds = await getUserGroupIds(db, userId);
  const ids = new Set<number>(groupIds);
  if (groupIds.length === 0) return [...ids];
  const placeholders = groupIds.map(() => "?").join(",");
  const groups = (await db
    .prepare(`SELECT id, parent_level FROM groups WHERE id IN (${placeholders})`)
    .bind(...groupIds)
    .all()) as unknown as { results: { id: number; parent_level: string }[] };
  for (const g of groups.results) {
    for (const pid of (g.parent_level || "").split(",").filter(Boolean)) {
      const n = parseInt(pid, 10);
      if (n > 0) ids.add(n);
    }
  }
  return [...ids];
}

/** 读取 "分享给我" 的分享列表（share_to 命中当前用户或用户所属部门）。 */
async function listShareToMeForUser(
  db: D1Database,
  userId: number,
  groupTree: number[]
): Promise<ShareRow[]> {
  const conds: string[] = [];
  const args: unknown[] = [];
  conds.push("(targetType = 1 AND targetID = ?)");
  args.push(userId);
  if (groupTree.length > 0) {
    conds.push(`(targetType = 2 AND targetID IN (${groupTree.map(() => "?").join(",")}))`);
    args.push(...groupTree);
  }
  const rows = (await db
    .prepare(
      `SELECT s.* FROM share_to st JOIN share s ON s.shareID = st.shareID
       WHERE ${conds.join(" OR ")} ORDER BY st.createTime DESC`
    )
    .bind(...args)
    .all()) as unknown as { results: ShareRow[] };
  return rows.results;
}

interface ShareItemUser {
  id: number;
  username: string;
  nickname: string;
}

/** "分享给我的" 分享项列表项构造（源解析后）。 */
async function shareToMeItemMake(
  env: Env,
  share: ShareRow,
  owner: ShareItemUser,
  groupInfo?: { name: string }
): Promise<Record<string, unknown> | null> {
  const source = await resolveShareSource(env, { id: owner.id, username: owner.username, nickname: owner.nickname } as AuthUser, share);
  if (!source) return null;
  const isFolder = source.type === "folder";
  const itemPath = `{shareItem:${share.shareID}}` + (isFolder ? "/" : "");
  return {
    name: source.name,
    path: itemPath,
    pathDisplay: itemPath.replace(/^\{shareItem:\d+\}/, share.title || source.name),
    type: isFolder ? "folder" : "file",
    isFolder,
    isWriteable: false,
    isReadable: true,
    shareID: share.shareID,
    shareCreateTime: share.createTime,
    shareModifyTime: share.modifyTime,
    sharePathFrom: "分享者(" + (owner.nickname || owner.username) + ")",
    shareUser: shareUserInfo({ id: owner.id, username: owner.username, nickname: owner.nickname } as AuthUser),
    shareFromShow: true,
    shareGroupName: groupInfo?.name,
    sourceInfo: {
      shareInfo: { ...share, options: shareOptions(share) },
      shareIsRoot: true,
    },
  };
}

/** 构造 "分享者用户" 文件夹项（{shareToMe:user-U} 入口）。 */
function shareToMeUserItem(user: AuthUser, parentGroup: string): Record<string, unknown> {
  return {
    name: user.nickname || user.username,
    path: `{shareToMe:user-${user.id}}/`,
    pathDisplay: "分享者(" + (user.nickname || user.username) + ")",
    type: "folder",
    isFolder: true,
    isWriteable: false,
    isReadable: true,
    icon: "user",
    iconClassName: "avatar",
    shareUser: shareUserInfo(user),
  };
}

/** 构造 "分享者用户+部门" 文件夹项（{shareToMe:group-uU-P} 入口）。 */
function shareToMeGroupUserItem(user: AuthUser, parentGroup: string): Record<string, unknown> {
  return {
    name: user.nickname || user.username,
    path: `{shareToMe:group-u${user.id}-${parentGroup}}/`,
    pathDisplay: (user.nickname || user.username) + "(分享给我)",
    type: "folder",
    isFolder: true,
    isWriteable: false,
    isReadable: true,
    icon: "user",
    iconClassName: "avatar",
    shareUser: shareUserInfo(user),
  };
}

/** "分享给我的" 根视图（{shareToMe}/）：按分享者所属部门归类展示用户文件夹。 */
export async function listShareToMeRoot(
  env: Env,
  user: AuthUser,
  thisPath: string
): Promise<Record<string, unknown>> {
  const groupTree = await getUserGroupTree(env.DB, user.id);
  const shares = await listShareToMeForUser(env.DB, user.id, groupTree);

  const userSet = new Map<number, ShareItemUser>();
  for (const share of shares) {
    if (userSet.has(share.userID)) continue;
    const u = (await getUserById(env.DB, share.userID)) as unknown as { id: number; username: string; nickname: string } | null;
    if (!u) continue;
    userSet.set(share.userID, { id: u.id, username: u.username, nickname: u.nickname || u.username });
  }

  const groupList: Record<string, unknown>[] = [];
  const folderList: Record<string, unknown>[] = [];
  const shareUserIds: number[] = [];
  const seenGroups = new Set<number>();

  for (const [uid, uinfo] of userSet) {
    const uGroups = await getUserGroupIds(env.DB, uid);
    const rootGid = await getUserRootGroup(env.DB, uid);
    shareUserIds.push(uid);
    if (rootGid && !seenGroups.has(rootGid)) {
      const g = (await env.DB.prepare("SELECT id, name FROM groups WHERE id = ?").bind(rootGid).first()) as
        | { id: number; name: string }
        | null;
      if (g) {
        seenGroups.add(rootGid);
        groupList.push({
          name: g.name,
          path: `{shareToMe:group-g${g.id}}/`,
          pathDisplay: g.name,
          type: "folder",
          isFolder: true,
          isWriteable: false,
          isReadable: true,
        });
      }
    }
    folderList.push(shareToMeGroupUserItem({ id: uid, username: uinfo.username, nickname: uinfo.nickname } as AuthUser, String(rootGid ?? 0)));
    void uGroups;
  }

  return {
    current: {
      name: "分享给我的",
      path: thisPath,
      pathDisplay: "分享给我的",
      type: "folder",
      isFolder: true,
      isWriteable: false,
      isReadable: true,
    },
    folderList,
    fileList: [],
    groupList,
    pageInfo: { totalNum: folderList.length + groupList.length, pageNum: 500, page: 1, pageTotal: 1 },
    thisPath,
    targetSpace: { sizeMax: 0, sizeUse: 0 },
    groupShow: {
      groupRootShow: true,
      userGroupShow: true,
      userGroup: true,
      userGroupRoot: true,
      childGroup: seenGroups.size > 0,
      childUser: folderList.length > 0,
      childUserOuter: false,
      childContent: false,
    },
    shareUserIds,
  };
}

/** "分享给我的" 按用户列出（{shareToMe:user-U}/ 与 {shareToMe:group-uU-P}/）。 */
export async function listShareToMeByUser(
  env: Env,
  user: AuthUser,
  shareUserID: number,
  thisPath: string
): Promise<Record<string, unknown>> {
  const groupTree = await getUserGroupTree(env.DB, user.id);
  const shares = (await listShareToMeForUser(env.DB, user.id, groupTree)).filter((s) => s.userID === shareUserID);
  const owner = (await getUserById(env.DB, shareUserID)) as ShareItemUser | null;
  const ownerInfo = owner ? { id: owner.id, username: owner.username, nickname: owner.nickname || owner.username } : null;

  const folderList: Record<string, unknown>[] = [];
  const fileList: Record<string, unknown>[] = [];
  for (const share of shares) {
    if (!ownerInfo) continue;
    const item = await shareToMeItemMake(env, share, ownerInfo);
    if (!item) continue;
    (item.isFolder ? folderList : fileList).push(item);
  }

  return {
    current: {
      name: ownerInfo ? ownerInfo.nickname : "分享者",
      path: thisPath,
      pathDisplay: ownerInfo ? "分享者(" + ownerInfo.nickname + ")" : "分享者",
      type: "folder",
      isFolder: true,
      isWriteable: false,
      isReadable: true,
      icon: "user",
      iconClassName: "avatar",
      currentFieldAdd: ownerInfo ? { name: ownerInfo.nickname, path: thisPath, type: "folder" } : undefined,
    },
    folderList,
    fileList,
    groupList: [],
    pageInfo: { totalNum: folderList.length + fileList.length, pageNum: 500, page: 1, pageTotal: 1 },
    thisPath,
    targetSpace: { sizeMax: 0, sizeUse: 0 },
  };
}

/** "分享给我的" 按部门列出（{shareToMe:group-gX}/）：该部门下有分享的成员 + 部门分享内容。 */
export async function listShareToMeByGroup(
  env: Env,
  user: AuthUser,
  groupID: number,
  thisPath: string
): Promise<Record<string, unknown>> {
  const group = (await env.DB.prepare("SELECT id, name FROM groups WHERE id = ?").bind(groupID).first()) as
    | { id: number; name: string }
    | null;
  const groupTree = await getUserGroupTree(env.DB, user.id);
  const shares = (await listShareToMeForUser(env.DB, user.id, groupTree)).filter((s) => s.userID !== user.id);

  const memberShareUsers = new Set<number>();
  for (const share of shares) {
    const uGroups = await getUserGroupIds(env.DB, share.userID);
    if (uGroups.includes(groupID) || (await getUserRootGroup(env.DB, share.userID)) === groupID) {
      memberShareUsers.add(share.userID);
    }
  }

  const folderList: Record<string, unknown>[] = [];
  const fileList: Record<string, unknown>[] = [];
  for (const uid of memberShareUsers) {
    const u = (await getUserById(env.DB, uid)) as ShareItemUser | null;
    if (!u) continue;
    folderList.push(
      shareToMeGroupUserItem({ id: u.id, username: u.username, nickname: u.nickname || u.username } as AuthUser, String(groupID))
    );
  }
  for (const share of shares) {
    if (!memberShareUsers.has(share.userID)) continue;
    const u = (await getUserById(env.DB, share.userID)) as ShareItemUser | null;
    if (!u) continue;
    const item = await shareToMeItemMake(env, share, { id: u.id, username: u.username, nickname: u.nickname || u.username }, group ? { name: group.name } : undefined);
    if (!item) continue;
    (item.isFolder ? folderList : fileList).push(item);
  }

  return {
    current: {
      name: group ? group.name : "部门",
      path: thisPath,
      pathDisplay: group ? group.name : "部门",
      type: "folder",
      isFolder: true,
      isWriteable: false,
      isReadable: true,
    },
    folderList,
    fileList,
    groupList: [],
    pageInfo: { totalNum: folderList.length + fileList.length, pageNum: 500, page: 1, pageTotal: 1 },
    thisPath,
    targetSpace: { sizeMax: 0, sizeUse: 0 },
    groupShow: {
      groupRootShow: true,
      userGroupShow: true,
      userGroup: true,
      userGroupRoot: false,
      childGroup: false,
      childUser: folderList.length > 0,
      childUserOuter: false,
      childContent: fileList.length > 0,
    },
  };
}

/** "分享给我的" 统一入口：解析 {shareToMe} / {shareToMe:user-U} / {shareToMe:group-gX} / {shareToMe:group-uU-P}。 */
export async function listShareToMeVirtual(
  env: Env,
  user: AuthUser,
  thisPath: string
): Promise<Record<string, unknown>> {
  const p = thisPath.replace(/\/+/g, "/");
  const gMatch = p.match(/^\{shareToMe:group-g(\d+)\}/);
  if (gMatch) {
    return listShareToMeByGroup(env, user, parseInt(gMatch[1], 10), thisPath);
  }
  const uMatch = p.match(/^\{shareToMe:(?:group-u|user-)(\d+)(?:-\d+)?\}/);
  if (uMatch) {
    return listShareToMeByUser(env, user, parseInt(uMatch[1], 10), thisPath);
  }
  return listShareToMeRoot(env, user, thisPath);
}

/** 解析 JSON 数组参数（前端 shareArr 等）。 */
function parseJsonArray(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 读取 "分享给我" 隐藏列表（user_option type=shareToMe, key=hideList）。 */
async function getUserShareHide(db: D1Database, userId: number): Promise<Record<string, string>> {
  const raw = await getUserOption(db, userId, "hideList", "shareToMe");
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as Record<string, string>) : {};
  } catch {
    return {};
  }
}

type ShareListItem = Record<string, unknown>;

/** 001 explorer/userShare::shareToMeListMake - 平铺列出与我协作的内容。 */
export async function shareToMeListMake(
  env: Env,
  user: AuthUser,
  type: string
): Promise<Record<string, unknown>> {
  const groupTree = await getUserGroupTree(env.DB, user.id);
  const shares = await listShareToMeForUser(env.DB, user.id, groupTree);
  const hide = await getUserShareHide(env.DB, user.id);
  const folderList: ShareListItem[] = [];
  const fileList: ShareListItem[] = [];

  for (const share of shares) {
    const opts = shareOptions(share);
    const timeout = parseInt(String(opts.shareToTimeout ?? "0"), 10) || 0;
    if (timeout > 0 && timeout < Math.floor(Date.now() / 1000)) continue;

    // 系统分享 (userID=0): 001 getInfoSimpleOuter(0) 返回系统用户;
    let ownerInfo: { id: number; username: string; nickname: string };
    if (share.userID === 0) {
      ownerInfo = { id: 0, username: "system", nickname: "system" };
    } else {
      const owner = (await getUserById(env.DB, share.userID)) as ShareItemUser | null;
      if (!owner) continue;
      ownerInfo = { id: owner.id, username: owner.username, nickname: owner.nickname || owner.username };
    }
    const item = await shareToMeItemMake(env, share, ownerInfo);
    if (!item) continue;

    const shareHide = hide[String(share.shareID)] ? 1 : 0;
    item.shareHide = shareHide;
    if (type === "" && shareHide) continue;
    if (type === "hide" && !shareHide) continue;

    if (share.userID === 0) item.isFromSystem = "1";
    (item.isFolder ? folderList : fileList).push(item);
  }

  const result: Record<string, unknown> = {
    folderList,
    fileList,
    currentFieldAdd: {
      pathDesc: "[" + t("admin.setting.shareToMeList") + "]," + t("explorer.pathDesc.shareToMe"),
    },
  };
  // 001 shareToMeListMake: 数量 > 3 时按 用户/系统/外部分享 分组展示。
  const length = folderList.length + fileList.length;
  if (length > 3) {
    result.groupShow = [
      {
        type: "userData",
        title: t("explorer.toolbar.shareToMe"),
        filter: { shareID: "", isFromSystem: "_null_", isShareOut: "_null_" },
      },
      {
        type: "systemData",
        title: t("explorer.share.shareSystem"),
        desc: t("explorer.share.shareSystemDesc"),
        filter: { isFromSystem: "", isShareOut: "_null_" },
      },
      {
        type: "outerData",
        title: t("explorer.shareOut.titlePath"),
        desc: t("explorer.shareOut.titlePathDesc"),
        filter: { isShareOut: "" },
      },
    ];
  }
  return result;
}

/** 001 explorer/userShareUser::listRoot - 按分享者列出与我协作的用户。 */
export async function listShareToMeUserRoot(
  env: Env,
  user: AuthUser,
  thisPath: string
): Promise<Record<string, unknown>> {
  const groupTree = await getUserGroupTree(env.DB, user.id);
  const shares = await listShareToMeForUser(env.DB, user.id, groupTree);
  const userIds: number[] = [];
  for (const s of shares) if (!userIds.includes(s.userID)) userIds.push(s.userID);

  const folderList: ShareListItem[] = [];
  for (const uid of userIds) {
    const u = (await getUserById(env.DB, uid)) as ShareItemUser | null;
    if (!u) continue;
    folderList.push(shareToMeUserItem({ id: u.id, username: u.username, nickname: u.nickname || u.username } as AuthUser, "0"));
  }

  return {
    current: {
      name: t("explorer.toolbar.shareToMe"),
      path: thisPath,
      pathDisplay: t("explorer.toolbar.shareToMe"),
      type: "folder",
      isFolder: true,
      isWriteable: false,
      isReadable: true,
    },
    folderList,
    fileList: [],
    groupList: [],
    pageInfo: { totalNum: folderList.length, pageNum: 500, page: 1, pageTotal: 1 },
    thisPath,
    targetSpace: { sizeMax: 0, sizeUse: 0 },
    currentFieldAdd: {
      pathDesc: "[" + t("admin.setting.shareToMeUser") + "]," + t("explorer.pathDesc.shareToMeUser"),
    },
  };
}

/** 001 explorer/userShareGroup::get。 */
export async function userShareGroupGet(
  env: Env,
  user: AuthUser,
  id: string
): Promise<Record<string, unknown>> {
  const groupPre = "group-g";
  const userPre = "group-u";
  if (!id || id === "group") {
    const data = await listShareToMeRoot(env, user, "{shareToMe}");
    data.currentFieldAdd = {
      pathDesc: "[" + t("admin.setting.shareToMeGroup") + "]," + t("explorer.pathDesc.shareToMeGroup"),
    };
    return data;
  }
  if (id.startsWith(groupPre)) {
    const gid = parseInt(id.slice(groupPre.length), 10);
    return listShareToMeByGroup(env, user, gid, `{shareToMe:group-g${gid}}/`);
  }
  if (id.startsWith(userPre)) {
    const rest = id.slice(userPre.length);
    const uid = parseInt(rest.split("-")[0], 10);
    return listShareToMeByUser(env, user, uid, `{shareToMe:group-u${rest}}/`);
  }
  return listShareToMeRoot(env, user, "{shareToMe}");
}

/** 001 explorer/userShareUser::get。 */
export async function userShareUserGet(
  env: Env,
  user: AuthUser,
  id: string
): Promise<Record<string, unknown>> {
  if (!id || id === "user") {
    return listShareToMeUserRoot(env, user, "{shareToMe:user}");
  }
  const uid = parseInt(id.startsWith("user-") ? id.slice("user-".length) : id, 10);
  return listShareToMeByUser(env, user, uid, `{shareToMe:user-${uid}}/`);
}

/** 001 explorer/userShare::shareToMe 分发（list / group / user 三种展示方式）。 */
export async function shareToMeDispatch(
  env: Env,
  user: AuthUser,
  type: string
): Promise<Record<string, unknown> | false> {
  type = type || "";
  const allowTree = (await getSetting(env.DB, "shareToMeAllowTree")) ?? "1";
  let showType = (await getUserOption(env.DB, user.id, "shareToMeShowType")) || "list";
  if (allowTree === "0") showType = "list";
  if (showType === "group" || type.startsWith("group")) return userShareGroupGet(env, user, type);
  if (showType === "user" || type.startsWith("user")) return userShareUserGet(env, user, type);
  return shareToMeListMake(env, user, type);
}

// ============ 外链生成 helper（复刻 001 explorer/share::link/linkSafe/linkOut）============

/** 001 explorer/share::link - 通用加密外链（Mcrypt 编码 path）。 */
export async function link(env: Env, appHost: string, path: string, downFilename = ""): Promise<string> {
  const pass = (await getSetting(env.DB, "systemPassword")) || "";
  const hash = mcryptEncode(path, pass);
  const name = path.split("/").filter(Boolean).pop() || "";
  const addParam = downFilename
    ? "&downFilename=" + encodeURIComponent(downFilename)
    : "&name=/" + encodeURIComponent(name);
  return appHost + "index.php?explorer/share/file&hash=" + encodeURIComponent(hash) + addParam;
}

/** 001 explorer/share::linkFile - 固定哈希（浏览器可缓存）的文件外链。 */
export async function linkFile(env: Env, appHost: string, file: string, addParam = ""): Promise<string> {
  const pass = (await getSetting(env.DB, "systemPassword")) || "";
  const hash = mcryptEncode(file, pass);
  return appHost + "index.php?explorer/share/file&hash=" + encodeURIComponent(hash) + (addParam ? "&" + addParam : "");
}

/** 001 explorer/share::linkSafe - 登录用户生成带会话访问令牌的安全外链。 */
export async function linkSafe(
  c: AppContext,
  user: AuthUser | undefined,
  path: string,
  downFilename = ""
): Promise<string> {
  if (!user) return link(c.env, getAppHost(c), path, downFilename);
  const name = path.split("/").filter(Boolean).pop() || "";
  const addParam = downFilename
    ? "&downFilename=" + encodeURIComponent(downFilename)
    : "&name=/" + encodeURIComponent(name);
  const token = getSessionId(c) || "";
  return (
    getAppHost(c) +
    "index.php?explorer/index/fileOut&path=" +
    encodeURIComponent(path) +
    (token ? "&accessToken=" + encodeURIComponent(token) : "") +
    addParam
  );
}

/** 001 explorer/share::linkOut - 生成 fileOut 外链（可选附带 accessToken）。 */
export async function linkOut(
  c: AppContext,
  path: string,
  token = false,
  info?: { name?: string; modifyTime?: string; size?: number }
): Promise<string> {
  const isSharePath = path.startsWith("{shareItemLink:") || path.startsWith("{shareItem:");
  const apiKey = isSharePath ? "explorer/share/fileOut" : "explorer/index/fileOut";
  let etag = md5(path).slice(0, 5);
  let name = c.req?.query?.("name") ? encodeURIComponent(String(c.req.query("name"))) : "";
  if (info) {
    name = encodeURIComponent(info.name || "");
    etag = md5(String(info.modifyTime ?? "") + String(info.size ?? "")).slice(0, 5);
  }
  let url =
    getAppHost(c) +
    "index.php?" +
    apiKey +
    "&path=" +
    encodeURIComponent(path) +
    "&et=" +
    etag +
    "&name=/" +
    name;
  if (token) url += "&accessToken=" + encodeURIComponent(getSessionId(c) || "");
  return url;
}

/**
 * 分享项文件输出 (下载/预览): 分享者本人或 share_to 命中的接收者可用。
 * 返回 R2 对象与文件名; 不可访问返回 null。
 */
export async function shareItemFileOut(
  env: Env,
  user: AuthUser,
  shareID: number,
  rel: string
): Promise<{ obj: R2ObjectBody; name: string; isFolder: boolean } | null> {
  const share = await getShareById(env.DB, shareID);
  if (!share) return null;
  const isOwner = share.userID === user.id;
  if (!isOwner) {
    const groupTree = await getUserGroupTree(env.DB, user.id);
    const targets = await getShareToList(env.DB, shareID);
    const hit = targets.some(
      (t) =>
        (t.targetType === 1 && t.targetID === user.id) ||
        (t.targetType === 2 && groupTree.includes(t.targetID))
    );
    if (!hit) return null;
  }
  const owner = (await getUserById(env.DB, share.userID)) as { username: string } | null;
  if (!owner) return null;

  const realPath = joinShareRealPath(share.sourcePath, rel);
  const isFolder = realPath.endsWith("/");
  const key = shareStorageKey(owner.username, realPath);
  if (isFolder) return null;
  const obj = await env.FILES.get(key);
  if (!obj) return null;
  const name = realPath.split("/").filter(Boolean).pop() || "file";
  return { obj, name, isFolder };
}

/** 进入分享目录 {shareItem:<id>}/... 的列表数据（仅分享者本人可访问）。 */
export async function listShareItemDir(
  env: Env,
  user: AuthUser,
  shareID: number,
  rel: string,
  thisPath: string
): Promise<Record<string, unknown> | null> {
  const share = await getShareById(env.DB, shareID);
  if (!share) return null;
  const isOwner = share.userID === user.id;
  if (!isOwner) {
    const groupTree = await getUserGroupTree(env.DB, user.id);
    const targets = await getShareToList(env.DB, shareID);
    const hit = targets.some(
      (t) =>
        (t.targetType === 1 && t.targetID === user.id) ||
        (t.targetType === 2 && groupTree.includes(t.targetID))
    );
    if (!hit) return null;
  }
  const owner = (await getUserById(env.DB, share.userID)) as { username: string } | null;
  if (!owner) return null;

  const realDir = joinShareRealPath(share.sourcePath, rel, true);
  const virtualDir = `{shareItem:${shareID}}` + (rel ? "/" + rel.replace(/\/+$/, "") + "/" : "/");
  const displayRoot = share.title || share.sourcePath.split("/").filter(Boolean).pop() || "分享";
  const displayPath = (virtual: string) => virtual.replace(/^\{shareItem:\d+\}/, displayRoot);
  try {
    // 发布临时目录的 realDir 为 {publish:...} 虚拟前缀, 展开为 __publish__ 前缀列出
    const pub = parsePublishPath(realDir);
    const listBase = pub ? "" : owner.username;
    const listDir = pub ? pub.key + "/" : realDir;
    const { folders, files } = await listDirectory(env.FILES, listBase, listDir);
    const folderList = folders
      .map((f) => f.key.split("/").filter(Boolean).pop() || "")
      .filter((name) => name && !name.startsWith("."))
      .map((name) => ({
        name,
        path: virtualDir + name + "/",
        pathDisplay: displayPath(virtualDir + name + "/"),
        type: "folder",
        isFolder: true,
        isWriteable: true,
        isReadable: true,
        ext: "folder",
        size: 0,
        modifyTime: new Date().toISOString(),
        createTime: new Date().toISOString(),
      }));
    const fileList = files
      .filter((f) => {
        const n = f.key.split("/").pop() || "";
        return n !== ".keep" && !n.startsWith(".");
      })
      .map((f) => {
        const name = f.key.split("/").pop() || f.key;
        return {
          name,
          path: virtualDir + name,
          pathDisplay: displayPath(virtualDir + name),
          type: "file",
          isFolder: false,
          isWriteable: true,
          isReadable: true,
          ext: name.includes(".") ? name.split(".").pop()!.toLowerCase() : "",
          size: f.size,
          modifyTime: f.uploaded ? new Date(f.uploaded).toISOString() : new Date().toISOString(),
          createTime: new Date().toISOString(),
        };
      });
    const curRel = rel.replace(/\/+$/, "");
    return {
      current: {
        name: curRel ? curRel.split("/").pop()! : share.title,
        path: virtualDir,
        pathDisplay: displayPath(virtualDir),
        type: "folder",
        isFolder: true,
        isWriteable: true,
        isReadable: true,
      },
      folderList,
      fileList,
      groupList: [],
      pageInfo: { totalNum: folderList.length + fileList.length, pageNum: 500, page: 1, pageTotal: 1 },
      thisPath,
      targetSpace: { sizeMax: 0, sizeUse: 0 },
    };
  } catch {
    return null;
  }
}

// ============ 小工具 ============

function decodeBase64(s: string): string {
  const binary = atob(s);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 按序流式拼接多个 R2 对象的 body 写入目标 key。
 *  R2 put 要求 body 是已知长度的流, 用 FixedLengthStream 包装合并流,
 *  规避 multipart 每 part 最小 5MiB 的限制(前端默认分片仅 2MB)。 */
async function mergeChunks(bucket: R2Bucket, keys: string[], size: number, key: string, metadata: R2PutOptions): Promise<void> {
  const fixed = new FixedLengthStream(size);
  const writePromise = (async () => {
    const writer = fixed.writable.getWriter();
    try {
      for (const k of keys) {
        const obj = await bucket.get(k);
        if (!obj) throw new Error(`missing chunk: ${k}`);
        const reader = obj.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => {});
      throw err;
    }
  })();

  try {
    await bucket.put(key, fixed.readable, metadata);
  } catch (err) {
    await writePromise.catch(() => {});
    throw err;
  }
  await writePromise;
}

async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const o of listed.objects) keys.push(o.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return keys;
}

async function deleteR2Directory(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) await Promise.all(keys.map((k) => bucket.delete(k)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

// ============ 分享内复制/移动（复刻 001 copyCheckShare + pathPast） ============

const SHARE_CLIP_COOKIE = "shareClip";

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "");
}

function b64decode(s: string): string {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/** 读取分享页剪贴板（Cookie，兼容未登录访客）。 */
function getShareClip(c: AppContext): { type: string; list: { path: string }[] } {
  const cookie = c.req.header("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)shareClip=([^;]+)/);
  if (!m) return { type: "", list: [] };
  try {
    const j = JSON.parse(b64decode(m[1]));
    return { type: j.type || "", list: Array.isArray(j.list) ? j.list : [] };
  } catch {
    return { type: "", list: [] };
  }
}

function setShareClip(c: AppContext, type: string, list: { path: string }[]): void {
  const val = b64encode(JSON.stringify({ type, list }));
  c.header("Set-Cookie", `${SHARE_CLIP_COOKIE}=${val}; Path=/; Max-Age=86400; SameSite=Lax`);
}

function clearShareClip(c: AppContext): void {
  c.header("Set-Cookie", `${SHARE_CLIP_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
}

/** 分享内相对路径 + 是否目录 → 完整 R2 key。 */
function shareRelKey(owner: AuthUser, share: ShareRow, rel: string, isDir: boolean): string {
  return shareStorageKey(owner.username, joinShareRealPath(share.sourcePath, rel, isDir));
}

/** 目标目录下是否已存在同名文件或文件夹。 */
async function shareDestConflict(c: AppContext, owner: AuthUser, share: ShareRow, destDirRel: string, name: string): Promise<boolean> {
  const dirClean = destDirRel.replace(/\/+$/, "");
  const rel = (dirClean ? dirClean + "/" : "") + name;
  const fileKey = shareStorageKey(owner.username, joinShareRealPath(share.sourcePath, rel, false));
  if (await c.env.FILES.head(fileKey)) return true;
  const dirKey = shareRelKey(owner, share, rel, true);
  const listed = await c.env.FILES.list({ prefix: dirKey.endsWith("/") ? dirKey : dirKey + "/", limit: 1 });
  return listed.objects.length > 0 || (listed.delimitedPrefixes || []).length > 0;
}

/** 目标目录下自动生成不冲突的名字。 */
async function uniqueShareName(c: AppContext, owner: AuthUser, share: ShareRow, destDirRel: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = name;
  let i = 1;
  while (await shareDestConflict(c, owner, share, destDirRel, n)) {
    n = `${base}_${i}${ext}`;
    i++;
    if (i > 999) break;
  }
  return n;
}

/** 删除分享内条目（文件或整个目录）。 */
async function deleteShareEntry(c: AppContext, owner: AuthUser, share: ShareRow, rel: string): Promise<void> {
  const isDir = rel.endsWith("/");
  const key = shareRelKey(owner, share, rel, isDir);
  if (isDir) await deleteR2Directory(c.env.FILES, key.endsWith("/") ? key : key + "/");
  else await c.env.FILES.delete(key);
}

/** 复制分享内条目（文件或目录），返回目标相对路径（目录带尾斜杠），失败返回 null。 */
async function copyShareEntry(c: AppContext, owner: AuthUser, share: ShareRow, srcRel: string, destDirRel: string, repeat: string): Promise<string | null> {
  const isDir = srcRel.endsWith("/");
  const name = srcRel.replace(/\/+$/, "").split("/").pop() || "";
  if (!name) return null;
  const dirClean = destDirRel.replace(/\/+$/, "");
  let finalName = name;
  if (await shareDestConflict(c, owner, share, destDirRel, name)) {
    if (repeat === "skip") return null;
    if (repeat === "replace") {
      await deleteShareEntry(c, owner, share, (dirClean ? dirClean + "/" : "") + name + (isDir ? "/" : ""));
    } else {
      finalName = await uniqueShareName(c, owner, share, destDirRel, name);
    }
  }
  const destRel = (dirClean ? dirClean + "/" : "") + finalName;
  if (srcRel.replace(/\/+$/, "") === destRel.replace(/\/+$/, "")) return null;
  const srcKey = shareRelKey(owner, share, srcRel, isDir);
  const destKey = shareRelKey(owner, share, destRel, isDir);
  if (isDir) {
    const prefix = srcKey.endsWith("/") ? srcKey : srcKey + "/";
    const dstPrefix = destKey.endsWith("/") ? destKey : destKey + "/";
    let cursor: string | undefined;
    let count = 0;
    do {
      const batch = await c.env.FILES.list({ prefix, cursor });
      for (const o of batch.objects) {
        const sub = o.key.slice(prefix.length);
        const data = await c.env.FILES.get(o.key);
        if (data) {
          await c.env.FILES.put(dstPrefix + sub, data.body, { httpMetadata: o.httpMetadata, customMetadata: o.customMetadata });
          count++;
        }
      }
      cursor = batch.truncated ? batch.cursor : undefined;
    } while (cursor);
    if (count === 0) return null;
    return destRel + "/";
  }
  const obj = await c.env.FILES.get(srcKey);
  if (!obj) return null;
  await c.env.FILES.put(destKey, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
  return destRel;
}

/** 移动分享内条目（先复制再删除源）。 */
async function moveShareEntry(c: AppContext, owner: AuthUser, share: ShareRow, srcRel: string, destDirRel: string, repeat: string): Promise<string | null> {
  const destRel = await copyShareEntry(c, owner, share, srcRel, destDirRel, repeat);
  if (!destRel) return null;
  await deleteShareEntry(c, owner, share, srcRel);
  return destRel;
}

/** 执行粘贴：把 list（分享链接项）复制/移动到 params.path 指定的分享目录。 */
async function runSharePaste(
  c: AppContext,
  init: Extract<InitResult, { ok: true }>,
  params: Record<string, any>,
  copyType: "copy" | "cute",
  list: { path: string }[]
): Promise<Response> {
  const { share, owner } = init;
  const targetRel = parseShareLinkRel(share, typeof params.path === "string" ? params.path : "");
  if (targetRel === null) return c.json({ code: false, data: L.noPermission });
  if (list.length === 0) return c.json({ code: false, data: "剪贴板为空" });

  const repeat = typeof params.fileRepeat === "string" && params.fileRepeat ? params.fileRepeat : "rename";
  const out: string[] = [];
  for (const it of list) {
    const srcRel = parseShareLinkRel(share, it.path);
    if (!srcRel) continue;
    const r = copyType === "cute"
      ? await moveShareEntry(c, owner, share, srcRel, targetRel, repeat)
      : await copyShareEntry(c, owner, share, srcRel, targetRel, repeat);
    if (r) out.push(shareLinkRoot(share.shareHash) + r);
  }
  await addAuditLog(c.env.DB, copyType === "cute" ? "shareMove" : "shareCopy", owner.id, share.sourcePath, null, null, `to:${targetRel}`);
  if (out.length === 0) return c.json({ code: false, data: L.error });
  return c.json({ code: 1, data: copyType === "cute" ? "移动成功" : "复制成功", info: out });
}

/** 递归收集分享内文件清单（供前端 zipClient 自行打包，R2 或外部挂载）。 */
async function shareZipCollect(
  c: AppContext,
  owner: AuthUser,
  share: ShareRow,
  source: { type: "folder" | "file"; name: string; realPath: string },
  storage: { source: SourceRef | null; relPath: string },
  rel: string,
  zipName: string,
  out: Record<string, unknown>[]
): Promise<void> {
  const isFolder = rel.endsWith("/") || (rel === "" && source.type === "folder");
  const now = new Date().toISOString();
  if (!isFolder) {
    const fullRel = shareJoinRel(storage.relPath, rel);
    const head = await shareHeadOf(c.env, owner, storage.source, fullRel);
    out.push({
      path: zipName,
      folder: false,
      filePath: shareLinkRoot(share.shareHash) + rel,
      size: head?.size ?? 0,
      modifyTime: head?.lastModified ? new Date(head.lastModified).toISOString() : now,
    });
    return;
  }
  out.push({ path: zipName, folder: true, modifyTime: now });
  const fullDir = shareJoinRel(storage.relPath, rel, true);
  const list = await shareListDir(c.env, owner, storage.source, fullDir);
  if (!list) return;
  const baseRel = rel.replace(/\/+$/, "");
  for (const f of list.folders) {
    const n = f.name;
    if (!n || n.startsWith(".")) continue;
    const zipBase = zipName.replace(/\/+$/, "");
    await shareZipCollect(c, owner, share, source, storage, (baseRel ? baseRel + "/" : "") + n + "/", zipBase + "/" + n + "/", out);
  }
  for (const f of list.files) {
    const n = f.name;
    if (n === ".keep" || n.startsWith(".")) continue;
    const zipBase = zipName.replace(/\/+$/, "");
    out.push({
      path: zipBase + "/" + n,
      folder: false,
      filePath: shareLinkRoot(share.shareHash) + (baseRel ? baseRel + "/" : "") + n,
      size: f.size,
      modifyTime: f.uploaded ? f.uploaded : now,
    });
  }
}

export { shareApi };
