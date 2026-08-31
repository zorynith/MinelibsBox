/**
 * D1 Database initialization and helper functions
 */

export async function initDatabase(db: D1Database): Promise<void> {
  const stmts = [
    // Users table (replaces system_member.php)
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      nickname TEXT DEFAULT '',
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      avatar TEXT DEFAULT '',
      sex INTEGER DEFAULT 1,
      role TEXT DEFAULT 'user',
      roleID INTEGER DEFAULT 0,
      status INTEGER DEFAULT 1,
      size_max INTEGER DEFAULT 0,
      config_json TEXT DEFAULT '{}',
      last_login INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,

    // User options table (replaces user_option.php, stores per-user setting key/value)
    `CREATE TABLE IF NOT EXISTS user_option (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userID INTEGER NOT NULL,
      type TEXT DEFAULT '',
      key TEXT NOT NULL,
      value TEXT DEFAULT '',
      modifyTime TEXT DEFAULT (datetime('now')),
      createTime TEXT DEFAULT (datetime('now')),
      UNIQUE (userID, type, key)
    )`,

    // Verify codes table (image captcha + message/email codes)
    `CREATE TABLE IF NOT EXISTS verify_code (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_key TEXT NOT NULL UNIQUE,
      type TEXT DEFAULT '',
      code TEXT NOT NULL,
      cnt INTEGER DEFAULT 0,
      time INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`,

    // Groups table (replaces system_group.php)
    `CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER DEFAULT 0,
      size_max INTEGER NOT NULL DEFAULT 0,
      size_use INTEGER NOT NULL DEFAULT 0,
      status INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      parent_level TEXT NOT NULL DEFAULT ',',
      io_driver INTEGER NOT NULL DEFAULT 0,
      auth_show_type TEXT NOT NULL DEFAULT 'all',
      auth_show_group TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`,

    // Roles table (replaces system_role.php)
    `CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      display INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      administrator INTEGER NOT NULL DEFAULT 0,
      "system" INTEGER NOT NULL DEFAULT 0,
      auth TEXT NOT NULL DEFAULT '',
      permissions_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )`,

    // User-Group mapping
    `CREATE TABLE IF NOT EXISTS user_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL,
      authID INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0,
      UNIQUE (user_id, group_id)
    )`,

    // Group-Role mapping
    `CREATE TABLE IF NOT EXISTS group_roles (
      group_id INTEGER NOT NULL,
      role_id INTEGER NOT NULL,
      PRIMARY KEY (group_id, role_id)
    )`,

    // Jobs (职位, replaces system_job.php)
    `CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      display INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`,

    // Permission groups (权限组, replaces system_auth.php; auth is an int bitmask)
    `CREATE TABLE IF NOT EXISTS auths (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      display INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      auth INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`,

    // Sessions table
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,

    // System settings (replaces system_setting.php)
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,

    // Favorites (replaces user_fav.php, follows original user_fav table structure)
    `CREATE TABLE IF NOT EXISTS user_fav (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userID INTEGER NOT NULL,
      tagID INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'folder',
      sort INTEGER NOT NULL DEFAULT 0,
      modifyTime TEXT DEFAULT (datetime('now')),
      createTime TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (userID) REFERENCES users(id) ON DELETE CASCADE
    )`,

    // User tags (个人标签, replaces user_tag.php)
    `CREATE TABLE IF NOT EXISTS user_tag (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userID INTEGER NOT NULL,
      name TEXT NOT NULL,
      style TEXT NOT NULL DEFAULT 'label-blue-normal',
      sort INTEGER NOT NULL DEFAULT 0,
      modifyTime TEXT DEFAULT (datetime('now')),
      createTime TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (userID) REFERENCES users(id) ON DELETE CASCADE
    )`,

    // User tag sources (标签关联文件, replaces user_tag_source.php)
    `CREATE TABLE IF NOT EXISTS user_tag_source (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userID INTEGER NOT NULL,
      tagID INTEGER NOT NULL,
      sourceID TEXT DEFAULT '',
      path TEXT NOT NULL,
      modifyTime TEXT DEFAULT (datetime('now')),
      createTime TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (userID) REFERENCES users(id) ON DELETE CASCADE
    )`,

    // Shares (replaces share.php)
    `CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      is_directory INTEGER DEFAULT 0,
      share_token TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,

    // Share (外链分享/内部协作分享, replaces 001 share table)
    // 注: userID=0 用于站间联合分享(001 系统分享), 故不设 userID 外键
    `CREATE TABLE IF NOT EXISTS share (
      shareID INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      shareHash TEXT NOT NULL DEFAULT '',
      userID INTEGER NOT NULL,
      sourceID TEXT NOT NULL DEFAULT '0',
      sourcePath TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      isLink INTEGER NOT NULL DEFAULT 0,
      isShareTo INTEGER NOT NULL DEFAULT 0,
      password TEXT NOT NULL DEFAULT '',
      timeTo INTEGER NOT NULL DEFAULT 0,
      numView INTEGER NOT NULL DEFAULT 0,
      numDownload INTEGER NOT NULL DEFAULT 0,
      options TEXT NOT NULL DEFAULT '{}',
      createTime TEXT DEFAULT (datetime('now')),
      modifyTime TEXT DEFAULT (datetime('now'))
    )`,

    // Audit logs
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      user_id INTEGER,
      path TEXT,
      ip TEXT,
      user_agent TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,

    // Light apps (轻应用, replaces 001 SystemLightApp model)
    `CREATE TABLE IF NOT EXISTS light_app (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      group_name TEXT NOT NULL DEFAULT 'tools',
      desc TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '{}',
      sort INTEGER NOT NULL DEFAULT 0,
      createTime TEXT DEFAULT (datetime('now')),
      modifyTime TEXT DEFAULT (datetime('now'))
    )`,

    // Plugin status & config (插件管理, replaces 001 Model('Plugin') DB storage)
    `CREATE TABLE IF NOT EXISTS plugin (
      id TEXT PRIMARY KEY,
      status INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      updateTime TEXT DEFAULT (datetime('now'))
    )`,

    // 存储配置 (001 io_source: 支持 R2/S3/OSS 等对象存储驱动; id=1 系统 R2 默认存储)
    `CREATE TABLE IF NOT EXISTS io_source (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      driver TEXT NOT NULL DEFAULT 'local',
      size_max INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      system INTEGER NOT NULL DEFAULT 0,
      config TEXT NOT NULL DEFAULT '{}',
      status INTEGER NOT NULL DEFAULT 1,
      add_time INTEGER NOT NULL DEFAULT 0,
      edit_time INTEGER NOT NULL DEFAULT 0
    )`,

    // 评论 (001 comment 表)
    `CREATE TABLE IF NOT EXISTS comment (
      commentID INTEGER PRIMARY KEY AUTOINCREMENT,
      pid INTEGER NOT NULL DEFAULT 0,
      userID INTEGER NOT NULL DEFAULT 0,
      targetType INTEGER NOT NULL DEFAULT 0,
      targetID INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL DEFAULT '',
      praiseCount INTEGER NOT NULL DEFAULT 0,
      commentCount INTEGER NOT NULL DEFAULT 0,
      status INTEGER NOT NULL DEFAULT 1,
      modifyTime INTEGER NOT NULL DEFAULT 0,
      createTime INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS comment_praise (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      commentID INTEGER NOT NULL DEFAULT 0,
      userID INTEGER NOT NULL DEFAULT 0,
      createTime INTEGER NOT NULL DEFAULT 0,
      modifyTime INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS comment_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      commentID INTEGER NOT NULL DEFAULT 0,
      key TEXT NOT NULL DEFAULT '',
      value TEXT NOT NULL DEFAULT '',
      createTime INTEGER NOT NULL DEFAULT 0,
      modifyTime INTEGER NOT NULL DEFAULT 0
    )`,

    // 系统公告 (001 admin/notice, SystemNotice)
    `CREATE TABLE IF NOT EXISTS notice (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      auth TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT '0',
      time INTEGER NOT NULL DEFAULT 0,
      type INTEGER NOT NULL DEFAULT 1,
      level INTEGER NOT NULL DEFAULT 0,
      enable INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0,
      createTime INTEGER NOT NULL DEFAULT 0,
      modifyTime INTEGER NOT NULL DEFAULT 0
    )`,
    // 用户收到的公告 (001 SystemNotice.userNotice*, 按用户冗余快照)
    `CREATE TABLE IF NOT EXISTS user_notice (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userID INTEGER NOT NULL DEFAULT 0,
      noticeID INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      time INTEGER NOT NULL DEFAULT 0,
      type INTEGER NOT NULL DEFAULT 1,
      level INTEGER NOT NULL DEFAULT 0,
      status INTEGER NOT NULL DEFAULT 0,
      "delete" INTEGER NOT NULL DEFAULT 0,
      createTime INTEGER NOT NULL DEFAULT 0,
      UNIQUE (userID, noticeID)
    )`,

    // Department group meta (mirrors 001 group_meta table, stores groupTag etc.)
    `CREATE TABLE IF NOT EXISTS group_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      groupID INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      createTime INTEGER NOT NULL,
      modifyTime INTEGER NOT NULL,
      UNIQUE (groupID, key)
    )`,

    // Department file-tag associations (mirrors 001 GroupTag model)
    `CREATE TABLE IF NOT EXISTS group_tag_file (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      groupID INTEGER NOT NULL,
      path TEXT NOT NULL,
      tagID INTEGER NOT NULL,
      createTime INTEGER NOT NULL,
      UNIQUE (groupID, path, tagID)
    )`,

    // Share targets (mirrors 001 share_to: 内部协作分享目标, targetType 1=user 2=group)
    `CREATE TABLE IF NOT EXISTS share_to (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shareID INTEGER NOT NULL,
      targetType INTEGER NOT NULL,
      targetID INTEGER NOT NULL,
      authID INTEGER NOT NULL,
      authDefine INTEGER NOT NULL DEFAULT 0,
      createTime INTEGER NOT NULL,
      modifyTime INTEGER NOT NULL,
      UNIQUE (shareID, targetType, targetID)
    )`,

    // Share report (分享举报, mirrors 001 share_report; status 0=待处理 1=已处理)
    `CREATE TABLE IF NOT EXISTS share_report (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shareID INTEGER NOT NULL,
      userID INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      status INTEGER NOT NULL DEFAULT 0,
      createTime TEXT DEFAULT (datetime('now'))
    )`,

    // Admin task queue (后台任务, mirrors 001 Task model; status: waiting/running/stop/kill)
    `CREATE TABLE IF NOT EXISTS task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT '',
      event TEXT NOT NULL DEFAULT '',
      param TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'waiting',
      processID TEXT NOT NULL DEFAULT '',
      userID INTEGER NOT NULL DEFAULT 0,
      result TEXT NOT NULL DEFAULT '',
      timeAdd INTEGER NOT NULL DEFAULT 0,
      timeUpdate INTEGER NOT NULL DEFAULT 0
    )`,

    // 任务结果临时缓存: 跨 Worker isolate 共享, 供前端 abort 后轮询 taskAction 取回
    `CREATE TABLE IF NOT EXISTS task_result (
      id TEXT PRIMARY KEY,
      result TEXT NOT NULL DEFAULT '',
      expire_at INTEGER NOT NULL DEFAULT 0
    )`,

    // Indexes
    `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(share_token)`,
    `CREATE INDEX IF NOT EXISTS idx_share_hash ON share(shareHash)`,
    `CREATE INDEX IF NOT EXISTS idx_share_user ON share(userID)`,
    `CREATE INDEX IF NOT EXISTS idx_user_fav_user ON user_fav(userID)`,
    `CREATE INDEX IF NOT EXISTS idx_user_fav_name ON user_fav(name)`,
    `CREATE INDEX IF NOT EXISTS idx_user_tag_user ON user_tag(userID)`,
    `CREATE INDEX IF NOT EXISTS idx_user_tag_source ON user_tag_source(tagID)`,
    `CREATE INDEX IF NOT EXISTS idx_comment_target ON comment(targetType, targetID)`,
    `CREATE INDEX IF NOT EXISTS idx_comment_user ON comment(userID)`,
    `CREATE INDEX IF NOT EXISTS idx_comment_pid ON comment(pid)`,
    `CREATE INDEX IF NOT EXISTS idx_comment_praise ON comment_praise(commentID)`,
    `CREATE INDEX IF NOT EXISTS idx_group_meta_groupID ON group_meta(groupID, key)`,
    `CREATE INDEX IF NOT EXISTS idx_group_tag_file_group ON group_tag_file(groupID, path)`,
    `CREATE INDEX IF NOT EXISTS idx_share_to_shareID ON share_to(shareID)`,
    `CREATE INDEX IF NOT EXISTS idx_share_to_target ON share_to(targetType, targetID)`,
    `CREATE INDEX IF NOT EXISTS idx_user_notice_user ON user_notice(userID)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_task_result_expire ON task_result(expire_at)`,
  ];

  // 批量建表/索引: 单次 D1 round-trip 完成, 显著降低 worker 冷启动时间
  await db.batch(stmts.map((s) => db.prepare(s)));

  // Backward-compatible column additions for existing tables
  const ensureColumns = async (table: string, cols: Array<[string, string]>) => {
    const rows = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const names = new Set(rows.results.map((r) => r.name));
    const missing = cols.filter(([c]) => !names.has(c));
    if (missing.length > 0) {
      await db.batch(missing.map(([, ddl]) => db.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)));
    }
  };
  await ensureColumns("groups", [
    ["size_max", "size_max INTEGER NOT NULL DEFAULT 0"],
    ["size_use", "size_use INTEGER NOT NULL DEFAULT 0"],
    ["status", "status INTEGER NOT NULL DEFAULT 1"],
    ["sort", "sort INTEGER NOT NULL DEFAULT 0"],
    ["parent_level", "parent_level TEXT NOT NULL DEFAULT ','"],
    ["io_driver", "io_driver INTEGER NOT NULL DEFAULT 0"],
    ["auth_show_type", "auth_show_type TEXT NOT NULL DEFAULT 'all'"],
    ["auth_show_group", "auth_show_group TEXT NOT NULL DEFAULT ''"],
  ]);
  await ensureColumns("roles", [
    ["label", "label TEXT NOT NULL DEFAULT ''"],
    ["display", "display INTEGER NOT NULL DEFAULT 1"],
    ["sort", "sort INTEGER NOT NULL DEFAULT 0"],
    ["administrator", "administrator INTEGER NOT NULL DEFAULT 0"],
    ["system", '"system" INTEGER NOT NULL DEFAULT 0'],
    ["auth", "auth TEXT NOT NULL DEFAULT ''"],
  ]);
  await ensureColumns("user_groups", [
    ["authID", "authID INTEGER NOT NULL DEFAULT 0"],
    ["sort", "sort INTEGER NOT NULL DEFAULT 0"],
  ]);
  await ensureColumns("users", [
    ["roleID", "roleID INTEGER NOT NULL DEFAULT 0"],
  ]);

  // Seed root department (groupID=1), mirrors 001 install addGroup()
  // Seed default admin user (密码 admin123), 幂等重建: 部署重置清空数据后自动恢复登录。
  // mirrors migrations/0002_seed.sql
  // Seed default roles / user_groups / auths; 全部 batch 单次往返
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO groups (id, name, parent_id, parent_level, size_max, size_use, status, sort)
       VALUES (1, '根部门', 0, ',1,', 0, 0, 1, 0)`
    ),
    db.prepare(
      `INSERT OR IGNORE INTO users (username, password_hash, nickname, role, status)
       VALUES ('admin', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9', 'Administrator', 'admin', 1)`
    ),
    db.prepare(
      `INSERT OR IGNORE INTO roles (id, name, label, display, sort, administrator, "system", auth)
       VALUES
         (1, 'Administrator', 'label-green-deep', 1, 2, 1, 1, ?),
         (2, '部门管理员', 'label-blue-deep', 1, 1, 0, 1, ?),
         (3, '默认用户', 'label-blue-normal', 1, 0, 0, 1, ?)`
    ).bind(
      "explorer.add,explorer.upload,explorer.view,explorer.download,explorer.share,explorer.shareLink,explorer.remove,explorer.edit,explorer.move,explorer.serverDownload,explorer.search,explorer.unzip,explorer.zip,user.edit,user.fav,admin.index.dashboard,admin.index.setting,admin.index.loginLog,admin.index.log,admin.index.server,admin.role.list,admin.role.edit,admin.job.list,admin.job.edit,admin.member.list,admin.member.userEdit,admin.member.userAuth,admin.member.groupEdit,admin.auth.list,admin.auth.edit,admin.plugin.list,admin.plugin.edit,admin.storage.list,admin.storage.edit,admin.autoTask.list,admin.autoTask.edit",
      "explorer.add,explorer.upload,explorer.view,explorer.download,explorer.share,explorer.shareLink,explorer.remove,explorer.edit,explorer.move,explorer.serverDownload,explorer.search,explorer.unzip,explorer.zip,user.edit,user.fav,admin.index.loginLog,admin.index.log,admin.member.list,admin.member.userEdit,admin.member.userAuth,admin.member.groupEdit,admin.auth.list",
      "explorer.add,explorer.upload,explorer.view,explorer.download,explorer.share,explorer.shareLink,explorer.remove,explorer.edit,explorer.move,explorer.serverDownload,explorer.search,explorer.unzip,explorer.zip,user.edit,user.fav"
    ),
    db.prepare(
      `INSERT OR IGNORE INTO user_groups (user_id, group_id, authID, sort)
       SELECT id, 1, 1, 0 FROM users WHERE username = 'admin'`
    ),
    db.prepare(
      `INSERT OR IGNORE INTO auths (id, name, label, display, sort, auth)
       VALUES
         (1, '完全控制', 'label-green-deep', 1, 2, 33554943),
         (2, '只读', 'label-blue-normal', 1, 0, 391),
         (3, '可读写', 'label-blue-deep', 1, 1, 511)`
    ),
    // Seed 默认 R2 存储 (001 io_source): 容量 10G (R2 账号级配额上限), driver 归类为对象存储(minio 兼容 S3)
    db.prepare(
      `INSERT OR IGNORE INTO io_source (id, name, driver, size_max, is_default, system, config, status, add_time, edit_time)
       VALUES (1, '系统存储', 'minio', 10737418240, 1, 1, '{}', 1, 0, 0)`
    ),
    db.prepare(
      `UPDATE user_groups SET authID = CASE
         WHEN authID IN (1, 2) THEN 1
         WHEN authID = 3 THEN 3
         ELSE 3 END
       WHERE authID IS NOT NULL`
    ),
  ]);

  // 老数据回填 roleID 主角色: admin→1, user→3 (roleID 列新增前创建的存量用户)
  await db.batch([
    db.prepare(`UPDATE users SET roleID = 1 WHERE role = 'admin' AND roleID = 0`),
    db.prepare(`UPDATE users SET roleID = 3 WHERE role = 'user' AND roleID = 0`),
  ]);
}

