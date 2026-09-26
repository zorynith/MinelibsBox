export function parseLooseJson(raw: string): Record<string, any> {
  // Strip comments (//... and /*...*/) and trailing commas ONLY outside string literals.
  let out = "";
  let inStr = false;
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const ch = raw[i];
    if (inStr) {
      // 字符串内裸控制字符 (001 package.json 多行字符串如 fileThumb.desc) 需转义,
      // 否则 JSON.parse 报错。\n -> 换行、\t -> 制表符、\r 跳过 (CRLF)。
      if (ch === "\n") {
        out += "\\n";
        i++;
        continue;
      }
      if (ch === "\r") {
        i++;
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        i++;
        continue;
      }
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += raw[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < n && raw[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < n && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < n && /[\s\n\r]/.test(raw[j])) j++;
      if (raw[j] === "}" || raw[j] === "]") {
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return JSON.parse(out);
}
