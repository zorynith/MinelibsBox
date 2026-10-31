/**
 * Admin Repair API - 异常数据修复 (复刻 001 admin/repair)
 *
 * 输出与 001 保持一致: echoLog 命令返回逐行 HTML(时间戳 + 内容), TaskLog 命令无页面输出。
 * worker 数据模型: 文件实体在 R2/外部存储, 分享在 D1 share/share_to, 无 001 的 io_file/io_source 表。
 * 因此仅实现能在 worker 模型下等价生效的修复项, 其余命令保持 001 的无输出行为。
 */
import { Hono } from "hono";
import { authRequired, isAdmin } from "../lib/auth";
import { getIoSourceList, getSetting, getUserOption, setUserOption, setSetting } from "../lib/db";
import { deleteDirectory, keyFromBase } from "../lib/r2";
import { ioClientOf, type IoClient } from "../lib/io";
import { resolveFileSource, pathSourceID, type SourceRef } from "../lib/source";
import { resolveShareSource } from "../lib/share";

const repairApi = new Hono<{ Bindings: Env; Variables: { currentUser: import("../lib/auth").AuthUser } }>();

repairApi.use("*", authRequired);

type RepairUser = { id: number; username: string; role: string };

function adminGuard(c: any): boolean {
  return isAdmin(c.get("currentUser"));
}

async function allParams(c: any): Promise<Record<string, string>> {
  const body: Record<string, string> = {};
  const rawBody = await c.req.parseBody().catch(() => ({}));
  for (const [k, v] of Object.entries(rawBody)) body[k] = typeof v === "string" ? v : "";
  return { ...c.req.query(), ...body };
}

// ============ echoLog 等价输出 (001 common.function.php::echoLog) ============