// Storage (io_source) helpers - 001 io_source 存储配置
export async function getDefaultIoSource(db: D1Database): Promise<Record<string, any> | null> {
  return db.prepare(
    "SELECT * FROM io_source WHERE status = 1 ORDER BY is_default DESC, id ASC LIMIT 1"
  ).first<Record<string, any>>().catch(() => null);
}

export async function getIoSourceById(db: D1Database, id: number): Promise<Record<string, any> | null> {
  if (!id || id <= 0) return null;
  return db.prepare("SELECT * FROM io_source WHERE id = ?").bind(id).first<Record<string, any>>().catch(() => null);
}

export async function getIoSourceList(db: D1Database): Promise<Record<string, any>[]> {
  return db.prepare("SELECT * FROM io_source ORDER BY id ASC").all<Record<string, any>>().then((r) => r.results).catch(() => []);
}

// User helpers
export async function getUserById(db: D1Database, id: number) {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
}

export async function getUserByUsername(db: D1Database, username: string) {
  return db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
}

/**
 * Search users by any identity field (name/username/email/phone).
 * Mirrors 001 Model('User')->userSearch($where, $field)
 */
export async function userSearch(db: D1Database, where: Record<string, string>, field: string = "userID") {
  const fields: string[] = [];
  const values: string[] = [];
  for (const [k, v] of Object.entries(where)) {
    if (!v) continue;
    fields.push(k);
    values.push(v);
  }
  if (fields.length === 0) return null;
  // 001 uses 001 column names in $where/$field; map them to the DB schema
  const colMap: Record<string, string> = {
    name: "username",
    nickName: "nickname",
    userID: "id",
    sizeMax: "size_max",
    lastLogin: "last_login",
  };
  const whereSql = fields.map((f) => `${colMap[f] || f} = ?`).join(" AND ");
  const selectCols = field.split(",").map((f) => colMap[f.trim()] || f.trim()).join(", ");
  return db.prepare(`SELECT ${selectCols} FROM users WHERE ${whereSql} LIMIT 1`).bind(...values).first();
}

