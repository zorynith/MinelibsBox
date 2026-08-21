/**
 * Explorer API - file operations for 003 SPA
 *
 * Frontend contract (decoded from static/app/dist):
 *  - All data requests go through `requestSend` -> `urlMake` -> `ajax`.
 *  - URL is `{API_HOST}?MOD/ST/ACT` (route only, no business params in query).
 *  - Method is POST with `application/x-www-form-urlencoded` body (jQuery default).
 *  - Scalar params are strings; object/array params (e.g. `dataArr`) are
 *    JSON-encoded strings by `requestFilterParam`.
 *  - Both the main list and the sidebar tree use `explorer/list/path`.
 *  - `fileDownload` / `fileOut` are GET links built via `urlMake` (params in query).
 */
import { Hono } from "hono";
import { authRequired } from "../lib/auth";
import { getUserFileKey, listDirectory, listAllFiles, deleteDirectory, getFileMimeType } from "../lib/r2";
import { addAuditLog, getFavorites, addFavorite, removeFavoriteByName, renameFavorite, favMoveTop, favMoveBottom, favResetSort, getUserOption, setUserOption, getUserTags, addTag, editTag, removeTag, tagMoveTop, tagMoveBottom, tagResetSort, getTagSources, tagAddSources, tagRemoveSources } from "../lib/db";
import { getStaticHost } from "../lib/user-system";
import { parseShareItemPath, listUserShareVirtual, listShareItemDir } from "./share-api";

type Vars = { currentUser: import("../lib/auth").AuthUser };
const explorerApi = new Hono<{ Bindings: Env; Variables: Vars }>();

// All explorer routes require auth
explorerApi.use("*", authRequired);

// ============ helpers ============

type AppContext = any;

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

/** Decode a base64 string into a UTF-8 string (Worker-safe, no Buffer). */
function decodeBase64(s: string): string {
  const binary = atob(s);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Normalize a virtual/real path to a trailing-slash directory path. */
function normDirPath(p: string): string {
  let s = (p || "/").replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!s) s = "/";
  if (s !== "/" && !s.endsWith("/")) s += "/";
  return s;
}

type ExplorerPath = {
  kind: "root" | "recycle" | "fav" | "fileType" | "fileTag" | "recent" | "block" | "virtual" | "real";
  realPath: string;
  typeId?: string;
  blockId?: string;
  tagId?: string;
  thisPath: string;
};

function parseExplorerPath(raw: string): ExplorerPath {
  let p = (raw || "").replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!p) p = "/";
  const blockMatch = p.match(/^\{block:(\w+)\}\/?$/);
  if (blockMatch) {
    return { kind: "block", realPath: "/", blockId: blockMatch[1], thisPath: p };
  }
  // {source:home} / {source:ID} map to the user's own space root;
  // a trailing subpath (e.g. {source:home}/桌面/) is kept as a real path.
  const srcMatch = p.match(/^\{source:(home|\d+)\}(.*)$/);
  if (srcMatch) {
    const rest = srcMatch[2].replace(/^\/+/, "");
    const realPath = rest ? "/" + rest : "/";
    return { kind: "root", realPath, thisPath: p };
  }
  if (p.startsWith("{userRecycle}") || p.startsWith("{io:systemRecycle}")) {
    return { kind: "recycle", realPath: "/", thisPath: p };
  }
  if (p.startsWith("{userFav}")) {
    return { kind: "fav", realPath: "/", thisPath: p };
  }
  const ft = p.match(/^\{userFileType:(\w+)\}/);
  if (ft) {
    return { kind: "fileType", realPath: "/", typeId: ft[1], thisPath: p };
  }
  const tag = p.match(/^\{userFileTag:([^/}]+)\}/);
  if (tag) {
    return { kind: "fileTag", realPath: "/", tagId: tag[1], thisPath: p };
  }
  if (p.startsWith("{userRencent}")) {
    return { kind: "recent", realPath: "/", thisPath: p };
  }
  if (p.startsWith("{")) {
    return { kind: "virtual", realPath: "/", thisPath: p };
  }
  if (!p.startsWith("/")) p = "/" + p;
  return { kind: "real", realPath: p, thisPath: p };
}

/** Convert a frontend path (which may be virtual, e.g. {source:home}/桌面/) to its real relative path (/桌面/). */
function toRealPath(p: string): string {
  return parseExplorerPath(p).realPath;
}

/** MbesBox standard file category id (matches options.documentType). */
const DESKTOP_FOLDER = "桌面";

/** Ensure the user's desktop folder placeholder exists under their root. */
async function ensureDesktopFolder(env: Env, username: string): Promise<void> {
  const key = getUserFileKey(username, "/" + DESKTOP_FOLDER + "/.keep");
  try {
    const existing = await env.FILES.head(key);
    if (!existing) await env.FILES.put(key, "");
  } catch {
    // ignore transient storage errors; the folder will be created on first write
  }
}

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

function folderItem(name: string, dirPath: string, targetID?: string | number): Record<string, unknown> {
  const path = dirPath + name + "/";
  return {
    name,
    path,
    pathDisplay: displayPath(path),
    type: "folder",
    isFolder: true,
    isParent: true,
    hasChildren: true,
    isWriteable: true,
    isReadable: true,
    isTruePath: true,
    targetType: "user",
    targetID,
    ext: "",
    size: 0,
    modifyTime: new Date().toISOString(),
    createTime: new Date().toISOString(),
  };
}

function fileItem(obj: R2Object, dirPath: string, targetID?: string | number): Record<string, unknown> {
  const name = obj.key.split("/").pop() || obj.key;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const path = dirPath + name;
  return {
    name,
    path,
    pathDisplay: displayPath(path),
    type: kodFileType(name),
    isFolder: false,
    isWriteable: true,
    isReadable: true,
    isTruePath: true,
    targetType: "user",
    targetID,
    ext,
    size: obj.size,
    modifyTime: obj.uploaded ? new Date(obj.uploaded).toISOString() : new Date().toISOString(),
    createTime: new Date().toISOString(),
  };
}

function emptyListData(thisPath: string, name?: string, targetID?: string | number): Record<string, unknown> {
  return {
    current: {
      name: name || "",
      path: thisPath,
      pathDisplay: displayPath(thisPath),
      type: "folder",
      isFolder: true,
      isWriteable: true,
      isReadable: true,
      isTruePath: true,
      targetType: "user",
      targetID,
    },
    folderList: [],
    fileList: [],
    groupList: [],
    pageInfo: { totalNum: 0, pageNum: 500, page: 1, pageTotal: 1 },
    thisPath,
    targetSpace: { sizeMax: 0, sizeUse: 0 },
  };
}

/** Parse `dataArr` param (JSON string or array) into {path,name,type}[] */
function parseDataArr(dataArr: any): { path: string; name?: string; type?: string }[] {
  let arr = dataArr;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: { path: string; name?: string; type?: string }[] = [];
  for (const it of arr) {
    if (typeof it === "string" && it) out.push({ path: it });
    else if (it && typeof it.path === "string" && it.path) out.push({ path: it.path, name: it.name, type: it.type });
  }
  return out;
}

function rootName(user: Vars["currentUser"]): string {
  return "个人空间";
}

