/**
 * User API - login, options, lang, plugins
 * These are the critical APIs the 003 SPA needs to bootstrap
 */
import { Hono } from "hono";
import { getUserByUsername, createSession, deleteSession, getUserById, getSetting, setSetting, getSession } from "../lib/db";
import { getSessionId, clearSessionCookie, setSessionCookie, verifyPassword, authRequired } from "../lib/auth";
import { parseKodPassword } from "../lib/mcrypt";
import { DEV_KOD, devLicenseHashes } from "../lib/license";
import { detectLang, loadLangPack, normalizeLang } from "../lib/i18n-lang";
import { renderPluginsJs } from "../lib/plugins";
import { accountApi } from "./user-account-api";
import { getAppHost, getStaticHost } from "../lib/user-system";

const userApi = new Hono<{ Bindings: Env; Variables: { currentUser: import("../lib/auth").AuthUser } }>();

// Keys persisted in the `settings` table that mirror 001 language-pack keys.
// When the admin edits enterprise info (copyright/powerBy/desc/contact/...), the
// SPA sends these dotted keys to admin/setting/set; the Worker must overlay them
// onto the returned language pack so window.LNG reflects the saved values after
// a refresh (otherwise the copyright dialog keeps showing the static default).
const COPYRIGHT_LNG_KEYS = [
  "common.copyright.name",
  "common.copyright.nameTitle",
  "common.copyright.nameDesc",
  "common.copyright.desc",
  "common.copyright.contact",
  "common.copyright.powerBy",
  "common.copyright.homepage",
  "common.copyright.metaKeywords",
  "common.copyright.metaName",
];

// Read the full `settings` table into a map, JSON-first deserialization
// (same semantics as admin/setting/get). String values stay raw strings.
async function loadSettingsMap(db: D1Database): Promise<Record<string, any>> {
  const rows = await db.prepare("SELECT key, value FROM settings").all();
  const map: Record<string, any> = {};
  for (const r of rows.results as any[]) {
    const v = r.value;
    try {
      map[r.key] = JSON.parse(v);
    } catch {
      map[r.key] = v;
    }
  }
  return map;
}

// Overlay saved copyright/language-pack keys onto a language pack list.
function overlayCopyright(list: Record<string, any>, settings: Record<string, any>): void {
  for (const k of COPYRIGHT_LNG_KEYS) {
    if (settings[k] !== undefined) list[k] = settings[k];
  }
}

// ============ index ============

// loginSubmit
userApi.post("/index/loginSubmit", async (c) => {
  const body: Record<string, string> = {};
  const rawBody = await c.req.parseBody().catch(() => ({}));
  for (const [k, v] of Object.entries(rawBody)) {
    body[k] = typeof v === "string" ? v : "";
  }
  const username = body.name || body.username || "";
  const password = body.password || "";
  const salt = body.salt || "";
  const remember = body.remember === "1" || body.remember === "true";

  if (!username || !password) {
    return c.json({ code: false, data: "用户名或密码错误!" });
  }

  const plainPassword = parseKodPassword(password, salt);
  if (!plainPassword) {
    return c.json({ code: false, data: "用户名或密码错误!" });
  }

  const user = await getUserByUsername(c.env.DB, username);
  if (!user) {
    return c.json({ code: false, data: "用户名或密码错误!" });
  }

  const valid = await verifyPassword(plainPassword, user.password_hash as string);
  if (!valid) {
    return c.json({ code: false, data: "用户名或密码错误!" });
  }

  const maxAge = remember ? 30 * 86400 : 86400;
  const sessionId = await createSession(c.env.DB, user.id as number, remember ? 720 : 24);
  setSessionCookie(c, sessionId, maxAge);

  // Set accessToken cookie too (003 SPA checks this).
  // Must append, otherwise it overwrites the kod_session Set-Cookie above.
  c.header("Set-Cookie", `accessToken=${sessionId}; Path=/; Max-Age=${maxAge}; SameSite=Lax`, { append: true });

  return c.json({ code: true, data: { userID: user.id, name: user.username, nickname: user.nickname } });
});

