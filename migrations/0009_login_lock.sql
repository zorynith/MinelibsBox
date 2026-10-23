-- 密码连续错误锁定 (mirrors 001 Cache user_login_lock_{userID}_{ip})
CREATE TABLE IF NOT EXISTS login_lock (
  lock_key TEXT PRIMARY KEY,
  times TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);