/** 将虚拟路径中的 {source:home} 前缀替换为根目录显示名，用于面包屑 pathDisplay。 */
function displayPath(virtualPath: string): string {
  if (virtualPath.startsWith("{source:home}")) {
    return virtualPath.replace("{source:home}", "个人空间");
  }
  return virtualPath;
}

// ============ 左侧栏 (listBlock: 位置/工具/文件类型/个人标签/挂载) ============

const FILE_TYPE_BLOCKS: { key: string; name: string; ext: string }[] = [
  { key: "doc", name: "文档", ext: "txt,md,pdf,ofd,doc,docx,xls,xlsx,ppt,pptx,xps,pps,ppsx,ods,odt,odp,docm,dot,dotm,xlsb,xlsm,mht,djvu,wps,dpt,csv,et,ett,pages,numbers,key,dotx,vsd,vsdx,mpp" },
  { key: "image", name: "图片", ext: "jpg,jpeg,png,gif,bmp,ico,svg,webp,tif,tiff,cdr,svgz,xbm,eps,pjepg,heic,raw,psd,ai" },
  { key: "music", name: "音乐", ext: "mp3,wav,wma,m4a,ogg,omf,amr,aa3,flac,aac,cda,aif,aiff,mid,ra,ape" },
  { key: "movie", name: "视频", ext: "mp4,flv,rm,rmvb,avi,mkv,mov,f4v,mpeg,mpg,vob,wmv,ogv,webm,3gp,mts,m2ts,m4v,mpe,3g2,asf,dat,asx,wvx,mpa" },
  { key: "zip", name: "压缩包", ext: "zip,gz,rar,iso,tar,7z,ar,bz,bz2,xz,arj" },
  { key: "others", name: "其他", ext: "" },
];

function blockName(id: string): string {
  const map: Record<string, string> = {
    root: "全部",
    files: "位置",
    tools: "工具",
    fileType: "文件类型",
    fileTag: "个人标签",
    driver: "挂载",
  };
  return map[id] || "全部";
}

function blockItems(): Record<string, any> {
  return {
    files: { name: "位置", open: true },
    tools: { name: "工具", open: true },
    fileType: { name: "文件类型", open: false, children: true, pathDesc: "按文件类型浏览" },
    fileTag: { name: "个人标签", open: false, children: true, pathDesc: "按标签浏览" },
    driver: { name: "挂载 (admin)", open: false, pathDesc: "存储挂载" },
  };
}

async function blockRoot(c: AppContext, user: Vars["currentUser"], isAdmin: boolean): Promise<any[]> {
  const items = blockItems();
  if (!isAdmin) delete items.driver;
  const result: any[] = [];
  for (const [type, item] of Object.entries(items)) {
    const block: any = { ...item, path: `{block:${type}}/`, type: "folder", isParent: true };
    if (block.open || block.children) {
      // 嵌套为 {folderList:[...]} 结构，前端 dataFilterTree 会递归生成
      // _itemDataBefore/isParent/pathFather，既支持展开也支持直点导航。
      block.children = { folderList: await blockChildren(c, user, type, isAdmin), fileList: [], groupList: [] };
    }
    result.push(block);
  }
  return result;
}

async function blockFiles(c: AppContext, user: Vars["currentUser"]): Promise<any[]> {
  const list: any[] = [
    { name: "收藏夹", path: "{userFav}/", pathDesc: "我的收藏", type: "folder", isParent: true },
    { name: "个人空间", path: "{source:home}/", sourceRoot: "userSelf", open: true, pathDesc: "个人空间", type: "folder", isParent: true },
    { name: "我的部门", path: "{groupRootSelf}/", pathDesc: "所在部门", type: "folder", isParent: true },
    { name: "分享给我的", path: "{shareToMe}/", pathDesc: "他人分享", type: "folder", isParent: true },
  ];
  // 子目录通过 {source:home} 等路径异步加载，避免嵌套 children 缺失 _itemDataBefore。
  return list;
}

function blockTools(): any[] {
  return [
    { name: "最近文档", path: "{userRencent}/", pathDesc: "最近使用", type: "folder", isParent: true },
    { name: "我的相册", path: "{userFileType:photo}/", pathDesc: "图片视频", type: "folder", isParent: true },
    { name: "我分享的", path: "{userShare}/", pathDesc: "分享给他人", type: "folder", isParent: true },
    { name: "外链分享", path: "{userShareLink}/", pathDesc: "外链文件", type: "folder", isParent: true },
    { name: "回收站", path: "{userRecycle}/", pathDesc: "已删除文件", type: "folder", isParent: true },
  ];
}

function blockFileType(): any[] {
  return FILE_TYPE_BLOCKS.map((t) => ({
    name: t.name,
    path: `{userFileType:${t.key}}/`,
    ext: t.ext,
    extType: t.key,
    type: "folder",
  }));
}

async function blockFileTag(c: AppContext, user: Vars["currentUser"]): Promise<any[]> {
  const tags = await getUserTags(c.env.DB, user.id);
  const list: any[] = [];
  for (const t of tags as any[]) {
    const sources = await getTagSources(c.env.DB, user.id, t.id);
    list.push({
      name: t.name,
      path: `{userFileTag:${t.id}}/`,
      icon: `tag-label label ${t.style || "label-grey-normal"}`,
      tagInfo: t,
      tagHas: sources.length,
      pathDesc: "按个人标签筛选",
      type: "folder",
    });
  }
  return list;
}

function blockDriver(): any[] {
  return [];
}

async function blockChildren(c: AppContext, user: Vars["currentUser"], type: string, isAdmin: boolean): Promise<any[]> {
  switch (type) {
    case "root": return blockRoot(c, user, isAdmin);
    case "files": return blockFiles(c, user);
    case "tools": return blockTools();
    case "fileType": return blockFileType();
    case "fileTag": return blockFileTag(c, user);
    case "driver": return blockDriver();
    default: return [];
  }
}

async function listBlockData(c: AppContext, user: Vars["currentUser"], parsed: ExplorerPath): Promise<Record<string, unknown>> {
  const blockId = parsed.blockId || "root";
  const isAdmin = user.role === "admin";
  const folderList = await blockChildren(c, user, blockId, isAdmin);
  return {
    current: { name: blockName(blockId), path: parsed.thisPath, pathDisplay: displayPath(parsed.thisPath), type: "folder", isFolder: true, isWriteable: true, isReadable: true, isTruePath: true },
    folderList,
    fileList: [],
    groupList: [],
    pageInfo: { totalNum: folderList.length, pageNum: 500, page: 1, pageTotal: Math.max(1, Math.ceil(folderList.length / 500)) },
    thisPath: parsed.thisPath,
    targetSpace: { sizeMax: 0, sizeUse: 0 },
  };
}