// logout
userApi.get("/index/logout", async (c) => {
  const sessionId = getSessionId(c);
  if (sessionId) await deleteSession(c.env.DB, sessionId);
  clearSessionCookie(c);
  c.header("Set-Cookie", "accessToken=; Path=/; Max-Age=0; SameSite=Lax", { append: true });
  return c.json({ code: true, data: "ok" });
});

// loginCheck - returns current user info or null
userApi.get("/index/loginCheck", async (c) => {
  const sessionId = getSessionId(c);
  if (!sessionId) {
    return c.json({ code: true, data: null });
  }

  const session = await getSession(c.env.DB, sessionId);
  if (!session) {
    return c.json({ code: true, data: null });
  }

  const user = await getUserById(c.env.DB, session.user_id as number);
  if (!user) {
    return c.json({ code: true, data: null });
  }

  return c.json({
    code: true,
    data: {
      userID: user.id,
      name: user.username,
      nickname: user.nickname,
      email: user.email,
      avatar: user.avatar,
      role: user.role,
      status: user.status,
    },
  });
});

// userInfo
userApi.get("/index/userInfo", authRequired, async (c) => {
  const u = c.get("currentUser");
  return c.json({
    code: true,
    data: {
      userID: u.id,
      name: u.username,
      nickname: u.nickname,
      role: u.role,
      config: JSON.parse(u.config_json || "{}"),
    },
  });
});

// license - returns license status (GET/POST)
userApi.get("/license", async (c) => {
  return c.json({ code: true, data: { valid: true, type: "dev", expired: false, versionType: "B", versionText: "开发版" } });
});
userApi.post("/license", async (c) => {
  return c.json({ code: true, data: { valid: true, type: "dev", expired: false, versionType: "B", versionText: "开发版" } });
});

// call - system call endpoint (seajs uses eval, must return JS)
userApi.get("/view/call", async (c) => {
  return c.body("define({});", 200, { "Content-Type": "application/javascript" });
});

// setup - ensure admin user exists (call once to initialize)
userApi.post("/setup", async (c) => {
  const { username, password } = await c.req.json().catch(() => ({ username: "admin", password: "admin123" }));
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(password));
  const passwordHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await c.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname TEXT DEFAULT '',
      email TEXT DEFAULT '',
      role TEXT DEFAULT 'user',
      config_json TEXT DEFAULT '{}',
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`
  ).run();
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO users (username, password_hash, nickname, role, status) VALUES (?, ?, 'Administrator', 'admin', 1)`
  ).bind(username, passwordHash).run();
  return c.json({ code: true, data: "Admin user ready" });
});

// ============ view ============

