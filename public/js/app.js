'use strict';

const App = (() => {

  // ── State ────────────────────────────────────────────────────────────────
  let currentUser = null;
  let _accessToken = null;
  let _refreshToken = null;
  let _refreshing = false;

  // ── Token storage (localStorage) ─────────────────────────────────────────
  const Store = {
    save(token, refresh, user) {
      _accessToken  = token;
      _refreshToken = refresh;
      currentUser   = user;
      localStorage.setItem('ge_token',   token);
      localStorage.setItem('ge_refresh', refresh);
      localStorage.setItem('ge_user',    JSON.stringify(user));
    },
    load() {
      _accessToken  = localStorage.getItem('ge_token');
      _refreshToken = localStorage.getItem('ge_refresh');
      const u = localStorage.getItem('ge_user');
      currentUser   = u ? JSON.parse(u) : null;
    },
    clear() {
      _accessToken = _refreshToken = currentUser = null;
      localStorage.removeItem('ge_token');
      localStorage.removeItem('ge_refresh');
      localStorage.removeItem('ge_user');
    },
  };

  // ── API Helper ───────────────────────────────────────────────────────────
  const API = {
    async request(method, url, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`;

      const opts = { method, headers };
      if (body) opts.body = JSON.stringify(body);

      let res = await fetch(url, opts);

      // Auto-refresh on expired token
      if (res.status === 401 && !_refreshing) {
        const data = await res.clone().json().catch(() => ({}));
        if (data.error === 'token_expired' && _refreshToken) {
          const refreshed = await Auth.refresh();
          if (refreshed) {
            headers['Authorization'] = `Bearer ${_accessToken}`;
            res = await fetch(url, { method, headers, body: opts.body });
          } else {
            Auth.forceLogout();
            return null;
          }
        }
      }
      return res;
    },
    get:    (url)       => API.request('GET',    url),
    post:   (url, body) => API.request('POST',   url, body),
    patch:  (url, body) => API.request('PATCH',  url, body),
    delete: (url)       => API.request('DELETE', url),
  };

  // ── Toast ────────────────────────────────────────────────────────────────
  let _toastTimer = null;
  const Toast = {
    show(msg, type = 'default') {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = type === 'error' ? 'error' : type === 'success' ? 'success' : '';
      el.classList.add('show');
      clearTimeout(_toastTimer);
      _toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
    },
    ok:  (msg) => Toast.show(msg, 'success'),
    err: (msg) => Toast.show(msg, 'error'),
  };

  // ── Util ─────────────────────────────────────────────────────────────────
  const Util = {
    maskCNPJ(el) {
      let v = el.value.replace(/\D/g, '').slice(0, 14);
      if (v.length > 12) v = `${v.slice(0,2)}.${v.slice(2,5)}.${v.slice(5,8)}/${v.slice(8,12)}-${v.slice(12)}`;
      else if (v.length > 8) v = `${v.slice(0,2)}.${v.slice(2,5)}.${v.slice(5,8)}/${v.slice(8)}`;
      else if (v.length > 5) v = `${v.slice(0,2)}.${v.slice(2,5)}.${v.slice(5)}`;
      else if (v.length > 2) v = `${v.slice(0,2)}.${v.slice(2)}`;
      el.value = v;
    },
    syncRange(rangeId, valId) {
      document.getElementById(valId).textContent = document.getElementById(rangeId).value;
    },
    toggleOutro(selId, wrapId) {
      const wrap = document.getElementById(wrapId);
      if (!wrap) return;
      const isOutro = document.getElementById(selId)?.value === 'Outro';
      wrap.style.display = isOutro ? 'flex' : 'none';
      wrap.hidden = !isOutro;
    },
    val(id)    { return document.getElementById(id)?.value?.trim() ?? ''; },
    intVal(id) { return parseInt(document.getElementById(id)?.value ?? '0', 10); },
    clear(ids) { ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; }); },
    clearRange(pairs) { pairs.forEach(([rId, vId, def]) => { document.getElementById(rId).value = def; document.getElementById(vId).textContent = def; }); },
    requireFields(fields) {
      for (const [id, label] of fields) {
        const el = document.getElementById(id);
        if (!el || !el.value.trim()) { Toast.err(`Campo obrigatório: ${label}`); el?.focus(); return false; }
      }
      return true;
    },
  };

  // ── Auth ─────────────────────────────────────────────────────────────────
  const Auth = {
    async login() {
      const email    = Util.val('login-email');
      const password = Util.val('login-pass');
      if (!email || !password) { Auth.showAlert('Preencha e-mail e senha.'); return; }

      const btn = document.getElementById('btn-login');
      btn.innerHTML = '<span class="spinner"></span>';
      btn.disabled  = true;

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      btn.innerHTML = 'Entrar';
      btn.disabled  = false;

      const data = await res.json();
      if (!res.ok) { Auth.showAlert(data.error || 'Erro ao fazer login.'); return; }

      Store.save(data.token, data.refreshToken, data.user);
      Auth.onLoggedIn(data.user);
    },

    async loginGoogle() {
      Toast.err('Google OAuth requer configuração adicional no servidor.');
    },

    async register() {
      const name     = Util.val('reg-name');
      const email    = Util.val('reg-email');
      const password = Util.val('reg-pass');
      const role     = document.getElementById('reg-role').value;

      if (!name || !email || !password) { Auth.showAlert('Preencha todos os campos.'); return; }
      if (password.length < 6) { Auth.showAlert('Senha deve ter ao menos 6 caracteres.'); return; }

      const res  = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, role }),
      });
      const data = await res.json();
      if (!res.ok) { Auth.showAlert(data.error); return; }

      Store.save(data.token, data.refreshToken, data.user);
      Auth.onLoggedIn(data.user);
    },

    async refresh() {
      if (!_refreshToken) return false;
      _refreshing = true;
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: _refreshToken }),
        });
        if (!res.ok) return false;
        const data = await res.json();
        Store.save(data.token, data.refreshToken, data.user);
        return true;
      } catch { return false; }
      finally { _refreshing = false; }
    },

    async logout() {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_accessToken}` },
        body: JSON.stringify({ refreshToken: _refreshToken }),
      }).catch(() => {});
      Auth.forceLogout();
    },

    forceLogout() {
      Store.clear();
      document.getElementById('app').hidden         = true;
      document.getElementById('auth-screen').hidden = false;
      document.getElementById('login-email').value  = '';
      document.getElementById('login-pass').value   = '';
      Auth.showLogin();
    },

    onLoggedIn(user) {
      currentUser = user;
      document.getElementById('topbar-name').textContent = user.name;
      const pill = document.getElementById('topbar-role');
      pill.textContent = user.role === 'administrador' ? 'Administrador' : 'Usuário';
      pill.className   = 'role-pill ' + (user.role === 'administrador' ? 'admin' : 'user');
      document.querySelectorAll('.admin-only').forEach(el => {
        if (user.role === 'administrador') {
          el.style.setProperty('display', 'flex', 'important');
        } else {
          el.style.setProperty('display', 'none', 'important');
        }
      });
      document.getElementById('auth-screen').hidden = true;
      document.getElementById('app').hidden          = false;
      Nav.go('dashboard');
    },

    async tryAutoLogin() {
      Store.load();
      if (!_accessToken || !currentUser) return false;

      // Restore session from localStorage immediately — don't show login screen
      Auth.onLoggedIn(currentUser);

      // Then silently validate in the background (doesn't block UI)
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch('/api/auth/me', {
          headers: { 'Authorization': `Bearer ${_accessToken}` },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          const data = await res.json();
          // Update user data silently (e.g. role change)
          if (data.user) Auth.onLoggedIn(data.user);
          return true;
        }
        // 401 — try refresh token
        if (res.status === 401 && _refreshToken) {
          const refreshed = await Auth.refresh();
          if (refreshed) return true;
          // Refresh also failed — session truly expired
          Auth.forceLogout();
          return false;
        }
      } catch (e) {
        // Network error or timeout (Render waking up) — keep session, will retry on next call
        return true;
      }
      return true;
    },

    isAdmin() {
      return currentUser?.role === 'administrador';
    },

    showAlert(msg) {
      const el = document.getElementById('auth-alert');
      el.textContent = msg;
      el.hidden = false;
    },
    showLogin() {
      document.getElementById('auth-alert').hidden    = true;
      document.getElementById('form-login').hidden    = false;
      document.getElementById('form-register').hidden = true;
    },
    showRegister() {
      document.getElementById('auth-alert').hidden    = true;
      document.getElementById('form-login').hidden    = true;
      document.getElementById('form-register').hidden = false;
    },
  };

  // ── Navigation ───────────────────────────────────────────────────────────
  const PAGE_TITLES = {
    dashboard:'Dashboard', atendimento:'Atendimento', gestao:'Gestão de Clientes',
    insatisfacao:'Insatisfação', sensiveis:'Clientes Sensíveis',
    pesquisas:'Pesquisas de Satisfação', recuperacao:'Recuperação de Clientes',
    admin:'Administração de Usuários',
  };

  const Nav = {
    go(page) {
      if (page === 'admin' && currentUser?.role !== 'administrador') return false;
      document.querySelectorAll('.page').forEach(el => el.hidden = true);
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      const pg = document.getElementById(`page-${page}`);
      if (pg) pg.hidden = false;
      document.querySelectorAll(`.nav-item[data-page="${page}"]`).forEach(el => el.classList.add('active'));
      document.getElementById('page-title').textContent = PAGE_TITLES[page] || page;
      if (page === 'dashboard') Dashboard.load();
      if (page === 'pesquisas')  Pesquisas.loadGrid();
      if (page === 'insatisfacao') Insatisfacao.loadGrid();
      if (page === 'sensiveis')   Sensiveis.loadGrid();
      if (page === 'admin')     Admin.load();
      return false;
    },
  };

  // ── Dashboard ─────────────────────────────────────────────────────────────
  const CHART_COLORS = ['#1a4233','#f5c518','#3182ce','#e53e3e','#38a169','#d69e2e','#9b2c2c','#2c7a7b'];
  let _charts = {};

  const Dashboard = {
    async load() {
      const period = document.getElementById('dash-period').value;
      const res    = await API.get(`/api/data/dashboard?period=${period}`);
      if (!res || !res.ok) return;
      const d = await res.json();

      const stats = [
        { label:'Total Atendimentos', value: d.totals.atendimentos },
        { label:'Gestões',            value: d.totals.gestoes },
        { label:'Insatisfações',      value: d.totals.insatisfacoes },
        { label:'Clientes Sensíveis', value: d.totals.sensiveis },
        { label:'Pesquisas',          value: d.totals.pesquisas },
        { label:'Recuperações',       value: d.totals.recuperacoes },
      ];
      document.getElementById('stats-grid').innerHTML = stats.map(s =>
        `<div class="stat-card"><div class="stat-label">${s.label}</div><div class="stat-value">${s.value}</div></div>`
      ).join('');

      Dashboard.renderChart('c-depto',  'bar',      d.charts.atendPorDepto,    'Departamento');
      Dashboard.renderChart('c-gestao', 'doughnut', d.charts.gestaoPorTipo,    'Solicitação');
      Dashboard.renderChart('c-grav',   'bar',      d.charts.insatPorGravidade,'Gravidade');
      Dashboard.renderChart('c-canal',  'pie',      d.charts.gestaoPorCanal,   'Canal');

      document.getElementById('nps-row').innerHTML = [
        { label:'NPS Médio',  value: d.nps,  sub:'Net Promoter Score (0–10)' },
        { label:'CSAT Médio', value: d.csat, sub:'Satisfação do cliente (0–5)' },
        { label:'CES Médio',  value: d.ces,  sub:'Esforço do cliente (0–5)' },
      ].map(n => `
        <div class="nps-card">
          <div class="nps-label">${n.label}</div>
          <div class="nps-value">${n.value != null ? n.value.toFixed(1) : '—'}</div>
          <div class="nps-sub">${n.sub}</div>
        </div>`).join('');
    },

    renderChart(id, type, rows, labelKey) {
      if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
      const ctx = document.getElementById(id);
      if (!ctx) return;
      const labels = rows.map(r => r.label || 'Não informado');
      const data   = rows.map(r => r.n);
      const bg     = type === 'bar' ? CHART_COLORS[0] : labels.map((_,i) => CHART_COLORS[i % CHART_COLORS.length]);
      _charts[id] = new Chart(ctx, {
        type,
        data: { labels, datasets: [{ label: labelKey, data, backgroundColor: bg, borderColor:'#fff', borderWidth: type==='bar'?0:2, borderRadius: type==='bar'?4:0 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: type!=='bar', position:'bottom', labels:{ boxWidth:12, font:{size:11}, padding:12 } } },
          scales: type==='bar' ? { y:{ beginAtZero:true, ticks:{stepSize:1,font:{size:11}}, grid:{color:'rgba(0,0,0,.05)'} }, x:{ ticks:{font:{size:11},maxRotation:35}, grid:{display:false} } } : {},
        },
      });
    },

    async clear() {
      if (!confirm('Limpar todos os dados do período selecionado?')) return;
      const period = document.getElementById('dash-period').value;
      const res    = await API.delete(`/api/data/clear?period=${period}`);
      if (res?.ok) { Toast.ok('Dados limpos!'); Dashboard.load(); }
      else Toast.err('Erro ao limpar dados.');
    },
  };

  // ── Forms ─────────────────────────────────────────────────────────────────
  const Forms = {
    async _submit(endpoint, body, clearIds, toastMsg) {
      const res = await API.post(`/api/data/${endpoint}`, body);
      if (!res) return;
      const data = await res.json();
      if (!res.ok) { Toast.err(data.error || 'Erro ao salvar.'); return; }
      Util.clear(clearIds);
      Toast.ok(toastMsg);
    },

    async atendimento() {
      if (!Util.requireFields([['at-analista','Analista'],['at-cliente','Cliente'],['at-cnpj','CNPJ'],['at-empresa','Empresa'],['at-depto','Departamento'],['at-procurado','Analista Procurado'],['at-demanda','Demanda']])) return;
      const demanda = Util.val('at-demanda');
      await Forms._submit('atendimentos', {
        analista: Util.val('at-analista'), cliente: Util.val('at-cliente'),
        cnpj: Util.val('at-cnpj'), empresa: Util.val('at-empresa'),
        departamento: Util.val('at-depto'), procurado: Util.val('at-procurado'),
        demanda: demanda==='Outro' ? Util.val('at-outro') : demanda,
        resumo: Util.val('at-resumo'),
      }, ['at-analista','at-cliente','at-cnpj','at-empresa','at-procurado','at-outro','at-resumo'], 'Atendimento salvo!');
      document.getElementById('at-depto').value=''; document.getElementById('at-demanda').value='';
      document.getElementById('at-outro-wrap').hidden=true;
    },

    async gestao() {
      if (!Util.requireFields([['gc-analista','Analista'],['gc-solicitacao','Solicitação'],['gc-cnpj','CNPJ'],['gc-empresa','Empresa'],['gc-data','Data'],['gc-competencia','Competência'],['gc-canal','Canal']])) return;
      await Forms._submit('gestao', {
        analista: Util.val('gc-analista'), solicitacao: Util.val('gc-solicitacao'),
        cnpj: Util.val('gc-cnpj'), empresa: Util.val('gc-empresa'),
        data_sol: Util.val('gc-data'), competencia: Util.val('gc-competencia'),
        canal: Util.val('gc-canal'), motivo: Util.val('gc-motivo'),
      }, ['gc-analista','gc-cnpj','gc-empresa','gc-data','gc-competencia','gc-motivo'], 'Gestão salva!');
      document.getElementById('gc-solicitacao').value=''; document.getElementById('gc-canal').value='';
    },

    async insatisfacao() {
      if (!Util.requireFields([['in-analista','Analista'],['in-cliente','Cliente'],['in-cnpj','CNPJ'],['in-empresa','Empresa'],['in-reclamacao','Reclamação'],['in-gravidade','Gravidade']])) return;
      await Forms._submit('insatisfacoes', {
        analista: Util.val('in-analista'), cliente: Util.val('in-cliente'),
        cnpj: Util.val('in-cnpj'), empresa: Util.val('in-empresa'),
        reclamado: Util.val('in-reclamado'), reclamacao: Util.val('in-reclamacao'),
        gravidade: Util.val('in-gravidade'),
      }, ['in-analista','in-cliente','in-cnpj','in-empresa','in-reclamado','in-reclamacao'], 'Insatisfação registrada!');
      document.getElementById('in-gravidade').value='';
      Insatisfacao.loadGrid();
    },

    async sensiveis() {
      if (!Util.requireFields([['cs-analista','Analista'],['cs-cliente','Cliente'],['cs-cnpj','CNPJ'],['cs-empresa','Empresa'],['cs-demonstrou','O que demonstrou'],['cs-gravidade','Gravidade']])) return;
      await Forms._submit('sensiveis', {
        analista: Util.val('cs-analista'), cliente: Util.val('cs-cliente'),
        cnpj: Util.val('cs-cnpj'), empresa: Util.val('cs-empresa'),
        demonstrou: Util.val('cs-demonstrou')==='Outro' ? Util.val('cs-outro') : Util.val('cs-demonstrou'),
        gravidade: Util.val('cs-gravidade'),
        detalhe: Util.val('cs-detalhe') || null,
      }, ['cs-analista','cs-cliente','cs-cnpj','cs-empresa','cs-detalhe'], 'Cliente sensível registrado!');
      document.getElementById('cs-demonstrou').value='';
      document.getElementById('cs-gravidade').value='';
      document.getElementById('cs-outro-wrap').hidden = true;
      Sensiveis.loadGrid();
    },

    async pesquisas() {
      if (!Util.requireFields([['ps-analista','Analista'],['ps-cliente','Cliente'],['ps-cnpj','CNPJ'],['ps-empresa','Empresa']])) return;
      await Forms._submit('pesquisas', {
        analista: Util.val('ps-analista'), cliente: Util.val('ps-cliente'),
        cnpj: Util.val('ps-cnpj'), empresa: Util.val('ps-empresa'),
        nps: Util.intVal('ps-nps'), csat: Util.intVal('ps-csat'), ces: Util.intVal('ps-ces'),
        pontos: Util.val('ps-pontos'),
      }, ['ps-analista','ps-cliente','ps-cnpj','ps-empresa','ps-pontos'], 'Pesquisa salva!');
      Util.clearRange([['ps-nps','ps-nps-v',5],['ps-csat','ps-csat-v',3],['ps-ces','ps-ces-v',3]]);
    },

    async recuperacao() {
      if (!Util.requireFields([['rc-analista','Analista'],['rc-cliente','Cliente'],['rc-cnpj','CNPJ'],['rc-empresa','Empresa'],['rc-demonstrou','Demonstração'],['rc-gravidade','Gravidade']])) return;
      await Forms._submit('recuperacoes', {
        analista: Util.val('rc-analista'), cliente: Util.val('rc-cliente'),
        cnpj: Util.val('rc-cnpj'), empresa: Util.val('rc-empresa'),
        demonstrou: Util.val('rc-demonstrou'), gravidade: Util.val('rc-gravidade'),
      }, ['rc-analista','rc-cliente','rc-cnpj','rc-empresa','rc-demonstrou'], 'Recuperação registrada!');
      document.getElementById('rc-gravidade').value='';
    },
  };

  // ── Admin ─────────────────────────────────────────────────────────────────
  let _editingUserId = null;
  const Admin = {
    async load() {
      const res = await API.get('/api/users');
      if (!res || !res.ok) return;
      const { users } = await res.json();
      document.getElementById('users-tbody').innerHTML = users.map(u => `
        <tr>
          <td style="color:var(--info)">${u.email}</td>
          <td>${u.name}</td>
          <td><span class="tag ${u.role==='administrador'?'tag-admin':'tag-user'}">${u.role==='administrador'?'Administrador':'Usuário'}</span></td>
          <td style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" onclick="App.Admin.openEditProfile('${u.id}','${u.name}','${u.email}')">Editar</button>
            <button class="btn btn-ghost btn-sm" onclick="App.Admin.openEditPass('${u.id}')">Senha</button>
            <button class="btn btn-danger btn-sm" onclick="App.Admin.deleteUser('${u.id}','${u.name}')">Excluir</button>
          </td>
        </tr>`).join('');
    },

    openAdd() {
      Modal.open('Adicionar usuário', `
        <div class="field"><label>Nome</label><input id="m-name" type="text" placeholder="Nome completo" /></div>
        <div class="field" style="margin-top:12px"><label>E-mail</label><input id="m-email" type="email" placeholder="email@dominio.com" /></div>
        <div class="field" style="margin-top:12px"><label>Senha</label><input id="m-pass" type="password" placeholder="Mín. 6 caracteres" /></div>
        <div class="field" style="margin-top:12px"><label>Perfil</label>
          <select id="m-role"><option value="usuario">Usuário</option><option value="administrador">Administrador</option></select>
        </div>`, Admin._confirmAdd);
    },

    async _confirmAdd() {
      const name=Util.val('m-name'), email=Util.val('m-email'), password=Util.val('m-pass'), role=document.getElementById('m-role')?.value;
      if (!name||!email||!password) { Toast.err('Preencha todos os campos.'); return; }
      const res  = await API.post('/api/users', { name, email, password, role });
      const data = await res.json();
      if (!res.ok) { Toast.err(data.error); return; }
      Modal.close(); Toast.ok('Usuário criado!'); Admin.load();
    },

    openEditPass(userId) {
      _editingUserId = userId;
      Modal.open('Editar senha', `<div class="field"><label>Nova senha</label><input id="m-newpass" type="password" placeholder="Mín. 6 caracteres" /></div>`, Admin._confirmEditPass);
    },

    async _confirmEditPass() {
      const password = Util.val('m-newpass');
      if (password.length < 6) { Toast.err('Mín. 6 caracteres.'); return; }
      const res = await API.patch(`/api/users/${_editingUserId}/password`, { password });
      if (res?.ok) { Modal.close(); Toast.ok('Senha atualizada!'); }
      else { const d = await res.json(); Toast.err(d.error); }
    },

    deleteUser(userId, name) {
      Modal.open(`Excluir usuário`, `<p style="color:var(--gray-600)">Excluir <strong>${name}</strong>? Esta ação não pode ser desfeita.</p>`,
        async () => {
          const res = await API.delete(`/api/users/${userId}`);
          if (res?.ok) { Modal.close(); Toast.ok('Usuário excluído.'); Admin.load(); }
          else { const d = await res?.json(); Toast.err(d?.error||'Erro.'); }
        });
    },
  };

  // ── Modal ─────────────────────────────────────────────────────────────────
  let _modalCallback = null;
  const Modal = {
    open(title, bodyHTML, onConfirm) {
      _modalCallback = onConfirm;
      document.getElementById('modal-title').textContent = title;
      document.getElementById('modal-body').innerHTML    = bodyHTML;
      document.getElementById('modal-confirm').onclick   = () => _modalCallback?.();
      document.getElementById('modal-backdrop').hidden   = false;
    },
    close() { document.getElementById('modal-backdrop').hidden = true; _modalCallback = null; },
  };

  // ── Token keep-alive ──────────────────────────────────────────────────────
  setInterval(async () => { if (currentUser) await Auth.refresh(); }, 90 * 60 * 1000);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !document.getElementById('form-login').hidden) Auth.login();
    if (e.key === 'Escape') Modal.close();
  });


  return { Auth, Nav, Dashboard, Forms, Admin, Modal, Util, Toast };
})();

