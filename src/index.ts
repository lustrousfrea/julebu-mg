import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { ensureSchema } from './schema';
import {
  decryptSecret,
  encryptSecret,
  randomCode,
  randomToken,
  safeEqual,
  sha256Hex,
  signToken,
  verifyToken,
} from './crypto';

type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
  ENCRYPTION_KEY: string;
};

type Member = { id: number; group_id: number; nickname: string };
type AppEnv = { Bindings: Env; Variables: { member: Member } };
type Ctx = Context<AppEnv>;

type AccountRow = { id: number; label: string; phone: string; note: string; created_at: number; updated_at: number };
type GroupRow = { id: number; name: string; code: string; created_at: number };
type SessionRow = {
  id: number;
  account_id: number;
  group_id: number;
  member_id: number;
  nickname: string;
  login_at: number;
  last_heartbeat: number;
  active: number;
  logout_at: number | null;
  logout_reason: string | null;
};

// 超过这个时间没收到心跳就算失联（offline_reason = timeout），界面上显示“失联”而不是“空闲”，
// 因为可能只是断网或电脑睡眠，对方仍登录着。插件每 45 秒发一次。
const ONLINE_TIMEOUT_MS = 2 * 60 * 1000;
// 同一次句乐部登录失联后在这个时间内恢复上报，就接着原来的使用记录，不另起一条
const RESUME_WINDOW_MS = 30 * 60 * 1000;
const ADMIN_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 同一来源 10 分钟内最多失败 10 次（输错分组代码 / 后台密码）。
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 10;
// 插件可以上报的下线原因；timeout / switch / removed 由服务器自己写。
const OFFLINE_REASONS = new Set(['logout', 'tab_closed', 'not_logged_in', 'not_in_group']);

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: '服务器出错了，请稍后再试' }, 500);
});

// 首次访问 API 时自动建表，一键部署后无需手动跑数据库迁移
app.use('/api/*', async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

// ---------- 工具 ----------

function fail(c: Ctx, message: string, status: 400 | 401 | 403 | 404 | 409 | 429 | 500 = 400) {
  return c.json({ error: message }, status);
}

async function readJson<T>(c: Ctx): Promise<Partial<T>> {
  try {
    return ((await c.req.json()) ?? {}) as Partial<T>;
  } catch {
    return {};
  }
}

function bearer(c: Ctx): string {
  return c.req.header('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
}

function toId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 句乐部 get-session 返回的是 "86" + 11 位，后台录入的是 11 位，统一成 11 位再比较。
function normalizePhone(raw: unknown): string {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length > 11 && digits.startsWith('86')) digits = digits.slice(2);
  return digits;
}

function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone;
}

function isUniqueError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed');
}

// ---------- 限流 ----------

async function failureSource(c: Ctx, kind: string): Promise<string> {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  // 只存哈希，不保存原始 IP
  return `${kind}:${(await sha256Hex(`${c.env.ENCRYPTION_KEY}:${ip}`)).slice(0, 32)}`;
}

async function tooManyFailures(c: Ctx, source: string): Promise<boolean> {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM auth_failures WHERE source = ? AND at > ?')
    .bind(source, Date.now() - FAIL_WINDOW_MS)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= FAIL_LIMIT;
}

async function recordFailure(c: Ctx, source: string) {
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO auth_failures (source, at) VALUES (?, ?)').bind(source, now),
    c.env.DB.prepare('DELETE FROM auth_failures WHERE at < ?').bind(now - 24 * 60 * 60 * 1000),
  ]);
}

// ---------- 账号状态 ----------

function describeSession(s: SessionRow, now: number) {
  const fresh = now - s.last_heartbeat <= ONLINE_TIMEOUT_MS;
  // 心跳超时的记录没有 logout_at，下线时间按最后一次心跳算
  const offlineAt = s.logout_at ?? (fresh ? null : s.last_heartbeat);
  return {
    member_id: s.member_id,
    nickname: s.nickname,
    login_at: s.login_at,
    last_heartbeat: s.last_heartbeat,
    active: s.active === 1,
    online: offlineAt === null,
    offline_at: offlineAt,
    offline_reason: s.logout_at !== null ? s.logout_reason : offlineAt !== null ? 'timeout' : null,
    duration_ms: (offlineAt ?? now) - s.login_at,
  };
}

