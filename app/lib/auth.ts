/**
 * Authentication middleware and helpers
 */

import type { Context, Next, MiddlewareHandler } from "hono";
import { getSession, getUserById } from "./db";
import { t } from "./i18n";

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
  return match ? match[1] : null;
}

/**
 * Middleware: require authentication
 */
export async function authRequired(c: AppContext, next: Next) {
  const sessionId = getSessionId(c);
  if (!sessionId) {
    return c.json({ success: false, code: "NOT_LOGIN", message: "Please login first" }, 401);
  }

  const session = await getSession(c.env.DB, sessionId);
  if (!session) {
    clearSessionCookie(c);
    return c.json({ success: false, code: "NOT_LOGIN", message: "Session expired" }, 401);
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
