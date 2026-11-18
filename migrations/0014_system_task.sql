-- 系统计划任务表 (镜像 001 SystemTask): admin/autoTask/* 接口与插件内置任务(如通知中心)共用。
-- 此前仅代码引用未建表, 导致 admin/autoTask/get|enable 等接口 SQL 报错。
-- 与 initDatabase 中的 CREATE TABLE IF NOT EXISTS system_task 保持一致。
CREATE TABLE IF NOT EXISTS system_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'method',
  event TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL DEFAULT '',
  desc TEXT NOT NULL DEFAULT '',
  enable INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  last_time INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_system_task_event ON system_task(event);
