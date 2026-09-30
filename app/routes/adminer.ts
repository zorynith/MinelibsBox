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

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };
const SQL_HEADERS = { "Content-Type": "application/sql; charset=utf-8" };

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
  let order = c.req.query("order") || "";
  if (order && !colNames.includes(order)) order = "";
  const dir = (c.req.query("dir") || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const where = (c.req.query("where") || "").trim();
  const whereSql = where ? ` WHERE ${where}` : "";
  const countRow = (await safeAll(c, `SELECT COUNT(*) AS n FROM ${qi(table)}${whereSql}`))[0];
  const total = countRow ? Number(countRow.n) : 0;
  const select = meta.canRowid ? "rowid AS __rowid__, *" : "*";
  const orderSql = order ? ` ORDER BY ${qi(order)} ${dir}` : "";
  const offset = (page - 1) * size;
  const rows = await safeAll(c, `SELECT ${select} FROM ${qi(table)}${whereSql}${orderSql} LIMIT ${size} OFFSET ${offset}`);
  return c.json({
    code: true,
    data: { table, type: meta.type, columns: meta.columns, pk: meta.pk, canRowid: meta.canRowid, page, size, total, where, order, dir, rows },
  });
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
  const setCols = Object.keys(values).filter((k) => colNames.includes(k) && !meta.pk.includes(k));

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
      if (!setCols.length) {
        const r = await runStmt(c, `INSERT INTO ${qi(table)} DEFAULT VALUES`);
        return c.json({ code: true, data: { changes: r.meta?.changes ?? 0, lastRowId: r.meta?.last_row_id ?? null } });
      }
      const placeholders = setCols.map(() => "?").join(", ");
      const r = await runStmt(
        c,
        `INSERT INTO ${qi(table)} (${setCols.map(qi).join(", ")}) VALUES (${placeholders})`,
        setCols.map((k) => values[k])
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

/** 导出(整库或单表)为 SQL 文本。 */
async function adminerExport(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  const only = c.req.query("table") || "";
  const objects = await safeAll(
    c,
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 ELSE 4 END, name"
  );
  const tables = objects.filter((o: any) => o.type === "table" && (!only || o.name === only));
  const others = objects.filter((o: any) => o.type !== "table" && (!only || o.tbl_name === only || o.name === only));

  const out: string[] = [];
  out.push("-- MinelibsBox Adminer (D1/SQLite) export");
  out.push("-- " + new Date().toISOString());
  out.push("PRAGMA foreign_keys=OFF;");
  out.push("BEGIN TRANSACTION;");
  for (const t of tables) {
    const name = String(t.name);
    out.push("");
    out.push(`DROP TABLE IF EXISTS ${qi(name)};`);
    out.push(String(t.sql || `CREATE TABLE ${qi(name)} ();`) + ";");
    // 数据: 分页读取, 生成 INSERT
    const meta = await objectMeta(c, name);
    const colNames = meta.columns.map((x: any) => x.name);
    if (colNames.length) {
      const step = 500;
      for (let offset = 0; ; offset += step) {
        const rows = await safeAll(c, `SELECT * FROM ${qi(name)} LIMIT ${step} OFFSET ${offset}`);
        if (!rows.length) break;
        for (const row of rows) {
          const vals = colNames.map((col: string) => sqlLiteral(row[col]));
          out.push(`INSERT INTO ${qi(name)} (${colNames.map(qi).join(", ")}) VALUES (${vals.join(", ")});`);
        }
        if (rows.length < step) break;
      }
    }
  }
  for (const o of others) {
    if (!o.sql) continue;
    out.push("");
    out.push(String(o.sql) + ";");
  }
  out.push("COMMIT;");
  out.push("");
  const filename = `adminer-${only || "all"}-${Date.now()}.sql`;
  return c.body(out.join("\n"), 200, Object.assign({}, SQL_HEADERS, { "Content-Disposition": `attachment; filename="${filename}"` }));
}

/** 导入 SQL 脚本。 */
async function adminerImport(c: any): Promise<Response> {
  if (!currentAdmin(c)) return deny(c);
  let sql = "";
  try {
    const body = await c.req.json();
    sql = String((body as any).sql || "");
  } catch {
    try {
      sql = await c.req.text();
    } catch {
      sql = "";
    }
  }
  if (!sql.trim()) return fail(c, "empty sql");
  const statements = splitStatements(sql);
  if (!statements.length) return fail(c, "no statements");
  let executed = 0;
  const chunkSize = 50;
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    const prepared = chunk.map((s) => c.env.DB.prepare(s));
    try {
      await c.env.DB.batch(prepared);
      executed += chunk.length;
    } catch (e: any) {
      return fail(c, String(e?.message || e), { executed, failedAt: chunk[0] });
    }
  }
  return c.json({ code: true, data: { executed } });
}

// ---------- dispatcher ----------

export async function handleAdminer(c: any, act: string, appHost: string, staticPath: string): Promise<Response> {
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
    case "row":
      return adminerRow(c);
    case "drop":
      return adminerDrop(c);
    case "export":
      return adminerExport(c);
    case "import":
      return adminerImport(c);
    default:
      return renderAdminer(c, appHost, staticPath);
  }
}