// ── Wire all events after DOM ready (no inline onclick) ───────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Auth
  document.getElementById('btn-login').addEventListener('click', () => App.Auth.login());
  document.getElementById('btn-register').addEventListener('click', () => App.Auth.register());
  document.getElementById('btn-google').addEventListener('click', () => App.Auth.loginGoogle());
  document.getElementById('btn-show-register').addEventListener('click', () => App.Auth.showRegister());
  document.getElementById('btn-show-login').addEventListener('click', () => App.Auth.showLogin());
  document.getElementById('btn-logout').addEventListener('click', (e) => { e.preventDefault(); App.Auth.logout(); });
  document.getElementById('btn-logout-top').addEventListener('click', () => App.Auth.logout());

  // Nav items
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', (e) => { e.preventDefault(); App.Nav.go(el.dataset.page); });
  });

  // Dashboard
  document.getElementById('dash-period')?.addEventListener('change', () => App.Dashboard.load());
  document.getElementById('btn-clear-dash')?.addEventListener('click', () => App.Dashboard.clear());

  // Forms
  document.getElementById('btn-at-save')?.addEventListener('click', () => App.Forms.atendimento());
  document.getElementById('btn-gc-save')?.addEventListener('click', () => App.Forms.gestao());
  document.getElementById('btn-in-save')?.addEventListener('click', () => App.Forms.insatisfacao());
  document.getElementById('btn-cs-save')?.addEventListener('click', () => App.Forms.sensiveis());
  document.getElementById('btn-ps-save')?.addEventListener('click', () => App.Forms.pesquisas());
  document.getElementById('btn-rc-save')?.addEventListener('click', () => App.Forms.recuperacao());

  // CNPJ masks
  ['at-cnpj','gc-cnpj','in-cnpj','cs-cnpj','rc-cnpj'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', (e) => App.Util.maskCNPJ(e.target));
  });

  // Range sliders
  [['ps-nps','ps-nps-v'],['ps-csat','ps-csat-v'],['ps-ces','ps-ces-v']].forEach(([rId,vId]) => {
    document.getElementById(rId)?.addEventListener('input', () => App.Util.syncRange(rId, vId));
  });

  // Outro demanda
  document.getElementById('at-demanda')?.addEventListener('change', () => {
    App.Util.toggleOutro('at-demanda', 'at-outro-wrap');
  });

  // Clientes Sensíveis - Outro
  document.getElementById('cs-demonstrou')?.addEventListener('change', () => {
    App.Util.toggleOutro('cs-demonstrou', 'cs-outro-wrap');
  });

  // Admin
  document.getElementById('btn-add-user')?.addEventListener('click', () => App.Admin.openAdd());

  // Modal
  document.getElementById('modal-cancel')?.addEventListener('click', () => App.Modal.close());
  document.getElementById('modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-backdrop')) App.Modal.close();
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !document.getElementById('form-login').hidden) App.Auth.login();
    if (e.key === 'Escape') App.Modal.close();
  });

  // Auto login
  (async () => { await App.Auth.tryAutoLogin(); })();
});

