/**
 * API routes - handles 003 MbesBox SPA API calls
 * Pattern: /index.php?MOD/ST/ACT&params
 */
import { Hono } from "hono";
import { userApi } from "./user-api";
import { ssoApi } from "./sso-api";
import { explorerApi } from "./explorer-api";
import { tagGroupApi } from "./taggroup-api";
import { shareApi } from "./share-api";
import { publishApi } from "./publish-api";
import { adminApi } from "./admin-api";
import { repairApi } from "./repair-api";
import { autoTaskApi } from "./autotask-api";
import { msgApi } from "./msg-api";
import { pluginApi } from "./plugin-api";
import { commentApi } from "./comment-api";
import { viewImageApi } from "./viewimage-api";
import { authRoleApi } from "./authrole-api";
import { authPluginApi } from "./authplugin-api";
import { seoApi } from "./seo-api";
import { adminShareApi } from "./admin-share-api";
import { adminTaskApi } from "./admin-task-api";
import { adminServerApi } from "./admin-server-api";
import { shareOutRouter } from "./shareout-api";

const apiRoutes = new Hono<{ Bindings: Env }>();

// Mount user API
apiRoutes.route("/user", userApi);
// Mount SSO API
apiRoutes.route("/user", ssoApi);
// Mount explorer API
apiRoutes.route("/explorer", shareApi);
// Mount explorer publish API
apiRoutes.route("/explorer", publishApi);
// Mount explorer API
apiRoutes.route("/explorer", explorerApi);
// Mount explorer seo API (匿名: 独立 /seo 前缀, 避开 authRequired 前缀拦截)
apiRoutes.route("/seo", seoApi);
// Mount explorer shareOut API (站间联合分享, 匿名: 独立 /shareOut 前缀, 避开 authRequired 前缀拦截)
apiRoutes.route("/shareOut", shareOutRouter);
// Mount explorer tagGroup / userShareTarget API
apiRoutes.route("/explorer", tagGroupApi);
// Mount admin API (用户管理)
apiRoutes.route("/admin", adminApi);
// Mount admin share API (分享管理)
apiRoutes.route("/admin", adminShareApi);
// Mount admin task API (后台任务管理)
apiRoutes.route("/admin", adminTaskApi);
// Mount admin server API (服务器信息/缓存/数据库)
apiRoutes.route("/admin", adminServerApi);
// Mount admin repair API (异常数据修复)
apiRoutes.route("/admin", repairApi);
// Mount admin autoTask API (计划任务)
apiRoutes.route("/admin", autoTaskApi);
// Mount user msg API (短信/邮件发送)
apiRoutes.route("/user", msgApi);
// Mount plugin API (officeViewer / pdfjs viewers)
apiRoutes.route("/plugin", pluginApi);
// Mount comment API (评论/聊天面板)
apiRoutes.route("/comment", commentApi);
// Mount user viewImage API (壁纸图片转发)
apiRoutes.route("/user", viewImageApi);
// Mount user authRole API (角色权限)
apiRoutes.route("/user", authRoleApi);
// Mount user authPlugin API (插件权限)
apiRoutes.route("/user", authPluginApi);

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
