-- 表结构与 src/schema.ts 保持一致。Worker 首次请求时也会自动建表，
-- 这个文件主要用于本地开发 `wrangler d1 migrations apply`。全部 IF NOT EXISTS，可重复执行。

-- 账号：号主录入的句乐部账号，密码用 AES-GCM 加密后保存
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,          -- 11 位手机号，不带 86
  password_enc TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 分组：租户输入分组代码加入，只能看到、上报分组里的账号
CREATE TABLE IF NOT EXISTS share_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_accounts (
  group_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  PRIMARY KEY (group_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_group_accounts_account ON group_accounts(account_id);

-- 成员：每个插件输入一次分组代码就是一个成员；token 只存哈希
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_members_group ON members(group_id);

-- 使用记录：插件第一次看到某个登录会话时新建一条，之后每次心跳更新
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  nickname TEXT NOT NULL,              -- 冗余保存，成员被删后历史记录仍能显示是谁
  site_session_id TEXT NOT NULL,       -- 句乐部 get-session 返回的 session.id
  login_at INTEGER NOT NULL,           -- 插件第一次看到这个会话在用的时间
  last_heartbeat INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,   -- 最近一次心跳时是否在操作
  logout_at INTEGER,
  logout_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id, last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_sessions_member_open ON sessions(member_id, logout_at);

-- 失败尝试（输错分组代码 / 后台密码）用于限流；只存来源的哈希，24 小时后清理
CREATE TABLE IF NOT EXISTS auth_failures (
  source TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_failures ON auth_failures(source, at);
