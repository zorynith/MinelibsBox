/**
 * Admin Repair API - 异常数据修复 (复刻 001 admin/repair)
 *
 * worker 数据模型与 001 不同: 文件数据在 R2, 分享在 D1 share/share_to,
 * 无 Source/File/SourceHistory 表。因此 repair 的命令做如下映射:
 *  - resetShareTo / resetShare: D1 分享数据修复 (可执行)
 *  - resetParentLevel: groups.parent_level 重算 (可执行)
 *  - clearUserRecycle: 物理清空所有用户回收站 (可执行)
 *  - listFileNotExists: 列出 R2 中已不存在的分享源 (可执行)
 *  - autoReset: 聚合执行上述可执行项
 *  - 其余依赖 Source/File 表的命令返回跳过提示
 */
import { Hono } from "hono";
import { authRequired, isAdmin } from "../lib/auth";
import { getUserOption, setUserOption } from "../lib/db";
import { getUserFileKey } from "../lib/r2";
import { resolveShareSource } from "../lib/share";

const repairApi = new Hono<{ Bindings: Env; Variables: { currentUser: import("../lib/auth").AuthUser } }>();

repairApi.use("*", authRequired);

function adminGuard(c: Parameters<typeof isAdmin>[0] extends never ? never : any): boolean {
  const user = c.get("currentUser");
  return isAdmin(user);
}

function ok(data: any) {
  return { code: true, data };
}

function fail(data: any) {
  return { code: false, data };
}

async function allParams(c: any): Promise<Record<string, string>> {
  const body: Record<string, string> = {};
  const rawBody = await c.req.parseBody().catch(() => ({}));
  for (const [k, v] of Object.entries(rawBody)) body[k] = typeof v === "string" ? v : "";
  return { ...c.req.query(), ...body };
}

// ============ resetShareTo - share_to 中 share 不存在的记录清理 ============
async function resetShareTo(db: D1Database): Promise<number> {
  const res = await db
    .prepare("DELETE FROM share_to WHERE shareID NOT IN (SELECT shareID FROM share)")
    .run();
  return res.meta.changes ?? 0;
}

// ============ resetShare - 分享源在 R2 已不存在的分享清理 ============
async function resetShare(env: Env): Promise<{ share: number; shareTo: number }> {
  const rows = (await env.DB.prepare(
    "SELECT s.*, u.username, u.id AS ownerID, u.role AS ownerRole FROM share s JOIN users u ON u.id = s.userID"
  ).all()) as unknown as { results: (import("../lib/share").ShareRow & { username: string; ownerID: number; ownerRole: string })[] };
  const removedIds: number[] = [];
  for (const share of rows.results) {
    const source = await resolveShareSource(env, { id: share.ownerID, username: share.username, role: share.ownerRole } as import("../lib/auth").AuthUser, share);
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

// ============ resetParentLevel - 重算部门 parent_level (格式 ",1,2,") ============
async function resetParentLevel(db: D1Database): Promise<number> {
  const rows = (await db.prepare("SELECT id, parent_id, parent_level FROM groups").all()) as unknown as {
    results: { id: number; parent_id: number; parent_level: string }[];
  };
  const all = rows.results;
  const byId = new Map<number, { parent_id: number; parent_level: string }>();
  for (const g of all) byId.set(g.id, { parent_id: g.parent_id, parent_level: g.parent_level });

  const computed = new Map<number, string>();
  let changed = true;
  let guard = 0;
  while (changed && guard < 100) {
    changed = false;
    guard++;
    for (const g of all) {
      let want: string;
      if (g.parent_id === 0) {
        want = "," + g.id + ",";
      } else {
        const parent = computed.get(g.parent_id) ?? byId.get(g.parent_id)?.parent_level;
        if (!parent) {
          want = "," + g.id + ",";
        } else {
          want = parent + g.id + ",";
        }
      }
      const cur = computed.get(g.id) ?? g.parent_level;
      if (want !== cur) {
        computed.set(g.id, want);
        changed = true;
      }
    }
  }
  let updated = 0;
  for (const g of all) {
    const want = computed.get(g.id) ?? g.parent_level;
    if (want !== g.parent_level) {
      await db.prepare("UPDATE groups SET parent_level = ? WHERE id = ?").bind(want, g.id).run();
      updated++;
    }
  }
  return updated;
}

// ============ 回收站清理 (001 SourceRecycle; worker 用 user_option recycleList 承载) ============

/** 清空单个用户的回收站, 返回清除的文件/夹数。 */
async function clearUserRecycleFor(env: Env, userId: number): Promise<number> {
  const u = (await env.DB.prepare("SELECT id, username FROM users WHERE id = ?").bind(userId).first()) as unknown as
    | { id: number; username: string }
    | null;
  if (!u) return 0;
  const raw = await getUserOption(env.DB, u.id, "recycleList", "recycle");
  if (!raw) return 0;
  let list: Record<string, string> = {};
  try {
    list = JSON.parse(raw) as Record<string, string>;
  } catch {
    return 0;
  }
  const keys: string[] = [];
  for (const recycleVPath of Object.keys(list)) {
    const rel = recycleVPath.replace(/^\{source:[^}]+\}/, "").replace(/^\{[^}]+\}/, "");
    keys.push(getUserFileKey(u.username, rel));
  }
  for (const key of keys) {
    await env.FILES.delete(key);
  }
  await setUserOption(env.DB, u.id, "recycleList", "{}", "recycle");
  return keys.length;
}

