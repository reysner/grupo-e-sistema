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
      document.getElementById(wrapId).hidden = document.getElementById(selId).value !== 'Outro';
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

    tryAutoLogin() {
      Store.load();
      if (_accessToken && currentUser) {
        Auth.onLoggedIn(currentUser);
        return true;
      }
      return false;
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
    },

    async sensiveis() {
      if (!Util.requireFields([['cs-analista','Analista'],['cs-cliente','Cliente'],['cs-cnpj','CNPJ'],['cs-empresa','Empresa'],['cs-demonstrou','O que demonstrou'],['cs-gravidade','Gravidade']])) return;
      await Forms._submit('sensiveis', {
        analista: Util.val('cs-analista'), cliente: Util.val('cs-cliente'),
        cnpj: Util.val('cs-cnpj'), empresa: Util.val('cs-empresa'),
        demonstrou: Util.val('cs-demonstrou')==='Outro' ? Util.val('cs-outro') : Util.val('cs-demonstrou'), gravidade: Util.val('cs-gravidade'),
      }, ['cs-analista','cs-cliente','cs-cnpj','cs-empresa'], 'Cliente sensível registrado!');
      document.getElementById('cs-demonstrou').value=''; document.getElementById('cs-gravidade').value='';
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
  document.getElementById('dash-period').addEventListener('change', () => App.Dashboard.load());
  document.getElementById('btn-clear-dash').addEventListener('click', () => App.Dashboard.clear());

  // Forms
  document.getElementById('btn-at-save').addEventListener('click', () => App.Forms.atendimento());
  document.getElementById('btn-gc-save').addEventListener('click', () => App.Forms.gestao());
  document.getElementById('btn-in-save').addEventListener('click', () => App.Forms.insatisfacao());
  document.getElementById('btn-cs-save').addEventListener('click', () => App.Forms.sensiveis());
  document.getElementById('btn-ps-save').addEventListener('click', () => App.Forms.pesquisas());
  document.getElementById('btn-rc-save').addEventListener('click', () => App.Forms.recuperacao());

  // CNPJ masks
  ['at-cnpj','gc-cnpj','in-cnpj','cs-cnpj','ps-cnpj','rc-cnpj'].forEach(id => {
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
  document.getElementById('modal-cancel').addEventListener('click', () => App.Modal.close());
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-backdrop')) App.Modal.close();
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !document.getElementById('form-login').hidden) App.Auth.login();
    if (e.key === 'Escape') App.Modal.close();
  });

  // Auto login
  App.Auth.tryAutoLogin();
});

