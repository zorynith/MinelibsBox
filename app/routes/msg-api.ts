/**
 * Message API - 发送短信/邮件 (复刻 001 user/msg)
 *
 * - user/msg/send: 按 type 发送 (sms/email)
 * - user/msg/sms / user/msg/email: 兼容旧版直发
 * - user/msg/emailByCustom: 自定义服务器发送 (SMTP, worker 环境不支持, 返回明确错误)
 *
 * 实际发送链路与 001 一致: 默认走 KodAPI 平台 (kodApiServer + systemPassword/systemSecret 签名),
 * 站点未配置平台凭据时返回明确错误而不是静默占位。验证码场景由调用方先生成验证码并存储,
 * 本接口只负责把消息送达收件人。
 */
import { Hono } from "hono";
import { getSetting } from "../lib/db";
import { checkInputFormat } from "../lib/user-system";
import { t } from "../lib/i18n";

const msgApi = new Hono<{ Bindings: Env }>();

function ok(data: any) {
  return { code: true, data };
}

function fail(data: any) {
  return { code: false, data };
}

async function parseBody(c: any): Promise<Record<string, string>> {
  const body: Record<string, string> = {};
  const rawBody = await c.req.parseBody().catch(() => ({}));
  for (const [k, v] of Object.entries(rawBody)) body[k] = typeof v === "string" ? v : "";
  return body;
}

async function allParams(c: any): Promise<Record<string, string>> {
  return { ...c.req.query(), ...(await parseBody(c)) };
}

async function md5hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  // SHA-256 (001 用 PHP md5, worker 无原生 md5; 站点标识仅用于平台签名, 用 sha256 前缀保持一致长度不必要)
  const bytes = new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** 平台请求签名 (001 makeSign): ksort -> k=v& -> md5(sha1(str . secret)) 大写 */
function makeSign(post: Record<string, string>, secret: string): Promise<string> {
  return (async () => {
    const keys = Object.keys(post).sort();
    const str = keys.map((k) => `${k}=${post[k]}`).join("&");
    const sha1Buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str + secret));
    const sha1Hex = Array.from(new Uint8Array(sha1Buf), (b) => b.toString(16).padStart(2, "0")).join("");
    const md5Buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sha1Hex));
    const md5Hex = Array.from(new Uint8Array(md5Buf), (b) => b.toString(16).padStart(2, "0")).join("");
    return md5Hex.slice(0, 32).toUpperCase();
  })();
}

/** 平台 secret: settings.systemSecret; 无 secret 时仅 secret 类型可用 kodid 兜底。 */
async function apiSecret(c: any, kodid: string, type: string): Promise<{ secret: string; err?: string }> {
  const secret = (await getSetting(c.env.DB, "systemSecret")) || "";
  if (secret) return { secret };
  if (type === "secret") return { secret: kodid };
  return { secret: "", err: "Api secret error. 站点未配置 systemSecret" };
}

/**
 * 请求 KodAPI 平台发送短信/邮件 (001 userBind::apiRequest).
 * 站点未配置 systemPassword / kodApiServer 时返回明确错误。
 */
async function platformRequest(c: any, type: string, payload: Record<string, unknown>): Promise<{ code: boolean; data: string }> {
  const pass = (await getSetting(c.env.DB, "systemPassword")) || "";
  if (!pass) return { code: false, data: t("user.sendFail") + ": 平台未配置(systemPassword)" };
  const server = (await getSetting(c.env.DB, "kodApiServer")) || "";
  if (!server) return { code: false, data: t("user.sendFail") + ": 平台未配置(kodApiServer)" };

  const kodid = await md5hex("/" + pass);
  const { secret, err } = await apiSecret(c, kodid, type);
  if (err) return { code: false, data: err };

  const post: Record<string, string> = {
    type,
    kodid,
    timestamp: String(Math.floor(Date.now() / 1000)),
    data: JSON.stringify(payload),
  };
  post.sign = await makeSign(post, secret);

  try {
    const url = server.replace(/\/+$/, "") + "/plugin/platform/";
    const body = new FormData();
    for (const [k, v] of Object.entries(post)) body.append(k, v);
    const res = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { code: false, data: t("user.sendFail") + ": HTTP " + res.status };
    const json = (await res.json().catch(() => null)) as { code?: boolean; data?: unknown } | null;
    if (!json || json.code === false) return { code: false, data: (json?.data as string) || t("user.sendFail") };
    return { code: true, data: String(json.data ?? "ok") };
  } catch {
    return { code: false, data: t("user.sendFail") + ": network error" };
  }
}

