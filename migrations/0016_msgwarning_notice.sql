-- 通知中心待推送消息 (ktips / kwarn)
-- 与 initDatabase 中的 CREATE TABLE IF NOT EXISTS 保持一致。
CREATE TABLE IF NOT EXISTS plugin_msgwarning_notice (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userID INTEGER NOT NULL DEFAULT 0,
  event TEXT NOT NULL DEFAULT '',
  level INTEGER NOT NULL DEFAULT 1,
  method TEXT NOT NULL DEFAULT 'ktips',
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  createTime INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msgwarning_notice_user ON plugin_msgwarning_notice(userID, status);