type SessionView = ReturnType<typeof describeSession>;
type AccountStatus = {
  online: boolean;
  users: SessionView[]; // 当前在线的人。正常只有 1 个，多于 1 个说明有人同时在用
  last: SessionView | null; // 最近一次使用
};

const EMPTY_STATUS: AccountStatus = { online: false, users: [], last: null };

// 取每个账号最近 3 条使用记录，算出当前状态。groupId 为 null 时取全部账号。
async function loadStatuses(db: D1Database, groupId: number | null): Promise<Map<number, AccountStatus>> {
  const filter = groupId === null ? '' : 'WHERE account_id IN (SELECT account_id FROM group_accounts WHERE group_id = ?1)';
  const stmt = db.prepare(`
    SELECT * FROM (
      SELECT s.*, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY last_heartbeat DESC) AS rn
      FROM sessions s ${filter}
    ) WHERE rn <= 3
    ORDER BY account_id, rn`);
  const { results } = await (groupId === null ? stmt : stmt.bind(groupId)).all<SessionRow>();

  const now = Date.now();
  const map = new Map<number, AccountStatus>();
  for (const row of results) {
    let st = map.get(row.account_id);
    if (!st) {
      st = { online: false, users: [], last: null };
      map.set(row.account_id, st);
    }
    const view = describeSession(row, now);
    st.last ??= view; // 按 last_heartbeat 倒序，第一条就是最近一次
    if (view.online) {
      st.users.push(view);
      st.online = true;
    }
  }
  return map;
}

// ---------- 管理后台 ----------

function adminMaterial(env: Env): string {
  return `${env.ENCRYPTION_KEY}:${env.ADMIN_PASSWORD}`;
}

app.post('/api/admin/login', async (c) => {
  if (!c.env.ADMIN_PASSWORD || !c.env.ENCRYPTION_KEY) {
    return fail(c, '服务器还没有配置 ADMIN_PASSWORD 和 ENCRYPTION_KEY', 500);
  }
  const source = await failureSource(c, 'admin');
  if (await tooManyFailures(c, source)) return fail(c, '尝试次数太多，请 10 分钟后再试', 429);

  const { password } = await readJson<{ password: string }>(c);
  if (!(await safeEqual(String(password ?? ''), c.env.ADMIN_PASSWORD))) {
    await recordFailure(c, source);
    return fail(c, '密码不正确', 401);
  }
  const token = await signToken({ role: 'admin', exp: Date.now() + ADMIN_TOKEN_TTL_MS }, adminMaterial(c.env));
  return c.json({ token });
});

app.use('/api/admin/*', async (c, next) => {
  if (c.req.path === '/api/admin/login') return next();
  const token = bearer(c);
  const payload = token ? await verifyToken<{ exp: number; role: string }>(token, adminMaterial(c.env)) : null;
  if (payload?.role !== 'admin') return fail(c, '请先登录', 401);
  await next();
});

// 账号列表：带所属分组和当前状态
app.get('/api/admin/accounts', async (c) => {
  const db = c.env.DB;
  const [{ results: accounts }, { results: links }, statuses] = await Promise.all([
    db.prepare('SELECT id, label, phone, note, created_at, updated_at FROM accounts ORDER BY id').all<AccountRow>(),
    db
      .prepare('SELECT ga.account_id, g.id, g.name FROM group_accounts ga JOIN share_groups g ON g.id = ga.group_id ORDER BY g.id')
      .all<{ account_id: number; id: number; name: string }>(),
    loadStatuses(db, null),
  ]);
  return c.json({
    server_time: Date.now(),
    accounts: accounts.map((a) => ({
      ...a,
      groups: links.filter((l) => l.account_id === a.id).map((l) => ({ id: l.id, name: l.name })),
      status: statuses.get(a.id) ?? EMPTY_STATUS,
    })),
  });
});

