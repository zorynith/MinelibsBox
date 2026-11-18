/**
 * 通知中心 (001 plugins/msgWarning 移植)
 *
 * 001 侧结构:
 *   app.php        -> table / action / notice / taskInfo / message / sendType
 *   lib/evntApi    -> 通知事件列表 + 配置读写 (配置项 ntcEvntList)
 *   lib/typeApi    -> 通知方式列表 + 配置读写 (配置项 ntcTypeList / systemOption.email)
 *   lib/logsApi    -> 通知日志 plugin_msgwarning_log
 *   lib/data/*     -> 事件/方式默认值
 *
 * worker 侧没有硬件/存储巡检任务与第三方消息网关, 因此:
 *   - 事件列表、开关、通知规则、日志查询、邮件网关配置全部可用;
 *   - 企微/钉钉/飞书需要 msgGateway 插件, 未安装时按 001 逻辑标记为未配置。
 */
import { getPluginMeta, setPluginConfig, getSetting, setSetting, getUserById } from "./db";
import { loadPluginLang } from "./plugins";
import { isAdmin } from "./auth";
import { detectLang, loadLangPack } from "./i18n-lang";
import { t } from "./i18n";

type Lng = Record<string, string>;

const PLUGIN_ID = "msgWarning";
const EVNT_KEY = "ntcEvntList";
const TYPE_KEY = "ntcTypeList";

export const MSG_WARNING_TASK_EVENT = "msgWarningPlugin.autoTask";
const MSG_WARNING_TASK_TIME = '{"type":"minute","month":"1","week":"1","day":"08:00","minute":"1"}';

// ---------- 静态默认值 (001 lib/data/ntc.evnt.php, 去掉暂未启用的 devChange/svrFileSysErr/sysStoreDefErr) ----------

interface NoticeRule {
  method: string;
  target: string;
  cntMax?: number;
  cntMaxDay: number;
  timeFreq: number;
  timeFrom: string;
  timeTo: string;
}

interface PolicyItem {
  type: string;
  value: any;
  display?: string;
  desc?: string;
  titleRight?: string;
  require?: number;
}

interface EvntDef {
  event: string;
  title: string;
  level: number;
  class: string;
  desc: string;
  message: string;
  system: number;
  status: number;
  policy?: Record<string, PolicyItem | string>;
  notice: NoticeRule;
  toAll?: number;
  taskFreq: number;
  /** class=dev 为硬件事件, 001 无 cockpit 插件时不下发 */
  hardware?: boolean;
}

