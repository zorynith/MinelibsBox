/**
 * 已完成任务的临时结果缓存 (复刻 001 Cache::result_<id> 语义)
 *
 * 001 中: 同步执行的接口(如 explorer/index/unzipList)若携带 longTaskID,
 * 完成后把结果写入 result_<longTaskID> 缓存; 前端 500ms 未等到响应会 abort
 * 并轮询 taskAction get?id=longTaskID, 后端命中该缓存后返回
 * { code:true, data:结果, info:"task_finished" }, 前端据此拿到结果。
 *
 * 缓存落在 D1 的 task_result 表, 保证跨 Worker isolate 命中
 * (Cloudflare Workers 多 isolate 下内存 Map 不共享, 会导致轮询 miss
 *  而误报"操作失败")。读取即删除 (读一次清一次), 过期行在读取时顺带清理。
 */

const TTL_SEC = 300;

/**
 * 结果大小上限 (字节)。D1 单值可写上限约 1MB, 超大结果(巨型 zip 的
 * unzipList 等)直接写入会失败并拖慢接口; 超过上限则跳过缓存,
 * 此时前端若 abort 会 miss, 属可接受的残余限制。
 */
const MAX_VALUE_BYTES = 900 * 1024;

/** 写入/覆盖任务结果缓存; 结果超过 TTL 后视为失效。 */
export async function taskResultSet(db: D1Database, id: string, value: string, ttlSec = TTL_SEC): Promise<void> {
  if (value.length > MAX_VALUE_BYTES) return;
  const expireAt = Math.floor(Date.now() / 1000) + ttlSec;
  await db
    .prepare(
      `INSERT INTO task_result (id, result, expire_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET result = excluded.result, expire_at = excluded.expire_at`
    )
    .bind(id, value, expireAt)
    .run()
    .catch(() => null);
}

/** 读取并删除任务结果缓存; 未命中或已过期返回 undefined, 同时清理过期行。 */
export async function taskResultGet(db: D1Database, id: string): Promise<string | undefined> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(`SELECT result FROM task_result WHERE id = ? AND expire_at > ?`)
    .bind(id, now)
    .first()
    .catch(() => null);
  if (row) {
    await db.prepare(`DELETE FROM task_result WHERE id = ?`).bind(id).run().catch(() => null);
    return (row as { result: string }).result;
  }
  await db.prepare(`DELETE FROM task_result WHERE expire_at <= ?`).bind(now).run().catch(() => null);
  return undefined;
}