/** 按文件类型分类列出用户空间内所有匹配的文件。 */
async function listFilesByType(c: AppContext, user: Vars["currentUser"], parsed: ExplorerPath): Promise<Record<string, unknown>> {
  const typeId = parsed.typeId || "";
  const all = await listAllFiles(c.env.FILES, user.username).catch(() => [] as R2Object[]);
  const fileList: Record<string, unknown>[] = [];
  for (const o of all) {
    const rel = o.key.slice(o.key.indexOf("/") + 1);
    const name = rel.split("/").pop() || rel;
    if (!name) continue;
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const cat = kodFileType(name);
    const match = typeId === "photo" ? cat === "image" || cat === "movie" : cat === typeId;
    if (!match) continue;
    fileList.push({
      name,
      path: "{source:home}/" + rel,
      pathDisplay: displayPath("{source:home}/" + rel),
      type: cat,
      isFolder: false,
      isWriteable: true,
      isReadable: true,
      isTruePath: true,
      ext,
      size: o.size,
      modifyTime: o.uploaded ? new Date(o.uploaded).toISOString() : new Date().toISOString(),
      createTime: new Date().toISOString(),
    });
  }
  const typeNames: Record<string, string> = { photo: "我的相册", doc: "文档", image: "图片", music: "音乐", movie: "视频", zip: "压缩包", others: "其他" };
  const typeName = typeNames[typeId] || "文件";
  const totalNum = fileList.length;
  return {
    current: { name: typeName, path: parsed.thisPath, pathDisplay: displayPath(parsed.thisPath), type: "folder", isFolder: true, isWriteable: true, isReadable: true, isTruePath: true },
    folderList: [],
    fileList,
    groupList: [],
    pageInfo: { totalNum, pageNum: 500, page: 1, pageTotal: Math.max(1, Math.ceil(totalNum / 500)) },
    thisPath: parsed.thisPath,
    targetSpace: { sizeMax: 0, sizeUse: 0 },
  };
}

/** 判断一个前端路径（虚拟或真实）是否为文件夹，依据 R2 中是否存在该目录前缀的对象。 */
async function isFolderVirtualPath(env: Env, username: string, p: string): Promise<boolean> {
  const realPath = toRealPath(p).replace(/\/+$/, "");
  const rel = realPath.replace(/^\/+/, "");
  if (!rel) return false;
  const prefix = getUserFileKey(username, rel + "/");
  const listed = await env.FILES.list({ prefix, limit: 1 }).catch(() => null);
  return !!listed && listed.objects.length > 0;
}

/** 列出某个个人标签下的文件/文件夹。 */
async function listTagSourcesData(c: AppContext, user: Vars["currentUser"], parsed: ExplorerPath): Promise<Record<string, unknown>> {
  const tagId = parseInt(parsed.tagId || "0", 10);
  const tags = await getUserTags(c.env.DB, user.id);
  const tagInfo = (tags as any[]).find((t) => t.id === tagId);
  const sources = Number.isInteger(tagId) && tagId > 0 ? await getTagSources(c.env.DB, user.id, tagId) : [];
  const folderList: Record<string, unknown>[] = [];
  const fileList: Record<string, unknown>[] = [];
  for (const s of sources as any[]) {
    const rawPath = (s.path || "").replace(/\/+$/, "");
    const isFolder = await isFolderVirtualPath(c.env, user.username, rawPath);
    const name = rawPath.split("/").filter(Boolean).pop() || rawPath;
    if (isFolder) {
      folderList.push({
        name,
        path: rawPath + "/",
        pathDisplay: displayPath(rawPath + "/"),
        type: "folder",
        isFolder: true,
        isParent: true,
        hasChildren: true,
        isWriteable: true,
        isReadable: true,
        isTruePath: true,
        ext: "",
        size: 0,
        modifyTime: s.modifyTime || new Date().toISOString(),
        createTime: s.createTime || new Date().toISOString(),
        sourceInfo: { listTag: "1" },
      });
    } else {
      const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
      fileList.push({
        name,
        path: rawPath,
        pathDisplay: displayPath(rawPath),
        type: kodFileType(name),
        isFolder: false,
        isWriteable: true,
        isReadable: true,
        isTruePath: true,
        ext,
        size: 0,
        modifyTime: s.modifyTime || new Date().toISOString(),
        createTime: s.createTime || new Date().toISOString(),
        sourceInfo: { listTag: "1" },
      });
    }
  }
  const totalNum = folderList.length + fileList.length;
  return {
    current: {
      name: tagInfo?.name ? `个人标签 - ${tagInfo.name}` : "个人标签",
      path: parsed.thisPath,
      pathDisplay: displayPath(parsed.thisPath),
      type: "folder",
      isFolder: true,
      isWriteable: true,
      isReadable: true,
      isTruePath: true,
      pathAddress: [
        { name: "个人标签", path: "{block:fileTag}/" },
        { name: tagInfo?.name || "个人标签", path: parsed.thisPath },
      ],
    },
    folderList,
    fileList,
    groupList: [],
    pageInfo: { totalNum, pageNum: 500, page: 1, pageTotal: Math.max(1, Math.ceil(totalNum / 500)) },
    thisPath: parsed.thisPath,
    targetSpace: { sizeMax: 0, sizeUse: 0 },
  };
}

// ============ index ============

// desktopApp - desktop shortcut icons (frontend uses POST)
explorerApi.all("/index/desktopApp", async (c) => {
  const user = c.get("currentUser");
  const staticPath = getStaticHost(c);
  const isAdmin = user.role === "admin";

  const desktopApps: Record<string, any> = {
    myComputer: {
      name: "我的电脑",
      type: "path",
      value: "{source:home}/",
      icon: staticPath + "images/file_icon/icon_others/computer.png",
      menuType: "menu-default",
    },
    recycle: {
      name: "回收站",
      type: "path",
      value: "{userRecycle}",
      icon: "recycle",
      className: "file-folder",
      menuType: "menu-recycle-tree",
    },
    appStore: {
      name: "轻应用",
      type: "doAction",
      value: "appInstall",
      icon: staticPath + "images/file_icon/icon_others/appStore.png",
      menuType: "menu-default",
    },
    userPhoto: {
      name: "我的相册",
      type: "path",
      value: "{userFileType:photo}/",
      icon: staticPath + "images/file_icon/icon_file/gif.png",
      menuType: "menu-default",
    },
    userHelp: {
      name: "使用帮助",
      type: "url",
      value: "https://docs.MbesBox.com/",
      icon: staticPath + "images/file_icon/icon_file/hlp.png",
      menuType: "menu-default",
    },
  };

  if (isAdmin) {
    desktopApps.PluginCenter = {
      name: "插件中心",
      type: "url",
      value: "./#admin/plugin",
      rootNeed: 1,
      icon: staticPath + "images/file_icon/icon_others/plugins.png",
      menuType: "menu-default",
    };
    desktopApps.setting = {
      name: "系统设置",
      type: "url",
      rootNeed: 1,
      value: "./#admin",
      icon: staticPath + "images/file_icon/icon_others/setting.png",
      menuType: "menu-default",
    };
    desktopApps.adminLog = {
      name: "操作日志",
      type: "url",
      rootNeed: 1,
      value: "./#admin/log",
      icon: staticPath + "images/file_icon/icon_app/text.png",
      menuType: "menu-default",
    };
  }

  return c.json({ code: true, data: desktopApps });
});

// ============ list (main list + sidebar tree) ============