/**
 * Update a user's fields, e.g. {nickName: 'x', email: 'y', avatar: 'z'}
 * Accepts both 001 field names (nickName) and DB column names (nickname).
 */
export async function userEdit(db: D1Database, userId: number, data: Record<string, string | number>) {
  const fieldMap: Record<string, string> = {
    nickName: "nickname",
    sizeMax: "size_max",
    lastLogin: "last_login",
  };
  const sets: string[] = [];
  const params: (string | number)[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    const col = fieldMap[k] || k;
    sets.push(`${col} = ?`);
    params.push(v as string | number);
  }
  if (sets.length === 0) return { success: true, meta: { changes: 0 } };
  params.push(userId);
  return db.prepare(`UPDATE users SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).bind(...params).run();
}

// User options (mirrors 001 Model('UserOption'))
export async function getUserOption(db: D1Database, userId: number, key: string, type: string = "") {
  const row = await db.prepare("SELECT value FROM user_option WHERE userID = ? AND type = ? AND key = ?")
    .bind(userId, type, key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function getAllUserOptions(db: D1Database, userId: number, type: string = "") {
  const result = await db.prepare("SELECT key, value FROM user_option WHERE userID = ? AND type = ?")
    .bind(userId, type).all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  for (const r of result.results) map[r.key] = r.value;
  return map;
}

export async function setUserOption(db: D1Database, userId: number, key: string, value: string, type: string = "") {
  const now = new Date().toISOString();
  return db.prepare(
    `INSERT INTO user_option (userID, type, key, value, modifyTime, createTime) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(userID, type, key) DO UPDATE SET value = excluded.value, modifyTime = excluded.modifyTime`
  ).bind(userId, type, key, value, now, now).run();
}

// Verify codes (image captcha + message codes) - mirrors 001 Session/Cache
export async function setVerifyCode(db: D1Database, key: string, code: string, type: string = "") {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    `INSERT INTO verify_code (code_key, type, code, cnt, time, created_at) VALUES (?, ?, ?, 0, ?, datetime('now'))
     ON CONFLICT(code_key) DO UPDATE SET code = excluded.code, cnt = 0, time = excluded.time, type = excluded.type`
  ).bind(key, type, code, now).run();
}

export async function getVerifyCode(db: D1Database, key: string) {
  return db.prepare("SELECT * FROM verify_code WHERE code_key = ?").bind(key).first();
}

export async function updateVerifyCodeCnt(db: D1Database, key: string, cnt: number) {
  return db.prepare("UPDATE verify_code SET cnt = ? WHERE code_key = ?").bind(cnt, key).run();
}

export async function deleteVerifyCode(db: D1Database, key: string) {
  return db.prepare("DELETE FROM verify_code WHERE code_key = ?").bind(key).run();
}

// Device list helpers (mirrors 001 Model('SystemLog')->deviceList)
export async function getDeviceList(db: D1Database, userId: number, fromTime: number) {
  const result = await db.prepare(
    `SELECT id, created_at AS createTime, user_agent AS desc, ip, '' AS browser, '' AS os
     FROM audit_logs WHERE user_id = ? AND created_at >= ? AND action IN ('login', 'user.index.loginSubmit')
     GROUP BY ip, desc ORDER BY createTime DESC`
  ).bind(userId, new Date(fromTime * 1000).toISOString()).all();
  return result.results;
}

export async function getUserLogs(db: D1Database, userId: number, page: number = 1, pageNum: number = 10, action?: string) {
  const offset = (page - 1) * pageNum;
  const where = action ? "AND action = ?" : "";
  const args = action ? [userId, action, pageNum, offset] : [userId, pageNum, offset];
  const result = await db.prepare(
    `SELECT id, action AS desc, path, ip, user_agent, detail, created_at AS createTime
     FROM audit_logs WHERE user_id = ? ${where} ORDER BY createTime DESC LIMIT ? OFFSET ?`
  ).bind(...(args as any)).all();
  const totalRow = await db.prepare(
    `SELECT COUNT(*) AS total FROM audit_logs WHERE user_id = ? ${where}`
  ).bind(...(action ? [userId, action] : [userId]) as any).first<{ total: number }>();
  return { list: result.results, total: totalRow?.total ?? 0 };
}

// Session helpers
export async function createSession(db: D1Database, userId: number, expiresHours: number = 24): Promise<string> {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + expiresHours * 3600 * 1000).toISOString();
  await db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(id, userId, expiresAt).run();
  return id;
}

export async function getSession(db: D1Database, sessionId: string) {
  return db.prepare(`
    SELECT s.*, u.username, u.nickname, u.role, u.roleID, u.config_json, u.email, u.phone, u.avatar, u.sex, u.status, u.size_max, u.last_login
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sessionId).first();
}

