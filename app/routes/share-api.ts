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
import { authOptional, authRequired } from "../lib/auth";
import type { AuthUser } from "../lib/auth";
import { getUserById, addAuditLog, getSetting } from "../lib/db";
import { getUserFileKey, listDirectory, getFileMimeType } from "../lib/r2";
import { md5, mcryptDecode } from "../lib/mcrypt";
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
  shareLinkRoot,
  getUnlockedShares,
  setSharePassUnlocked,
} from "../lib/share";

type Vars = { currentUser?: AuthUser };
type AppContext = any;

// ============ 分享相关 i18n（与 001 config/i18n/zh-CN 保持一致） ============

const L = {
  notExist: "分享不存在！",
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
function parseShareLinkRel(share: ShareRow, path: string): string | null {
  const prefix = `{shareItemLink:${share.shareHash}}`;
  if (typeof path !== "string" || !path.startsWith(prefix)) return null;
  return path.slice(prefix.length).replace(/^\/+/, "");
}

/** 分享根真实路径 + 相对子路径 → 真实路径（目录保留尾斜杠）。 */
function joinShareRealPath(sourcePath: string, rel: string, isDir = false): string {
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

/** 文件类型（与主 explorer 的 kodFileType 一致）。 */
function kodFileType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const doc = "txt,md,pdf,ofd,doc,docx,xls,xlsx,ppt,pptx,xps,pps,ppsx,ods,odt,odp,docm,dot,dotm,xlsb,xlsm,mht,djvu,wps,dpt,csv,et,ett,pages,numbers,key,dotx,vsd,vsdx,mpp".split(",");
  const image = "jpg,jpeg,png,gif,bmp,ico,svg,webp,tif,tiff,cdr,svgz,xbm,eps,pjepg,heic,raw,psd,ai".split(",");
  const music = "mp3,wav,wma,m4a,ogg,omf,amr,aa3,flac,aac,cda,aif,aiff,mid,ra,ape".split(",");
  const movie = "mp4,flv,rm,rmvb,avi,mkv,mov,f4v,mpeg,mpg,vob,wmv,ogv,webm,3gp,mts,m2ts,m4v,mpe,3g2,asf,dat,asx,wvx,mpa".split(",");
  const zip = "zip,gz,rar,iso,tar,7z,ar,bz,bz2,xz,arj".split(",");
  if (image.includes(ext)) return "image";
  if (doc.includes(ext)) return "doc";
  if (music.includes(ext)) return "music";
  if (movie.includes(ext)) return "movie";
  if (zip.includes(ext)) return "zip";
  return "others";
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
  const path = o.isFolder ? root + rel + "/" : root + rel;
  const pathDisplay = sourceName + (rel ? "/" + rel : "") + (o.isFolder ? "/" : "");
  return {
    name: o.name,
    path,
    pathDisplay,
    type: o.isFolder ? "folder" : kodFileType(o.name),
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
  source: { type: "folder" | "file"; name: string; realPath: string }
): Promise<Record<string, unknown>> {
  const canEdit = await shareCanEdit(env, share);
  return {
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
      size: 0,
      modifyTime: share.modifyTime,
      canEdit,
    }),
    shareUser: shareUserInfo(owner),
  };
}

/** 管理场景分享信息（share 行 + 源信息）。 */
async function buildManageShareInfo(env: Env, share: ShareRow, source: { type: "folder" | "file"; name: string; realPath: string } | null): Promise<Record<string, unknown>> {
  return {
    shareID: share.shareID,
    title: share.title,
    shareHash: share.shareHash,
    userID: share.userID,
    sourceID: share.sourceID,
    sourcePath: share.sourcePath,
    url: share.url,
    isLink: share.isLink,
    isShareTo: share.isShareTo,
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
      : null,
  };
}

/** 错误响应（对齐 001 show_json：{code, data, info}）。 */
function shareError(c: AppContext, code: number | false, msg: string, info?: any) {
  return { ok: false as const, response: c.json({ code, data: msg, info }) };
}

type InitResult =
  | { ok: true; share: ShareRow; owner: AuthUser; source: { type: "folder" | "file"; name: string; realPath: string } }
  | { ok: false; response: Response };

/**
 * 分享信息初始化（001 initShare）：
 * 存在性 → 分享者有效性 → 源存在性 → 过期 → 下载次数 → 需登录 → 密码。
 */