const NTC_EVNT_LIST: EvntDef[] = [
  {
    event: "devHealth", title: "NTC_EVNT_DEV_HEALTH", level: 3, class: "dev",
    desc: "NTC_EVNT_DEV_HEALTH_DESC", message: "msgWarning.dev.devHealth",
    system: 1, status: 1, hardware: true,
    notice: { method: "ktips,email", target: '{"user":[1]}', cntMaxDay: 1, timeFreq: 60, timeFrom: "00:00", timeTo: "23:59" },
    toAll: 0, taskFreq: 60,
  },
  {
    event: "devDiskErr", title: "NTC_EVNT_DEV_DISK_ERR", level: 4, class: "dev",
    desc: "NTC_EVNT_DEV_DISK_ERR_DESC", message: "msgWarning.dev.devDiskErr",
    system: 1, status: 1, hardware: true,
    notice: { method: "kwarn,email", target: '{"user":[1]}', cntMaxDay: 0, timeFreq: 60, timeFrom: "00:00", timeTo: "23:59" },
    toAll: 1, taskFreq: 10,
  },
  {
    event: "devRaidErr", title: "NTC_EVNT_DEV_RAID_ERR", level: 4, class: "dev",
    desc: "NTC_EVNT_DEV_RAID_ERR_DESC", message: "msgWarning.dev.devRaidErr",
    system: 1, status: 1, hardware: true,
    notice: { method: "kwarn,email", target: '{"user":[1]}', cntMaxDay: 0, timeFreq: 60, timeFrom: "00:00", timeTo: "23:59" },
    toAll: 1, taskFreq: 10,
  },
  {
    event: "svrDiskSizeErr", title: "NTC_EVNT_SVR_DISK_SIZE_ERR", level: 3, class: "svr",
    desc: "NTC_EVNT_SVR_DISK_SIZE_ERR_DESC", message: "msgWarning.svr.diskSizeErr",
    system: 1, status: 1,
    policy: {
      sizeMin: { type: "number", value: 10, display: "admin.member.spaceSize", titleRight: "GB", require: 1 },
    },
    notice: { method: "ktips", target: '{"user":[1]}', cntMaxDay: 0, timeFreq: 60, timeFrom: "00:00", timeTo: "23:59" },
    taskFreq: 5,
  },
  {
    event: "svrCpuErr", title: "NTC_EVNT_SVR_CPU_ERR", level: 2, class: "svr",
    desc: "NTC_EVNT_SVR_CPU_ERR_DESC", message: "msgWarning.svr.usageErr",
    system: 1, status: 0,
    policy: {
      useRatio: { type: "number", value: 80, display: "msgWarning.evnt.useRatio", titleRight: "&nbsp;%&nbsp;", desc: "msgWarning.evnt.useRatioDesc", require: 1 },
      useTime: { type: "number", value: 10, display: "msgWarning.evnt.useTime", desc: "msgWarning.evnt.useTimeDesc", require: 1 },
    },
    notice: { method: "ktips", target: '{"user":[1]}', cntMaxDay: 0, timeFreq: 60, timeFrom: "00:00", timeTo: "23:59" },
    taskFreq: 1,
  },
  {
    event: "svrMemErr", title: "NTC_EVNT_SVR_MEM_ERR", level: 2, class: "svr",
    desc: "NTC_EVNT_SVR_MEM_ERR_DESC", message: "msgWarning.svr.usageErr",
    system: 1, status: 0,
    policy: {
      useRatio: { type: "number", value: 80, display: "msgWarning.evnt.useRatio", titleRight: "&nbsp;%&nbsp;", desc: "msgWarning.evnt.useRatioDesc", require: 1 },
      useTime: { type: "number", value: 10, display: "msgWarning.evnt.useTime", desc: "msgWarning.evnt.useTimeDesc", require: 1 },
    },
    notice: { method: "ktips", target: '{"user":[1]}', cntMaxDay: 0, timeFreq: 60, timeFrom: "00:00", timeTo: "23:59" },
    taskFreq: 1,
  },
  {
    event: "sysStoreErr", title: "NTC_EVNT_SYS_STORE_ERR", level: 4, class: "sys",
    desc: "NTC_EVNT_SYS_STORE_ERR_DESC", message: "msgWarning.sys.storeErr",
    system: 1, status: 1,
    notice: { method: "kwarn,email", target: '{"user":[1]}', cntMaxDay: 0, timeFreq: 60, timeFrom: "00:00", timeTo: "23:59" },
    toAll: 1, taskFreq: 10,
  },
  {
    event: "sysStoreBakErr", title: "NTC_EVNT_SYS_STORE_BAK_ERR", level: 3, class: "sys",
    desc: "NTC_EVNT_SYS_STORE_BAK_ERR_DESC", message: "msgWarning.sys.storeBakErr",
    system: 1, status: 1,
    notice: { method: "ktips,email", target: '{"user":[1]}', cntMaxDay: 1, timeFreq: 60, timeFrom: "00:00", timeTo: "23:59" },
    taskFreq: 10,
  },
  {
    event: "sysStoreSizeErr", title: "NTC_EVNT_SYS_STORE_SIZE_ERR", level: 3, class: "sys",
    desc: "NTC_EVNT_SYS_STORE_SIZE_ERR_DESC", message: "msgWarning.sys.storeSizeErr",
    system: 1, status: 1,
    policy: {
      sizeMin: { type: "number", value: 10, display: "admin.member.spaceSize", titleRight: "GB", desc: "msgWarning.sys.storeSizeErrDesc", require: 1 },
    },
    notice: { method: "ktips", target: '{"user":[1]}', cntMaxDay: 1, timeFreq: 60, timeFrom: "00:00", timeTo: "23:59" },
    taskFreq: 5,
  },
  {
    event: "sysBakTaskErr", title: "NTC_EVNT_SYS_BAKTASK_ERR", level: 2, class: "sys",
    desc: "NTC_EVNT_SYS_BAKTASK_ERR_DESC", message: "msgWarning.sys.bakTaskErr",
    system: 1, status: 0,
    notice: { method: "ktips", target: '{"user":[1]}', cntMaxDay: 1, timeFreq: 60, timeFrom: "00:00", timeTo: "23:59" },
    taskFreq: 60,
  },
  {
    event: "opsUserAccErr", title: "NTC_EVNT_OPS_USER_ACC_ERR", level: 3, class: "ops",
    desc: "NTC_EVNT_OPS_USER_ACC_ERR_DESC", message: "msgWarning.ops.admEmlErr",
    system: 1, status: 1,
    notice: { method: "ktips", target: '{"user":[1]}', cntMaxDay: 0, timeFreq: 30, timeFrom: "00:00", timeTo: "23:59" },
    taskFreq: 10,
  },
  {
    event: "dataFileDownErr", title: "NTC_EVNT_DATA_FILE_DOWN_ERR", level: 2, class: "data",
    desc: "NTC_EVNT_DATA_FILE_DOWN_ERR_DESC", message: "msgWarning.data.downFileErr",
    system: 1, status: 0,
    policy: {
      cntMax: { type: "number", value: 100, display: "admin.index.fileCnt", desc: "msgWarning.evnt.downFileDesc", require: 1 },
      pol001: "<hr>",
      doAction: { type: "switch", value: 0, display: "msgWarning.evnt.downFileAct", desc: "msgWarning.evnt.downFileActDesc" },
    },
    notice: { method: "ktips", target: '{"user":[1]}', cntMaxDay: 0, timeFreq: 60, timeFrom: "00:00", timeTo: "23:59" },
    taskFreq: 1,
  },
];