export async function deleteSession(db: D1Database, sessionId: string) {
  return db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

// Settings helpers
export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string) {
  return db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
}

// User fav helpers (follows 001 user_fav model behavior)
export async function getFavorites(db: D1Database, userId: number) {
  const result = await db.prepare(
    "SELECT * FROM user_fav WHERE userID = ? AND tagID = 0 ORDER BY sort ASC, id ASC"
  ).bind(userId).all();
  return result.results;
}

export async function addFavorite(db: D1Database, userId: number, filePath: string, fileName: string, favType: string = "folder") {
  const now = new Date().toISOString();
  const sortRow = await db.prepare(
    "SELECT COALESCE(MAX(sort), 0) + 1 AS nextSort FROM user_fav WHERE userID = ? AND tagID = 0"
  ).bind(userId).first<{ nextSort: number }>();
  return db.prepare(
    "INSERT INTO user_fav (userID, tagID, name, path, type, sort, modifyTime, createTime) VALUES (?, 0, ?, ?, ?, ?, ?, ?)"
  ).bind(userId, fileName, filePath, favType, sortRow?.nextSort ?? 0, now, now).run();
}

export async function removeFavoriteByName(db: D1Database, userId: number, name: string) {
  return db.prepare("DELETE FROM user_fav WHERE userID = ? AND name = ?")
    .bind(userId, name).run();
}