explorerApi.all("/list/path", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const rawPath = typeof params.path === "string" ? params.path : "/";
  const page = Math.max(1, parseInt(String(params.page ?? "1"), 10) || 1);
  const pageNum = Math.max(1, parseInt(String(params.pageNum ?? "500"), 10) || 500);

  const parsed = parseExplorerPath(rawPath);

  if (parsed.kind === "block") {
    return c.json({ code: true, data: await listBlockData(c, user, parsed) });
  }

  if (parsed.kind === "recycle") {
    return c.json({ code: true, data: emptyListData(parsed.thisPath, "回收站", user.id) });
  }
  if (parsed.kind === "fav") {
    return listFav(c, user, parsed.thisPath);
  }
  if (parsed.kind === "fileType") {
    return c.json({ code: true, data: await listFilesByType(c, user, parsed) });
  }
  if (parsed.kind === "fileTag") {
    return c.json({ code: true, data: await listTagSourcesData(c, user, parsed) });
  }
  if (parsed.kind === "recent") {
    return c.json({ code: true, data: emptyListData(parsed.thisPath, "最近文档", user.id) });
  }
  if (parsed.kind === "virtual") {
    const cleanPath = parsed.thisPath.replace(/\/+$/, "");
    const shareItem = parseShareItemPath(cleanPath);
    if (shareItem) {
      const data = await listShareItemDir(c.env, user, shareItem.shareID, shareItem.rel, parsed.thisPath);
      if (data) return c.json({ code: true, data });
      return c.json({ code: false, data: "分享不存在！" });
    }
    const virtualNames: Record<string, string> = {
      "{userShare}": "我分享的",
      "{userShareLink}": "外链分享",
      "{shareToMe}": "分享给我的",
      "{groupRootSelf}": "我的部门",
      "{search}": "搜索",
    };
    if (cleanPath === "{userShare}") {
      const data = await listUserShareVirtual(c.env, user, parsed.thisPath, false);
      return c.json({ code: true, data });
    }
    if (cleanPath === "{userShareLink}") {
      const data = await listUserShareVirtual(c.env, user, parsed.thisPath, true);
      return c.json({ code: true, data });
    }
    const vname = virtualNames[cleanPath] || "";
    return c.json({ code: true, data: emptyListData(parsed.thisPath, vname, user.id) });
  }

  const dirPath = normDirPath(parsed.realPath);
  // 前端依赖虚拟路径（如 {source:home}/桌面/）进行导航；真实路径仅用于 R2 访问。
  const virtualDir = parsed.thisPath.endsWith("/") ? parsed.thisPath : parsed.thisPath + "/";
  try {
    if (dirPath === "/") await ensureDesktopFolder(c.env, user.username);
    const { folders, files } = await listDirectory(c.env.FILES, user.username, dirPath);

    const folderList = folders
      .map((f) => f.key.split("/").filter(Boolean).pop() || "")
      .filter((name) => name && !name.startsWith("."))
      .map((name) => folderItem(name, virtualDir, user.id));

    const fileList = files
      .filter((f) => {
        const n = f.key.split("/").pop() || "";
        return n !== ".keep" && !n.startsWith(".");
      })
      .map((f) => fileItem(f, virtualDir, user.id));

    const currentName = dirPath === "/" ? rootName(user) : dirPath.split("/").filter(Boolean).pop() || rootName(user);
    const current = {
      name: currentName,
      path: parsed.thisPath,
      pathDisplay: displayPath(parsed.thisPath),
      type: "folder",
      isFolder: true,
      isWriteable: true,
      isReadable: true,
      isTruePath: true,
      targetType: "user",
      targetID: user.id,
    };

    const totalNum = folderList.length + fileList.length;
    const pageTotal = Math.max(1, Math.ceil(totalNum / pageNum));

    return c.json({
      code: true,
      data: {
        current,
        folderList,
        fileList,
        groupList: [],
        pageInfo: { totalNum, pageNum, page, pageTotal },
        thisPath: parsed.thisPath,
        targetSpace: { sizeMax: 0, sizeUse: 0 },
      },
    });
  } catch (err: any) {
    return c.json({ code: false, data: err.message });
  }
});

async function listFav(c: AppContext, user: Vars["currentUser"], thisPath: string) {
  const list = await getFavorites(c.env.DB, user.id);
  const folderList: Record<string, unknown>[] = [];
  const fileList: Record<string, unknown>[] = [];
  for (const item of list as any[]) {
    const isFolder = item.type === "folder" || item.path.endsWith("/");
    const base: Record<string, unknown> = {
      name: item.name,
      path: item.path,
      type: isFolder ? "folder" : kodFileType(item.name),
      isFolder,
      isWriteable: true,
      isReadable: true,
      targetType: "user",
      targetID: user.id,
      modifyTime: item.modifyTime || new Date().toISOString(),
      createTime: item.createTime || new Date().toISOString(),
      sourceInfo: { isFav: 1, favName: item.name, favID: item.id },
    };
    if (isFolder) {
      base.isParent = true;
      base.hasChildren = true;
      folderList.push(base);
    } else {
      fileList.push(base);
    }
  }
  const totalNum = folderList.length + fileList.length;
  return c.json({
    code: true,
    data: {
      current: { name: "收藏夹", path: thisPath, pathDisplay: displayPath(thisPath), type: "folder", isFolder: true, isWriteable: true, isReadable: true, isTruePath: true, targetType: "user", targetID: user.id },
      folderList,
      fileList,
      groupList: [],
      pageInfo: { totalNum, pageNum: 500, page: 1, pageTotal: Math.max(1, Math.ceil(totalNum / 500)) },
      thisPath,
      targetSpace: { sizeMax: 0, sizeUse: 0 },
    },
  });
}

// treeList - legacy sidebar folder tree (frontend actually uses /list/path)
explorerApi.all("/list/tree", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const path = normDirPath(typeof params.path === "string" ? params.path : "/");

  try {
    const { folders } = await listDirectory(c.env.FILES, user.username, path);
    const dirs = folders.map((p) => {
      const name = p.key.split("/").filter(Boolean).pop() || "";
      return folderItem(name, path, user.id);
    });
    return c.json({ code: true, data: dirs });
  } catch (err: any) {
    return c.json({ code: false, data: err.message });
  }
});

// pathInfo - file/folder detail (right-click context menu)
explorerApi.all("/index/pathInfo", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const items = parseDataArr(params.dataArr);
  if (items.length === 0) return c.json({ code: false, data: "No data" });

  const result: any[] = [];
  for (const item of items) {
    const path = item.path;
    if (!path) continue;
    const isFolder = path.endsWith("/");
    const name = path.split("/").filter(Boolean).pop() || path;

    if (isFolder) {
      result.push({
        name,
        path,
        pathDisplay: displayPath(path),
        type: "folder",
        isFolder: true,
        isParent: true,
        hasChildren: true,
        isWriteable: true,
        isReadable: true,
        isTruePath: true,
        size: 0,
        ext: "",
        modifyTime: new Date().toISOString(),
        createTime: new Date().toISOString(),
      });
    } else {
      const key = getUserFileKey(user.username, toRealPath(path));
      const obj = await c.env.FILES.head(key).catch(() => null);
      if (obj) {
        const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
        result.push({
          name,
          path,
          pathDisplay: displayPath(path),
          type: kodFileType(name),
          isFolder: false,
          isWriteable: true,
          isReadable: true,
          isTruePath: true,
          size: obj.size,
          ext,
          modifyTime: obj.uploaded ? new Date(obj.uploaded).toISOString() : new Date().toISOString(),
          createTime: new Date().toISOString(),
        });
      }
    }
  }

  if (result.length === 0) return c.json({ code: false, data: "路径不存在" });
  if (result.length === 1) return c.json({ code: true, data: result[0] });
  return c.json({ code: true, data: result });
});

