/**
 * 复刻 001 app/controller/install/index.class.php
 *
 * 001 通过两个文件判定安装状态:
 *   - config/setting_user.php : 数据库/缓存配置已写入
 *   - data/system/install.lock : 安装完成
 *
 * Worker 无本地文件系统, 用 settings 表键值等价表示:
 *   - install_db_conf : 已保存的数据库/缓存配置 (defDbConfig)
 *   - install_lock    : 已安装标记 (install.lock)
 *
 * initCheck() 语义与 001 完全一致:
 *   有 db 配置 + 有 lock => 2 已安装 (所有接口拒绝: admin.install.errorRequest)
 *   有 db 配置 + 无 lock => 1 仅可重置管理员密码
 *   无 db 配置           => 0 完整安装向导 (环境检测 -> 数据库 -> 账号)
 *
 * 注: Worker 的 D1/对象存储由平台预置, 启动时自动建表并写入默认配置,
 * 因此部署完成后 initCheck() 恒为 2, 与 001 已安装站点的行为一致。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { getSetting, setSetting } from "../lib/db";
import { hashPassword } from "../lib/auth";
import { passwordError } from "../lib/user-check";
import { detectLang, loadLangPack } from "../lib/i18n-lang";
import { getAppHost, getStaticHost } from "../lib/user-system";

const installApi = new Hono<{ Bindings: Env }>();

const DB_CONF_KEY = "install_db_conf";
const LOCK_KEY = "install_lock";

/** 001 initCheck(): 0=未安装, 1=待重置管理员, 2=已安装 */
export async function installInitCheck(db: D1Database): Promise<0 | 1 | 2> {
  const conf = await getSetting(db, DB_CONF_KEY).catch(() => null);
  if (!conf) return 0;
  const lock = await getSetting(db, LOCK_KEY).catch(() => null);
  return lock === "1" ? 2 : 1;
}

/** 记录安装配置并标记已安装 (等价 001 setUserSetting + touch install.lock) */
export async function markInstalled(db: D1Database): Promise<void> {
  const conf = await getSetting(db, DB_CONF_KEY).catch(() => null);
  if (!conf) {
    await setSetting(db, DB_CONF_KEY, JSON.stringify({ dbType: "d1", cacheType: "none" })).catch(() => {});
  }
  await setSetting(db, LOCK_KEY, "1").catch(() => {});
}

/** 读取完整语言包并返回翻译函数 (等价 001 LNG) */
async function langOf(c: Context): Promise<(key: string) => string> {
  const lang = detectLang(c);
  let pack: Record<string, string> | null = null;
  try {
    pack = await loadLangPack(c.env.ASSETS, lang);
    if (!pack && lang !== "zh-CN") pack = await loadLangPack(c.env.ASSETS, "zh-CN");
  } catch {
    pack = null;
  }
  return (key: string) => {
    if (!key) return "";
    if (pack && typeof pack[key] === "string") return pack[key];
    return key;
  };
}

/** 001 Input::get: query 优先, 其次 body (JSON / form / multipart) */
async function allParams(c: Context): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) if (v !== undefined) out[k] = String(v);
  const ct = (c.req.header("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) {
      const obj = JSON.parse(await c.req.raw.clone().text());
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) out[k] = v == null ? "" : String(v);
      }
    } else if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const fd = await c.req.raw.clone().formData();
      for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : "";
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** 001 show_json($data, $code, $info) */
function showJson(data: unknown, code = true, info?: number | string) {
  const body: Record<string, unknown> = { code, data };
  if (info !== undefined) body.info = info;
  return Response.json(body);
}

