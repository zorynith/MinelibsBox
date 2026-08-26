/**
 * Plugin infrastructure - mirrors 001 PluginBase echoFile template replacement.
 *
 * 001 flow (user.view.class.php plugins()):
 *   echo 'var kodReady=[];' -> Hook::trigger('user.commonJs.insert')
 *   -> each plugin app.php registers 'user.commonJs.insert' => 'xxxPlugin.echoJs'
 *   -> PluginBase::echoJs() renders static/main.js through echoFile():
 *      parseFile -> parseLang -> parseConfig -> parsePackage
 */
import { parseLooseJson } from "./loose-json";
import { getPluginMeta } from "./db";

export interface PluginPackage {
  id: string;
  name: string;
  title: string;
  version: string;
  description?: string;
  source?: Record<string, any>;
  configItem?: Record<string, any>;
  [key: string]: any;
}

export interface PluginContext {
  appHost: string; // trailing slash, e.g. "https://mbos.minelibs.eu.org/"
  staticPath: string; // e.g. "https://mbos.minelibs.eu.org/static/"
  lang: string; // detected lang, e.g. "zh-CN"
}

/** All plugins shipped with the worker (served from ASSETS static/plugins). */
export const ALL_PLUGINS = ["DPlayer", "jPlayer", "photoSwipe", "picasa", "htmlEditor", "officeViewer", "pdfjs", "simpleClock", "toolsCommon", "webodf", "OnlyOffice", "CADViewer", "drawio", "Photopea", "bisheng", "PDFTron"];

// {{{ helpers mirroring 001 array_get_value/_get }}}
function arrayGet(obj: any, key: string): any {
  if (!key) return undefined;
  const segs = key.split(".");
  let cur = obj;
  for (const s of segs) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[s];
  }
  return cur;
}

function isPlainObj(v: any): boolean {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Encode for JS context (mirrors 001 parseLang str_replace escaping). */
function jsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "");
}

/**
 * Mirrors 001 PluginBase::parseLang: replaces {{LNG['key']}} with LNG(key) value.
 * Note: {{LNG}} (whole pack) is handled in parseFile, NOT here.
 */
function parseLang(tpl: string, langArr: Record<string, string>): string {
  const re = /\{\{LNG\['([^']+)'\]\}\}/g;
  return tpl.replace(re, (m, key: string) => {
    const v = langArr[key] ?? m;
    return jsEscape(v);
  });
}

/** Mirrors 001 PluginBase::parseConfig: {{config.xxx}} -> _get(config, 'xxx'). */
function parseConfig(tpl: string, config: Record<string, any>): string {
  const re = /\{\{config\.([^}]+)\}\}/g;
  return tpl.replace(re, (m, key: string) => {
    const v = arrayGet(config, key);
    if (v == null) return m;
    if (isPlainObj(v) || Array.isArray(v)) return JSON.stringify(v);
    return String(v);
  });
}

/** Mirrors 001 PluginBase::parsePackage: {{package.xxx}} -> _get(appPackage, 'xxx'). */
function parsePackage(tpl: string, pkg: PluginPackage): string {
  const re = /\{\{package\.([^}]+)\}\}/g;
  return tpl.replace(re, (m, key: string) => {
    const v = arrayGet(pkg, key);
    if (v == null) return m;
    if (isPlainObj(v) || Array.isArray(v)) return JSON.stringify(v);
    return String(v);
  });
}

/**
 * Resolve plugin config defaults from package.json configItem.
 * 001 stores per-plugin config in DB (System.pluginList optionType); here we
 * fall back to configItem default values (no user-customized UI this round).
 */
export function defaultPluginConfig(pkg: PluginPackage): Record<string, any> {
  const config: Record<string, any> = {};
  const items = pkg.configItem || {};
  for (const [k, v] of Object.entries(items)) {
    if (isPlainObj(v) && "value" in (v as any)) {
      config[k] = (v as any).value;
    } else if (isPlainObj(v) || Array.isArray(v)) {
      config[k] = v;
    } else {
      config[k] = v;
    }
  }
  return config;
}

/**
 * Load plugin package.json from ASSETS. Returns null on failure.
 * URL is /plugins/{name}/package.json because ASSETS serves ./static at root.
 */
export async function loadPluginPackage(assets: Fetcher, name: string): Promise<PluginPackage | null> {
  try {
    const res = await assets.fetch(new Request(`https://assets.local/plugins/${name}/package.json`));
    if (!res.ok) return null;
    const raw = await res.text();
    return parseLooseJson(raw) as PluginPackage;
  } catch {
    return null;
  }
}

