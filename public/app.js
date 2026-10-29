const { createApp, ref, reactive, computed, onMounted, onUnmounted } = Vue;

const TOKEN_KEY = 'julebu_mg_admin_token';

// ---------- 小工具 ----------
function pad(n) {
  return String(n).padStart(2, '0');
}
function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now - 86400000);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
function fmtDuration(ms) {
  if (ms == null || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
  const days = Math.floor(h / 24);
  return `${days} 天 ${h % 24} 小时`;
}
function statusText(st) {
  if (st && st.online) {
    // 多人同时在线时，任何一人在操作就算使用中
    const u = st.users.find((x) => x.active) || st.users[0];
    const who = st.users.map((x) => x.nickname).join('、');
    const extra = `${fmtTime(u.login_at)}开始 · 已用 ${fmtDuration(u.duration_ms)}`;
    if (u.active) return { cls: 'on', label: `使用中 · ${who}`, extra };
    return { cls: 'idle', label: `在线挂着 · ${who}`, extra };
  }
  const last = st && st.last;
  if (!last) return { cls: 'off', label: '从未使用' };
  // 心跳中断（断网、电脑睡眠、浏览器被关掉）：对方可能还登录着，不能当成空闲
  if (last.offline_reason === 'timeout') {
    return { cls: 'lost', label: `失联 · ${last.nickname}`, extra: `最后在线 ${fmtTime(last.offline_at)}，可能仍在使用` };
  }
  return { cls: 'off', label: `空闲 · ${fmtTime(last.offline_at)}下线` };
}

const app = createApp({
  setup() {
    const token = ref(localStorage.getItem(TOKEN_KEY) || '');
    const loggedIn = computed(() => !!token.value);
    const tab = ref('accounts');
    const toast = reactive({ show: false, msg: '', err: false });
    let toastTimer = null;

    function notify(msg, err = false) {
      toast.msg = msg;
      toast.err = err;
      toast.show = true;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (toast.show = false), 2600);
    }

    async function api(path, { method = 'GET', body } = {}) {
      const res = await fetch(`/api${path}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && token.value) {
        logout();
        throw new Error('登录已过期，请重新登录');
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }

    // ---------- 登录 ----------
    const login = reactive({ password: '', err: '', loading: false });
    async function doLogin() {
      login.err = '';
      login.loading = true;
      try {
        const { token: t } = await api('/admin/login', { method: 'POST', body: { password: login.password } });
        token.value = t;
        localStorage.setItem(TOKEN_KEY, t);
        login.password = '';
        loadAll();
      } catch (e) {
        login.err = e.message;
      } finally {
        login.loading = false;
      }
    }
    function logout() {
      token.value = '';
      localStorage.removeItem(TOKEN_KEY);
    }

    // ---------- 账号 ----------
    const accounts = ref([]);
    const accountsLoading = ref(false);
    async function loadAccounts() {
      accountsLoading.value = true;
      try {
        const data = await api('/admin/accounts');
        accounts.value = data.accounts;
      } catch (e) {
        notify(e.message, true);
      } finally {
        accountsLoading.value = false;
      }
    }

    const accountModal = reactive({ show: false, id: null, label: '', phone: '', password: '', note: '', err: '', saving: false });
    function openAccount(a) {
      Object.assign(accountModal, {
        show: true,
        id: a ? a.id : null,
        label: a ? a.label : '',
        phone: a ? a.phone : '',
        password: '',
        note: a ? a.note : '',
        err: '',
        saving: false,
      });
    }
    async function saveAccount() {
      accountModal.err = '';
      accountModal.saving = true;
      try {
        const body = { label: accountModal.label, phone: accountModal.phone, note: accountModal.note };
        if (accountModal.password) body.password = accountModal.password;
        if (accountModal.id) {
          await api(`/admin/accounts/${accountModal.id}`, { method: 'PUT', body });
          delete revealed[accountModal.id]; // 显示着的旧密码可能已经改了
        } else {
          if (!accountModal.password) throw new Error('请填写密码');
          await api('/admin/accounts', { method: 'POST', body });
        }
        accountModal.show = false;
        notify('已保存');
        loadAccounts();
      } catch (e) {
        accountModal.err = e.message;
      } finally {
        accountModal.saving = false;
      }
    }
    async function delAccount(a) {
      if (!confirm(`确定删除账号「${a.label}」？相关使用记录也会一并删除。`)) return;
      try {
        await api(`/admin/accounts/${a.id}`, { method: 'DELETE' });
        notify('已删除');
        loadAccounts();
      } catch (e) {
        notify(e.message, true);
      }
    }
    async function showPassword(a) {
      try {
        const { password } = await api(`/admin/accounts/${a.id}/password`);
        await copy(password, `「${a.label}」的密码已复制`);
      } catch (e) {
        notify(e.message, true);
      }
    }

    // 在列表里直接显示/隐藏密码
    const revealed = reactive({});
    async function togglePassword(a) {
      if (a.id in revealed) {
        delete revealed[a.id];
        return;
      }
      try {
        const { password } = await api(`/admin/accounts/${a.id}/password`);
        revealed[a.id] = password;
      } catch (e) {
        notify(e.message, true);
      }
    }

    // ---------- 分组 ----------
    const groups = ref([]);
    async function loadGroups() {
      try {
        const data = await api('/admin/groups');
        groups.value = data.groups;
      } catch (e) {
        notify(e.message, true);
      }
    }
    const groupModal = reactive({ show: false, id: null, name: '', accountIds: [], err: '', saving: false });
    function openGroup(g) {
      Object.assign(groupModal, {
        show: true,
        id: g ? g.id : null,
        name: g ? g.name : '',
        accountIds: g ? [...g.account_ids] : [],
        err: '',
        saving: false,
      });
    }
    function toggleAcc(id) {
      const i = groupModal.accountIds.indexOf(id);
      if (i >= 0) groupModal.accountIds.splice(i, 1);
      else groupModal.accountIds.push(id);
    }
    async function saveGroup() {
      groupModal.err = '';
      groupModal.saving = true;
      try {
        const body = { name: groupModal.name, account_ids: groupModal.accountIds };
        if (groupModal.id) await api(`/admin/groups/${groupModal.id}`, { method: 'PUT', body });
        else await api('/admin/groups', { method: 'POST', body });
        groupModal.show = false;
        notify('已保存');
        loadGroups();
      } catch (e) {
        groupModal.err = e.message;
      } finally {
        groupModal.saving = false;
      }
    }
    async function resetCode(g) {
      if (!confirm(`重置「${g.name}」的分组代码？\n已加入的 ${g.member_count} 位成员会被移出，需要用新代码重新加入。`)) return;
      try {
        const { code } = await api(`/admin/groups/${g.id}/reset-code`, { method: 'POST' });
        notify('分组代码已重置');
        loadGroups();
        showInvite({ ...g, code });
      } catch (e) {
        notify(e.message, true);
      }
    }
    async function delGroup(g) {
      if (!confirm(`删除分组「${g.name}」？成员会被移出，使用记录保留。`)) return;
      try {
        await api(`/admin/groups/${g.id}`, { method: 'DELETE' });
        notify('已删除');
        loadGroups();
      } catch (e) {
        notify(e.message, true);
      }
    }

    // 邀请串：服务器地址 + # + 分组代码，租户在插件里粘贴一次就行
    const inviteModal = reactive({ show: false, name: '', code: '', link: '' });
    function showInvite(g) {
      inviteModal.name = g.name;
      inviteModal.code = g.code;
      inviteModal.link = `${location.origin}#${g.code}`;
      inviteModal.show = true;
    }

    // ---------- 成员 ----------
    const memberModal = reactive({ show: false, group: null, members: [], loading: false });
    async function openMembers(g) {
      memberModal.show = true;
      memberModal.group = g;
      memberModal.loading = true;
      memberModal.members = [];
      try {
        const data = await api(`/admin/groups/${g.id}/members`);
        memberModal.members = data.members;
      } catch (e) {
        notify(e.message, true);
      } finally {
        memberModal.loading = false;
      }
    }
    async function removeMember(m) {
      if (!confirm(`移出成员「${m.nickname}」？对方需要用分组代码重新加入。`)) return;
      try {
        await api(`/admin/members/${m.id}`, { method: 'DELETE' });
        notify('已移出');
        openMembers(memberModal.group);
        loadGroups();
      } catch (e) {
        notify(e.message, true);
      }
    }

    // ---------- 使用记录 ----------
    const sessions = ref([]);
    const sessionFilter = reactive({ account_id: '', group_id: '' });
    async function loadSessions() {
      try {
        const q = new URLSearchParams();
        if (sessionFilter.account_id) q.set('account_id', sessionFilter.account_id);
        if (sessionFilter.group_id) q.set('group_id', sessionFilter.group_id);
        const data = await api(`/admin/sessions?${q}`);
        sessions.value = data.sessions;
      } catch (e) {
        notify(e.message, true);
      }
    }

    // ---------- 通用 ----------
    async function copy(text, msg) {
      try {
        await navigator.clipboard.writeText(text);
        notify(msg || '已复制');
      } catch {
        // 某些浏览器非 https 下 clipboard 不可用，退回提示手动复制
        prompt('请手动复制：', text);
      }
    }

    let statusTimer = null;
    function loadAll() {
      loadAccounts();
      loadGroups();
      loadSessions();
    }

    onMounted(() => {
      if (loggedIn.value) loadAll();
      // 账号状态每 15 秒自动刷新一次
      statusTimer = setInterval(() => {
        if (loggedIn.value && tab.value === 'accounts' && !accountModal.show) loadAccounts();
      }, 15000);
    });
    onUnmounted(() => clearInterval(statusTimer));

    return {
      token, loggedIn, tab, toast, notify,
      login, doLogin, logout,
      accounts, accountsLoading, loadAccounts, accountModal, openAccount, saveAccount, delAccount, showPassword, revealed, togglePassword,
      groups, loadGroups, groupModal, openGroup, toggleAcc, saveGroup, resetCode, delGroup,
      inviteModal, showInvite,
      memberModal, openMembers, removeMember,
      sessions, sessionFilter, loadSessions,
      copy, statusText, fmtTime, fmtDuration,
    };
  },

  template: `
  <!-- 登录页 -->
  <div v-if="!loggedIn" class="login-wrap">
    <div class="login-card">
      <h1>句乐部账号管理后台</h1>
      <p class="sub">请输入管理密码</p>
      <form @submit.prevent="doLogin">
        <input type="password" v-model="login.password" placeholder="管理密码" autofocus />
        <div class="err-text">{{ login.err }}</div>
        <button class="primary" style="width:100%;margin-top:8px" :disabled="login.loading">
          {{ login.loading ? '登录中…' : '登录' }}
        </button>
      </form>
    </div>
  </div>

  <!-- 主界面 -->
  <template v-else>
    <div class="topbar">
      <span class="brand">👥 句乐部账号管理</span>
      <div class="tabs">
        <button :class="{active: tab==='accounts'}" @click="tab='accounts'">账号</button>
        <button :class="{active: tab==='groups'}" @click="tab='groups'">分组</button>
        <button :class="{active: tab==='sessions'}" @click="tab='sessions';loadSessions()">使用记录</button>
      </div>
      <button class="link" @click="logout">退出</button>
    </div>

    <div class="container">
      <!-- 账号 -->
      <section v-if="tab==='accounts'">
        <div class="toolbar">
          <h2>账号</h2>
          <button class="link sm" @click="loadAccounts">刷新</button>
          <button class="primary" @click="openAccount(null)">+ 添加账号</button>
        </div>
        <div class="card">
          <div v-if="!accounts.length" class="empty">还没有账号，点右上角「添加账号」。</div>
          <table v-else>
            <thead>
              <tr>
                <th>账号</th><th>手机号</th><th>当前状态</th>
                <th class="hide-sm">所属分组</th><th style="text-align:right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in accounts" :key="a.id">
                <td>
                  <strong>{{ a.label }}</strong>
                  <div v-if="a.note" class="muted" style="font-size:12px">{{ a.note }}</div>
                </td>
                <td class="mono">
                  {{ a.phone }}
                  <div v-if="a.id in revealed" class="muted" style="font-size:12px">密码：{{ revealed[a.id] }}</div>
                </td>
                <td>
                  <span class="dot" :class="statusText(a.status).cls"></span>
                  <span :class="'status-' + statusText(a.status).cls">
                    {{ statusText(a.status).label }}
                  </span>
                  <span v-if="statusText(a.status).extra" class="muted" style="font-size:12px"> · {{ statusText(a.status).extra }}</span>
                  <span v-if="a.status.users && a.status.users.length > 1" class="chip" style="background:#fde8e8;color:#dc2626">⚠ {{ a.status.users.length }} 人同时在线</span>
                </td>
                <td class="hide-sm">
                  <span v-for="g in a.groups" :key="g.id" class="chip">{{ g.name }}</span>
                  <span v-if="!a.groups.length" class="muted">未分组</span>
                </td>
                <td>
                  <div class="row-actions">
                    <button class="sm link" @click="togglePassword(a)">{{ a.id in revealed ? '隐藏密码' : '查看密码' }}</button>
                    <button class="sm link" @click="showPassword(a)">复制密码</button>
                    <button class="sm" @click="openAccount(a)">编辑</button>
                    <button class="sm danger" @click="delAccount(a)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 分组 -->
      <section v-if="tab==='groups'">
        <div class="toolbar">
          <h2>分组</h2>
          <button class="primary" @click="openGroup(null)">+ 新建分组</button>
        </div>
        <div class="card">
          <div v-if="!groups.length" class="empty">还没有分组。新建分组后把分组代码发给朋友即可。</div>
          <table v-else>
            <thead>
              <tr><th>分组</th><th>分组代码</th><th>账号数</th><th>成员</th><th style="text-align:right">操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="g in groups" :key="g.id">
                <td><strong>{{ g.name }}</strong></td>
                <td><span class="mono" style="font-weight:600;letter-spacing:1px">{{ g.code }}</span></td>
                <td>{{ g.account_ids.length }}</td>
                <td><button class="link sm" @click="openMembers(g)">{{ g.member_count }} 人</button></td>
                <td>
                  <div class="row-actions">
                    <button class="sm primary" @click="showInvite(g)">邀请</button>
                    <button class="sm" @click="openGroup(g)">编辑</button>
                    <button class="sm" @click="resetCode(g)">重置代码</button>
                    <button class="sm danger" @click="delGroup(g)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 使用记录 -->
      <section v-if="tab==='sessions'">
        <div class="toolbar">
          <h2>使用记录</h2>
          <select v-model="sessionFilter.account_id" @change="loadSessions" style="width:auto;padding:6px 10px;border-radius:8px;border:1px solid var(--border)">
            <option value="">全部账号</option>
            <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.label }}</option>
          </select>
          <button class="link sm" @click="loadSessions">刷新</button>
        </div>
        <div class="card">
          <div v-if="!sessions.length" class="empty">还没有使用记录。</div>
          <table v-else>
            <thead>
              <tr><th>账号</th><th>使用者</th><th>开始</th><th>时长</th><th>状态</th></tr>
            </thead>
            <tbody>
              <tr v-for="s in sessions" :key="s.id">
                <td>{{ s.account_label || '(已删除)' }}</td>
                <td>{{ s.nickname }}</td>
                <td>{{ fmtTime(s.login_at) }}</td>
                <td>{{ fmtDuration(s.duration_ms) }}</td>
                <td>
                  <span v-if="s.online" class="status-on"><span class="dot on"></span>使用中</span>
                  <span v-else-if="s.offline_reason === 'timeout'" class="status-lost" title="心跳中断：可能断网、电脑睡眠或浏览器被关掉，不确定是否已退出">{{ fmtTime(s.offline_at) }} 后失联</span>
                  <span v-else class="muted">{{ fmtTime(s.offline_at) }} 下线</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <!-- 账号弹窗 -->
    <div v-if="accountModal.show" class="modal-mask" @click.self="accountModal.show=false">
      <div class="modal">
        <h3>{{ accountModal.id ? '编辑账号' : '添加账号' }}</h3>
        <label>账号名称（方便区分，如「大号」）</label>
        <input v-model="accountModal.label" placeholder="给账号起个名字" />
        <label>手机号（句乐部登录用，11 位）</label>
        <input v-model="accountModal.phone" class="mono" placeholder="13800138000" />
        <label>密码{{ accountModal.id ? '（留空表示不修改）' : '' }}</label>
        <input v-model="accountModal.password" type="text" :placeholder="accountModal.id ? '不改就留空' : '句乐部登录密码'" />
        <label>备注（可选）</label>
        <input v-model="accountModal.note" placeholder="可选" />
        <div class="err-text">{{ accountModal.err }}</div>
        <div class="modal-actions">
          <button @click="accountModal.show=false">取消</button>
          <button class="primary" :disabled="accountModal.saving" @click="saveAccount">保存</button>
        </div>
      </div>
    </div>

    <!-- 分组弹窗 -->
    <div v-if="groupModal.show" class="modal-mask" @click.self="groupModal.show=false">
      <div class="modal">
        <h3>{{ groupModal.id ? '编辑分组' : '新建分组' }}</h3>
        <label>分组名称</label>
        <input v-model="groupModal.name" placeholder="如「宿舍四人组」" />
        <label>包含哪些账号（成员只能看到、上报这些账号）</label>
        <div class="checklist" v-if="accounts.length">
          <label v-for="a in accounts" :key="a.id">
            <input type="checkbox" :checked="groupModal.accountIds.includes(a.id)" @change="toggleAcc(a.id)" />
            {{ a.label }} <span class="muted mono">{{ a.phone }}</span>
          </label>
        </div>
        <p v-else class="hint">还没有账号，请先到「账号」里添加。</p>
        <div class="err-text">{{ groupModal.err }}</div>
        <div class="modal-actions">
          <button @click="groupModal.show=false">取消</button>
          <button class="primary" :disabled="groupModal.saving" @click="saveGroup">保存</button>
        </div>
      </div>
    </div>

    <!-- 邀请弹窗 -->
    <div v-if="inviteModal.show" class="modal-mask" @click.self="inviteModal.show=false">
      <div class="modal">
        <h3>邀请成员加入「{{ inviteModal.name }}」</h3>
        <label>分组代码（在插件里输入这个）</label>
        <div class="code-box">{{ inviteModal.code }}</div>
        <button class="sm" style="margin-top:8px" @click="copy(inviteModal.code, '分组代码已复制')">复制代码</button>
        <label style="margin-top:18px">一键邀请串（把服务器地址和代码合在一起，租户粘贴一次即可）</label>
        <input class="mono" :value="inviteModal.link" readonly @focus="$event.target.select()" />
        <button class="sm primary" style="margin-top:8px" @click="copy(inviteModal.link, '邀请串已复制')">复制邀请串</button>
        <p class="hint">提示：把邀请串发给朋友，他们在插件里粘贴即可加入，不用再单独填服务器地址。</p>
        <div class="modal-actions">
          <button class="primary" @click="inviteModal.show=false">完成</button>
        </div>
      </div>
    </div>

    <!-- 成员弹窗 -->
    <div v-if="memberModal.show" class="modal-mask" @click.self="memberModal.show=false">
      <div class="modal">
        <h3>「{{ memberModal.group && memberModal.group.name }}」的成员</h3>
        <div v-if="memberModal.loading" class="muted">加载中…</div>
        <div v-else-if="!memberModal.members.length" class="muted">还没有人加入。</div>
        <table v-else>
          <thead><tr><th>昵称</th><th>最近活跃</th><th></th></tr></thead>
          <tbody>
            <tr v-for="m in memberModal.members" :key="m.id">
              <td>{{ m.nickname }}</td>
              <td class="muted">{{ fmtTime(m.last_seen_at) }}</td>
              <td style="text-align:right"><button class="sm danger" @click="removeMember(m)">移出</button></td>
            </tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button @click="memberModal.show=false">关闭</button>
        </div>
      </div>
    </div>
  </template>

  <!-- 提示条 -->
  <transition name="fade">
    <div v-if="toast.show" class="toast" :class="{err: toast.err}">{{ toast.msg }}</div>
  </transition>
  `,
});

app.mount('#app');