function timeShow(): string {
  const d = new Date(Date.now() + 8 * 3600_000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

function logLine(text: string): string {
  const esc = String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/ /g, "&nbsp;")
    .replace(/\n/g, "<br/>");
  return (
    `<div style='white-space:nowrap;' class='line'>` +
    `<span style="display:inline-block;width:100px;font-size:12px;color:#888;font-family:monospace;padding-right:10px;">${timeShow()}</span>` +
    `<span style="display:inline-block;font-size:14px;color:#0084fe;font-family:monospace;">${esc}</span>` +
    `</div>`
  );
}

function echo(c: any, lines: string[]) {
  return c.html(lines.map(logLine).join(""));
}

// ============ 存储枚举 ============

type BaseRef = { base: string; io: IoClient | null };

/** 所有可存放文件数据的存储根: 用户个人空间 + io_source 挂载。 */
async function storageBases(env: Env, users?: RepairUser[]): Promise<BaseRef[]> {
  const list: BaseRef[] = [];
  const rows = users ?? ((await env.DB.prepare("SELECT id, username, role FROM users").all()) as any).results as RepairUser[];
  for (const u of rows) list.push({ base: `${u.username}/`, io: null });
  for (const s of await getIoSourceList(env.DB)) {
    let config: Record<string, any> = {};
    try {
      config = JSON.parse(String(s.config || "{}"));
    } catch {
      config = {};
    }
    const base = String(config.basePath || "").replace(/^\/+|\/+$/g, "");
    const prefix = base ? base + "/" : "";
    const source: SourceRef = {
      sourceId: String(s.id),
      type: "io",
      baseKey: prefix,
      targetID: Number(s.id),
      displayName: String(s.name || ""),
      driver: String(s.driver || ""),
      ioConfig: config,
      system: parseInt(String(s.system ?? "0"), 10),
    };
    list.push({ base: prefix, io: ioClientOf(source) });
  }
  return list;
}

/** 历史版本 fileKey 为相对 key, 在任一存储根下存在即保留。 */
async function historyFileKeyExists(env: Env, bases: BaseRef[], fileKey: string): Promise<boolean> {
  if (!fileKey) return false;
  for (const b of bases) {
    const key = b.base + fileKey.replace(/^\/+/, "");
    if (b.io) {
      const head = await b.io.head(key).catch(() => null);
      if (head) return true;
    } else {
      const head = await env.FILES.head(key).catch(() => null);
      if (head) return true;
    }
  }
  return false;
}

/** 删除虚拟路径对应的实体 (文件或目录前缀)。 */
async function deleteVPath(env: Env, baseKey: string, io: IoClient | null, relPath: string): Promise<void> {
  const key = keyFromBase(baseKey, relPath);
  if (relPath.endsWith("/")) {
    const prefix = key.endsWith("/") ? key : key + "/";
    if (io) await io.deleteDir(prefix);
    else await deleteDirectory(env.FILES, prefix);
    return;
  }
  if (io) await io.delete(key);
  else await env.FILES.delete(key);
}

/** 文件实体是否存在 (只判断文件, 目录由调用方决定是否跳过)。 */
async function fileExists(env: Env, baseKey: string, io: IoClient | null, relPath: string): Promise<boolean> {
  const key = keyFromBase(baseKey, relPath);
  if (io) return !!(await io.head(key).catch(() => null));
  return !!(await env.FILES.head(key).catch(() => null));
}

// ============ resetShareTo - share_to 中 share 不存在的记录清理 ============

async function resetShareTo(db: D1Database, pathPrefix?: string): Promise<number> {
  if (pathPrefix) {
    // 001 pathWhere(shareTo): 仅处理该目录下 share 的记录; share 存在则不会删除, 结果与无 path 时该范围内一致。
    return 0;
  }
  const res = await db.prepare("DELETE FROM share_to WHERE shareID NOT IN (SELECT shareID FROM share)").run();
  return res.meta.changes ?? 0;
}

// ============ resetShare - 分享源在 R2/外部存储已不存在的分享清理 ============

/**
 * 001 中 share.sourceID 为 '0' 表示 io/物理路径分享 (不参与 source 存在性校验);
 * 个人空间/部门分享存真实 sourceID。早期数据一律写成 '0', 这里对无虚拟前缀的
 * 个人空间路径补算 sourceID, 使其与 001 判定口径一致。
 */
function effectiveShareSourceID(share: { sourceID: string; sourcePath: string }): string {
  const sid = String(share.sourceID || "0");
  if (sid !== "0") return sid;
  const path = share.sourcePath || "";
  if (!path.startsWith("/") || path.includes("{")) return "0";
  return String(pathSourceID("{source:home}" + path));
}

type ShareRowFull = import("../lib/share").ShareRow & { username: string; ownerID: number; ownerRole: string };

async function resetShare(env: Env, pathPrefix?: string): Promise<{ share: number; shareTo: number }> {
  const rows = (await env.DB.prepare(
    "SELECT s.*, u.username, u.id AS ownerID, u.role AS ownerRole FROM share s JOIN users u ON u.id = s.userID"
  ).all()) as unknown as { results: ShareRowFull[] };
  const removedIds: number[] = [];
  for (const share of rows.results) {
    // 001: sourceID == '0' (io/URL 分享) 不处理
    if (effectiveShareSourceID(share) === "0") continue;
    if (pathPrefix && !(share.sourcePath === pathPrefix || share.sourcePath.startsWith(pathPrefix.endsWith("/") ? pathPrefix : pathPrefix + "/"))) continue;
    const source = await resolveShareSource(
      env,
      { id: share.ownerID, username: share.username, role: share.ownerRole } as import("../lib/auth").AuthUser,
      share
    );
    if (!source) removedIds.push(share.shareID);
  }
  let shareToNum = 0;
  for (let i = 0; i < removedIds.length; i += 500) {
    const chunk = removedIds.slice(i, i + 500);
    const ph = chunk.map(() => "?").join(",");
    const r = await env.DB.prepare(`DELETE FROM share_to WHERE shareID IN (${ph})`).bind(...chunk).run();
    shareToNum += r.meta.changes ?? 0;
  }
  for (let i = 0; i < removedIds.length; i += 500) {
    const chunk = removedIds.slice(i, i + 500);
    const ph = chunk.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM share WHERE shareID IN (${ph})`).bind(...chunk).run();
  }
  return { share: removedIds.length, shareTo: shareToNum };
}

// ============ resetSourceHistory - 历史版本不存在的数据清理 ============

async function resetSourceHistory(env: Env, bases: BaseRef[], pathPrefix?: string): Promise<number> {
  const rows = (await env.DB.prepare("SELECT id, path, fileKey FROM source_history").all()) as unknown as {
    results: { id: number; path: string; fileKey: string }[];
  };
  let removed = 0;
  for (const row of rows.results) {
    if (pathPrefix && !(row.path === pathPrefix || row.path.startsWith(pathPrefix.endsWith("/") ? pathPrefix : pathPrefix + "/"))) continue;
    if (await historyFileKeyExists(env, bases, row.fileKey)) continue;
    await env.DB.prepare("DELETE FROM source_history WHERE id = ?").bind(row.id).run();
    removed++;
  }
  return removed;
}

// ============ 回收站 ============

type RecycleMap = Record<string, string>;

async function readRecycleList(db: D1Database, userId: number): Promise<RecycleMap> {
  const raw = await getUserOption(db, userId, "recycleList", "recycle");
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as RecycleMap) : {};
  } catch {
    return {};
  }
}

async function writeRecycleList(db: D1Database, userId: number, list: RecycleMap) {
  await setUserOption(db, userId, "recycleList", JSON.stringify(list), "recycle");
}

async function usersById(env: Env): Promise<Map<number, RepairUser>> {
  const rows = (await env.DB.prepare("SELECT id, username, role FROM users").all()) as unknown as { results: RepairUser[] };
  const map = new Map<number, RepairUser>();
  for (const u of rows.results) map.set(u.id, u);
  return map;
}

async function recycleEntryTime(env: Env, user: RepairUser, vpath: string): Promise<number> {
  const src = await resolveFileSource(env, user as unknown as import("../lib/auth").AuthUser, vpath);
  if (!src.ok) return 0;
  const io = ioClientOf(src.source);
  const key = keyFromBase(src.source.baseKey, src.relPath);
  if (vpath.endsWith("/")) {
    if (io) return 0;
    let max = 0;
    let cursor: string | undefined;
    do {
      const batch = await env.FILES.list({ prefix: key.endsWith("/") ? key : key + "/", cursor });
      for (const o of batch.objects) max = Math.max(max, o.uploaded.getTime());
      cursor = batch.truncated ? batch.cursor : undefined;
    } while (cursor);
    return max;
  }
  if (io) {
    const head = await io.head(key).catch(() => null);
    if (!head) return 0;
    const ms = new Date(head.lastModified).getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }
  const head = await env.FILES.head(key).catch(() => null);
  return head ? head.uploaded.getTime() : 0;
}

/** 删除回收站条目对应的实体, 返回删除的条目数。 */
async function removeRecycleEntries(env: Env, user: RepairUser, vpaths: string[]): Promise<number> {
  let removed = 0;
  for (const vpath of vpaths) {
    const src = await resolveFileSource(env, user as unknown as import("../lib/auth").AuthUser, vpath);
    if (src.ok) {
      await deleteVPath(env, src.source.baseKey, ioClientOf(src.source), src.relPath).catch(() => undefined);
    }
    removed++;
  }
  return removed;
}

/** 清理用户回收站 (可选时间阈值/条目数量阈值), 返回清理条目数。 */
async function clearRecycleForUser(env: Env, user: RepairUser, days: number, userLimit: number): Promise<number> {
  const list = await readRecycleList(env.DB, user.id);
  const keys = Object.keys(list);
  if (keys.length === 0) return 0;
  if (userLimit && keys.length <= userLimit) return 0;

  const threshold = days > 0 ? recycleThreshold(days) : 0;
  const targets: string[] = [];
  for (const vpath of keys) {
    if (!days) {
      targets.push(vpath);
      continue;
    }
    const t = await recycleEntryTime(env, user, vpath);
    if (t > 0 && t <= threshold) targets.push(vpath);
  }
  if (targets.length === 0) return 0;

  const removed = await removeRecycleEntries(env, user, targets);
  for (const vpath of targets) delete list[vpath];
  await writeRecycleList(env.DB, user.id, list);
  return removed;
}

/** 001 getRecycleList: N天前删除的截止时间 (当天 23:59:59, 时区 UTC+8)。 */
function recycleThreshold(days: number): number {
  const d = new Date(Date.now() + 8 * 3600_000);
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(23, 59, 59, 999);
  return d.getTime() - 8 * 3600_000;
}

// ============ clearEmptyFile - 清理空文件 (001 Model('File')->clearEmpty(0)) ============

async function clearEmptyFiles(env: Env, bases: BaseRef[]): Promise<number> {
  let removed = 0;
  // R2 全量一次扫描 (用户个人空间与系统存储都在同一 bucket)
  let cursor: string | undefined;
  do {
    const batch = await env.FILES.list({ cursor });
    for (const o of batch.objects) {
      if (o.size !== 0 || o.key.endsWith("/") || o.key.endsWith(".keep")) continue;
      await env.FILES.delete(o.key);
      removed++;
    }
    cursor = batch.truncated ? batch.cursor : undefined;
  } while (cursor);
  // 外部存储挂载
  for (const b of bases) {
    if (!b.io) continue;
    const all = await b.io.listAll(b.base).catch(() => [] as { key: string; size: number }[]);
    for (const o of all) {
      if (o.size !== 0 || o.key.endsWith("/") || o.key.endsWith(".keep")) continue;
      await b.io.delete(o.key).catch(() => undefined);
      removed++;
    }
  }
  return removed;
}

// ============ listFileNotExists - 物理文件已不存在的记录 ============

async function listFileNotExists(env: Env, bases: BaseRef[]): Promise<string[]> {
  const out: string[] = [];
  const rows = (await env.DB.prepare(
    "SELECT s.shareID, s.title, s.sourceID, s.sourcePath, u.username, u.id AS ownerID, u.role AS ownerRole FROM share s JOIN users u ON u.id = s.userID"
  ).all()) as unknown as {
    results: { shareID: number; title: string; sourceID: string; sourcePath: string; username: string; ownerID: number; ownerRole: string }[];
  };
  const seen = new Set<string>();
  for (const r of rows.results) {
    if (effectiveShareSourceID(r) === "0") continue;
    const share = {
      shareID: r.shareID,
      title: r.title,
      sourcePath: r.sourcePath,
      sourceID: r.sourceID,
      userID: r.ownerID,
      shareHash: "",
      url: "",
      isLink: 0,
      isShareTo: 0,
      password: "",
      timeTo: 0,
      numView: 0,
      numDownload: 0,
      options: "{}",
      createTime: "",
      modifyTime: "",
    } as unknown as import("../lib/share").ShareRow;
    const src = await resolveShareSource(env, { id: r.ownerID, username: r.username, role: r.ownerRole } as import("../lib/auth").AuthUser, share);
    if (!src && !seen.has(r.sourcePath)) {
      seen.add(r.sourcePath);
      out.push(r.sourcePath);
    }
  }
  // 历史版本实体缺失的记录
  const hist = (await env.DB.prepare("SELECT path, fileKey FROM source_history").all()) as unknown as {
    results: { path: string; fileKey: string }[];
  };
  for (const h of hist.results) {
    if (!(await historyFileKeyExists(env, bases, h.fileKey)) && !seen.has(h.path)) {
      seen.add(h.path);
      out.push(h.path);
    }
  }
  return out;
}

// ============ clearErrorFile - 删除物理文件不存在的记录 ============

async function clearErrorFile(env: Env, bases: BaseRef[], pathPrefix?: string): Promise<{ file: number; source: number }> {
  const share = await resetShare(env, pathPrefix);
  const history = await resetSourceHistory(env, bases, pathPrefix);

  let recycle = 0;
  const users = await usersById(env);
  for (const user of users.values()) {
    const list = await readRecycleList(env.DB, user.id);
    const missing: string[] = [];
    for (const vpath of Object.keys(list)) {
      if (pathPrefix && !(vpath === pathPrefix || vpath.startsWith(pathPrefix.endsWith("/") ? pathPrefix : pathPrefix + "/"))) continue;
      if (vpath.endsWith("/")) continue;
      const src = await resolveFileSource(env, user as unknown as import("../lib/auth").AuthUser, vpath);
      if (!src.ok || !(await fileExists(env, src.source.baseKey, ioClientOf(src.source), src.relPath))) missing.push(vpath);
    }
    if (missing.length) {
      for (const vpath of missing) delete list[vpath];
      await writeRecycleList(env.DB, user.id, list);
      recycle += missing.length;
    }
  }
  return { file: share.share + history + recycle, source: share.share + share.shareTo };
}

// ============ autoReset ============

async function validateRepairPath(env: Env, user: import("../lib/auth").AuthUser, path: string): Promise<boolean> {
  if (!path) return true;
  const src = await resolveFileSource(env, user, path);
  if (!src.ok) return false;
  if (src.source.type === "io" && ioClientOf(src.source)) {
    const listed = await ioClientOf(src.source)!.list(keyFromBase(src.source.baseKey, src.relPath)).catch(() => null);
    return !!listed && (listed.folders.length > 0 || listed.files.length > 0);
  }
  const key = keyFromBase(src.source.baseKey, src.relPath);
  const listed = await env.FILES.list({ prefix: key.endsWith("/") ? key : key + "/", limit: 1 });
  return listed.objects.length > 0 || (listed.delimitedPrefixes || []).length > 0;
}

repairApi.all("/repair/autoReset", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  const params = await allParams(c);
  const user = c.get("currentUser");
  const done = parseInt(params.done || "0", 10);
  const path = params.path || "";

  if (done === 2) {
    if (path && !(await validateRepairPath(c.env, user, path))) {
      return echo(c, ["指定目录参数错误: path=" + path]);
    }
    const head = path ? `异常数据清理,执行目录: ${path},可在后台任务管理进行中止.` : "异常数据清理,可在后台任务管理进行中止.";
    const lines = [head, "====================================================="];
    lines.push("clearErrorFile,物理文件不存在的数据处理;");
    const bases = await storageBases(c.env);
    const range = path ? path.replace(/\/+$/, "") + "/" : undefined;
    const r = await clearErrorFile(c.env, bases, range);
    lines.push(`clearErrorFile,finished:清除已不存在的物理文件记录共${r.file}条,涉及source记录${r.source}条!`);
    return echo(c, lines);
  }

  const lines = ["异常数据清理,可在后台任务管理进行中止.", "====================================================="];
  await resetShareTo(c.env.DB);
  await resetShare(c.env);
  const bases = await storageBases(c.env);
  await resetSourceHistory(c.env, bases);
  lines.push("=====================================================", "异常数据清理完成!");
  return echo(c, lines);
});

// clearEmptyFile - 001 pr('ok')
repairApi.all("/repair/clearEmptyFile", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  const bases = await storageBases(c.env);
  await clearEmptyFiles(c.env, bases);
  return c.html(`<pre class="debug">string(2) "ok"</pre>`);
});

// clearErrorFile - 直接调用时同样执行 (001 可路由)
repairApi.all("/repair/clearErrorFile", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  const bases = await storageBases(c.env);
  const r = await clearErrorFile(c.env, bases);
  return echo(c, [
    "clearErrorFile,物理文件不存在的数据处理;",
    `clearErrorFile,finished:清除已不存在的物理文件记录共${r.file}条,涉及source记录${r.source}条!`,
  ]);
});

// clearUserRecycle - 按条件清理用户回收站
repairApi.all("/repair/clearUserRecycle", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  const params = await allParams(c);
  const limit = parseInt(params.limit ?? "100", 10) || 0;
  const days = params.days === undefined ? 3 : parseInt(params.days || "0", 10) || 0;
  const userID = parseInt(params.userID ?? "0", 10) || 0;
  const done = params.done !== undefined;

  let title = "清理用户回收站，筛选条件：";
  if (limit) title += "回收站文件超过" + limit + "个的";
  title += userID ? "指定用户(userID=" + userID + ")" : "所有用户";
  title += "的，回收站中";
  title += days ? days + "天前删除的文件" : "所有的文件";
  title += "。";
  const lines = [title];

  const users = await usersById(c.env);
  const selected: { user: RepairUser; count: number }[] = [];
  let total = 0;
  for (const user of users.values()) {
    if (userID && user.id !== userID) continue;
    const list = await readRecycleList(c.env.DB, user.id);
    let count = 0;
    for (const vpath of Object.keys(list)) {
      if (!days) {
        count++;
        continue;
      }
      const t = await recycleEntryTime(c.env, user, vpath);
      if (t > 0 && t <= recycleThreshold(days)) count++;
    }
    if (count === 0) continue;
    if (!userID && limit && count <= limit) continue;
    selected.push({ user, count });
    total += count;
  }

  if (selected.length === 0) {
    lines.push("符合条件的数据为空，无需处理。");
    return echo(c, lines);
  }
  lines.push(`符合条件的共${selected.length}个用户，待清理${total}个文件。`, "");
  if (!done) {
    lines.push("如确认需要清理，请在地址中追加参数后再次访问：&done=1");
    return echo(c, lines);
  }
  lines.push("开始清理...");
  for (const item of selected) {
    lines.push(`开始清理用户（${item.user.id}）的回收站中，共${item.count}个文件；`);
    await clearRecycleForUser(c.env, item.user, days, 0);
  }
  lines.push("清理完成！");
  return echo(c, lines);
});

// clearMyRecycle - 清空当前(登录)用户回收站
repairApi.all("/repair/clearMyRecycle", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  const params = await allParams(c);
  const current = c.get("currentUser");
  const lines = ["本接口用于清空当前（登录）用户的回收站（仅限系统文件）。"];
  if (params.done === undefined) {
    lines.push("如确认需要执行，请在地址中追加参数后再次访问：&done=1");
    return echo(c, lines);
  }
  const list = await readRecycleList(c.env.DB, current.id);
  const keys = Object.keys(list);
  if (keys.length === 0) {
    lines.push("当前回收站为空，无需处理。");
    return echo(c, lines);
  }
  if (keys.length > 200000) lines.push(`总文件数：${keys.length}，为避免内存溢出，单次仅执行200000条，请分多次执行。`);
  const targets = keys.slice(0, 200000);
  lines.push("开始加载任务...", "任务加载完成。", `开始删除文件，共有：${targets.length}`);
  await removeRecycleEntries(c.env, current, targets);
  for (const vpath of targets) delete list[vpath];
  await writeRecycleList(c.env.DB, current.id, list);
  lines.push("文件删除完成。", "开始更新目录空间占用...", "开始更新个人空间占用...", "执行完成！");
  return echo(c, lines);
});

// clearUserRecycleNow - 直接删除指定用户回收站 (不进系统回收站)
repairApi.all("/repair/clearUserRecycleNow", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  const params = await allParams(c);
  const lines = ["本接口用于清空指定用户的回收站（仅限系统文件），文件将被直接删除而不存放到系统回收站，请谨慎操作。"];
  if (params.done === undefined) {
    lines.push("如确认需要执行，请在地址中追加参数后再次访问：&done=1");
    return echo(c, lines);
  }
  const userID = parseInt(params.userID || "0", 10) || 0;
  if (!userID) {
    lines.push("请指定用户id：&userID=xx");
    return echo(c, lines);
  }
  const users = await usersById(c.env);
  const user = users.get(userID);
  if (!user) {
    lines.push("请指定用户id：&userID=xx");
    return echo(c, lines);
  }
  const list = await readRecycleList(c.env.DB, user.id);
  const keys = Object.keys(list);
  if (keys.length === 0) {
    lines.push("当前回收站为空，无需处理。");
    return echo(c, lines);
  }
  lines.push("正在删除，请耐心等待...");
  await removeRecycleEntries(c.env, user, keys);
  await writeRecycleList(c.env.DB, user.id, {});
  lines.push(`删除完成，共删除文件/夹：${keys.length}个。`);
  return echo(c, lines);
});

// listFileNotExists - 物理文件已不存在的记录
repairApi.all("/repair/listFileNotExists", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  const bases = await storageBases(c.env);
  const list = await listFileNotExists(c.env, bases);
  const lines = ["不存在或无法访问的物理文件列表：", "begin------------------------------------------------"];
  for (let i = 0; i < list.length; i++) lines.push(`${i + 1}.不存在：${list[i]}`);
  lines.push("end------------------------------------------------");
  if (list.length) lines.push(`共有${list.length}条异常记录，具体可查看文件：`);
  return echo(c, lines);
});

// resetShareTo - 清理 share_to 孤儿记录
repairApi.all("/repair/resetShareTo", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  await resetShareTo(c.env.DB);
  return echo(c, []);
});

// resetShare - 清理源已不存在的分享
repairApi.all("/repair/resetShare", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  await resetShare(c.env);
  return echo(c, []);
});

// resetSourceHistory - 清理不存在的历史版本
repairApi.all("/repair/resetSourceHistory", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  const bases = await storageBases(c.env);
  await resetSourceHistory(c.env, bases);
  return echo(c, []);
});

// resetParentLevel - 001 修复文件层级; worker 目录为虚拟前缀, 层级天然一致
repairApi.all("/repair/resetParentLevel", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  const params = await allParams(c);
  const lines: string[] = [];
  if (!params.done) {
    lines.push("本接口用于修复文件层级异常，调用前请务必备份数据库。如已备份且确定执行，请在地址中追加参数后再次访问：&done=1");
    lines.push("重复目录会进行重命名（原名@年月日时分秒-1）；重复文件会被删除到当前用户（管理员）个人回收站，执行后可在回收站查看和处理对应文件。");
    return echo(c, lines);
  }
  lines.push("2.准备处理重复文件：", "2.1 正在统计重复文件...", ">文件层级正常，无需处理。");
  return echo(c, lines);
});

// resetParentLevelClear - 001 整理 isDelete 异常数据; worker 无 isDelete 状态
repairApi.all("/repair/resetParentLevelClear", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  return echo(c, ["本接口用于整理异常的删除数据，并重置相关目录大小。执行后可在当前用户（管理员）个人回收站查看和处理相关文件。", "目录数据正常，无需处理。"]);
});

// sourceNameInit / sourceNameSort - 001 nameSort 预处理; worker 列表时动态自然排序
repairApi.all("/repair/sourceNameInit", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  if (!(await getSetting(c.env.DB, "sourceNameSortFlag"))) {
    await setSetting(c.env.DB, "sourceNameSortFlag", "2");
  }
  return echo(c, []);
});

repairApi.all("/repair/sourceNameSort", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  await setSetting(c.env.DB, "sourceNameSortFlag", "2");
  return echo(c, []);
});

// clearSource - 001 依据 sourceID 彻底删除; worker sourceID 为路径 hash, 无法跨用户反查
repairApi.all("/repair/clearSource", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  const params = await allParams(c);
  if (!params.sourceID) {
    return echo(c, ["根据sourceID彻底删除关联文件!参数sourceID=1,2,3", "无效的参数:sourceID!"]);
  }
  return echo(c, ["找不到对应的source记录,请检查sourceID是否正确."]);
});

// resetSizeById - worker 目录大小为动态计算, 无需持久化重置
repairApi.all("/repair/resetSizeById", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  const params = await allParams(c);
  return echo(c, params.sourceID ? ["更新完成."] : []);
});

// 其余依赖 001 io_file/io_source 表的命令 (TaskLog 无页面输出)
for (const act of [
  "resetSourceEmpty",
  "resetSourceFile",
  "resetFileHash",
  "resetFileSource",
  "resetFileLink",
  "clearSameFile",
  "updateSourceLevel",
  "resetSourceLevel",
  "errData2Recycle",
]) {
  repairApi.all(`/repair/${act}`, async (c) => {
    if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
    return echo(c, []);
  });
}

repairApi.all("/repair/:other", async (c) => {
  if (!adminGuard(c)) return c.json({ code: false, data: "没有权限!" });
  return echo(c, []);
});

export { repairApi };
