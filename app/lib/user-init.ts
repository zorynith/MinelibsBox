/**
 * 新用户/部门默认初始化 (mirrors 001 adminMember::settingDefault/folderDefault/lightAppDefault)
 * member/add 与 regist 创建用户后调用: 写默认 user_option、建默认目录、桌面放默认轻应用。
 */
import { setUserOption, getSetting } from "./db";
import { getUserFileKey } from "./r2";

/** 001 config/setting.php settingDefault - 新用户默认用户配置 */
export const DEFAULT_USER_OPTIONS: Record<string, string> = {
  listType: "icon",
  listSortField: "name",
  listSortOrder: "up",
  fileIconSize: "80",
  fileOpenClick: "dbclick",
  fileShowDesc: "0",
  fileShowRename: "1",
  animateOpen: "1",
  soundOpen: "0",
  theme: "auto",
  themeImage: "",
  wall: "4",
  language: "zh-CN",
  listTypeKeep: "1",
  listSortKeep: "1",
  menuBarAutoHide: "0",
  pathSafeSpaceShow: "1",
  themeStyle: "theme-windows",
  fileRepeat: "replace",
  recycleOpen: "1",
  kodAppDefault: "",
  fileIconSizeDesktop: "70",
  fileIconSizePhoto: "120",
  photoConfig: "",
  resizeConfig: '{"filename":250,"filetype":80,"filesize":80,"filetime":215,"editorTreeWidth":220,"explorerTreeWidth":220}',
  imageThumb: "1",
  fileSelect: "1",
  displayHideFile: "0",
  filePanel: "1",
  shareToMeShowType: "list",
  messageSendType: "enter",
  loginDevice: "",
};

/** 001 data/system/apps.php 中 newUserApp 对应的默认轻应用内容 */
export const DEFAULT_LIGHT_APPS: Record<string, Record<string, unknown>> = {
  "高德地图": {
    type: "url",
    content: "https://ditu.amap.com/",
    group: "life",
    name: "高德地图",
    desc: "gaode map",
    icon: "map.png",
    width: "800",
    height: "600",
    simple: 0,
    resize: 1,
  },
  icloud: {
    type: "url",
    content: "https://www.icloud.com/",
    group: "others",
    name: "icloud",
    desc: "icloud",
    icon: "icloud.png",
    width: "800",
    height: "600",
    openType: "window",
    simple: 0,
    resize: 1,
  },
};

/** 001 settingDefault: 写入新用户默认 user_option 配置 */
export async function settingDefault(db: D1Database, userID: number): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_USER_OPTIONS)) {
    await setUserOption(db, userID, key, value);
  }
}

/** 001 folderDefault: 用户空间创建默认目录(可由 systemOption.newUserFolder 覆盖) */
export async function folderDefaultUser(bucket: R2Bucket, username: string, folderNames?: string[]): Promise<void> {
  const names = folderNames && folderNames.length > 0 ? folderNames : ["我的文档", "我的图片", "我的音乐"];
  for (const name of names) {
    const key = getUserFileKey(username, "/" + name + "/.keep");
    try {
      const existing = await bucket.head(key);
      if (!existing) await bucket.put(key, "");
    } catch {
      // ignore transient storage errors
    }
  }
}

/** 001 lightAppDefault: 桌面创建默认轻应用(高德地图/icloud; 可由 systemOption.newUserApp 覆盖) */
export async function lightAppDefault(
  bucket: R2Bucket,
  username: string,
  apps?: Record<string, Record<string, unknown>>
): Promise<void> {
  for (const [name, app] of Object.entries(apps && Object.keys(apps).length > 0 ? apps : DEFAULT_LIGHT_APPS)) {
    const key = getUserFileKey(username, "/桌面/" + name + ".oexe");
    try {
      const existing = await bucket.head(key);
      if (!existing) await bucket.put(key, JSON.stringify(app));
    } catch {
      // ignore transient storage errors
    }
  }
}

/** 001 member.add 初始化三步: 默认配置 + 默认目录 + 桌面默认轻应用 */
export async function userDefaultInit(db: D1Database, bucket: R2Bucket, userID: number, username: string): Promise<void> {
  await settingDefault(db, userID);
  await folderDefaultUser(bucket, username, await settingStringList(db, "newUserFolder"));
  await lightAppDefault(bucket, username, await settingLightApps(db, "newUserApp"));
}

/** 后台 "新用户默认文件夹" 设置 (逗号/JSON 数组); 未配置返回 undefined 用内置默认 */
async function settingStringList(db: D1Database, key: string): Promise<string[] | undefined> {
  const raw = await getSetting(db, key).catch(() => null);
  const text = String(raw ?? "").trim();
  if (!text) return undefined;
  if (text.startsWith("[")) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        const list = arr.map((v) => String(typeof v === "string" ? v : v?.name ?? "")).filter(Boolean);
        if (list.length > 0) return list;
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }
  const list = text.split(",").map((v) => v.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** 后台 "新用户默认轻应用" 设置 (JSON 对象[name->app] 或逗号分隔名称, 未配置用内置默认) */
async function settingLightApps(db: D1Database, key: string): Promise<Record<string, Record<string, unknown>> | undefined> {
  const raw = await getSetting(db, key).catch(() => null);
  const text = String(raw ?? "").trim();
  if (!text) return undefined;
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).length > 0) {
        return obj as Record<string, Record<string, unknown>>;
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }
  // 逗号分隔名称: 只保留内置默认里同名的应用
  const names = text.split(",").map((v) => v.trim()).filter(Boolean);
  if (names.length === 0) return undefined;
  const picked: Record<string, Record<string, unknown>> = {};
  for (const n of names) {
    if (DEFAULT_LIGHT_APPS[n]) picked[n] = DEFAULT_LIGHT_APPS[n];
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}
