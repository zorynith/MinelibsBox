/**
 * SSO API - 共享账号登录 (复刻 001 user/sso)
 *
 * - user/sso/check: SDK 模式校验, 返回 userInfo + accessToken
 * - user/sso/apiCheckToken: 第三方 URL 调用校验 (GET appName)
 * - user/sso/apiLogin: 第三方跳转登录 (GET appName + callbackUrl)
 * - user/sso/logout: 清理会话
 *
 * accessToken 即会话 id (与登录接口的 kod_session cookie 等价),
 * 第三方通过 query 参数 accessToken / kodTokenApi 携带。
 */
import { Hono } from "hono";
import { getSession, getUserById } from "../lib/db";
import { getSessionId, isAdmin, type AuthUser } from "../lib/auth";
import { deleteSession } from "../lib/db";

const ssoApi = new Hono<{ Bindings: Env }>();

/** 从 cookie 或 query(accessToken/kodTokenApi) 中解析会话 id。 */
function resolveSessionId(c: Parameters<typeof getSessionId>[0]): string | null {
  const cookie = getSessionId(c);
  if (cookie) return cookie;
  const q = c.req.query();
  return q.accessToken || q.kodTokenApi || null;
}

async function resolveUser(c: Parameters<typeof getSessionId>[0]): Promise<AuthUser | null> {
  const sessionId = resolveSessionId(c);
  if (!sessionId) return null;
  const session = await getSession(c.env.DB, sessionId);
  if (!session) return null;
  const u = await getUserById(c.env.DB, session.user_id as number);
  if (!u) return null;
  return {
    id: u.id as number,
    username: u.username as string,
    nickname: (u.nickname as string) || (u.username as string),
    email: (u.email as string) || "",
    phone: (u.phone as string) || "",
    avatar: (u.avatar as string) || "",
    sex: (u.sex as number) || 1,
    role: u.role as string,
    status: (u.status as number) ?? 1,
    config_json: (u.config_json as string) || "",
  };
}

/** 返回 userInfo（001 user/sso userInfo 字段 + accessToken）。 */
function userInfoPayload(user: AuthUser, accessToken: string): Record<string, unknown> {
  return {
    userID: user.id,
    name: user.username,
    email: user.email,
    phone: user.phone,
    nickName: user.nickname,
    avatar: user.avatar,
    sex: user.sex,
    accessToken,
  };
}

/**
 * appName 权限校验 (001 checkAuth):
 * - 空 / user:all  → 所有登录用户
 * - user:admin     → 系统管理员
 * - {"user":"1,3","group":"1","role":"1,2"} → 指定用户/部门/角色
 */
async function checkAppAuth(db: D1Database, appName: string | undefined, user: AuthUser): Promise<boolean> {
  const name = (appName || "").trim();
  if (!name || name === "user:all") return true;
  if (name === "user:admin") return isAdmin(user);
  if (name.startsWith("{")) {
    let obj: Record<string, string> = {};
    try {
      obj = JSON.parse(name) as Record<string, string>;
    } catch {
      return false;
    }
    const userPart = obj.user || "";
    if (userPart) {
      const targets = userPart.split(",").map((s) => s.trim()).filter(Boolean);
      if (targets.includes(String(user.id)) || targets.includes(user.username)) return true;
    }
    const groupPart = obj.group || "";
    if (groupPart) {
      const targets = groupPart.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
      if (targets.length > 0) {
        const rows = (await db
          .prepare(`SELECT group_id FROM user_groups WHERE user_id = ? AND group_id IN (${targets.map(() => "?").join(",")})`)
          .bind(user.id, ...targets)
          .all()) as unknown as { results: { group_id: number }[] };
        if (rows.results.length > 0) return true;
      }
    }
    const rolePart = obj.role || "";
    if (rolePart) {
      const targets = rolePart.split(",").map((s) => s.trim()).filter(Boolean);
      if (targets.includes(user.role)) return true;
    }
    return false;
  }
  return false;
}

// check - 登录用户校验 + 权限判定, 返回 userInfo + accessToken
ssoApi.all("/sso/check", async (c) => {
  const body: Record<string, string> = {};
  const rawBody = await c.req.parseBody().catch(() => ({}));
  for (const [k, v] of Object.entries(rawBody)) body[k] = typeof v === "string" ? v : "";
  const appName = body.appName || c.req.query("appName") || "";

  const user = await resolveUser(c);
  const sessionId = resolveSessionId(c);
  if (!user || !sessionId) {
    return c.json({ code: false, data: "[API LOGIN]" });
  }
  const allow = await checkAppAuth(c.env.DB, appName, user);
  if (!allow) {
    return c.json({ code: false, data: "无权访问!" });
  }
  return c.json({ code: true, data: userInfoPayload(user, sessionId) });
});

// apiCheckToken - 第三方 url 调用校验
ssoApi.get("/sso/apiCheckToken", async (c) => {
  const appName = c.req.query("appName") || "";
  const user = await resolveUser(c);
  const sessionId = resolveSessionId(c);
  if (!user || !sessionId) {
    return c.text("[error]:[API LOGIN]");
  }
  const allow = await checkAppAuth(c.env.DB, appName, user);
  if (!allow) {
    return c.text("[error]:无权访问!");
  }
  return c.json(userInfoPayload(user, sessionId));
});

// apiLogin - 校验通过后重定向回 callbackUrl 并附加 accessToken
ssoApi.get("/sso/apiLogin", async (c) => {
  const appName = c.req.query("appName") || "";
  const callbackUrl = c.req.query("callbackUrl") || "";
  const user = await resolveUser(c);
  const sessionId = resolveSessionId(c);
  if (!user || !sessionId) {
    const link = "/#user/login&link=" + encodeURIComponent(callbackUrl) + "&callbackToken=1&msg=[API LOGIN]";
    return c.redirect(link);
  }
  const allow = await checkAppAuth(c.env.DB, appName, user);
  if (!allow) {
    const link = "/#user/login&link=" + encodeURIComponent(callbackUrl) + "&callbackToken=1&msg=" + encodeURIComponent("无权访问!");
    return c.redirect(link);
  }
  const cleanUrl = callbackUrl.replace(/([?&])kodTokenApi=[^&]*/, "$1");
  const separator = cleanUrl.includes("?") ? "&" : "?";
  return c.redirect(cleanUrl + separator + "kodTokenApi=" + encodeURIComponent(sessionId));
});

// logout - 清理当前会话
ssoApi.get("/sso/logout", async (c) => {
  const sessionId = resolveSessionId(c);
  if (sessionId) await deleteSession(c.env.DB, sessionId);
  return c.json({ code: true, data: "ok" });
});

export { ssoApi };
