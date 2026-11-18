/**
 * I18n language pack loader for the Cloudflare Worker.
 * Reads full language packs from static assets (converted from 001 config/i18n/*.php).
 */

const SUPPORTED_LANGS = [
  "ar", "bn", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko",
  "pl", "pt", "ru", "ta", "th", "tr", "uk", "vi", "zh-CN", "zh-TW",
];

const DEFAULT_LANG = "zh-CN";

/** Normalize language code, returns the lang dir name or empty if unsupported. */
export function normalizeLang(raw: string | null | undefined): string {
  if (!raw) return "";
  const lang = raw.trim();
  if (SUPPORTED_LANGS.includes(lang)) return lang;
  // aliases
  const map: Record<string, string> = {
    zh: "zh-CN",
    "zh-cn": "zh-CN",
    "zh_CN": "zh-CN",
    "zh_cn": "zh-CN",
    "zh-tw": "zh-TW",
    "zh_tw": "zh-TW",
    "zh_TW": "zh-TW",
    "zh-Hans": "zh-CN",
    "zh-Hant": "zh-TW",
    "en-us": "en",
    "en_us": "en",
    "en-gb": "en",
    "en_ca": "en",
  };
  if (map[lang]) return map[lang];
  // strip region for base language detection
  const base = lang.split("-")[0].toLowerCase();
  if (SUPPORTED_LANGS.includes(base)) return base;
  return "";
}

/**
 * Determine the language to use, mirroring 001 I18n::init logic:
 *  1. `in.language` (query param)
 *  2. cookie `kodUserLanguage`
 *  3. HTTP Accept-Language header
 *  4. default zh-CN
 */
export function detectLang(c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }, configLang?: string): string {
  const inLang = c.req.query("language");
  if (inLang) {
    const n = normalizeLang(inLang);
    if (n) return n;
  }

  // filter/userCheck::setAppLang - iOS APP 自带 Language:xx; 在 cookie 之前生效
  const ua = c.req.header("user-agent") || "";
  if (ua.includes("kodCloud-System:iOS")) {
    const m = ua.match(/Language:(.*);/);
    if (m) {
      const n = normalizeLang(m[1]);
      if (n) return n;
    }
  }

  const cookieHeader = c.req.header("cookie") || "";
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)kodUserLanguage=([^;]+)/);
  if (cookieMatch) {
    const n = normalizeLang(cookieMatch[1]);
    if (n) return n;
  }

  if (configLang) {
    const n = normalizeLang(configLang);
    if (n) return n;
  }

  const accept = c.req.header("accept-language") || "";
  const acceptNormalized = accept.toLowerCase().replace(/_/g, "-");
  const m = acceptNormalized.match(/([a-z]{2}(?:-[a-z]{2})?)/g);
  if (m) {
    for (const raw of m) {
      const n = normalizeLang(raw);
      if (n) return n;
    }
  }

  return DEFAULT_LANG;
}

async function readLangFile(assets: Fetcher, lang: string): Promise<Record<string, string> | null> {
  try {
    const req = new Request(`https://assets.local/config/i18n/${lang}/index.json`);
    const res = await assets.fetch(req);
    if (!res.ok) return null;
    const data = await res.json<Record<string, string>>();
    return data || null;
  } catch {
    return null;
  }
}

/** 已加载语言包缓存(60s): view/lang 等接口每次请求都要读语言包, 避免重复 ASSETS fetch。 */
const langPackCache = new Map<string, { at: number; pack: Record<string, string> | null }>();
const LANG_PACK_TTL = 60_000;

/**
 * Load the full language pack JSON from static assets. Returns null on failure.
 *
 * 部分语言包缺少后加的文案 key(如 ar/ja 缺 explorer.pathDesc.*, bn/de/hi/th 等缺
 * admin.member.import*), 直接下发会让前端显示原始 key; 这里用 en 包补齐缺失项,
 * 已有译文保持不变。返回对象为共享缓存, 调用方只读。
 */
export async function loadLangPack(assets: Fetcher, lang: string): Promise<Record<string, string> | null> {
  const cached = langPackCache.get(lang);
  if (cached && Date.now() - cached.at < LANG_PACK_TTL) return cached.pack;
  const pack = await readLangFile(assets, lang);
  if (pack && lang !== "en") {
    const en = await readLangFile(assets, "en");
    if (en) {
      for (const [k, v] of Object.entries(en)) {
        if (!(k in pack)) pack[k] = v;
      }
    }
  }
  langPackCache.set(lang, { at: Date.now(), pack });
  return pack;
}
