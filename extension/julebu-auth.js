// 句乐部登录接口的封装，content.js（页面里）和 background.js（后台）共用。
// 读登录状态分三种结果，只有接口正常返回了“没有会话”才算未登录；
// 网络错误、接口报错、返回内容看不懂，一律当作“无法确认”，调用方不能据此判断为空闲。

(() => {
  const AUTH_BASE = 'https://auth-api.julebu.co/api/auth';

  // 句乐部 get-session 返回的是 "86" + 11 位，后台录入的是 11 位，统一成 11 位再比较
  function normalizePhone(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.length > 11 && d.startsWith('86')) d = d.slice(2);
    return d;
  }

  // 返回 { state: 'in', phone, siteSessionId } | { state: 'out' } | { state: 'unknown' }
  async function readSession() {
    let res;
    try {
      res = await fetch(`${AUTH_BASE}/get-session`, {
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
    } catch {
      return { state: 'unknown' };
    }
    if (res.status === 401) return { state: 'out' };
    if (!res.ok) return { state: 'unknown' };
    let data;
    try {
      data = await res.json();
    } catch {
      return { state: 'unknown' };
    }
    if (data && data.user) {
      return {
        state: 'in',
        phone: normalizePhone(data.user.phoneNumber),
        siteSessionId: (data.session && data.session.id) || '',
      };
    }
    // 未登录时 Better Auth 返回 null（或 user 为空的对象）
    if (data === null || (typeof data === 'object' && !Array.isArray(data))) return { state: 'out' };
    return { state: 'unknown' };
  }

  // 发 sign-out 后再读一次登录状态，确认真的没有会话了才算退出成功
  async function signOutVerified() {
    let res;
    try {
      res = await fetch(`${AUTH_BASE}/sign-out`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch {
      return { ok: false, error: '退出请求没有发出去（网络错误），句乐部可能仍是登录状态' };
    }
    const after = await readSession();
    if (after.state === 'out') return { ok: true };
    if (after.state === 'in') return { ok: false, error: '退出后仍检测到登录状态，请在句乐部页面手动退出' };
    if (!res.ok) return { ok: false, error: `句乐部退出接口出错（${res.status}），可能仍是登录状态` };
    return { ok: false, error: '无法确认是否已退出，请刷新句乐部页面看一下' };
  }

  // 只退出分组里的账号：先确认当前登录的手机号在 phones 里，再退出并确认。
  // already: true 表示本来就没有登录。
  async function logoutManaged(phones) {
    const before = await readSession();
    if (before.state === 'unknown') return { ok: false, error: '读不到句乐部登录状态（网络或接口异常），没有退出' };
    if (before.state === 'out') return { ok: true, already: true };
    if (!phones.includes(before.phone)) return { ok: false, error: '当前登录的不是分组里的账号，没有退出' };
    return signOutVerified();
  }

  globalThis.JulebuAuth = { AUTH_BASE, normalizePhone, readSession, logoutManaged };
})();
