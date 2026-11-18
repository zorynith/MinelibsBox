/**
 * Authentication middleware and helpers
 */

import type { Context, Next, MiddlewareHandler } from "hono";
import { getSession, getUserById, getSetting, deleteSession } from "./db";
import { t } from "./i18n";

/** 001 SystemOption sessionTime (秒, 默认 4 小时); 60s 内存缓存, 避免每次请求都查库 */
let sessionTtlCache: { at: number; hours: number } | null = null;

export async function sessionTtlHours(db: D1Database): Promise<number> {
  if (sessionTtlCache && Date.now() - sessionTtlCache.at < 60_000) return sessionTtlCache.hours;
  const raw = await getSetting(db, "sessionTime").catch(() => null);
  const sec = parseInt(String(raw ?? ""), 10);
  const hours = Number.isFinite(sec) && sec > 0 ? Math.max(1, Math.round(sec / 3600)) : 4;
  sessionTtlCache = { at: Date.now(), hours };
  return hours;
}

const SESSION_COOKIE = "kod_session";

export interface AuthUser {
  id: number;
  username: string;
  nickname: string;
  email: string;
  phone: string;
  avatar: string;
  sex: number;
  role: string;
  /** 角色 id (1=管理员); 用于角色级权限拦截 */
  roleID?: number;
  status: number;
  config_json: string;
}

type AppContext = Context<{ Bindings: Env; Variables: { currentUser: AuthUser } }>;

export function setSessionCookie(c: Context, sessionId: string, maxAge: number = 86400) {
  c.header("Set-Cookie", `${SESSION_COOKIE}=${sessionId}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`);
}

export function clearSessionCookie(c: Context) {
  c.header("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

export function getSessionId(c: Context): string | null {
  const cookie = c.req.header("Cookie") || "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (match) return match[1];
  // 官方客户端/第三方: accessToken 即会话 id (query / header / cookie)
  const q = c.req.query();
  const token = q.accessToken || q.kodTokenApi || "";
  if (token) return token;
  const h = c.req.header("accessToken") || c.req.header("kodTokenApi");
  if (h) return h;
  const cookieToken = cookie.match(/(?:^|;\s*)(?:accessToken|kodTokenApi)=([^;]+)/);
  if (cookieToken) return cookieToken[1];
  return null;
}

/**
 * Middleware: require authentication
 */
export async function authRequired(c: AppContext, next: Next) {
  // apiSignCheck 已按签名注入身份 (001: Session::set('kodUser')), 无需会话
  if (c.get("currentUser")) return next();
  const sessionId = getSessionId(c);
  if (!sessionId) {
    return c.json({ success: false, code: "NOT_LOGIN", message: "Please login first" }, 401);
  }

  const session = await getSession(c.env.DB, sessionId);
  if (!session) {
    clearSessionCookie(c);
    return c.json({ success: false, code: "NOT_LOGIN", message: "Session expired" }, 401);
  }

  // 001 userDataInit: 账号被禁用/未启用时立即失效 (管理员禁用后无需等会话过期)
  if (Number(session.status ?? 1) === 0) {
    await deleteSession(c.env.DB, sessionId).catch(() => undefined);
    clearSessionCookie(c);
    return c.json({ success: false, code: "USER_INVALID", message: t("user.userEnabled") }, 401);
  }

  // 001: 滑动过期 (sessionTime); 仅在剩余寿命不足一半时续期, 减少 D1 写入
  try {
    const ttlHours = await sessionTtlHours(c.env.DB);
    const ttlMs = ttlHours * 3600 * 1000;
    const expires = Date.parse(String(session.expires_at || ""));
    if (Number.isFinite(expires) && expires - Date.now() < ttlMs / 2) {
      const next = new Date(Date.now() + ttlMs).toISOString();
      if (!Number.isFinite(expires) || next > String(session.expires_at)) {
        await c.env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").bind(next, sessionId).run().catch(() => undefined);
      }
    }
  } catch {
    /* 续期失败不影响请求 */
  }

  const user: AuthUser = {
    id: session.user_id as number,
    username: session.username as string,
    nickname: (session.nickname as string) || (session.username as string),
    email: (session.email as string) || "",
    phone: (session.phone as string) || "",
    avatar: (session.avatar as string) || "",
    sex: (session.sex as number) || 1,
    role: session.role as string,
    roleID: Number(session.roleID ?? 0) || undefined,
    status: (session.status as number) ?? 1,
    config_json: session.config_json as string,
  };

  c.set("currentUser", user);
  await next();
}

/**
 * Middleware: optional auth
 */
export async function authOptional(c: AppContext, next: Next) {
  if (c.get("currentUser")) return next();
  const sessionId = getSessionId(c);
  if (sessionId) {
    const session = await getSession(c.env.DB, sessionId);
    if (session) {
      const user: AuthUser = {
        id: session.user_id as number,
        username: session.username as string,
        nickname: (session.nickname as string) || (session.username as string),
        email: (session.email as string) || "",
        phone: (session.phone as string) || "",
        avatar: (session.avatar as string) || "",
        sex: (session.sex as number) || 1,
        role: session.role as string,
        status: (session.status as number) ?? 1,
        config_json: session.config_json as string,
      };
      c.set("currentUser", user);
    }
  }
  await next();
}

/**
 * Hash password using SHA-256 (compatible with Cloudflare Workers)
 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify password against hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computed = await hashPassword(password);
  return computed === hash;
}

/**
 * Check if user is admin
 */
export function isAdmin(user: AuthUser | null): boolean {
  return user?.role === "admin" || user?.role === "root";
}

/**
 * Middleware: require admin role (001: admin 模块仅 root 可访问)
 */
export async function adminRequired(c: AppContext, next: Next) {
  const u = c.get("currentUser");
  if (!u || !isAdmin(u)) {
    return c.json({ code: false, data: t("explorer.noPermissionAction") });
  }
  await next();
}
