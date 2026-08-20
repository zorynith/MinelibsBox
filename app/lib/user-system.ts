/**
 * User system shared helpers
 * Re-implements 001 user controllers (setting/regist/bind/view) for 003
 */

import type { Context } from "hono";
import { md5 } from "./mcrypt";
import { hashPassword } from "./auth";
import { getVerifyCode, setVerifyCode, deleteVerifyCode, updateVerifyCodeCnt, userSearch, userEdit, getUserOption, setUserOption } from "./db";

const CAPTCHA_COOKIE = "kod_captcha";

// Minimal structural context: these helpers only need env.DB, req.header and header()
type Ctx = {
  env: { DB: D1Database; STATIC_HOST?: string };
  req: { header(name: string): string | undefined; url: string };
  header(name: string, value: string, options?: { append?: boolean }): void;
};

// ---------- app host ----------

export function getAppHost(c: Ctx): string {
  const forwardedHost = c.req.header("X-Forwarded-Host");
  if (forwardedHost) {
    return (c.req.header("X-Forwarded-Proto") || "https") + "://" + forwardedHost + "/";
  }
  const url = new URL(c.req.url);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const proto = isLocal ? "http" : "https";
  return proto + "://" + url.host + "/";
}

/**
 * Resolve the static asset base URL (trailing slash).
 * Static files are hosted on GitHub Pages (STATIC_HOST) when configured;
 * otherwise they fall back to the worker root "/" where the ASSETS binding
 * serves ./static content (works for local dev and no-STATIC_HOST fallback).
 */
export function getStaticHost(c: Ctx): string {
  return c.env.STATIC_HOST || "/";
}

// ---------- image captcha (checkCode) ----------

const CAPTCHA_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

export function randomCaptcha(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += CAPTCHA_CHARS[Math.floor(Math.random() * CAPTCHA_CHARS.length)];
  }
  return s;
}

export function randomNumCode(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10).toString();
  return s;
}

/**
 * Generate an SVG captcha image. Returns the SVG string.
 * (001 uses PHP GD; Workers have no canvas so we emit a self-contained SVG.)
 */