// options - CRITICAL: returns all system/user config for SPA bootstrap
// Must exactly match the original PHP format to prevent SPA crashes
userApi.get("/view/options", async (c) => {
  const appHost = getAppHost(c);
  const staticPath = getStaticHost(c);
  const lang = detectLang(c);

  // Build permission roleList (flat key-value object as in original PHP)
  const permList: Record<string, number> = {
    "explorer.add": 1, "explorer.upload": 1, "explorer.view": 1,
    "explorer.download": 1, "explorer.edit": 1, "explorer.remove": 1,
    "explorer.share": 1, "explorer.move": 1, "explorer.server": 0,
    "explorer.recycle": 1, "explorer.fav": 1, "explorer.tag": 1,
    "explorer.comment": 1, "explorer.copy": 1, "explorer.clone": 1,
    "explorer.searchContent": 1, "explorer.fileLog": 1,
    "explorer.fileOutLink": 1, "explorer.fileInLink": 0,
    "explorer.setBackground": 1, "explorer.pathInfo": 1,
    "explorer.unzipList": 1,
    "user.edit": 1, "user.fav": 1, "user.share": 1,
    "admin.setting": 0, "admin.member": 0, "admin.group": 0,
    "admin.role": 0, "admin.auth": 0, "admin.plugin": 0,
    "admin.storage": 0, "admin.share": 0, "admin.loginCheck": 0,
    "admin.log": 0, "admin.task": 0, "admin.backup": 0,
  };

  const userRoleAuth = {
    info: { roleID: "0", roleName: "user" },
    allowAction: {
      "explorer.add": 1, "explorer.upload": 1, "explorer.view": 1,
      "explorer.download": 1, "explorer.edit": 1, "explorer.remove": 1,
      "explorer.share": 1, "explorer.move": 1, "explorer.server": 0,
      "explorer.recycle": 1, "explorer.fav": 1, "explorer.tag": 1,
      "explorer.comment": 1, "explorer.copy": 1, "explorer.clone": 1,
      "explorer.searchContent": 1, "explorer.fileLog": 1,
      "explorer.fileOutLink": 1, "explorer.fileInLink": 0,
      "explorer.setBackground": 1, "explorer.pathInfo": 1,
      "explorer.unzipList": 1,
      "user.edit": 1, "user.fav": 1, "user.share": 1,
      "admin.setting": 0, "admin.member": 0, "admin.group": 0,
      "admin.role": 0, "admin.auth": 0, "admin.plugin": 0,
      "admin.storage": 0, "admin.share": 0, "admin.loginCheck": 0,
      "admin.log": 0, "admin.task": 0, "admin.backup": 0,
    },
    roleList: permList,
  };

  // Check session
  let userObj: any = {
    userID: "",
    myhome: "{source:home}",
    desktop: "{source:home}/桌面/",
    isRoot: 0,
    info: { userID: "", name: "", nickname: "", role: "", sex: 0, email: "", phone: "", avatar: "", sizeMax: 0, sizeUse: 0 },
    role: userRoleAuth,
    config: {
      listType: "icon", listSortField: "name", listSortOrder: "up",
      fileIconSize: "80", fileOpenClick: "dbclick", fileShowDesc: "0",
      fileShowRename: "1", animateOpen: "1", soundOpen: "0",
      theme: "auto", themeImage: "", wall: "4", language: lang,
      listTypeKeep: "1", listSortKeep: "1", menuBarAutoHide: "0",
      pathSafeSpaceShow: "1", themeStyle: "theme-windows",
      fileRepeat: "replace", recycleOpen: "1", kodAppDefault: "",
      fileIconSizeDesktop: "70", fileIconSizePhoto: "120",
      photoConfig: "", imageThumb: "1", fileSelect: "1",
      displayHideFile: "0", filePanel: "1",
      shareToMeShowType: "list", messageSendType: "enter",
      loginDevice: "",
      resizeConfig: JSON.stringify({
        filename: 250, filetype: 80, filesize: 80, filetime: 215,
        editorTreeWidth: 220, explorerTreeWidth: 220,
      }),
    },
    editorConfig: {},
    isRootAllowIO: 0,
    isRootAllowAll: 1,
    targetSpace: { sizeMax: 0, sizeUse: 0 },
    isOpenSafeSpace: false,
  };

  const sessionId = getSessionId(c);
  if (sessionId) {
    const session = await getSession(c.env.DB, sessionId);
    if (session) {
      const isAdmin = session.role === "admin";

      // Build admin permissions if user is admin
      if (isAdmin) {
        Object.keys(permList).forEach(k => { (permList as Record<string, number>)[k] = 1; });
        Object.keys(userRoleAuth.allowAction).forEach(k => { (userRoleAuth.allowAction as Record<string, number>)[k] = 1; });
      }

      userObj = {
        userID: session.user_id,
        myhome: "{source:home}",
        desktop: "{source:home}/桌面/",
        isRoot: isAdmin ? 1 : 0,
        info: {
          userID: session.user_id,
          name: session.username,
          nickname: session.nickname || session.username,
          role: session.role,
          sex: 0, email: "", phone: "", avatar: "",
          sizeMax: 0, sizeUse: 0, status: 1,
        },
        role: userRoleAuth,
        config: {
          listType: "icon", listSortField: "name", listSortOrder: "up",
          fileIconSize: "80", fileOpenClick: "dbclick", fileShowDesc: "0",
          fileShowRename: "1", animateOpen: "1", soundOpen: "0",
          theme: "auto", themeImage: "", wall: "4", language: lang,
          listTypeKeep: "1", listSortKeep: "1", menuBarAutoHide: "0",
          pathSafeSpaceShow: "1", themeStyle: "theme-windows",
          fileRepeat: "replace", recycleOpen: "1", kodAppDefault: "",
          fileIconSizeDesktop: "70", fileIconSizePhoto: "120",
          photoConfig: "", imageThumb: "1", fileSelect: "1",
          displayHideFile: "0", filePanel: "1",
          shareToMeShowType: "list", messageSendType: "enter",
          loginDevice: "",
          resizeConfig: JSON.stringify({
            filename: 250, filetype: 80, filesize: 80, filetime: 215,
            editorTreeWidth: 220, explorerTreeWidth: 220,
          }),
        },
        editorConfig: {},
        isRootAllowIO: isAdmin ? 1 : 0,
        isRootAllowAll: isAdmin ? 1 : 1,
        targetSpace: { sizeMax: 0, sizeUse: 0 },
        isOpenSafeSpace: false,
      };
    }
  }

  const licenseHashes = devLicenseHashes();

  const options = {
    kod: {
      systemOS: "-",
      phpVersion: "-",
      appApi: appHost + "index.php?",
      APP_HOST: appHost,
      APP_HOST_LINK: appHost,
      ENV_DEV: false,
      staticPath: staticPath,
      version: DEV_KOD.version,
      build: DEV_KOD.build,
      channel: DEV_KOD.channel,
      kodID: DEV_KOD.kodID,
      versionType: DEV_KOD.versionType,
      versionHash: licenseHashes.versionHash,
      versionHashUser: licenseHashes.versionHashUser,
    },
    io: {
      KOD_SOURCE: "{source}",
      KOD_IO: "{io}",
      KOD_SHARE_ITEM: "{shareItem}",
      KOD_SHARE_LINK: "{shareItemLink}",
      KOD_SHARE_OUTER: "{shareOuter}",
      KOD_USER_RECYCLE: "{userRecycle}",
      KOD_USER_FAV: "{userFav}",
      KOD_USER_SHARE: "{userShare}",
      KOD_USER_FILE_TAG: "{userFileTag}",
      KOD_USER_FILE_TYPE: "{userFileType}",
      KOD_GROUP_ROOT_SELF: "{groupRootSelf}",
      KOD_USER_DRIVER: "{userDriver}",
      KOD_USER_DRIVER_ITEM: "{userDriverItem}",
      KOD_USER_RECENT: "{userRencent}",
      KOD_USER_SHARE_TO_ME: "{shareToMe}",
      KOD_USER_SHARE_LINK: "{userShareLink}",
      KOD_SEARCH: "{search}",
      KOD_BLOCK: "{block}",
    },
    user: userObj,
    system: {
      version: "",
      build: "",
      name: "MbesBox",
      desc: "——Minelibs资源管理器",
      logo: staticPath + "images/common/logo.png",
      favicon: staticPath + "images/icon/fav.png",
      copyright: "MbesBox",
      powerBy: "MbesBox",
      language: lang,
      theme: "win10",
      wallpaper: "",
      recycleOpen: 1,
      recycleDay: 30,
      chunkSize: 4194304,
      uploadThreads: 3,
      checkChunk: 1,
      soundOpen: 0,
      animateOpen: 1,
      fileSelect: 1,
      imageThumb: 1,
      officePreview: "0",
      paramRewrite: "1",
      pluginServer: "",
      appType: {
        tools: { type: "tools", name: "explorer.app.groupTools", class: "ri-tools-fill" },
        game: { type: "game", name: "explorer.app.groupGame", class: "ri-gamepad-fill" },
        movie: { type: "movie", name: "explorer.app.groupMovie", class: "ri-film-line" },
        music: { type: "music", name: "explorer.app.groupMusic", class: "ri-music-fill-2" },
        life: { type: "life", name: "explorer.app.groupLife", class: "ri-map-pin-fill-2" },
        others: { type: "others", name: "common.others", class: "ri-more-fill" },
      },
      versionHash: "",
      versionHashUser: "",
      settings: {
        upload: {
          chunkSize: 10485760, threads: 10,
          ignoreName: ".DS_Store,Thumb.db", chunkRetry: 2,
          sendAsBinary: 1, httpSendFile: false,
          ignoreExt: "", allowExt: "", downloadSpeed: 0, ignoreFileSize: 0,
        },
        downloadUrlTime: 0, apiLoginToken: "", paramRewrite: false,
        ioAvailed: "local,ftp,oss,qiniu,cos,s3,oos,uss,minio,eos,eds,obs,jos",
        ioFileOutServer: false, ioUploadServer: false,
        fileEditLockTimeout: 1200, fileHistoryMax: 500, fileHistoryLocal: 1,
        uploadFileNumberMax: 0, storeFileNumberMax: 0,
        shareLinkSizeMax: 0, unzipFileSizeMax: 0, zipFileSizeMax: 0,
        groupCompany: 0, shareLinkExpireTime: 0, userLoginLimit: 5,
        pathShowUrlParam: 0, ioReadMax: 31457280,
        staticPath: staticPath,
        kodApiServer: "",
        allowHeaderCookie: "1", searchContent: 1, searchMutil: 1,
        allowSEO: 1, systemBackup: 1, bigFileForce: 0, fileViewLog: 0,
        appType: {
          tools: { type: "tools", name: "explorer.app.groupTools", class: "ri-tools-fill" },
          game: { type: "game", name: "explorer.app.groupGame", class: "ri-gamepad-fill" },
          movie: { type: "movie", name: "explorer.app.groupMovie", class: "ri-film-line" },
          music: { type: "music", name: "explorer.app.groupMusic", class: "ri-music-fill-2" },
          life: { type: "life", name: "explorer.app.groupLife", class: "ri-map-pin-fill-2" },
          others: { type: "others", name: "common.others", class: "ri-more-fill" },
        },
        documentType: {
          doc: { name: "文档", ext: "txt,md,pdf,ofd,doc,docx,xls,xlsx,ppt,pptx,xps,pps,ppsx,ods,odt,odp,docm,dot,dotm,xlsb,xlsm,mht,djvu,wps,dpt,csv,et,ett,pages,numbers,key,dotx,vsd,vsdx,mpp" },
          image: { name: "图片", ext: "jpg,jpeg,png,gif,bmp,ico,svg,webp,tif,tiff,cdr,svgz,xbm,eps,pjepg,heic,raw,psd,ai" },
          music: { name: "音乐", ext: "mp3,wav,wma,m4a,ogg,omf,amr,aa3,flac,aac,cda,aif,aiff,mid,ra,ape" },
          movie: { name: "视频", ext: "mp4,flv,rm,rmvb,avi,mkv,mov,f4v,mpeg,mpg,vob,wmv,ogv,webm,3gp,mts,m2ts,m4v,mpe,3g2,asf,dat,asx,wvx,mpa" },
          zip: { name: "压缩包", ext: "zip,gz,rar,iso,tar,7z,ar,bz,bz2,xz,arj" },
          others: { name: "其他", ext: "" },
        },
        sourceMeta: {
          configItem: { defaultShow: "user_sourceAlias,user_sourceCover", fileAllow: "user_sourceAlias,user_sourceCover,user_sourceNumber,user_sourceParticipant", folderAllow: "user_sourceAlias,user_sourceCover,user_sourceParticipant" },
        },
        userDefaultTag: [
          { name: "explorer.tag.default1", style: "label-blue-normal" },
          { name: "explorer.tag.default2", style: "label-red-normal" },
          { name: "explorer.tag.default3", style: "label-yellow-normal" },
          { name: "common.others", style: "label-green-normal" },
        ],
        ioClassList: {
          local: "Local", ftp: "FTP", oss: "OSS", qiniu: "Qiniu", cos: "COS", s3: "S3",
          oos: "OOS", uss: "USS", minio: "MinIO", eos: "EOS", eds: "EDS", obs: "OBS", jos: "JOS",
          moss: "MOSS", nos: "NOS", baidu: "Baidu", onedrive: "OneDrive",
          base: "Base", bases3: "BaseS3", db: "DB", dbshareitem: "DbShareItem", dbsharelink: "DbShareLink",
          drivershareitem: "DriverShareItem", driversharelink: "DriverShareLink", drivershareouter: "DriverShareOuter",
          stream: "Stream", url: "Url",
        },
      },
      options: {
        systemPassword: "", systemName: "MbesBox", systemDesc: "——Minelibs资源管理器",
        systemNameType: "image",
        systemLogo: staticPath + "images/common/logo.png",
        systemLogoMenu: staticPath + "images/common/logo-kod.png",
        adminTheme: "black",
        pathHidden: "Thumb.db,.DS_Store,.gitignore,.git,*.temp,*.tmp",
        autoLogin: "0", needCheckCode: "0", firstIn: "explorer",
        globalIcp: "", globalCss: "", globalHtml: "",
        newUserApp: "高德地图,icloud",
        newUserFolder: "我的文档,我的图片,我的音乐",
        newGroupFolder: "共享资源,文档,其他",
        groupRootName: "企业网盘",
        versionType: "B", rootListUser: 0, rootListGroup: 0,
        groupAuthOuther: 1, currentVersion: "",
        orderSort: "desc", dateFormat: "Y-m-d",
        fileEncryption: "all",
        passwordErrorLock: "1", passwordLockNumber: "5", passwordLockTime: "60",
        passwordRule: "none", loginCheckAllow: "",
        csrfProtect: "1", downloadZipClient: "1", downloadZipLimit: "0",
        dragDownload: "1", dragDownloadZip: "0", dragDownloadLimit: 20,
        showFileLink: "1", showFileMd5: "1",
        systemRecycleOpen: "0", systemRecycleClear: "180", systemBackup: "1",
        groupTagAllow: "0", groupSpaceLimit: "0", groupSpaceLimitLevel: "5",
        pathSafeSpaceEnable: "1", shareToMeAllowTree: "1",
        shareLinkAllow: "1", shareLinkZip: "1", shareLinkPasswordAllowEmpty: "1",
        shareLinkAllowGuest: "1", shareLinkUserDisableSkip: "1", shareLinkAllowEdit: "1",
        shareOutAllowSend: "1", shareOutAllowRecive: "1",
        shareOutSiteSafe: "", shareOutSiteApiKey: "",
        desktopAppDisable: "",
        treeOpen: "my,myFav,myGroup,rootGroup,recentDoc,fileType,fileTag,driver",
        groupListChild: "1", groupRootListChild: "1",
        wallpageDesktop: "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17",
        wallpageLogin: "2,3,6,8,9,11,12,16,17",
        emailType: "0", email: "",
        sourceSecret: "0", sourceSecretSetUser: "", sourceSecretMaxID: "0",
        sourceSecretList: '[{"id":"","title":"A-绝密","style":"#E64A19","auth":""},{"id":"","title":"B-机密","style":"#FF5722","auth":""},{"id":"","title":"C-秘密","style":"#E57754","auth":""}]',
        loginConfig: { loginWith: [], allowPhone: "1", openRegist: "0" },
        regist: { openRegist: "0", checkRegist: "0", sizeMax: "0", roleID: "", groupInfo: '{"1":""}', allowPhone: "1" },
        allowNickNameRpt: false,
        menu: [
          { name: "desktop", type: "system", url: "desktop", target: "_self", use: "1" },
          { name: "explorer", type: "system", url: "explorer", target: "_self", use: "1" },
          { name: "editor", type: "", url: "editor", target: "_self", use: "0" },
          { name: "官网", url: "", icon: "ri-home-line-3", target: "inline", use: "0" },
        ],
        searchFulltext: 0, searchNumberUseLike: 0,
        searchFulltextForce: 0, searchFulltextInnodb: 0,
      },
      all: {
        hash: licenseHashes.systemHash,
        theme: "mac,win10,win7,metro,metro_green,metro_purple,metro_pink,metro_orange,alpha_image,alpha_image_sun,alpha_image_sky,diy",
        codeTheme: "chrome,clouds,crimson_editor,eclipse,github,kuroir,solarized_light,tomorrow,xcode,gruvbox_light_hard,cloud9_day,ambiance,monokai,idle_fingers,pastel_on_dark,solarized_dark,twilight,tomorrow_night_blue,tomorrow_night_eighties,github_dark,cloud9_night,gruvbox_dark_hard",
        codeFont: "Source Code Pro,Consolas,Courier,DejaVu Sans Mono,Liberation Mono,Menlo,Monaco,Monospace",
        language: {
          "zh-CN": ["简体中文", "简体中文", "Simplified Chinese", "cn"],
          "zh-TW": ["繁體中文", "繁體中文", "Traditional Chinese", "tw"],
          "en": ["English", "英语", "English", "us"],
          "ar": ["العربية", "阿拉伯语", "Arabic", "sa"],
          "ja": ["日本語", "日语", "Japanese", "jp"],
          "ko": ["한국어", "韩语", "Korean", "kr"],
          "fr": ["Français", "法语", "French", "fr"],
          "de": ["Deutsch", "德语", "German", "de"],
          "ru": ["Русский", "俄语", "Russian", "ru"],
          "es": ["Español", "西班牙语", "Spanish", "es"],
          "it": ["Italiano", "意大利语", "Italian", "it"],
          "pt": ["Português", "葡萄牙语", "Portuguese", "pt"],
          "vi": ["Tiếng Việt", "越南语", "Vietnamese", "vn"],
          "th": ["ไทย", "泰语", "Thai", "th"],
          "id": ["Bahasa Indonesia", "印尼语", "Indonesian", "id"],
        },
      },
    },
    lang,
  };

  // Merge persisted system settings onto the hard-coded defaults so edits to
  // systemName/systemDesc/wallpageDesktop/wallpageLogin/... survive a refresh.
  // 001: system.options = settingSystemDefault merged with SystemOption->get().
  const settingsMap = await loadSettingsMap(c.env.DB);
  const sysOptions = (options as any).system.options;
  for (const [k, v] of Object.entries(settingsMap)) {
    if (k.startsWith("common.copyright.")) continue; // language-pack keys, not options
    sysOptions[k] = v;
  }

  // options?full=1 also includes the complete language pack (mirrors 001 user/view/options)
  const full = c.req.query("full") === "1";
  if (full) {
    let list = await loadLangPack(c.env.ASSETS, lang);
    if (!list && lang !== "zh-CN") list = await loadLangPack(c.env.ASSETS, "zh-CN");
    if (!list) list = {};
    overlayCopyright(list, settingsMap);
    (options as any)._lang = { list, lang };
  }

  return c.json({ code: true, data: options });
});