// mkdir - create folder (path is full path including new folder name)
explorerApi.all("/index/mkdir", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const fullPath = normDirPath(toRealPath(typeof params.path === "string" ? params.path : "/"));

  try {
    const key = getUserFileKey(user.username, fullPath + ".keep");
    await c.env.FILES.put(key, "");
    await addAuditLog(c.env.DB, "mkdir", user.id, fullPath, null, null, null);
    return c.json({ code: true, data: "ok", info: fullPath });
  } catch (err: any) {
    return c.json({ code: false, data: err.message });
  }
});

// mkfile - create file (path is full path including new file name)
explorerApi.all("/index/mkfile", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const rawPath = typeof params.path === "string" ? params.path : "";
  if (!rawPath) return c.json({ code: false, data: "参数错误" });
  const fullPath = toRealPath(rawPath);

  try {
    let content = typeof params.content === "string" ? params.content : "";
    if (params.base64 === "1") {
      content = decodeBase64(content);
    }
    const key = getUserFileKey(user.username, fullPath);
    await c.env.FILES.put(key, content);
    await addAuditLog(c.env.DB, "mkfile", user.id, fullPath, null, null, null);
    return c.json({ code: true, data: "ok", info: fullPath });
  } catch (err: any) {
    return c.json({ code: false, data: err.message });
  }
});

// pathRename - rename file/folder
explorerApi.all("/index/pathRename", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const path = typeof params.path === "string" ? params.path : "";
  const newName = typeof params.newName === "string" ? params.newName : "";
  if (!path || !newName) return c.json({ code: false, data: "common.invalidParam" });
  if (newName.includes("/")) return c.json({ code: false, data: "common.invalidParam" });

  const realPath = toRealPath(path);
  const isFolder = realPath.endsWith("/");
  const parentPath = realPath.substring(0, realPath.lastIndexOf("/") + 1);
  const newPath = parentPath + newName + (isFolder ? "/" : "");

  try {
    const oldKey = getUserFileKey(user.username, realPath);
    const newKey = getUserFileKey(user.username, newPath);

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

    await addAuditLog(c.env.DB, "rename", user.id, path, null, null, `New: ${newName}`);
    const virtualNewPath = path.substring(0, path.lastIndexOf("/") + 1) + newName + (isFolder ? "/" : "");
    return c.json({ code: true, data: "ok", info: virtualNewPath });
  } catch (err: any) {
    return c.json({ code: false, data: err.message });
  }
});

// pathDelete - delete files/folders
explorerApi.all("/index/pathDelete", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const items = parseDataArr(params.dataArr);
  if (items.length === 0) return c.json({ code: false, data: "参数错误" });

  try {
    for (const item of items) {
      const path = toRealPath(item.path);
      const key = getUserFileKey(user.username, path);
      if (path.endsWith("/")) {
        await deleteDirectory(c.env.FILES, key.endsWith("/") ? key : key + "/");
      } else {
        await c.env.FILES.delete(key);
      }
      await addAuditLog(c.env.DB, "delete", user.id, path, null, null, null);
    }
    return c.json({ code: true, data: "ok" });
  } catch (err: any) {
    return c.json({ code: false, data: err.message });
  }
});

// ============ copy / cut / paste ============

async function copyObject(bucket: R2Bucket, srcKey: string, destKey: string): Promise<boolean> {
  const obj = await bucket.get(srcKey);
  if (!obj) return false;
  await bucket.put(destKey, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
  return true;
}

async function copyPath(bucket: R2Bucket, username: string, srcPath: string, destDir: string): Promise<boolean> {
  const srcKey = getUserFileKey(username, srcPath);
  const srcName = srcPath.split("/").filter(Boolean).pop() || srcPath;
  const isFolder = srcPath.endsWith("/");
  const destPath = destDir + srcName + (isFolder ? "/" : "");
  const destKey = getUserFileKey(username, destPath);

  if (isFolder) {
    const prefix = srcKey.endsWith("/") ? srcKey : srcKey + "/";
    const destPrefix = destKey.endsWith("/") ? destKey : destKey + "/";
    let cursor: string | undefined;
    do {
      const batch = await bucket.list({ prefix, cursor });
      for (const o of batch.objects) {
        const relPath = o.key.slice(prefix.length);
        await copyObject(bucket, o.key, destPrefix + relPath);
      }
      cursor = batch.truncated ? batch.cursor : undefined;
    } while (cursor);
    return true;
  }
  return copyObject(bucket, srcKey, destKey);
}

async function movePath(bucket: R2Bucket, username: string, srcPath: string, destDir: string): Promise<boolean> {
  const srcKey = getUserFileKey(username, srcPath);
  const srcName = srcPath.split("/").filter(Boolean).pop() || srcPath;
  const isFolder = srcPath.endsWith("/");
  const destPath = destDir + srcName + (isFolder ? "/" : "");
  const destKey = getUserFileKey(username, destPath);

  if (isFolder && destKey.startsWith(srcKey.endsWith("/") ? srcKey : srcKey + "/")) {
    return false; // moving a dir into its own subtree
  }

  if (isFolder) {
    const prefix = srcKey.endsWith("/") ? srcKey : srcKey + "/";
    const destPrefix = destKey.endsWith("/") ? destKey : destKey + "/";
    let cursor: string | undefined;
    do {
      const batch = await bucket.list({ prefix, cursor });
      for (const o of batch.objects) {
        const relPath = o.key.slice(prefix.length);
        await copyObject(bucket, o.key, destPrefix + relPath);
        await bucket.delete(o.key);
      }
      cursor = batch.truncated ? batch.cursor : undefined;
    } while (cursor);
    return true;
  }
  const ok = await copyObject(bucket, srcKey, destKey);
  if (ok) await bucket.delete(srcKey);
  return ok;
}

// pathCopy - store copy clipboard server-side
explorerApi.all("/index/pathCopy", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const items = parseDataArr(params.dataArr);
  const paths = items.map((it) => it.path);
  await setUserOption(c.env.DB, user.id, "pathCopy", JSON.stringify(paths), "clipboard");
  await setUserOption(c.env.DB, user.id, "pathCopyType", "copy", "clipboard");
  return c.json({ code: true, data: "ok" });
});

// pathCute - store cut clipboard server-side
explorerApi.all("/index/pathCute", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const items = parseDataArr(params.dataArr);
  const paths = items.map((it) => it.path);
  await setUserOption(c.env.DB, user.id, "pathCopy", JSON.stringify(paths), "clipboard");
  await setUserOption(c.env.DB, user.id, "pathCopyType", "cut", "clipboard");
  return c.json({ code: true, data: "ok" });
});

