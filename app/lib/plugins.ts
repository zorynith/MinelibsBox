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

const ENABLED_PLUGINS = ["DPlayer", "jPlayer", "photoSwipe", "picasa", "htmlEditor", "officeViewer", "pdfjs", "simpleClock", "toolsCommon", "webodf"];

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

/** Render the /api/user/view/plugins output body. */
export async function renderPluginsJs(assets: Fetcher, ctx: PluginContext): Promise<string> {
  let body = "var kodReady=[];";
  for (const name of ENABLED_PLUGINS) {
    const [pkg, langArr, tpl] = await Promise.all([
      loadPluginPackage(assets, name),
      loadPluginLang(assets, name, ctx.lang),
      loadPluginMainJs(assets, name),
    ]);
    if (!pkg || tpl == null) continue;
    const config = defaultPluginConfig(pkg);
    body += "\n" + renderPluginJs(tpl, pkg, config, langArr, ctx);
  }
  return body;
}
