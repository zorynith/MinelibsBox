-- 任务结果临时缓存表: 供前端 abort 后轮询 taskAction 取回 (跨 Worker isolate 共享)。
-- 与 initDatabase 中的 CREATE TABLE IF NOT EXISTS task_result 保持一致。
CREATE TABLE IF NOT EXISTS task_result (
  id TEXT PRIMARY KEY,
  result TEXT NOT NULL DEFAULT '',
  expire_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_task_result_expire ON task_result(expire_at);