export async function renameFavorite(db: D1Database, userId: number, name: string, newName: string) {
  const now = new Date().toISOString();
  return db.prepare("UPDATE user_fav SET name = ?, modifyTime = ? WHERE userID = ? AND name = ?")
    .bind(newName, now, userId, name).run();
}

export async function favMoveTop(db: D1Database, userId: number, name: string) {
  const minRow = await db.prepare(
    "SELECT COALESCE(MIN(sort), 0) AS minSort FROM user_fav WHERE userID = ? AND tagID = 0"
  ).bind(userId).first<{ minSort: number }>();
  const now = new Date().toISOString();
  return db.prepare(
    "UPDATE user_fav SET sort = ?, modifyTime = ? WHERE userID = ? AND name = ? AND tagID = 0"
  ).bind((minRow?.minSort ?? 0) - 1, now, userId, name).run();
}

export async function favMoveBottom(db: D1Database, userId: number, name: string) {
  const maxRow = await db.prepare(
    "SELECT COALESCE(MAX(sort), 0) AS maxSort FROM user_fav WHERE userID = ? AND tagID = 0"
  ).bind(userId).first<{ maxSort: number }>();
  const now = new Date().toISOString();
  return db.prepare(
    "UPDATE user_fav SET sort = ?, modifyTime = ? WHERE userID = ? AND name = ? AND tagID = 0"
  ).bind((maxRow?.maxSort ?? 0) + 1, now, userId, name).run();
}

