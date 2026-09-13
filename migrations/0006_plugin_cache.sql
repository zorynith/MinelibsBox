-- 插件运行时缓存表: 供 yzOffice 等需要跨请求保存任务状态的插件使用。
-- 与 initDatabase 中的 CREATE TABLE IF NOT EXISTS plugin_cache 保持一致。
CREATE TABLE IF NOT EXISTS plugin_cache (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '',
  expire_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_plugin_cache_expire ON plugin_cache(expire_at);