// ── Exportação de Relatórios ──────────────────────────────────────────────────
App.Reports = (() => {
  const _cols = {
    atendimentos: ['created_at','analista','cliente','cnpj','empresa','departamento','procurado','demanda','resumo'],
    gestao:       ['created_at','analista','solicitacao','cnpj','empresa','data_sol','competencia','canal','motivo'],
    insatisfacoes:['created_at','analista','cliente','cnpj','empresa','reclamado','reclamacao','gravidade'],
    sensiveis:    ['created_at','analista','cliente','cnpj','empresa','demonstrou','gravidade'],
    pesquisas:    ['created_at','analista','cliente','cnpj','empresa','nps','csat','ces','pontos'],
    recuperacoes: ['created_at','analista','cliente','cnpj','empresa','demonstrou','gravidade'],
  };
  const _labels = {
    created_at:'Data', analista:'Analista Responsável', cliente:'Cliente', cnpj:'CNPJ',
    empresa:'Empresa', departamento:'Departamento', procurado:'Analista Procurado',
    demanda:'Demanda', resumo:'Resumo', solicitacao:'Solicitação', data_sol:'Data Solicitação',
    competencia:'Fim Competência', canal:'Canal', motivo:'Motivo', reclamado:'Analista Reclamado',
    reclamacao:'Reclamação', gravidade:'Gravidade', demonstrou:'Demonstração',
    nps:'NPS (0-10)', csat:'CSAT (0-5)', ces:'CES (0-5)', pontos:'Pontos Destacados',
  };

  async function fetchData(endpoint) {
    const period = document.getElementById('dash-period')?.value || 'todos';
    const headers = {};
    const token = localStorage.getItem('ge_token');
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`/api/data/${endpoint}?period=${period}`, { headers });
    if (!res.ok) return null;
    const { data } = await res.json();
    return data;
  }

  async function exportCSV(endpoint) {
    const data = await fetchData(endpoint);
    if (!data) { App.Toast.err('Erro ao buscar dados.'); return; }
    if (!data.length) { App.Toast.err('Nenhum dado para exportar no período selecionado.'); return; }

    const cols   = _cols[endpoint] || Object.keys(data[0]);
    const labels = cols.map(c => _labels[c] || c);
    const rows   = data.map(r => cols.map(c => {
      let v = r[c] ?? '';
      if (c === 'created_at') v = new Date(v).toLocaleString('pt-BR');
      return `"${String(v).replace(/"/g, '""')}"`;
    }));

    const csv  = [labels.join(';'), ...rows.map(r => r.join(';'))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${endpoint}_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    App.Toast.ok('CSV exportado com sucesso!');
  }

  async function exportPDF(endpoint, title) {
    const data = await fetchData(endpoint);
    if (!data) { App.Toast.err('Erro ao buscar dados.'); return; }
    if (!data.length) { App.Toast.err('Nenhum dado para exportar no período selecionado.'); return; }

    const cols   = _cols[endpoint] || Object.keys(data[0]);
    const labels = cols.map(c => _labels[c] || c);
    const rows   = data.map(r =>
      `<tr>${cols.map(c => {
        let v = r[c] ?? '';
        if (c === 'created_at') v = new Date(v).toLocaleString('pt-BR');
        return `<td>${String(v).replace(/</g,'&lt;').replace(/>/g,'&gt;')}</td>`;
      }).join('')}</tr>`
    ).join('');

    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>Grupo-E — ${title}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:10px;margin:20px;color:#222}
  h1{font-size:15px;color:#1a4233;margin-bottom:2px}
  .sub{color:#666;font-size:10px;margin-bottom:14px}
  table{width:100%;border-collapse:collapse}
  th{background:#1a4233;color:#fff;padding:6px 8px;text-align:left;font-size:9px;white-space:nowrap}
  td{padding:5px 8px;border-bottom:1px solid #e8e8e8;vertical-align:top;word-break:break-word}
  tr:nth-child(even) td{background:#f7f7f7}
  @page{margin:15mm}
  @media print{body{margin:0}}
</style></head><body>
<h1>Grupo-E Soluções Empresariais — ${title}</h1>
<div class="sub">Gerado em: ${new Date().toLocaleString('pt-BR')} &nbsp;|&nbsp; Total de registros: ${data.length}</div>
<table>
  <thead><tr>${labels.map(l => `<th>${l}</th>`).join('')}</tr></thead>
  <tbody>${rows}</tbody>
</table>
<script>window.onload = () => { window.print(); }<\/script>
</body></html>`;

    const win = window.open('', '_blank');
    if (!win) { App.Toast.err('Permita popups para exportar PDF.'); return; }
    win.document.write(html);
    win.document.close();
    App.Toast.ok('PDF aberto — use Ctrl+P para salvar como PDF!');
  }

  return { exportCSV, exportPDF };
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
  document.getElementById('dash-period').addEventListener('change', () => App.Dashboard.load());
  document.getElementById('btn-clear-dash').addEventListener('click', () => App.Dashboard.clear());

  // Forms
  document.getElementById('btn-at-save').addEventListener('click', () => App.Forms.atendimento());
  document.getElementById('btn-gc-save').addEventListener('click', () => App.Forms.gestao());
  document.getElementById('btn-in-save').addEventListener('click', () => App.Forms.insatisfacao());
  document.getElementById('btn-cs-save').addEventListener('click', () => App.Forms.sensiveis());
  document.getElementById('btn-ps-save').addEventListener('click', () => App.Forms.pesquisas());
  document.getElementById('btn-rc-save').addEventListener('click', () => App.Forms.recuperacao());

  // CNPJ masks
  ['at-cnpj','gc-cnpj','in-cnpj','cs-cnpj','ps-cnpj','rc-cnpj'].forEach(id => {
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
  document.getElementById('modal-cancel').addEventListener('click', () => App.Modal.close());
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-backdrop')) App.Modal.close();
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !document.getElementById('form-login').hidden) App.Auth.login();
    if (e.key === 'Escape') App.Modal.close();
  });

  // Auto login
  App.Auth.tryAutoLogin();
});

// ── Exportação de Relatórios ───────────────────────────────────────────────────
const Reports = {
  // Mapeamento de colunas por módulo
  _cols: {
    atendimentos: ['created_at','analista','cliente','cnpj','empresa','departamento','procurado','demanda','resumo'],
    gestao:       ['created_at','analista','solicitacao','cnpj','empresa','data_sol','competencia','canal','motivo'],
    insatisfacoes:['created_at','analista','cliente','cnpj','empresa','reclamado','reclamacao','gravidade'],
    sensiveis:    ['created_at','analista','cliente','cnpj','empresa','demonstrou','gravidade'],
    pesquisas:    ['created_at','analista','cliente','cnpj','empresa','nps','csat','ces','pontos'],
    recuperacoes: ['created_at','analista','cliente','cnpj','empresa','demonstrou','gravidade'],
  },
  _labels: {
    created_at:'Data', analista:'Analista', cliente:'Cliente', cnpj:'CNPJ',
    empresa:'Empresa', departamento:'Departamento', procurado:'Analista Procurado',
    demanda:'Demanda', resumo:'Resumo', solicitacao:'Solicitação', data_sol:'Data Solicitação',
    competencia:'Competência', canal:'Canal', motivo:'Motivo', reclamado:'Analista Reclamado',
    reclamacao:'Reclamação', gravidade:'Gravidade', demonstrou:'Demonstração',
    nps:'NPS', csat:'CSAT', ces:'CES', pontos:'Pontos Destacados',
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
