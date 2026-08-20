/**
 * Convert MbesBox PHP i18n files to JSON
 * Usage: node scripts/convert-i18n.js
 */
const fs = require("fs");
const path = require("path");

const i18nSrc = "/workspace/001/config/i18n";
const i18nDst = path.join(__dirname, "..", "static", "i18n");

fs.mkdirSync(i18nDst, { recursive: true });

const dirs = fs.readdirSync(i18nSrc).filter((d) =>
  fs.statSync(path.join(i18nSrc, d)).isDirectory()
);

function parsePhpValue(val) {
  val = val.replace(/,\s*$/, "");

  // Handle concatenation with dot operator
  if (val.includes(" . ")) {
    const parts = val.split(" . ");
    return parts.map((p) => parsePhpValue(p.trim())).join("");
  }

  // String literal (single or double quoted)
  const strMatch = val.match(/^["'](.*)["']$/s);
  if (strMatch) {
    return strMatch[1]
      .replace(/\\\\/g, "\\")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  }

  // Function calls like LNG('xxx'), sprintf(...) - keep as placeholder
  if (val.match(/^[a-zA-Z_]\w*\s*\(/)) {
    return "";
  }

  // Numbers
  if (val.match(/^\d+(\.\d+)?$/)) return val;

  // Boolean/null
  if (val === "true") return "true";
  if (val === "false") return "false";
  if (val === "null") return "null";

  return val;
}

dirs.forEach((lang) => {
  const phpFile = path.join(i18nSrc, lang, "main.php");
  if (!fs.existsSync(phpFile)) return;

  const content = fs.readFileSync(phpFile, "utf8");

  // Extract the PHP array
  const match = content.match(/return\s+array\s*\(([\s\S]*)\)\s*;?\s*$/);
  if (!match) {
    console.log("Failed to parse: " + lang);
    return;
  }

  const json = {};
  const arrayContent = match[1];

  // Match key => value pairs using regex
  const keyValuePattern = /["']([^"']+)["']\s*=>\s*(.+?)(?=\n\s*["']|$)/gs;

  let m;
  while ((m = keyValuePattern.exec(arrayContent)) !== null) {
    const key = m[1];
    const rawValue = m[2].trim();
    const value = parsePhpValue(rawValue);
    if (key && value !== undefined && value !== "") {
      json[key] = value;
    }
  }

  if (Object.keys(json).length === 0) {
    console.log("Empty: " + lang);
    return;
  }

  fs.writeFileSync(
    path.join(i18nDst, lang + ".json"),
    JSON.stringify(json, null, 2)
  );
  console.log(`Converted: ${lang} (${Object.keys(json).length} keys)`);
});

console.log(`\nDone! Converted ${dirs.length} languages to ${i18nDst}/`);