// clipboard - query clipboard state (frontend uses POST)
explorerApi.all("/index/clipboard", async (c) => {
  const user = c.get("currentUser");
  const raw = await getUserOption(c.env.DB, user.id, "pathCopy", "clipboard");
  const type = await getUserOption(c.env.DB, user.id, "pathCopyType", "clipboard");
  const paths = raw ? JSON.parse(raw) : [];
  return c.json({ code: true, data: { type, dataArr: paths } });
});

// pathPast - paste from clipboard
explorerApi.all("/index/pathPast", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const target = normDirPath(toRealPath(typeof params.path === "string" ? params.path : "/"));
  const raw = await getUserOption(c.env.DB, user.id, "pathCopy", "clipboard");
  const type = await getUserOption(c.env.DB, user.id, "pathCopyType", "clipboard");
  const paths: string[] = raw ? JSON.parse(raw) : [];
  for (const p of paths) {
    const rp = toRealPath(p);
    if (type === "cut") await movePath(c.env.FILES, user.username, rp, target);
    else await copyPath(c.env.FILES, user.username, rp, target);
  }
  return c.json({ code: true, data: "ok", info: target });
});

// pathCopyTo - copy directly to a target folder
explorerApi.all("/index/pathCopyTo", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const items = parseDataArr(params.dataArr);
  const target = normDirPath(toRealPath(typeof params.path === "string" ? params.path : "/"));
  for (const it of items) {
    await copyPath(c.env.FILES, user.username, toRealPath(it.path), target);
  }
  return c.json({ code: true, data: "ok", info: target });
});

// pathCuteTo - move directly to a target folder
explorerApi.all("/index/pathCuteTo", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const items = parseDataArr(params.dataArr);
  const target = normDirPath(toRealPath(typeof params.path === "string" ? params.path : "/"));
  for (const it of items) {
    await movePath(c.env.FILES, user.username, toRealPath(it.path), target);
  }
  return c.json({ code: true, data: "ok", info: target });
});

// ============ file output / download ============

function fileStreamResponse(c: AppContext, obj: any, name: string, disposition: "inline" | "attachment") {
  const headers = new Headers();
  headers.set("Content-Type", getFileMimeType(name));
  headers.set("Content-Disposition", `${disposition}; filename="${encodeURIComponent(name)}"`);
  if (disposition === "inline") headers.set("Cache-Control", "public, max-age=3600");
  obj.writeHttpMetadata(headers);
  return new Response(obj.body, { headers });
}

async function fileOutHandler(c: AppContext, disposition: "inline" | "attachment") {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const path = typeof params.path === "string" ? params.path : "";
  if (!path) return c.json({ code: false, data: "参数错误" });

  const key = getUserFileKey(user.username, toRealPath(path));
  const obj = await c.env.FILES.get(key).catch(() => null);
  if (!obj) return c.json({ code: false, data: "Not found" });

  const name = (typeof params.name === "string" && params.name) ? params.name : path.split("/").filter(Boolean).pop() || "file";
  return fileStreamResponse(c, obj, name, disposition);
}

explorerApi.all("/index/fileDownload", (c) => fileOutHandler(c, "attachment"));
explorerApi.all("/index/fileOut", (c) => fileOutHandler(c, "inline"));
explorerApi.all("/index/fileOutBy", (c) => fileOutHandler(c, "inline"));

// fileSave - save text content to file
explorerApi.all("/index/fileSave", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const path = typeof params.path === "string" ? params.path : "";
  if (!path) return c.json({ code: false, data: "参数错误" });

  let content = typeof params.content === "string" ? params.content : "";
  if (params.base64 === "1") {
    content = decodeBase64(content);
  }
  const key = getUserFileKey(user.username, toRealPath(path));
  await c.env.FILES.put(key, content);
  await addAuditLog(c.env.DB, "fileSave", user.id, path, null, null, null);
  return c.json({ code: true, data: "ok" });
});

// ============ editor ============

// editor/fileGet - read file content for text editor
explorerApi.all("/editor/fileGet", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const path = typeof params.path === "string" ? params.path : "";
  if (!path) return c.json({ code: false, data: "参数错误" });

  const key = getUserFileKey(user.username, toRealPath(path));
  const obj = await c.env.FILES.get(key).catch(() => null);
  if (!obj) return c.json({ code: false, data: "common.pathNotExists" });

  const name = path.split("/").filter(Boolean).pop() || path;
  const content = await obj.text().catch(() => "");
  return c.json({
    code: true,
    data: {
      name,
      path,
      pathDisplay: displayPath(path),
      ext: name.includes(".") ? name.split(".").pop()!.toLowerCase() : "",
      size: obj.size,
      charset: "utf-8",
      base64: "0",
      pageInfo: { page: 1, pageNum: 1, pageTotal: 1 },
      content,
    },
  });
});

// editor/fileSave - save text editor content
explorerApi.all("/editor/fileSave", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const path = typeof params.path === "string" ? params.path : "";
  if (!path) return c.json({ code: false, data: "参数错误" });

  let content = typeof params.content === "string" ? params.content : "";
  if (params.base64 === "1") {
    content = decodeBase64(content);
  }
  const key = getUserFileKey(user.username, toRealPath(path));
  await c.env.FILES.put(key, content);
  await addAuditLog(c.env.DB, "editorSave", user.id, path, null, null, null);
  return c.json({ code: true, data: "ok" });
});

// ============ search ============

explorerApi.all("/index/search", async (c) => {
  const user = c.get("currentUser");
  const params = await reqParams(c);
  const keyword = (typeof params.keyword === "string" ? params.keyword : "").toLowerCase();
  const path = typeof params.path === "string" ? params.path : "/";

  if (!keyword) return c.json({ code: true, data: [] });

  try {
    const prefix = getUserFileKey(user.username, toRealPath(path));
    const results: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const listed = await c.env.FILES.list({ prefix, cursor });
      for (const obj of listed.objects) {
        const name = obj.key.split("/").pop() || "";
        if (name === ".keep") continue;
        if (name.toLowerCase().includes(keyword)) {
          results.push({
            name,
            path: "/" + obj.key.slice(obj.key.indexOf("/") + 1),
            size: obj.size,
            type: kodFileType(name),
            modifyTime: new Date().toISOString(),
          });
        }
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor && results.length < 200);

    return c.json({ code: true, data: results });
  } catch (err: any) {
    return c.json({ code: false, data: err.message });
  }
});

// ============ upload ============

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 001 契约: fileInfo=1 时 info 返回文件信息对象, 否则返回最终文件虚拟路径字符串。 */
function uploadInfoJson(virtualDir: string, fileName: string, size: number, fileInfo: string): string | Record<string, unknown> {
  const fullPath = virtualDir + fileName;
  if (fileInfo === "1") {
    return {
      name: fileName,
      size,
      path: fullPath,
      pathDisplay: displayPath(fullPath),
      ext: fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "",
      createTime: Math.floor(Date.now() / 1000),
      downloadPath: "",
    };
  }
  return fullPath;
}

/** 列出某前缀下所有对象 key（处理 list 分页），用于收集 multipart part 或清理临时对象。 */
async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of listed.objects) keys.push(o.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return keys;
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
    // 消费失败(如并发合并时临时对象已被清理), 结束写入线程避免悬挂
    await writePromise.catch(() => {});
    throw err;
  }
  await writePromise;
}

