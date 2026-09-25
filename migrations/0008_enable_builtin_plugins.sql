-- 一次性数据修复: 启用内置插件 officeLive / yzOffice。
-- 线上 D1 的 plugin 表中这两行 status 为历史脏值(非 1), 导致用户端
-- renderPluginsJs 与管理端"安装"标签同时隐藏它们。此处显式置为 1。
-- 幂等: 行存在则只更新 status, 保留已有 config_json; 行不存在则插入。
-- 迁移只执行一次, 之后用户若在后台禁用不会被本文件重新启用。
INSERT INTO plugin (id, status, config_json, updateTime)
VALUES ('officeLive', 1, '{}', datetime('now')),
       ('yzOffice',   1, '{}', datetime('now'))
ON CONFLICT(id) DO UPDATE SET status = 1, updateTime = excluded.updateTime;
