/**
 * Adminer (D1) —— 复刻 001 plugins/adminer。
 *
 * 001: adminer 是 PHP 版 Adminer(index.php 包裹 + adminer.php.txt), 由 PHP 驱动 MySQL。
 * Workers 环境无 PHP / MySQL, 这里改为驱动 D1(SQLite)。能力参照 adminer.php.txt 内置的
 * SQLite 驱动: 表/视图列举、结构(列/索引/外键/触发器/DDL)、数据分页浏览、行增删改、
 * SQL 执行(多语句)、整库/单表导出、SQL 导入、删除对象。
 *
 * 访问控制: 与 001 adminerPlugin::echoJs / index.php KodSSO::check('user:admin') 一致, 仅管理员。
 */
import type { AuthUser } from "../lib/auth";
import { getPluginMeta } from "../lib/db";

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

function adminerIsAdmin(user: AuthUser | undefined): boolean {
  return !!user && (user.role === "admin" || user.role === "root");
}

function currentAdmin(c: any): AuthUser | null {
  const u = c.get("currentUser") as AuthUser | undefined;
  return adminerIsAdmin(u) ? (u as AuthUser) : null;
}

function deny(c: any): Response {
  return c.json({ code: false, data: "explorer.noPermissionAction" });
}

function fail(c: any, msg: string, extra?: Record<string, unknown>): Response {
  return c.json(Object.assign({ code: false, data: msg }, extra || {}));
}

/** 001 adminerPlugin::debugSet: 读取插件 config.debug(默认 0) 决定是否输出错误信息。 */
async function adminerDebugOn(c: any): Promise<boolean> {
  try {
    const meta = await getPluginMeta(c.env.DB, "adminer");
    return Number((meta.config || {}).debug) === 1;
  } catch {
    return false;
  }
}

// ---------- SQL 基础 ----------

/** SQLite 标识符引用(双引号, 内部双引号翻倍)。 */
function qi(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** JS 值 -> D1 可绑定值。 */
function bindValue(v: any): any {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof ArrayBuffer || v instanceof Uint8Array) return v;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return v;
}

async function allStmt(c: any, sql: string, params: any[] = []): Promise<any[]> {
  const stmt = c.env.DB.prepare(sql);
  const r = params.length ? await stmt.bind(...params.map(bindValue)).all() : await stmt.all();
  return (r && (r.results as any[])) || [];
}

async function safeAll(c: any, sql: string, params: any[] = []): Promise<any[]> {
  try {
    return await allStmt(c, sql, params);
  } catch {
    return [];
  }
}

async function runStmt(c: any, sql: string, params: any[] = []): Promise<any> {
  const stmt = c.env.DB.prepare(sql);
  return params.length ? await stmt.bind(...params.map(bindValue)).run() : await stmt.run();
}

/** 读取对象定义(type/DDL/是否 WITHOUT ROWID)。 */
async function objectMeta(c: any, name: string): Promise<{ type: string; sql: string; withoutRowid: boolean; columns: any[]; pk: string[]; canRowid: boolean }> {
  const metaRows = await safeAll(c, "SELECT type, sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')", [name]);
  const type = metaRows[0]?.type || "";
  const sql = metaRows[0]?.sql || "";
  const columns = await safeAll(c, `PRAGMA table_info(${qi(name)})`);
  const colNames = columns.map((x: any) => x.name);
  const pk = columns.filter((x: any) => x.pk > 0).sort((a: any, b: any) => a.pk - b.pk).map((x: any) => x.name);
  const withoutRowid = /WITHOUT\s+ROWID/i.test(sql);
  const canRowid = type === "table" && !withoutRowid && !colNames.includes("rowid") && !colNames.includes("_rowid_") && !colNames.includes("oid");
  return { type, sql, withoutRowid, columns, pk, canRowid };
}

/** 拆分 SQL 脚本为单条语句(识别字符串/注释, 并处理 CREATE TRIGGER ... BEGIN ... END;)。 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  let inSingle = false;
  let inDouble = false;
  let inBack = false;
  let inBracket = false;
  let inLineComment = false;
  let inBlockComment = false;
  let trigger = false;
  const endsWithEnd = (s: string) => /end\s*$/i.test(s.trim());
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      cur += ch;
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      cur += ch;
      if (ch === "*" && next === "/") {
        cur += next;
        i += 2;
        inBlockComment = false;
        continue;
      }
      i++;
      continue;
    }
    if (inSingle) {
      cur += ch;
      if (ch === "'") {
        if (next === "'") {
          cur += next;
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i++;
      continue;
    }
    if (inDouble) {
      cur += ch;
      if (ch === '"') {
        if (next === '"') {
          cur += next;
          i += 2;
          continue;
        }
        inDouble = false;
      }
      i++;
      continue;
    }
    if (inBack) {
      cur += ch;
      if (ch === "`") {
        if (next === "`") {
          cur += next;
          i += 2;
          continue;
        }
        inBack = false;
      }
      i++;
      continue;
    }
    if (inBracket) {
      cur += ch;
      if (ch === "]") inBracket = false;
      i++;
      continue;
    }
    if (ch === "-" && next === "-") {
      inLineComment = true;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "`") {
      inBack = true;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "[") {
      inBracket = true;
      cur += ch;
      i++;
      continue;
    }
    if (ch === ";") {
      if (trigger && !endsWithEnd(cur)) {
        cur += ch;
        i++;
        continue;
      }
      const s = cur.trim();
      if (s) out.push(s);
      cur = "";
      trigger = false;
      i++;
      continue;
    }
    cur += ch;
    i++;
    if (!trigger && /^create\s+(temp\s+|temporary\s+)?trigger\b/i.test(cur.trim())) trigger = true;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

// ---------- handlers ----------

/** 表/视图列表。 */
async function adminerTables(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  const rows = await safeAll(
    c,
    "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name"
  );
  return c.json({ code: true, data: rows });
}

/** 服务器信息。 */
async function adminerInfo(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  const v = (await safeAll(c, "SELECT sqlite_version() AS version"))[0]?.version || "";
  const counts = await safeAll(
    c,
    "SELECT type, COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type"
  );
  return c.json({ code: true, data: { version: v, counts } });
}

/** 结构: 列 / 索引 / 外键 / 触发器 / DDL。 */
async function adminerStructure(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  const table = c.req.query("table") || "";
  if (!table) return fail(c, "missing table");
  const meta = await objectMeta(c, table);
  if (!meta.type) return fail(c, "object not found: " + table);
  const columns = meta.columns;
  const idxList = await safeAll(c, `PRAGMA index_list(${qi(table)})`);
  const indexes: Array<{ name: string; unique: boolean; origin: string; partial: boolean; columns: string[] }> = [];
  for (const ix of idxList) {
    const info = await safeAll(c, `PRAGMA index_info(${qi(ix.name)})`);
    indexes.push({
      name: String(ix.name),
      unique: !!ix.unique,
      origin: String(ix.origin || ""),
      partial: !!ix.partial,
      columns: info.map((x: any) => String(x.name)),
    });
  }
  const foreignKeys = await safeAll(c, `PRAGMA foreign_key_list(${qi(table)})`);
  const triggers = await safeAll(c, "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?", [table]);
  return c.json({
    code: true,
    data: {
      table,
      type: meta.type,
      columns,
      indexes,
      foreignKeys,
      triggers,
      sql: meta.sql,
      pk: meta.pk,
      canRowid: meta.canRowid,
    },
  });
}

/** 数据浏览(分页/排序/可选 where)。 */
async function adminerData(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  const table = c.req.query("table") || "";
  if (!table) return fail(c, "missing table");
  const meta = await objectMeta(c, table);
  if (!meta.type) return fail(c, "object not found: " + table);
  const colNames = meta.columns.map((x: any) => x.name);
  const size = Math.min(1000, Math.max(1, parseInt(c.req.query("size") || "50", 10) || 50));
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  const orderCols = (c.req.query("order") || "").split(",").map((s: string) => s.trim()).filter((col: string) => colNames.includes(col));
  const dirs = (c.req.query("dir") || "").split(",").map((s: string) => s.trim().toLowerCase());
  const where = (c.req.query("where") || "").trim();
  const whereSql = where ? ` WHERE ${where}` : "";
  const countRow = (await safeAll(c, `SELECT COUNT(*) AS n FROM ${qi(table)}${whereSql}`))[0];
  const total = countRow ? Number(countRow.n) : 0;
  const select = meta.canRowid ? "rowid AS __rowid__, *" : "*";
  const orderSql = orderCols.length
    ? ` ORDER BY ${orderCols.map((col: string, i: number) => `${qi(col)} ${dirs[i] === "desc" ? "DESC" : "ASC"}`).join(", ")}`
    : "";
  const offset = (page - 1) * size;
  const rows = await safeAll(c, `SELECT ${select} FROM ${qi(table)}${whereSql}${orderSql} LIMIT ${size} OFFSET ${offset}`);
  return c.json({
    code: true,
    data: { table, type: meta.type, columns: meta.columns, pk: meta.pk, canRowid: meta.canRowid, page, size, total, where, order: orderCols.join(","), dir: dirs.join(","), rows },
  });
}

/** 跨表搜索: 在所有表的文本列中 LIKE 匹配。 */
async function adminerSearch(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  const q = String(c.req.query("q") || "").trim();
  if (!q) return fail(c, "empty query");
  const tables = await safeAll(c, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const results: Array<{ table: string; columns: string[]; rows: any[] }> = [];
  for (const t of tables) {
    const meta = await objectMeta(c, String(t.name));
    const textCols = meta.columns.filter((col: any) => /TEXT|CHAR|CLOB/i.test(String(col.type || ""))).map((col: any) => String(col.name));
    if (!textCols.length) continue;
    const where = textCols.map((col: string) => `${qi(col)} LIKE ?`).join(" OR ");
    const rows = await safeAll(c, `SELECT * FROM ${qi(String(t.name))} WHERE ${where} LIMIT 100`, textCols.map(() => `%${q}%`));
    if (rows.length) results.push({ table: String(t.name), columns: meta.columns.map((col: any) => String(col.name)), rows });
  }
  return c.json({ code: true, data: { q, results } });
}

/** SQL 执行(支持多语句)。 */
async function adminerQuery(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  let sql = c.req.query("sql") || "";
  if (!sql) {
    try {
      const body = await c.req.json();
      sql = String((body as any).sql || "");
    } catch {
      /* no body */
    }
  }
  if (!sql.trim()) return fail(c, "empty sql");
  const statements = splitStatements(sql);
  const results: Array<Record<string, unknown>> = [];
  for (const st of statements) {
    const lower = st.trim().toLowerCase();
    const returnsRows = /^(select|pragma|with|explain|values|table)\b/.test(lower);
    try {
      if (returnsRows) {
        const r = await c.env.DB.prepare(st).all();
        const rows = (r.results as any[]) || [];
        results.push({ sql: st, columns: rows.length ? Object.keys(rows[0]) : [], rows });
      } else {
        const r = await c.env.DB.prepare(st).run();
        results.push({ sql: st, changes: r.meta?.changes ?? 0, lastRowId: r.meta?.last_row_id ?? null });
      }
    } catch (e: any) {
      return fail(c, String(e?.message || e), { results });
    }
  }
  return c.json({ code: true, data: { results } });
}

/** 单行增/删/改。 */
async function adminerRow(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty */
  }
  const action = String(body.action || "");
  const table = String(body.table || "");
  if (!table) return fail(c, "missing table");
  const meta = await objectMeta(c, table);
  if (!meta.type) return fail(c, "object not found: " + table);
  if (meta.type !== "table") return fail(c, "not editable: " + table);

  const colNames = meta.columns.map((x: any) => x.name);
  const values = body.values && typeof body.values === "object" ? (body.values as Record<string, any>) : {};
  const providedCols = Object.keys(values).filter((k) => colNames.includes(k));
  // update: 不修改主键列; insert: 主键列留空时省略(交由默认值/自增), 填写时写入。
  const setCols = providedCols.filter((k) => !meta.pk.includes(k));
  const insertCols = providedCols.filter((k) => {
    const v = values[k];
    if (v === undefined) return false;
    if (meta.pk.includes(k) && (v === null || v === "")) return false;
    return true;
  });

  // WHERE: 优先主键, 无主键时用 rowid (仅 update/delete 需要)
  let whereSql = "";
  let whereParams: any[] = [];
  if (action === "update" || action === "delete") {
    if (meta.pk.length) {
      const pkObj = body.pk && typeof body.pk === "object" ? (body.pk as Record<string, any>) : {};
      const missing = meta.pk.filter((k: string) => pkObj[k] === undefined || pkObj[k] === null);
      if (missing.length) return fail(c, "missing primary key: " + missing.join(", "));
      whereSql = meta.pk.map((k: string) => `${qi(k)} = ?`).join(" AND ");
      whereParams = meta.pk.map((k: string) => pkObj[k]);
    } else if (meta.canRowid && body.rowid !== undefined && body.rowid !== null) {
      whereSql = "rowid = ?";
      whereParams = [body.rowid];
    }
  }

  try {
    if (action === "insert") {
      if (!insertCols.length) {
        const r = await runStmt(c, `INSERT INTO ${qi(table)} DEFAULT VALUES`);
        return c.json({ code: true, data: { changes: r.meta?.changes ?? 0, lastRowId: r.meta?.last_row_id ?? null } });
      }
      const placeholders = insertCols.map(() => "?").join(", ");
      const r = await runStmt(
        c,
        `INSERT INTO ${qi(table)} (${insertCols.map(qi).join(", ")}) VALUES (${placeholders})`,
        insertCols.map((k) => values[k])
      );
      return c.json({ code: true, data: { changes: r.meta?.changes ?? 0, lastRowId: r.meta?.last_row_id ?? null } });
    }
    if (!whereSql) return fail(c, "no primary key / rowid to locate row");
    if (action === "update") {
      if (!setCols.length) return fail(c, "no changes");
      const r = await runStmt(
        c,
        `UPDATE ${qi(table)} SET ${setCols.map((k) => `${qi(k)} = ?`).join(", ")} WHERE ${whereSql}`,
        [...setCols.map((k) => values[k]), ...whereParams]
      );
      return c.json({ code: true, data: { changes: r.meta?.changes ?? 0 } });
    }
    if (action === "delete") {
      const r = await runStmt(c, `DELETE FROM ${qi(table)} WHERE ${whereSql}`, whereParams);
      return c.json({ code: true, data: { changes: r.meta?.changes ?? 0 } });
    }
    return fail(c, "unknown action: " + action);
  } catch (e: any) {
    return fail(c, String(e?.message || e));
  }
}

