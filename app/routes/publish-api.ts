/**
 * Explorer Publish API - 文件发布 (复刻 001 explorer/publish)
 *
 * 流程: makeTemp 复制到系统临时目录(__publish__/<userID>/<tempName>/),
 * 同时以内部协作分享(isShareTo=1)开放给指定用户; finished 从临时目录复制
 * 到发布目标路径后清理; cancle 直接清理临时目录与分享。
 *
 * 发布临时目录路径虚拟前缀: {publish:<userID>:<tempName>}/
 * share.sourcePath 存该虚拟路径, 分享项浏览/下载由 share-api 的
 * shareStorageKey 展开为 __publish__ 前缀。
 */
import { Hono } from "hono";
import { authRequired } from "../lib/auth";
import type { AuthUser } from "../lib/auth";
import { resolveFileSource } from "../lib/source";
import { keyFromBase, deleteDirectory } from "../lib/r2";
import {
  addShare,
  generateShareHash,
  normShareSourcePath,
} from "../lib/share";
import { parseAuthTo, replaceShareTo, removeShareToByShareIds } from "../lib/share-to";
import type { AuthToItem } from "../lib/share-to";

const publishApi = new Hono<{ Bindings: Env; Variables: { currentUser: AuthUser } }>();

publishApi.use("*", authRequired);

async function allParams(c: any): Promise<Record<string, string>> {
  const body: Record<string, string> = {};
  const rawBody = await c.req.parseBody().catch(() => ({}));
  for (const [k, v] of Object.entries(rawBody)) body[k] = typeof v === "string" ? v : "";
  return { ...c.req.query(), ...body };
}

async function copyKey(bucket: R2Bucket, srcKey: string, destKey: string): Promise<void> {
  const obj = await bucket.get(srcKey);
  if (!obj) return;
  await bucket.put(destKey, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
}

/** 递归复制前缀 srcPrefix → destPrefix。 */
async function copyPrefix(bucket: R2Bucket, srcPrefix: string, destPrefix: string): Promise<void> {
  const sp = srcPrefix.endsWith("/") ? srcPrefix : srcPrefix + "/";
  const dp = destPrefix.endsWith("/") ? destPrefix : destPrefix + "/";
  let cursor: string | undefined;
  do {
    const batch = await bucket.list({ prefix: sp, cursor });
    for (const o of batch.objects) {
      const rel = o.key.slice(sp.length);
      await copyKey(bucket, o.key, dp + rel);
    }
    cursor = batch.truncated ? batch.cursor : undefined;
  } while (cursor);
}

/**
 * 解析 userAuth 参数:
 * 001 格式 {userID: authID}; 也兼容 [{targetType,targetID,authID}]
 */
function parsePublishAuthTo(raw: string | undefined): AuthToItem[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) return parseAuthTo(raw);
    if (arr && typeof arr === "object") {
      const out: AuthToItem[] = [];
      for (const [uid, authID] of Object.entries(arr)) {
        const n = parseInt(uid, 10);
        const a = parseInt(String(authID), 10);
        if (n > 0 && a > 0) out.push({ targetType: "1", targetID: String(n), authID: String(a) });
      }
      return out;
    }
  } catch {
    // fallthrough
  }
  return [];
}

/** 根据虚拟路径解析 R2 源 key。返回 {isFolder, srcKey} 或 null。 */
async function resolveSourceKey(
  env: Env,
  user: AuthUser,
  virtualPath: string
): Promise<{ isFolder: boolean; srcKey: string } | null> {
  const src = await resolveFileSource(env, user, virtualPath);
  if (!src.ok) return null;
  const rel = src.relPath;
  const isFolder = rel.endsWith("/") || rel === "/";
  let srcKey: string;
  if (isFolder) {
    srcKey = keyFromBase(src.source.baseKey, rel);
    const listed = await env.FILES.list({ prefix: srcKey, limit: 1 });
    if (listed.objects.length === 0 && (listed.delimitedPrefixes || []).length === 0) return null;
  } else {
    srcKey = keyFromBase(src.source.baseKey, rel);
    const obj = await env.FILES.head(srcKey);
    if (!obj) return null;
  }
  return { isFolder, srcKey };
}

