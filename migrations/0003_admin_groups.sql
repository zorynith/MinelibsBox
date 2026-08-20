-- Extend groups table with MbesBox-compatible fields
ALTER TABLE groups ADD COLUMN size_max INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN size_use INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN status INTEGER NOT NULL DEFAULT 1;
ALTER TABLE groups ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN parent_level TEXT NOT NULL DEFAULT ',';

-- Extend roles table with MbesBox-compatible fields
ALTER TABLE roles ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE roles ADD COLUMN display INTEGER NOT NULL DEFAULT 1;
ALTER TABLE roles ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
ALTER TABLE roles ADD COLUMN administrator INTEGER NOT NULL DEFAULT 0;
ALTER TABLE roles ADD COLUMN "system" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE roles ADD COLUMN auth TEXT NOT NULL DEFAULT '';

-- Extend user_groups table with authID + sort (MbesBox user_group schema)
ALTER TABLE user_groups ADD COLUMN authID INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_groups ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;

-- Seed root department (groupID=1), mirrors 001 install addGroup()
INSERT OR IGNORE INTO groups (id, name, parent_id, parent_level, size_max, size_use, status, sort)
VALUES (1, '根部门', 0, ',1,', 0, 0, 1, 0);

-- Seed default roles, mirrors 001 install roleDefault()
INSERT OR IGNORE INTO roles (id, name, label, display, sort, administrator, "system", auth)
VALUES
  (1, 'Administrator', 'label-green-deep', 1, 2, 1, 1,
   'explorer.add,explorer.upload,explorer.view,explorer.download,explorer.share,explorer.shareLink,explorer.remove,explorer.edit,explorer.move,explorer.serverDownload,explorer.search,explorer.unzip,explorer.zip,user.edit,user.fav,admin.index.dashboard,admin.index.setting,admin.index.loginLog,admin.index.log,admin.index.server,admin.role.list,admin.role.edit,admin.job.list,admin.job.edit,admin.member.list,admin.member.userEdit,admin.member.userAuth,admin.member.groupEdit,admin.auth.list,admin.auth.edit,admin.plugin.list,admin.plugin.edit,admin.storage.list,admin.storage.edit,admin.autoTask.list,admin.autoTask.edit'),
  (2, '部门管理员', 'label-blue-deep', 1, 1, 0, 1,
   'explorer.add,explorer.upload,explorer.view,explorer.download,explorer.share,explorer.shareLink,explorer.remove,explorer.edit,explorer.move,explorer.serverDownload,explorer.search,explorer.unzip,explorer.zip,user.edit,user.fav,admin.index.loginLog,admin.index.log,admin.member.list,admin.member.userEdit,admin.member.userAuth,admin.member.groupEdit,admin.auth.list'),
  (3, '默认用户', 'label-blue-normal', 1, 0, 0, 1,
   'explorer.add,explorer.upload,explorer.view,explorer.download,explorer.share,explorer.shareLink,explorer.remove,explorer.edit,explorer.move,explorer.serverDownload,explorer.search,explorer.unzip,explorer.zip,user.edit,user.fav');

-- Link admin user to root department
INSERT OR IGNORE INTO user_groups (user_id, group_id, authID, sort)
SELECT id, 1, 1, 0 FROM users WHERE username = 'admin';
