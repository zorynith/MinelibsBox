-- 登录设备信息 (mirrors 001 filter.userLoginState cache item: time/sid/ip/ua/device/HTTP_X_PLATFORM)
ALTER TABLE sessions ADD COLUMN ip TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN ua TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN platform TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN device_json TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN login_time INTEGER NOT NULL DEFAULT 0;