export async function favResetSort(db: D1Database, userId: number, idArray: Array<number | string>) {
  const now = new Date().toISOString();
  let idx = 0;
  for (const id of idArray) {
    await db.prepare("UPDATE user_fav SET sort = ?, modifyTime = ? WHERE userID = ? AND id = ?")
      .bind(idx++, now, userId, id).run();
  }
  return { success: true };
}

// Audit log helper
export async function addAuditLog(db: D1Database, action: string, userId: number | null, path: string | null, ip: string | null, ua: string | null, detail: string | null) {
  return db.prepare("INSERT INTO audit_logs (action, user_id, path, ip, user_agent, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(action, userId, path, ip, ua, detail).run();
}

// ============ User tags (个人标签) ============

const DEFAULT_TAGS: { name: string; style: string }[] = [
  { name: "学习资料", style: "label-blue-normal" },
  { name: "工作资料", style: "label-red-normal" },
  { name: "个人资料", style: "label-yellow-normal" },
  { name: "其他", style: "label-green-normal" },
];

/** List a user's tags (creating default tags on first access). */
export async function getUserTags(db: D1Database, userID: number) {
  await initDefaultTags(db, userID);
  const result = await db.prepare(
    "SELECT * FROM user_tag WHERE userID = ? ORDER BY sort ASC, id ASC"
  ).bind(userID).all();
  return result.results;
}

/** Seed default tags when the user has none (mirrors 001 tag.initUserData). */
export async function initDefaultTags(db: D1Database, userID: number) {
  const done = await getUserOption(db, userID, "userTagInit", "flag");
  if (done === "ok") return;
  const existing = await db.prepare("SELECT COUNT(*) AS c FROM user_tag WHERE userID = ?").bind(userID).first<{ c: number }>();
  if ((existing?.c ?? 0) > 0) {
    await setUserOption(db, userID, "userTagInit", "ok", "flag");
    return;
  }
  const now = new Date().toISOString();
  let sort = 0;
  for (const t of DEFAULT_TAGS) {
    await db.prepare(
      "INSERT INTO user_tag (userID, name, style, sort, modifyTime, createTime) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(userID, t.name, t.style, sort++, now, now).run();
  }
  await setUserOption(db, userID, "userTagInit", "ok", "flag");
}

export async function addTag(db: D1Database, userID: number, name: string, style: string) {
  await initDefaultTags(db, userID);
  const dup = await db.prepare("SELECT id FROM user_tag WHERE userID = ? AND name = ?").bind(userID, name).first();
  if (dup) return null;
  const now = new Date().toISOString();
  const sortRow = await db.prepare(
    "SELECT COALESCE(MAX(sort), 0) + 1 AS nextSort FROM user_tag WHERE userID = ?"
  ).bind(userID).first<{ nextSort: number }>();
  const res = await db.prepare(
    "INSERT INTO user_tag (userID, name, style, sort, modifyTime, createTime) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(userID, name, style, sortRow?.nextSort ?? 0, now, now).run();
  return res.meta.last_row_id as number;
}

export async function editTag(db: D1Database, userID: number, tagID: number, data: { name?: string; style?: string }) {
  const now = new Date().toISOString();
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (data.name !== undefined) { sets.push("name = ?"); params.push(data.name); }
  if (data.style !== undefined) { sets.push("style = ?"); params.push(data.style); }
  if (sets.length === 0) return { success: true };
  sets.push("modifyTime = ?"); params.push(now);
  params.push(userID, tagID);
  return db.prepare(`UPDATE user_tag SET ${sets.join(", ")} WHERE userID = ? AND id = ?`).bind(...params).run();
}

export async function removeTag(db: D1Database, userID: number, tagID: number) {
  await db.prepare("DELETE FROM user_tag_source WHERE tagID = ? AND userID = ?").bind(tagID, userID).run();
  return db.prepare("DELETE FROM user_tag WHERE id = ? AND userID = ?").bind(tagID, userID).run();
}

export async function tagMoveTop(db: D1Database, userID: number, tagID: number) {
  const minRow = await db.prepare(
    "SELECT COALESCE(MIN(sort), 0) AS minSort FROM user_tag WHERE userID = ?"
  ).bind(userID).first<{ minSort: number }>();
  const now = new Date().toISOString();
  return db.prepare("UPDATE user_tag SET sort = ?, modifyTime = ? WHERE userID = ? AND id = ?")
    .bind((minRow?.minSort ?? 0) - 1, now, userID, tagID).run();
}

export async function tagMoveBottom(db: D1Database, userID: number, tagID: number) {
  const maxRow = await db.prepare(
    "SELECT COALESCE(MAX(sort), 0) AS maxSort FROM user_tag WHERE userID = ?"
  ).bind(userID).first<{ maxSort: number }>();
  const now = new Date().toISOString();
  return db.prepare("UPDATE user_tag SET sort = ?, modifyTime = ? WHERE userID = ? AND id = ?")
    .bind((maxRow?.maxSort ?? 0) + 1, now, userID, tagID).run();
}

export async function tagResetSort(db: D1Database, userID: number, idArray: Array<number | string>) {
  const now = new Date().toISOString();
  let idx = 0;
  for (const id of idArray) {
    await db.prepare("UPDATE user_tag SET sort = ?, modifyTime = ? WHERE userID = ? AND id = ?")
      .bind(idx++, now, userID, id).run();
  }
  return { success: true };
}

/** List the file paths associated with a tag. */
export async function getTagSources(db: D1Database, userID: number, tagID: number) {
  const result = await db.prepare(
    "SELECT * FROM user_tag_source WHERE userID = ? AND tagID = ? ORDER BY id ASC"
  ).bind(userID, tagID).all();
  return result.results;
}

export async function tagAddSources(db: D1Database, userID: number, tagID: number, files: string[]) {
  const now = new Date().toISOString();
  for (const f of files) {
    const path = f.endsWith("/") ? f.slice(0, -1) : f;
    const dup = await db.prepare(
      "SELECT id FROM user_tag_source WHERE userID = ? AND tagID = ? AND path = ?"
    ).bind(userID, tagID, path).first();
    if (dup) continue;
    await db.prepare(
      "INSERT INTO user_tag_source (userID, tagID, sourceID, path, modifyTime, createTime) VALUES (?, ?, '', ?, ?, ?)"
    ).bind(userID, tagID, path, now, now).run();
  }
  return { success: true };
}

export async function tagRemoveSources(db: D1Database, userID: number, tagID: number, files: string[]) {
  for (const f of files) {
    const path = f.endsWith("/") ? f.slice(0, -1) : f;
    await db.prepare(
      "DELETE FROM user_tag_source WHERE userID = ? AND tagID = ? AND path = ?"
    ).bind(userID, tagID, path).run();
  }
  return { success: true };
}

// LightApp helpers (mirrors 001 SystemLightApp model)
export interface LightAppItem {
  id?: number;
  name: string;
  group: string;
  desc: string;
  content: {
    type: string;
    value: string;
    icon: string;
    options: Record<string, any>;
  };
}

export async function getLightApps(db: D1Database, group: string = "all"): Promise<LightAppItem[]> {
  const rows = await db.prepare(
    "SELECT * FROM light_app ORDER BY sort ASC, id ASC"
  ).all<Record<string, any>>();
  const out: LightAppItem[] = [];
  for (const r of rows.results) {
    if (group !== "all" && r.group_name !== group) continue;
    out.push({
      id: r.id,
      name: r.name,
      group: r.group_name,
      desc: r.desc || "",
      content: safeParseJson(r.content) as LightAppItem["content"],
    });
  }
  return out;
}

export async function addLightApp(db: D1Database, app: LightAppItem): Promise<number | null> {
  const dup = await db.prepare("SELECT id FROM light_app WHERE name = ?").bind(app.name).first();
  if (dup) return null;
  const sortRow = await db.prepare(
    "SELECT COALESCE(MAX(sort), 0) + 1 AS nextSort FROM light_app"
  ).first<{ nextSort: number }>();
  const now = new Date().toISOString();
  const res = await db.prepare(
    "INSERT INTO light_app (name, group_name, desc, content, sort, createTime, modifyTime) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(app.name, app.group || "tools", app.desc || "", JSON.stringify(app.content || {}), sortRow?.nextSort ?? 0, now, now).run();
  return res.meta.last_row_id as number;
}

export async function updateLightApp(db: D1Database, name: string, app: LightAppItem): Promise<boolean> {
  const target = await db.prepare("SELECT id FROM light_app WHERE name = ?").bind(name).first();
  if (!target) return false;
  const now = new Date().toISOString();
  await db.prepare(
    "UPDATE light_app SET name = ?, group_name = ?, desc = ?, content = ?, modifyTime = ? WHERE name = ?"
  ).bind(app.name, app.group || "tools", app.desc || "", JSON.stringify(app.content || {}), now, name).run();
  return true;
}

export async function removeLightApp(db: D1Database, name: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM light_app WHERE name = ?").bind(name).run();
  return (res.meta.changes ?? 0) > 0;
}

// Plugin status/config helpers (mirrors 001 Model('Plugin'))
export async function getPluginMeta(db: D1Database, id: string): Promise<{ status: number; config: Record<string, any> }> {
  const row = await db.prepare("SELECT status, config_json FROM plugin WHERE id = ?").bind(id).first<{ status: number; config_json: string }>();
  return {
    status: row ? row.status : 1,
    config: row ? safeParseJson(row.config_json) : {},
  };
}

export async function setPluginStatus(db: D1Database, id: string, status: number) {
  const now = new Date().toISOString();
  return db.prepare(
    "INSERT INTO plugin (id, status, config_json, updateTime) VALUES (?, ?, '{}', ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, updateTime = excluded.updateTime"
  ).bind(id, status, now).run();
}

export async function setPluginConfig(db: D1Database, id: string, config: Record<string, any>) {
  const now = new Date().toISOString();
  return db.prepare(
    "INSERT INTO plugin (id, status, config_json, updateTime) VALUES (?, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updateTime = excluded.updateTime"
  ).bind(id, JSON.stringify(config || {}), now).run();
}

function safeParseJson(s: string): any {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}
