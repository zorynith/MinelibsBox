-- 文件/文件夹元信息表: 对齐 001 io_source 的 desc/systemSort/systemLock/folderPassword/user_source* 字段。
-- 与 initDatabase 中的 CREATE TABLE IF NOT EXISTS source_meta 保持一致。
CREATE TABLE IF NOT EXISTS source_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sourceID TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  createTime INTEGER NOT NULL DEFAULT 0,
  modifyTime INTEGER NOT NULL DEFAULT 0,
  UNIQUE (sourceID, key)
);
CREATE INDEX IF NOT EXISTS idx_source_meta_sourceID ON source_meta(sourceID, key);