// ============ clearUserRecycle - 物理清空所有用户回收站 ============
async function clearUserRecycle(env: Env): Promise<number> {
  const users = (await env.DB.prepare("SELECT id, username FROM users").all()) as unknown as {
    results: { id: number; username: string }[];
  };
  let cleared = 0;
  for (const u of users.results) {
    cleared += await clearUserRecycleFor(env, u.id);
  }
  return cleared;
}

// ============ listFileNotExists - R2 已不存在的分享源列表 ============
async function listFileNotExists(env: Env): Promise<Record<string, unknown>[]> {
  const rows = (await env.DB.prepare(
    "SELECT s.shareID, s.title, s.sourcePath, u.username, u.id AS ownerID, u.role AS ownerRole, s.createTime FROM share s JOIN users u ON u.id = s.userID"
  ).all()) as unknown as {
    results: { shareID: number; title: string; sourcePath: string; username: string; ownerID: number; ownerRole: string; createTime: string }[];
  };
  const list: Record<string, unknown>[] = [];
  for (const r of rows.results) {
    const share: import("../lib/share").ShareRow = {
      shareID: r.shareID,
      title: r.title,
      shareHash: String(r.shareID),
      userID: 0,
      sourceID: "0",
      sourcePath: r.sourcePath,
      url: "",
      isLink: 0,
      isShareTo: 0,
      password: "",
      timeTo: 0,
      numView: 0,
      numDownload: 0,
      options: "{}",
      createTime: r.createTime,
      modifyTime: r.createTime,
    };
    const source = await resolveShareSource(env, { id: r.ownerID, username: r.username, role: r.ownerRole } as import("../lib/auth").AuthUser, share);
    if (!source) {
      list.push({
        shareID: r.shareID,
        title: r.title,
        sourcePath: r.sourcePath,
        shareUser: r.username,
        createTime: r.createTime,
      });
    }
  }
  return list;
}

// ============ 路由 ============

// autoReset - 聚合执行可修复项 (done=2 时执行清除步骤)
repairApi.all("/repair/autoReset", async (c) => {
  if (!adminGuard(c)) return c.json(fail("没有权限!"));
  const params = await allParams(c);
  const done = parseInt(params.done || "0", 10);
  if (done === 2) {
    const notExists = await listFileNotExists(c.env);
    return c.json(ok({ done: 2, list: notExists }));
  }
  const shareTo = await resetShareTo(c.env.DB);
  const share = await resetShare(c.env);
  const group = await resetParentLevel(c.env.DB);
  return c.json(
    ok({
      resetShareTo: shareTo,
      resetShare: share.share,
      resetShareToByShare: share.shareTo,
      resetParentLevel: group,
      skip: [
        "resetSourceEmpty",
        "resetSourceFile",
        "resetSourceHistory",
        "resetFileLink",
        "resetFileSource",
        "clearSameFile",
        "resetFileHash",
      ],
    })
  );
});

// clearEmptyFile - worker 无 File 表, R2 无法全量枚举, 返回跳过
repairApi.all("/repair/clearEmptyFile", async (c) => {
  if (!adminGuard(c)) return c.json(fail("没有权限!"));
  return c.json(ok("worker 数据模型中无 File 表, 该命令跳过。"));
});

