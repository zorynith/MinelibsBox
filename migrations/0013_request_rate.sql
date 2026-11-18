-- 请求频率限制 (mirrors 001 Session userRequest / userRequestAllow)
CREATE TABLE IF NOT EXISTS request_rate (
  rate_key TEXT PRIMARY KEY,
  times TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);
