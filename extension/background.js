// Service Worker：插件的大脑。
// - 收到 content 上报的当前登录身份后，判断是不是分组里的账号，是才上报心跳；不是就不报
// - 监控句乐部标签页，全部关掉时上报下线（开了自动退出就顺便退出登录）
// - 处理 popup 的一键登录、用完退出
// Service Worker 闲置约 30 秒会被浏览器停掉、内存变量全丢，所以状态都存在 chrome.storage 里。

importScripts('julebu-auth.js');

const CACHE_TTL = 5 * 60 * 1000;
const TAB_STALE_MS = 2 * 60 * 1000; // 标签页这么久没上报，就不再参与“是否活跃”的判断
const TABS_GONE_DELAY = 4000; // 标签页关掉或跳走后等一会儿再查，避免刷新、跳转时误判
const RETRY_ALARM = 'retry-offline';
const JULEBU_TAB_URLS = ['*://julebu.co/*', '*://*.julebu.co/*'];

let cache = { accounts: [], ts: 0 }; // 分组账号列表（含手机号，用于本地比对），丢了重新拉即可
let tabsGoneTimer = null;

// 读写状态的操作排队执行，避免几个标签页同时上报时互相覆盖
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

// current: 正在上报的会话 { accountId, siteSessionId }，没有则为 null
// tabs: 各标签页最近一次上报 { [tabId]: { active, at } }，任一页面在操作就算活跃
// signedOutAt: 最近一次确认退出的时间，早于它读到的“已登录”作废
// 存在 storage.session：Service Worker 重启后还在，浏览器关掉后清空
async function loadState() {
  const { bg } = await chrome.storage.session.get('bg');
  return { current: null, tabs: {}, signedOutAt: 0, ...bg };
}
async function saveState(state) {
  await chrome.storage.session.set({ bg: state });
}

async function getConfig() {
  return chrome.storage.local.get(['serverUrl', 'token', 'groupName', 'nickname']);
}

async function api(path, body) {
  const { serverUrl, token } = await getConfig();
  if (!serverUrl || !token) throw Object.assign(new Error('还没有加入分组'), { status: 401 });
  const res = await fetch(serverUrl.replace(/\/+$/, '') + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { status: res.status });
  return data;
}

async function refreshCache(force) {
  if (!force && cache.accounts.length && Date.now() - cache.ts < CACHE_TTL) return;
  try {
    const d = await api('/api/ext/status');
    cache = { accounts: (d.accounts || []).map((a) => ({ id: a.id, label: a.label, phone: a.phone })), ts: Date.now() };
  } catch {
    // 拿不到就用旧缓存
  }
}

function groupPhones() {
  return cache.accounts.map((a) => a.phone);
}

// content 上报身份
async function onIdentity(tabId, p) {
  const { token } = await getConfig();
  if (!token || !p) return;
  // 读不到登录状态：什么都不改。一直读不到的话，服务器两分钟后会显示“失联”而不是“空闲”
  if (p.state === 'unknown') return;

  const state = await loadState();
  if (p.state === 'out') {
    state.tabs = {};
    await endSession(state, 'not_logged_in');
    return;
  }
  if (p.at < state.signedOutAt) return; // 退出之前读到的旧状态

  await refreshCache(false);
  const acc = cache.accounts.find((a) => a.phone === p.phone);
  if (!acc) {
    // 登录的是分组外的账号：不上报
    state.tabs = {};
    await endSession(state, 'not_in_group');
    return;
  }

  const cur = state.current;
  if (cur && (cur.accountId !== acc.id || cur.siteSessionId !== p.siteSessionId)) state.tabs = {}; // 换了账号或重新登录
  const now = Date.now();
  if (tabId != null) state.tabs[tabId] = { active: !!p.active, at: now };
  const active = Object.values(state.tabs).some((t) => t.active && now - t.at < TAB_STALE_MS);
  try {
    await api('/api/ext/heartbeat', { account_id: acc.id, site_session_id: p.siteSessionId, active });
    state.current = { accountId: acc.id, siteSessionId: p.siteSessionId };
  } catch {}
  await saveState(state);
}

// 结束当前上报的会话。current 为空时不重复上报。
async function endSession(state, reason) {
  const cur = state.current;
  state.current = null;
  await saveState(state);
  if (cur) await sendOffline({ account_id: cur.accountId, site_session_id: cur.siteSessionId, reason, at: Date.now() });
}

// 下线上报失败就存起来每分钟重试。重试带着会话标识和发生时间，服务器只结束对应那条记录。
async function sendOffline(item) {
  try {
    await api('/api/ext/offline', item);
  } catch (e) {
    if (e.status === 401) return; // 已经不在分组里了，不用再报
    const { pendingOffline = [] } = await chrome.storage.local.get('pendingOffline');
    pendingOffline.push(item);
    await chrome.storage.local.set({ pendingOffline: pendingOffline.slice(-20) });
    chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
  }
}

