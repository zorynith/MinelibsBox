/**
 * 将 001 插件 i18n PHP 文件转换为 static/plugins/i18n/{name}.{lang}.json。
 * 格式: return array('key.with.prefix' => "value", ...)
 * 支持: 单/双引号字符串、跨行字符串、转义、行注释与块注释、尾逗号。
 * Usage: node scripts/convert-plugin-i18n.cjs
 */
const fs = require("fs");
const path = require("path");

const srcBase = path.join("/workspace", "001", "plugins");
const dstDir = path.join("/workspace", "static", "plugins", "i18n");

const plugins = ["adminer", "client", "fileThumb", "msgWarning", "oauth", "storeImport", "webdav"];

function parsePhpArray(content) {
  const m = content.match(/return\s+array\s*\(([\s\S]*)\)\s*;?\s*$/);
  if (!m) return null;
  const body = m[1];
  const result = {};
  let i = 0;
  const n = body.length;

  function skipWsAndComments() {
    while (i < n) {
      const c = body[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === ",") {
        i++;
        continue;
      }
      if (c === "/" && body[i + 1] === "/") {
        while (i < n && body[i] !== "\n") i++;
        continue;
      }
      if (c === "#") {
        while (i < n && body[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && body[i + 1] === "*") {
        i += 2;
        while (i < n && !(body[i] === "*" && body[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      break;
    }
  }

  function parseString() {
    const quote = body[i];
    i++;
    let out = "";
    while (i < n) {
      const c = body[i];
      if (c === "\\") {
        const nx = body[i + 1];
        if (nx === quote || nx === "\\") {
          out += nx;
          i += 2;
          continue;
        }
        if (nx === "n") {
          out += "\n";
          i += 2;
          continue;
        }
        if (nx === "t") {
          out += "\t";
          i += 2;
          continue;
        }
        if (nx === "r") {
          out += "\r";
          i += 2;
          continue;
        }
        out += c;
        i++;
        continue;
      }
      if (c === quote) {
        i++;
        return out;
      }
      out += c;
      i++;
    }
    return out;
  }

  while (true) {
    skipWsAndComments();
    if (i >= n) break;
    const c = body[i];
    if (c !== "'" && c !== '"') {
      i++;
      continue;
    }
    const key = parseString();
    skipWsAndComments();
    if (body[i] === "=" && body[i + 1] === ">") {
      i += 2;
    } else {
      continue;
    }
    skipWsAndComments();
    const vc = body[i];
    if (vc === "'" || vc === '"') {
      result[key] = parseString();
    } else if (body.slice(i, i + 5) === "array") {
      // 嵌套数组：跳过（插件 i18n 少见）
      let depth = 0;
      while (i < n) {
        if (body[i] === "(") depth++;
        else if (body[i] === ")") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
      result[key] = {};
    } else {
      let start = i;
      while (i < n && body[i] !== "," && body[i] !== "\n") i++;
      const raw = body.slice(start, i).trim();
      result[key] = raw;
    }
  }
  return result;
}

let total = 0;
for (const name of plugins) {
  const i18nDir = path.join(srcBase, name, "i18n");
  if (!fs.existsSync(i18nDir)) continue;
  for (const file of fs.readdirSync(i18nDir)) {
    if (!file.endsWith(".php")) continue;
    const lang = file.slice(0, -4);
    const content = fs.readFileSync(path.join(i18nDir, file), "utf8");
    const obj = parsePhpArray(content);
    if (!obj || Object.keys(obj).length === 0) {
      console.log(`Empty/failed: ${name}/${lang}`);
      continue;
    }
    fs.writeFileSync(
      path.join(dstDir, `${name}.${lang}.json`),
      JSON.stringify(obj, null, 2)
    );
    total++;
  }
}
console.log(`\nDone! Converted ${total} plugin i18n files to ${dstDir}/`);