explorerApi.post("/upload/fileUpload", async (c) => {
  const user = c.get("currentUser");
  const contentType = c.req.header("Content-Type") || "";

  let path = "/", name = "", size = 0, chunk = 0, chunks = 1, chunkSizeParam = 0;
  let checkType = "", fileInfo = "";
  let file: File | null = null;

  const isMultipart = contentType.includes("multipart/form-data");
  const isUrlencoded = contentType.includes("application/x-www-form-urlencoded");
  if (!isMultipart && !isUrlencoded) {
    // sendAsBinary 模式: webuploader 将表单参数拼入 URL query, 请求体为文件二进制流
    // (浏览器请求 Content-Type 为文件自身 MIME, 如 text/plain; 而非 application/octet-stream)
    const q = c.req.query();
    path = q.path || "/";
    name = q.name || "";
    size = parseInt(q.size || "0", 10);
    chunk = parseInt(q.chunk || "0", 10);
    chunks = parseInt(q.chunks || "1", 10);
    chunkSizeParam = parseInt(q.chunkSize || "0", 10);
    checkType = q.checkType || "";
    fileInfo = q.fileInfo || "";
    if (name) {
      const buf = await c.req.arrayBuffer();
      file = new File([buf], name, { type: q.type || "application/octet-stream" });
    }
  } else {
    // parseBody 同时支持 multipart/form-data 与 application/x-www-form-urlencoded(预检请求)
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    path = str("path") || "/";
    name = str("name");
    size = parseInt(str("size") || "0", 10);
    chunk = parseInt(str("chunk") || "0", 10);
    chunks = parseInt(str("chunks") || "1", 10);
    chunkSizeParam = parseInt(str("chunkSize") || "0", 10);
    checkType = str("checkType");
    fileInfo = str("fileInfo");
    file = body["file"] instanceof File ? (body["file"] as File) : null;
  }
  // 对齐 001 逻辑: 分片大小不小于文件大小时视为不分片, 避免小文件触发 R2 multipart 最小 5MiB 限制
  if (chunkSizeParam > 0 && size > 0 && chunkSizeParam >= size) chunks = 1;

  // 上传预检(秒传/断点续传): 返回 uploadToKod=true + kodDriverType=Local, 使前端直接走后端上传
  if (checkType) {
    return c.json({
      code: true,
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

  const realDir = normDirPath(toRealPath(path));
  const virtualDir = normDirPath(path);
  const fileName = name || file.name;
  const key = getUserFileKey(user.username, realDir + fileName);

  try {
    if (chunks > 1) {
      // 分片上传: 每个分片独立暂存为临时对象, 全部到达后按序流式合并,
      // 规避 R2 multipart 每 part 最小 5MiB 的限制(前端默认分片仅 2MB)。
      const sessionId = await sha256Hex(`${user.username}|${realDir}|${fileName}|${size}`);
      const tmpPrefix = getUserFileKey(user.username, `/.upload_tmp/${sessionId}/`);
      const chunkKey = `${tmpPrefix}chunk_${chunk}`;
      const mergedKey = `${tmpPrefix}merged`;

      // 上次会话已完整合并过(merged 存在)才清理, 否则保留在途/残留分片
      // (断点续传语义: 分片并发上传时不得删掉已在途的其他分片)
      if (chunk === 0 && (await c.env.FILES.head(mergedKey))) {
        const staleKeys = await listAllKeys(c.env.FILES, tmpPrefix);
        if (staleKeys.length > 0) await c.env.FILES.delete(staleKeys);
      }

      // 暂存当前分片 (覆盖式, 分片并发/重试时幂等)
      await c.env.FILES.put(chunkKey, file.stream(), { httpMetadata: { contentType: file.type || getFileMimeType(fileName) } });

      // 检查全部分片是否已到齐
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
        return c.json({ code: true, data: `chunk_success_${chunk}` });
      }

      // 已合并完成则跳过, 否则按序流式合并写入最终 key
      const mergedObj = await c.env.FILES.head(mergedKey);
      if (!mergedObj) {
        try {
          await mergeChunks(c.env.FILES, chunkKeys, size, key, { httpMetadata: { contentType: file.type || getFileMimeType(fileName) } });
          await c.env.FILES.put(mergedKey, "1");
        } catch (err) {
          // 并发分片可能同时触发合并; 若已由其他请求完成则视为成功
          if (!(await c.env.FILES.head(mergedKey))) throw err;
        }
      }

      // 清理临时对象 (分片 + merged 标记)
      const tmpKeys = await listAllKeys(c.env.FILES, tmpPrefix);
      if (tmpKeys.length > 0) await c.env.FILES.delete(tmpKeys);
    } else {
      await c.env.FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || getFileMimeType(fileName) } });
    }

    await addAuditLog(c.env.DB, "upload", user.id, realDir + fileName, null, null, `Size: ${size || file.size}`);
    return c.json({ code: true, data: "上传成功", info: uploadInfoJson(virtualDir, fileName, size || file.size, fileInfo) });
  } catch (err: any) {
    return c.json({ code: false, data: err.message });
  }
});

// legacy download / fileProxy / image routes (kept for compatibility)
explorerApi.all("/download", (c) => fileOutHandler(c, "attachment"));
explorerApi.all("/fileProxy", (c) => fileOutHandler(c, "inline"));
explorerApi.all("/image", (c) => fileOutHandler(c, "inline"));

// ============ fav (favorites) ============

async function favParams(c: AppContext): Promise<any> {
  return reqParams(c);
}

explorerApi.all("/fav/get", async (c) => {
  const user = c.get("currentUser");
  const list = await getFavorites(c.env.DB, user.id);

  const items: any[] = [];
  for (const item of list as any[]) {
    const path = item.path;
    const name = item.name;
    const isFolder = item.type === "folder" || path.endsWith("/");

    let info: any = {
      name,
      path,
      type: item.type === "file" ? "file" : "folder",
      modifyTime: item.modifyTime,
      createTime: item.createTime,
      isFolder: isFolder,
    };
    info.sourceInfo = { isFav: 1, favName: name, favID: item.id };

    const key = getUserFileKey(user.username, toRealPath(path));
    if (isFolder) {
      const prefix = key.endsWith("/") ? key : key + "/";
      const listed = await c.env.FILES.list({ prefix, limit: 1 });
      if (listed.objects.length === 0 && (listed.delimitedPrefixes?.length ?? 0) === 0) {
        info.exists = false;
      }
    } else {
      const obj = await c.env.FILES.head(key);
      if (!obj) {
        info.exists = false;
      } else {
        info.type = "file";
        info.size = obj.size;
        info.ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() || "" : "";
      }
    }
    items.push(info);
  }

  return c.json({ code: true, data: items });
});

explorerApi.all("/fav/add", async (c) => {
  const user = c.get("currentUser");
  const body = await favParams(c);
  const path = body.path;
  const name = body.name;
  const favType = body.type || "folder";

  if (!path || !name) return c.json({ code: false, data: "参数错误" });

  const list = await getFavorites(c.env.DB, user.id);
  if (list.length > 1000) return c.json({ code: false, data: "数量已达上限" });
  for (const item of list as any[]) {
    if (item.path === path) return c.json({ code: false, data: "该路径已收藏" });
  }

  await addFavorite(c.env.DB, user.id, path, name, favType);
  await addAuditLog(c.env.DB, "fav.add", user.id, path, null, null, name);
  return c.json({ code: true, data: "添加收藏成功" });
});