export function renderCaptchaSvg(code: string): string {
  const w = 110;
  const h = 38;
  let noise = "";
  // background noise lines
  for (let i = 0; i < 6; i++) {
    const x1 = Math.floor(Math.random() * w);
    const y1 = Math.floor(Math.random() * h);
    const x2 = Math.floor(Math.random() * w);
    const y2 = Math.floor(Math.random() * h);
    const c = `rgba(${Math.floor(Math.random() * 255)},${Math.floor(Math.random() * 255)},${Math.floor(Math.random() * 255)},0.4)`;
    noise += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="1"/>`;
  }
  let chars = "";
  const colors = ["#e64a19", "#1976d2", "#388e3c", "#7b1fa2", "#f57c00", "#c2185b"];
  const per = w / code.length;
  for (let i = 0; i < code.length; i++) {
    const angle = (Math.random() * 40 - 20) * (Math.PI / 180);
    const x = per * i + per / 2;
    const y = 26 + Math.floor(Math.random() * 6);
    const color = colors[Math.floor(Math.random() * colors.length)];
    chars += `<text x="${x}" y="${y}" font-size="24" font-weight="bold" font-family="monospace"
      fill="${color}" transform="rotate(${(angle * 180) / Math.PI} ${x} ${y})">${code[i]}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${noise}${chars}</svg>`;
}

/**
 * Store an image captcha and set the captcha cookie.
 * Returns the captcha key (also stored in cookie).
 */
export async function storeImageCaptcha(c: Ctx, code: string): Promise<string> {
  const key = randomCaptcha(16).toLowerCase() + Math.floor(Math.random() * 1e9);
  await setVerifyCode(c.env.DB, `captcha_${key}`, code, "img");
  c.header("Set-Cookie", `${CAPTCHA_COOKIE}=${key}; Path=/; Max-Age=600; SameSite=Lax`);
  return key;
}

/**
 * Verify an image captcha submitted by the client (cookie + code).
 * Mirrors 001 userSetting::checkImgCode. Returns { ok } or { ok:false, msg }.
 */
export async function checkImgCode(c: Ctx, code: string): Promise<{ ok: boolean; msg?: string }> {
  const cookie = c.req.header("Cookie") || "";
  const match = cookie.match(new RegExp(`${CAPTCHA_COOKIE}=([^;]+)`));
  const key = match ? match[1] : "";
  if (!key) return { ok: false, msg: "user.codeError" };
  const row = await getVerifyCode(c.env.DB, `captcha_${key}`);
  await deleteVerifyCode(c.env.DB, `captcha_${key}`);
  if (!row || !row.code || String(row.code).toLowerCase() !== String(code || "").trim().toLowerCase()) {
    return { ok: false, msg: "user.codeError" };
  }
  return { ok: true };
}

// ---------- message/email codes (sendCode / sendMsg) ----------

const MSG_SOURCES = ["setting", "regist", "findpwd", "deregist"];

/**
 * Code key used to store message verification codes.
 * Mirrors 001 md5("{$source}_{$type}_{$input}_msgcode")
 */
export function msgCodeKey(source: string, type: string, input: string): string {
  return `msg_${md5(`${source}_${type}_${input}_msgcode`)}`;
}

export function msgFreqKey(type: string, input: string, source: string): string {
  return `freq_${md5(`${type}_${input}_${source}_msgtime`)}`;
}

/**
 * Validate an email or phone input format.
 */
export function checkInputFormat(type: string, input: string): boolean {
  if (type === "email") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
  }
  if (type === "phone") {
    return /^1[3-9]\d{9}$/.test(input);
  }
  return false;
}

/**
 * Store a message verification code (first step of checkMsgCode with $set=true).
 */
export async function storeMsgCode(c: Ctx, type: string, code: string, source: string, input: string) {
  return setVerifyCode(c.env.DB, msgCodeKey(source, type, input), code, type);
}

/**
 * Verify a message code. Mirrors 001 checkMsgCode($type,$code,$data).
 * Returns { ok:true } or { ok:false, msg }.
 */
export async function checkMsgCode(c: Ctx, type: string, code: string, source: string, input: string): Promise<{ ok: boolean; msg?: string }> {
  if (!MSG_SOURCES.includes(source)) return { ok: false, msg: "common.invalid" };
  const key = msgCodeKey(source, type, input);
  const sess = await getVerifyCode(c.env.DB, key) as unknown as { code?: string; cnt?: number; time?: number };
  if (!sess || !sess.code) return { ok: false, msg: "common.invalid" };
  const now = Math.floor(Date.now() / 1000);
  if ((sess.time || 0) + 60 * 20 < now) {
    await deleteVerifyCode(c.env.DB, key);
    return { ok: false, msg: "user.codeExpired" };
  }
  if ((sess.cnt || 0) >= 10) {
    await deleteVerifyCode(c.env.DB, key);
    return { ok: false, msg: "user.codeErrorTooMany" };
  }
  if (String(sess.code).toLowerCase() !== String(code || "").toLowerCase()) {
    await updateVerifyCodeCnt(c.env.DB, key, (sess.cnt || 0) + 1);
    return { ok: false, msg: "user.codeError" };
  }
  await deleteVerifyCode(c.env.DB, key);
  return { ok: true };
}

/**
 * Check message send frequency. Mirrors 001 checkMsgFreq.
 */
export async function checkMsgFreq(c: Ctx, type: string, input: string, source: string, set: boolean = false): Promise<boolean> {
  const key = msgFreqKey(type, input, source);
  const row = await getVerifyCode(c.env.DB, key) as unknown as { code?: string };
  if (set) {
    await setVerifyCode(c.env.DB, key, String(Math.floor(Date.now() / 1000)), "freq");
    return true;
  }
  if (!row || !row.code) return true;
  const last = parseInt(row.code, 10) || 0;
  const interval = type === "email" ? 60 : 90;
  if ((last + interval) * 1000 > Date.now()) return false;
  return true;
}

// ---------- user info formatting ----------

/**
 * Build the full user info object returned to the frontend.
 * Mirrors 001 Model('User')->getInfo() structure used by setUserInfo/setHeadImage.
 */
export async function buildUserInfo(c: Ctx, userId: number) {
  const row = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!row) return null;
  const options = await getAllUserOptionsFor(c, userId);
  return {
    userID: row.id,
    name: row.username,
    nickName: row.nickname || row.username,
    nickname: row.nickname || row.username,
    email: row.email || "",
    phone: row.phone || "",
    avatar: row.avatar || "",
    sex: row.sex ?? 1,
    roleID: row.role === "admin" ? "1" : "0",
    roleName: row.role,
    status: row.status ?? 1,
    sizeMax: row.size_max || 0,
    sizeUse: 0,
    groupInfo: [],
    sourceInfo: [],
    config: options,
    lastLogin: row.last_login || 0,
  };
}

async function getAllUserOptionsFor(c: Ctx, userId: number) {
  const result = await c.env.DB.prepare("SELECT key, value FROM user_option WHERE userID = ? AND type = ''")
    .bind(userId).all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  for (const r of result.results) map[r.key] = r.value;
  return map;
}
// ---------- login device list (userLoginList / userLogoutSet) ----------

/**
 * Build current user online device list.
 * Each item: {sign, ip, address, time, browser, os, isSelf}
 */
export async function buildLoginList(c: Ctx, userId: number) {
  const result = await c.env.DB.prepare(
    "SELECT id, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > datetime('now') ORDER BY created_at DESC"
  ).bind(userId).all<{ id: string; created_at: string; expires_at: string }>();
  const list = result.results.map((s) => ({
    sign: s.id,
    ip: "",
    address: "",
    time: Math.floor(new Date(s.created_at).getTime() / 1000),
    browser: "Unknown",
    os: "Unknown",
    isSelf: false,
  }));
  return list;
}

export async function getSelfSessionSign(c: Ctx): Promise<string> {
  const cookie = c.req.header("Cookie") || "";
  const match = cookie.match(/kod_session=([^;]+)/);
  return match ? match[1] : "";
}

// ---------- password hashing ----------

export async function parseAndHashPassword(pass: string, salt?: string): Promise<string> {
  return hashPassword(pass);
}

export { userSearch, userEdit, getUserOption, setUserOption };