app.post('/api/admin/accounts', async (c) => {
  const body = await readJson<{ label: string; phone: string; password: string; note: string }>(c);
  const label = String(body.label ?? '').trim();
  const phone = normalizePhone(body.phone);
  const password = String(body.password ?? '');
  if (!label) return fail(c, '请填写账号名称');
  if (!/^1\d{10}$/.test(phone)) return fail(c, '手机号要填 11 位');
  if (!password) return fail(c, '请填写密码');

  const now = Date.now();
  try {
    const row = await c.env.DB.prepare(
      'INSERT INTO accounts (label, phone, password_enc, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    )
      .bind(label, phone, await encryptSecret(password, c.env.ENCRYPTION_KEY), String(body.note ?? '').trim(), now, now)
      .first<{ id: number }>();
    return c.json({ id: row?.id });
  } catch (err) {
    if (isUniqueError(err)) return fail(c, '这个手机号已经添加过了', 409);
    throw err;
  }
});

// 修改账号。只改传了的字段；password 传空字符串表示不改。
app.put('/api/admin/accounts/:id', async (c) => {
  const id = toId(c.req.param('id'));
  if (!id) return fail(c, '账号不存在', 404);
  const body = await readJson<{ label: string; phone: string; password: string; note: string }>(c);

  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.label !== undefined) {
    const label = String(body.label).trim();
    if (!label) return fail(c, '账号名称不能为空');
    sets.push('label = ?');
    args.push(label);
  }
  if (body.phone !== undefined) {
    const phone = normalizePhone(body.phone);
    if (!/^1\d{10}$/.test(phone)) return fail(c, '手机号要填 11 位');
    sets.push('phone = ?');
    args.push(phone);
  }
  if (body.password) {
    sets.push('password_enc = ?');
    args.push(await encryptSecret(String(body.password), c.env.ENCRYPTION_KEY));
  }
  if (body.note !== undefined) {
    sets.push('note = ?');
    args.push(String(body.note).trim());
  }
  if (!sets.length) return c.json({ ok: true });
  sets.push('updated_at = ?');
  args.push(Date.now());

  try {
    const res = await c.env.DB.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id).run();
    if (!res.meta.changes) return fail(c, '账号不存在', 404);
    return c.json({ ok: true });
  } catch (err) {
    if (isUniqueError(err)) return fail(c, '这个手机号已经被其他账号使用', 409);
    throw err;
  }
});

app.get('/api/admin/accounts/:id/password', async (c) => {
  const id = toId(c.req.param('id'));
  const row = id
    ? await c.env.DB.prepare('SELECT password_enc FROM accounts WHERE id = ?').bind(id).first<{ password_enc: string }>()
    : null;
  if (!row) return fail(c, '账号不存在', 404);
  return c.json({ password: await decryptSecret(row.password_enc, c.env.ENCRYPTION_KEY) });
});