// ---------- 页面 ----------

/** 渲染 Adminer 主题的 D1 管理页(复用 001 adminer.css)。 */
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

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Adminer</title>
<link rel="stylesheet" href="${pluginHost}adminer/adminer.css">
</head>
<body class="ltr js">
<div id="content">
  <p id="breadcrumb"><a href="javascript:void(0)" onclick="showSql()">D1</a><span id="crumb"></span></p>
  <h2 id="title">SQL command</h2>
  <div id="ajaxstatus" class="jsonly hidden"></div>
  <div id="main"></div>
</div>
<div id="foot" class="foot">
  <div id="menu">
    <h1><a href="javascript:void(0)" onclick="showSql()">Adminer</a> <span class="version" id="version">D1</span></h1>
    <div id="tables"><p class="error">Loading tables...</p></div>
    <p class="links">
      <a href="javascript:void(0)" onclick="showSql()" id="lnkSql">SQL command</a><br>
      <a href="javascript:void(0)" onclick="showImport()" id="lnkImport">Import</a><br>
      <a href="javascript:void(0)" onclick="exportAll()" id="lnkExport">Export</a>
    </p>
    <p class="links"><a href="javascript:void(0)" onclick="toggleLang()" id="lnkLang">中文</a></p>
  </div>
</div>
<script>
var apiBase = ${JSON.stringify(apiBase)};
var LANG = {
  en: {sqlCommand:'SQL command', table:'Table:', selectData:'Select data', showStructure:'Show structure', newItem:'New item', edit:'edit', del:'delete', save:'Save', cancel:'Cancel', refresh:'Refresh', execute:'Execute', clear:'Clear', rows:'rows', page:'Page', prev:'<', next:'>', structure:'Structure', columns:'Columns', indexes:'Indexes', foreignKeys:'Foreign keys', triggers:'Triggers', ddl:'Create code', importSql:'Import SQL', importHint:'Paste SQL statements, run them one by one.', drop:'Drop', empty:'Empty', confirmDrop:'Drop this object? This cannot be undone.', confirmEmpty:'Delete ALL rows in this table?', confirmDelete:'Delete this row?', affected:'row(s) affected', noTables:'No tables', loading:'Loading...', null:'NULL', unique:'unique', primaryKey:'PK', nullable:'nullable', default:'default', name:'Name', type:'Type', actions:'Actions', where:'WHERE', rowsPerPage:'Rows', export:'Export', notEditable:'This object is read-only (view).', selectTable:'Select a table from the left.', executed:'statement(s) executed', result:'Result' },
  zh: {sqlCommand:'SQL 命令', table:'表:', selectData:'浏览数据', showStructure:'显示结构', newItem:'新建记录', edit:'编辑', del:'删除', save:'保存', cancel:'取消', refresh:'刷新', execute:'执行', clear:'清空', rows:'行', page:'第', prev:'<', next:'>', structure:'结构', columns:'字段', indexes:'索引', foreignKeys:'外键', triggers:'触发器', ddl:'建表语句', importSql:'导入 SQL', importHint:'粘贴 SQL 语句，将逐条执行。', drop:'删除', empty:'清空', confirmDrop:'确定删除该对象？不可恢复。', confirmEmpty:'确定删除该表全部数据？', confirmDelete:'确定删除该行？', affected:'行受影响', noTables:'没有数据表', loading:'加载中...', null:'NULL', unique:'唯一', primaryKey:'主键', nullable:'可空', default:'默认', name:'名称', type:'类型', actions:'操作', where:'条件', rowsPerPage:'每页', export:'导出', notEditable:'该对象只读（视图）。', selectTable:'请从左侧选择数据表。', executed:'条语句已执行', result:'结果' }
};
var L = (navigator.language && navigator.language.indexOf('zh') === 0) ? LANG.zh : LANG.en;
function t(k){ return (L[k] !== undefined ? L[k] : LANG.en[k]) || k; }
function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function qi(n){ return '"' + String(n).replace(/"/g, '""') + '"'; }
function el(id){ return document.getElementById(id); }
function setTitle(txt){ el('title').textContent = txt; document.title = txt; }
function setCrumb(parts){ el('crumb').textContent = parts && parts.length ? ' \\u203a ' + parts.join(' \\u203a ') : ''; }
function busy(on){ el('ajaxstatus').textContent = on ? t('loading') : ''; }
function toggleLang(){ L = (L === LANG.zh) ? LANG.en : LANG.zh; applyLang(); }
function applyLang(){
  el('lnkSql').textContent = t('sqlCommand'); el('lnkImport').textContent = t('importSql'); el('lnkExport').textContent = t('export'); el('lnkLang').textContent = (L === LANG.zh) ? 'English' : '中文';
  loadTables();
}
function apiGet(act, params){
  var u = apiBase + act; var qs = [];
  for (var k in (params || {})) { if (params[k] !== undefined && params[k] !== null && params[k] !== '') qs.push(k + '=' + encodeURIComponent(params[k])); }
  if (qs.length) u += '&' + qs.join('&');
  return fetch(u, {credentials:'include'}).then(function(r){ return r.json(); });
}
function apiPost(act, body){
  return fetch(apiBase + act, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body || {}), credentials:'include'}).then(function(r){ return r.json(); });
}
function ok(res){ if (!res || !res.code) { alert((res && res.data) || 'error'); return false; } return true; }

