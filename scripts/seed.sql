/**
 * Database seed - creates default admin user
 * Run via: npx wrangler d1 execute minelibsbox --local --file=scripts/seed.sql
 */
INSERT OR IGNORE INTO users (username, password_hash, nickname, role, status)
VALUES (
  'admin',
  -- Default password: admin123 (SHA-256 hash)
  '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9',
  'Administrator',
  'admin',
  1
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('site_title', 'MinelibsBox');
INSERT OR IGNORE INTO settings (key, value) VALUES ('version', '4.54');
