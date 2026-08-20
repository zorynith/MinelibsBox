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

/** Load the full language pack JSON from static assets. Returns null on failure. */
export async function loadLangPack(assets: Fetcher, lang: string): Promise<Record<string, string> | null> {
  try {
    const req = new Request(`https://assets.local/config/i18n/${lang}/index.json`);
    const res = await assets.fetch(req);
    if (!res.ok) return null;
    const data = await res.json<Record<string, string>>();
    return data;
  } catch {
    return null;
  }
}