app.delete('/api/admin/accounts/:id', async (c) => {
  const id = toId(c.req.param('id'));
  if (!id) return fail(c, '账号不存在', 404);
  const db = c.env.DB;
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE account_id = ?').bind(id),
    db.prepare('DELETE FROM group_accounts WHERE account_id = ?').bind(id),
    db.prepare('DELETE FROM accounts WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// 分组列表：带账号 id 和成员数
app.get('/api/admin/groups', async (c) => {
  const db = c.env.DB;
  const [{ results: groups }, { results: links }, { results: counts }] = await Promise.all([
    db.prepare('SELECT id, name, code, created_at FROM share_groups ORDER BY id').all<GroupRow>(),
    db.prepare('SELECT group_id, account_id FROM group_accounts').all<{ group_id: number; account_id: number }>(),
    db.prepare('SELECT group_id, COUNT(*) AS n FROM members GROUP BY group_id').all<{ group_id: number; n: number }>(),
  ]);
  return c.json({
    groups: groups.map((g) => ({
      ...g,
      account_ids: links.filter((l) => l.group_id === g.id).map((l) => l.account_id),
      member_count: counts.find((m) => m.group_id === g.id)?.n ?? 0,
    })),
  });
});

function setGroupAccounts(db: D1Database, groupId: number, accountIds: unknown): D1PreparedStatement[] {
  const ids = [...new Set((Array.isArray(accountIds) ? accountIds : []).map(toId).filter((n): n is number => n !== null))];
  return [
    db.prepare('DELETE FROM group_accounts WHERE group_id = ?').bind(groupId),
    // 只插入真实存在的账号
    ...ids.map((aid) =>
      db.prepare('INSERT OR IGNORE INTO group_accounts (group_id, account_id) SELECT ?, id FROM accounts WHERE id = ?').bind(groupId, aid),
    ),
  ];
}

app.post('/api/admin/groups', async (c) => {
  const body = await readJson<{ name: string; account_ids: number[] }>(c);
  const name = String(body.name ?? '').trim();
  if (!name) return fail(c, '请填写分组名称');
  const db = c.env.DB;

  // 分组代码撞车的概率极低，撞了就换一个重试
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      const row = await db
        .prepare('INSERT INTO share_groups (name, code, created_at) VALUES (?, ?, ?) RETURNING id')
        .bind(name, code, Date.now())
        .first<{ id: number }>();
      if (!row) break;
      await db.batch(setGroupAccounts(db, row.id, body.account_ids));
      return c.json({ id: row.id, code });
    } catch (err) {
      if (!isUniqueError(err)) throw err;
    }
  }
  return fail(c, '生成分组代码失败，请重试', 500);
});

app.put('/api/admin/groups/:id', async (c) => {
  const id = toId(c.req.param('id'));
  const db = c.env.DB;
  const exists = id ? await db.prepare('SELECT id FROM share_groups WHERE id = ?').bind(id).first() : null;
  if (!id || !exists) return fail(c, '分组不存在', 404);

  const body = await readJson<{ name: string; account_ids: number[] }>(c);
  const stmts: D1PreparedStatement[] = [];
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return fail(c, '分组名称不能为空');
    stmts.push(db.prepare('UPDATE share_groups SET name = ? WHERE id = ?').bind(name, id));
  }
  if (body.account_ids !== undefined) stmts.push(...setGroupAccounts(db, id, body.account_ids));
  if (stmts.length) await db.batch(stmts);
  return c.json({ ok: true });
});

// 重置分组代码：旧代码作废，已加入的成员全部移除，需要用新代码重新加入
app.post('/api/admin/groups/:id/reset-code', async (c) => {
  const id = toId(c.req.param('id'));
  const db = c.env.DB;
  const exists = id ? await db.prepare('SELECT id FROM share_groups WHERE id = ?').bind(id).first() : null;
  if (!id || !exists) return fail(c, '分组不存在', 404);

  const now = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      await db.batch([
        db.prepare('UPDATE share_groups SET code = ? WHERE id = ?').bind(code, id),
        db
          .prepare("UPDATE sessions SET logout_at = ?, logout_reason = 'removed' WHERE group_id = ? AND logout_at IS NULL")
          .bind(now, id),
        db.prepare('DELETE FROM members WHERE group_id = ?').bind(id),
      ]);
      return c.json({ code });
    } catch (err) {
      if (!isUniqueError(err)) throw err;
    }
  }
  return fail(c, '生成分组代码失败，请重试', 500);
});