function loadTables(){
  apiGet('tables').then(function(res){
    var box = el('tables');
    if (!res || !res.code) { box.innerHTML = '<p class="error">' + esc(res && res.data) + '</p>'; return; }
    var tables = res.data || [];
    if (!tables.length) { box.innerHTML = '<p>' + t('noTables') + '</p>'; return; }
    var tablesHtml = '', viewsHtml = '';
    tables.forEach(function(it){
      var a = '<a href="javascript:void(0)" onclick="showTable(\\'' + String(it.name).replace(/'/g, "\\\\'") + '\\')" title="' + esc(it.name) + '">' + esc(it.name) + '</a>';
      if (it.type === 'view') viewsHtml += a; else tablesHtml += a;
    });
    box.innerHTML = (tablesHtml ? '<p><b>' + esc(t('table')) + '</b></p>' + tablesHtml : '') + (viewsHtml ? '<p><b>' + t('structure') + '</b></p>' + viewsHtml : '');
  });
  apiGet('info').then(function(res){ if (res && res.code && res.data) el('version').textContent = 'SQLite ' + (res.data.version || ''); });
}

function showSql(){
  state.table = ''; setTitle(t('sqlCommand')); setCrumb([]);
  el('main').innerHTML =
    '<form onsubmit="return runSql();">' +
    '<textarea id="sql" rows="6" style="width:100%"></textarea>' +
    '<p><input type="submit" value="' + esc(t('execute')) + '"> <input type="button" value="' + esc(t('clear')) + '" onclick="el(\\'sql\\').value=\\'\\';el(\\'result\\').innerHTML=\\'\\'"></p>' +
    '</form><div id="result"></div>';
  var s = el('sql'); if (s) s.focus();
}
function runSql(sqlOverride){
  var sql = sqlOverride || el('sql').value;
  if (!sql || !sql.trim()) return false;
  el('sql').value = sql;
  el('result').innerHTML = '<p>' + t('loading') + '</p>';
  apiPost('query', {sql: sql}).then(function(res){ renderQueryResults('result', res); });
  return false;
}
function renderQueryResults(target, res){
  var box = el(target);
  if (!res || !res.code) { box.innerHTML = '<p class="error">' + esc(res && res.data) + '</p>'; return; }
  var results = (res.data && res.data.results) || [];
  var html = '';
  results.forEach(function(r){
    html += '<div class="message">' + esc(r.sql) + '</div>';
    if (r.rows) {
      html += tableHtml(r.columns, r.rows, null);
      html += '<p>' + r.rows.length + ' ' + t('rows') + '</p>';
    } else if (r.changes !== undefined) {
      html += '<p>' + r.changes + ' ' + t('affected') + '</p>';
    } else {
      html += '<p>OK</p>';
    }
  });
  box.innerHTML = html || '<p>OK</p>';
}
function tableHtml(columns, rows, actions){
  var h = '<table class="nowrap checkable"><thead><tr>';
  (columns || []).forEach(function(c){ h += '<th>' + esc(c) + '</th>'; });
  if (actions) h += '<th>' + esc(t('actions')) + '</th>';
  h += '</tr></thead><tbody>';
  rows.forEach(function(row, i){
    h += '<tr>';
    (columns || []).forEach(function(c){ var v = row[c]; h += '<td>' + (v === null || v === undefined ? '<i>' + esc(t('null')) + '</i>' : esc(v)) + '</td>'; });
    if (actions) h += '<td>' + actions(i, row) + '</td>';
    h += '</tr>';
  });
  h += '</tbody></table>';
  return h;
}