const NTC_TYPE_LIST = [
  { type: "ktips", name: "NTC_TYPE_KTIPS", desc: "NTC_TYPE_KTIPS_DESC" },
  { type: "kwarn", name: "NTC_TYPE_KWARN", desc: "NTC_TYPE_KWARN_DESC" },
  { type: "email", name: "NTC_TYPE_EMAIL", desc: "NTC_TYPE_EMAIL_DESC" },
  { type: "weixin", name: "NTC_TYPE_WEIXIN", desc: "NTC_TYPE_WEIXIN_DESC" },
  { type: "dding", name: "NTC_TYPE_DDING", desc: "NTC_TYPE_DDING_DESC" },
  { type: "feishu", name: "NTC_TYPE_FEISHU", desc: "NTC_TYPE_FEISHU_DESC" },
];

// ---------- 参数解析 ----------

function setNested(target: Record<string, any>, path: string[], value: any) {
  let cur = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
}

/**
 * 前端 (jQuery.param) 会把嵌套对象序列化成 data[notice][timeFreq]=60,
 * 001 的 PHP 能直接读成数组; 这里把 bracket 键还原成嵌套对象。
 */
function expandBracketParams(params: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(params)) {
    const base = key.match(/^([^[\]]+)/);
    const keys = [...key.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
    if (!base || !keys.length) {
      out[key] = value;
      continue;
    }
    setNested(out, [base[1], ...keys], value);
  }
  return out;
}

async function readParams(c: any): Promise<Record<string, any>> {
  const params: Record<string, any> = {};
  new URL(c.req.url).searchParams.forEach((v, k) => {
    params[k] = v;
  });
  const method = String(c.req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const ct = String(c.req.header("content-type") || "").toLowerCase();
    if (ct.includes("application/json")) {
      const json = await c.req.json().catch(() => null);
      if (json && typeof json === "object") Object.assign(params, json);
    } else {
      const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, any>;
      for (const [k, v] of Object.entries(body)) params[k] = typeof v === "string" ? v : "";
    }
  }
  return expandBracketParams(params);
}

/** data 参数既可能是 JSON 字符串, 也可能是 bracket 表单还原出的对象 */
function parseDataParam(raw: any): Record<string, any> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------- 语言 & 配置 ----------

async function pluginLng(c: any): Promise<Lng> {
  const lang = detectLang(c);
  // 事件标题/描述来自插件语言包, policy 的 display/desc 里混有 app 级 key (admin.member.spaceSize 等),
  // 两者合并后统一查表, 保证返回给前端的都是译文 (SPA 不二次翻译)。
  const [plugin, app] = await Promise.all([
    loadPluginLang(c.env.ASSETS, PLUGIN_ID, lang).catch(() => ({}) as Lng),
    loadLangPack(c.env.ASSETS, lang).catch(() => null),
  ]);
  return { ...(app || {}), ...(plugin || {}) } as Lng;
}

function translator(lng: Lng) {
  return (key: string, fallback = "") => lng[key] || fallback || key;
}

async function loadConfig(c: any): Promise<Record<string, any>> {
  const meta = await getPluginMeta(c.env.DB, PLUGIN_ID);
  return meta.config || {};
}

async function saveConfig(c: any, config: Record<string, any>) {
  await setPluginConfig(c.env.DB, PLUGIN_ID, config);
}