// clearUserRecycle - 物理清空所有用户回收站
repairApi.all("/repair/clearUserRecycle", async (c) => {
  if (!adminGuard(c)) return c.json(fail("没有权限!"));
  const cleared = await clearUserRecycle(c.env);
  return c.json(ok("回收站已清空:" + cleared + " 项"));
});

// clearMyRecycle - 清空当前(登录)用户回收站 (001 clearMyRecycle)
repairApi.all("/repair/clearMyRecycle", async (c) => {
  if (!adminGuard(c)) return c.json(fail("没有权限!"));
  const user = c.get("currentUser");
  const cleared = await clearUserRecycleFor(c.env, user.id);
  return c.json(ok("回收站已清空:" + cleared + " 项"));
});

// clearUserRecycleNow - 清空指定用户回收站 (001 clearUserRecycleNow; 参数 userID)
repairApi.all("/repair/clearUserRecycleNow", async (c) => {
  if (!adminGuard(c)) return c.json(fail("没有权限!"));
  const params = await allParams(c);
  const userId = parseInt(params.userID || "0", 10) || 0;
  if (!userId) return c.json(fail("请指定 userID"));
  const cleared = await clearUserRecycleFor(c.env, userId);
  return c.json(ok("回收站已清空:" + cleared + " 项"));
});

// resetParentLevel - 重算部门层级
repairApi.all("/repair/resetParentLevel", async (c) => {
  if (!adminGuard(c)) return c.json(fail("没有权限!"));
  const updated = await resetParentLevel(c.env.DB);
  return c.json(ok("部门层级已重算:" + updated + " 条"));
});

// resetShareTo - 清理 share_to 孤儿记录
repairApi.all("/repair/resetShareTo", async (c) => {
  if (!adminGuard(c)) return c.json(fail("没有权限!"));
  const n = await resetShareTo(c.env.DB);
  return c.json(ok("share_to 已清理:" + n + " 条"));
});

// resetShare - 清理源已不存在的分享
repairApi.all("/repair/resetShare", async (c) => {
  if (!adminGuard(c)) return c.json(fail("没有权限!"));
  const r = await resetShare(c.env);
  return c.json(ok("分享已清理:" + r.share + " 条(含 share_to " + r.shareTo + " 条)"));
});

// listFileNotExists - 物理文件已不存在的分享记录
repairApi.all("/repair/listFileNotExists", async (c) => {
  if (!adminGuard(c)) return c.json(fail("没有权限!"));
  const list = await listFileNotExists(c.env);
  return c.json(ok(list));
});

// 依赖 001 Source/File 表、worker 数据模型无法等价复刻的命令, 统一返回跳过说明。
const SKIP_REASON: Record<string, string> = {
  clearErrorFile: "依赖 001 io_file 表 + 全量物理文件检查, worker(R2 无集中文件索引)无法等价复刻",
  resetSourceEmpty: "依赖 001 io_source 表(sourceHash/parentLevel), worker 无对应表",
  resetSourceFile: "依赖 001 io_source/io_file 表(fileID 关联), worker 无对应表",
  resetFileHash: "依赖 001 io_file 表(hashSimple/hashMd5), worker 无对应表",
  resetFileSource: "依赖 001 io_file/io_source 表, worker 无对应表",
  resetFileLink: "依赖 001 io_file 表(linkCount 引用计数), worker 无对应表",
  resetSourceHistory: "source_history 未存存储 baseKey, 无法定位历史版本 R2 对象",
  sourceNameInit: "依赖 001 io_source 表(name/nameSort 自然排序), worker 文件名存于 R2 key",
  sourceNameSort: "依赖 001 io_source 表(name/nameSort), worker 无对应表",
  clearSource: "依赖 001 sourceID 概念, worker 文件用 path 定位无 sourceID",
  resetSizeById: "worker 目录大小动态计算(R2 扫描), 无持久化大小字段",
  clearSameFile: "依赖 001 io_file 表(hashMd5 去重), worker 无对应表",
  resetParentLevelClear: "依赖 001 io_source 表(isDelete 状态), worker 无对应表",
  updateSourceLevel: "依赖 001 io_source 表层级结构, worker 层级由 groups.parent_level 承载(见 resetParentLevel)",
};

repairApi.all("/repair/:other", async (c) => {
  if (!adminGuard(c)) return c.json(fail("没有权限!"));
  const act = c.req.param("other");
  const reason = SKIP_REASON[act];
  return c.json(ok(reason ? act + ": " + reason : act + ": worker 数据模型中无对应表, 该命令跳过。"));
});

export { repairApi };
