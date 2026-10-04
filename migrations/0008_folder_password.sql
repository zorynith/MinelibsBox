-- 加密文件夹已通过校验的会话 (mirrors 001 Session folderPassword_{sourceID})
CREATE TABLE IF NOT EXISTS folder_password (
  userID INTEGER NOT NULL,
  sourceID TEXT NOT NULL,
  password TEXT NOT NULL,
  time INTEGER NOT NULL DEFAULT 0,
  UNIQUE (userID, sourceID)
);