function settingJson(raw: any): Record<string, any> {
  if (raw && typeof raw === "object") return raw as Record<string, any>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function emailGatewayReady(db: D1Database): Promise<{ ready: boolean; type: string; config: Record<string, any> }> {
  const type = String((await getSetting(db, "emailType").catch(() => "0")) || "0");
  const config = settingJson(await getSetting(db, "email").catch(() => null));
  const ready = type === "1" && !!(config.smtp && config.host && config.email && config.password);
  return { ready, type, config };
}

// ---------- 事件列表 ----------

function mergeEvnt(def: EvntDef, saved: Record<string, any> = {}) {
  const notice: Record<string, any> = { ...def.notice, ...(saved.notice || {}) };
  const policy: Record<string, any> = {};
  for (const [k, v] of Object.entries(def.policy || {})) {
    if (!v || typeof v !== "object") {
      policy[k] = v;
      continue;
    }
    // 前端提交的 policy 是纯值 {useRatio:85}, 001 老数据可能是 {useRatio:{value:85}}, 两种都兼容
    const rawSaved = saved.policy && typeof saved.policy === "object" ? (saved.policy as any)[k] : undefined;
    const savedValue = rawSaved && typeof rawSaved === "object" ? rawSaved.value : rawSaved;
    policy[k] = savedValue === undefined ? { ...v } : { ...v, value: savedValue };
  }
  const result = { cntToday: 0, cntTotal: 0, ntcTime: 0, tskTime: 0, ...(saved.result || {}) };
  return {
    ...def,
    status: saved.status === undefined ? def.status : Number(saved.status),
    toAll: saved.toAll === undefined ? def.toAll || 0 : Number(saved.toAll),
    notice,
    policy,
    result,
  };
}

function allEvents(saved: Record<string, any>) {
  return NTC_EVNT_LIST.filter((e) => !e.hardware).map((e) =>
    mergeEvnt(e, (saved && saved[e.event]) || {})
  );
}

/** 静态表里存的是语言 key, 001 返回的是已翻译文本(SPA 直接展示, 不二次翻译) */
function localizeEvents(list: ReturnType<typeof allEvents>, L: (k: string, d?: string) => string) {
  const tr = (key?: string) => {
    if (!key) return "";
    if (L(key) !== key) return L(key);
    const app = t(key);
    return app && app !== key ? app : key;
  };
  return list.map((e) => {
    const policy: Record<string, any> = {};
    for (const [k, v] of Object.entries(e.policy || {})) {
      policy[k] =
        v && typeof v === "object"
          ? { ...v, display: tr((v as PolicyItem).display), desc: tr((v as PolicyItem).desc) }
          : v;
    }
    return {
      ...e,
      title: tr(e.title),
      desc: tr(e.desc),
      message: tr(e.message),
      policy,
    };
  });
}

// ---------- 日志 ----------

interface LogRow {
  id: number;
  event: string;
  userID: number;
  method: string;
  target: string;
  status: number;
  desc: string;
  createTime: number;
}

/** 001 logsApi::add, 供后续巡检任务写入 */
export async function addMsgWarningLog(
  db: D1Database,
  item: { event: string; userID: number; method: string; target?: string; status: number; desc?: string }
) {
  return db
    .prepare(
      "INSERT INTO plugin_msgwarning_log (event, userID, method, target, status, desc, createTime) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(item.event, item.userID, item.method, item.target || "", item.status ? 1 : 0, item.desc || "", Math.floor(Date.now() / 1000))
    .run();
}

async function logsTable(c: any, params: Record<string, any>, L: (k: string, d?: string) => string) {
  const page = Math.max(1, parseInt(String(params.page || "1"), 10) || 1);
  const pageNum = Math.min(200, Math.max(1, parseInt(String(params.pageNum || "50"), 10) || 50));
  const time = String(params.time || "30");
  const where: string[] = [];
  const binds: any[] = [];
  const now = Math.floor(Date.now() / 1000);

  if (time === "0") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    where.push("createTime >= ?");
    binds.push(Math.floor(start.getTime() / 1000));
  } else if (time === "diy") {
    const from = Date.parse(String(params.timeFrom || ""));
    const to = Date.parse(String(params.timeTo || ""));
    if (!Number.isNaN(from)) {
      where.push("createTime >= ?");
      binds.push(Math.floor(from / 1000));
    }
    if (!Number.isNaN(to)) {
      where.push("createTime <= ?");
      binds.push(Math.floor(to / 1000) + 86399);
    }
  } else if (time !== "all") {
    where.push("createTime >= ?");
    binds.push(now - 30 * 86400);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = (await c.env.DB.prepare(`SELECT COUNT(*) AS cnt FROM plugin_msgwarning_log ${whereSql}`)
    .bind(...binds)
    .first()) as { cnt?: number } | null;
  const total = Number(totalRow?.cnt || 0);
  const rows = (await c.env.DB.prepare(
    `SELECT * FROM plugin_msgwarning_log ${whereSql} ORDER BY createTime DESC, id DESC LIMIT ? OFFSET ?`
  )
    .bind(...binds, pageNum, (page - 1) * pageNum)
    .all()) as { results?: LogRow[] };

  const titleMap = new Map(NTC_EVNT_LIST.map((e) => [e.event, L(e.title, e.event)]));
  const list: any[] = [];
  for (const row of rows.results || []) {
    const user = (await getUserById(c.env.DB, Number(row.userID)).catch(() => null)) as any;
    const name = user ? String(user.nickname || user.username || "") : "";
    list.push({
      ...row,
      title: titleMap.get(row.event) || row.event,
      userInfo: user
        ? { userID: user.id, name, nickName: name, avatar: user.avatar || "" }
        : { userID: row.userID, name: "未知" },
    });
  }
  return { total, list };
}

// ---------- 巡检: 事件产生器 ----------

/**
 * Worker 无法采集宿主 CPU/内存/磁盘/RAID 指标, 这里只实现能从库里真实得到的检查:
 *   opsUserAccErr   : 管理员账号未绑定邮箱
 *   dataFileDownErr : 当日下载文件次数达到阈值的用户
 * 其余硬件类事件在 Web 端保持"已配置但不产生告警", 与 001 无 cockpit 插件的表现一致。
 */
const PRODUCER_EVENTS = ["opsUserAccErr", "dataFileDownErr"];

/** 001 的消息模板用 %s/%d 顺序占位 */
function formatTpl(tpl: string, args: Array<string | number>): string {
  let i = 0;
  return String(tpl || "").replace(/%(s|d)/g, () => String(args[i++] ?? ""));
}

function inTimeWindow(nowHM: string, from: string, to: string): boolean {
  if (!from || !to) return true;
  return from <= to ? nowHM >= from && nowHM <= to : nowHM >= from || nowHM <= to;
}

async function collectFindings(
  c: any,
  event: string,
  merged: any,
  L: (key: string, fallback?: string) => string
): Promise<string[]> {
  const db = c.env.DB;
  if (event === "opsUserAccErr") {
    const rows = (await db
      .prepare("SELECT username, nickname, email FROM users WHERE roleID = 1")
      .all()) as { results?: any[] };
    const names = (rows.results || [])
      .filter((u) => !u.email)
      .map((u) => u.nickname || u.username)
      .filter(Boolean);
    if (!names.length) return [];
    return [`${L("msgWarning.ops.admEmlErr")}（${names.join(", ")}）`];
  }
  if (event === "dataFileDownErr") {
    const limit = Number(merged?.policy?.cntMax?.value ?? 100) || 100;
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0); // audit_logs.created_at 为 UTC datetime('now')
    const since = start.toISOString().slice(0, 19).replace("T", " ");
    const rows = (await db
      .prepare(
        "SELECT user_id, COUNT(*) AS cnt FROM audit_logs WHERE action = 'download' AND created_at >= ? GROUP BY user_id"
      )
      .bind(since)
      .all()) as { results?: any[] };
    const over = (rows.results || []).filter((r) => Number(r.cnt) >= limit);
    if (!over.length) return [];
    const nowText = new Date().toISOString().slice(11, 16);
    return [formatTpl(L("msgWarning.data.downFileErr"), [nowText, over.length, limit])];
  }
  return [];
}

/**
 * 巡检节流: notice 每 60s 轮询一次, 同一 isolate 内多个用户/标签页会重复触发。
 * 55s 内复用上次结果即可(事件本身还有 timeFreq 约束)。
 */
let lastRunAt = 0;
let lastSummary: { events: number; messages: number } | null = null;
let running: Promise<{ events: number; messages: number }> | null = null;
let lastCleanupAt = 0;

/** 按各事件的开关/频率/时段/日上限执行巡检, 写日志与待推送消息 (供 notice、autoTask 调用) */
export async function runMsgWarningTasks(c: any): Promise<{ events: number; messages: number }> {
  const nowMs = Date.now();
  if (lastSummary && nowMs - lastRunAt < 55_000) return lastSummary;
  if (running) return running;
  running = runMsgWarningTasksInner(c)
    .then((summary) => {
      lastSummary = summary;
      lastRunAt = Date.now();
      return summary;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

async function runMsgWarningTasksInner(c: any): Promise<{ events: number; messages: number }> {
  const db = c.env.DB;
  const lng = await pluginLng(c);
  const L = translator(lng);
  const config = await loadConfig(c);
  const savedList = (config[EVNT_KEY] || {}) as Record<string, any>;
  const nowSec = Math.floor(Date.now() / 1000);
  const today = new Date().toISOString().slice(0, 10);
  const nowHM = new Date().toISOString().slice(11, 16);
  let events = 0;
  let messages = 0;

  for (const def of NTC_EVNT_LIST) {
    if (!PRODUCER_EVENTS.includes(def.event)) continue;
    const saved = savedList[def.event] || {};
    const merged = mergeEvnt(def, saved);
    if (!Number(merged.status)) continue;

    const notice = merged.notice as NoticeRule;
    if (!inTimeWindow(nowHM, notice.timeFrom, notice.timeTo)) continue;

    const result: Record<string, any> = { ...merged.result };
    if (result.dayKey !== today) {
      result.cntToday = 0;
      result.dayKey = today;
    }
    const timeFreq = Number(notice.timeFreq || 0);
    if (result.ntcTime && nowSec - Number(result.ntcTime) < timeFreq * 60) continue;
    const maxDay = Number(notice.cntMaxDay || 0);
    if (maxDay > 0 && Number(result.cntToday) >= maxDay) continue;

    const texts = await collectFindings(c, def.event, merged, L).catch(() => [] as string[]);
    if (!texts.length) continue;

    let targetIDs: number[] = [];
    try {
      const raw = typeof notice.target === "string" ? JSON.parse(notice.target) : notice.target;
      targetIDs = ((raw && raw.user) || []).map((n: any) => Number(n)).filter(Boolean);
    } catch {
      targetIDs = [];
    }
    if (!targetIDs.length) {
      const admins = (await db.prepare("SELECT id FROM users WHERE roleID = 1").all()) as { results?: any[] };
      targetIDs = (admins.results || []).map((r) => Number(r.id)).filter(Boolean);
    }

    const methods = String(notice.method || "ktips")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const title = L(def.title, def.event);

    for (const text of texts) {
      for (const method of methods) {
        if (method === "ktips" || method === "kwarn") {
          for (const uid of targetIDs) {
            await db
              .prepare(
                "INSERT INTO plugin_msgwarning_notice (userID, event, level, method, title, message, createTime, status) VALUES (?, ?, ?, ?, ?, ?, ?, 0)"
              )
              .bind(uid, def.event, Number(def.level), method, title, text, nowSec)
              .run();
          }
          await addMsgWarningLog(db, {
            event: def.event,
            userID: targetIDs[0] || 0,
            method,
            status: 1,
            desc: text.slice(0, 200),
          });
          messages++;
        } else if (method === "email") {
          // Worker 无 SMTP; 平台邮件依赖外部服务, 这里如实记录失败原因而不是静默丢弃
          await addMsgWarningLog(db, {
            event: def.event,
            userID: targetIDs[0] || 0,
            method,
            status: 0,
            desc: "邮件通道不可用（Worker 不支持 SMTP，平台邮件服务未配置）",
          });
        }
      }
    }

    result.cntToday = Number(result.cntToday || 0) + 1;
    result.cntTotal = Number(result.cntTotal || 0) + 1;
    result.ntcTime = nowSec;
    result.tskTime = nowSec;
    savedList[def.event] = { ...saved, result };
    events++;
  }

  if (events) {
    config[EVNT_KEY] = savedList;
    await saveConfig(c, config);
  }

  // 已推送消息保留 7 天, 每小时清理一次 (避免表无限增长)
  if (Date.now() - lastCleanupAt > 3600_000) {
    lastCleanupAt = Date.now();
    await db
      .prepare("DELETE FROM plugin_msgwarning_notice WHERE status = 1 AND createTime < ?")
      .bind(nowSec - 7 * 86400)
      .run()
      .catch(() => null);
  }
  return { events, messages };
}

// ---------- 路由处理 ----------

/** plugin/msgWarning/table */
export async function msgWarningTableHandler(c: any): Promise<Response> {
  // 事件/网关/日志只在后台管理页使用, 非管理员不下发(日志含其它用户信息)
  const curUser: any = c.get("currentUser");
  if (!curUser || !isAdmin(curUser)) return c.json({ code: false, data: t("explorer.noPermissionAction") });
  const params = await readParams(c);
  const tab = String(params.tab || "");
  const lng = await pluginLng(c);
  const L = translator(lng);
  const config = await loadConfig(c);

  if (tab === "evnt" || tab === "type" || tab === "logs") {
    if (tab === "logs") {
      const data = await logsTable(c, params, L);
      return c.json({ code: true, data });
    }
    if (tab === "type") {
      const email = await emailGatewayReady(c.env.DB);
      const typeStatus = (config[TYPE_KEY] || {}) as Record<string, any>;
      const list = NTC_TYPE_LIST.map((item) => {
        if (item.type === "ktips" || item.type === "kwarn") {
          return { ...item, name: L(item.name, item.type), desc: L(item.desc), data: 1, status: 1 };
        }
        if (item.type === "email") {
          return { ...item, name: L(item.name, item.type), desc: L(item.desc), data: email.ready ? 1 : 0, status: 1 };
        }
        // weixin / dding / feishu: 依赖 msgGateway 插件, 本版本未内置
        return {
          ...item,
          name: L(item.name, item.type),
          desc: L(item.desc),
          data: 0,
          status: Number(typeStatus[item.type] || 0),
        };
      });
      return c.json({ code: true, data: { list } });
    }
    let list = localizeEvents(allEvents(config[EVNT_KEY] || {}), L);
    const cls = String(params.class || "all");
    const level = String(params.level || "all");
    const status = String(params.status || "all");
    if (cls !== "all" && cls !== "") {
      const classes = cls.split(",").map((s) => s.trim()).filter(Boolean);
      list = list.filter((e) => classes.includes(e.class));
    }
    if (level !== "all" && level !== "") {
      const lv = parseInt(level.replace("level", ""), 10);
      if (!Number.isNaN(lv)) list = list.filter((e) => Number(e.level) === lv);
    }
    if (status === "1" || status === "0") {
      list = list.filter((e) => Number(e.status) === Number(status));
    }
    // 001: 无 cockpit 插件时不下发 dev 类硬件事件
    return c.json({ code: true, data: { list } });
  }
  return c.json({ code: false, data: t("common.illegalRequest") });
}

/** plugin/msgWarning/action */
export async function msgWarningActionHandler(c: any): Promise<Response> {
  // 事件规则/邮件网关配置属于管理操作
  const curUser: any = c.get("currentUser");
  if (!curUser || !isAdmin(curUser)) return c.json({ code: false, data: t("explorer.noPermissionAction") });
  const params = await readParams(c);
  const tab = String(params.tab || "");
  const action = String(params.action || "");
  const lng = await pluginLng(c);
  const L = translator(lng);
  const config = await loadConfig(c);
  const okMsg = () => c.json({ code: true, data: t("explorer.success") });

  if (tab === "evnt") {
    if (action === "getRawData") {
      const saved = (config[EVNT_KEY] || {}) as Record<string, any>;
      const map: Record<string, string> = {};
      for (const def of NTC_EVNT_LIST) {
        map[def.event] = String(saved[def.event]?.notice?.method ?? def.notice.method);
      }
      return c.json({ code: true, data: map });
    }
    if (action === "setConfig") {
      const event = String(params.event || "");
      const def = NTC_EVNT_LIST.find((e) => e.event === event);
      if (!def) return c.json({ code: false, data: t("common.invalidParam") });
      const data = parseDataParam(params.data);
      if (!data) return c.json({ code: false, data: t("common.invalidParam") });

      const saved = (config[EVNT_KEY] || {}) as Record<string, any>;
      const merged = mergeEvnt(def, saved[event] || {});
      // 001 evntApi::setConfig 的两条频率校验
      if (data.notice && typeof data.notice === "object") {
        const timeFreq = Number(data.notice.timeFreq);
        if (!Number.isNaN(timeFreq)) {
          const useTime = Number((merged.policy?.useTime as any)?.value ?? 0);
          if (["svrCpuErr", "svrMemErr"].includes(event) && useTime && timeFreq < useTime) {
            return c.json({ code: false, data: L("msgWarning.evnt.freqLsUseTimeErr") });
          }
          if (timeFreq < def.taskFreq) {
            return c.json({ code: false, data: formatTpl(L("msgWarning.evnt.freqLsTimeErr"), [def.taskFreq]) });
          }
        }
      }
      config[EVNT_KEY] = { ...saved, [event]: { ...(saved[event] || {}), ...data } };
      await saveConfig(c, config);
      return okMsg();
    }
    return c.json({ code: false, data: t("common.illegalRequest") });
  }

  if (tab === "type") {
    if (action === "getConfig") {
      const type = String(params.type || "");
      if (type !== "email") return c.json({ code: false, data: t("explorer.share.errorParam") });
      const gateway = await emailGatewayReady(c.env.DB);
      return c.json({
        code: true,
        data: {
          type: gateway.type === "1" ? 1 : 0,
          smtp: gateway.config.smtp || "",
          host: gateway.config.host || "",
          email: gateway.config.email || "",
          secure: gateway.config.secure || "",
          password: gateway.config.password || "",
        },
      });
    }
    if (action === "setConfig") {
      const type = String(params.type || "");
      if (!["sms", "email", "weixin", "dding", "feishu"].includes(type)) {
        return c.json({ code: false, data: t("explorer.share.errorParam") });
      }
      const data = parseDataParam(params.data);
      if (!data) return c.json({ code: false, data: t("explorer.share.errorParam") });

      if (type === "sms") return okMsg(); // 001 同样不落库
      if (type === "email") {
        const { type: emailType, tested, ...rest } = data as Record<string, any>;
        if (emailType !== undefined) await setSetting(c.env.DB, "emailType", String(emailType));
        await setSetting(c.env.DB, "email", JSON.stringify(rest));
        return okMsg();
      }
      // weixin / dding / feishu: 需要 msgGateway 插件, 未内置时按 001 提示先配置网关
      const status = Number(data.status) === 1 ? 1 : 0;
      if (status === 1) return c.json({ code: false, data: L("msgWarning.type.setAppFirst") });
      config[TYPE_KEY] = { ...(config[TYPE_KEY] || {}), [type]: 0 };
      await saveConfig(c, config);
      return okMsg();
    }
    return c.json({ code: false, data: t("common.illegalRequest") });
  }
  return c.json({ code: false, data: t("common.illegalRequest") });
}

/**
 * plugin/msgWarning/notice: 前端每 60s 轮询。
 * 先跑一次巡检(受各事件 timeFreq 限制, 不会重复告警), 再取走当前用户的待推送消息。
 * 返回 { ktips?: {event:{title,level,message[]}}, kwarn?: {...} }, 无消息时 []。
 */
export async function msgWarningNoticeHandler(c: any): Promise<Response> {
  const user: any = c.get("currentUser");
  if (!user) return c.json({ code: true, data: [] });
  await runMsgWarningTasks(c).catch(() => null);

  const rows = (await c.env.DB.prepare(
    "SELECT * FROM plugin_msgwarning_notice WHERE userID = ? AND status = 0 ORDER BY id ASC LIMIT 50"
  )
    .bind(user.id)
    .all()) as { results?: any[] };
  const list = rows.results || [];
  if (!list.length) return c.json({ code: true, data: [] });

  const out: Record<string, any> = {};
  const ids: number[] = [];
  for (const row of list) {
    ids.push(Number(row.id));
    const method = row.method === "kwarn" ? "kwarn" : "ktips";
    const bucket = out[method] || (out[method] = {});
    const item = bucket[row.event] || (bucket[row.event] = { title: row.title, level: Number(row.level), message: [] });
    item.message.push(row.message);
  }
  await c.env.DB.prepare(
    `UPDATE plugin_msgwarning_notice SET status = 1 WHERE id IN (${ids.map(() => "?").join(",")})`
  )
    .bind(...ids)
    .run();
  return c.json({ code: true, data: out });
}

/** plugin/msgWarning/autoTask: 计划任务入口, 返回本次巡检摘要 */
export async function msgWarningAutoTaskHandler(c: any): Promise<Response> {
  const summary = await runMsgWarningTasks(c).catch(() => ({ events: 0, messages: 0 }));
  return c.json({ code: true, data: summary });
}

/** plugin/msgWarning/message: 设置页"系统消息"体检; 空对象 → 前端显示"一切正常" */
export async function msgWarningMessageHandler(c: any): Promise<Response> {
  const lng = await pluginLng(c);
  const L = translator(lng);
  const config = await loadConfig(c);
  const saved = (config[EVNT_KEY] || {}) as Record<string, any>;
  const issues: string[] = [];
  for (const def of NTC_EVNT_LIST) {
    if (!PRODUCER_EVENTS.includes(def.event)) continue;
    const texts = await collectFindings(c, def.event, mergeEvnt(def, saved[def.event] || {}), L).catch(
      () => [] as string[]
    );
    issues.push(...texts);
  }
  if (!issues.length) return c.json({ code: true, data: {} });
  return c.json({ code: true, data: { user: issues } });
}

/** plugin/msgWarning/sendType: 可用发送方式, 值为 '1' 才可勾选 */
export async function msgWarningSendTypeHandler(c: any): Promise<Response> {
  const email = await emailGatewayReady(c.env.DB);
  return c.json({
    code: true,
    data: { email: email.ready ? "1" : "0", weChat: "0", dingTalk: "0" },
  });
}

/** plugin/msgWarning/taskInfo: 通知中心的计划任务, 缺失时补建 (001 msgWarningSysTask) */
export async function msgWarningTaskInfoHandler(c: any): Promise<Response> {
  const db = c.env.DB;
  const findTask = async () =>
    (await db
      .prepare("SELECT * FROM system_task WHERE event = ? ORDER BY id ASC")
      .bind(MSG_WARNING_TASK_EVENT)
      .first()) as any;

  let task = await findTask().catch(() => null);
  if (!task) {
    const lng = await pluginLng(c);
    const name = lng["msgWarning.meta.name"] || "通知中心";
    const desc = lng["msgWarning.main.taskDesc"] || "系统消息通知，任务来源于【通知中心】";
    const maxRow = (await db
      .prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS nextSort FROM system_task")
      .first()
      .catch(() => null)) as { nextSort?: number } | null;
    // WHERE NOT EXISTS: 并发打开两次不会建出重复任务
    await db
      .prepare(
        `INSERT INTO system_task (name, type, event, time, desc, enable, system, sort, last_time)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0
         WHERE NOT EXISTS (SELECT 1 FROM system_task WHERE event = ?)`
      )
      .bind(
        name, "method", MSG_WARNING_TASK_EVENT, MSG_WARNING_TASK_TIME, desc, 0, 1,
        maxRow?.nextSort ?? 1, MSG_WARNING_TASK_EVENT
      )
      .run()
      .catch(() => null);
    task = await findTask().catch(() => null);
  }
  return c.json({ code: true, data: task || null });
}
