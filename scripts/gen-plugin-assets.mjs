// 生成插件资源聚合包 static/plugins/__assets__.json。
//
// 背景: Cloudflare Workers 单次调用有子请求数量上限(免费版约 50)。
// 原实现每个插件需 3 次 ASSETS fetch(package.json / static/main.js /
// i18n/<name>.<lang>.json), 18 个插件即 54 次, 超出上限后末尾插件
// (officeLive / yzOffice) 的 fetch 会静默失败并被跳过。这里在构建期把
// 全部插件资源合并为一个 JSON, 运行时只需 1 次 fetch。
//
// 由 package.json 的 build 脚本在 vite build 之前执行, 产物被 vite 作为
// publicDir(static) 复制到 dist/client, 并随 ./static 一起部署到 ASSETS。
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = join(root, "static", "plugins");
const i18nDir = join(pluginsDir, "i18n");
const outFile = join(pluginsDir, "__assets__.json");

/** @type {Record<string, {pkg?: string, main?: string, langs?: Record<string, any>}>} */
const plugins = {};

for (const name of readdirSync(pluginsDir)) {
  const dir = join(pluginsDir, name);
  if (!statSync(dir).isDirectory()) continue;
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  const entry = { pkg: readFileSync(pkgPath, "utf8"), langs: {} };
  const mainPath = join(dir, "static", "main.js");
  if (existsSync(mainPath)) entry.main = readFileSync(mainPath, "utf8");
  plugins[name] = entry;
}

if (existsSync(i18nDir)) {
  for (const file of readdirSync(i18nDir)) {
    if (!file.endsWith(".json")) continue;
    const base = file.slice(0, -5);
    const dot = base.indexOf(".");
    if (dot < 0) continue;
    const name = base.slice(0, dot);
    const lang = base.slice(dot + 1);
    if (!plugins[name]) continue;
    try {
      plugins[name].langs[lang] = JSON.parse(readFileSync(join(i18nDir, file), "utf8"));
    } catch {
      // 忽略损坏的语言包, 运行时回退到单独 fetch
    }
  }
}

writeFileSync(outFile, JSON.stringify({ plugins }));
const total = Object.keys(plugins).length;
console.log(`[gen-plugin-assets] wrote ${outFile} (${total} plugins)`);
