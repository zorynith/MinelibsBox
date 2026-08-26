-- MbesBox D1 Database Schema
-- Replaces PHP FileCache (JSON file-based storage)

-- Users table (replaces system_member.php)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    nickname TEXT DEFAULT '',
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    sex INTEGER DEFAULT 1,
    role TEXT DEFAULT 'user',
    status INTEGER DEFAULT 1,
    size_max INTEGER DEFAULT 0,
    config_json TEXT DEFAULT '{}',
    last_login INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- User options table (replaces user_option.php)
CREATE TABLE IF NOT EXISTS user_option (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userID INTEGER NOT NULL,
    type TEXT DEFAULT '',
    key TEXT NOT NULL,
    value TEXT DEFAULT '',
    modifyTime TEXT DEFAULT (datetime('now')),
    createTime TEXT DEFAULT (datetime('now')),
    UNIQUE (userID, type, key)
);

-- Verify codes table (image captcha + message/email codes)
CREATE TABLE IF NOT EXISTS verify_code (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_key TEXT NOT NULL UNIQUE,
    type TEXT DEFAULT '',
    code TEXT NOT NULL,
    cnt INTEGER DEFAULT 0,
    time INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Groups table (replaces system_group.php)
CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Roles table (replaces system_role.php)
CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    permissions_json TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
);

-- User-Group mapping
CREATE TABLE IF NOT EXISTS user_groups (
    user_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, group_id)
);

-- Group-Role mapping
CREATE TABLE IF NOT EXISTS group_roles (
    group_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    PRIMARY KEY (group_id, role_id)
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- System settings (replaces system_setting.php)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Favorites (replaces fav.php)
CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Shares (replaces share.php)
CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    is_directory INTEGER DEFAULT 0,
    share_token TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Audit logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    user_id INTEGER,
    path TEXT,
    ip TEXT,
    user_agent TEXT,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(share_token);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
