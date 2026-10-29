// 运行在 julebu.co 页面里（julebu-auth.js 先加载）。职责：
// 1. 定时读取句乐部的登录状态、是否在操作，上报给 background
// 2. 接收 background 的指令：一键登录、用完退出、立即上报
// 和句乐部的所有交互都用它自己的接口，页面改版也不受影响。
// 关页面时不在这里退出登录：刷新、跳转也会触发关页面事件，是否全部关掉由 background 判断。
// 插件更新后，background 会给已打开的页面重新注入本脚本。同一页面里只让最新的一份工作，
// 旧的那份（和插件的连接已经断开）发现自己过期就停下。

(() => {
  const POLL_INTERVAL = 45 * 1000; // 服务器 2 分钟没心跳算失联，45 秒上报一次足够
  const ACTIVITY_WINDOW = 5 * 60 * 1000; // 5 分钟内有操作才算“活跃”

  const instance = {};
  globalThis.__julebuContent = instance;
  const isCurrent = () => globalThis.__julebuContent === instance && !!(chrome.runtime && chrome.runtime.id);

  let lastActivity = Date.now();
  let timer = null;

  ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'].forEach((ev) =>
    window.addEventListener(ev, () => (lastActivity = Date.now()), { passive: true, capture: true }),
  );

  function isActive() {
    return document.visibilityState === 'visible' && Date.now() - lastActivity < ACTIVITY_WINDOW;
  }

  function tellBackground(payload) {
    // background 可能正在休眠，发送失败忽略即可，下次轮询会补上
    try {
      chrome.runtime.sendMessage({ type: 'JULEBU_IDENTITY', payload }).catch(() => {});
    } catch {}
  }

  async function poll() {
    if (!isCurrent()) return clearInterval(timer);
    const at = Date.now(); // 读取开始的时间，background 用它丢弃“退出之前读到的已登录”
    const s = await JulebuAuth.readSession();
    if (!isCurrent()) return clearInterval(timer);
    tellBackground({ ...s, active: isActive(), at });
  }

  poll();
  timer = setInterval(poll, POLL_INTERVAL);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
  });

  // ---- 指令 ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isCurrent()) return false;
    if (msg.cmd === 'LOGIN') {
      doLogin(msg.phone, msg.password).then(sendResponse);
      return true;
    }
    if (msg.cmd === 'LOGOUT') {
      JulebuAuth.logoutManaged(msg.phones || []).then((r) => {
        sendResponse(r);
        poll();
      });
      return true;
    }
    if (msg.cmd === 'POLL_NOW') {
      poll().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.cmd === 'PING') {
      sendResponse({ ok: true });
      return false;
    }
  });

  async function doLogin(phone, password) {
    try {
      const res = await fetch(`${JulebuAuth.AUTH_BASE}/phone-number/sign-in-with-pwd`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: (data && (data.message || data.error)) || `登录失败（${res.status}）` };
      }
      await poll(); // 立即上报新的登录状态
      // 换了账号后，当前页面可能还显示着旧账号的内容，统一回首页重新加载。
      // 稍等一下再跳，先让这次的结果传回 background。
      setTimeout(() => (location.href = 'https://julebu.co/home'), 300);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: '网络错误：' + (e && e.message ? e.message : String(e)) };
    }
  }
})();