async function retryPending() {
  const { pendingOffline = [] } = await chrome.storage.local.get('pendingOffline');
  const left = [];
  for (const item of pendingOffline) {
    try {
      await api('/api/ext/offline', item);
    } catch (e) {
      if (e.status !== 400 && e.status !== 401) left.push(item);
    }
  }
  await chrome.storage.local.set({ pendingOffline: left });
  if (!left.length) await chrome.alarms.clear(RETRY_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) serial(retryPending);
});
chrome.runtime.onStartup.addListener(() => serial(retryPending));

// ---- 标签页监控 ----
// 不在内存里记标签页列表（Service Worker 重启会丢），需要时直接查询
function julebuTabs() {
  return chrome.tabs.query({ url: JULEBU_TAB_URLS });
}

function scheduleTabsCheck() {
  clearTimeout(tabsGoneTimer);
  tabsGoneTimer = setTimeout(() => serial(checkTabsGone), TABS_GONE_DELAY);
}

async function checkTabsGone() {
  const tabs = await julebuTabs();
  const state = await loadState();
  const open = new Set(tabs.map((t) => String(t.id)));
  for (const id of Object.keys(state.tabs)) if (!open.has(id)) delete state.tabs[id];
  if (tabs.length || !state.current) {
    await saveState(state);
    return;
  }
  const { autoLogout } = await chrome.storage.local.get('autoLogout');
  await endSession(state, autoLogout && (await autoSignOut()) ? 'logout' : 'tab_closed');
}

// 全部页面关掉后自动退出：只退出分组里的账号，而且要确认真的退出了。
// 后台读到“没登录”时分不清是本来就没登录、还是插件读不到登录信息，不算退出成功。
async function autoSignOut() {
  await refreshCache(false);
  const r = await JulebuAuth.logoutManaged(groupPhones());
  return r.ok && !r.already;
}

chrome.tabs.onRemoved.addListener(scheduleTabsCheck);
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.url) scheduleTabsCheck();
});

// ---- 消息 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'JULEBU_IDENTITY') {
    const tabId = sender.tab ? sender.tab.id : null;
    serial(() => onIdentity(tabId, msg.payload)).finally(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'ONECLICK_LOGIN') {
    oneClickLogin(msg.accountId).then(sendResponse);
    return true;
  }
  if (msg.type === 'LOGOUT_NOW') {
    serial(logoutNow).then(sendResponse, (e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
    return true;
  }
  if (msg.type === 'REFRESH_CACHE') {
    refreshCache(true).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// ---- 一键登录 ----
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findJulebuTab() {
  const tabs = await julebuTabs();
  return tabs[0];
}

async function sendToTab(tabId, msg, tries = 20) {
  // content script 可能还没注入好，重试几次
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, msg);
      if (resp) return resp;
    } catch {}
    await sleep(500);
  }
  return null;
}

async function oneClickLogin(accountId) {
  try {
    const { phone, password } = await api('/api/ext/credentials', { account_id: accountId });
    let tab = await findJulebuTab();
    if (!tab) {
      tab = await chrome.tabs.create({ url: 'https://julebu.co/login', active: true });
    } else {
      await chrome.tabs.update(tab.id, { active: true });
    }
    // 等页面 PING 得通（content script 已就绪）
    const ready = await sendToTab(tab.id, { cmd: 'PING' });
    if (!ready) return { ok: false, error: '页面未就绪，请在打开的句乐部页面手动登录' };
    const resp = await sendToTab(tab.id, { cmd: 'LOGIN', phone, password }, 1);
    return resp || { ok: false, error: '登录无响应，请手动登录' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// ---- 用完退出 ----
// 确认退出成功后才上报下线；失败时保持原状态，并把原因告诉用户
async function logoutNow() {
  await refreshCache(false);
  const tab = await findJulebuTab();
  let r;
  if (tab) {
    r = await sendToTab(tab.id, { cmd: 'LOGOUT', phones: groupPhones() }, 3);
    if (!r) return { ok: false, error: '句乐部页面没有响应，请刷新页面后再试' };
  } else {
    r = await JulebuAuth.logoutManaged(groupPhones());
    if (r.ok && r.already) {
      return { ok: false, error: '没有检测到句乐部登录。如果确定还登录着，请打开句乐部页面后再点一次' };
    }
  }
  if (!r.ok) return r;

  const state = await loadState();
  state.tabs = {};
  state.signedOutAt = Date.now();
  await endSession(state, 'logout');
  return { ok: true, already: !!r.already };
}