async function initShare(c: AppContext, params: Record<string, any>): Promise<InitResult> {
  const hash = parseShareID(params);
  const share = await getShareByHash(c.env.DB, hash);
  if (!share || share.isLink !== 1) return shareError(c, 30100, L.notExist);

  const owner = await getUserById(c.env.DB, share.userID);
  if (!owner || (owner.status ?? 1) !== 1) return shareError(c, 30100, L.notExist);

  const source = await resolveShareSource(c.env, owner, share);
  if (!source) return shareError(c, 30100, L.notExist);

  const opts = shareOptions(share);
  const now = Math.floor(Date.now() / 1000);
  if (share.timeTo && share.timeTo > 0 && share.timeTo < now) {
    const info = await buildSharePageData(c.env, share, owner, source);
    return shareError(c, 30101, L.expiredTips, info);
  }
  if (opts.downloadNumber && Number(opts.downloadNumber) <= share.numDownload) {
    const info = await buildSharePageData(c.env, share, owner, source);
    return shareError(c, 30102, L.downExceedTips, info);
  }

  const user = c.get("currentUser") as AuthUser | undefined;
  if (opts.onlyLogin === "1" && !user) {
    const info = await buildSharePageData(c.env, share, owner, source);
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
        const info = await buildSharePageData(c.env, share, owner, source);
        return shareError(c, 30104, L.needPwd, info);
      }
    }
  }

  return { ok: true, share, owner, source };
}

/** 权限检测（001 authCheck）：notView/notDownload/上传/编辑。返回错误消息或 null。 */
function authCheck(c: AppContext, share: ShareRow, act: string, params: Record<string, any>): string | null {
  const opts = shareOptions(share);
  const canUpload = opts.canUpload === "1";
  const canEdit = opts.canEditSave === "1";
  const canView = opts.notView !== "1";
  const canDownload = opts.notDownload !== "1";

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
  const { share, owner } = init;
  const rel = parseShareLinkRel(share, typeof params.path === "string" ? params.path : "");
  if (rel === null) return c.json({ code: false, data: L.noPermission });

  const isDir = rel === "" ? init.source.type === "folder" : false;
  if (isDir) return c.json({ code: false, data: L.pathNotExists });

  const errMsg = authCheck(c, share, disposition === "attachment" ? "filedownload" : "fileout", params);
  if (errMsg) return await tipsHtml(c, c.json({ code: false, data: errMsg }));

  const realPath = joinShareRealPath(share.sourcePath, rel);
  const key = getUserFileKey(owner.username, realPath);
  const obj = await c.env.FILES.get(key).catch(() => null);
  if (!obj) return await tipsHtml(c, c.json({ code: false, data: L.pathNotExists }));

  const isDownload = disposition === "attachment" || params.download === "1";
  if (isDownload) await incNumDownload(c.env.DB, share.shareID);

  const fileName = realPath.split("/").filter(Boolean).pop() || "file";
  let name = typeof params.name === "string" && params.name ? params.name.replace(/^\/+/, "") : fileName;
  if (!name) name = fileName;

  const headers = new Headers();
  headers.set("Content-Type", getFileMimeType(name));
  headers.set("Content-Disposition", `${disposition}; filename="${encodeURIComponent(name)}"`);
  if (disposition === "inline") headers.set("Cache-Control", "public, max-age=3600");
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

/** 分享者空间下真实路径是否可作为分享源。 */
async function resolveShareSourceForUser(env: Env, username: string, path: string): Promise<{ type: "folder" | "file"; name: string; realPath: string } | null> {
  const p = normShareSourcePath(path);
  const isFolder = p.endsWith("/");
  const name = p.split("/").filter(Boolean).pop() || p;
  if (isFolder) {
    const key = getUserFileKey(username, p);
    const listed = await env.FILES.list({ prefix: key, limit: 1 });
    if (listed.objects.length > 0 || (listed.delimitedPrefixes || []).length > 0) return { type: "folder", name, realPath: p };
    return null;
  }
  const obj = await env.FILES.head(getUserFileKey(username, p));
  if (!obj) return null;
  return { type: "file", name, realPath: p };
}

// ============ 路由 ============

const shareApi = new Hono<{ Bindings: Env; Variables: Vars }>();
shareApi.use("/share/*", authOptional);
shareApi.use("/userShare/*", authRequired);

// ---------- 外链落地页（公开） ----------

// get - 分享信息（落地页初始化）
shareApi.all("/share/get", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  await incNumView(c.env.DB, init.share.shareID);
  return c.json({ code: 1, data: await buildSharePageData(c.env, init.share, init.owner, init.source) });
});

