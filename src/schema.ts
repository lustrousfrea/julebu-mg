// 数据库表结构。既供本地 `wrangler d1 migrations apply` 使用（见 migrations/），
// 也供 Worker 首次请求时自动建表使用（见 ensureSchema），两边内容保持一致。
// 全部用 IF NOT EXISTS，重复执行安全。

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    password_enc TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS share_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS group_accounts (
    group_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    PRIMARY KEY (group_id, account_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_group_accounts_account ON group_accounts(account_id)`,
  `CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    nickname TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_members_group ON members(group_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    nickname TEXT NOT NULL,
    site_session_id TEXT NOT NULL,
    login_at INTEGER NOT NULL,
    last_heartbeat INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    logout_at INTEGER,
    logout_reason TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id, last_heartbeat)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_member_open ON sessions(member_id, logout_at)`,
  `CREATE TABLE IF NOT EXISTS auth_failures (
    source TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_failures ON auth_failures(source, at)`,
];

let ready = false;

// 首次请求时建表；建好后本 isolate 内不再重复。多个请求并发时可能各建一次，但 IF NOT EXISTS 无副作用。
export async function ensureSchema(db: D1Database): Promise<void> {
  if (ready) return;
  await db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
  ready = true;
}