/** 删除对象(表/视图/索引/触发器)。 */
async function adminerDrop(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty */
  }
  const type = String(body.type || "table").toLowerCase();
  const name = String(body.name || "");
  if (!["table", "view", "index", "trigger"].includes(type)) return fail(c, "bad type");
  if (!name) return fail(c, "missing name");
  try {
    await runStmt(c, `DROP ${type.toUpperCase()} IF EXISTS ${qi(name)}`);
    return c.json({ code: true });
  } catch (e: any) {
    return fail(c, String(e?.message || e));
  }
}

/** SQL 值字面量。 */
function sqlLiteral(v: any): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof Uint8Array) return "X'" + Array.from(v).map((b) => b.toString(16).padStart(2, "0")).join("") + "'";
  if (v instanceof ArrayBuffer) return "X'" + Array.from(new Uint8Array(v)).map((b) => b.toString(16).padStart(2, "0")).join("") + "'";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return "'" + s.replace(/'/g, "''") + "'";
}

/** CSV/TSV 单元格转义。 */
function delimitedCell(v: any, sep: string): string {
  let s: string;
  if (v === null || v === undefined) return "";
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) s = "[BLOB]";
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  if (sep === "\t") {
    if (/[\t\n\r"]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  } else if (/[",\n\r]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** XML 文本转义。 */
function xmlEscape(v: any): string {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 导出(整库/多表), 支持 sql/csv/tsv/json/xml。 */
async function adminerExport(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  const format = (c.req.query("format") || "sql").toLowerCase();
  const mode = (c.req.query("mode") || "both").toLowerCase();
  const includeStructure = mode !== "data";
  const includeData = mode !== "structure";
  const tablesParam = c.req.query("tables") || "";
  const only = c.req.query("table") || "";
  const selected = (tablesParam ? tablesParam.split(",") : only ? [only] : [])
    .map((s: string) => s.trim())
    .filter(Boolean);
  const wanted = (n: string) => selected.length === 0 || selected.includes(n);
  const columnsParam = String(c.req.query("columns") || "").trim();
  const wantedCols = columnsParam ? columnsParam.split(",").map((s: string) => s.trim()).filter(Boolean) : null;
  const pickCols = (all: string[]): string[] => {
    if (!wantedCols) return all;
    const valid = new Set(all);
    return wantedCols.filter((col) => valid.has(col));
  };

  const objects = await safeAll(
    c,
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 ELSE 4 END, name"
  );
  const tables = objects.filter((o: any) => o.type === "table" && wanted(String(o.name)));
  const others = objects.filter(
    (o: any) => o.type !== "table" && (selected.length === 0 || selected.includes(String(o.name)) || selected.includes(String(o.tbl_name)))
  );

  const readRows = async (name: string): Promise<{ columns: string[]; rows: any[] }> => {
    const meta = await objectMeta(c, name);
    const columns = pickCols(meta.columns.map((x: any) => x.name));
    if (!columns.length) return { columns: [], rows: [] };
    const rows = await safeAll(c, `SELECT ${columns.map(qi).join(", ")} FROM ${qi(name)}`);
    return { columns, rows };
  };

  let body = "";
  let ext = "sql";
  let contentType = "application/sql; charset=utf-8";

  if (format === "csv" || format === "tsv") {
    const sep = format === "tsv" ? "\t" : ",";
    ext = format;
    contentType = format === "tsv" ? "text/tab-separated-values; charset=utf-8" : "text/csv; charset=utf-8";
    const chunks: string[] = [];
    for (const t of tables) {
      const { columns, rows } = await readRows(String(t.name));
      if (!columns.length) continue;
      if (selected.length === 0) chunks.push("# " + t.name);
      chunks.push(columns.map((col: string) => delimitedCell(col, sep)).join(sep));
      for (const row of rows) chunks.push(columns.map((col: string) => delimitedCell(row[col], sep)).join(sep));
    }
    body = chunks.join("\n") + (chunks.length ? "\n" : "");
  } else if (format === "json") {
    ext = "json";
    contentType = "application/json; charset=utf-8";
    const out: any[] = [];
    for (const t of tables) {
      const { columns, rows } = await readRows(String(t.name));
      out.push({ table: t.name, columns, rows });
    }
    body = JSON.stringify(out, null, 2);
  } else if (format === "xml") {
    ext = "xml";
    contentType = "application/xml; charset=utf-8";
    const out: string[] = ['<?xml version="1.0" encoding="utf-8"?>', "<database>"];
    for (const t of tables) {
      const { columns, rows } = await readRows(String(t.name));
      out.push('  <table name="' + xmlEscape(t.name) + '">');
      for (const row of rows) {
        out.push("    <row>");
        for (const col of columns) out.push('      <col name="' + xmlEscape(col) + '">' + xmlEscape(row[col]) + "</col>");
        out.push("    </row>");
      }
      out.push("  </table>");
    }
    out.push("</database>");
    body = out.join("\n") + "\n";
  } else {
    const out: string[] = [];
    out.push("-- MinelibsBox Adminer (D1/SQLite) export");
    out.push("-- " + new Date().toISOString());
    out.push("PRAGMA foreign_keys=OFF;");
    out.push("BEGIN TRANSACTION;");
    for (const t of tables) {
      const name = String(t.name);
      out.push("");
      if (includeStructure) {
        out.push(`DROP TABLE IF EXISTS ${qi(name)};`);
        out.push(String(t.sql || `CREATE TABLE ${qi(name)} ();`) + ";");
      }
      if (includeData) {
        const meta = await objectMeta(c, name);
        const colNames = pickCols(meta.columns.map((x: any) => x.name));
        if (colNames.length) {
          const colSel = colNames.map(qi).join(", ");
          const step = 500;
          for (let offset = 0; ; offset += step) {
            const rows = await safeAll(c, `SELECT ${colSel} FROM ${qi(name)} LIMIT ${step} OFFSET ${offset}`);
            if (!rows.length) break;
            for (const row of rows) {
              const vals = colNames.map((col: string) => sqlLiteral(row[col]));
              out.push(`INSERT INTO ${qi(name)} (${colSel}) VALUES (${vals.join(", ")});`);
            }
            if (rows.length < step) break;
          }
        }
      }
    }
    if (includeStructure) {
      for (const o of others) {
        if (!o.sql) continue;
        out.push("");
        out.push(String(o.sql) + ";");
      }
    }
    out.push("COMMIT;");
    out.push("");
    body = out.join("\n");
  }

  const gzipOn = c.req.query("gzip") === "1" || c.req.query("gzip") === "true";
  const label = selected.length ? selected.join("_") : "all";
  const filename = `adminer-${label}-${Date.now()}.${ext}${gzipOn ? ".gz" : ""}`;
  const headers: Record<string, string> = {
    "Content-Type": gzipOn ? "application/gzip" : contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
  };
  if (gzipOn) {
    const stream = new Response(body).body!.pipeThrough(new CompressionStream("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    return c.body(buf, 200, headers);
  }
  return c.body(body, 200, headers);
}

/** 简易 CSV/TSV 解析(支持引号包裹与转义)。 */
function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === sep) {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 导入 SQL 脚本或 CSV/TSV 数据。 */
async function adminerImport(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  let sql = "";
  let format = "sql";
  let table = "";
  let skipErrors = false;
  const ct = c.req.header("content-type") || "";
  try {
    if (ct.includes("multipart/form-data")) {
      const fd = await c.req.formData();
      format = String(fd.get("format") || "sql");
      table = String(fd.get("table") || "");
      skipErrors = String(fd.get("skipErrors") || "") === "1";
      const f: any = fd.get("file");
      if (f && typeof f === "object" && typeof f.text === "function") sql = await f.text();
      else sql = String(fd.get("sql") || "");
    } else {
      try {
        const body: any = await c.req.json();
        sql = String(body.sql || "");
        format = String(body.format || "sql");
        table = String(body.table || "");
        skipErrors = body.skipErrors === true || body.skipErrors === "1";
      } catch {
        sql = await c.req.text();
      }
    }
  } catch {
    return fail(c, "cannot read import body");
  }
  if (!sql.trim()) return fail(c, "empty input");

  if (format === "csv" || format === "tsv") {
    if (!table) return fail(c, "missing table");
    const rows = parseCsv(sql, format === "tsv" ? "\t" : ",");
    if (rows.length < 2) return fail(c, "no data rows");
    const header = rows[0].map((x) => String(x).trim());
    const data = rows.slice(1).filter((r) => r.length && !(r.length === 1 && r[0] === ""));
    const placeholders = header.map(() => "?").join(", ");
    const stmt = `INSERT INTO ${qi(table)} (${header.map(qi).join(", ")}) VALUES (${placeholders})`;
    let executed = 0;
    const errors: string[] = [];
    const chunkSize = 100;
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      if (skipErrors) {
        for (let j = 0; j < chunk.length; j++) {
          try {
            await c.env.DB.prepare(stmt).bind(...header.map((_, k) => bindValue(chunk[j][k]))).run();
            executed++;
          } catch (e: any) {
            errors.push(String(e?.message || e));
          }
        }
      } else {
        const prepared = chunk.map((r) => c.env.DB.prepare(stmt).bind(...header.map((_, j) => bindValue(r[j]))));
        try {
          await c.env.DB.batch(prepared);
          executed += chunk.length;
        } catch (e: any) {
          return fail(c, String(e?.message || e), { executed });
        }
      }
    }
    return c.json({ code: true, data: { executed, errors } });
  }

  const statements = splitStatements(sql);
  if (!statements.length) return fail(c, "no statements");
  let executed = 0;
  const errors: string[] = [];
  const chunkSize = 50;
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    if (skipErrors) {
      for (const s of chunk) {
        try {
          await c.env.DB.prepare(s).run();
          executed++;
        } catch (e: any) {
          errors.push(String(e?.message || e));
        }
      }
    } else {
      const prepared = chunk.map((s) => c.env.DB.prepare(s));
      try {
        await c.env.DB.batch(prepared);
        executed += chunk.length;
      } catch (e: any) {
        return fail(c, String(e?.message || e), { executed, failedAt: chunk[0] });
      }
    }
  }
  return c.json({ code: true, data: { executed, errors } });
}

/** 建表(列定义 + 可选索引)。 */
async function adminerCreate(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty */
  }
  const name = String(body.name || "").trim();
  if (!name) return fail(c, "missing table name");
  const cols: any[] = Array.isArray(body.columns) ? body.columns : [];
  const defs: string[] = [];
  const pkCols: string[] = [];
  let autoCol = "";
  for (const col of cols) {
    const cn = String(col.name || "").trim();
    if (!cn) continue;
    let type = String(col.type || "TEXT").trim() || "TEXT";
    if (col.length && !/\(/.test(type)) type += "(" + parseInt(String(col.length), 10) + ")";
    if (col.autoIncrement) {
      defs.push(qi(cn) + " INTEGER PRIMARY KEY AUTOINCREMENT");
      autoCol = cn;
      continue;
    }
    let def = qi(cn) + " " + type;
    if (col.notnull) def += " NOT NULL";
    if (col.default !== undefined && col.default !== null && col.default !== "") def += " DEFAULT " + String(col.default);
    if (col.foreignKey && col.foreignKey.refTable) {
      def += ` REFERENCES ${qi(String(col.foreignKey.refTable))}${col.foreignKey.refColumn ? `(${qi(String(col.foreignKey.refColumn))})` : ""}`;
    }
    if (col.pk) pkCols.push(cn);
    defs.push(def);
  }
  if (!defs.length) return fail(c, "no columns");
  if (pkCols.length && !autoCol) defs.push("PRIMARY KEY (" + pkCols.map(qi).join(", ") + ")");
  const fks: any[] = Array.isArray(body.foreignKeys) ? body.foreignKeys : [];
  for (const fk of fks) {
    const fkCols: string[] = Array.isArray(fk.columns) ? fk.columns.filter(Boolean) : [];
    if (!fkCols.length || !fk.refTable) continue;
    const refCols: string[] = Array.isArray(fk.refColumns) ? fk.refColumns.filter(Boolean) : [];
    defs.push(`FOREIGN KEY (${fkCols.map(qi).join(", ")}) REFERENCES ${qi(String(fk.refTable))}${refCols.length ? ` (${refCols.map(qi).join(", ")})` : ""}`);
  }
  const createSql = `CREATE TABLE ${body.ifNotExists ? "IF NOT EXISTS " : ""}${qi(name)} (\n  ${defs.join(",\n  ")}\n)`;
  const executed: string[] = [createSql];
  try {
    await runStmt(c, createSql);
    const idxs: any[] = Array.isArray(body.indexes) ? body.indexes : [];
    for (const ix of idxs) {
      const ixCols: string[] = Array.isArray(ix.columns) ? ix.columns.filter(Boolean) : [];
      if (!ixCols.length) continue;
      const ixName = String(ix.name || "").trim() || `${name}_${ixCols.join("_")}_idx`;
      const s = `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${qi(ixName)} ON ${qi(name)} (${ixCols.map(qi).join(", ")})`;
      executed.push(s);
      await runStmt(c, s);
    }
  } catch (e: any) {
    return fail(c, String(e?.message || e), { executed });
  }
  return c.json({ code: true, data: { executed } });
}

/** 改表: 增/删/改名 列, 改名表, 增/删索引。 */
async function adminerAlter(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty */
  }
  const table = String(body.table || "").trim();
  if (!table) return fail(c, "missing table");
  const op = String(body.op || "");
  try {
    if (op === "addColumn") {
      const cn = String(body.name || "").trim();
      if (!cn) return fail(c, "missing column name");
      let type = String(body.type || "TEXT").trim() || "TEXT";
      if (body.length && !/\(/.test(type)) type += "(" + parseInt(String(body.length), 10) + ")";
      let s = `ALTER TABLE ${qi(table)} ADD COLUMN ${qi(cn)} ${type}`;
      if (body.notnull) s += " NOT NULL";
      if (body.default !== undefined && body.default !== null && body.default !== "") s += " DEFAULT " + String(body.default);
      await runStmt(c, s);
      return c.json({ code: true, data: { executed: [s] } });
    }
    if (op === "dropColumn") {
      const cn = String(body.name || "").trim();
      if (!cn) return fail(c, "missing column name");
      const s = `ALTER TABLE ${qi(table)} DROP COLUMN ${qi(cn)}`;
      await runStmt(c, s);
      return c.json({ code: true, data: { executed: [s] } });
    }
    if (op === "renameColumn") {
      const from = String(body.from || "").trim();
      const to = String(body.to || "").trim();
      if (!from || !to) return fail(c, "missing column name");
      const s = `ALTER TABLE ${qi(table)} RENAME COLUMN ${qi(from)} TO ${qi(to)}`;
      await runStmt(c, s);
      return c.json({ code: true, data: { executed: [s] } });
    }
    if (op === "renameTable") {
      const to = String(body.to || "").trim();
      if (!to) return fail(c, "missing new name");
      const s = `ALTER TABLE ${qi(table)} RENAME TO ${qi(to)}`;
      await runStmt(c, s);
      return c.json({ code: true, data: { executed: [s], renameTo: to } });
    }
    if (op === "addIndex") {
      const cols: string[] = Array.isArray(body.columns) ? body.columns.filter(Boolean) : [];
      if (!cols.length) return fail(c, "no columns");
      const nm = String(body.name || "").trim() || `${table}_${cols.join("_")}_idx`;
      const s = `CREATE ${body.unique ? "UNIQUE " : ""}INDEX ${qi(nm)} ON ${qi(table)} (${cols.map(qi).join(", ")})`;
      await runStmt(c, s);
      return c.json({ code: true, data: { executed: [s] } });
    }
    if (op === "dropIndex") {
      const nm = String(body.name || "").trim();
      if (!nm) return fail(c, "missing index name");
      const s = `DROP INDEX ${qi(nm)}`;
      await runStmt(c, s);
      return c.json({ code: true, data: { executed: [s] } });
    }
    return fail(c, "unknown op: " + op);
  } catch (e: any) {
    return fail(c, String(e?.message || e));
  }
}

/** 创建/替换视图。 */
async function adminerCreateView(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty */
  }
  const name = String(body.name || "").trim();
  const selectSql = String(body.sql || "").trim();
  if (!name) return fail(c, "missing view name");
  if (!selectSql) return fail(c, "missing SELECT sql");
  if (!/^select\b/i.test(selectSql)) return fail(c, "view SQL must be a SELECT");
  try {
    const executed: string[] = [];
    if (body.replace === true) {
      const dropSql = `DROP VIEW IF EXISTS ${qi(name)}`;
      await runStmt(c, dropSql);
      executed.push(dropSql);
    }
    const createSql = `CREATE VIEW ${qi(name)} AS ${selectSql}`;
    await runStmt(c, createSql);
    executed.push(createSql);
    return c.json({ code: true, data: { executed } });
  } catch (e: any) {
    return fail(c, String(e?.message || e));
  }
}

/** 创建触发器。 */
async function adminerCreateTrigger(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty */
  }
  const name = String(body.name || "").trim();
  const table = String(body.table || "").trim();
  const timing = String(body.timing || "BEFORE").toUpperCase();
  const event = String(body.event || "INSERT").toUpperCase();
  const sql = String(body.sql || "").trim();
  if (!name || !table) return fail(c, "missing name/table");
  if (!["BEFORE", "AFTER", "INSTEAD OF"].includes(timing)) return fail(c, "bad timing");
  if (!["INSERT", "UPDATE", "DELETE"].includes(event)) return fail(c, "bad event");
  if (!sql) return fail(c, "missing trigger body");
  try {
    const body = sql.replace(/;+\s*$/, "");
    const s = `CREATE TRIGGER ${qi(name)} ${timing} ${event} ON ${qi(table)} BEGIN ${body}; END`;
    await runStmt(c, s);
    return c.json({ code: true, data: { executed: [s] } });
  } catch (e: any) {
    return fail(c, String(e?.message || e));
  }
}

// ---------- dispatcher ----------

export async function handleAdminer(c: any, act: string, appHost: string, staticPath: string): Promise<Response> {
  try {
    switch (act) {
      case "tables":
        return adminerTables(c);
      case "info":
        return adminerInfo(c);
      case "structure":
        return adminerStructure(c);
      case "data":
        return adminerData(c);
      case "query":
        return adminerQuery(c);
      case "search":
        return adminerSearch(c);
      case "row":
        return adminerRow(c);
      case "create":
        return adminerCreate(c);
      case "createView":
        return adminerCreateView(c);
      case "createTrigger":
        return adminerCreateTrigger(c);
      case "alter":
        return adminerAlter(c);
      case "drop":
        return adminerDrop(c);
      case "export":
        return adminerExport(c);
      case "import":
        return adminerImport(c);
      default:
        return renderAdminer(c, appHost, staticPath);
    }
  } catch (e: any) {
    const debug = await adminerDebugOn(c);
    return c.json({ code: false, data: debug ? String((e && e.stack) || e) : "adminer.execError" });
  }
}

// ---------- 页面 ----------

/** 渲染 Adminer 主题的 D1 管理页(复用 001 adminer.css, 尽量还原 Adminer 界面与能力)。 */
async function renderAdminer(c: any, appHost: string, staticPath: string): Promise<Response> {
  if (!currentAdmin(c)) {
    return c.body(
      `<!doctype html><html><head><meta charset="utf-8"><title>Adminer</title></head><body style="font-family:sans-serif;padding:40px">Adminer: no permission (admin only)</body></html>`,
      200,
      HTML_HEADERS
    );
  }
  const pluginHost = `${staticPath}plugins/adminer/`;
  const apiBase = `${appHost}index.php?plugin/adminer/`;
  const debug = await adminerDebugOn(c);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Adminer</title>
<link rel="stylesheet" href="${pluginHost}adminer/adminer.css">
<style>
#menu{display:flex;flex-direction:column;}
#menu #dbs{color:#fff;font-size:13px;}
#lang select{position:absolute !important;left:10px !important;right:auto !important;top:9px !important;width:auto !important;max-width:210px;background-color:#456079;border:none;color:#fff;border-radius:4px;height:23px;line-height:23px;}
#menu .links{width:auto !important;margin:0 !important;flex:none;}
#menu #tables{position:static !important;top:auto !important;bottom:auto !important;left:auto !important;right:auto !important;margin:0 !important;flex:1 1 auto;overflow-y:auto !important;width:100%;}
#page input[type=button]{margin:0 5px 6px 0;padding:5px 11px;border:1px solid #d0cdc4;border-radius:3px;background:#fff;color:#2c3e50;cursor:pointer;vertical-align:middle;}
#page input[type=button]:hover{background:#eef3f8;}
#page input[type=button]:disabled{opacity:.45;cursor:default;}
#page p{line-height:2.2;}
td a{margin-right:8px;}
</style>
</head>
<body class="ltr js">
<div id="content">
  <p id="breadcrumb"></p>
  <h2 id="h2"></h2>
  <div id="ajaxstatus" class="jsonly"></div>
  <p class="links" id="tabs"></p>
  <div id="page"></div>
</div>
<div id="foot" class="foot"><div id="menu">
  <h1><a href="javascript:void(0)" id="h1">Adminer</a> <span class="version" id="version">D1</span></h1>
  <form onsubmit="return false"><div id="lang"><label>Language: <select id="langSel"><option value="en">English</option><option value="zh">简体中文</option><option value="zh-tw">繁體中文</option><option value="ja">日本語</option><option value="ko">한국어</option><option value="fr">Français</option><option value="de">Deutsch</option><option value="es">Español</option><option value="ru">Русский</option><option value="pt">Português</option><option value="it">Italiano</option></select></label></div></form>
  <p id="dbs">SQLite / D1</p>
  <p id="tableFilter" style="display:none"><input type="text" id="tableFilterInput" oninput="filterTables(this.value)" placeholder="filter" style="width:92%"></p>
  <p class="links">
    <a href="javascript:void(0)" data-nav="sql">SQL command</a>
    <a href="javascript:void(0)" data-nav="import">Import</a>
    <a href="javascript:void(0)" data-nav="export">Export</a>
    <a href="javascript:void(0)" data-nav="create">Create table</a>
  </p>
  <ul id="tables"></ul>
</div></div>
<div id="adminerDebug" style="display:none;position:fixed;left:0;right:0;bottom:0;max-height:35%;overflow:auto;background:#1e1e1e;color:#d4d4d4;font:12px/1.5 monospace;padding:8px 12px;border-top:2px solid #e8a33d;z-index:9999"></div>
<script>
var apiBase = ${JSON.stringify(apiBase)};
var DEBUG = ${debug ? 1 : 0};
var TYPE_LIST = ['INTEGER','TEXT','REAL','BLOB','NUMERIC','BOOLEAN','DATE','DATETIME','TIMESTAMP','VARCHAR','CHAR','DECIMAL','DOUBLE','FLOAT','BIGINT','SMALLINT','CLOB','JSON'];
var LANG = {
  en: { sqlCommand:'SQL command', import:'Import', export:'Export', createTable:'Create table', alterTable:'Alter table', selectData:'Select data', structure:'Structure', newItem:'New item', edit:'edit', del:'delete', save:'Save', cancel:'Cancel', refresh:'Refresh', execute:'Execute', clear:'Clear', rows:'row(s)', page:'Page', prev:'<', next:'>', indexes:'Indexes', foreignKeys:'Foreign keys', triggers:'Triggers', ddl:'Create code', columns:'Columns', name:'Name', type:'Type', nullable:'Nullable', default:'Default', primaryKey:'Primary key', unique:'Unique', importSql:'Import SQL / CSV', importHint:'Paste SQL statements (or CSV data with a header row), or choose a file.', loading:'Loading...', noTables:'No tables', noRows:'No rows', views:'Views', db:'D1', table:'Table', tableName:'Table name', format:'Format', file:'File', executed:'statement(s) executed', actions:'Actions', where:'WHERE', rowsPerPage:'Rows', size:'Size', addColumn:'Add column', dropColumn:'Drop column', renameColumn:'Rename column', renameTable:'Rename table', addIndex:'Add index', dropIndex:'Drop index', column:'Column', length:'Length', notnull:'Not NULL', autoIncrement:'Auto increment', add:'Add', remove:'Remove', drop:'Drop', empty:'Empty', confirmDrop:'Drop this object? This cannot be undone.', confirmEmpty:'Delete ALL rows in this table?', confirmDelete:'Delete this row?', newTableName:'New name', from:'From', to:'To', ifNotExists:'IF NOT EXISTS', affected:'row(s) affected', selectTable:'Select a table from the left.', search:'Search', searchHint:'Search text across all tables', clone:'clone', print:'Print', createView:'Create view', createTrigger:'Create trigger', first:'<<', last:'>>', structureOnly:'Structure only', dataOnly:'Data only', both:'Structure + data', skipErrors:'Skip errors', history:'History', filter:'Filter', viewName:'View name', selectSql:'SELECT statement', triggerName:'Trigger name', timing:'Timing', event:'Event', triggerBody:'Trigger body (SQL statements)', refTable:'Reference table', refColumn:'Reference column', foreignKey:'Foreign key', noMatches:'No matches', copied:'row copied', columnsHint:'blank = all, comma-separated' },
  zh: { sqlCommand:'SQL 命令', import:'导入', export:'导出', createTable:'新建数据表', alterTable:'修改表', selectData:'浏览数据', structure:'结构', newItem:'新建记录', edit:'编辑', del:'删除', save:'保存', cancel:'取消', refresh:'刷新', execute:'执行', clear:'清空', rows:'行', page:'第', prev:'<', next:'>', indexes:'索引', foreignKeys:'外键', triggers:'触发器', ddl:'建表语句', columns:'字段', name:'名称', type:'类型', nullable:'可空', default:'默认值', primaryKey:'主键', unique:'唯一', importSql:'导入 SQL / CSV', importHint:'粘贴 SQL 语句（或带表头的 CSV 数据），也可选择文件。', loading:'加载中...', noTables:'没有数据表', noRows:'没有数据', views:'视图', db:'D1', table:'表', tableName:'表名', format:'格式', file:'文件', executed:'条语句已执行', actions:'操作', where:'条件', rowsPerPage:'每页', size:'宽度', addColumn:'添加字段', dropColumn:'删除字段', renameColumn:'重命名字段', renameTable:'重命名表', addIndex:'添加索引', dropIndex:'删除索引', column:'字段', length:'长度', notnull:'非空', autoIncrement:'自增', add:'添加', remove:'删除', drop:'删除表', empty:'清空', confirmDrop:'确定删除该对象？不可恢复。', confirmEmpty:'确定删除该表全部数据？', confirmDelete:'确定删除该行？', newTableName:'新名称', from:'从', to:'到', ifNotExists:'若不存在', affected:'行受影响', selectTable:'请从左侧选择数据表。', search:'搜索', searchHint:'在所有表中搜索文本', clone:'克隆', print:'打印', createView:'新建视图', createTrigger:'新建触发器', first:'<<', last:'>>', structureOnly:'仅结构', dataOnly:'仅数据', both:'结构+数据', skipErrors:'跳过错误继续', history:'历史', filter:'过滤', viewName:'视图名', selectSql:'SELECT 语句', triggerName:'触发器名', timing:'时机', event:'事件', triggerBody:'触发器体（SQL 语句）', refTable:'引用表', refColumn:'引用列', foreignKey:'外键', noMatches:'无匹配', copied:'行已复制', columnsHint:'留空=全部，逗号分隔' },
  'zh-tw': { sqlCommand:'SQL 命令', import:'匯入', export:'匯出', createTable:'建立資料表', alterTable:'修改資料表', selectData:'瀏覽資料', structure:'結構', newItem:'新增記錄', edit:'編輯', del:'刪除', save:'儲存', cancel:'取消', refresh:'重新整理', execute:'執行', clear:'清除', rows:'列', page:'第', prev:'<', next:'>', indexes:'索引', foreignKeys:'外鍵', triggers:'觸發器', ddl:'建表語句', columns:'欄位', name:'名稱', type:'類型', nullable:'可空', default:'預設值', primaryKey:'主鍵', unique:'唯一', importSql:'匯入 SQL / CSV', importHint:'貼上 SQL 語句（或帶表頭的 CSV 資料），也可選擇檔案。', loading:'載入中...', noTables:'沒有資料表', noRows:'沒有資料', views:'檢視', db:'D1', table:'資料表', tableName:'表名', format:'格式', file:'檔案', executed:'條語句已執行', actions:'操作', where:'條件', rowsPerPage:'每頁', size:'寬度', addColumn:'新增欄位', dropColumn:'刪除欄位', renameColumn:'重新命名欄位', renameTable:'重新命名資料表', addIndex:'新增索引', dropIndex:'刪除索引', column:'欄位', length:'長度', notnull:'非空', autoIncrement:'自動遞增', add:'新增', remove:'刪除', drop:'刪除資料表', empty:'清空', confirmDrop:'確定刪除該物件？不可恢復。', confirmEmpty:'確定刪除該表全部資料？', confirmDelete:'確定刪除該列？', newTableName:'新名稱', from:'從', to:'到', ifNotExists:'若不存在', affected:'列受影響', selectTable:'請從左側選擇資料表。', search:'搜尋', searchHint:'在所有資料表中搜尋文字', clone:'複製', print:'列印', createView:'建立檢視', createTrigger:'建立觸發器', first:'<<', last:'>>', structureOnly:'僅結構', dataOnly:'僅資料', both:'結構+資料', skipErrors:'跳過錯誤繼續', history:'歷史', filter:'過濾', viewName:'檢視名', selectSql:'SELECT 語句', triggerName:'觸發器名', timing:'時機', event:'事件', triggerBody:'觸發器體（SQL 語句）', refTable:'引用資料表', refColumn:'引用欄位', foreignKey:'外鍵', noMatches:'無匹配', copied:'列已複製', columnsHint:'留空=全部，逗號分隔' },
  ja: { sqlCommand:'SQL コマンド', import:'インポート', export:'エクスポート', createTable:'テーブル作成', alterTable:'テーブル変更', selectData:'データ表示', structure:'構造', newItem:'新規レコード', edit:'編集', del:'削除', save:'保存', cancel:'キャンセル', refresh:'更新', execute:'実行', clear:'クリア', rows:'行', page:'ページ', prev:'<', next:'>', indexes:'インデックス', foreignKeys:'外部キー', triggers:'トリガー', ddl:'CREATE 文', columns:'カラム', name:'名前', type:'型', nullable:'NULL 可', default:'デフォルト', primaryKey:'主キー', unique:'一意', importSql:'SQL / CSV インポート', importHint:'SQL 文（またはヘッダー付き CSV データ）を貼り付けるか、ファイルを選択してください。', loading:'読み込み中...', noTables:'テーブルなし', noRows:'データなし', views:'ビュー', db:'D1', table:'テーブル', tableName:'テーブル名', format:'形式', file:'ファイル', executed:'文を実行しました', actions:'操作', where:'条件', rowsPerPage:'表示件数', size:'サイズ', addColumn:'カラム追加', dropColumn:'カラム削除', renameColumn:'カラム名変更', renameTable:'テーブル名変更', addIndex:'インデックス追加', dropIndex:'インデックス削除', column:'カラム', length:'長さ', notnull:'NOT NULL', autoIncrement:'自動採番', add:'追加', remove:'削除', drop:'テーブル削除', empty:'空にする', confirmDrop:'このオブジェクトを削除しますか？元に戻せません。', confirmEmpty:'このテーブルの全データを削除しますか？', confirmDelete:'この行を削除しますか？', newTableName:'新しい名前', from:'元', to:'先', ifNotExists:'存在しない場合', affected:'行が影響を受けました', selectTable:'左側からテーブルを選択してください。', search:'検索', searchHint:'すべてのテーブルでテキストを検索', clone:'複製', print:'印刷', createView:'ビュー作成', createTrigger:'トリガー作成', first:'<<', last:'>>', structureOnly:'構造のみ', dataOnly:'データのみ', both:'構造+データ', skipErrors:'エラーをスキップ', history:'履歴', filter:'絞り込み', viewName:'ビュー名', selectSql:'SELECT 文', triggerName:'トリガー名', timing:'タイミング', event:'イベント', triggerBody:'トリガー本体（SQL 文）', refTable:'参照テーブル', refColumn:'参照カラム', foreignKey:'外部キー', noMatches:'一致なし', copied:'行を複製しました' },
  ko: { sqlCommand:'SQL 명령', import:'가져오기', export:'내보내기', createTable:'테이블 생성', alterTable:'테이블 변경', selectData:'데이터 보기', structure:'구조', newItem:'새 레코드', edit:'편집', del:'삭제', save:'저장', cancel:'취소', refresh:'새로고침', execute:'실행', clear:'지우기', rows:'행', page:'페이지', prev:'<', next:'>', indexes:'인덱스', foreignKeys:'외래 키', triggers:'트리거', ddl:'CREATE 문', columns:'열', name:'이름', type:'유형', nullable:'NULL 허용', default:'기본값', primaryKey:'기본 키', unique:'고유', importSql:'SQL / CSV 가져오기', importHint:'SQL 문(또는 헤더가 있는 CSV 데이터)을 붙여넣거나 파일을 선택하세요.', loading:'불러오는 중...', noTables:'테이블 없음', noRows:'데이터 없음', views:'뷰', db:'D1', table:'테이블', tableName:'테이블 이름', format:'형식', file:'파일', executed:'문 실행됨', actions:'작업', where:'조건', rowsPerPage:'페이지당 행', size:'크기', addColumn:'열 추가', dropColumn:'열 삭제', renameColumn:'열 이름 변경', renameTable:'테이블 이름 변경', addIndex:'인덱스 추가', dropIndex:'인덱스 삭제', column:'열', length:'길이', notnull:'NOT NULL', autoIncrement:'자동 증가', add:'추가', remove:'삭제', drop:'테이블 삭제', empty:'비우기', confirmDrop:'이 개체를 삭제할까요? 되돌릴 수 없습니다.', confirmEmpty:'이 테이블의 모든 데이터를 삭제할까요?', confirmDelete:'이 행을 삭제할까요?', newTableName:'새 이름', from:'원본', to:'대상', ifNotExists:'없는 경우', affected:'행이 영향받음', selectTable:'왼쪽에서 테이블을 선택하세요.', search:'검색', searchHint:'모든 테이블에서 텍스트 검색', clone:'복제', print:'인쇄', createView:'뷰 생성', createTrigger:'트리거 생성', first:'<<', last:'>>', structureOnly:'구조만', dataOnly:'데이터만', both:'구조+데이터', skipErrors:'오류 건너뛰기', history:'기록', filter:'필터', viewName:'뷰 이름', selectSql:'SELECT 문', triggerName:'트리거 이름', timing:'시점', event:'이벤트', triggerBody:'트리거 본문(SQL 문)', refTable:'참조 테이블', refColumn:'참조 열', foreignKey:'외래 키', noMatches:'일치 없음', copied:'행 복사됨' },
  fr: { sqlCommand:'Commande SQL', import:'Importer', export:'Exporter', createTable:'Créer une table', alterTable:'Modifier la table', selectData:'Afficher les données', structure:'Structure', newItem:'Nouvel enregistrement', edit:'modifier', del:'supprimer', save:'Enregistrer', cancel:'Annuler', refresh:'Actualiser', execute:'Exécuter', clear:'Effacer', rows:'lignes', page:'Page', prev:'<', next:'>', indexes:'Index', foreignKeys:'Clés étrangères', triggers:'Déclencheurs', ddl:'Code CREATE', columns:'Colonnes', name:'Nom', type:'Type', nullable:'Nullable', default:'Défaut', primaryKey:'Clé primaire', unique:'Unique', importSql:'Importer SQL / CSV', importHint:'Collez des instructions SQL (ou des données CSV avec en-tête), ou choisissez un fichier.', loading:'Chargement...', noTables:'Aucune table', noRows:'Aucune donnée', views:'Vues', db:'D1', table:'Table', tableName:'Nom de la table', format:'Format', file:'Fichier', executed:'instruction(s) exécutée(s)', actions:'Actions', where:'WHERE', rowsPerPage:'Lignes', size:'Taille', addColumn:'Ajouter une colonne', dropColumn:'Supprimer une colonne', renameColumn:'Renommer une colonne', renameTable:'Renommer la table', addIndex:'Ajouter un index', dropIndex:'Supprimer un index', column:'Colonne', length:'Longueur', notnull:'NOT NULL', autoIncrement:'Auto-incrément', add:'Ajouter', remove:'Supprimer', drop:'Supprimer', empty:'Vider', confirmDrop:'Supprimer cet objet ? Action irréversible.', confirmEmpty:'Supprimer TOUTES les lignes de cette table ?', confirmDelete:'Supprimer cette ligne ?', newTableName:'Nouveau nom', from:'De', to:'Vers', ifNotExists:'SI INEXISTANT', affected:'ligne(s) affectée(s)', selectTable:'Sélectionnez une table à gauche.', search:'Rechercher', searchHint:'Rechercher du texte dans toutes les tables', clone:'cloner', print:'Imprimer', createView:'Créer une vue', createTrigger:'Créer un déclencheur', first:'<<', last:'>>', structureOnly:'Structure seule', dataOnly:'Données seules', both:'Structure + données', skipErrors:'Ignorer les erreurs', history:'Historique', filter:'Filtrer', viewName:'Nom de la vue', selectSql:'Instruction SELECT', triggerName:'Nom du déclencheur', timing:'Moment', event:'Événement', triggerBody:'Corps du déclencheur (instructions SQL)', refTable:'Table de référence', refColumn:'Colonne de référence', foreignKey:'Clé étrangère', noMatches:'Aucune correspondance', copied:'ligne copiée' },
  de: { sqlCommand:'SQL-Befehl', import:'Importieren', export:'Exportieren', createTable:'Tabelle erstellen', alterTable:'Tabelle ändern', selectData:'Daten anzeigen', structure:'Struktur', newItem:'Neuer Datensatz', edit:'bearbeiten', del:'löschen', save:'Speichern', cancel:'Abbrechen', refresh:'Aktualisieren', execute:'Ausführen', clear:'Leeren', rows:'Zeilen', page:'Seite', prev:'<', next:'>', indexes:'Indizes', foreignKeys:'Fremdschlüssel', triggers:'Trigger', ddl:'CREATE-Code', columns:'Spalten', name:'Name', type:'Typ', nullable:'Nullwert zulässig', default:'Standard', primaryKey:'Primärschlüssel', unique:'Eindeutig', importSql:'SQL / CSV importieren', importHint:'SQL-Anweisungen (oder CSV-Daten mit Kopfzeile) einfügen oder Datei wählen.', loading:'Laden...', noTables:'Keine Tabellen', noRows:'Keine Daten', views:'Ansichten', db:'D1', table:'Tabelle', tableName:'Tabellenname', format:'Format', file:'Datei', executed:'Anweisung(en) ausgeführt', actions:'Aktionen', where:'WHERE', rowsPerPage:'Zeilen', size:'Größe', addColumn:'Spalte hinzufügen', dropColumn:'Spalte löschen', renameColumn:'Spalte umbenennen', renameTable:'Tabelle umbenennen', addIndex:'Index hinzufügen', dropIndex:'Index löschen', column:'Spalte', length:'Länge', notnull:'NOT NULL', autoIncrement:'Auto-Inkrement', add:'Hinzufügen', remove:'Entfernen', drop:'Löschen', empty:'Leeren', confirmDrop:'Dieses Objekt löschen? Nicht rückgängig machbar.', confirmEmpty:'ALLE Zeilen dieser Tabelle löschen?', confirmDelete:'Diese Zeile löschen?', newTableName:'Neuer Name', from:'Von', to:'Nach', ifNotExists:'FALLS NICHT VORHANDEN', affected:'Zeile(n) betroffen', selectTable:'Wählen Sie links eine Tabelle.', search:'Suchen', searchHint:'Text in allen Tabellen suchen', clone:'klonen', print:'Drucken', createView:'Ansicht erstellen', createTrigger:'Trigger erstellen', first:'<<', last:'>>', structureOnly:'Nur Struktur', dataOnly:'Nur Daten', both:'Struktur + Daten', skipErrors:'Fehler überspringen', history:'Verlauf', filter:'Filtern', viewName:'Name der Ansicht', selectSql:'SELECT-Anweisung', triggerName:'Trigger-Name', timing:'Zeitpunkt', event:'Ereignis', triggerBody:'Trigger-Rumpf (SQL-Anweisungen)', refTable:'Referenztabelle', refColumn:'Referenzspalte', foreignKey:'Fremdschlüssel', noMatches:'Keine Treffer', copied:'Zeile kopiert' },
  es: { sqlCommand:'Comando SQL', import:'Importar', export:'Exportar', createTable:'Crear tabla', alterTable:'Modificar tabla', selectData:'Ver datos', structure:'Estructura', newItem:'Nuevo registro', edit:'editar', del:'eliminar', save:'Guardar', cancel:'Cancelar', refresh:'Actualizar', execute:'Ejecutar', clear:'Limpiar', rows:'filas', page:'Página', prev:'<', next:'>', indexes:'Índices', foreignKeys:'Claves foráneas', triggers:'Disparadores', ddl:'Código CREATE', columns:'Columnas', name:'Nombre', type:'Tipo', nullable:'Anulable', default:'Predeterminado', primaryKey:'Clave primaria', unique:'Único', importSql:'Importar SQL / CSV', importHint:'Pegue sentencias SQL (o datos CSV con encabezado) o elija un archivo.', loading:'Cargando...', noTables:'Sin tablas', noRows:'Sin datos', views:'Vistas', db:'D1', table:'Tabla', tableName:'Nombre de la tabla', format:'Formato', file:'Archivo', executed:'sentencia(s) ejecutada(s)', actions:'Acciones', where:'WHERE', rowsPerPage:'Filas', size:'Tamaño', addColumn:'Agregar columna', dropColumn:'Eliminar columna', renameColumn:'Renombrar columna', renameTable:'Renombrar tabla', addIndex:'Agregar índice', dropIndex:'Eliminar índice', column:'Columna', length:'Longitud', notnull:'NOT NULL', autoIncrement:'Autoincremento', add:'Agregar', remove:'Eliminar', drop:'Eliminar', empty:'Vaciar', confirmDrop:'¿Eliminar este objeto? No se puede deshacer.', confirmEmpty:'¿Eliminar TODAS las filas de esta tabla?', confirmDelete:'¿Eliminar esta fila?', newTableName:'Nuevo nombre', from:'De', to:'A', ifNotExists:'SI NO EXISTE', affected:'fila(s) afectada(s)', selectTable:'Seleccione una tabla a la izquierda.', search:'Buscar', searchHint:'Buscar texto en todas las tablas', clone:'clonar', print:'Imprimir', createView:'Crear vista', createTrigger:'Crear disparador', first:'<<', last:'>>', structureOnly:'Solo estructura', dataOnly:'Solo datos', both:'Estructura + datos', skipErrors:'Omitir errores', history:'Historial', filter:'Filtrar', viewName:'Nombre de la vista', selectSql:'Sentencia SELECT', triggerName:'Nombre del disparador', timing:'Momento', event:'Evento', triggerBody:'Cuerpo del disparador (sentencias SQL)', refTable:'Tabla de referencia', refColumn:'Columna de referencia', foreignKey:'Clave foránea', noMatches:'Sin coincidencias', copied:'fila copiada' },
  ru: { sqlCommand:'SQL-команда', import:'Импорт', export:'Экспорт', createTable:'Создать таблицу', alterTable:'Изменить таблицу', selectData:'Показать данные', structure:'Структура', newItem:'Новая запись', edit:'изменить', del:'удалить', save:'Сохранить', cancel:'Отмена', refresh:'Обновить', execute:'Выполнить', clear:'Очистить', rows:'строк', page:'Страница', prev:'<', next:'>', indexes:'Индексы', foreignKeys:'Внешние ключи', triggers:'Триггеры', ddl:'Код CREATE', columns:'Столбцы', name:'Имя', type:'Тип', nullable:'Может быть NULL', default:'По умолчанию', primaryKey:'Первичный ключ', unique:'Уникальный', importSql:'Импорт SQL / CSV', importHint:'Вставьте SQL-операторы (или CSV-данные с заголовком) или выберите файл.', loading:'Загрузка...', noTables:'Нет таблиц', noRows:'Нет данных', views:'Представления', db:'D1', table:'Таблица', tableName:'Имя таблицы', format:'Формат', file:'Файл', executed:'выполнено операторов', actions:'Действия', where:'WHERE', rowsPerPage:'Строк', size:'Размер', addColumn:'Добавить столбец', dropColumn:'Удалить столбец', renameColumn:'Переименовать столбец', renameTable:'Переименовать таблицу', addIndex:'Добавить индекс', dropIndex:'Удалить индекс', column:'Столбец', length:'Длина', notnull:'NOT NULL', autoIncrement:'Автоинкремент', add:'Добавить', remove:'Удалить', drop:'Удалить', empty:'Очистить', confirmDrop:'Удалить этот объект? Действие необратимо.', confirmEmpty:'Удалить ВСЕ строки этой таблицы?', confirmDelete:'Удалить эту строку?', newTableName:'Новое имя', from:'Из', to:'В', ifNotExists:'ЕСЛИ НЕ СУЩЕСТВУЕТ', affected:'затронуто строк', selectTable:'Выберите таблицу слева.', search:'Поиск', searchHint:'Поиск текста во всех таблицах', clone:'клонировать', print:'Печать', createView:'Создать представление', createTrigger:'Создать триггер', first:'<<', last:'>>', structureOnly:'Только структура', dataOnly:'Только данные', both:'Структура + данные', skipErrors:'Пропускать ошибки', history:'История', filter:'Фильтр', viewName:'Имя представления', selectSql:'Оператор SELECT', triggerName:'Имя триггера', timing:'Момент', event:'Событие', triggerBody:'Тело триггера (SQL-операторы)', refTable:'Ссылочная таблица', refColumn:'Ссылочный столбец', foreignKey:'Внешний ключ', noMatches:'Совпадений нет', copied:'строка скопирована' },
  pt: { sqlCommand:'Comando SQL', import:'Importar', export:'Exportar', createTable:'Criar tabela', alterTable:'Alterar tabela', selectData:'Ver dados', structure:'Estrutura', newItem:'Novo registro', edit:'editar', del:'excluir', save:'Salvar', cancel:'Cancelar', refresh:'Atualizar', execute:'Executar', clear:'Limpar', rows:'linhas', page:'Página', prev:'<', next:'>', indexes:'Índices', foreignKeys:'Chaves estrangeiras', triggers:'Gatilhos', ddl:'Código CREATE', columns:'Colunas', name:'Nome', type:'Tipo', nullable:'Anulável', default:'Padrão', primaryKey:'Chave primária', unique:'Único', importSql:'Importar SQL / CSV', importHint:'Cole instruções SQL (ou dados CSV com cabeçalho) ou escolha um arquivo.', loading:'Carregando...', noTables:'Sem tabelas', noRows:'Sem dados', views:'Visualizações', db:'D1', table:'Tabela', tableName:'Nome da tabela', format:'Formato', file:'Arquivo', executed:'instrução(ões) executada(s)', actions:'Ações', where:'WHERE', rowsPerPage:'Linhas', size:'Tamanho', addColumn:'Adicionar coluna', dropColumn:'Excluir coluna', renameColumn:'Renomear coluna', renameTable:'Renomear tabela', addIndex:'Adicionar índice', dropIndex:'Excluir índice', column:'Coluna', length:'Comprimento', notnull:'NOT NULL', autoIncrement:'Autoincremento', add:'Adicionar', remove:'Excluir', drop:'Excluir', empty:'Esvaziar', confirmDrop:'Excluir este objeto? Não pode ser desfeito.', confirmEmpty:'Excluir TODAS as linhas desta tabela?', confirmDelete:'Excluir esta linha?', newTableName:'Novo nome', from:'De', to:'Para', ifNotExists:'SE NÃO EXISTIR', affected:'linha(s) afetada(s)', selectTable:'Selecione uma tabela à esquerda.', search:'Pesquisar', searchHint:'Pesquisar texto em todas as tabelas', clone:'clonar', print:'Imprimir', createView:'Criar visualização', createTrigger:'Criar gatilho', first:'<<', last:'>>', structureOnly:'Somente estrutura', dataOnly:'Somente dados', both:'Estrutura + dados', skipErrors:'Ignorar erros', history:'Histórico', filter:'Filtrar', viewName:'Nome da visualização', selectSql:'Instrução SELECT', triggerName:'Nome do gatilho', timing:'Momento', event:'Evento', triggerBody:'Corpo do gatilho (instruções SQL)', refTable:'Tabela de referência', refColumn:'Coluna de referência', foreignKey:'Chave estrangeira', noMatches:'Sem correspondências', copied:'linha copiada' },
  it: { sqlCommand:'Comando SQL', import:'Importa', export:'Esporta', createTable:'Crea tabella', alterTable:'Modifica tabella', selectData:'Visualizza dati', structure:'Struttura', newItem:'Nuovo record', edit:'modifica', del:'elimina', save:'Salva', cancel:'Annulla', refresh:'Aggiorna', execute:'Esegui', clear:'Pulisci', rows:'righe', page:'Pagina', prev:'<', next:'>', indexes:'Indici', foreignKeys:'Chiavi esterne', triggers:'Trigger', ddl:'Codice CREATE', columns:'Colonne', name:'Nome', type:'Tipo', nullable:'Annullabile', default:'Predefinito', primaryKey:'Chiave primaria', unique:'Unico', importSql:'Importa SQL / CSV', importHint:'Incolla istruzioni SQL (o dati CSV con intestazione) oppure scegli un file.', loading:'Caricamento...', noTables:'Nessuna tabella', noRows:'Nessun dato', views:'Viste', db:'D1', table:'Tabella', tableName:'Nome tabella', format:'Formato', file:'File', executed:'istruzione(i) eseguita(e)', actions:'Azioni', where:'WHERE', rowsPerPage:'Righe', size:'Dimensione', addColumn:'Aggiungi colonna', dropColumn:'Elimina colonna', renameColumn:'Rinomina colonna', renameTable:'Rinomina tabella', addIndex:'Aggiungi indice', dropIndex:'Elimina indice', column:'Colonna', length:'Lunghezza', notnull:'NOT NULL', autoIncrement:'Autoincremento', add:'Aggiungi', remove:'Elimina', drop:'Elimina', empty:'Svuota', confirmDrop:'Eliminare questo oggetto? Non annullabile.', confirmEmpty:'Eliminare TUTTE le righe di questa tabella?', confirmDelete:'Eliminare questa riga?', newTableName:'Nuovo nome', from:'Da', to:'A', ifNotExists:'SE NON ESISTE', affected:'riga(e) interessata(e)', selectTable:'Seleziona una tabella a sinistra.', search:'Cerca', searchHint:'Cerca testo in tutte le tabelle', clone:'clona', print:'Stampa', createView:'Crea vista', createTrigger:'Crea trigger', first:'<<', last:'>>', structureOnly:'Solo struttura', dataOnly:'Solo dati', both:'Struttura + dati', skipErrors:'Ignora errori', history:'Cronologia', filter:'Filtra', viewName:'Nome vista', selectSql:'Istruzione SELECT', triggerName:'Nome trigger', timing:'Momento', event:'Evento', triggerBody:'Corpo del trigger (istruzioni SQL)', refTable:'Tabella di riferimento', refColumn:'Colonna di riferimento', foreignKey:'Chiave esterna', noMatches:'Nessuna corrispondenza', copied:'riga copiata' }
};
function pickLangKey(nav){ nav = String(nav || 'en').toLowerCase().replace('_', '-'); if (LANG[nav]) return nav; var base = nav.split('-')[0]; if (LANG[base]) return base; return 'en'; }
var LANG_KEY = pickLangKey(navigator.language);
var L = LANG[LANG_KEY];
function t(k){ return (L[k] !== undefined ? L[k] : (LANG.en[k] !== undefined ? LANG.en[k] : k)); }
function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function qi(n){ return '"' + String(n).replace(/"/g, '""') + '"'; }
function $(id){ return document.getElementById(id); }
function busy(on){ $('ajaxstatus').textContent = on ? t('loading') : ''; }
var state = { view:'sql', table:'', type:'table', columns:[], pk:[], canRowid:false, page:1, size:50, total:0, rows:[], where:'', order:'', dir:'asc' };

function dbg(label, data){
  if (!DEBUG) return;
  var box = $('adminerDebug'); if (!box) return;
  box.style.display = 'block';
  var line = document.createElement('div');
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + label + ' ' + (data === undefined ? '' : (typeof data === 'string' ? data : JSON.stringify(data)));
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}
function apiGet(act, params){
  var u = apiBase + act, qs = [], k;
  for (k in (params || {})) { var v = params[k]; if (v !== undefined && v !== null && v !== '') qs.push(k + '=' + encodeURIComponent(v)); }
  if (qs.length) u += '&' + qs.join('&');
  dbg('GET ' + act, params);
  return fetch(u, { credentials:'include' }).then(function(r){ return r.json(); }).then(function(j){ dbg('GET ' + act + ' ->', j); return j; });
}
function apiPost(act, body){
  dbg('POST ' + act, body);
  return fetch(apiBase + act, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body || {}), credentials:'include' }).then(function(r){ return r.json(); }).then(function(j){ dbg('POST ' + act + ' ->', j); return j; });
}
function doPost(act, body, done){
  busy(true);
  apiPost(act, body).then(function(res){ busy(false); if (!res || !res.code) { if (DEBUG) dbg('ERROR ' + act, res); alert((res && res.data) || 'error'); return; } if (done) done(res); }).catch(function(e){ busy(false); if (DEBUG) dbg('EXC ' + act, String(e)); alert(String(e)); });
}
function setTitle(s){ $('h2').textContent = s; document.title = s; }
function setCrumb(parts){ $('breadcrumb').innerHTML = (parts && parts.length) ? parts.map(function(p, i){ return (i ? ' \u203a ' : '') + esc(p); }).join('') : ''; }
function tabs(html){ $('tabs').innerHTML = html; }
function tabBtn(label, code, active){ return '<a href="javascript:void(0)" onclick="' + code + '"' + (active ? ' class="active"' : '') + '>' + esc(label) + '</a>'; }
function notEditable(){ alert(t('selectTable')); }
function typeOptions(sel){ var h = ''; TYPE_LIST.forEach(function(x){ h += '<option value="' + x + '"' + (x === sel ? ' selected' : '') + '>' + x + '</option>'; }); return h; }

var tableList = [];
function loadTables(){
  var box = $('tables');
  $('tableFilter').style.display = '';
  $('tableFilterInput').placeholder = t('filter');
  apiGet('tables').then(function(res){
    if (!res || !res.code) { box.innerHTML = '<li class="error">' + esc(res && res.data) + '</li>'; return; }
    tableList = res.data || [];
    renderTableList('');
  });
  apiGet('info').then(function(res){ if (res && res.code && res.data) $('version').textContent = 'SQLite ' + (res.data.version || ''); });
}
function renderTableList(filter){
  var box = $('tables'), tablesHtml = '', viewsHtml = '', kw = (filter || '').toLowerCase();
  tableList.forEach(function(it){
    if (kw && String(it.name).toLowerCase().indexOf(kw) < 0) return;
    var a = '<a href="javascript:void(0)" data-table="' + esc(it.name) + '"' + (state.table === it.name ? ' class="active"' : '') + ' title="' + esc(it.name) + '">' + esc(it.name) + '</a>';
    if (it.type === 'view') viewsHtml += '<li>' + a + ' <a href="javascript:void(0)" data-edit-view="' + esc(it.name) + '" title="' + esc(t('edit')) + '">\u270E</a></li>'; else tablesHtml += '<li>' + a + '</li>';
  });
  box.innerHTML = (tablesHtml || viewsHtml) ? tablesHtml + (viewsHtml ? '<li><b>' + esc(t('views')) + '</b></li>' + viewsHtml : '') : '<li>' + esc(t('noTables')) + '</li>';
}
function filterTables(v){ renderTableList(v); }

function nav(view){
  if (view === 'sql') return showSql();
  if (view === 'search') return showSearch();
  if (view === 'import') return showImport();
  if (view === 'export') return showExport();
  if (view === 'create') return showCreate();
  if (view === 'createView') return showCreateView();
  if (view === 'createTrigger') return showCreateTrigger();
}
function tableTabs(active){
  tabs(
    tabBtn(t('selectData'), 'showTable(state.table)', active === 'data') +
    tabBtn(t('structure'), 'showStructure()', active === 'structure') +
    tabBtn(t('alterTable'), 'state.table && showAlter()', active === 'alter') +
    tabBtn(t('newItem'), 'state.table && showRow(null)', active === 'row') +
    tabBtn(t('export'), 'state.table && exportTable()', false)
  );
}

function sqlHistory(){ try { return JSON.parse(localStorage.getItem('adminer_sql_history') || '[]'); } catch(e){ return []; } }
function sqlHistoryPush(sql){
  var h = sqlHistory(); h = h.filter(function(x){ return x !== sql; }); h.unshift(sql); h = h.slice(0, 20);
  try { localStorage.setItem('adminer_sql_history', JSON.stringify(h)); } catch(e){}
}
function showSql(){
  state.view = 'sql'; state.table = ''; setTitle(t('sqlCommand')); setCrumb([t('sqlCommand')]); tabs('');
  var hist = sqlHistory(), histHtml = '';
  if (hist.length) {
    histHtml = '<select id="sqlHist" onchange="useHistory()"><option value="">' + esc(t('history')) + '</option>';
    hist.forEach(function(x, i){ histHtml += '<option value="' + i + '">' + esc(String(x).slice(0, 80)) + '</option>'; });
    histHtml += '</select> ';
  }
  $('page').innerHTML = '<p class="links">' +
    '<input type="button" value="' + esc(t('search')) + '" onclick="showSearch()"> ' +
    '<input type="button" value="' + esc(t('createView')) + '" onclick="showCreateView()"> ' +
    '<input type="button" value="' + esc(t('createTrigger')) + '" onclick="showCreateTrigger()"> ' +
    '</p>' +
    '<form onsubmit="return runSql();"><textarea id="sql" rows="8" style="width:100%"></textarea>' +
    '<p>' + histHtml + '<input type="submit" value="' + esc(t('execute')) + '"> <input type="button" value="' + esc(t('clear')) + '" onclick="clearSql()"></p></form><div id="result"></div>';
  var s = $('sql'); if (s) s.focus();
}
function useHistory(){
  var sel = $('sqlHist'), hist = sqlHistory();
  if (sel && sel.value !== '' && hist[sel.value]) { $('sql').value = hist[sel.value]; }
}
function clearSql(){ var s = $('sql'); if (s) s.value = ''; $('result').innerHTML = ''; }
function runSql(sqlOverride){
  var sql = sqlOverride || $('sql').value;
  if (!sql || !sql.trim()) return false;
  if (!sqlOverride) sqlHistoryPush(sql);
  $('sql').value = sql;
  $('result').innerHTML = '<p>' + t('loading') + '</p>';
  apiPost('query', { sql: sql }).then(function(res){ renderQueryResults('result', res); });
  return false;
}
function renderQueryResults(target, res){
  var box = $(target);
  if (!res || !res.code) { box.innerHTML = '<p class="error">' + esc(res && res.data) + '</p>'; return; }
  var results = (res.data && res.data.results) || [], html = '';
  results.forEach(function(r){
    html += '<div class="message">' + esc(r.sql) + '</div>';
    if (r.rows) { html += tableHtml(r.columns, r.rows); html += '<p>' + r.rows.length + ' ' + esc(t('rows')) + '</p>'; }
    else if (r.changes !== undefined) { html += '<p>' + r.changes + ' ' + esc(t('affected')) + '</p>'; }
    else { html += '<p>OK</p>'; }
  });
  box.innerHTML = html || '<p>OK</p>';
}
function tableHtml(columns, rows){
  var h = '<table class="nowrap checkable"><thead><tr>';
  (columns || []).forEach(function(c){ h += '<th>' + esc(c) + '</th>'; });
  h += '</tr></thead><tbody>';
  rows.forEach(function(row, i){
    h += '<tr class="' + (i % 2 ? 'odd' : 'even') + '">';
    (columns || []).forEach(function(c){ var v = row[c]; h += '<td>' + (v === null || v === undefined ? '<i>NULL</i>' : esc(v)) + '</td>'; });
    h += '</tr>';
  });
  h += '</tbody></table>';
  return h;
}

function showTable(name, page){
  if (!name) return;
  state.view = 'data'; state.table = name; state.page = page || 1; state.order = ''; state.dir = 'asc'; state.where = '';
  setTitle(t('table') + ': ' + name); setCrumb([t('db'), name]);
  tableTabs('data');
  loadData();
}
function loadData(){
  busy(true);
  apiGet('data', { table:state.table, page:state.page, size:state.size, where:state.where, order:state.order, dir:state.dir }).then(function(res){
    busy(false);
    if (!res || !res.code) { $('page').innerHTML = '<p class="error">' + esc(res && res.data) + '</p>'; return; }
    var d = res.data;
    state.columns = d.columns; state.pk = d.pk || []; state.canRowid = !!d.canRowid; state.type = d.type;
    state.total = d.total || 0; state.rows = d.rows || []; state.page = d.page; state.size = d.size;
    state.where = d.where || ''; state.order = d.order || ''; state.dir = d.dir || 'asc';
    renderData();
  });
}
function renderData(){
  var d = state, colNames = d.columns.map(function(c){ return c.name; });
  var pages = Math.max(1, Math.ceil(d.total / d.size)), editable = d.type !== 'view';
  var h = '';
  h += '<p>' + esc(t('where')) + ': <input type="text" id="whereInput" style="width:50%" value="' + esc(d.where) + '"> ';
  h += '<input type="button" value="' + esc(t('refresh')) + '" onclick="applyWhere()"></p>';
  h += '<p>' + esc(t('rowsPerPage')) + ' <input type="number" class="size" id="sizeInput" value="' + d.size + '" onchange="applySize()"> ';
  h += '<input type="button" value="' + esc(t('first')) + '" ' + (d.page <= 1 ? 'disabled' : 'onclick="gotoPage(1)"') + '> ';
  h += '<input type="button" value="' + esc(t('prev')) + '" ' + (d.page <= 1 ? 'disabled' : 'onclick="gotoPage(' + (d.page - 1) + ')"') + '> ';
  h += '<input type="button" value="' + esc(t('next')) + '" ' + (d.page >= pages ? 'disabled' : 'onclick="gotoPage(' + (d.page + 1) + ')"') + '> ';
  h += '<input type="button" value="' + esc(t('last')) + '" ' + (d.page >= pages ? 'disabled' : 'onclick="gotoPage(' + pages + ')"') + '> ';
  h += esc(t('page')) + ' ' + d.page + '/' + pages + ' (' + d.total + ' ' + esc(t('rows')) + ')</p>';
  var orderCols = (d.order || '').split(',').filter(Boolean);
  var orderDirs = (d.dir || '').split(',');
  h += '<table class="nowrap checkable"><thead><tr>';
  colNames.forEach(function(c){
    var oi = orderCols.indexOf(c);
    var mark = oi >= 0 ? (orderDirs[oi] === 'desc' ? ' \u2193' : ' \u2191') + (orderCols.length > 1 ? (oi + 1) : '') : '';
    h += '<th><a href="javascript:void(0)" data-sort="' + esc(c) + '">' + esc(c) + mark + '</a></th>';
  });
  if (editable) h += '<th>' + esc(t('actions')) + '</th>';
  h += '</tr></thead><tbody>';
  d.rows.forEach(function(row, i){
    h += '<tr class="' + (i % 2 ? 'odd' : 'even') + '">';
    colNames.forEach(function(c){ var v = row[c]; h += '<td>' + (v === null || v === undefined ? '<i>NULL</i>' : esc(v)) + '</td>'; });
    if (editable) h += '<td><a href="javascript:void(0)" onclick="showRow(state.rows[' + i + '])">' + esc(t('edit')) + '</a> <a href="javascript:void(0)" onclick="cloneRow(' + i + ')">' + esc(t('clone')) + '</a> <a href="javascript:void(0)" onclick="deleteRow(' + i + ')">' + esc(t('del')) + '</a></td>';
    h += '</tr>';
  });
  h += '</tbody></table>';
  if (!d.rows.length) h += '<p>' + esc(t('noRows')) + '</p>';
  $('page').innerHTML = h;
}
function gotoPage(p){ state.page = p; loadData(); }
function applyWhere(){ state.where = $('whereInput').value; state.page = 1; loadData(); }
function applySize(){ var v = parseInt($('sizeInput').value, 10); if (v > 0 && v <= 1000) { state.size = v; state.page = 1; loadData(); } }
function sortBy(c, additive){
  var cols = (state.order || '').split(',').filter(Boolean);
  var dirs = (state.dir || '').split(',').filter(Boolean);
  var i = cols.indexOf(c);
  if (additive) {
    if (i >= 0) { dirs[i] = (dirs[i] === 'desc' ? 'asc' : 'desc'); }
    else { cols.push(c); dirs.push('asc'); }
  } else {
    if (cols.length === 1 && i === 0) { dirs[0] = (dirs[0] === 'desc' ? 'asc' : 'desc'); }
    else { cols = [c]; dirs = ['asc']; }
  }
  state.order = cols.join(','); state.dir = dirs.join(',');
  state.page = 1; loadData();
}
function printView(){ window.print(); }
function cloneRow(i){
  var src = state.rows[i], values = {};
  state.columns.forEach(function(c){ values[c.name] = (state.pk.indexOf(c.name) >= 0) ? null : src[c.name]; });
  window.__cloneValues = values;
  showRow(null);
}

function rowLocator(row){
  var loc = { pk:{}, rowid:null };
  if (state.pk.length) { state.pk.forEach(function(k){ loc.pk[k] = row[k]; }); }
  else if (state.canRowid && row.__rowid__ !== undefined) { loc.rowid = row.__rowid__; }
  return loc;
}
function showRow(row){
  state.view = 'row';
  var isEdit = !!row, title = (isEdit ? t('edit') : t('newItem')) + ' ' + state.table;
  setTitle(title); setCrumb([t('db'), state.table, isEdit ? t('edit') : t('newItem')]);
  tableTabs('row');
  var h = '<form onsubmit="return saveRow(event)"><table class="nowrap"><tbody>';
  state.columns.forEach(function(c){
    var v = row ? row[c.name] : (window.__cloneValues ? window.__cloneValues[c.name] : null);
    var isText = /TEXT|CLOB|CHAR/i.test(c.type || '');
    var nullChecked = row && (v === null || v === undefined) ? ' checked' : '';
    h += '<tr><th>' + esc(c.name) + '<div class="field-type">' + esc(c.type || '') + (c.notnull ? ' NOT NULL' : '') + (c.pk ? ' [PK]' : '') + '</div></th>';
    if (isText) {
      h += '<td><textarea data-col="' + esc(c.name) + '" rows="2" style="width:90%">' + (v === null || v === undefined ? '' : esc(v)) + '</textarea> <label><input type="checkbox" data-null="' + esc(c.name) + '"' + nullChecked + '> NULL</label></td></tr>';
    } else {
      h += '<td><input data-col="' + esc(c.name) + '" value="' + (v === null || v === undefined ? '' : esc(v)) + '"> <label><input type="checkbox" data-null="' + esc(c.name) + '"' + nullChecked + '> NULL</label></td></tr>';
    }
  });
  h += '</tbody></table><p><input type="submit" value="' + esc(t('save')) + '"> <input type="button" value="' + esc(t('cancel')) + '" onclick="showTable(state.table, state.page)"></p></form>';
  $('page').innerHTML = h;
  window.__editRow = row || null;
  window.__cloneValues = null;
}
function saveRow(ev){
  ev.preventDefault();
  var isEdit = !!window.__editRow, values = {};
  state.columns.forEach(function(c){
    var nb = document.querySelector('[data-null="' + c.name.replace(/"/g, '\\\\"') + '"]');
    var inp = document.querySelector('[data-col="' + c.name.replace(/"/g, '\\\\"') + '"]');
    values[c.name] = (nb && nb.checked) ? null : (inp ? inp.value : null);
  });
  var payload = { action: isEdit ? 'update' : 'insert', table: state.table, values: values };
  if (isEdit) { var loc = rowLocator(window.__editRow); payload.pk = loc.pk; payload.rowid = loc.rowid; }
  doPost('row', payload, function(){ window.__editRow = null; showTable(state.table, state.page); });
  return false;
}
function deleteRow(i){
  if (!confirm(t('confirmDelete'))) return;
  var loc = rowLocator(state.rows[i]);
  doPost('row', { action:'delete', table:state.table, pk:loc.pk, rowid:loc.rowid }, function(){ showTable(state.table, state.page); });
}

function showStructure(){
  if (!state.table) return notEditable();
  state.view = 'structure';
  setTitle(t('structure') + ': ' + state.table); setCrumb([t('db'), state.table, t('structure')]); tableTabs('structure');
  $('page').innerHTML = '<p>' + t('loading') + '</p>';
  apiGet('structure', { table: state.table }).then(renderStructure);
}
function renderStructure(res){
  if (!res || !res.code) { $('page').innerHTML = '<p class="error">' + esc(res && res.data) + '</p>'; return; }
  var d = res.data, h = '';
  h += '<p class="links"><input type="button" value="' + esc(t('selectData')) + '" onclick="showTable(state.table)"> ';
  h += '<input type="button" value="' + esc(t('alterTable')) + '" onclick="showAlter()"> ';
  h += '<input type="button" value="' + esc(t('empty')) + '" onclick="emptyTable()"> ';
  h += '<input type="button" value="' + esc(t('drop')) + '" onclick="dropObject()"></p>';
  h += '<h3>' + esc(t('columns')) + '</h3><table class="nowrap checkable"><thead><tr><th>#</th><th>' + esc(t('name')) + '</th><th>' + esc(t('type')) + '</th><th>' + esc(t('nullable')) + '</th><th>' + esc(t('default')) + '</th><th>' + esc(t('primaryKey')) + '</th></tr></thead><tbody>';
  (d.columns || []).forEach(function(c){
    h += '<tr><td>' + esc(c.cid) + '</td><td>' + esc(c.name) + '</td><td>' + esc(c.type) + '</td><td>' + (c.notnull ? '' : 'YES') + '</td><td>' + esc(c.dflt_value) + '</td><td>' + (c.pk ? esc(t('primaryKey')) : '') + '</td></tr>';
  });
  h += '</tbody></table>';
  if ((d.indexes || []).length) {
    h += '<h3>' + esc(t('indexes')) + '</h3><table class="nowrap"><thead><tr><th>' + esc(t('name')) + '</th><th>' + esc(t('unique')) + '</th><th>' + esc(t('columns')) + '</th><th>' + esc(t('actions')) + '</th></tr></thead><tbody>';
    d.indexes.forEach(function(ix){ h += '<tr><td>' + esc(ix.name) + '</td><td>' + (ix.unique ? 'YES' : '') + '</td><td>' + esc((ix.columns || []).join(', ')) + '</td><td>' + (ix.origin === 'c' ? '<a href="javascript:void(0)" data-drop="index" data-drop-name="' + esc(ix.name) + '">' + esc(t('del')) + '</a>' : '') + '</td></tr>'; });
    h += '</tbody></table>';
  }
  if ((d.foreignKeys || []).length) {
    h += '<h3>' + esc(t('foreignKeys')) + '</h3><table class="nowrap"><thead><tr><th>' + esc(t('name')) + '</th><th>' + esc(t('table')) + '</th><th>' + esc(t('columns')) + '</th></tr></thead><tbody>';
    d.foreignKeys.forEach(function(fk){ h += '<tr><td>' + esc(fk.from) + '</td><td>' + esc(fk.table) + '</td><td>' + esc(fk.to) + '</td></tr>'; });
    h += '</tbody></table>';
  }
  if ((d.triggers || []).length) {
    h += '<h3>' + esc(t('triggers')) + '</h3><table class="nowrap"><thead><tr><th>' + esc(t('name')) + '</th><th>SQL</th><th>' + esc(t('actions')) + '</th></tr></thead><tbody>';
    d.triggers.forEach(function(g){ h += '<tr><td>' + esc(g.name) + '</td><td>' + esc(g.sql) + '</td><td><a href="javascript:void(0)" data-drop="trigger" data-drop-name="' + esc(g.name) + '">' + esc(t('del')) + '</a></td></tr>'; });
    h += '</tbody></table>';
  }
  h += '<h3>' + esc(t('ddl')) + '</h3><pre class="message">' + esc(d.sql) + '</pre>';
  $('page').innerHTML = h;
}
function dropObject(){
  if (!state.table) return;
  if (!confirm(t('confirmDrop'))) return;
  doPost('drop', { type: state.type === 'view' ? 'view' : 'table', name: state.table }, function(){
    state.table = ''; loadTables(); showSql();
  });
}
function dropObjectByName(type, name){
  if (!confirm(t('confirmDrop'))) return;
  doPost('drop', { type: type, name: name }, function(){ loadTables(); if (state.table) showStructure(); });
}
function emptyTable(){
  if (!state.table) return;
  if (!confirm(t('confirmEmpty'))) return;
  apiPost('query', { sql: 'DELETE FROM ' + qi(state.table) }).then(function(){ loadTables(); loadData(); });
}
function exportTable(){ if (state.table) window.open(apiBase + 'export&table=' + encodeURIComponent(state.table), '_blank'); }

function showSearch(){
  state.view = 'search'; state.table = ''; setTitle(t('search')); setCrumb([t('search')]); tabs('');
  $('page').innerHTML = '<p>' + esc(t('searchHint')) + '</p><form onsubmit="return runSearch()">' +
    '<input type="text" id="searchInput" style="width:50%"> <input type="submit" value="' + esc(t('execute')) + '"></form><div id="result"></div>';
  $('searchInput').focus();
}
function runSearch(){
  var q = $('searchInput').value.trim();
  if (!q) return false;
  $('result').innerHTML = '<p>' + t('loading') + '</p>';
  apiGet('search', { q: q }).then(function(res){
    var box = $('result');
    if (!res || !res.code) { box.innerHTML = '<p class="error">' + esc(res && res.data) + '</p>'; return; }
    var results = (res.data && res.data.results) || [], h = '';
    if (!results.length) { box.innerHTML = '<p>' + esc(t('noMatches')) + '</p>'; return; }
    results.forEach(function(r){
      h += '<h3>' + esc(r.table) + ' (' + r.rows.length + ' ' + esc(t('rows')) + ')</h3>';
      h += tableHtml(r.columns, r.rows);
    });
    box.innerHTML = h;
  });
  return false;
}

function showCreateView(pre){
  pre = pre || {};
  state.view = 'createView'; state.table = ''; setTitle(t('createView')); setCrumb([t('createView')]); tabs('');
  $('page').innerHTML = '<form onsubmit="return submitCreateView(event)">' +
    '<p>' + esc(t('viewName')) + ': <input id="cvName" autocomplete="off" value="' + esc(pre.name || '') + '"> <label><input type="checkbox" id="cvReplace"' + (pre.replace ? ' checked' : '') + '> OR REPLACE</label></p>' +
    '<p>' + esc(t('selectSql')) + ':</p>' +
    '<textarea id="cvSql" rows="6" style="width:100%">' + esc(pre.sql || '') + '</textarea>' +
    '<p><input type="submit" value="' + esc(t('save')) + '"> <input type="button" value="' + esc(t('cancel')) + '" onclick="nav(&quot;sql&quot;)"></p></form><div id="result"></div>';
}
function editView(name){
  apiGet('structure', { table: name }).then(function(res){
    if (!res || !res.code) { alert((res && res.data) || 'error'); return; }
    showCreateView({ name: name, sql: res.data.sql, replace: true });
  });
}
function submitCreateView(ev){
  ev.preventDefault();
  var name = $('cvName').value.trim();
  var sql = $('cvSql').value.trim();
  if (!name || !sql) return false;
  doPost('createView', { name: name, sql: sql, replace: $('cvReplace').checked }, function(res){
    $('result').innerHTML = '<p class="message">' + esc((res.data.executed || []).join('; ')) + '</p>';
    loadTables();
  });
  return false;
}

function showCreateTrigger(){
  state.view = 'createTrigger'; state.table = ''; setTitle(t('createTrigger')); setCrumb([t('createTrigger')]); tabs('');
  $('page').innerHTML = '<p>' + t('loading') + '</p>';
  apiGet('tables').then(function(res){
    var list = (res && res.data) || [], opts = '';
    list.forEach(function(it){ if (it.type !== 'view') opts += '<option value="' + esc(it.name) + '">' + esc(it.name) + '</option>'; });
    $('page').innerHTML = '<form onsubmit="return submitCreateTrigger(event)">' +
      '<p>' + esc(t('triggerName')) + ': <input id="ctName" autocomplete="off"></p>' +
      '<p>' + esc(t('table')) + ': <select id="ctTable">' + opts + '</select> ' +
      esc(t('timing')) + ': <select id="ctTiming"><option>BEFORE</option><option>AFTER</option><option>INSTEAD OF</option></select> ' +
      esc(t('event')) + ': <select id="ctEvent"><option>INSERT</option><option>UPDATE</option><option>DELETE</option></select></p>' +
      '<p>' + esc(t('triggerBody')) + ':</p>' +
      '<textarea id="ctSql" rows="6" style="width:100%"></textarea>' +
      '<p><input type="submit" value="' + esc(t('save')) + '"> <input type="button" value="' + esc(t('cancel')) + '" onclick="nav(&quot;sql&quot;)"></p></form><div id="result"></div>';
  });
}
function submitCreateTrigger(ev){
  ev.preventDefault();
  var name = $('ctName').value.trim();
  var table = $('ctTable').value;
  var timing = $('ctTiming').value;
  var event = $('ctEvent').value;
  var sql = $('ctSql').value.trim();
  if (!name || !table || !sql) return false;
  doPost('createTrigger', { name: name, table: table, timing: timing, event: event, sql: sql }, function(res){
    $('result').innerHTML = '<p class="message">' + esc((res.data.executed || []).join('; ')) + '</p>';
    loadTables();
  });
  return false;
}

function showCreate(){
  state.view = 'create'; state.table = ''; setTitle(t('createTable')); setCrumb([t('createTable')]); tabs('');
  var h = '<form id="createForm" onsubmit="return submitCreate(event)">';
  h += '<p>' + esc(t('tableName')) + ': <input id="createName" autocomplete="off"> <label><input type="checkbox" id="createIfNotExists"> ' + esc(t('ifNotExists')) + '</label></p>';
  h += '<table class="nowrap"><thead><tr><th>#</th><th>' + esc(t('name')) + '</th><th>' + esc(t('type')) + '</th><th>' + esc(t('length')) + '</th><th>' + esc(t('default')) + '</th><th>' + esc(t('notnull')) + '</th><th>' + esc(t('autoIncrement')) + '</th><th>' + esc(t('primaryKey')) + '</th><th>' + esc(t('refTable')) + '</th><th></th></tr></thead><tbody id="cols"></tbody></table>';
  h += '<p><input type="button" value="' + esc(t('addColumn')) + '" onclick="addColRow()"></p>';
  h += '<h3>' + esc(t('indexes')) + '</h3><table class="nowrap"><thead><tr><th>' + esc(t('name')) + '</th><th>' + esc(t('columns')) + '</th><th>' + esc(t('unique')) + '</th><th></th></tr></thead><tbody id="idxs"></tbody></table>';
  h += '<p><input type="button" value="' + esc(t('addIndex')) + '" onclick="addIdxRow()"></p>';
  h += '<p><input type="submit" value="' + esc(t('save')) + '"> <input type="button" value="' + esc(t('cancel')) + '" onclick="nav(&quot;sql&quot;)"></p></form><div id="result"></div>';
  $('page').innerHTML = h;
  addColRow(); addColRow(); addColRow();
}
function addColRow(){
  var tr = document.createElement('tr');
  tr.innerHTML = '<td class="colnum"></td>' +
    '<td><input data-f="name"></td>' +
    '<td><select data-f="type">' + typeOptions('TEXT') + '</select></td>' +
    '<td><input data-f="length" class="size"></td>' +
    '<td><input data-f="default"></td>' +
    '<td><input type="checkbox" data-f="notnull"></td>' +
    '<td><input type="checkbox" data-f="ai"></td>' +
    '<td><input type="checkbox" data-f="pk"></td>' +
    '<td><input data-f="refTable" class="size"></td>' +
    '<td><input type="button" value="x" onclick="removeRow(this)"></td>';
  $('cols').appendChild(tr); renumber();
}
function addIdxRow(){
  var tr = document.createElement('tr');
  tr.innerHTML = '<td><input data-f="iname"></td><td><input data-f="icols" placeholder="a,b"></td><td><input type="checkbox" data-f="iuniq"></td><td><input type="button" value="x" onclick="removeRow(this)"></td>';
  $('idxs').appendChild(tr);
}
function removeRow(btn){ var tr = btn.parentNode.parentNode; tr.parentNode.removeChild(tr); renumber(); }
function renumber(){ var trs = $('cols').querySelectorAll('tr'); for (var i = 0; i < trs.length; i++){ var c = trs[i].querySelector('.colnum'); if (c) c.textContent = String(i + 1); } }
function submitCreate(ev){
  ev.preventDefault();
  var name = $('createName').value.trim();
  if (!name) { alert(t('tableName')); return false; }
  var cols = [], trs = $('cols').querySelectorAll('tr');
  for (var i = 0; i < trs.length; i++){
    var g = function(f){ return trs[i].querySelector('[data-f="' + f + '"]'); };
    var cn = g('name').value.trim(); if (!cn) continue;
    var refTable = (g('refTable') ? g('refTable').value.trim() : '');
    var colObj = { name:cn, type:g('type').value, length:g('length').value, default:g('default').value, notnull:g('notnull').checked, autoIncrement:g('ai').checked, pk:g('pk').checked };
    if (refTable) colObj.foreignKey = { refTable: refTable };
    cols.push(colObj);
  }
  var idxs = [], itrs = $('idxs').querySelectorAll('tr');
  for (var j = 0; j < itrs.length; j++){
    var cs = itrs[j].querySelector('[data-f="icols"]').value.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    if (!cs.length) continue;
    idxs.push({ name: itrs[j].querySelector('[data-f="iname"]').value.trim(), columns: cs, unique: itrs[j].querySelector('[data-f="iuniq"]').checked });
  }
  doPost('create', { name:name, ifNotExists:$('createIfNotExists').checked, columns:cols, indexes:idxs }, function(){ loadTables(); showTable(name); });
  return false;
}

function showAlter(){
  if (!state.table) return notEditable();
  state.view = 'alter';
  setTitle(t('alterTable') + ': ' + state.table); setCrumb([t('db'), state.table, t('alterTable')]); tableTabs('alter');
  $('page').innerHTML = '<p>' + t('loading') + '</p>';
  apiGet('structure', { table: state.table }).then(function(res){
    if (!res || !res.code) { $('page').innerHTML = '<p class="error">' + esc(res && res.data) + '</p>'; return; }
    var d = res.data, colOpts = '', idxOpts = '';
    (d.columns || []).forEach(function(c){ colOpts += '<option value="' + esc(c.name) + '">' + esc(c.name) + '</option>'; });
    (d.indexes || []).forEach(function(ix){ idxOpts += '<option value="' + esc(ix.name) + '">' + esc(ix.name) + '</option>'; });
    var h = '';
    h += '<fieldset><legend>' + esc(t('renameTable')) + '</legend><div>' + esc(t('newTableName')) + ': <input id="rnTable"> <input type="button" value="' + esc(t('save')) + '" onclick="alterRename()"></div></fieldset>';
    h += '<fieldset><legend>' + esc(t('addColumn')) + '</legend><div>' + esc(t('name')) + ': <input id="acName"> ' + esc(t('type')) + ': <select id="acType">' + typeOptions('TEXT') + '</select> ' + esc(t('length')) + ': <input id="acLen" class="size"> <label><input type="checkbox" id="acNull"> ' + esc(t('notnull')) + '</label> ' + esc(t('default')) + ': <input id="acDefault"> <input type="button" value="' + esc(t('add')) + '" onclick="alterAddColumn()"></div></fieldset>';
    h += '<fieldset><legend>' + esc(t('dropColumn')) + '</legend><div><select id="dcName">' + colOpts + '</select> <input type="button" value="' + esc(t('remove')) + '" onclick="alterDropColumn()"></div></fieldset>';
    h += '<fieldset><legend>' + esc(t('renameColumn')) + '</legend><div><select id="rcFrom">' + colOpts + '</select> \u2192 <input id="rcTo"> <input type="button" value="' + esc(t('save')) + '" onclick="alterRenameColumn()"></div></fieldset>';
    h += '<fieldset><legend>' + esc(t('addIndex')) + '</legend><div>' + esc(t('name')) + ': <input id="aiName"> ' + esc(t('columns')) + ': <input id="aiCols" placeholder="a,b"> <label><input type="checkbox" id="aiUniq"> ' + esc(t('unique')) + '</label> <input type="button" value="' + esc(t('add')) + '" onclick="alterAddIndex()"></div></fieldset>';
    h += '<fieldset><legend>' + esc(t('dropIndex')) + '</legend><div><select id="diName">' + idxOpts + '</select> <input type="button" value="' + esc(t('remove')) + '" onclick="alterDropIndex()"></div></fieldset>';
    h += '<div id="result"></div>';
    $('page').innerHTML = h;
  });
}
function alterDone(res){ if (!res || !res.code) { alert((res && res.data) || 'error'); return; } if ($('result')) $('result').innerHTML = '<p class="message">' + esc((res.data.executed || []).join('; ')) + '</p>'; loadTables(); }
function alterRename(){ var to = $('rnTable').value.trim(); if (!to) return; doPost('alter', { table:state.table, op:'renameTable', to:to }, function(res){ state.table = to; showTable(to); alterDone(res); }); }
function alterAddColumn(){ var n = $('acName').value.trim(); if (!n) return; doPost('alter', { table:state.table, op:'addColumn', name:n, type:$('acType').value, length:$('acLen').value, notnull:$('acNull').checked, default:$('acDefault').value }, function(res){ showAlter(); alterDone(res); }); }
function alterDropColumn(){ var n = $('dcName').value; if (!n || !confirm(t('confirmDrop'))) return; doPost('alter', { table:state.table, op:'dropColumn', name:n }, function(res){ showAlter(); alterDone(res); }); }
function alterRenameColumn(){ var f = $('rcFrom').value, to = $('rcTo').value.trim(); if (!f || !to) return; doPost('alter', { table:state.table, op:'renameColumn', from:f, to:to }, function(res){ showAlter(); alterDone(res); }); }
function alterAddIndex(){ var cs = $('aiCols').value.split(',').map(function(s){ return s.trim(); }).filter(Boolean); if (!cs.length) return; doPost('alter', { table:state.table, op:'addIndex', name:$('aiName').value.trim(), columns:cs, unique:$('aiUniq').checked }, function(res){ showAlter(); alterDone(res); }); }
function alterDropIndex(){ var n = $('diName').value; if (!n || !confirm(t('confirmDrop'))) return; doPost('alter', { table:state.table, op:'dropIndex', name:n }, function(res){ showAlter(); alterDone(res); }); }

function showExport(){
  state.view = 'export'; state.table = ''; setTitle(t('export')); setCrumb([t('export')]); tabs('');
  $('page').innerHTML = '<p>' + t('loading') + '</p>';
  apiGet('tables').then(function(res){
    var list = (res && res.data) || [], h = '<form onsubmit="return doExport();">';
    h += '<table class="nowrap"><thead><tr><th><input type="checkbox" id="chkAll" onchange="toggleAll(this)"></th><th>' + esc(t('name')) + '</th><th>' + esc(t('type')) + '</th></tr></thead><tbody>';
    list.forEach(function(it){ h += '<tr><td><input type="checkbox" class="expTbl" value="' + esc(it.name) + '"></td><td>' + esc(it.name) + '</td><td>' + esc(it.type) + '</td></tr>'; });
    h += '</tbody></table><p>' + esc(t('format')) + ': <select id="expFmt"><option value="sql">SQL</option><option value="csv">CSV</option><option value="tsv">TSV</option><option value="json">JSON</option><option value="xml">XML</option></select> ';
    h += '<select id="expMode"><option value="both">' + esc(t('both')) + '</option><option value="structure">' + esc(t('structureOnly')) + '</option><option value="data">' + esc(t('dataOnly')) + '</option></select> ';
    h += '<label><input type="checkbox" id="expGzip"> gzip</label></p>';
    h += '<p>' + esc(t('columns')) + ': <input type="text" id="expCols" style="width:70%" placeholder="' + esc(t('columnsHint')) + '"></p>';
    h += '<p><input type="submit" value="' + esc(t('export')) + '"></p></form>';
    $('page').innerHTML = h;
  });
}
function toggleAll(box){ var c = document.querySelectorAll('.expTbl'); for (var i = 0; i < c.length; i++) c[i].checked = box.checked; }
function doExport(){
  var sel = document.querySelectorAll('.expTbl'), names = [];
  for (var i = 0; i < sel.length; i++){ if (sel[i].checked) names.push(sel[i].value); }
  var cols = ($('expCols') ? $('expCols').value.trim() : '');
  var gzip = ($('expGzip') ? $('expGzip').checked : false);
  var u = apiBase + 'export&format=' + $('expFmt').value + '&mode=' + $('expMode').value +
    (names.length ? ('&tables=' + encodeURIComponent(names.join(','))) : '') +
    (cols ? ('&columns=' + encodeURIComponent(cols)) : '') +
    (gzip ? '&gzip=1' : '');
  window.open(u, '_blank');
  return false;
}

function showImport(){
  state.view = 'import'; state.table = ''; setTitle(t('importSql')); setCrumb([t('import')]); tabs('');
  $('page').innerHTML = '<p>' + t('loading') + '</p>';
  apiGet('tables').then(function(res){
    var list = (res && res.data) || [], opts = '';
    list.forEach(function(it){ if (it.type !== 'view') opts += '<option value="' + esc(it.name) + '">' + esc(it.name) + '</option>'; });
    var h = '<form id="impForm" onsubmit="return doImport(event)">';
    h += '<p>' + esc(t('format')) + ': <select id="impFmt" onchange="importFmtChange()"><option value="sql">SQL</option><option value="csv">CSV</option><option value="tsv">TSV</option></select> ';
    h += '<span id="impTableWrap" style="display:none">' + esc(t('table')) + ': <select id="impTable">' + opts + '</select></span></p>';
    h += '<p>' + esc(t('file')) + ': <input type="file" id="impFile"></p>';
    h += '<p><textarea id="impSql" rows="12" style="width:100%" placeholder="' + esc(t('importHint')) + '"></textarea></p>';
    h += '<p><label><input type="checkbox" id="impSkip"> ' + esc(t('skipErrors')) + '</label></p>';
    h += '<p><input type="submit" value="' + esc(t('execute')) + '"></p></form><div id="result"></div>';
    $('page').innerHTML = h;
  });
}
function importFmtChange(){ var f = $('impFmt').value; $('impTableWrap').style.display = (f === 'csv' || f === 'tsv') ? '' : 'none'; }
function doImport(ev){
  ev.preventDefault();
  var fmt = $('impFmt').value, table = $('impTable') ? $('impTable').value : '', file = $('impFile').files[0], text = $('impSql').value;
  var skip = $('impSkip') ? $('impSkip').checked : false;
  $('result').innerHTML = '<p>' + t('loading') + '</p>';
  var p;
  if (file){
    var fd = new FormData(); fd.append('format', fmt); fd.append('table', table); fd.append('skipErrors', skip ? '1' : '0'); fd.append('file', file);
    p = fetch(apiBase + 'import', { method:'POST', body:fd, credentials:'include' }).then(function(r){ return r.json(); });
  } else {
    p = apiPost('import', { format:fmt, table:table, skipErrors:skip, sql:text });
  }
  p.then(function(res){
    if (!res || !res.code) { $('result').innerHTML = '<p class="error">' + esc(res && res.data) + '</p>'; return; }
    var errs = (res.data && res.data.errors) || [];
    var h = '<p class="message">' + (res.data.executed || 0) + ' ' + esc(t('executed')) + '</p>';
    if (errs.length) h += '<p class="error">' + errs.length + ' error(s)</p>';
    $('result').innerHTML = h;
    loadTables();
  });
  return false;
}

function applyLang(){
  var map = { sql:t('sqlCommand'), import:t('import'), export:t('export'), create:t('createTable') };
  var as = $('menu').querySelectorAll('a[data-nav]');
  for (var i = 0; i < as.length; i++){ var n = as[i].getAttribute('data-nav'); if (map[n]) as[i].textContent = map[n]; }
  document.documentElement.lang = LANG_KEY;
  if (state.view === 'data') { tableTabs('data'); renderData(); }
  else if (state.view === 'structure') tableTabs('structure');
  else if (state.view === 'alter') tableTabs('alter');
  else if (state.view === 'row') tableTabs('row');
}

document.addEventListener('click', function(e){
  var el = e.target;
  while (el && el.nodeType === 1) {
    if (el.hasAttribute('data-table')) { showTable(el.getAttribute('data-table')); return; }
    if (el.hasAttribute('data-nav')) { nav(el.getAttribute('data-nav')); return; }
    if (el.hasAttribute('data-sort')) { sortBy(el.getAttribute('data-sort'), e.shiftKey); return; }
    if (el.hasAttribute('data-drop')) { dropObjectByName(el.getAttribute('data-drop'), el.getAttribute('data-drop-name')); return; }
    if (el.hasAttribute('data-edit-view')) { editView(el.getAttribute('data-edit-view')); return; }
    el = el.parentNode;
  }
});
$('langSel').value = LANG_KEY;
$('langSel').addEventListener('change', function(){ LANG_KEY = this.value; L = LANG[LANG_KEY] || LANG.en; applyLang(); });
var tgl = document.createElement('div');
tgl.className = 'toggle-menu';
document.body.appendChild(tgl);
tgl.addEventListener('click', function(){ document.body.classList.toggle('menu-hide'); });
if (window.innerWidth < 769) { document.body.classList.add('app-page-small'); document.body.classList.add('menu-hide'); }
loadTables();
showSql();
if (DEBUG) dbg('debug mode on', { apiBase: apiBase });
</script>
</body>
</html>`;
  return c.body(html, 200, HTML_HEADERS);
}