// makeTemp - 构造发布临时目录并生成访问路径
publishApi.all("/publish/makeTemp", async (c) => {
  const user = c.get("currentUser");
  const params = await allParams(c);
  const fromPath = params.fromPath || "";
  const publishPath = params.publishPath || "";
  const userAuth = params.userAuth || params.authTo || "";

  if (!fromPath || !publishPath) {
    return c.json({ code: false, data: "参数错误!" });
  }
  const srcInfo = await resolveSourceKey(c.env, user, fromPath);
  if (!srcInfo) {
    return c.json({ code: false, data: "该路径不存在!" });
  }
  const destInfo = await resolveFileSource(c.env, user, publishPath);
  if (!destInfo.ok || !destInfo.relPath.endsWith("/")) {
    return c.json({ code: false, data: "发布目录无效!" });
  }

  const authTo = parsePublishAuthTo(userAuth);
  if (authTo.length === 0) {
    return c.json({ code: false, data: "请指定可访问的用户!" });
  }

  const srcName = (fromPath.split("/").filter(Boolean).pop() || "publish").replace(/[\\/:*?"<>|]/g, "_");
  const tempName = `${srcName}_${Date.now().toString(36)}`;
  const tempKey = `__publish__/${user.id}/${tempName}` + (srcInfo.isFolder ? "/" : "");
  const tempPath = `{publish:${user.id}:${tempName}}` + (srcInfo.isFolder ? "/" : "");

  if (srcInfo.isFolder) {
    await copyPrefix(c.env.FILES, srcInfo.srcKey, tempKey);
    await c.env.FILES.put(tempKey + ".keep", "");
  } else {
    await copyKey(c.env.FILES, srcInfo.srcKey, tempKey);
  }

  const shareHash = await generateShareHash(c.env.DB);
  const shareID = await addShare(c.env.DB, {
    userID: user.id,
    title: srcName,
    shareHash,
    sourcePath: normShareSourcePath(tempPath, srcInfo.isFolder),
    isLink: 0,
    isShareTo: 1,
    password: "",
    timeTo: 0,
    options: { publishData: { fromPath, publishPath, time: Date.now() } },
  });
  await replaceShareTo(c.env.DB, shareID, authTo);

  return c.json({
    code: true,
    data: { tempPath, viewPath: `{shareItem:${shareID}}` + (srcInfo.isFolder ? "/" : "") },
  });
});

/** 根据发布临时路径找到对应 share（含 options.publishData）。 */
async function findPublishShare(
  env: Env,
  user: AuthUser,
  tempPath: string
): Promise<import("../lib/share").ShareRow | null> {
  const p = normShareSourcePath(tempPath, tempPath.endsWith("/"));
  const row = (await env.DB.prepare("SELECT * FROM share WHERE userID = ? AND sourcePath = ? LIMIT 1")
    .bind(user.id, p)
    .first()) as unknown as Record<string, unknown> | null;
  if (!row) return null;
  return {
    shareID: Number(row.shareID),
    title: String(row.title || ""),
    shareHash: String(row.shareHash || ""),
    userID: Number(row.userID),
    sourceID: String(row.sourceID || "0"),
    sourcePath: String(row.sourcePath || ""),
    url: String(row.url || ""),
    isLink: Number(row.isLink || 0),
    isShareTo: Number(row.isShareTo || 0),
    password: String(row.password || ""),
    timeTo: Number(row.timeTo || 0),
    numView: Number(row.numView || 0),
    numDownload: Number(row.numDownload || 0),
    options: String(row.options || "{}"),
    createTime: String(row.createTime || ""),
    modifyTime: String(row.modifyTime || ""),
  };
}

// cancle - 取消临时目录并清理分享
publishApi.all("/publish/cancle", async (c) => {
  const user = c.get("currentUser");
  const params = await allParams(c);
  const tempPath = params.tempPath || "";
  const m = tempPath.match(/^\{publish:(\d+):([^}]+)\}/);
  if (!m) {
    return c.json({ code: false, data: "参数错误!" });
  }
  const share = await findPublishShare(c.env, user, tempPath);
  if (share) {
    await removeShareToByShareIds(c.env.DB, [share.shareID]);
    await c.env.DB.prepare("DELETE FROM share WHERE shareID = ?").bind(share.shareID).run();
  }
  await deleteDirectory(c.env.FILES, `__publish__/${m[1]}/${m[2]}`);
  return c.json({ code: true, data: "ok" });
});

// finished - 发布: 从临时目录复制到发布目标后清理
publishApi.all("/publish/finished", async (c) => {
  const user = c.get("currentUser");
  const params = await allParams(c);
  const tempPath = params.tempPath || "";
  const m = tempPath.match(/^\{publish:(\d+):([^}]+)\}/);
  if (!m) {
    return c.json({ code: false, data: "参数错误!" });
  }
  const share = await findPublishShare(c.env, user, tempPath);
  let publishPath = params.publishPath || "";
  if (!publishPath && share) {
    try {
      const opts = JSON.parse(share.options || "{}") as { publishData?: { publishPath?: string } };
      publishPath = opts.publishData?.publishPath || "";
    } catch {
      // ignore
    }
  }
  if (!publishPath) {
    return c.json({ code: false, data: "发布目录无效!" });
  }
  const destInfo = await resolveFileSource(c.env, user, publishPath);
  if (!destInfo.ok) {
    return c.json({ code: false, data: "发布目录无效!" });
  }
  const tempPrefix = `__publish__/${m[1]}/${m[2]}`;
  const tempIsFolder = tempPath.endsWith("/");
  const tempName = tempPrefix.split("/").filter(Boolean).pop() || "temp";
  const destKey = keyFromBase(destInfo.source.baseKey, destInfo.relPath);
  if (tempIsFolder) {
    await copyPrefix(c.env.FILES, tempPrefix, keyFromBase(destKey, tempName));
  } else {
    await copyKey(c.env.FILES, tempPrefix, destKey + tempName);
  }
  if (share) {
    await removeShareToByShareIds(c.env.DB, [share.shareID]);
    await c.env.DB.prepare("DELETE FROM share WHERE shareID = ?").bind(share.shareID).run();
  }
  await deleteDirectory(c.env.FILES, tempPrefix);
  return c.json({ code: true, data: "ok" });
});

export { publishApi };