explorerApi.all("/fav/del", async (c) => {
  const user = c.get("currentUser");
  const body = await favParams(c);
  const name = body.name;
  if (!name) return c.json({ code: false, data: "参数错误" });

  await removeFavoriteByName(c.env.DB, user.id, name);
  await addAuditLog(c.env.DB, "fav.del", user.id, null, null, null, name);
  return c.json({ code: true, data: "取消收藏成功" });
});

explorerApi.all("/fav/rename", async (c) => {
  const user = c.get("currentUser");
  const body = await favParams(c);
  const name = body.name;
  const newName = body.newName;
  if (!name || !newName) return c.json({ code: false, data: "参数错误" });

  const list = await getFavorites(c.env.DB, user.id);
  for (const item of list as any[]) {
    if (item.name === newName && item.name !== name) return c.json({ code: false, data: "名称已存在" });
  }

  await renameFavorite(c.env.DB, user.id, name, newName);
  return c.json({ code: true, data: body.path || false });
});

explorerApi.all("/fav/moveTop", async (c) => {
  const user = c.get("currentUser");
  const body = await favParams(c);
  const name = body.name;
  if (!name) return c.json({ code: false, data: "参数错误" });

  await favMoveTop(c.env.DB, user.id, name);
  return c.json({ code: true, data: "success" });
});

explorerApi.all("/fav/moveBottom", async (c) => {
  const user = c.get("currentUser");
  const body = await favParams(c);
  const name = body.name;
  if (!name) return c.json({ code: false, data: "参数错误" });

  await favMoveBottom(c.env.DB, user.id, name);
  return c.json({ code: true, data: "success" });
});

explorerApi.all("/fav/resetSort", async (c) => {
  const user = c.get("currentUser");
  const body = await favParams(c);
  const favList = body.favList;
  if (!favList) return c.json({ code: false, data: "参数错误" });

  const idArray = String(favList).split(",").filter(Boolean);
  if (idArray.length === 0) return c.json({ code: false, data: "参数错误" });

  await favResetSort(c.env.DB, user.id, idArray);
  return c.json({ code: true, data: "success" });
});

// ============ tag (个人标签) ============

/** 解析 tag/files 请求体（POST 或 GET，含 __*@*__ 逗号转义）。 */
async function tagParams(c: AppContext): Promise<Record<string, any>> {
  return reqParams(c);
}

function parseTagFiles(raw: any): string[] {
  const s = String(raw || "").replace(/__\*@\*__/g, ",");
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

explorerApi.all("/tag/get", async (c) => {
  const user = c.get("currentUser");
  const list = await getUserTags(c.env.DB, user.id);
  return c.json({ code: true, data: list });
});

explorerApi.all("/tag/add", async (c) => {
  const user = c.get("currentUser");
  const body = await tagParams(c);
  const name = String(body.name || "").trim();
  const style = String(body.style || "label-grey-normal");
  if (!name) return c.json({ code: false, data: "参数错误" });
  const id = await addTag(c.env.DB, user.id, name, style);
  if (id === null) return c.json({ code: false, data: "标签已存在" });
  const list = await getUserTags(c.env.DB, user.id);
  return c.json({ code: true, data: "success", info: list });
});

explorerApi.all("/tag/edit", async (c) => {
  const user = c.get("currentUser");
  const body = await tagParams(c);
  const tagID = parseInt(String(body.tagID ?? ""), 10);
  if (!Number.isInteger(tagID) || tagID <= 0) return c.json({ code: false, data: "参数错误" });
  const data: { name?: string; style?: string } = {};
  if (body.name !== undefined && body.name !== null && String(body.name).trim() !== "") data.name = String(body.name).trim();
  if (body.style !== undefined && body.style !== null) data.style = String(body.style);
  await editTag(c.env.DB, user.id, tagID, data);
  const list = await getUserTags(c.env.DB, user.id);
  return c.json({ code: true, data: "success", info: list });
});

explorerApi.all("/tag/remove", async (c) => {
  const user = c.get("currentUser");
  const body = await tagParams(c);
  const tagID = parseInt(String(body.tagID ?? ""), 10);
  if (!Number.isInteger(tagID) || tagID <= 0) return c.json({ code: false, data: "参数错误" });
  await removeTag(c.env.DB, user.id, tagID);
  const list = await getUserTags(c.env.DB, user.id);
  return c.json({ code: true, data: "success", info: list });
});

explorerApi.all("/tag/moveTop", async (c) => {
  const user = c.get("currentUser");
  const body = await tagParams(c);
  const tagID = parseInt(String(body.tagID ?? ""), 10);
  if (!Number.isInteger(tagID) || tagID <= 0) return c.json({ code: false, data: "参数错误" });
  await tagMoveTop(c.env.DB, user.id, tagID);
  const list = await getUserTags(c.env.DB, user.id);
  return c.json({ code: true, data: "success", info: list });
});

explorerApi.all("/tag/moveBottom", async (c) => {
  const user = c.get("currentUser");
  const body = await tagParams(c);
  const tagID = parseInt(String(body.tagID ?? ""), 10);
  if (!Number.isInteger(tagID) || tagID <= 0) return c.json({ code: false, data: "参数错误" });
  await tagMoveBottom(c.env.DB, user.id, tagID);
  const list = await getUserTags(c.env.DB, user.id);
  return c.json({ code: true, data: "success", info: list });
});

explorerApi.all("/tag/resetSort", async (c) => {
  const user = c.get("currentUser");
  const body = await tagParams(c);
  const idArray = String(body.tagList || "").split(",").map((x: string) => x.trim()).filter(Boolean);
  if (idArray.length === 0) return c.json({ code: false, data: "参数错误" });
  await tagResetSort(c.env.DB, user.id, idArray);
  const list = await getUserTags(c.env.DB, user.id);
  return c.json({ code: true, data: "success", info: list });
});

explorerApi.all("/tag/filesAddToTag", async (c) => {
  const user = c.get("currentUser");
  const body = await tagParams(c);
  const tagID = parseInt(String(body.tagID ?? ""), 10);
  const files = parseTagFiles(body.files);
  if (!Number.isInteger(tagID) || tagID <= 0 || files.length === 0) return c.json({ code: false, data: "参数错误" });
  await tagAddSources(c.env.DB, user.id, tagID, files);
  return c.json({ code: true, data: "success" });
});

explorerApi.all("/tag/filesRemoveFromTag", async (c) => {
  const user = c.get("currentUser");
  const body = await tagParams(c);
  const tagID = parseInt(String(body.tagID ?? ""), 10);
  const files = parseTagFiles(body.files);
  if (!Number.isInteger(tagID) || tagID <= 0 || files.length === 0) return c.json({ code: false, data: "参数错误" });
  await tagRemoveSources(c.env.DB, user.id, tagID, files);
  return c.json({ code: true, data: "success" });
});

export { explorerApi };