function showImport(){
  state.table = ''; setTitle(t('importSql')); setCrumb([]);
  el('main').innerHTML =
    '<p>' + esc(t('importHint')) + '</p>' +
    '<textarea id="importSql" rows="12" style="width:100%"></textarea>' +
    '<p><input type="button" value="' + esc(t('execute')) + '" onclick="runImport()"></p><div id="result"></div>';
}
function runImport(){
  var sql = el('importSql').value;
  if (!sql || !sql.trim()) return;
  el('result').innerHTML = '<p>' + t('loading') + '</p>';
  apiPost('import', {sql: sql}).then(function(res){
    if (!res || !res.code) { el('result').innerHTML = '<p class="error">' + esc(res && res.data) + '</p>'; return; }
    el('result').innerHTML = '<p class="message">' + (res.data.executed || 0) + ' ' + t('executed') + '</p>';
    loadTables();
  });
}

var state = { table:'', columns:[], pk:[], canRowid:false, isView:false, page:1, size:50, total:0, rows:[], where:'', order:'', dir:'asc' };
function showTable(name, page){
  state.table = name; state.page = page || 1; state.order = ''; state.dir = 'asc';
  setTitle(t('table') + ' ' + name); setCrumb([name]);
  el('main').innerHTML = '<p>' + t('loading') + '</p>';
  loadData();
}
function loadData(){
  apiGet('data', {table:state.table, page:state.page, size:state.size, where:state.where, order:state.order, dir:state.dir}).then(function(res){
    if (!res || !res.code) { el('main').innerHTML = '<p class="error">' + esc(res && res.data) + '</p>'; return; }
    var d = res.data;
    state.columns = d.columns; state.pk = d.pk || []; state.canRowid = !!d.canRowid; state.isView = d.type === 'view';
    state.total = d.total || 0; state.rows = d.rows || []; state.page = d.page; state.size = d.size; state.where = d.where || ''; state.order = d.order || ''; state.dir = d.dir || 'asc';
    renderData();
  });
}
function renderData(){
  var colNames = state.columns.map(function(c){ return c.name; });
  var pages = Math.max(1, Math.ceil(state.total / state.size));
  var editable = !state.isView;
  var bar = '';
  bar += '<p class="links">';
  bar += '<input type="button" value="' + esc(t('newItem')) + '" ' + (editable ? 'onclick="newRow()"' : 'disabled') + '> ';
  bar += '<input type="button" value="' + esc(t('showStructure')) + '" onclick="showStructure()"> ';
  bar += '<input type="button" value="' + esc(t('export')) + '" onclick="exportTable()"> ';
  bar += '<input type="button" value="' + esc(t('empty')) + '" onclick="emptyTable()"> ';
  bar += '<input type="button" value="' + esc(t('drop')) + '" onclick="dropObject()"> ';
  bar += '</p>';
  bar += '<p>' + t('page') + ' ' + state.page + '/' + pages + ' (' + state.total + ' ' + t('rows') + ')';
  bar += ' <input type="button" value="' + esc(t('prev')) + '" ' + (state.page <= 1 ? 'disabled' : 'onclick="gotoPage(' + (state.page - 1) + ')"') + '>';
  bar += ' <input type="button" value="' + esc(t('next')) + '" ' + (state.page >= pages ? 'disabled' : 'onclick="gotoPage(' + (state.page + 1) + ')"') + '></p>';
  bar += '<p>' + t('where') + ': <input type="text" id="whereInput" style="width:50%" value="' + esc(state.where) + '"> <input type="button" value="' + esc(t('refresh')) + '" onclick="applyWhere()"></p>';

  var head = '<table class="nowrap checkable"><thead><tr>';
  colNames.forEach(function(c){
    var mark = (state.order === c) ? (state.dir === 'asc' ? ' \\u2191' : ' \\u2193') : '';
    head += '<th><a href="javascript:void(0)" onclick="sortBy(\\'' + String(c).replace(/'/g, "\\\\'") + '\\')">' + esc(c) + mark + '</a></th>';
  });
  if (editable) head += '<th>' + esc(t('actions')) + '</th>';
  head += '</tr></thead><tbody>';
  state.rows.forEach(function(row, i){
    head += '<tr>';
    colNames.forEach(function(c){ var v = row[c]; head += '<td>' + (v === null || v === undefined ? '<i>' + esc(t('null')) + '</i>' : esc(v)) + '</td>'; });
    if (editable) head += '<td><a href="javascript:void(0)" onclick="editRow(' + i + ')">' + esc(t('edit')) + '</a> <a href="javascript:void(0)" onclick="deleteRow(' + i + ')">' + esc(t('del')) + '</a></td>';
    head += '</tr>';
  });
  head += '</tbody></table>';
  el('main').innerHTML = bar + (state.rows.length ? head : '<p>' + t('noTables') + '</p>');
}
function gotoPage(p){ state.page = p; loadData(); }
function applyWhere(){ state.where = el('whereInput').value; state.page = 1; loadData(); }
function sortBy(c){ if (state.order === c) { state.dir = (state.dir === 'asc' ? 'desc' : 'asc'); } else { state.order = c; state.dir = 'asc'; } state.page = 1; loadData(); }