// pathList - 目录浏览
shareApi.all("/share/pathList", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const { share, owner, source } = init;

  const rawPath = typeof params.path === "string" ? params.path : "";
  const rel = parseShareLinkRel(share, rawPath);
  if (rel === null) return c.json({ code: false, data: L.noPermission });

  const realDir = joinShareRealPath(share.sourcePath, rel, true);
  const virtualDir = shareLinkRoot(share.shareHash) + (rel ? rel.replace(/\/+$/, "") + "/" : "");
  const canEdit = await shareCanEdit(c.env, share);

  try {
    const { folders, files } = await listDirectory(c.env.FILES, owner.username, realDir);

    const folderList = folders
      .map((f) => f.key.split("/").filter(Boolean).pop() || "")
      .filter((name) => name && !name.startsWith("."))
      .map((name) =>
        shareItemInfo(share, source.name, {
          name,
          relPath: (rel ? rel.replace(/\/+$/, "") + "/" : "") + name,
          isFolder: true,
          size: 0,
          modifyTime: new Date().toISOString(),
          canEdit,
        })
      );

    const fileList = files
      .filter((f) => {
        const n = f.key.split("/").pop() || "";
        return n !== ".keep" && !n.startsWith(".");
      })
      .map((f) => {
        const name = f.key.split("/").pop() || f.key;
        return shareItemInfo(share, source.name, {
          name,
          relPath: (rel ? rel.replace(/\/+$/, "") + "/" : "") + name,
          isFolder: false,
          size: f.size,
          modifyTime: f.uploaded ? new Date(f.uploaded).toISOString() : new Date().toISOString(),
          canEdit,
        });
      });

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
  const { share, owner, source } = init;

  const items = parseDataArr(params.dataArr);
  if (items.length === 0) return c.json({ code: false, data: L.error });

  const canEdit = await shareCanEdit(c.env, share);
  const result: Record<string, unknown>[] = [];
  for (const item of items) {
    const rel = parseShareLinkRel(share, item.path);
    if (rel === null) continue;
    // 空 rel 表示分享源本身（文件分享的根路径）
    const isFolder = rel.endsWith("/") || (rel === "" && init.source.type === "folder");
    const realPath = joinShareRealPath(share.sourcePath, rel, isFolder);
    const name = rel === "" ? source.name : rel.replace(/\/+$/, "").split("/").pop() || "";
    if (isFolder) {
      const key = getUserFileKey(owner.username, realPath);
      const listed = await c.env.FILES.list({ prefix: key, limit: 1 });
      if (listed.objects.length === 0 && (listed.delimitedPrefixes || []).length === 0) continue;
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
      const key = getUserFileKey(owner.username, realPath);
      const obj = await c.env.FILES.head(key);
      if (!obj) continue;
      const info = shareItemInfo(share, source.name, {
        name,
        relPath: rel,
        isFolder: false,
        size: obj.size,
        modifyTime: obj.uploaded ? new Date(obj.uploaded).toISOString() : new Date().toISOString(),
        canEdit,
      });
      const canDownload = shareOptions(share).notDownload !== "1";
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
shareApi.all("/share/fileOutBy", async (c) => {
  // 文档内相对资源：path 指向分享文档，add 为相对父级路径
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return await tipsHtml(c, init.response);
  const { share, owner } = init;
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

  const realPath = joinShareRealPath(share.sourcePath, realRel);
  const key = getUserFileKey(owner.username, realPath);
  const obj = await c.env.FILES.get(key).catch(() => null);
  if (!obj) return await tipsHtml(c, c.json({ code: false, data: L.pathNotExists }));

  const name = realRel.split("/").filter(Boolean).pop() || "file";
  const headers = new Headers();
  headers.set("Content-Type", getFileMimeType(name));
  headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(name)}"`);
  headers.set("Cache-Control", "public, max-age=3600");
  obj.writeHttpMetadata(headers);
  return new Response(obj.body, { headers });
});

// fileGet - 读取文本内容（编辑器预览）
shareApi.all("/share/fileGet", async (c) => {
  const params = await reqParams(c);
  const init = await initShare(c, params);
  if (!init.ok) return init.response;
  const { share, owner } = init;
  const errMsg = authCheck(c, share, "fileget", params);
  if (errMsg) return c.json({ code: false, data: errMsg });

  const rel = parseShareLinkRel(share, typeof params.path === "string" ? params.path : "");
  if (rel === null) return c.json({ code: false, data: L.pathNotExists });
  // 空 rel 表示分享源本身（文件分享的根路径）
  const realPath = joinShareRealPath(share.sourcePath, rel);
  const key = getUserFileKey(owner.username, realPath);
  const obj = await c.env.FILES.get(key).catch(() => null);
  if (!obj) return c.json({ code: false, data: L.pathNotExists });

  const name = rel.split("/").filter(Boolean).pop() || (rel === "" ? share.title : "");
  const content = await obj.text().catch(() => "");
  return c.json({
    code: 1,
    data: {
      name,
      path: shareLinkRoot(share.shareHash) + rel,
      pathDisplay: share.title + "/" + rel,
      ext: name.includes(".") ? name.split(".").pop()!.toLowerCase() : "",
      size: obj.size,
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
  const key = getUserFileKey(owner.username, realPath);
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
  await c.env.FILES.put(getUserFileKey(owner.username, realPath), content);
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
  const oldKey = getUserFileKey(owner.username, realPath);
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
    const key = getUserFileKey(owner.username, realPath);
    if (isFolder) {
      await deleteR2Directory(c.env.FILES, key.endsWith("/") ? key : key + "/");
    } else {
      await c.env.FILES.delete(key);
    }
  }
  return c.json({ code: 1, data: "ok" });
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

// zipDownload / unzipList / fileDownloadRemove - 003 暂不支持压缩
shareApi.all("/share/zipDownload", (c) => c.json({ code: false, data: "暂不支持" }));
shareApi.all("/share/unzipList", (c) => c.json({ code: false, data: "暂不支持" }));
shareApi.all("/share/unzipListHash", (c) => c.json({ code: false, data: "暂不支持" }));
shareApi.all("/share/fileDownloadRemove", (c) => c.json({ code: true, data: "ok" }));

// ---------- 分享管理（需登录） ----------

// get - 通过路径获取分享；没有则返回 false
shareApi.all("/userShare/get", async (c) => {
  const user = c.get("currentUser")!;
  const params = await reqParams(c);
  const path = typeof params.path === "string" ? params.path : "";
  if (!path) return c.json({ code: true, data: false });

  const realPath = toRealPath(path);
  const share = await getShareBySourcePath(c.env.DB, user.id, realPath);
  if (!share) return c.json({ code: true, data: false });

  const source = await resolveShareSourceForUser(c.env, user.username, share.sourcePath);
  return c.json({ code: true, data: await buildManageShareInfo(c.env, share, source) });
});

// add - 新增分享
shareApi.all("/userShare/add", async (c) => {
  const user = c.get("currentUser")!;
  const params = await reqParams(c);
  const path = typeof params.path === "string" ? params.path : "";
  if (!path) return c.json({ code: false, data: "参数错误" });
  const isLink = String(params.isLink) === "1" ? 1 : 0;

  const realPath = toRealPath(path);
  const source = await resolveShareSourceForUser(c.env, user.username, realPath);
  if (!source) return c.json({ code: false, data: L.pathNotExists });

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

  const id = await addShare(c.env.DB, {
    userID: user.id,
    title,
    shareHash,
    sourcePath: realPath,
    isLink,
    isShareTo: 0,
    password: typeof params.password === "string" ? params.password : "",
    timeTo,
    options,
  });
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

  const updated = await getShareById(c.env.DB, shareID);
  const source = updated ? await resolveShareSourceForUser(c.env, user.username, updated.sourcePath) : null;
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
  return c.json({ code: true, data: L.success });
});

// shareDisplay / shareExit - "分享给我的" 场景（003 无内部协作，直接返回成功）
shareApi.all("/userShare/shareDisplay", async (c) => {
  return c.json({ code: true, data: L.success });
});
shareApi.all("/userShare/shareExit", async (c) => {
  return c.json({ code: true, data: L.success });
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
    const base: Record<string, unknown> = {
      name: source.name,
      path: `{shareItem:${share.shareID}}` + (isFolder ? "/" : ""),
      pathDisplay: `{shareItem:${share.shareID}}` + (isFolder ? "/" : ""),
      type: isFolder ? "folder" : kodFileType(source.name),
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

/** 进入分享目录 {shareItem:<id>}/... 的列表数据（仅分享者本人可访问）。 */
export async function listShareItemDir(
  env: Env,
  user: AuthUser,
  shareID: number,
  rel: string,
  thisPath: string
): Promise<Record<string, unknown> | null> {
  const share = await getShareById(env.DB, shareID);
  if (!share || share.userID !== user.id) return null;
  const owner = await getUserById(env.DB, share.userID);
  if (!owner) return null;

  const realDir = joinShareRealPath(share.sourcePath, rel, true);
  const virtualDir = `{shareItem:${shareID}}` + (rel ? "/" + rel.replace(/\/+$/, "") + "/" : "/");
  try {
    const { folders, files } = await listDirectory(env.FILES, owner.username, realDir);
    const folderList = folders
      .map((f) => f.key.split("/").filter(Boolean).pop() || "")
      .filter((name) => name && !name.startsWith("."))
      .map((name) => ({
        name,
        path: virtualDir + name + "/",
        pathDisplay: virtualDir + name + "/",
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
          pathDisplay: virtualDir + name,
          type: kodFileType(name),
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
        pathDisplay: virtualDir,
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

export { shareApi };
