-- 001 原版约定: size_max 以 GB 数值存储 (groups/users/io_source 统一 GB 语义, size_use 字节)。
-- 历史复刻误将前端 GB 输入 ×1024³ 存为字节, 此处迁移回 GB 语义。
-- 判定阈值: 字节值 >= 1GiB(1073741824), GB 配置值通常远小于该值, 避免误伤。
UPDATE io_source SET size_max = size_max / 1073741824 WHERE size_max >= 1073741824;
UPDATE groups SET size_max = size_max / 1073741824 WHERE size_max >= 1073741824;
UPDATE users SET size_max = size_max / 1073741824 WHERE size_max >= 1073741824;