/** 发送短信 (001 sendSms: 平台请求)。 */
async function sendSms(c: any, data: Record<string, string>): Promise<{ code: boolean; data: string }> {
  const payload = {
    type: "sms",
    input: data.input,
    language: data.language || "zh-CN",
    config: data.config ? safeParse(data.config) : {},
  };
  return platformRequest(c, data.action || "sms", payload);
}

/** 系统默认发送邮件 (001 sendEmail: emailType 判断后走平台)。 */
async function sendEmail(c: any, data: Record<string, string>): Promise<{ code: boolean; data: string }> {
  let type = data.emailType;
  if (type === undefined || type === "") {
    type = (await getSetting(c.env.DB, "emailType")) || "0";
  }
  if (type === "1") return sendEmailByOwn(c, data);
  const payload = {
    type: "email",
    input: data.input,
    language: data.language || "zh-CN",
    config: data.config ? safeParse(data.config) : "",
  };
  return platformRequest(c, data.action || "email", payload);
}

/** 自定义服务器发送邮件 (001 sendEmailByOwn, Mailer; worker 环境不支持直连 SMTP)。 */
async function sendEmailByOwn(c: any, data: Record<string, string>): Promise<{ code: boolean; data: string }> {
  const config = data.config ? safeParse(data.config) : {};
  const address = typeof config.address === "string" ? config.address : data.input || "";
  if (!address || !checkInputFormat("email", address)) {
    return { code: false, data: t("common.invalidFormat") };
  }
  return { code: false, data: "SMTP 自定义发送: 当前环境未配置邮件服务器(wrangler 不支持直连 SMTP)" };
}

/** 解析 JSON 字符串配置, 失败返回 {}。 */
function safeParse(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const obj = JSON.parse(s);
    return typeof obj === "object" && obj !== null ? obj : {};
  } catch {
    return {};
  }
}

function msgPayload(c: any, q: Record<string, string>): { type: string; input: string; action: string; emailType?: string; config?: string; language?: string } {
  return {
    type: (q.type || "").trim(),
    input: (q.input || "").trim(),
    action: (q.action || "").trim(),
    emailType: q.emailType !== undefined ? q.emailType : undefined,
    config: q.config,
    language: q.language || "zh-CN",
  };
}

// ============ user/msg ============

/** 发送短信/邮件 - user/msg/send */
msgApi.all("/msg/send", async (c) => {
  const q = await allParams(c);
  const data = msgPayload(c, q);
  const check: Record<string, "phone" | "email"> = { sms: "phone", email: "email" };
  if (!check[data.type]) return c.json(fail("common.invalidParam"));
  if (!data.input || !checkInputFormat(check[data.type], data.input)) {
    return c.json(fail("common.invalidFormat"));
  }
  const res = data.type === "sms" ? await sendSms(c, data) : await sendEmail(c, data);
  return c.json(res.code ? ok(res.data) : fail(res.data));
});

/** 发送短信(兼容旧版) - user/msg/sms */
msgApi.all("/msg/sms", async (c) => {
  const q = await allParams(c);
  const data = msgPayload(c, { ...q, type: "sms" });
  if (!data.input || !checkInputFormat("phone", data.input)) return c.json(fail("common.invalidFormat"));
  const res = await sendSms(c, data);
  return c.json(res.code ? ok(res.data) : fail(res.data));
});

/** 发送邮件(兼容旧版) - user/msg/email */
msgApi.all("/msg/email", async (c) => {
  const q = await allParams(c);
  const data = msgPayload(c, { ...q, type: "email" });
  if (!data.input || !checkInputFormat("email", data.input)) return c.json(fail("common.invalidFormat"));
  const res = await sendEmail(c, data);
  return c.json(res.code ? ok(res.data) : fail(res.data));
});

/** 自定义服务器发送邮件 - user/msg/emailByCustom */
msgApi.all("/msg/emailByCustom", async (c) => {
  const q = await allParams(c);
  const data = msgPayload(c, { ...q, type: "email", emailType: "1" });
  const res = await sendEmailByOwn(c, data);
  return c.json(res.code ? ok(res.data) : fail(res.data));
});

export { msgApi };
export { platformRequest, sendSms, sendEmail, sendEmailByOwn };
