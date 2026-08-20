/**
 * MinelibsBox Worker - Cloudflare Workers entry point
 * Serves 003 MbesBox SPA frontend + API backend
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { poweredBy } from "hono/powered-by";
import { logger } from "hono/logger";
import { apiRoutes } from "../app/routes/api";
import { pageRoutes } from "../app/routes/pages";
import { initDatabase } from "../app/lib/db";

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use("*", poweredBy());
app.use("*", logger());
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  credentials: true,
}));

// URL Rewrite: 003 SPA calls API_HOST + "user/view/options"
// API_HOST = "/index.php?" so the URL looks like: /index.php?user/view/options
// We need to rewrite this to: /api/user/view/options
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const path = url.pathname;

  // Handle /index.php?MOD/ST/ACT&params
  if (path === "/index.php" && url.search) {
    const query = url.search.slice(1); // e.g., "user/view/options&key=val"
    const parts = query.split("&");
    const routePart = parts[0]; // e.g., "user/view/options"

    // Parse MOD/ST/ACT from route (can be 2 or 3 segments)
    const segments = routePart.split("/");
    const restParams = parts.slice(1).join("&");

    if (segments.length >= 2) {
      const newPath = "/api/" + segments.join("/");
      url.pathname = newPath;
      url.search = restParams ? `?${restParams}` : "";
      const newReq = new Request(url.toString(), c.req.raw);
      return app.fetch(newReq, c.env, c.executionCtx);
    }
  }

  // Handle direct paths: /user/view/options -> /api/user/view/options
  const firstSeg = path.split("/")[1];
  if (firstSeg && ["user", "explorer", "admin", "setting", "fav", "share", "desktop"].includes(firstSeg)) {
    url.pathname = "/api" + path;
    const newReq = new Request(url.toString(), c.req.raw);
    return app.fetch(newReq, c.env, c.executionCtx);
  }

  await next();
});

// API routes
app.route("/api", apiRoutes);

// Page routes (SPA index.html)
app.route("/", pageRoutes);

// Static file serving via Cloudflare assets
// (handled by wrangler.jsonc assets.directory config)

// Static file serving: GitHub Pages (STATIC_HOST) hosts ./static content at its root.
// Legacy /static/* paths (hardcoded in main.js as ./static/...) are proxied to it.
// Falls back to the ASSETS binding in local dev where STATIC_HOST is unset.
app.get("/static/*", async (c) => {
  const rel = c.req.path.replace(/^\/static\//, "");
  try {
    const staticHost = c.env.STATIC_HOST;
    if (staticHost) {
      const res = await fetch(new URL(rel, staticHost));
      if (res.ok) {
        const headers = new Headers(res.headers);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        return new Response(res.body, { headers });
      }
      return c.notFound();
    }
    const obj = await c.env.ASSETS.fetch(new Request(`https://assets.local/${rel}`));
    if (!obj.ok) return c.notFound();
    return obj;
  } catch {
    return c.notFound();
  }
});

let dbInitialized = false;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!dbInitialized) {
      await initDatabase(env.DB);

      // Seed admin user with the original MbesBox default credentials
      const username = "admin";
      const password = "admin123";
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(password));
      const passwordHash = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      await env.DB.prepare(
        `INSERT INTO users (username, password_hash, nickname, role, status) VALUES (?, ?, ?, 'admin', 1)
         ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, nickname = excluded.nickname`
      ).bind(username, passwordHash, "Administrator").run();

      dbInitialized = true;
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