// lang - returns the full i18n language pack (mirrors 001 I18n::getAll)
// The SPA loads this via user/view/lang and merges it into window.LNG
userApi.get("/view/lang", async (c) => {
  const lang = detectLang(c);
  let list = await loadLangPack(c.env.ASSETS, lang);

  // Fall back to zh-CN if the requested language pack is missing
  if (!list && lang !== "zh-CN") {
    list = await loadLangPack(c.env.ASSETS, "zh-CN");
  }
  if (!list) list = {};

  // Overlay saved enterprise/copyright info so window.LNG reflects admin edits.
  const settingsMap = await loadSettingsMap(c.env.DB);
  overlayCopyright(list, settingsMap);

  return c.json({
    code: true,
    data: {
      list,
      lang,
    },
  });
});

// plugins - returns plugin list (seajs uses eval, must return JS)
// Mirrors 001 user.view.class.php plugins(): 'var kodReady=[];' + each plugin's echoJs
userApi.get("/view/plugins", async (c) => {
  const lang = detectLang(c);
  const body = await renderPluginsJs(c.env.ASSETS, {
    appHost: getAppHost(c),
    staticPath: getStaticHost(c),
    lang,
  });
  return c.body(body, 200, { "Content-Type": "application/javascript" });
});

// manifest - PWA manifest
userApi.get("/view/manifest", async (c) => {
  const origin = getAppHost(c).replace(/\/$/, "");
  return c.json({
    name: "MbesBox",
    short_name: "MbesBox",
    description: "——Minelibs资源管理器",
    start_url: origin + "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#1b6de1",
    icons: [
      { src: getStaticHost(c) + "images/icon/icon_192.png", sizes: "192x192", type: "image/png" },
      { src: getStaticHost(c) + "images/icon/icon_512.png", sizes: "512x512", type: "image/png" },
    ],
  });
});

// manifestJS - service worker
userApi.get("/view/manifestJS", async (c) => {
  return c.body("self.addEventListener('install', function(){}); self.addEventListener('fetch', function(){});", 200, {
    "Content-Type": "application/javascript",
  });
});

// ============ account (setting/regist/bind/view) ============
userApi.route("/", accountApi);

export { userApi };