// ── Grade de Pesquisas ────────────────────────────────────────────────────────
const PesquisasGrid = (() => {
  async function load() {
    const tbody = document.getElementById('ps-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';

    const headers = {};
    const token = localStorage.getItem('ge_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch('/api/data/pesquisas?period=todos', { headers });
    if (!res.ok) return;
    const { data } = await res.json();

    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--gray-400);padding:24px">Nenhuma resposta ainda.</td></tr>';
      return;
    }

    // Conta detratores não tratados
    const detratores = data.filter(r => r.nps <= 6 && !r.tratado);
    const alerta = document.getElementById('ps-alerta-baixo');
    const alertCount = document.getElementById('ps-alerta-count');
    if (alerta && detratores.length > 0) {
      alerta.style.display = 'block';
      alertCount.textContent = detratores.length;
    } else if (alerta) {
      alerta.style.display = 'none';
    }

    tbody.innerHTML = data.map(r => {
      const nps = r.nps;
      let rowStyle = '', badge = '', badgeStyle = '';
      if (nps <= 6) {
        rowStyle = 'background:#fff5f5';
        badge = 'Detrator';
        badgeStyle = 'background:#e53e3e;color:#fff';
      } else if (nps <= 8) {
        rowStyle = 'background:#fffff0';
        badge = 'Neutro';
        badgeStyle = 'background:#d69e2e;color:#fff';
      } else {
        rowStyle = 'background:#f0fff4';
        badge = 'Promotor';
        badgeStyle = 'background:#38a169;color:#fff';
      }
      const data_fmt = new Date(r.created_at).toLocaleDateString('pt-BR');
      const origem = r.origem === 'publico' ? '🌐 Link' : '📋 Interno';
      const status = r.tratado ? '<span style="color:#38a169;font-weight:600">✓ Tratado</span>' : '<span style="color:#e53e3e;font-weight:600">Pendente</span>';

      return '<tr style="' + rowStyle + '">' +
        '<td>' + data_fmt + '</td>' +
        '<td>' + (r.cliente || '') + '</td>' +
        '<td>' + (r.empresa || '') + '</td>' +
        '<td><strong>' + nps + '</strong> <span style="padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;' + badgeStyle + '">' + badge + '</span></td>' +
        '<td>' + (r.csat || '-') + '/5</td>' +
        '<td>' + (r.ces || '-') + '/5</td>' +
        '<td>' + origem + '</td>' +
        '<td>' + status + '</td>' +
        '<td><button class="btn btn-ghost btn-sm" onclick="PesquisasGrid.verDetalhes(\'' + r.id + '\')">Ver</button>' +
        (App.Auth.isAdmin() && !r.tratado ? ' <button class="btn btn-success btn-sm" onclick="PesquisasGrid.marcarTratado(\'' + r.id + '\')">Tratar</button>' : '') +
        '</td>' +
        '</tr>';
    }).join('');
  }

  async function verDetalhes(id) {
    const headers = {};
    const token = localStorage.getItem('ge_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch('/api/data/pesquisas?period=todos', { headers });
    if (!res.ok) return;
    const { data } = await res.json();
    const r = data.find(x => x.id === id);
    if (!r) return;

    App.Modal.open('Detalhes da Pesquisa',
      '<div style="font-size:13px;line-height:1.8">' +
      '<p><strong>Cliente:</strong> ' + (r.cliente || '-') + '</p>' +
      '<p><strong>Empresa:</strong> ' + (r.empresa || '-') + '</p>' +
      '<p><strong>Data:</strong> ' + new Date(r.created_at).toLocaleString('pt-BR') + '</p>' +
      '<p><strong>NPS:</strong> ' + r.nps + '/10</p>' +
      (r.motivo_nps ? '<p><strong>Motivo NPS:</strong> ' + r.motivo_nps + '</p>' : '') +
      '<p><strong>CSAT:</strong> ' + (r.csat || '-') + '/5</p>' +
      '<p><strong>CES:</strong> ' + (r.ces || '-') + '/5</p>' +
      (r.pontos ? '<p><strong>Comentário:</strong> ' + r.pontos + '</p>' : '') +
      '<p><strong>Origem:</strong> ' + (r.origem === 'publico' ? 'Link público' : 'Interno') + '</p>' +
      '</div>',
      function() { App.Modal.close(); }
    );
    document.getElementById('modal-confirm').textContent = 'Fechar';
  }

  async function marcarTratado(id) {
    const headers = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('ge_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch('/api/data/pesquisas/' + id + '/tratado', {
      method: 'PATCH', headers
    });
    if (res.ok) { App.Toast.ok('Marcado como tratado!'); load(); }
    else App.Toast.err('Erro ao atualizar.');
  }

  return { load, verDetalhes, marcarTratado };
})();