/** Load plugin language pack for a given lang. Returns {} on failure. */
export async function loadPluginLang(assets: Fetcher, name: string, lang: string): Promise<Record<string, string>> {
  try {
    const res = await assets.fetch(new Request(`https://assets.local/plugins/i18n/${name}.${lang}.json`));
    if (!res.ok) return {};
    return (await res.json<Record<string, string>>()) || {};
  } catch {
    return {};
  }
}

/** Load plugin static/main.js template. Returns null on failure. */
export async function loadPluginMainJs(assets: Fetcher, name: string): Promise<string | null> {
  try {
    const res = await assets.fetch(new Request(`https://assets.local/plugins/${name}/static/main.js`));
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Render a plugin's echoJs output, mirroring 001 PluginBase::echoJs().
 *
 * Replacement order (001 echoFile):
 *   1. parseFile: {{pluginHost}}/{{pluginHostDefault}}/{{pluginApi}}/{{pluginName}}/
 *      {{pluginPath}}/{{APP_HOST}}/{{staticPath}} + {{LNG}} + {{config}} whole-pack
 *   2. parseLang:  {{LNG['key']}}
 *   3. parseConfig: {{config.key}}
 *   4. parsePackage: {{package.key}}
 */
export function renderPluginJs(
  tpl: string,
  pkg: PluginPackage,
  config: Record<string, any>,
  langArr: Record<string, string>,
  ctx: PluginContext
): string {
  const name = pkg.id || pkg.name;
  const pluginHost = `${ctx.staticPath}plugins/${name}/`;

  // parseFile base replacements
  let out = tpl;
  const basePairs: Array<[string, string]> = [
    ["{{pluginHost}}", pluginHost],
    ["{{pluginHostDefault}}", pluginHost],
    ["{{pluginApi}}", `${ctx.appHost}index.php?plugin/${name}/`],
    ["{{pluginName}}", name],
    ["{{pluginPath}}", `plugins/${name}/`],
    ["{{APP_HOST}}", ctx.appHost],
    ["{{staticPath}}", ctx.staticPath],
  ];
  for (const [k, v] of basePairs) {
    out = out.split(k).join(v);
  }

  // {{LNG}} whole pack -> urlencoded JSON (photoSwipe LNG.set(jsonDecode(urlDecode(...))))
  if (out.includes("{{LNG}}")) {
    out = out.split("{{LNG}}").join(encodeURIComponent(JSON.stringify(langArr)));
  }

  // {{config}} whole pack -> urlencoded JSON
  if (out.includes("{{config}}")) {
    out = out.split("{{config}}").join(encodeURIComponent(JSON.stringify(config)));
  }

  out = parseLang(out, langArr);
  out = parseConfig(out, config);
  out = parsePackage(out, resolvePkgLng(pkg, langArr));
  return out;
}

/** 001 appPackage() runs parseLang on package.json before decode; mirror here. */
function resolvePkgLng(pkg: PluginPackage, langArr: Record<string, string>): PluginPackage {
  const copy: any = Array.isArray(pkg) ? [] : {};
  for (const [k, v] of Object.entries(pkg)) {
    if (typeof v === "string") {
      copy[k] = parseLang(v, langArr);
    } else if (isPlainObj(v) || Array.isArray(v)) {
      copy[k] = resolvePkgLng(v as any, langArr);
    } else {
      copy[k] = v;
    }
  }
  return copy;
}

/** Same as resolvePkgLng but without JS-string escaping (for JSON payloads). */
function parseLangRaw(tpl: string, langArr: Record<string, string>): string {
  const re = /\{\{LNG\['([^']+)'\]\}\}/g;
  return tpl.replace(re, (m, key: string) => langArr[key] ?? m);
}

/** Deep-resolve {{LNG['key']}} placeholders in any JSON payload (no JS escaping). */
export function resolveLngRaw(obj: any, langArr: Record<string, string>): any {
  if (typeof obj === "string") return parseLangRaw(obj, langArr);
  if (Array.isArray(obj)) return obj.map((x) => resolveLngRaw(x, langArr));
  if (obj && typeof obj === "object") {
    const copy: any = {};
    for (const [k, v] of Object.entries(obj)) copy[k] = resolveLngRaw(v, langArr);
    return copy;
  }
  return obj;
}

function resolvePkgLngRaw(pkg: PluginPackage, langArr: Record<string, string>): PluginPackage {
  const copy: any = Array.isArray(pkg) ? [] : {};
  for (const [k, v] of Object.entries(pkg)) {
    if (typeof v === "string") {
      copy[k] = parseLangRaw(v, langArr);
    } else if (isPlainObj(v) || Array.isArray(v)) {
      copy[k] = resolvePkgLngRaw(v as any, langArr);
    } else {
      copy[k] = v;
    }
  }
  return copy;
}

/**
 * Build the admin plugin app list payload: { id: pluginObj }.
 * Mirrors 001 Model('Plugin')->viewList() + admin plugin appList().
 * status: 1 enabled / 0 disabled (persisted in DB, default enabled).
 */
export async function buildPluginAppList(assets: Fetcher, db: D1Database, lang: string, staticPath = "/"): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const name of ALL_PLUGINS) {
    const pkg = await loadPluginPackage(assets, name);
    if (!pkg) continue;
    const langArr = await loadPluginLang(assets, name, lang);
    const resolved = resolvePkgLngRaw(pkg, langArr);
    const meta = await getPluginMeta(db, name);
    // {{pluginHost}}/{{staticPath}} -> 可访问静态路径 (001 admin appList 返回已替换的 icon/screenshoot 路径, 前端直接作 img src)
    const pluginHost = `${staticPath}plugins/${name}/`;
    const src = resolved.source as Record<string, any>;
    if (src && typeof src === "object") {
      const replacePath = (x: string) =>
        x.split("{{pluginHost}}").join(pluginHost).split("{{staticPath}}").join(staticPath);
      for (const k of Object.keys(src)) {
        const v = src[k];
        if (Array.isArray(v)) {
          src[k] = v.map((x) => (typeof x === "string" ? replacePath(x) : x));
        } else if (typeof v === "string") {
          src[k] = replacePath(v);
        }
      }
    }
    out[name] = { ...resolved, status: meta.status };
  }
  return out;
}

/** Load a single plugin package with {{LNG}} keys resolved for JSON payloads. */
export async function resolvePluginPackage(assets: Fetcher, name: string, lang: string): Promise<PluginPackage | null> {
  const pkg = await loadPluginPackage(assets, name);
  if (!pkg) return null;
  const langArr = await loadPluginLang(assets, name, lang);
  return resolvePkgLngRaw(pkg, langArr);
}

/**
 * 规范化文件扩展名配置值: 去除前导点号/空白, 转小写, 去重。
 * 001 默认 configItem.fileExt 为无点小写(如 "pdf,ai"); 管理端 tags 控件
 * 保存时可能回写 ".pdf,.PDF" 带点格式, 导致前端 kodApp 以 ext 为 key
 * 的 openDefault 匹配不到文件扩展名, 打开方式全部失效。
 */
function normalizeExtStr(s: string): string {
  const parts = s
    .split(/[,\s，;]+/)
    .filter(Boolean)
    .map((x) => x.trim().replace(/^\.+/, "").toLowerCase())
    .filter((x, i, a) => a.indexOf(x) === i);
  return parts.join(",");
}

export function normalizePluginConfig(config: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(config)) {
    if (Array.isArray(v)) {
      out[k] = v.map((x) => (typeof x === "string" && /^\./.test(x.trim()) ? x.trim().replace(/^\.+/, "").toLowerCase() : x));
    } else if (typeof v === "string" && /^\./.test(v.trim())) {
      // 仅对以点开头的字符串做扩展名规范化(文件类型相关字段)
      out[k] = normalizeExtStr(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Render the /api/user/view/plugins output body. Only enabled (DB status=1) plugins load.
 */
export async function renderPluginsJs(assets: Fetcher, ctx: PluginContext, db?: D1Database): Promise<string> {
  let body = "var kodReady=[];";
  for (const name of ALL_PLUGINS) {
    let meta: { status: number; config: Record<string, any> } | null = null;
    if (db) {
      meta = await getPluginMeta(db, name);
      if (meta.status !== 1) continue;
    }
    const [pkg, langArr, tpl] = await Promise.all([
      loadPluginPackage(assets, name),
      loadPluginLang(assets, name, ctx.lang),
      loadPluginMainJs(assets, name),
    ]);
    if (!pkg || tpl == null) continue;
    // DB 持久化 config 覆盖默认 configItem 值: 防止 DB config 缺字段时
    // main.js 模板里的 {{config.fileExt}} 等残留为字面量, 导致插件注册的
    // 文件打开方式 ext 全部失效(图片/视频/Office 等 app 匹配不到文件)
    const config = { ...defaultPluginConfig(pkg), ...(meta ? meta.config : {}) };
    body += "\n" + renderPluginJs(tpl, pkg, normalizePluginConfig(config), langArr, ctx);
  }
  return body;
}
