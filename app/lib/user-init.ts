/**
 * 新用户/部门默认初始化 (mirrors 001 adminMember::settingDefault/folderDefault/lightAppDefault)
 * member/add 与 regist 创建用户后调用: 写默认 user_option、建默认目录、桌面放默认轻应用。
 */
import { setUserOption } from "./db";
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

/** 001 folderDefault: 用户空间创建默认目录(我的文档/我的图片/我的音乐) */
export async function folderDefaultUser(bucket: R2Bucket, username: string): Promise<void> {
  for (const name of ["我的文档", "我的图片", "我的音乐"]) {
    const key = getUserFileKey(username, "/" + name + "/.keep");
    try {
      const existing = await bucket.head(key);
      if (!existing) await bucket.put(key, "");
    } catch {
      // ignore transient storage errors
    }
  }
}

/** 001 lightAppDefault: 桌面创建默认轻应用(高德地图/icloud).oexe */
export async function lightAppDefault(bucket: R2Bucket, username: string): Promise<void> {
  for (const [name, app] of Object.entries(DEFAULT_LIGHT_APPS)) {
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
  await folderDefaultUser(bucket, username);
  await lightAppDefault(bucket, username);
}
