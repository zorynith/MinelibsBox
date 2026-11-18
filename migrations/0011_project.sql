-- 项目管理插件: 6 张核心表
-- 字段名与 001/plugins/project 的 MySQL 结构保持一一对应, 便于历史数据直连/迁移。
-- 注意: desc 为 SQLite 保留字, 读写时必须写成 "desc"。
-- 与 app/lib/db.ts 中 initDatabase 的 CREATE TABLE IF NOT EXISTS 保持一致。

CREATE TABLE IF NOT EXISTS plugin_project (
  projectID INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  "desc" TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 1, -- 1=正常 2=已归档 0=已删除 100=模版 101=模版已删除
  createUser INTEGER NOT NULL DEFAULT 0,
  modifyUser INTEGER NOT NULL DEFAULT 0,
  createTime INTEGER NOT NULL DEFAULT 0,
  modifyTime INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plugin_project_task (
  taskID INTEGER PRIMARY KEY AUTOINCREMENT,
  projectID INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL DEFAULT 0,          -- 父任务id; pid=0 为根
  name TEXT NOT NULL DEFAULT '',
  "desc" TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 1,       -- 与项目同构: 1=正常 2=已归档 0=已删除
  isList INTEGER NOT NULL DEFAULT 0,       -- 1=分组(列表)节点 0=任务
  sort INTEGER NOT NULL DEFAULT 0,         -- 同级内从 1 起连续
  ownerUser INTEGER NOT NULL DEFAULT 0,
  createUser INTEGER NOT NULL DEFAULT 0,
  modifyUser INTEGER NOT NULL DEFAULT 0,
  createTime INTEGER NOT NULL DEFAULT 0,
  modifyTime INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plugin_project_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projectID INTEGER NOT NULL DEFAULT 0,
  key TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '',
  createTime INTEGER NOT NULL DEFAULT 0,
  modifyTime INTEGER NOT NULL DEFAULT 0,
  UNIQUE (projectID, key)
);

CREATE TABLE IF NOT EXISTS plugin_project_task_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskID INTEGER NOT NULL DEFAULT 0,
  key TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '',
  createTime INTEGER NOT NULL DEFAULT 0,
  modifyTime INTEGER NOT NULL DEFAULT 0,
  UNIQUE (taskID, key)
);

CREATE TABLE IF NOT EXISTS plugin_project_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projectID INTEGER NOT NULL DEFAULT 0,    -- 任务成员时 projectID=0
  taskID INTEGER NOT NULL DEFAULT 0,       -- 项目成员时 taskID=0
  userID INTEGER NOT NULL DEFAULT 0,
  authType INTEGER NOT NULL DEFAULT 1,     -- 1=只读 2=可读写 3=管理员
  createTime INTEGER NOT NULL DEFAULT 0,
  modifyTime INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plugin_project_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projectID INTEGER NOT NULL DEFAULT 0,
  taskID INTEGER NOT NULL DEFAULT 0,       -- 项目级日志为 0
  userID INTEGER NOT NULL DEFAULT 0,
  logType TEXT NOT NULL DEFAULT '',
  "desc" TEXT NOT NULL DEFAULT '',
  createTime INTEGER NOT NULL DEFAULT 0,
  modifyTime INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_project_status ON plugin_project(status);
CREATE INDEX IF NOT EXISTS idx_project_createUser ON plugin_project(createUser);
CREATE INDEX IF NOT EXISTS idx_project_task_project ON plugin_project_task(projectID, status);
CREATE INDEX IF NOT EXISTS idx_project_task_pid ON plugin_project_task(pid);
CREATE INDEX IF NOT EXISTS idx_project_task_sort ON plugin_project_task(projectID, pid, sort);
CREATE INDEX IF NOT EXISTS idx_project_task_meta_key ON plugin_project_task_meta(key);
CREATE INDEX IF NOT EXISTS idx_project_meta_key ON plugin_project_meta(key);
CREATE INDEX IF NOT EXISTS idx_project_user_project ON plugin_project_user(projectID, taskID);
CREATE INDEX IF NOT EXISTS idx_project_user_user ON plugin_project_user(userID);
CREATE INDEX IF NOT EXISTS idx_project_log_project ON plugin_project_log(projectID, id);
CREATE INDEX IF NOT EXISTS idx_project_log_user ON plugin_project_log(userID);
CREATE INDEX IF NOT EXISTS idx_project_log_type ON plugin_project_log(projectID, logType);