app.delete('/api/admin/groups/:id', async (c) => {
  const id = toId(c.req.param('id'));
  if (!id) return fail(c, '分组不存在', 404);
  const db = c.env.DB;
  // 使用记录保留，方便以后查历史
  await db.batch([
    db.prepare("UPDATE sessions SET logout_at = ?, logout_reason = 'removed' WHERE group_id = ? AND logout_at IS NULL").bind(Date.now(), id),
    db.prepare('DELETE FROM members WHERE group_id = ?').bind(id),
    db.prepare('DELETE FROM group_accounts WHERE group_id = ?').bind(id),
    db.prepare('DELETE FROM share_groups WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

app.get('/api/admin/groups/:id/members', async (c) => {
  const id = toId(c.req.param('id'));
  if (!id) return fail(c, '分组不存在', 404);
  const { results } = await c.env.DB.prepare(
    'SELECT id, nickname, created_at, last_seen_at FROM members WHERE group_id = ? ORDER BY id',
  )
    .bind(id)
    .all();
  return c.json({ members: results });
});

app.delete('/api/admin/members/:id', async (c) => {
  const id = toId(c.req.param('id'));
  if (!id) return fail(c, '成员不存在', 404);
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE sessions SET logout_at = ?, logout_reason = 'removed' WHERE member_id = ? AND logout_at IS NULL").bind(Date.now(), id),
    db.prepare('DELETE FROM members WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// 使用记录：可以按账号或分组筛选
app.get('/api/admin/sessions', async (c) => {
  const accountId = toId(c.req.query('account_id'));
  const groupId = toId(c.req.query('group_id'));
  const limit = Math.min(toId(c.req.query('limit')) ?? 100, 500);

  const where: string[] = [];
  const args: unknown[] = [];
  if (accountId) {
    where.push('s.account_id = ?');
    args.push(accountId);
  }
  if (groupId) {
    where.push('s.group_id = ?');
    args.push(groupId);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT s.*, a.label AS account_label, g.name AS group_name
     FROM sessions s
     LEFT JOIN accounts a ON a.id = s.account_id
     LEFT JOIN share_groups g ON g.id = s.group_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY s.login_at DESC
     LIMIT ?`,
  )
    .bind(...args, limit)
    .all<SessionRow & { account_label: string | null; group_name: string | null }>();

  const now = Date.now();
  return c.json({
    sessions: results.map((s) => ({
      id: s.id,
      account_id: s.account_id,
      account_label: s.account_label,
      group_name: s.group_name,
      ...describeSession(s, now),
    })),
  });
});

// ---------- 插件接口 ----------

// 插件运行在 chrome-extension:// 下，用 token 认证、不带 Cookie，所以允许任意来源
app.use(
  '/api/ext/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }),
);

app.post('/api/ext/join', async (c) => {
  const source = await failureSource(c, 'join');
  if (await tooManyFailures(c, source)) return fail(c, '尝试次数太多，请 10 分钟后再试', 429);

  const body = await readJson<{ code: string; nickname: string }>(c);
  const code = String(body.code ?? '').trim().toUpperCase();
  const nickname = String(body.nickname ?? '').trim().slice(0, 20);
  if (!nickname) return fail(c, '请填写昵称，方便大家知道是谁在用');

  const db = c.env.DB;
  const group = code
    ? await db.prepare('SELECT id, name FROM share_groups WHERE code = ?').bind(code).first<{ id: number; name: string }>()
    : null;
  if (!group) {
    await recordFailure(c, source);
    return fail(c, '分组代码不正确', 404);
  }

  const token = randomToken();
  const now = Date.now();
  const row = await db
    .prepare('INSERT INTO members (group_id, nickname, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(group.id, nickname, await sha256Hex(token), now, now)
    .first<{ id: number }>();
  return c.json({ token, member: { id: row?.id, nickname }, group });
});

app.use('/api/ext/*', async (c, next) => {
  if (c.req.path === '/api/ext/join' || c.req.method === 'OPTIONS') return next();
  const token = bearer(c);
  const member = token
    ? await c.env.DB.prepare('SELECT id, group_id, nickname FROM members WHERE token_hash = ?')
        .bind(await sha256Hex(token))
        .first<Member>()
    : null;
  if (!member) return fail(c, '分组凭证已失效，请重新输入分组代码', 401);
  c.set('member', member);
  await next();
});

async function accountInGroup(db: D1Database, accountId: number, groupId: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM group_accounts WHERE account_id = ? AND group_id = ?')
    .bind(accountId, groupId)
    .first();
  return row !== null;
}

// 心跳早已超时、还没结束的记录，下线时间记为最后一次心跳
function closeStaleSessions(db: D1Database, memberId: number, now: number): D1PreparedStatement {
  return db
    .prepare("UPDATE sessions SET logout_at = last_heartbeat, logout_reason = 'timeout' WHERE member_id = ? AND logout_at IS NULL AND last_heartbeat <= ?")
    .bind(memberId, now - ONLINE_TIMEOUT_MS);
}

// 分组里的账号和状态。phone 给插件本地比对当前登录的是哪个账号，界面上只显示 phone_masked。
app.get('/api/ext/status', async (c) => {
  const member = c.get('member');
  const db = c.env.DB;
  const [group, { results: accounts }, statuses] = await Promise.all([
    db.prepare('SELECT id, name FROM share_groups WHERE id = ?').bind(member.group_id).first<{ id: number; name: string }>(),
    db
      .prepare('SELECT a.id, a.label, a.phone FROM accounts a JOIN group_accounts ga ON ga.account_id = a.id WHERE ga.group_id = ? ORDER BY a.id')
      .bind(member.group_id)
      .all<{ id: number; label: string; phone: string }>(),
    loadStatuses(db, member.group_id),
  ]);

  const toView = (s: SessionView) => {
    const { member_id, ...rest } = s;
    return { ...rest, is_me: member_id === member.id };
  };
  return c.json({
    server_time: Date.now(),
    online_timeout_ms: ONLINE_TIMEOUT_MS,
    me: { id: member.id, nickname: member.nickname },
    group,
    accounts: accounts.map((a) => {
      const st = statuses.get(a.id) ?? EMPTY_STATUS;
      return {
        id: a.id,
        label: a.label,
        phone: a.phone,
        phone_masked: maskPhone(a.phone),
        status: { online: st.online, users: st.users.map(toView), last: st.last && toView(st.last) },
      };
    }),
  });
});

// 心跳：插件确认当前登录的是分组里的账号后，每 45 秒发一次。active 是这个浏览器所有句乐部页面汇总后的结果
app.post('/api/ext/heartbeat', async (c) => {
  const member = c.get('member');
  const body = await readJson<{ account_id: number; site_session_id: string; active: boolean }>(c);
  const accountId = toId(body.account_id);
  const siteSessionId = String(body.site_session_id ?? '').trim().slice(0, 100);
  if (!accountId || !siteSessionId) return fail(c, '参数不完整');

  const db = c.env.DB;
  if (!(await accountInGroup(db, accountId, member.group_id))) return fail(c, '这个账号不在你的分组里', 403);

  const now = Date.now();
  const active = body.active === false ? 0 : 1;
  // 同一次句乐部登录（site_session_id 相同）的最近一条记录，包括已被判为失联的
  const prev = await db
    .prepare(
      "SELECT id, last_heartbeat FROM sessions WHERE member_id = ? AND account_id = ? AND site_session_id = ? AND (logout_at IS NULL OR logout_reason = 'timeout') ORDER BY id DESC LIMIT 1",
    )
    .bind(member.id, accountId, siteSessionId)
    .first<{ id: number; last_heartbeat: number }>();
  // 只是失联了一会儿（插件更新、页面在后台被冻结、短暂断网）就接着原来那条记录，使用时长不从头算；
  // 断开太久（比如电脑睡了一夜）才另起一条
  const keepId = prev && now - prev.last_heartbeat <= RESUME_WINDOW_MS ? prev.id : 0;

  await db.batch([
    closeStaleSessions(db, member.id, now),
    // 同一个浏览器同时只会登录一个句乐部账号：换了账号或重新登录，旧记录就结束
    db
      .prepare("UPDATE sessions SET logout_at = ?, logout_reason = 'switch' WHERE member_id = ? AND logout_at IS NULL AND id != ?")
      .bind(now, member.id, keepId),
    keepId
      ? db
          .prepare('UPDATE sessions SET last_heartbeat = ?, active = ?, logout_at = NULL, logout_reason = NULL WHERE id = ?')
          .bind(now, active, keepId)
      : db
          .prepare(
            'INSERT INTO sessions (account_id, group_id, member_id, nickname, site_session_id, login_at, last_heartbeat, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(accountId, member.group_id, member.id, member.nickname, siteSessionId, now, now, active),
    db.prepare('UPDATE members SET last_seen_at = ? WHERE id = ?').bind(now, member.id),
  ]);
  return c.json({ ok: true });
});

// 下线：关掉所有句乐部标签页、退出登录、切到分组外的账号时调用。
// 插件带上 account_id + site_session_id + at（发生时间）时只结束对应那条记录；上报失败后的重试可能迟到，
// at 保证下线时间准确，login_at <= at 保证不会误结束之后新开的记录。已被判为失联的记录也会改成真实原因，
// 但如果事件发生在失联之后，下线时间仍记为最后一次心跳，不把失联那段算进使用时长。
// 不带会话标识就结束这个成员的全部记录（旧版插件）。
app.post('/api/ext/offline', async (c) => {
  const member = c.get('member');
  const body = await readJson<{ account_id: number; site_session_id: string; reason: string; at: number }>(c);
  const reason = OFFLINE_REASONS.has(String(body.reason)) ? String(body.reason) : 'logout';
  const accountId = toId(body.account_id);
  const siteSessionId = String(body.site_session_id ?? '').trim().slice(0, 100);

  const db = c.env.DB;
  const now = Date.now();
  const at = Number(body.at);
  const eventAt = Number.isFinite(at) && at > 0 ? Math.min(at, now) : now;
  const end =
    accountId && siteSessionId
      ? db
          .prepare(
            `UPDATE sessions
             SET logout_at = CASE WHEN ?1 - last_heartbeat <= ?2 THEN MAX(last_heartbeat, ?1) ELSE last_heartbeat END,
                 logout_reason = ?3
             WHERE member_id = ?4 AND account_id = ?5 AND site_session_id = ?6 AND login_at <= ?1
               AND (logout_at IS NULL OR logout_reason = 'timeout')`,
          )
          .bind(eventAt, ONLINE_TIMEOUT_MS, reason, member.id, accountId, siteSessionId)
      : accountId
        ? db
            .prepare('UPDATE sessions SET logout_at = ?, logout_reason = ? WHERE member_id = ? AND account_id = ? AND logout_at IS NULL')
            .bind(now, reason, member.id, accountId)
        : db
            .prepare('UPDATE sessions SET logout_at = ?, logout_reason = ? WHERE member_id = ? AND logout_at IS NULL')
            .bind(now, reason, member.id);
  // 先结束指定记录、再清理超时记录，这样迟到的重试也能写入真实原因
  await db.batch([end, closeStaleSessions(db, member.id, now)]);
  return c.json({ ok: true });
});

// 一键登录时取账号密码：每次现取，号主改了密码大家自动用新的
app.post('/api/ext/credentials', async (c) => {
  const member = c.get('member');
  const accountId = toId((await readJson<{ account_id: number }>(c)).account_id);
  const row = accountId
    ? await c.env.DB.prepare(
        'SELECT a.phone, a.password_enc FROM accounts a JOIN group_accounts ga ON ga.account_id = a.id WHERE a.id = ? AND ga.group_id = ?',
      )
        .bind(accountId, member.group_id)
        .first<{ phone: string; password_enc: string }>()
    : null;
  if (!row) return fail(c, '这个账号不在你的分组里', 403);
  return c.json({ phone: row.phone, password: await decryptSecret(row.password_enc, c.env.ENCRYPTION_KEY) });
});

// 退出分组：结束自己的使用记录并删除成员
app.post('/api/ext/leave', async (c) => {
  const member = c.get('member');
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE sessions SET logout_at = ?, logout_reason = 'logout' WHERE member_id = ? AND logout_at IS NULL").bind(Date.now(), member.id),
    db.prepare('DELETE FROM members WHERE id = ?').bind(member.id),
  ]);
  return c.json({ ok: true });
});

// ---------- 其他 ----------

app.all('/api/*', (c) => fail(c, '接口不存在', 404));

// 其余路径都返回管理后台页面（单页应用，刷新任意路径都能打开）
app.get('*', (c) => c.env.ASSETS.fetch(new Request(new URL('/', c.req.url))));

export default app;
