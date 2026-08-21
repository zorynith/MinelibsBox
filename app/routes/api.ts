/**
 * API routes - handles 003 MbesBox SPA API calls
 * Pattern: /index.php?MOD/ST/ACT&params
 */
import { Hono } from "hono";
import { userApi } from "./user-api";
import { explorerApi } from "./explorer-api";
import { shareApi } from "./share-api";
import { adminApi } from "./admin-api";
import { pluginApi } from "./plugin-api";

const apiRoutes = new Hono<{ Bindings: Env }>();

// Mount user API
apiRoutes.route("/user", userApi);
// Mount explorer API
apiRoutes.route("/explorer", shareApi);
// Mount explorer API
apiRoutes.route("/explorer", explorerApi);
// Mount admin API (用户管理)
apiRoutes.route("/admin", adminApi);
// Mount plugin API (officeViewer / pdfjs viewers)
apiRoutes.route("/plugin", pluginApi);

// Catch-all for other MOD/ST/ACT patterns
apiRoutes.all("/:mod/:st/:act", async (c) => {
  const { mod, st, act } = c.req.param();
  const query = c.req.query();

  // Return appropriate default responses based on the module
  // This prevents the SPA from crashing on unimplemented features
  if (mod === "explorer") {
    if (st === "fav") {
      return c.json({ code: true, data: [] });
    }
    if (st === "tag") {
      return c.json({ code: true, data: [] });
    }
    if (st === "userShare") {
      return c.json({ code: true, data: [] });
    }
    if (st === "share") {
      return c.json({ code: true, data: [] });
    }
    if (st === "recycleDriver") {
      return c.json({ code: true, data: [] });
    }
    if (st === "auth") {
      return c.json({ code: true, data: { read: 1, write: 1, upload: 1, download: 1, delete: 1, share: 1, move: 1, edit: 1, remove: 1 } });
    }
    return c.json({ code: true, data: null });
  }

  if (mod === "user") {
    if (st === "setting") {
      return c.json({ code: true, data: null });
    }
    if (st === "authRole") {
      return c.json({ code: true, data: { roleList: { explorer: { read: 1, write: 1, upload: 1, download: 1, delete: 1, share: 1, move: 1, edit: 1, remove: 1 }, user: { edit: 1, fav: 1 } }, roleAuth: {} } });
    }
    return c.json({ code: true, data: null });
  }

  if (mod === "admin") {
    return c.json({ code: true, data: null });
  }

  if (mod === "setting") {
    return c.json({ code: true, data: null });
  }

  if (mod === "fav") {
    return c.json({ code: true, data: [] });
  }

  if (mod === "share") {
    return c.json({ code: true, data: [] });
  }

  if (mod === "desktop") {
    return c.json({ code: true, data: {} });
  }

  // Forward all unknown API calls with empty/default responses
  // This lets the SPA continue loading without breaking
  return c.json({
    code: true,
    data: null,
  });
});

export { apiRoutes };