window.PesquisasGrid = PesquisasGrid;


// ── Módulo Pesquisas — grade de registros ─────────────────────────────────────
const Pesquisas = (() => {
  let _allData = [];  // cache de todas as respostas

  function _token() { return localStorage.getItem('ge_token') || ''; }

  function npsClass(nps) {
    if (nps <= 6) return 'background:#fff5f5';
    if (nps <= 8) return 'background:#fffff0';
    return 'background:#f0fff4';
  }
  function npsBadge(nps) {
    if (nps <= 6) return `<span style="background:#e53e3e;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">Detrator</span>`;
    if (nps <= 8) return `<span style="background:#d69e2e;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">Neutro</span>`;
    return `<span style="background:#38a169;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">Promotor</span>`;
  }
  function starStr(n) { return '★'.repeat(n) + '☆'.repeat(5-n); }

  function _populateYearFilter(data) {
    const sel = document.getElementById('ps-ano-filter');
    if (!sel) return;
    const anos = [...new Set(data.map(r => new Date(r.created_at).getFullYear()))].sort((a,b) => b-a);
    const current = sel.value;
    sel.innerHTML = '<option value="todos">Todos os anos</option>' +
      anos.map(a => `<option value="${a}" ${String(a) === current ? 'selected' : ''}>${a}</option>`).join('');
  }

  function _filterData(data) {
    const ano = document.getElementById('ps-ano-filter')?.value || 'todos';
    if (ano === 'todos') return data;
    return data.filter(r => new Date(r.created_at).getFullYear() === Number(ano));
  }

  function _renderGrid(data) {
    const tbody = document.getElementById('ps-tbody');
    if (!tbody) return;

    const baixos = data.filter(r => r.nps <= 6 && !r.tratado);
    const alertEl = document.getElementById('ps-alerta-baixo');
    const alertCount = document.getElementById('ps-alerta-count');
    if (alertEl) {
      alertEl.style.display = baixos.length > 0 ? 'block' : 'none';
      if (alertCount) alertCount.textContent = baixos.length;
    }

    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--gray-400);padding:24px">Nenhuma resposta registrada ainda</td></tr>';
      return;
    }

    tbody.innerHTML = data.map(r => {
      const d = new Date(r.created_at).toLocaleString('pt-BR');
      const origem = r.analista === 'Pesquisa Pública'
        ? '<span style="background:var(--g100);color:var(--g700);padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">🔗 Link público</span>'
        : '<span style="background:var(--gray-100);color:var(--gray-500);padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">✏️ Manual</span>';
      const statusBadge = r.tratado
        ? '<span style="background:#f0fff4;color:#38a169;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">✔ Tratado</span>'
        : '<span style="background:#fff5f5;color:#e53e3e;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">Pendente</span>';
      const tratarBtn = App.Auth.isAdmin() && !r.tratado
        ? ` <button class="btn btn-success btn-sm" onclick="PesquisasGrid.marcarTratado(\'${r.id}\')">Tratar</button>`
        : '';
      return `<tr style="${npsClass(r.nps)}">
        <td style="font-size:12px;color:var(--gray-500)">${d}</td>
        <td style="font-weight:600">${r.cliente}</td>
        <td>${r.empresa}</td>
        <td style="text-align:center"><span style="font-size:18px;font-weight:800;color:${r.nps<=6?'#e53e3e':r.nps<=8?'#d69e2e':'#38a169'}">${r.nps}</span><br/>${npsBadge(r.nps)}</td>
        <td style="text-align:center;font-size:16px;color:#f5c518">${starStr(r.csat)}</td>
        <td style="text-align:center;font-size:16px;color:#f5c518">${starStr(r.ces)}</td>
        <td>${origem}</td>
        <td>${statusBadge}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="Pesquisas.detail(${JSON.stringify(r).replace(/"/g,'&quot;')})">Ver</button>${tratarBtn}</td>
      </tr>`;
    }).join('');
  }

  async function loadGrid() {
    const tbody = document.getElementById('ps-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';

    const res = await fetch('/api/data/pesquisas?period=todos', {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!res || !res.ok) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#e53e3e;padding:24px">Erro ao carregar respostas.</td></tr>';
      return;
    }
    const { data } = await res.json();
    _allData = data || [];
    _populateYearFilter(_allData);
    _renderGrid(_filterData(_allData));
  }

  async function exportCSV() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar no período selecionado.'); return; }
    const cols = ['created_at','analista','cliente','cnpj','empresa','nps','csat','ces','pontos'];
    const labels = { created_at:'Data', analista:'Analista', cliente:'Cliente', cnpj:'CNPJ',
      empresa:'Empresa', nps:'NPS', csat:'CSAT', ces:'CES', pontos:'Pontos Destacados' };
    const header = cols.map(c => labels[c]).join(';');
    const rows = data.map(r => cols.map(c => {
      let v = r[c] ?? '';
      if (c === 'created_at') v = new Date(v).toLocaleString('pt-BR');
      return `"${String(v).replace(/"/g,'""')}"`;
    }).join(';'));
    const csv = [header, ...rows].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ano = document.getElementById('ps-ano-filter')?.value || 'todos';
    a.href = url; a.download = `pesquisas_${ano}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    App.Toast.ok('CSV exportado!');
  }

  async function exportPDF() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar no período selecionado.'); return; }
    const cols = ['created_at','cliente','empresa','nps','csat','ces','pontos'];
    const labels = { created_at:'Data', cliente:'Cliente', empresa:'Empresa',
      nps:'NPS', csat:'CSAT', ces:'CES', pontos:'Pontos Destacados' };
    const ano = document.getElementById('ps-ano-filter')?.value || 'todos';
    const titulo = ano === 'todos' ? 'Pesquisas de Satisfação — Todos os anos' : `Pesquisas de Satisfação — ${ano}`;
    const rows = data.map(r =>
      `<tr>${cols.map(c => {
        let v = r[c] ?? '—';
        if (c === 'created_at') v = new Date(v).toLocaleString('pt-BR');
        return `<td>${v}</td>`;
      }).join('')}</tr>`
    ).join('');
    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
    <title>${titulo}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#222}
      h1{font-size:15px;color:#1a4233;margin-bottom:4px}
      p.sub{color:#666;font-size:11px;margin-bottom:12px}
      table{width:100%;border-collapse:collapse;font-size:10px}
      th{background:#1a4233;color:#fff;padding:6px 8px;text-align:left}
      td{padding:5px 8px;border-bottom:1px solid #eee}
      tr:nth-child(even) td{background:#f8f8f8}
      @media print{body{margin:10px}}
    </style></head><body>
    <h1>Grupo-E — ${titulo}</h1>
    <p class="sub">Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${data.length} registros</p>
    <table><thead><tr>${cols.map(c=>`<th>${labels[c]}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody></table>
    <script>window.onload=()=>{window.print();}<\/script>
    </body></html>`;
    const win = window.open('', '_blank');
    if (!win) { App.Toast.err('Permita popups para exportar PDF.'); return; }
    win.document.write(html);
    win.document.close();
    App.Toast.ok('PDF gerado — use Ctrl+P para salvar!');
  }

  async function limpar() {
    if (!App.Auth.isAdmin()) { App.Toast.err('Acesso restrito a administradores.'); return; }
    const total = _allData.length;
    if (!total) { App.Toast.err('Não há respostas para limpar.'); return; }

    const confirmado = await new Promise(resolve => {
      App.Modal.open(
        '⚠️ Confirmar limpeza',
        `<div style="text-align:center;padding:10px 0">
          <p style="font-size:15px;margin-bottom:8px">Você está prestes a <strong>excluir permanentemente</strong></p>
          <p style="font-size:28px;font-weight:800;color:#e53e3e;margin:12px 0">${total} resposta${total !== 1 ? 's' : ''}</p>
          <p style="color:var(--gray-500);font-size:13px">Esta ação não pode ser desfeita.</p>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
            <button class="btn btn-ghost" onclick="App.Modal.close()">Cancelar</button>
            <button class="btn" style="background:#e53e3e;color:#fff;border:none"
              onclick="document.dispatchEvent(new CustomEvent('ps-confirm-limpar'))">
              Sim, limpar tudo
            </button>
          </div>
        </div>`,
        () => resolve(false)
      );
      document.addEventListener('ps-confirm-limpar', () => { App.Modal.close(); resolve(true); }, { once: true });
    });

    if (!confirmado) return;

    const res = await fetch('/api/data/pesquisas/clear', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (res && res.ok) {
      _allData = [];
      _renderGrid([]);
      _populateYearFilter([]);
      App.Toast.ok('Todas as respostas foram removidas.');
    } else {
      App.Toast.err('Erro ao limpar respostas. Tente novamente.');
    }
  }

  function detail(r) {
    const d = new Date(r.created_at).toLocaleString('pt-BR');
    App.Modal.open(`Pesquisa — ${r.cliente}`, `
      <div style="display:grid;gap:10px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div><strong>Data:</strong><br/><span style="color:var(--gray-500)">${d}</span></div>
          <div><strong>Empresa:</strong><br/><span style="color:var(--gray-500)">${r.empresa}</span></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;background:var(--gray-50);padding:14px;border-radius:8px">
          <div style="text-align:center"><div style="font-size:28px;font-weight:800;color:${r.nps<=6?'#e53e3e':r.nps<=8?'#d69e2e':'#38a169'}">${r.nps}</div><div style="font-size:11px;color:var(--gray-400)">NPS (0-10)</div></div>
          <div style="text-align:center"><div style="font-size:22px;color:#f5c518">${'★'.repeat(r.csat)}${'☆'.repeat(5-r.csat)}</div><div style="font-size:11px;color:var(--gray-400)">CSAT</div></div>
          <div style="text-align:center"><div style="font-size:22px;color:#f5c518">${'★'.repeat(r.ces)}${'☆'.repeat(5-r.ces)}</div><div style="font-size:11px;color:var(--gray-400)">CES</div></div>
        </div>
        ${r.pontos ? `<div><strong>Comentários:</strong><br/><span style="color:var(--gray-600)">${r.pontos}</span></div>` : ''}
      </div>
    `, () => App.Modal.close());
  }

  return { loadGrid, exportCSV, exportPDF, limpar, detail };
})();

// Expor globalmente
window.Pesquisas = Pesquisas;

// ── Módulo Insatisfação — grade de registros ─────────────────────────────────
const Insatisfacao = (() => {
  let _allData = [];
  function _token() { return localStorage.getItem('ge_token') || ''; }

  function _gravBadge(g) {
    const map = {
      'Muito Alta': '#e53e3e', 'Alta': '#dd6b20',
      'Média': '#d69e2e', 'Baixa': '#38a169', 'Muito Baixa': '#2b6cb0'
    };
    const color = map[g] || '#718096';
    return `<span style="background:${color}20;color:${color};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${g}</span>`;
  }

  function _populateYearFilter(data) {
    const sel = document.getElementById('in-ano-filter');
    if (!sel) return;
    const anos = [...new Set(data.map(r => new Date(r.created_at).getFullYear()))].sort((a,b) => b-a);
    const current = sel.value;
    sel.innerHTML = '<option value="todos">Todos os anos</option>' +
      anos.map(a => `<option value="${a}" ${String(a) === current ? 'selected' : ''}>${a}</option>`).join('');
  }

  function _filterData(data) {
    const ano = document.getElementById('in-ano-filter')?.value || 'todos';
    if (ano === 'todos') return data;
    return data.filter(r => new Date(r.created_at).getFullYear() === Number(ano));
  }

  function _renderGrid(data) {
    const tbody = document.getElementById('in-tbody');
    if (!tbody) return;
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--gray-400);padding:24px">Nenhum registro encontrado.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(r => {
      const d = new Date(r.created_at).toLocaleString('pt-BR');
      return `<tr>
        <td style="font-size:12px;color:var(--gray-500)">${d}</td>
        <td>${r.analista}</td>
        <td style="font-weight:600">${r.cliente}</td>
        <td style="font-size:12px">${r.cnpj || '—'}</td>
        <td>${r.empresa}</td>
        <td>${r.reclamado || '—'}</td>
        <td>${_gravBadge(r.gravidade)}</td>
        <td style="font-size:12px;color:var(--gray-500);max-width:200px;word-break:break-word">${r.reclamacao}</td>
      </tr>`;
    }).join('');
  }

  async function loadGrid() {
    const tbody = document.getElementById('in-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';
    const res = await fetch('/api/data/insatisfacoes?period=todos', {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!res || !res.ok) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#e53e3e;padding:24px">Erro ao carregar registros.</td></tr>';
      return;
    }
    const { data } = await res.json();
    _allData = data || [];
    _populateYearFilter(_allData);
    _renderGrid(_filterData(_allData));
  }

  function exportCSV() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at','analista','cliente','cnpj','empresa','reclamado','gravidade','reclamacao'];
    const labels = { created_at:'Data', analista:'Analista', cliente:'Cliente', cnpj:'CNPJ',
      empresa:'Empresa', reclamado:'Reclamado', gravidade:'Gravidade', reclamacao:'Reclamação' };
    const header = cols.map(c => labels[c]).join(';');
    const rows = data.map(r => cols.map(c => {
      let v = r[c] ?? '';
      if (c === 'created_at') v = new Date(v).toLocaleString('pt-BR');
      return `"${String(v).replace(/"/g,'""')}"`;
    }).join(';'));
    const csv = [header, ...rows].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ano = document.getElementById('in-ano-filter')?.value || 'todos';
    a.href = url; a.download = `insatisfacoes_${ano}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    App.Toast.ok('CSV exportado!');
  }

  function exportPDF() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at','analista','cliente','empresa','reclamado','gravidade','reclamacao'];
    const labels = { created_at:'Data', analista:'Analista', cliente:'Cliente',
      empresa:'Empresa', reclamado:'Reclamado', gravidade:'Gravidade', reclamacao:'Reclamação' };
    const ano = document.getElementById('in-ano-filter')?.value || 'todos';
    const titulo = ano === 'todos' ? 'Insatisfação — Todos os anos' : `Insatisfação — ${ano}`;
    const rows = data.map(r =>
      `<tr>${cols.map(c => {
        let v = r[c] ?? '—';
        if (c === 'created_at') v = new Date(v).toLocaleString('pt-BR');
        return `<td>${v}</td>`;
      }).join('')}</tr>`
    ).join('');
    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
    <title>${titulo}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#222}
      h1{font-size:15px;color:#1a4233;margin-bottom:4px}
      p.sub{color:#666;font-size:11px;margin-bottom:12px}
      table{width:100%;border-collapse:collapse;font-size:10px}
      th{background:#1a4233;color:#fff;padding:6px 8px;text-align:left}
      td{padding:5px 8px;border-bottom:1px solid #eee}
      tr:nth-child(even) td{background:#f8f8f8}
      @media print{body{margin:10px}}
    </style></head><body>
    <h1>Grupo-E — ${titulo}</h1>
    <p class="sub">Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${data.length} registros</p>
    <table><thead><tr>${cols.map(c=>`<th>${labels[c]}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody></table>
    <script>window.onload=()=>{window.print();}<\/script>
    </body></html>`;
    const win = window.open('', '_blank');
    if (!win) { App.Toast.err('Permita popups para exportar PDF.'); return; }
    win.document.write(html); win.document.close();
    App.Toast.ok('PDF gerado — use Ctrl+P para salvar!');
  }

  async function limpar() {
    if (!App.Auth.isAdmin()) { App.Toast.err('Acesso restrito a administradores.'); return; }
    const total = _allData.length;
    if (!total) { App.Toast.err('Não há registros para limpar.'); return; }
    const confirmado = await new Promise(resolve => {
      App.Modal.open('⚠️ Confirmar limpeza',
        `<div style="text-align:center;padding:10px 0">
          <p style="font-size:15px;margin-bottom:8px">Você está prestes a <strong>excluir permanentemente</strong></p>
          <p style="font-size:28px;font-weight:800;color:#e53e3e;margin:12px 0">${total} registro${total !== 1 ? 's' : ''}</p>
          <p style="color:var(--gray-500);font-size:13px">Esta ação não pode ser desfeita.</p>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
            <button class="btn btn-ghost" onclick="App.Modal.close()">Cancelar</button>
            <button class="btn" style="background:#e53e3e;color:#fff;border:none"
              onclick="document.dispatchEvent(new CustomEvent('in-confirm-limpar'))">Sim, limpar tudo</button>
          </div>
        </div>`, () => resolve(false));
      document.addEventListener('in-confirm-limpar', () => { App.Modal.close(); resolve(true); }, { once: true });
    });
    if (!confirmado) return;
    const res = await fetch('/api/data/insatisfacoes/clear', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (res && res.ok) {
      _allData = []; _renderGrid([]); _populateYearFilter([]);
      App.Toast.ok('Todos os registros foram removidos.');
    } else {
      App.Toast.err('Erro ao limpar registros.');
    }
  }

  return { loadGrid, exportCSV, exportPDF, limpar };
})();

window.Insatisfacao = Insatisfacao;

// ── Módulo Clientes Sensíveis — grade de registros ────────────────────────────
const Sensiveis = (() => {
  let _allData = [];
  function _token() { return localStorage.getItem('ge_token') || ''; }

  function _gravBadge(g) {
    const map = {
      'Muito Alta': '#e53e3e', 'Alta': '#dd6b20',
      'Média': '#d69e2e', 'Baixa': '#38a169', 'Muito Baixa': '#2b6cb0'
    };
    const color = map[g] || '#718096';
    return `<span style="background:${color}20;color:${color};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${g}</span>`;
  }

  function _populateYearFilter(data) {
    const sel = document.getElementById('cs-ano-filter');
    if (!sel) return;
    const anos = [...new Set(data.map(r => new Date(r.created_at).getFullYear()))].sort((a,b) => b-a);
    const current = sel.value;
    sel.innerHTML = '<option value="todos">Todos os anos</option>' +
      anos.map(a => `<option value="${a}" ${String(a) === current ? 'selected' : ''}>${a}</option>`).join('');
  }

  function _filterData(data) {
    const ano = document.getElementById('cs-ano-filter')?.value || 'todos';
    if (ano === 'todos') return data;
    return data.filter(r => new Date(r.created_at).getFullYear() === Number(ano));
  }

  function _renderGrid(data) {
    const tbody = document.getElementById('cs-tbody');
    if (!tbody) return;
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--gray-400);padding:24px">Nenhum registro encontrado.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(r => {
      const d = new Date(r.created_at).toLocaleString('pt-BR');
      return `<tr>
        <td style="font-size:12px;color:var(--gray-500)">${d}</td>
        <td>${r.analista}</td>
        <td style="font-weight:600">${r.cliente}</td>
        <td style="font-size:12px">${r.cnpj || '—'}</td>
        <td>${r.empresa}</td>
        <td>${r.demonstrou}</td>
        <td>${_gravBadge(r.gravidade)}</td>
        <td style="font-size:12px;color:var(--gray-500);max-width:200px;word-break:break-word">${r.detalhe || '—'}</td>
      </tr>`;
    }).join('');
  }

  async function loadGrid() {
    const tbody = document.getElementById('cs-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';
    const res = await fetch('/api/data/sensiveis?period=todos', {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!res || !res.ok) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#e53e3e;padding:24px">Erro ao carregar registros.</td></tr>';
      return;
    }
    const { data } = await res.json();
    _allData = data || [];
    _populateYearFilter(_allData);
    _renderGrid(_filterData(_allData));
  }

  function exportCSV() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at','analista','cliente','cnpj','empresa','demonstrou','gravidade','detalhe'];
    const labels = { created_at:'Data', analista:'Analista', cliente:'Cliente', cnpj:'CNPJ',
      empresa:'Empresa', demonstrou:'Demonstrou', gravidade:'Gravidade', detalhe:'Detalhe' };
    const header = cols.map(c => labels[c]).join(';');
    const rows = data.map(r => cols.map(c => {
      let v = r[c] ?? '';
      if (c === 'created_at') v = new Date(v).toLocaleString('pt-BR');
      return `"${String(v).replace(/"/g,'""')}"`;
    }).join(';'));
    const csv = [header, ...rows].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ano = document.getElementById('cs-ano-filter')?.value || 'todos';
    a.href = url; a.download = `clientes_sensiveis_${ano}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    App.Toast.ok('CSV exportado!');
  }

  function exportPDF() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at','analista','cliente','empresa','demonstrou','gravidade','detalhe'];
    const labels = { created_at:'Data', analista:'Analista', cliente:'Cliente',
      empresa:'Empresa', demonstrou:'Demonstrou', gravidade:'Gravidade', detalhe:'Detalhe' };
    const ano = document.getElementById('cs-ano-filter')?.value || 'todos';
    const titulo = ano === 'todos' ? 'Clientes Sensíveis — Todos os anos' : `Clientes Sensíveis — ${ano}`;
    const rows = data.map(r =>
      `<tr>${cols.map(c => {
        let v = r[c] ?? '—';
        if (c === 'created_at') v = new Date(v).toLocaleString('pt-BR');
        return `<td>${v}</td>`;
      }).join('')}</tr>`
    ).join('');
    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
    <title>${titulo}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#222}
      h1{font-size:15px;color:#1a4233;margin-bottom:4px}
      p.sub{color:#666;font-size:11px;margin-bottom:12px}
      table{width:100%;border-collapse:collapse;font-size:10px}
      th{background:#1a4233;color:#fff;padding:6px 8px;text-align:left}
      td{padding:5px 8px;border-bottom:1px solid #eee}
      tr:nth-child(even) td{background:#f8f8f8}
      @media print{body{margin:10px}}
    </style></head><body>
    <h1>Grupo-E — ${titulo}</h1>
    <p class="sub">Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${data.length} registros</p>
    <table><thead><tr>${cols.map(c=>`<th>${labels[c]}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody></table>
    <script>window.onload=()=>{window.print();}<\/script>
    </body></html>`;
    const win = window.open('', '_blank');
    if (!win) { App.Toast.err('Permita popups para exportar PDF.'); return; }
    win.document.write(html); win.document.close();
    App.Toast.ok('PDF gerado — use Ctrl+P para salvar!');
  }

  async function limpar() {
    if (!App.Auth.isAdmin()) { App.Toast.err('Acesso restrito a administradores.'); return; }
    const total = _allData.length;
    if (!total) { App.Toast.err('Não há registros para limpar.'); return; }
    const confirmado = await new Promise(resolve => {
      App.Modal.open('⚠️ Confirmar limpeza',
        `<div style="text-align:center;padding:10px 0">
          <p style="font-size:15px;margin-bottom:8px">Você está prestes a <strong>excluir permanentemente</strong></p>
          <p style="font-size:28px;font-weight:800;color:#e53e3e;margin:12px 0">${total} registro${total !== 1 ? 's' : ''}</p>
          <p style="color:var(--gray-500);font-size:13px">Esta ação não pode ser desfeita.</p>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
            <button class="btn btn-ghost" onclick="App.Modal.close()">Cancelar</button>
            <button class="btn" style="background:#e53e3e;color:#fff;border:none"
              onclick="document.dispatchEvent(new CustomEvent('cs-confirm-limpar'))">Sim, limpar tudo</button>
          </div>
        </div>`, () => resolve(false));
      document.addEventListener('cs-confirm-limpar', () => { App.Modal.close(); resolve(true); }, { once: true });
    });
    if (!confirmado) return;
    const res = await fetch('/api/data/sensiveis/clear', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (res && res.ok) {
      _allData = []; _renderGrid([]); _populateYearFilter([]);
      App.Toast.ok('Todos os registros foram removidos.');
    } else {
      App.Toast.err('Erro ao limpar registros.');
    }
  }

  return { loadGrid, exportCSV, exportPDF, limpar };
})();

window.Sensiveis = Sensiveis;




// ── Exportação de Relatórios ───────────────────────────────────────────────────
const Reports = {
  // Mapeamento de colunas por módulo
  _cols: {
    atendimentos: ['created_at','analista','cliente','cnpj','empresa','departamento','procurado','demanda','resumo'],
    gestao:       ['created_at','analista','solicitacao','cnpj','empresa','data_sol','competencia','canal','motivo'],
    insatisfacoes:['created_at','analista','cliente','cnpj','empresa','reclamado','reclamacao','gravidade'],
    sensiveis:    ['created_at','analista','cliente','cnpj','empresa','demonstrou','gravidade','detalhe'],
    pesquisas:    ['created_at','analista','cliente','cnpj','empresa','nps','csat','ces','pontos'],
    recuperacoes: ['created_at','analista','cliente','cnpj','empresa','demonstrou','gravidade'],
  },
  _labels: {
    created_at:'Data', analista:'Analista', cliente:'Cliente', cnpj:'CNPJ',
    empresa:'Empresa', departamento:'Departamento', procurado:'Analista Procurado',
    demanda:'Demanda', resumo:'Resumo', solicitacao:'Solicitação', data_sol:'Data Solicitação',
    competencia:'Competência', canal:'Canal', motivo:'Motivo', reclamado:'Analista Reclamado',
    reclamacao:'Reclamação', gravidade:'Gravidade', demonstrou:'Demonstração',
    nps:'NPS', csat:'CSAT', ces:'CES', pontos:'Pontos Destacados', detalhe:'Detalhe',
  },

  async exportCSV(endpoint) {
    const period = document.getElementById('dash-period')?.value || 'todos';
    const res = await API.get(`/api/data/${endpoint}?period=${period}`);
    if (!res || !res.ok) { Toast.err('Erro ao buscar dados.'); return; }
    const { data } = await res.json();
    if (!data.length) { Toast.err('Nenhum dado para exportar.'); return; }

    const cols = Reports._cols[endpoint] || Object.keys(data[0]);
    const labels = cols.map(c => Reports._labels[c] || c);
    const rows = data.map(r => cols.map(c => {
      let v = r[c] ?? '';
      if (c === 'created_at') v = new Date(v).toLocaleString('pt-BR');
      return `"${String(v).replace(/"/g,'""')}"`;
    }));

    const csv = [labels.join(';'), ...rows.map(r => r.join(';'))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${endpoint}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    Toast.ok('CSV exportado!');
  },

  async exportPDF(endpoint, title) {
    const period = document.getElementById('dash-period')?.value || 'todos';
    const res = await API.get(`/api/data/${endpoint}?period=${period}`);
    if (!res || !res.ok) { Toast.err('Erro ao buscar dados.'); return; }
    const { data } = await res.json();
    if (!data.length) { Toast.err('Nenhum dado para exportar.'); return; }

    const cols   = Reports._cols[endpoint] || Object.keys(data[0]);
    const labels = cols.map(c => Reports._labels[c] || c);

    // Build HTML for print
    const rows = data.map(r =>
      `<tr>${cols.map(c => {
        let v = r[c] ?? '';
        if (c === 'created_at') v = new Date(v).toLocaleString('pt-BR');
        return `<td>${v}</td>`;
      }).join('')}</tr>`
    ).join('');

    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
    <title>${title}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#222}
      h1{font-size:16px;color:#1a4233;margin-bottom:4px}
      p.sub{color:#666;font-size:11px;margin-bottom:12px}
      table{width:100%;border-collapse:collapse;font-size:10px}
      th{background:#1a4233;color:#fff;padding:6px 8px;text-align:left;font-size:10px}
      td{padding:5px 8px;border-bottom:1px solid #eee}
      tr:nth-child(even) td{background:#f8f8f8}
      @media print{body{margin:10px}}
    </style></head><body>
    <h1>Grupo-E — ${title}</h1>
    <p class="sub">Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${data.length} registros</p>
    <table><thead><tr>${labels.map(l=>`<th>${l}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody></table>
    <script>window.onload=()=>{window.print();}<\/script>
    </body></html>`;

    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
    Toast.ok('PDF gerado — use Ctrl+P para salvar!');
  },
};

// Expor Reports globalmente
window.App = window.App || {};
Object.assign(window.App, { Reports });
