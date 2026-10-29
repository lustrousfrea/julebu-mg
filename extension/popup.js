const $ = (id) => document.getElementById(id);
let pollTimer = null;

function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

function show(view) {
  for (const id of ['join', 'main', 'loading']) $(id).hidden = id !== view;
}

async function getConfig() {
  return chrome.storage.local.get(['serverUrl', 'token', 'groupName', 'nickname', 'autoLogout']);
}

async function api(path, body) {
  const { serverUrl, token } = await getConfig();
  const res = await fetch(serverUrl.replace(/\/+$/, '') + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

// ---- 时间格式 ----
function pad(n) {
  return String(n).padStart(2, '0');
}
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
function fmtDur(ms) {
  if (ms == null || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 小时 ${m % 60} 分` : `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

// ---- 加入分组 ----
async function doJoin() {
  $('joinErr').textContent = '';
  let serverUrl = $('serverUrl').value.trim();
  let code = $('code').value.trim().toUpperCase();
  const invite = $('invite').value.trim();
  const nickname = $('nickname').value.trim();

  if (invite) {
    const i = invite.lastIndexOf('#');
    if (i < 0) {
      $('joinErr').textContent = '邀请串格式不对，应形如 https://xxx#代码';
      return;
    }
    serverUrl = invite.slice(0, i);
    code = invite.slice(i + 1).toUpperCase();
  }
  if (!/^https?:\/\//.test(serverUrl)) {
    $('joinErr').textContent = '请填写正确的服务器地址';
    return;
  }
  if (!code) {
    $('joinErr').textContent = '请填写分组代码';
    return;
  }
  if (!nickname) {
    $('joinErr').textContent = '请填写昵称';
    return;
  }

  $('joinBtn').disabled = true;
  $('joinBtn').textContent = '加入中…';
  try {
    const res = await fetch(serverUrl.replace(/\/+$/, '') + '/api/ext/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, nickname }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '加入失败');
    await chrome.storage.local.set({
      serverUrl: serverUrl.replace(/\/+$/, ''),
      token: data.token,
      groupName: data.group.name,
      nickname,
    });
    toast('已加入「' + data.group.name + '」');
    render();
  } catch (e) {
    $('joinErr').textContent = e.message;
  } finally {
    $('joinBtn').disabled = false;
    $('joinBtn').textContent = '加入';
  }
}

// ---- 状态列表 ----
let accountsById = new Map(); // 最近一次加载的账号，一键登录前用来提醒

function who(u) {
  return u.is_me ? '你' : u.nickname;
}

function statusLine(st) {
  if (st && st.online) {
    // 多人同时在线时，任何一人在操作就算使用中
    const u = st.users.find((x) => x.active) || st.users[0];
    const names = st.users.map(who).join('、');
    const since = `${fmtTime(u.login_at)} 开始 · 已用 ${fmtDur(u.duration_ms)}`;
    if (u.active) return { cls: 'on', text: `使用中 · ${names} · ${since}` };
    return { cls: 'idle', text: `挂着 · ${names} · ${since}` };
  }
  const last = st && st.last;
  if (!last) return { cls: 'off', text: '空闲 · 暂无记录' };
  // 心跳中断（断网、电脑睡眠、浏览器被关掉）：对方可能还登录着，不能当成空闲
  if (last.offline_reason === 'timeout') {
    return {
      cls: 'lost',
      text: `失联 · ${who(last)} · 最后在线 ${fmtTime(last.offline_at)}`,
      hint: '插件连不上了，对方可能还在用，登录前最好先问一下',
    };
  }
  return { cls: 'off', text: `空闲 · ${fmtTime(last.offline_at)} 下线` };
}

// 别人正在用或失联时，一键登录前确认一下，避免顶号
function loginWarning(a) {
  const st = a && a.status;
  if (!st) return '';
  const others = st.users.filter((u) => !u.is_me);
  if (others.length) return `${others.map(who).join('、')} 正在使用这个账号，现在登录可能把对方顶下线。确定继续？`;
  const last = st.last;
  if (!st.online && last && last.offline_reason === 'timeout' && !last.is_me) {
    return `${last.nickname} 的状态未知（最后在线 ${fmtTime(last.offline_at)}），可能还在使用。确定继续？`;
  }
  return '';
}

async function loadStatus() {
  try {
    const data = await api('/api/ext/status');
    $('groupName').textContent = data.group ? data.group.name : '分组';
    $('meName').textContent = data.me ? '昵称：' + data.me.nickname : '';
    const list = $('list');
    list.innerHTML = '';
    accountsById = new Map(data.accounts.map((a) => [a.id, a]));
    if (!data.accounts.length) {
      list.innerHTML = '<p class="center muted">这个分组里还没有账号</p>';
      return;
    }
    for (const a of data.accounts) {
      const st = statusLine(a.status);
      const multi = a.status && a.status.users && a.status.users.length > 1;
      const card = document.createElement('div');
      card.className = 'acc';
      card.innerHTML = `
        <div class="acc-top">
          <div>
            <div class="acc-name">${esc(a.label)}</div>
            <div class="acc-phone">${esc(a.phone_masked)}</div>
          </div>
          <button class="login-btn" data-id="${a.id}">一键登录</button>
        </div>
        <div class="status">
          <span class="dot ${st.cls}"></span>
          <span class="${st.cls === 'off' ? 'muted' : 's-' + st.cls}">${esc(st.text)}</span>
        </div>
        ${st.hint ? '<div class="hint">' + esc(st.hint) + '</div>' : ''}
        ${multi ? '<div class="warn">⚠ 有 ' + a.status.users.length + ' 个人同时在线</div>' : ''}
      `;
      list.appendChild(card);
    }
    list.querySelectorAll('.login-btn').forEach((btn) =>
      btn.addEventListener('click', () => oneClickLogin(Number(btn.dataset.id), btn)),
    );
  } catch (e) {
    if (/凭证|失效|401/.test(e.message)) {
      await chrome.storage.local.remove(['token', 'groupName']);
      toast('分组凭证已失效，请重新加入', true);
      render();
      return;
    }
    toast(e.message, true);
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function oneClickLogin(accountId, btn) {
  const warning = loginWarning(accountsById.get(accountId));
  if (warning && !confirm(warning)) return;
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'ONECLICK_LOGIN', accountId });
    if (resp && resp.ok) {
      toast('已发起登录，请看句乐部页面');
      setTimeout(loadStatus, 2000);
    } else {
      toast((resp && resp.error) || '登录失败', true);
    }
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '一键登录';
  }
}

// ---- 渲染入口 ----
async function render() {
  clearInterval(pollTimer);
  const c = await getConfig();
  if (!c.token || !c.serverUrl) {
    show('join');
    return;
  }
  show('main');
  $('autoLogout').checked = !!c.autoLogout;
  await loadStatus();
  pollTimer = setInterval(loadStatus, 15000); // popup 开着时每 15 秒刷新
}

// ---- 事件 ----
$('joinBtn').addEventListener('click', doJoin);
$('refreshBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'REFRESH_CACHE' }).catch(() => {});
  loadStatus();
});
$('autoLogout').addEventListener('change', (e) => chrome.storage.local.set({ autoLogout: e.target.checked }));
$('logoutBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'LOGOUT_NOW' });
    if (resp && resp.ok) {
      toast(resp.already ? '当前没有登录句乐部' : '已退出登录');
      setTimeout(loadStatus, 1000);
    } else {
      toast((resp && resp.error) || '退出失败，请在句乐部页面手动退出', true);
    }
  } catch {
    toast('退出失败，请在句乐部页面手动退出', true);
  } finally {
    btn.disabled = false;
  }
});
$('leaveBtn').addEventListener('click', async () => {
  if (!confirm('退出当前分组？再次使用需要重新输入分组代码。')) return;
  try {
    await api('/api/ext/leave', {});
  } catch {}
  await chrome.storage.local.remove(['token', 'groupName', 'nickname']);
  toast('已退出分组');
  render();
});

render();