function rowLocator(row){
  var loc = {pk:{}, rowid:null};
  if (state.pk.length) { state.pk.forEach(function(k){ loc.pk[k] = row[k]; }); }
  else if (state.canRowid && row.__rowid__ !== undefined) { loc.rowid = row.__rowid__; }
  return loc;
}
function newRow(){ rowForm(null); }
function editRow(i){ rowForm(state.rows[i]); }
function rowForm(row){
  var isEdit = !!row;
  var title = isEdit ? (t('edit') + ' ' + state.table) : (t('newItem') + ' ' + state.table);
  setTitle(title);
  var h = '<h3>' + esc(title) + '</h3><form onsubmit="return saveRow();"><table class="nowrap"><tbody>';
  state.columns.forEach(function(c){
    var v = row ? row[c.name] : null;
    var nullChecked = row && (v === null || v === undefined) ? ' checked' : '';
    h += '<tr><th>' + esc(c.name) + '<div class="field-type">' + esc(c.type || '') + (c.notnull ? ' NOT NULL' : '') + (c.pk ? ' [PK]' : '') + '</div></th>' +
         '<td><input type="text" data-col="' + esc(c.name) + '" value="' + (v === null || v === undefined ? '' : esc(v)) + '"> ' +
         '<label><input type="checkbox" data-null="' + esc(c.name) + '"' + nullChecked + '> ' + esc(t('null')) + '</label></td></tr>';
  });
  h += '</tbody></table><p><input type="submit" value="' + esc(t('save')) + '"> <input type="button" value="' + esc(t('cancel')) + '" onclick="loadData()"></p></form>';
  el('main').innerHTML = h;
  window.__editRow = row;
  return false;
}
function saveRow(){
  var isEdit = !!window.__editRow;
  var values = {};
  state.columns.forEach(function(c){
    var nullBox = document.querySelector('[data-null="' + c.name.replace(/"/g, '\\\\"') + '"]');
    var input = document.querySelector('[data-col="' + c.name.replace(/"/g, '\\\\"') + '"]');
    values[c.name] = (nullBox && nullBox.checked) ? null : input.value;
  });
  var payload = {action: isEdit ? 'update' : 'insert', table: state.table, values: values};
  if (isEdit) { var loc = rowLocator(window.__editRow); payload.pk = loc.pk; payload.rowid = loc.rowid; }
  apiPost('row', payload).then(function(res){
    if (!ok(res)) return;
    window.__editRow = null;
    showTable(state.table, state.page);
  });
  return false;
}
function deleteRow(i){
  if (!confirm(t('confirmDelete'))) return;
  var loc = rowLocator(state.rows[i]);
  apiPost('row', {action:'delete', table:state.table, pk:loc.pk, rowid:loc.rowid}).then(function(res){
    if (!ok(res)) return;
    showTable(state.table, state.page);
  });
}

function showStructure(){
  setCrumb([state.table, t('structure')]); setTitle(t('structure') + ' ' + state.table);
  el('main').innerHTML = '<p>' + t('loading') + '</p>';
  apiGet('structure', {table:state.table}).then(renderStructure);
}
function renderStructure(res){
  if (!res || !res.code) { el('main').innerHTML = '<p class="error">' + esc(res && res.data) + '</p>'; return; }
  var d = res.data;
  var h = '<p class="links"><input type="button" value="' + esc(t('selectData')) + '" onclick="showTable(\\'' + String(state.table).replace(/'/g, "\\\\'") + '\\')"> <input type="button" value="' + esc(t('export')) + '" onclick="exportTable()"> <input type="button" value="' + esc(t('drop')) + '" onclick="dropObject()"></p>';
  h += '<h3>' + esc(t('columns')) + '</h3><table class="nowrap"><thead><tr><th>#</th><th>' + esc(t('name')) + '</th><th>' + esc(t('type')) + '</th><th>' + esc(t('nullable')) + '</th><th>' + esc(t('default')) + '</th><th>' + esc(t('primaryKey')) + '</th></tr></thead><tbody>';
  (d.columns || []).forEach(function(c){
    h += '<tr><td>' + esc(c.cid) + '</td><td>' + esc(c.name) + '</td><td>' + esc(c.type) + '</td><td>' + (c.notnull ? '' : 'YES') + '</td><td>' + esc(c.dflt_value) + '</td><td>' + (c.pk ? esc(t('primaryKey')) : '') + '</td></tr>';
  });
  h += '</tbody></table>';
  if ((d.indexes || []).length) {
    h += '<h3>' + esc(t('indexes')) + '</h3><table class="nowrap"><thead><tr><th>' + esc(t('name')) + '</th><th>' + esc(t('unique')) + '</th><th>' + esc(t('columns')) + '</th></tr></thead><tbody>';
    d.indexes.forEach(function(ix){ h += '<tr><td>' + esc(ix.name) + '</td><td>' + (ix.unique ? 'YES' : '') + '</td><td>' + esc((ix.columns || []).join(', ')) + '</td></tr>'; });
    h += '</tbody></table>';
  }
  if ((d.foreignKeys || []).length) {
    h += '<h3>' + esc(t('foreignKeys')) + '</h3><table class="nowrap"><thead><tr><th>' + esc(t('name')) + '</th><th>' + esc(t('table')) + '</th><th>' + esc(t('columns')) + '</th></tr></thead><tbody>';
    d.foreignKeys.forEach(function(fk){ h += '<tr><td>' + esc(fk.from) + '</td><td>' + esc(fk.table) + '</td><td>' + esc(fk.to) + '</td></tr>'; });
    h += '</tbody></table>';
  }
  if ((d.triggers || []).length) {
    h += '<h3>' + esc(t('triggers')) + '</h3><table class="nowrap"><thead><tr><th>' + esc(t('name')) + '</th><th>SQL</th></tr></thead><tbody>';
    d.triggers.forEach(function(g){ h += '<tr><td>' + esc(g.name) + '</td><td>' + esc(g.sql) + '</td></tr>'; });
    h += '</tbody></table>';
  }
  h += '<h3>' + esc(t('ddl')) + '</h3><pre class="message">' + esc(d.sql) + '</pre>';
  el('main').innerHTML = h;
}
function dropObject(){
  if (!confirm(t('confirmDrop'))) return;
  apiPost('drop', {type: state.isView ? 'view' : 'table', name: state.table}).then(function(res){
    if (!ok(res)) return;
    state.table = ''; showSql(); loadTables();
  });
}
function emptyTable(){
  if (!confirm(t('confirmEmpty'))) return;
  runSql('DELETE FROM ' + qi(state.table));
}
function exportTable(){ window.open(apiBase + 'export&table=' + encodeURIComponent(state.table), '_blank'); }
function exportAll(){ window.open(apiBase + 'export', '_blank'); }

loadTables();
showSql();
</script>
</body>
</html>`;
  return c.body(html, 200, HTML_HEADERS);
}