/** 001 show_tips(): 输出 HTML 提示页 (非 JSON) */
function showTips(message: string, title = "出错了! (warning!)", url = "", time = 3): Response {
  const info = url ? `${time}s 后自动跳转, <a href='${url}'>立即跳转</a>` : "";
  const refresh = url ? `<meta http-equiv='refresh' content='${time};url=${url}' charset="utf-8">` : "";
  const html = `<html>
	<head>
	<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, shrink-to-fit=no" />
${refresh}
	<style>
	body{background: #f6f6f6;}
	#msgbox{box-shadow: 0px 10px 40px rgba(0, 0, 0, 0.1);border-radius: 5px;border-radius: 5px;background:#fff;
    font-family: "Lantinghei SC","Hiragino Sans GB","Microsoft Yahei",Helvetica,arial,sans-serif;line-height: 1.5em;
	color:888;margin:10% auto;width:500px;font-size:13px;color:#666;word-wrap: break-word;word-break: break-all;max-width: 90%;box-sizing: border-box;max-height:90%;overflow: auto;padding:30px 30px;position: relative;}
	#msgbox #info{margin-top: 10px;color:#aaa;}
	#msgbox #title{color: #333;border-bottom: 1px solid #eee;padding: 10px 0;margin:0 0 15px;font-size:22px;font-weight:200;}
	#msgbox #info a{color: #64b8fb;text-decoration: none;padding: 2px 0px;border-bottom: 1px solid;}
	#msgbox a{text-decoration:none;color:#2196F3;}
	#msgbox a:hover{color:#f60;border-bottom:1px solid}
	#msgbox .desc{color:#f60;font-weight: 600;padding: 10px 0 10px;}
	#msgbox pre{word-break: break-all;word-wrap: break-word;white-space: pre-wrap;
		background: #002b36;padding:1em;color: #839496;border-left: 6px solid #8e8e8e;border-radius: 3px;}
	</style>
	</head>

	<body>
	<div id="msgbox">
		<div id="title">${title}</div>
		<div id="message">${message}</div>
		<div id="info">${info}</div>
	</div>
	</body>
</html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** 001 envList(): 环境检测项 (title/text 均可为空, 由前端按扩展名补齐) */
function envList(lng: (k: string) => string) {
  return {
    path_writable: { title: lng("admin.install.dirRight"), text: lng("admin.install.pathNeedWirte") },
    php_version: { title: "PHP " + lng("common.version"), text: lng("admin.install.phpVersionTips") },
    allow_url_fopen: { title: "ALLOW_URL_FOPEN " + lng("common.extend"), text: lng("admin.install.mustOpen") },
    php_bit: {
      title: "PHP " + lng("common.sysVersion"),
      text: lng("admin.install.phpBitTips") + '<br/><span class="bit-desc">(' + lng("admin.install.phpBitDesc") + ")</span>",
    },
    iconv: { title: "ICONV " + lng("common.extend"), text: lng("admin.install.suggestOpen") },
    mb_string: { title: "MB_STRING " + lng("common.extend"), text: lng("admin.install.suggestOpen") },
    json: { title: "JSON " + lng("common.extend"), text: lng("admin.install.suggestOpen") },
    curl: { title: "CURL " + lng("common.extend"), text: lng("admin.install.suggestOpen") },
    xml: { title: "XML " + lng("common.extend"), text: lng("admin.install.suggestOpen") },
    shell_exec: { title: "shell_exec、exec " + lng("common.method"), text: lng("admin.install.suggestOpen") },
    gd: { title: "GD " + lng("common.extend"), text: lng("admin.install.suggestOpen") },
    path_list: { title: lng("admin.install.serverDir"), text: lng("admin.install.suggestClose") },
  };
}

/** 001 defDbConfig(true): 读取已保存的数据库配置 */
async function defDbConfig(db: D1Database): Promise<Record<string, string>> {
  const raw = await getSetting(db, DB_CONF_KEY).catch(() => null);
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

// ---------- 安装向导弹出页 (001 installIndex::check 的页面部分) ----------

export async function renderInstallPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const lng = await langOf(c);
  const appHost = getAppHost(c);
  const staticPath = getStaticHost(c);
  const installPath = appHost + "app/controller/install/static/";

  // 001: installFast = setting_user.php 是否存在 (对应 db 配置已写入)
  const dbConf = await defDbConfig(c.env.DB);
  const installFast = Object.keys(dbConf).length > 0 ? 1 : 0;
  let installAuto = "";
  if (installFast) {
    const row = await c.env.DB.prepare("SELECT username FROM users WHERE id = 1").first<{ username: string }>().catch(() => null);
    if (row?.username) installAuto = row.username;
  }
  const hide = installFast ? "hidden" : "";

  let envItems = "";
  for (const [key, opt] of Object.entries(envList(lng))) {
    envItems += `<p class="${key}"><span class="w30 row-title">${opt.title}</span><span class="w20 row-value"></span><span class="w40 row-desc">${opt.text}</span><span class="w10 row-state"><i class="icon icon-loading"></i></span><span class="clear"></span></p>`;
  }

  const jumpHtml = `${lng("explorer.jumpAfterWhile").replace("%s", '<em class="delay">5</em>')}`.replace("<a href='%s'>", "<a href='./'>");

  return c.html(`<!DOCTYPE html>
<html>
<head>
	<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
	<link head-type='kod' href="${staticPath}images/icon/fav.png" rel="icon" type="image/x-icon">
	<title>${lng("common.copyright.name")}-${lng("common.install")}</title>
	<link href="${staticPath}style/lib/main.css" rel='stylesheet'>
	<link href="${staticPath}style/dist/main.css" rel='stylesheet'>
	<link href="${installPath}static/index.css" rel='stylesheet'>
</head>

<body>
	<div id="app">
		<div class="install-box">
			<div class="content-main-message">
				<div class="header">
					<div><img src="${installPath}static/logo.png"></div>
					<div class="lang-box">
					    <div class="menu-group language-list hidden">
                			<div data-toggle="dropdown" class="topbar-menu language-menu">
                				<i class='font-icon ri-flag-fill'></i>Language<b class="caret"></b>
                			</div>
                			<ul class="dropdown-menu animated menuShow" role="menu"></ul>
                		</div>
					</div>
				</div>
				<div class="body">
					<div class="content-main">
						<div class="install-fast hidden" fast="${installFast}" auto="${installAuto}"></div>
						<div class="check-result">
							<div class="title-box">${installFast ? lng("admin.setting.system") : lng("admin.install.install")}</div>
							<div class="progress-box">
								<div class="active ${hide}" data="env"><span>${lng("common.env.check")}</span><span class="btm-line"></span></div>
								<div class="${hide}" data="db"><span>${lng("admin.install.databaseSet")}</span><span class="btm-line"></span></div>
								<div class="${installFast ? "active" : ""}" data="user">
									<span>${lng("admin.setting.account")}</span>
									<span class="btm-line"></span>
								</div>
							</div>
							<div class="step-box env ${hide}">
								<div class="message-content form-box">
									<div class="env-table">
										<div class="env-item-list">${envItems}</div>
										<div class="form-row panel-form-body clear"><hr></div>
										<div class="form-row form-target-save hidden">
											<div class="setting-title"></div>
											<div class="setting-content">
												<button class="form-save-button">${lng("common.ok")}</button>
												<a class="help hidden" target="_blank" href="http://doc.kodcloud.com/v2/#/help/install">${lng("explorer.editor.help")}</a>
											</div>
										</div>
									</div>
								</div>
							</div>
							<div class="step-box db hidden">
								<div class="message-content">
									<p class="info-alert info-alert-yellow hidden">${lng("admin.install.dbWasSet")}</p>
									<div class="db-table"></div>
								</div>
							</div>
							<div class="step-box user ${installFast ? "" : "hidden"}" style="min-height:274px">
								<div class="message-content">
									<div class="user-table"></div>
								</div>
							</div>
							<div class="step-box msg hidden">
								<i class="font-icon success"></i>
								<div class="message-content">
									<div class='title'>${lng("admin.install.success")}</div>
									<div class='desc'></div>
								</div>
							</div>
						</div>
						<div class="link hidden">${jumpHtml}</div>
					</div>
				</div>
			</div>
			<div class="common-footer aero"></div>
		</div>
	</div>

	<script type="text/javascript">
		window.API_HOST = "${appHost}index.php?";
		window.STATIC_PATH = "${staticPath}";
	</script>
	<script src="${staticPath}app/vender/es3-profill.js"></script>
	<script src="${staticPath}app/dist/vendor.js"></script>
	<script src="${staticPath}app/dist/api.js"></script>
	<script src="${installPath}index.js"></script>
</body>
</html>`);
}

// 001 installIndex::authCheck: 仅 env/save/auto 三个 ACT 可访问, 其余一律 illegalRequest。
// 安装页面本身由 user.index.init 内部 ActionCall('install.index.check') 输出,
// 不存在可通过 HTTP 直接访问安装页的路由 (Worker 对应 pages.ts serveIndex)。
installApi.all("/index", async (c) => showJson((await langOf(c))("common.illegalRequest"), false));
installApi.all("/index/check", async (c) => showJson((await langOf(c))("common.illegalRequest"), false));

// ---------- install/index/env : 环境检测 ----------

installApi.all("/index/env", async (c) => {
  const lng = await langOf(c);
  const check = await installInitCheck(c.env.DB);
  if (check === 2) return showJson(lng("admin.install.errorRequest"), false);

  const params = await allParams(c);
  if (String(params.db || "") === "1") return showJson(await defDbConfig(c.env.DB));

  // Worker 运行时无 PHP, 环境项按平台等价能力返回:
  // 目录/URL/扩展在 Workers 上由平台提供, php_version/php_bit 仅作信息展示。
  const env = {
    path_writable: true,
    php_version: "8.1.0",
    allow_url_fopen: true,
    php_bit: 64,
    iconv: true,
    mb_string: true,
    json: true,
    curl: true,
    xml: true,
    shell_exec: false,
    gd: true,
    path_list: true,
  };
  return showJson(env);
});

// ---------- install/index/save : 数据库配置 / 账号设置 ----------

installApi.all("/index/save", async (c) => {
  const lng = await langOf(c);
  const check = await installInitCheck(c.env.DB);
  if (check === 2) return showJson(lng("admin.install.errorRequest"), false);

  const params = await allParams(c);
  const action = String(params.action || "");

  if (action === "db") {
    const conf: Record<string, string> = {};
    for (const key of [
      "dbType",
      "cacheType",
      "dbHost",
      "dbUser",
      "dbName",
      "dbEngine",
      "pdoType",
      "pdoDbHost",
      "pdoDbUser",
      "pdoDbName",
      "pdoDbEngine",
      "redisHost",
      "redisPort",
      "redisAuth",
      "memcachedHost",
      "memcachedPort",
    ]) {
      if (params[key] !== undefined) conf[key] = String(params[key]);
    }
    if (Object.keys(conf).length === 0) {
      return showJson(lng("explorer.error") + lng("admin.install.setPathWrt"), false);
    }
    // 001: 数据库中已有数据表且未传 del=1 时返回 info=10001 由前端确认
    const hasTables = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV') LIMIT 1"
    )
      .first<{ name: string }>()
      .catch(() => null);
    if (hasTables && String(params.del || "") !== "1") {
      return showJson(lng("admin.install.ifDelDb"), false, 10001);
    }
    await setSetting(c.env.DB, DB_CONF_KEY, JSON.stringify(conf));
    return showJson(lng("explorer.success"));
  }

  // action=user: 首次安装初始化系统, 或已配置数据库时重置管理员密码
  const name = String(params.name || "").trim();
  const password = String(params.password || "");
  if (!name || !password) return showJson(lng("common.invalidParam"), false);

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE id = 1").first<{ id: number }>().catch(() => null);
  if (existing) {
    // 001: Model('User')->find(1) 存在时校验密码强度并更新, 成功后写 install.lock
    const err = await passwordError(c.env.DB, password, detectLang(c));
    if (err) return showJson(err, false);
    await c.env.DB.prepare("UPDATE users SET username = ?, password_hash = ?, updated_at = datetime('now') WHERE id = 1")
      .bind(name, await hashPassword(password))
      .run();
    await markInstalled(c.env.DB);
    return showJson(lng("admin.install.updateSuccess"), true, 1);
  }

  const err = await passwordError(c.env.DB, password, detectLang(c));
  if (err) return showJson(err, false);

  // 001 sysInit + addUser: 建管理员账号并加入根部门(1), 角色 Administrator(1)
  await c.env.DB.prepare(
    `INSERT INTO users (username, password_hash, nickname, role, roleID, status)
     VALUES (?, ?, ?, 'admin', 1, 1)`
  )
    .bind(name, await hashPassword(password), lng("admin.role.administrator"))
    .run();
  const row = await c.env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(name).first<{ id: number }>();
  if (row?.id) {
    await c.env.DB.prepare("INSERT OR IGNORE INTO user_groups (user_id, group_id, authID, sort) VALUES (?, 1, 1, 0)")
      .bind(row.id)
      .run();
  }
  await markInstalled(c.env.DB);
  return showJson(lng("admin.install.createSuccess"));
});

// ---------- install/index/auto : CLI 一键安装 ----------

// 001 cliInstall(): 仅 CLI 环境执行, Web 请求直接返回 (无输出)。
installApi.all("/index/auto", async () => new Response("", { status: 200 }));

export { installApi };
