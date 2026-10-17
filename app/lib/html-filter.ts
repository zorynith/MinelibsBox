/**
 * HTML 净化 - 复刻 001 app/sdks/Html.class.php (HTMLPurifier 配置) 与 clear_html。
 *
 * 001 filter/html.class.php 的自动绑定:
 *   admin.notice.add  => content: Html::clean
 *   admin.notice.edit => content: Html::clean
 *   comment.index.add => content: Html::onlyImage, title: clear_html
 *
 * 这里用 Cloudflare Workers 原生 HTMLRewriter 实现等价的白名单净化:
 *  - Html::clean: 允许 001 HTML.Allowed 中的标签与属性, 移除 script/style 等;
 *  - Html::onlyImage: 仅保留 img[src|alt];
 *  - clear_html: 转义 < > " ' 四个字符。
 */

const GLOBAL_ATTRS = [
  "id",
  "style",
  "class",
  "title",
  "border",
  "width",
  "height",
  "alt",
  "type",
  "data-exp",
  "rowspan",
  "colspan",
];

const TAG_ATTRS: Record<string, string[]> = {
  a: ["href", "target"],
  img: ["src"],
  ol: ["start"],
  iframe: ["frameborder", "src", "allowfullscreen", "scrolling"],
  video: ["src", "controls", "poster"],
  source: ["src"],
};

// 001 HTML.Allowed 中保留的标签
const ALLOWED_TAGS = new Set([
  "div", "b", "strong", "i", "em", "a", "ul", "ol", "li", "p", "br", "span",
  "img", "pre", "hr", "code", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
  "del", "table", "thead", "tbody", "tr", "th", "td", "s", "sub", "sup", "ins",
  "address", "iframe", "var", "mark", "wbr", "section", "nav", "article",
  "aside", "header", "footer", "hgroup", "figure", "figcaption", "video", "source",
]);

// 不允许且需连同内容一起移除的标签 (script/style 及结构/嵌入类元素)
const DROP_CONTENT_TAGS = new Set([
  "script", "style", "title", "base", "meta", "link", "head", "html", "body",
  "frameset", "frame", "noframes", "noscript", "template", "param", "object",
  "embed", "applet",
]);

// HTMLPurifier 默认允许的 URI scheme
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "ftp", "nntp", "news", "tel", "urn"]);

const URI_ATTRS = new Set(["href", "src", "poster"]);

function isSafeUri(value: string): boolean {
  const cleaned = (value || "").replace(/[\u0000-\u0020]+/g, "");
  if (!cleaned) return true;
  const match = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!match) return true; // 相对路径 / 锚点
  return SAFE_SCHEMES.has(match[1].toLowerCase());
}

function isSafeStyle(value: string): boolean {
  const s = (value || "").toLowerCase();
  return !(
    s.includes("expression(") ||
    s.includes("javascript:") ||
    s.includes("vbscript:") ||
    s.includes("<")
  );
}

function sanitizeAttributes(el: Element, allowed: Set<string>) {
  const toRemove: string[] = [];
  // 运行时为 Workers HTMLRewriter 的 [name, value] 数组; DOM 类型声明会与 Workers 类型合并, 此处显式断言。
  const attrs = el.attributes as unknown as Iterable<[string, string]>;
  for (const attr of attrs) {
    const name = (attr[0] || "").toLowerCase();
    const value = attr[1] ?? "";
    if (!allowed.has(name)) {
      toRemove.push(name);
      continue;
    }
    if (URI_ATTRS.has(name) && !isSafeUri(value)) {
      toRemove.push(name);
      continue;
    }
    if (name === "style" && !isSafeStyle(value)) {
      toRemove.push(name);
    }
  }
  for (const name of toRemove) el.removeAttribute(name);
}

async function purify(html: string, mode: "clean" | "image"): Promise<string> {
  const imageAttrs = new Set(["src", "alt"]);
  const globalAttrs = new Set(GLOBAL_ATTRS);

  const rewriter = new HTMLRewriter().on("*", {
    element(el: Element) {
      const tag = (el.tagName || "").toLowerCase();

      if (mode === "image") {
        if (tag !== "img") {
          if (DROP_CONTENT_TAGS.has(tag)) el.remove();
          else el.removeAndKeepContent();
          return;
        }
        sanitizeAttributes(el, imageAttrs);
        return;
      }

      if (!ALLOWED_TAGS.has(tag)) {
        if (DROP_CONTENT_TAGS.has(tag)) el.remove();
        else el.removeAndKeepContent();
        return;
      }

      const allowed = new Set(globalAttrs);
      const extra = TAG_ATTRS[tag];
      if (extra) for (const a of extra) allowed.add(a);
      sanitizeAttributes(el, allowed);
    },
  });

  const transformed = rewriter.transform(
    new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
  );
  return await transformed.text();
}

/** 复刻 001 Html::clean (HTMLPurifier 白名单净化)。 */
export async function htmlClean(html: string | null | undefined): Promise<string> {
  // 001: $data = $data ? str_replace("\\","\\\\",$data):'';
  const data = html ? String(html).replace(/\\/g, "\\\\") : "";
  if (!data) return "";
  return await purify(data, "clean");
}

/** 复刻 001 Html::onlyImage (仅保留 img[src|alt])。 */
export async function htmlOnlyImage(html: string | null | undefined): Promise<string> {
  const data = html ? String(html) : "";
  if (!data) return "";
  return await purify(data, "image");
}

/** 复刻 001 clear_html: 转义 < > " '。 */
export function clearHtml(html: string | null | undefined): string {
  const data = html === null || html === undefined ? "" : String(html);
  return data
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
