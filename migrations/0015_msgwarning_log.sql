-- 通知中心发送日志 (镜像 001 plugins/msgWarning/lib/data/plugin_msgwarning_log.sqlite.sql)
-- 与 initDatabase 中的 CREATE TABLE IF NOT EXISTS 保持一致。
CREATE TABLE IF NOT EXISTS plugin_msgwarning_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL DEFAULT '',
  userID INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  desc TEXT NOT NULL DEFAULT '',
  createTime INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msgwarning_log_time ON plugin_msgwarning_log(createTime);
