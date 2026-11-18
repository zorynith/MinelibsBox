-- 文档密级 (复刻 001 SourceSecret 模型: sourceID -> typeID)
CREATE TABLE IF NOT EXISTS source_secret (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sourceID TEXT NOT NULL,
  typeID TEXT NOT NULL DEFAULT '',
  createUser INTEGER NOT NULL DEFAULT 0,
  createTime INTEGER NOT NULL DEFAULT 0,
  modifyTime INTEGER NOT NULL DEFAULT 0,
  UNIQUE (sourceID)
);

CREATE INDEX IF NOT EXISTS idx_source_secret_sourceID ON source_secret(sourceID);
