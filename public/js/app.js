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
    paginate(data, page, perPage=25) {
      const total = data.length;
      const pages = Math.ceil(total / perPage) || 1;
      const p = Math.min(Math.max(1, page), pages);
      return { items: data.slice((p-1)*perPage, p*perPage), page: p, pages, total, perPage };
    },
    renderPagination(containerId, page, pages, total, onGoFn) {
      const el = document.getElementById(containerId);
      if (!el) return;
      if (pages <= 1) { el.innerHTML = ''; return; }
      const btn = (active, label, p) =>
        `<button onclick="${onGoFn}(${p})" style="padding:4px 10px;border-radius:6px;border:1px solid var(--gray-200);background:${active?'var(--g700)':'#fff'};color:${active?'#fff':'var(--gray-700)'};cursor:pointer;font-size:12px;font-weight:500">${label}</button>`;
      let btns = page > 1 ? btn(false,'‹',page-1) : '';
      for (let i = Math.max(1,page-2); i <= Math.min(pages,page+2); i++) btns += btn(i===page,i,i);
      if (page < pages) btns += btn(false,'›',page+1);
      el.innerHTML = '<div style="display:flex;align-items:center;gap:6px;justify-content:center;padding:12px 0;flex-wrap:wrap"><span style="font-size:12px;color:var(--gray-400)">Total: '+total+' registro'+(total!==1?'s':'')+'</span><div style="display:flex;gap:4px">'+btns+'</div></div>';
    },
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
      window._currentUser = user;
      document.getElementById('topbar-name').textContent = user.name;
      const pill = document.getElementById('topbar-role');
      pill.textContent = user.role === 'administrador' ? 'Administrador' : 'Usuário';
      pill.className   = 'role-pill ' + (user.role === 'administrador' ? 'admin' : 'user');
      if (user.role === 'administrador') {
        document.body.classList.add('is-admin');
        // Pages always start hidden — Nav.go controls them
        document.querySelectorAll('.page.admin-only').forEach(el => {
          el.hidden = true;
        });
      } else {
        document.body.classList.remove('is-admin');
      }
      document.getElementById('auth-screen').hidden = true;
      document.getElementById('app').hidden          = false;
      Nav.go('dashboard');
      Notificacoes.iniciar();
      BuscaGlobal.iniciar();
      UserMenu.iniciar();
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
    dashboard:'Dashboard', atendimento:'Atendimento', gestao:'Gestão de Clientes', carteira:'Inteligência da Carteira', perfil:'Meu Perfil', cac:'CAC / Investimentos em Aquisição', log:'Log de Atividades', gamificacao:'Gamificação Mensal',
    insatisfacao:'Insatisfação', sensiveis:'Clientes Sensíveis',
    pesquisas:'Pesquisas de Satisfação', recuperacao:'Recuperação de Clientes',
    admin:'Administração de Usuários',
  };

  const Nav = {
    go(page) {
      if (page === 'admin' && currentUser?.role !== 'administrador') return false;
      document.querySelectorAll('.page').forEach(el => { el.hidden = true; });
      closeSidebarMobile();
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      const pg = document.getElementById(`page-${page}`);
      if (pg) pg.hidden = false;
      document.querySelectorAll(`.nav-item[data-page="${page}"]`).forEach(el => el.classList.add('active'));
      document.getElementById('page-title').textContent = PAGE_TITLES[page] || page;
      if (page === 'dashboard')   (window.Dashboard || Dashboard)?.load();
      if (page === 'pesquisas')   window.Pesquisas?.loadGrid();
      if (page === 'carteira')    window.Carteira?.load();
      if (page === 'perfil')      window.Perfil?.load();
      if (page === 'cac')         window.CAC?.load();
      if (page === 'log')         window.Log?.carregar();
      if (page === 'gamificacao')  window.Gamificacao?.load();
      if (page === 'atendimento') window.Atendimento?.loadGrid();
      if (page === 'gestao')      window.Gestao?.loadGrid();
      if (page === 'insatisfacao') window.Insatisfacao?.loadGrid();
      if (page === 'recuperacao') window.Recuperacao?.loadGrid();
      if (page === 'sensiveis')   window.Sensiveis?.loadGrid();
      if (page === 'admin')        (window.Admin || Admin)?.load();
      return false;
    },
  };

  // ── Dashboard ─────────────────────────────────────────────────────────────
  const CHART_COLORS = ['#1a4233','#f5c518','#3182ce','#e53e3e','#38a169','#d69e2e','#9b2c2c','#2c7a7b'];
  let _charts = {};

  const Dashboard = {
    async load() {
      const period   = document.getElementById('dash-period').value;
      const analista = document.getElementById('dash-analista')?.value || '';
      const params   = analista ? `period=${period}&analista=${encodeURIComponent(analista)}` : `period=${period}`;
      const res      = await API.get(`/api/data/dashboard?${params}`);
      if (!res || !res.ok) return;
      const d = await res.json();
      Dashboard._lastData = d;
      const c = d.charts;
      // Populate analista dropdown
      const anaListaSel = document.getElementById('dash-analista');
      if (anaListaSel && d.analistas) {
        const cur = anaListaSel.value;
        anaListaSel.innerHTML = '<option value="">Todos os analistas</option>' +
          d.analistas.map(a => `<option value="${a}" ${a===cur?'selected':''}>${a}</option>`).join('');
      }

      // ── ATENDIMENTO ──────────────────────────────────────────────────────────
      Dashboard.renderChart('c-at-empresa', 'bar',      c.atEmpresa,  'Empresa',     {indexAxis:'y'});
      Dashboard.renderChart('c-depto',      'bar',      c.atDepto,    'Departamento');
      Dashboard.renderChart('c-analista',   'bar',      c.atAnalista, 'Analista',    {indexAxis:'y'});
      Dashboard.renderChart('c-demanda',    'doughnut', c.atDemanda,  'Demanda');

      // ── GESTÃO ───────────────────────────────────────────────────────────────
      Dashboard.renderChart('c-gestao', 'doughnut', c.gcTipo,  'Solicitação');
      Dashboard.renderChart('c-canal',  'pie',      c.gcCanal, 'Canal');

      // ── INSATISFAÇÃO ─────────────────────────────────────────────────────────
      Dashboard.renderChart('c-ins-area',   'bar',      c.insArea,    'Área');
      Dashboard.renderChart('c-ins-tipo',   'bar',      c.insTipo,    'Tipo',        {indexAxis:'y'});
      Dashboard.renderChart('c-grav',       'doughnut', c.insGrav,    'Gravidade');
      Dashboard.renderChart('c-ins-empresa','bar',      c.insEmpresa, 'Empresa',     {indexAxis:'y'});

      // ── PESQUISAS NPS ────────────────────────────────────────────────────────
      const npsEl = document.getElementById('nps-row');
      if (npsEl) npsEl.innerHTML = [
        { label:'NPS Médio',  value: d.nps,  sub:'Net Promoter Score (0–10)',    color:'#f5c518' },
        { label:'CSAT Médio', value: d.csat, sub:'Satisfação do cliente (0–5)',  color:'#68d391' },
        { label:'CES Médio',  value: d.ces,  sub:'Esforço do cliente (0–5)',     color:'#76e4f7' },
      ].map(n => `
        <div class="nps-card">
          <div class="nps-label">${n.label}</div>
          <div class="nps-value" style="color:${n.color}">${n.value != null ? n.value.toFixed(1) : '—'}</div>
          <div class="nps-sub">${n.sub}</div>
        </div>`).join('');
    },

    renderChart(id, type, rows, labelKey, extra={}) {
      if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
      const ctx = document.getElementById(id);
      if (!ctx) return;
      if (!rows || !rows.length) {
        ctx.parentElement.innerHTML = '<p style="text-align:center;color:var(--gray-400);font-size:12px;padding:40px 0">Sem dados no período</p>';
        return;
      }
      const isHBar = extra.indexAxis === 'y';
      const labels = rows.map(r => r.label || 'Não informado');
      const data   = rows.map(r => Number(r.n));
      const isBar  = type === 'bar';
      const bg     = isBar ? labels.map((_,i) => CHART_COLORS[i % CHART_COLORS.length]) : labels.map((_,i) => CHART_COLORS[i % CHART_COLORS.length]);
      _charts[id] = new Chart(ctx, {
        type,
        data: { labels, datasets: [{ label: labelKey, data, backgroundColor: bg, borderColor:'#fff', borderWidth: isBar?0:2, borderRadius: isBar?4:0 }] },
        options: {
          indexAxis: extra.indexAxis || 'x',
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: !isBar, position:'bottom', labels:{ boxWidth:12, font:{size:11}, padding:12 } } },
          scales: isBar ? {
            x: isHBar ? { beginAtZero:true, ticks:{stepSize:1,font:{size:10}}, grid:{color:'rgba(0,0,0,.05)'} } : { ticks:{font:{size:10},maxRotation:35}, grid:{display:false} },
            y: isHBar ? { ticks:{font:{size:10}}, grid:{display:false} } : { beginAtZero:true, ticks:{stepSize:1,font:{size:10}}, grid:{color:'rgba(0,0,0,.05)'} },
          } : {},
        },
      });
    },

    exportCSV() {
      const d = Dashboard._lastData;
      if (!d) { App.Toast.err('Carregue o Dashboard primeiro.'); return; }
      const period = document.getElementById('dash-period')?.value || 'todos';
      const c = d.charts;
      const rows = [];
      const sep = '\n\n';

      const section = (title, data) => {
        if (!data || !data.length) return '';
        const header = 'Posição;Descrição;Quantidade';
        const lines = data.map((r, i) => `${i+1};"${r.label||'Não informado'}";${r.n}`);
        return `${title}\n${header}\n${lines.join('\n')}`;
      };

      let csv = `DASHBOARD GRUPO-E — Período: ${period}\nGerado em: ${new Date().toLocaleString('pt-BR')}\n`;
      csv += sep + '=== ATENDIMENTO ===';
      csv += sep + section('Ranking — Empresas que mais solicitam', c.atEmpresa);
      csv += sep + section('Por departamento', c.atDepto);
      csv += sep + section('Por analista procurado', c.atAnalista);
      csv += sep + section('Por demanda', c.atDemanda);
      csv += sep + '=== GESTÃO DE CLIENTES ===';
      csv += sep + section('Por tipo de solicitação', c.gcTipo);
      csv += sep + section('Canal da solicitação', c.gcCanal);
      csv += sep + '=== INSATISFAÇÃO ===';
      csv += sep + section('Por área', c.insArea);
      csv += sep + section('Por tipo', c.insTipo);
      csv += sep + section('Por gravidade', c.insGrav);
      csv += sep + section('Ranking — Empresas com mais insatisfações', c.insEmpresa);
      csv += sep + '=== PESQUISAS ===';
      csv += sep + `NPS Médio;${d.nps != null ? d.nps.toFixed(1) : '—'}\nCSAT Médio;${d.csat != null ? d.csat.toFixed(1) : '—'}\nCES Médio;${d.ces != null ? d.ces.toFixed(1) : '—'}`;

      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dashboard_${period}_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      App.Toast.ok('CSV exportado!');
    },

    exportPDF() {
      const d = Dashboard._lastData;
      if (!d) { App.Toast.err('Carregue o Dashboard primeiro.'); return; }
      const period = document.getElementById('dash-period')?.value || 'todos';
      const c = d.charts;

      const table = (title, data) => {
        if (!data || !data.length) return `<h3>${title}</h3><p style="color:#999;font-size:11px">Sem dados no período</p>`;
        const rows = data.map((r,i) => `<tr><td>${i+1}</td><td>${r.label||'Não informado'}</td><td style="text-align:right;font-weight:600">${r.n}</td></tr>`).join('');
        return `<h3>${title}</h3>
          <table>
            <thead><tr><th>#</th><th>Descrição</th><th style="text-align:right">Qtd</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`;
      };

      const npsBlock = `<h3>Pesquisas de Satisfação</h3>
        <div style="display:flex;gap:20px;margin-top:6px">
          <div style="background:#1a4233;color:#fff;border-radius:8px;padding:12px 20px;text-align:center">
            <div style="font-size:10px;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:1px">NPS Médio</div>
            <div style="font-size:24px;font-weight:800;color:#f5c518">${d.nps != null ? d.nps.toFixed(1) : '—'}</div>
            <div style="font-size:10px;color:rgba(255,255,255,.5)">Net Promoter Score (0–10)</div>
          </div>
          <div style="background:#1a4233;color:#fff;border-radius:8px;padding:12px 20px;text-align:center">
            <div style="font-size:10px;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:1px">CSAT Médio</div>
            <div style="font-size:24px;font-weight:800;color:#68d391">${d.csat != null ? d.csat.toFixed(1) : '—'}</div>
            <div style="font-size:10px;color:rgba(255,255,255,.5)">Satisfação (0–5)</div>
          </div>
          <div style="background:#1a4233;color:#fff;border-radius:8px;padding:12px 20px;text-align:center">
            <div style="font-size:10px;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:1px">CES Médio</div>
            <div style="font-size:24px;font-weight:800;color:#76e4f7">${d.ces != null ? d.ces.toFixed(1) : '—'}</div>
            <div style="font-size:10px;color:rgba(255,255,255,.5)">Esforço (0–5)</div>
          </div>
        </div>`;

      const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
        <title>Dashboard Grupo-E</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: Arial, sans-serif; font-size: 11px; color: #222; padding: 24px; }
          .header { background: #1a4233; color: #fff; padding: 16px 20px; border-radius: 8px; margin-bottom: 20px; }
          .header h1 { font-size: 18px; font-weight: 800; }
          .header p { font-size: 11px; color: rgba(255,255,255,.7); margin-top: 4px; }
          .section { margin-bottom: 24px; border-left: 3px solid #1a4233; padding-left: 12px; }
          .section > h2 { font-size: 13px; font-weight: 700; color: #1a4233; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 12px; }
          .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
          h3 { font-size: 11px; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }
          table { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 8px; }
          th { background: #1a4233; color: #fff; padding: 5px 8px; text-align: left; }
          td { padding: 4px 8px; border-bottom: 1px solid #eee; }
          tr:nth-child(even) td { background: #f8f8f8; }
          @media print { body { padding: 10px; } .no-print { display: none; } }
        </style>
      </head><body>
        <div class="header">
          <h1>Dashboard — Grupo-E Soluções Empresariais</h1>
          <p>Período: ${period} &nbsp;|&nbsp; Gerado em: ${new Date().toLocaleString('pt-BR')}</p>
        </div>

        <div class="section">
          <h2>Atendimento</h2>
          <div class="grid2">
            ${table('Ranking — Empresas que mais solicitam atendimento', c.atEmpresa)}
            ${table('Por departamento', c.atDepto)}
            ${table('Por analista procurado', c.atAnalista)}
            ${table('Por demanda', c.atDemanda)}
          </div>
        </div>

        <div class="section">
          <h2>Gestão de Clientes</h2>
          <div class="grid2">
            ${table('Por tipo de solicitação', c.gcTipo)}
            ${table('Canal da solicitação', c.gcCanal)}
          </div>
        </div>

        <div class="section">
          <h2>Insatisfação</h2>
          <div class="grid2">
            ${table('Por área', c.insArea)}
            ${table('Por tipo', c.insTipo)}
            ${table('Por gravidade', c.insGrav)}
            ${table('Ranking — Empresas com mais insatisfações', c.insEmpresa)}
          </div>
        </div>

        <div class="section">
          <h2>Pesquisas de Satisfação</h2>
          ${npsBlock}
        </div>

        <script>window.onload = () => { window.print(); }<\/script>
      </body></html>`;

      const win = window.open('', '_blank');
      if (!win) { App.Toast.err('Permita popups para exportar PDF.'); return; }
      win.document.write(html);
      win.document.close();
      App.Toast.ok('PDF gerado — use Ctrl+P para salvar!');
    },

    renderLineChart(id, data) {
      if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
      const ctx = document.getElementById(id);
      if (!ctx || !data.length) return;
      const labels = data.map(r => r.mes);
      _charts[id] = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label:'NPS', data: data.map(r=>r.nps), borderColor:'#f5c518', backgroundColor:'#f5c51820', tension:.3, pointRadius:4 },
            { label:'CSAT', data: data.map(r=>r.csat), borderColor:'#68d391', backgroundColor:'#68d39120', tension:.3, pointRadius:4 },
            { label:'CES', data: data.map(r=>r.ces), borderColor:'#76e4f7', backgroundColor:'#76e4f720', tension:.3, pointRadius:4 },
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position:'bottom', labels:{ boxWidth:12, font:{size:11}, padding:12 } } },
          scales: {
            y: { beginAtZero:true, max:10, ticks:{font:{size:10}}, grid:{color:'rgba(0,0,0,.05)'} },
            x: { ticks:{font:{size:10}}, grid:{display:false} }
          }
        }
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
      if (!Util.requireFields([['at-analista','Analista'],['at-cliente','Cliente'],['at-cnpj','CNPJ'],['at-empresa','Empresa'],['at-depto','Departamento'],['at-procurado','Analista Procurado']])) return;
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
      Atendimento.loadGrid();
    },

    async gestao() {
      if (!Util.requireFields([['gc-analista','Analista'],['gc-solicitacao','Solicitação'],['gc-cnpj','CNPJ'],['gc-empresa','Empresa'],['gc-data','Data'],['gc-competencia','Competência'],['gc-canal','Canal']])) return;
      const gcSol = Util.val('gc-solicitacao') === 'Outro' ? Util.val('gc-sol-outro') : Util.val('gc-solicitacao');
      const gcCanal = Util.val('gc-canal') === 'Outro' ? Util.val('gc-canal-outro') : Util.val('gc-canal');
      const isEntrada = gcSol==='Constituição de empresa' || gcSol==='Cliente vindo de outro contador' || gcSol==='Transformação de empresa';
      const isSaida = gcSol==='Saída de empresa' || gcSol==='Baixa de empresa';
      // Validar honorario obrigatorio na entrada
      if (isEntrada && !Util.val('gc-honorario')) {
        App.Toast.err('Honorário Inicial é obrigatório para registros de entrada.'); return;
      }
      if (isEntrada && !Util.val('gc-data-entrada')) {
        App.Toast.err('Data de Entrada é obrigatória.'); return;
      }
      const token = localStorage.getItem('ge_token');
      // Se é entrada, registra automaticamente na carteira
      if (isEntrada && Util.val('gc-honorario')) {
        // Calcular CAC automaticamente: investimento do mês ÷ clientes do mês
        const dataEntrada = Util.val('gc-data-entrada') || Util.val('gc-data');
        const mesEntrada = dataEntrada ? dataEntrada.slice(0,7) : new Date().toISOString().slice(0,7);
        let cacCalculado = 0;
        try {
          const cacRes = await fetch('/api/data/cac/dashboard?mes=' + mesEntrada, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (cacRes && cacRes.ok) {
            const cacData = await cacRes.json();
            cacCalculado = cacData.cacMedio || 0;
          }
        } catch(e) {}

        await fetch('/api/data/clientes', {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` },
          body: JSON.stringify({
            cnpj: Util.val('gc-cnpj'),
            nome_empresa: Util.val('gc-empresa'),
            codigo: Util.val('gc-codigo') || null,
            regime_tributario: Util.val('gc-regime') || null,
            data_entrada: dataEntrada,
            honorario_inicial: parseFloat(Util.val('gc-honorario')) || 0,
            origem: Util.val('gc-origem') || null,
            cac: cacCalculado,
          })
        });
      }
      // Se é saída/baixa, encerra o cliente na carteira pelo CNPJ
      if (isSaida) {
        const cnpj = Util.val('gc-cnpj');
        const dataSaida = Util.val('gc-data-saida') || Util.val('gc-data');
        const motivoSaida = Util.val('gc-motivo-saida') || gcSol;
        // Buscar cliente pelo CNPJ para obter o ID
        const resClientes = await fetch(`/api/data/clientes?status=ativo`, {
          headers: { 'Authorization':`Bearer ${token}` }
        });
        if (resClientes && resClientes.ok) {
          const { data } = await resClientes.json();
          const cliente = data.find(c => c.cnpj === cnpj);
          if (cliente) {
            await fetch(`/api/data/clientes/${cliente.id}/encerrar`, {
              method: 'PATCH',
              headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` },
              body: JSON.stringify({ data_saida: dataSaida, motivo_saida: motivoSaida })
            });
          }
        }
      }
      await Forms._submit('gestao', {
        analista: Util.val('gc-analista'), solicitacao: gcSol,
        cnpj: Util.val('gc-cnpj'), empresa: Util.val('gc-empresa'),
        data_sol: Util.val('gc-data'), competencia: Util.val('gc-competencia'),
        canal: gcCanal,
      }, ['gc-analista','gc-cnpj','gc-empresa','gc-data','gc-competencia','gc-motivo'], 'Gestão salva!');
      document.getElementById('gc-solicitacao').value='';
      document.getElementById('gc-canal').value='';
      document.getElementById('gc-sol-outro').value='';
      document.getElementById('gc-canal-outro').value='';
      document.getElementById('gc-codigo').value='';
      gcToggleOutros();
      Gestao.loadGrid();
    },

    async insatisfacao() {
      const inTipo = Util.val('in-tipo') === 'Outro' ? Util.val('in-tipo-outro') : Util.val('in-tipo');
      if (!Util.requireFields([
        ['in-analista','Analista'],['in-cliente','Cliente'],['in-cnpj','CNPJ'],
        ['in-empresa','Empresa'],['in-reclamacao','Reclamação'],['in-gravidade','Gravidade'],
        ['in-area','Área da Insatisfação'],
      ])) return;
      if (!Util.val('in-area')) { App.Toast.err('Selecione a Área da Insatisfação.'); return; }
      if (!inTipo) { App.Toast.err('Selecione o Tipo de Insatisfação.'); return; }
      if (Util.val('in-tipo') === 'Outro' && !Util.val('in-tipo-outro')) {
        App.Toast.err('Descreva o tipo de insatisfação.'); return;
      }
      const gravInsatisf = Util.val('in-gravidade');
      await Forms._submit('insatisfacoes', {
        analista: Util.val('in-analista'), cliente: Util.val('in-cliente'),
        cnpj: Util.val('in-cnpj'), empresa: Util.val('in-empresa'),
        reclamado: Util.val('in-reclamado'), reclamacao: Util.val('in-reclamacao'),
        gravidade: gravInsatisf,
        area: Util.val('in-area'),
        tipo: inTipo,
      }, ['in-analista','in-cliente','in-cnpj','in-empresa','in-reclamado','in-reclamacao','in-tipo-outro'], 'Insatisfação registrada!');
      document.getElementById('in-gravidade').value='';
      document.getElementById('in-area').value='';
      document.getElementById('in-tipo').innerHTML='<option value="">Selecione a área primeiro</option>';
      const ow = document.getElementById('in-tipo-outro-wrap');
      if(ow){ow.hidden=true;ow.style.display='none';}
      // Notificar se gravidade alta
      if (gravInsatisf === 'Muito Alta' || gravInsatisf === 'Alta') {
        const empresa = Util.val('in-empresa') || 'cliente';
        Notificacoes.criar(
          'insatisfacao_alta',
          'Insatisfação ' + gravInsatisf + ' registrada',
          empresa + ' — ' + (inTipo || Util.val('in-area') || 'Verifique o módulo de Insatisfação'),
          'insatisfacao'
        );
      }
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
      Recuperacao.loadGrid();
    },
  };

  // ── Admin ─────────────────────────────────────────────────────────────────
  let _editingUserId = null;
  const Admin = {
    _users: [],

    async load() {
      const res = await API.get('/api/users');
      if (!res || !res.ok) return;
      const { users } = await res.json();
      Admin._users = users;
      Admin.filtrar();
    },

    filtrar() {
      const busca = (document.getElementById('adm-busca')?.value || '').toLowerCase().trim();
      const users = busca
        ? Admin._users.filter(u =>
            (u.name||'').toLowerCase().includes(busca) ||
            (u.email||'').toLowerCase().includes(busca))
        : Admin._users;
      document.getElementById('users-tbody').innerHTML = users.map(u => {
        const ativo = u.ativo !== false;
        return `<tr style="${!ativo?'opacity:.55':''}">
          <td style="font-weight:600">${u.name}</td>
          <td style="font-size:12px;color:var(--gray-500)">${u.email}</td>
          <td><span class="role-pill ${u.role==='administrador'?'admin':'user'}">${u.role==='administrador'?'Administrador':'Usuário'}</span></td>
          <td><span style="background:${ativo?'#f0fff4':'#fff5f5'};color:${ativo?'#38a169':'#e53e3e'};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${ativo?'Ativo':'Inativo'}</span></td>
          <td style="white-space:nowrap;display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" onclick="App.Admin.openEditProfile('${u.id}','${u.name}','${u.email}')">✏️ Editar</button>
            <button class="btn btn-ghost btn-sm" onclick="App.Admin.openEditPass('${u.id}')">🔑 Senha</button>
            <button class="btn btn-sm" style="background:${ativo?'#fff5f5':'#f0fff4'};color:${ativo?'#e53e3e':'#38a169'};border:1px solid ${ativo?'#fed7d7':'#c6f6d5'}" onclick="App.Admin.toggleAtivo('${u.id}','${u.name}',${ativo})">${ativo?'⏸ Desativar':'▶ Ativar'}</button>
            <button class="btn btn-danger btn-sm" onclick="App.Admin.deleteUser('${u.id}','${u.name}')">🗑 Excluir</button>
          </td>
        </tr>`;
      }).join('');
    },

    async fazerBackup() {
      App.Toast.show('Gerando backup... aguarde.', 'default');
      const tk = localStorage.getItem('ge_token') || '';
      const res = await fetch('/api/data/backup', { headers: { Authorization: 'Bearer ' + tk } });
      if (!res || !res.ok) { App.Toast.err('Erro ao gerar backup.'); return; }
      const data = await res.json();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const ts   = new Date().toISOString().slice(0,10);
      const a    = document.createElement('a');
      a.href = url; a.download = 'backup-grupo-e-' + ts + '.json';
      a.click(); URL.revokeObjectURL(url);
      // Show summary
      const meta = data.meta?.totais || {};
      App.Toast.ok('Backup gerado! Registros: ' +
        Object.entries(meta).map(function(e) { return e[0] + ': ' + e[1]; }).join(' | '));
    },

    exportCSV() {
      const users = Admin._users;
      if (!users.length) { App.Toast.err('Nenhum usuário para exportar.'); return; }
      const header = 'Nome;E-mail;Perfil;Status';
      const rows = users.map(u =>
        `"${u.name}";"${u.email}";"${u.role==='administrador'?'Administrador':'Usuário'}";"${u.ativo!==false?'Ativo':'Inativo'}"`
      );
      const csv = [header, ...rows].join('\n');
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `usuarios_${new Date().toISOString().slice(0,10)}.csv`;
      a.click(); URL.revokeObjectURL(url);
      App.Toast.ok('CSV exportado!');
    },

    exportPDF() {
      const users = Admin._users;
      if (!users.length) { App.Toast.err('Nenhum usuário para exportar.'); return; }
      const rows = users.map(u => `<tr>
        <td>${u.name}</td><td>${u.email}</td>
        <td>${u.role==='administrador'?'Administrador':'Usuário'}</td>
        <td style="color:${u.ativo!==false?'#38a169':'#e53e3e'}">${u.ativo!==false?'Ativo':'Inativo'}</td>
      </tr>`).join('');
      const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Usuários</title>
      <style>body{font-family:Arial,sans-serif;font-size:12px;margin:20px}
      h1{font-size:15px;color:#1a4233;margin-bottom:12px}
      table{width:100%;border-collapse:collapse}
      th{background:#1a4233;color:#fff;padding:6px 10px;text-align:left}
      td{padding:5px 10px;border-bottom:1px solid #eee}
      tr:nth-child(even) td{background:#f8f8f8}
      @media print{body{margin:10px}}</style></head><body>
      <h1>Grupo-E — Usuários do Sistema</h1>
      <p style="font-size:11px;color:#666;margin-bottom:12px">Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${users.length} usuário${users.length!==1?'s':''}</p>
      <table><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <script>window.onload=()=>{window.print();}<\/script></body></html>`;
      const win = window.open('', '_blank');
      if (!win) { App.Toast.err('Permita popups para exportar PDF.'); return; }
      win.document.write(html); win.document.close();
      App.Toast.ok('PDF gerado!');
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

    openEditProfile(id, name, email) {
      App.Modal.open('Editar usuário', '<div style="display:grid;gap:12px">' +
        '<div class="field"><label>Nome</label><input id="eu-name" type="text" value="' + (name||'') + '" /></div>' +
        '<div class="field"><label>E-mail</label><input id="eu-email" type="email" value="' + (email||'') + '" /></div>' +
        '<div class="field"><label>Função</label><select id="eu-role">' +
          '<option value="usuario">Usuário</option>' +
          '<option value="administrador">Administrador</option>' +
        '</select></div>' +
        '<button class="btn btn-primary" data-id="' + id + '" onclick="App.Admin.saveEdit(this.dataset.id)">Salvar</button>' +
      '</div>');
    },

    async saveEdit(id) {
      const name  = document.getElementById('eu-name')?.value?.trim();
      const email = document.getElementById('eu-email')?.value?.trim();
      const role  = document.getElementById('eu-role')?.value;
      if (!name) { App.Toast.err('Nome obrigatório.'); return; }
      const res = await API.patch('/api/users/' + id + '/profile', { name, email, role });
      if (res && res.ok) { App.Modal.close(); App.Toast.ok('Usuário atualizado!'); Admin.load(); }
      else App.Toast.err('Erro ao atualizar.');
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

    async toggleAtivo(id, name, ativo) {
      const acao = ativo ? 'desativar' : 'ativar';
      if (!confirm(`Confirma ${acao} o usuário "${name}"?`)) return;
      const res = await API.patch(`/api/users/${id}/toggle`, {});
      if (res && res.ok) {
        App.Toast.ok('Usuário ' + (ativo ? 'desativado' : 'ativado') + '!');
        Admin.load();
      } else App.Toast.err('Erro ao alterar status.');
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
    open(title, bodyHTML, onConfirm, opts) {
      _modalCallback = onConfirm;
      document.getElementById('modal-title').textContent = title;
      document.getElementById('modal-body').innerHTML    = bodyHTML;
      document.getElementById('modal-confirm').onclick   = () => _modalCallback?.();
      // Esconde rodapé se opts.noFooter = true
      const footer = document.getElementById('modal-footer');
      if (footer) footer.hidden = !!(opts && opts.noFooter);
      document.getElementById('modal-backdrop').hidden   = false;
    },
    close() {
      document.getElementById('modal-backdrop').hidden = true;
      _modalCallback = null;
      const footer = document.getElementById('modal-footer');
      if (footer) footer.hidden = false; // restore for next modal
    },
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

// Expor módulos internos do App para window
window.Dashboard = App.Dashboard;
window.Admin     = App.Admin;
window.Forms     = App.Forms;
window.Nav       = App.Nav;

// ── Wire all events after DOM ready (no inline onclick) ───────────────────────
// ── Gestão de Clientes — toggles de "Outro" ──────────────────────────────────
function gcToggleOutros() {
  const sol = document.getElementById('gc-solicitacao')?.value;
  const canal = document.getElementById('gc-canal')?.value;
  // Outro solicitação
  const solWrap = document.getElementById('gc-sol-outro-wrap');
  if (solWrap) { const s = sol==='Outro'; solWrap.style.display=s?'flex':'none'; solWrap.hidden=!s; }
  // Outro canal
  const canalWrap = document.getElementById('gc-canal-outro-wrap');
  if (canalWrap) { const s = canal==='Outro'; canalWrap.style.display=s?'flex':'none'; canalWrap.hidden=!s; }
  // Campos de ENTRADA (honorário, origem, CAC, regime, data-entrada)
  const isEntrada = sol==='Constituição de empresa' || sol==='Cliente vindo de outro contador' || sol==='Transformação de empresa';
  ['gc-honorario-wrap','gc-origem-wrap','gc-regime-wrap','gc-data-entrada-wrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.display = isEntrada ? 'flex' : 'none'; el.hidden = !isEntrada; }
  });
  // Campos de SAÍDA
  const isSaida = sol==='Saída de empresa' || sol==='Baixa de empresa';
  ['gc-data-saida-wrap','gc-motivo-saida-wrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.display = isSaida ? 'flex' : 'none'; el.hidden = !isSaida; }
  });
}

// ── Insatisfação — cascade Area → Tipo ───────────────────────────────────────
const IN_TIPOS = {
  'Comunicação': [
    'Demora no retorno','Falta de clareza nas informações',
    'Não foi avisado sobre prazo/vencimento','Outro'
  ],
  'Qualidade do Serviço': [
    'Erro em guia/boleto','Erro em declaração','Erro em folha de pagamento',
    'Erro em nota fiscal','Informação incorreta','Outro'
  ],
  'Prazo': [
    'Entrega fora do prazo','Atraso na abertura de empresa',
    'Atraso no encerramento','Atraso em certidão/documento','Outro'
  ],
  'Atendimento': [
    'Analista despreparado','Falta de proatividade',
    'Tratamento inadequado','Analista não conhecia o cliente','Outro'
  ],
  'Financeiro': [
    'Cobrança incorreta','Honorário não acordado',
    'Falta de transparência nos custos','Outro'
  ],
  'Fiscal / Tributário': [
    'Imposto calculado errado','Enquadramento tributário inadequado',
    'Multa por erro do escritório','Outro'
  ],
  'Tecnologia / Acesso': [
    'Problema com sistema','Dificuldade de acesso ao portal',
    'Documento não enviado/recebido','Outro'
  ],
  'Outro': ['Outro'],
};

function inToggleArea() {
  const area = document.getElementById('in-area')?.value;
  const tipoSel = document.getElementById('in-tipo');
  const outroWrap = document.getElementById('in-tipo-outro-wrap');
  if (!tipoSel) return;
  const tipos = IN_TIPOS[area] || [];
  tipoSel.innerHTML = tipos.length
    ? '<option value="">Selecione o tipo</option>' + tipos.map(t=>`<option>${t}</option>`).join('')
    : '<option value="">Selecione a área primeiro</option>';
  // Hide outro initially
  if (outroWrap) { outroWrap.hidden = true; outroWrap.style.display = 'none'; }
  tipoSel.onchange = () => {
    const isOutro = tipoSel.value === 'Outro';
    if (outroWrap) { outroWrap.hidden = !isOutro; outroWrap.style.display = isOutro ? 'flex' : 'none'; }
  };
}

// ── Módulo Perfil ─────────────────────────────────────────────────────────────
const Perfil = (() => {
  function _token() { return localStorage.getItem('ge_token') || ''; }

  function load() {
    const store = localStorage.getItem('ge_user');
    if (!store) return;
    try {
      const user = JSON.parse(store);
      const nome = document.getElementById('perfil-nome');
      const email = document.getElementById('perfil-email');
      if (nome) nome.value = user.name || '';
      if (email) email.value = user.email || '';
    } catch(e) {}
  }

  async function salvar() {
    const nome = document.getElementById('perfil-nome')?.value?.trim();
    const senhaAtual = document.getElementById('perfil-senha-atual')?.value;
    const senhaNova = document.getElementById('perfil-senha-nova')?.value;
    const senhaConf = document.getElementById('perfil-senha-conf')?.value;
    if (!nome) { App.Toast.err('Nome é obrigatório.'); return; }
    // Senha atual obrigatória para qualquer alteração
    if (!senhaAtual) { App.Toast.err('Digite sua senha atual para confirmar as alterações.'); return; }
    // Validar nova senha apenas se preenchida
    if (senhaNova || senhaConf) {
      if (senhaNova.length < 6) { App.Toast.err('Nova senha deve ter ao menos 6 caracteres.'); return; }
      if (senhaNova !== senhaConf) { App.Toast.err('As senhas não coincidem.'); return; }
    }
    const body = { nome, senhaAtual };
    if (senhaNova) body.senhaNova = senhaNova;
    const res = await fetch('/api/data/perfil', {
      method: 'PATCH',
      headers: { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + _token() },
      body: JSON.stringify(body)
    });
    if (res && res.ok) {
      App.Toast.ok('Perfil atualizado!');
      ['perfil-senha-atual','perfil-senha-nova','perfil-senha-conf'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
    } else {
      const err = await res.json().catch(() => ({}));
      App.Toast.err(err.error || 'Erro ao atualizar perfil.');
    }
  }

  return { load, salvar };
})();

window.Perfil = Perfil;

// ── Responsividade — sidebar mobile ──────────────────────────────────────────
function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (!sidebar) return;
  sidebar.classList.toggle('open');
  if (overlay) overlay.classList.toggle('open');
}

// Fechar sidebar ao navegar (mobile)
function closeSidebarMobile() {
  if (window.innerWidth <= 768) {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
  }
}

// Mostrar/esconder botão hamburguer conforme tamanho
function handleResize() {
  const btn = document.getElementById('btn-menu');
  if (!btn) return;
  btn.style.display = window.innerWidth <= 768 ? 'flex' : 'none';
}

window.addEventListener('resize', handleResize);

// ── Módulo Notificações ───────────────────────────────────────────────────────
const Notificacoes = (() => {
  const _tk = () => localStorage.getItem('ge_token') || '';
  let _open = false;
  let _interval = null;

  async function checar() {
    const res = await fetch('/api/data/notificacoes', { headers: { Authorization: 'Bearer ' + _tk() } });
    if (!res || !res.ok) return;
    const { data, naoLidas } = await res.json();
    const badge = document.getElementById('notif-badge');
    if (badge) {
      badge.hidden = naoLidas === 0;
      badge.textContent = naoLidas > 9 ? '9+' : naoLidas;
    }
    const list = document.getElementById('notif-list');
    if (!list) return;
    if (!data.length) {
      list.innerHTML = '<p style="text-align:center;color:var(--gray-400);font-size:13px;padding:20px">Sem notificações</p>';
      return;
    }
    const icons = { insatisfacao_alta: '🚨', reajuste: '⚠️', novo_cliente: '🎉', pesquisa: '📊', default: '🔔' };
    list.innerHTML = data.map(function(n) {
      const icon = icons[n.tipo] || icons.default;
      const bg = n.lida ? '' : 'background:#f0fff4;';
      const dt = new Date(n.created_at).toLocaleString('pt-BR');
      const dataAttrs = 'data-modulo="' + (n.link_modulo||'') + '" data-id="' + n.id + '" onclick="Notificacoes.clicar(this)"';
      return '<div style="' + bg + 'padding:12px 16px;border-bottom:1px solid var(--gray-100);cursor:pointer" ' + dataAttrs + '>' +
        '<div style="display:flex;gap:10px;align-items:flex-start">' +
          '<span style="font-size:18px;flex-shrink:0">' + icon + '</span>' +
          '<div style="min-width:0">' +
            '<div style="font-size:13px;font-weight:' + (n.lida ? '400' : '600') + ';color:var(--g800)">' + n.titulo + '</div>' +
            '<div style="font-size:12px;color:var(--gray-500);margin-top:2px">' + n.mensagem + '</div>' +
            '<div style="font-size:11px;color:var(--gray-400);margin-top:4px">' + dt + '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function toggle() {
    const panel = document.getElementById('notif-panel');
    if (!panel) return;
    _open = !_open;
    panel.hidden = !_open;
    if (_open) checar();
  }

  async function marcarLida(id) {
    await fetch('/api/data/notificacoes/' + id + '/lida', { method: 'PATCH', headers: { Authorization: 'Bearer ' + _tk() } });
    await checar();
  }

  async function marcarTodasLidas() {
    await fetch('/api/data/notificacoes/todas/lidas', { method: 'PATCH', headers: { Authorization: 'Bearer ' + _tk() } });
    await checar();
  }

  async function irPara(modulo, id) {
    await marcarLida(id);
    const panel = document.getElementById('notif-panel');
    if (panel) panel.hidden = true;
    _open = false;
    App.Nav.go(modulo);
  }

  async function criar(tipo, titulo, mensagem, link_modulo) {
    await fetch('/api/data/notificacoes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tk() },
      body: JSON.stringify({ tipo, titulo, mensagem, link_modulo: link_modulo || null })
    }).catch(function(){});
    await checar();
  }

  function iniciar() {
    checar();
    // Verifica a cada 2 minutos
    _interval = setInterval(checar, 2 * 60 * 1000);
    // Fechar ao clicar fora
    document.addEventListener('click', function(e) {
      const panel = document.getElementById('notif-panel');
      const btn = document.getElementById('notif-btn');
      if (_open && panel && !panel.contains(e.target) && !btn.contains(e.target)) {
        panel.hidden = true;
        _open = false;
      }
    });
  }

  function clicar(el) {
    const modulo = el.dataset.modulo;
    const id = el.dataset.id;
    if (modulo) irPara(modulo, id);
    else marcarLida(id);
  }
  return { checar, toggle, marcarLida, marcarTodasLidas, irPara, clicar, criar, iniciar };
})();

window.Notificacoes = Notificacoes;

// ── Módulo Relatório Executivo ────────────────────────────────────────────────
const Relatorio = (() => {
  const _tk = () => localStorage.getItem('ge_token') || '';
  const _fmt = (v) => 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const _meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

  function abrir() {
    const agora = new Date();
    const mesAtual = agora.toISOString().slice(0,7);
    App.Modal.open('📋 Relatório Executivo', '<div style="display:grid;gap:16px;padding:8px 0">' +
      '<div class="field"><label>Selecione o mês do relatório</label>' +
        '<input id="rel-mes" type="month" value="' + mesAtual + '" style="padding:8px 12px;border:1px solid var(--gray-200);border-radius:8px;font-size:14px;width:200px" /></div>' +
      '<p style="font-size:13px;color:var(--gray-500)">O relatório incluirá: atendimentos, gestão de clientes, insatisfações, pesquisas NPS/CSAT/CES, indicadores da carteira e CAC do mês selecionado.</p>' +
      '<button class="btn btn-primary" onclick="Relatorio.gerar()" style="font-size:15px;padding:12px">📋 Gerar Relatório PDF</button>' +
    '</div>');
  }

  async function gerar() {
    const mes = document.getElementById('rel-mes')?.value;
    if (!mes) { App.Toast.err('Selecione o mês.'); return; }
    App.Toast.show('Gerando relatório...', 'default');
    const res = await fetch('/api/data/relatorio-executivo?mes=' + mes, {
      headers: { Authorization: 'Bearer ' + _tk() }
    });
    if (!res || !res.ok) { App.Toast.err('Erro ao gerar relatório.'); return; }
    const d = await res.json();
    App.Modal.close();
    _gerarPDF(d);
  }

  function _table(title, rows, col1, col2) {
    if (!rows || !rows.length) return '<p style="color:#999;font-size:11px;margin:4px 0 12px">Sem dados no período</p>';
    const trs = rows.map(function(r) {
      const v1 = r[col1] || r.label || r.gravidade || r.area || r.solicitacao || r.departamento || r.procurado || r.empresa || '—';
      const v2 = r[col2] || r.n || 0;
      return '<tr><td>' + v1 + '</td><td style="text-align:right;font-weight:600">' + v2 + '</td></tr>';
    }).join('');
    return '<table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:12px">' +
      '<thead><tr><th style="background:#1a4233;color:#fff;padding:5px 8px;text-align:left">' + col1.charAt(0).toUpperCase() + col1.slice(1) + '</th>' +
      '<th style="background:#1a4233;color:#fff;padding:5px 8px;text-align:right">Qtd</th></tr></thead>' +
      '<tbody>' + trs + '</tbody></table>';
  }

  function _gerarPDF(d) {
    const mrr = parseFloat(d.carteira?.mrr || 0);
    const cac = d.cac || 0;
    const novos = d.novosClientes || 0;
    const cacMedio = novos > 0 ? cac / novos : 0;

    const html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">' +
    '<title>Relatório Executivo ' + d.mesLabel + '</title>' +
    '<style>' +
      '* { box-sizing:border-box; margin:0; padding:0; }' +
      'body { font-family:Arial,sans-serif; font-size:11px; color:#222; padding:24px; }' +
      '.header { background:#1a4233; color:#fff; padding:20px 24px; border-radius:10px; margin-bottom:20px; }' +
      '.header h1 { font-size:20px; font-weight:800; margin-bottom:4px; }' +
      '.header p { font-size:12px; color:rgba(255,255,255,.7); }' +
      '.section { margin-bottom:20px; border-left:3px solid #1a4233; padding-left:12px; page-break-inside:avoid; }' +
      '.section h2 { font-size:13px; font-weight:700; color:#1a4233; text-transform:uppercase; letter-spacing:.5px; margin-bottom:10px; }' +
      '.cards { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; }' +
      '.card { background:#f8f8f8; border-radius:8px; padding:12px 14px; border-top:3px solid #1a4233; }' +
      '.card-label { font-size:10px; color:#666; text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px; }' +
      '.card-value { font-size:18px; font-weight:800; color:#1a4233; }' +
      '.card-green { border-top-color:#38a169; }' +
      '.card-green .card-value { color:#38a169; }' +
      '.card-yellow { border-top-color:#d69e2e; }' +
      '.card-yellow .card-value { color:#d69e2e; }' +
      '.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; }' +
      'table { width:100%; border-collapse:collapse; font-size:10px; margin-bottom:8px; }' +
      'th { background:#1a4233; color:#fff; padding:5px 8px; text-align:left; }' +
      'td { padding:4px 8px; border-bottom:1px solid #eee; }' +
      'tr:nth-child(even) td { background:#f8f8f8; }' +
      '.nps-cards { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }' +
      '.nps-card { background:#1a4233; color:#fff; border-radius:8px; padding:14px; text-align:center; }' +
      '.nps-label { font-size:10px; color:rgba(255,255,255,.6); text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px; }' +
      '.nps-value { font-size:26px; font-weight:800; }' +
      '.nps-sub { font-size:10px; color:rgba(255,255,255,.5); margin-top:2px; }' +
      '@media print { body { padding:10px; } .no-print { display:none; } }' +
    '</style></head><body>' +

    '<div class="header">' +
      '<h1>Relatório Executivo — ' + d.mesLabel + '</h1>' +
      '<p>Grupo-E Soluções Empresariais &nbsp;|&nbsp; Gerado em: ' + new Date().toLocaleString('pt-BR') + '</p>' +
    '</div>' +

    // RESUMO OPERACIONAL
    '<div class="section"><h2>Resumo Operacional</h2>' +
    '<div class="cards">' +
      '<div class="card"><div class="card-label">Atendimentos</div><div class="card-value">' + d.totais.atendimentos + '</div></div>' +
      '<div class="card"><div class="card-label">Gestões</div><div class="card-value">' + d.totais.gestoes + '</div></div>' +
      '<div class="card card-yellow"><div class="card-label">Insatisfações</div><div class="card-value">' + d.totais.insatisfacoes + '</div></div>' +
      '<div class="card"><div class="card-label">Recuperações</div><div class="card-value">' + d.totais.recuperacoes + '</div></div>' +
    '</div></div>' +

    // CARTEIRA
    '<div class="section"><h2>Inteligência da Carteira</h2>' +
    '<div class="cards">' +
      '<div class="card card-green"><div class="card-label">MRR</div><div class="card-value">' + _fmt(mrr) + '</div></div>' +
      '<div class="card card-green"><div class="card-label">ARR</div><div class="card-value">' + _fmt(mrr*12) + '</div></div>' +
      '<div class="card"><div class="card-label">Clientes ativos</div><div class="card-value">' + (d.carteira?.ativos||0) + '</div></div>' +
      '<div class="card"><div class="card-label">Novos clientes</div><div class="card-value">' + novos + '</div></div>' +
    '</div>' +
    '<div class="cards">' +
      '<div class="card"><div class="card-label">Investimento CAC</div><div class="card-value">' + _fmt(cac) + '</div></div>' +
      '<div class="card"><div class="card-label">CAC médio</div><div class="card-value">' + (cacMedio > 0 ? _fmt(cacMedio) : '—') + '</div></div>' +
      '<div class="card card-green"><div class="card-label">LTV/CAC</div><div class="card-value">' + (cacMedio > 0 && mrr > 0 ? (mrr*48/cacMedio).toFixed(1)+'x' : '—') + '</div></div>' +
    '</div></div>' +

    // ATENDIMENTO
    '<div class="section"><h2>Atendimento</h2><div class="grid2">' +
      '<div><h3 style="font-size:11px;color:#555;margin-bottom:6px">Por departamento</h3>' + _table('', d.atDepto, 'departamento', 'n') + '</div>' +
      '<div><h3 style="font-size:11px;color:#555;margin-bottom:6px">Por analista procurado</h3>' + _table('', d.atAnalista, 'procurado', 'n') + '</div>' +
    '</div></div>' +

    // INSATISFAÇÃO
    '<div class="section"><h2>Insatisfação</h2><div class="grid2">' +
      '<div><h3 style="font-size:11px;color:#555;margin-bottom:6px">Por gravidade</h3>' + _table('', d.insGrav, 'gravidade', 'n') + '</div>' +
      '<div><h3 style="font-size:11px;color:#555;margin-bottom:6px">Por área</h3>' + _table('', d.insArea, 'area', 'n') + '</div>' +
    '</div>' +
    '<h3 style="font-size:11px;color:#555;margin:8px 0 6px">Top empresas com insatisfações</h3>' +
    _table('', d.insEmpresas, 'empresa', 'n') + '</div>' +

    // GESTÃO
    '<div class="section"><h2>Gestão de Clientes</h2>' +
    '<h3 style="font-size:11px;color:#555;margin-bottom:6px">Por tipo de solicitação</h3>' +
    _table('', d.gcTipo, 'solicitacao', 'n') + '</div>' +

    // PESQUISAS
    '<div class="section"><h2>Pesquisas de Satisfação</h2>' +
    '<div class="nps-cards">' +
      '<div class="nps-card"><div class="nps-label">NPS Médio</div><div class="nps-value" style="color:#f5c518">' + (d.pesquisas?.nps || '—') + '</div><div class="nps-sub">Net Promoter Score (0–10) | ' + (d.pesquisas?.total||0) + ' respostas</div></div>' +
      '<div class="nps-card"><div class="nps-label">CSAT Médio</div><div class="nps-value" style="color:#68d391">' + (d.pesquisas?.csat || '—') + '</div><div class="nps-sub">Satisfação do cliente (0–5)</div></div>' +
      '<div class="nps-card"><div class="nps-label">CES Médio</div><div class="nps-value" style="color:#76e4f7">' + (d.pesquisas?.ces || '—') + '</div><div class="nps-sub">Esforço do cliente (0–5)</div></div>' +
    '</div></div>' +

    '<script>window.onload=function(){window.print();}<\/script>' +
    '</body></html>';

    const win = window.open('', '_blank');
    if (!win) { App.Toast.err('Permita popups para gerar o PDF.'); return; }
    win.document.write(html);
    win.document.close();
    App.Toast.ok('Relatório gerado! Use Ctrl+P para salvar em PDF.');
  }

  return { abrir, gerar };
})();

window.Relatorio = Relatorio;

// ── Módulo Busca Global ───────────────────────────────────────────────────────
const BuscaGlobal = (() => {
  const _tk = () => localStorage.getItem('ge_token') || '';
  let _timer = null;

  const _modulos = {
    atendimento:  { label: 'Atendimento',       icon: '📞', cor: '#3d9070' },
    gestao:       { label: 'Gestão de Clientes', icon: '👥', cor: '#2b6cb0' },
    insatisfacao: { label: 'Insatisfação',       icon: '⚠️',  cor: '#c05621' },
    sensiveis:    { label: 'Clientes Sensíveis', icon: '💛', cor: '#b7791f' },
    recuperacao:  { label: 'Recuperação',        icon: '🔄', cor: '#276749' },
    carteira:     { label: 'Carteira',           icon: '💼', cor: '#553c9a' },
  };

  function buscar(q) {
    clearTimeout(_timer);
    const panel = document.getElementById('busca-global-panel');
    if (!panel) return;
    if (!q || q.trim().length < 2) {
      panel.hidden = true;
      return;
    }
    _timer = setTimeout(async function() {
      panel.hidden = false;
      panel.innerHTML = '<div style="padding:16px;text-align:center;color:var(--gray-400);font-size:13px">Buscando...</div>';
      const res = await fetch('/api/data/busca-global?q=' + encodeURIComponent(q.trim()), {
        headers: { Authorization: 'Bearer ' + _tk() }
      });
      if (!res || !res.ok) {
        panel.innerHTML = '<div style="padding:16px;text-align:center;color:#e53e3e;font-size:13px">Erro na busca.</div>';
        return;
      }
      const { data, total } = await res.json();
      if (!total) {
        panel.innerHTML = '<div style="padding:16px;text-align:center;color:var(--gray-400);font-size:13px">Nenhum resultado encontrado.</div>';
        return;
      }
      panel.innerHTML = '<div style="padding:8px 14px;font-size:11px;color:var(--gray-400);border-bottom:1px solid var(--gray-100);font-weight:600">' +
        total + ' resultado' + (total!==1?'s':'') + ' encontrado' + (total!==1?'s':'') +
      '</div>' +
      data.map(function(r) {
        const mod = _modulos[r.modulo] || { label: r.modulo, icon: '•', cor: '#666' };
        const dt = new Date(r.created_at).toLocaleDateString('pt-BR');
        return '<div style="padding:10px 14px;border-bottom:1px solid var(--gray-100);cursor:pointer;display:flex;gap:10px;align-items:center" ' +
          'data-modulo="' + r.modulo + '" onclick="BuscaGlobal.irPara(this.dataset.modulo)">' +
          '<span style="font-size:18px">' + mod.icon + '</span>' +
          '<div style="min-width:0;flex:1">' +
            '<div style="font-size:13px;font-weight:600;color:var(--g800)">' + (r.empresa||r.nome_empresa||'—') + '</div>' +
            (r.cliente ? '<div style="font-size:12px;color:var(--gray-500)">' + r.cliente + '</div>' : '') +
            '<div style="display:flex;gap:8px;margin-top:2px">' +
              '<span style="background:' + mod.cor + '20;color:' + mod.cor + ';padding:1px 8px;border-radius:10px;font-size:10px;font-weight:700">' + mod.label + '</span>' +
              '<span style="font-size:11px;color:var(--gray-400)">' + dt + '</span>' +
              (r.cnpj ? '<span style="font-size:11px;color:var(--gray-400)">' + r.cnpj + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }, 350);
  }

  function irPara(modulo) {
    const input = document.getElementById('busca-global-input');
    const panel = document.getElementById('busca-global-panel');
    if (input) { input.value = ''; input.style.background = 'rgba(255,255,255,.1)'; input.style.color = '#fff'; }
    if (panel) panel.hidden = true;
    App.Nav.go(modulo);
  }

  function iniciar() {
    // Fechar ao clicar fora
    document.addEventListener('click', function(e) {
      const wrap = document.getElementById('busca-global-wrap');
      const panel = document.getElementById('busca-global-panel');
      if (panel && wrap && !wrap.contains(e.target)) panel.hidden = true;
    });
    // Fechar com ESC
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        const panel = document.getElementById('busca-global-panel');
        if (panel) panel.hidden = true;
      }
    });
  }

  return { buscar, irPara, iniciar };
})();

window.BuscaGlobal = BuscaGlobal;

// ── Módulo Log de Atividades ─────────────────────────────────────────────────
const Log = (() => {
  let _data = [];
  let _page = 1;
  const _tk = () => localStorage.getItem('ge_token') || '';

  const _acaoBadge = {
    criar:   { bg:'#f0fff4', cor:'#38a169', label:'Criar'   },
    editar:  { bg:'#ebf8ff', cor:'#2b6cb0', label:'Editar'  },
    excluir: { bg:'#fff5f5', cor:'#e53e3e', label:'Excluir' },
    login:   { bg:'#faf5ff', cor:'#553c9a', label:'Login'   },
    logout:  { bg:'#f7fafc', cor:'#718096', label:'Logout'  },
  };

  const _moduloIcon = {
    atendimento: '📞', gestao: '👥', insatisfacao: '⚠️',
    sensiveis: '💛', carteira: '💼', recuperacao: '🔄',
    admin: '⚙️', log: '📋', cac: '💰',
  };

  async function carregar() {
    const tbody = document.getElementById('log-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:32px">Carregando...</td></tr>';

    const modulo = document.getElementById('log-modulo-filter')?.value || 'todos';
    const user   = document.getElementById('log-user-filter')?.value || 'todos';

    const res = await fetch('/api/data/log-atividades?modulo=' + modulo + '&user=' + user + '&limit=500', {
      headers: { Authorization: 'Bearer ' + _tk() }
    });
    if (!res || !res.ok) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#e53e3e;padding:32px">Erro ao carregar.</td></tr>';
      return;
    }
    const { data, users } = await res.json();
    _data = data || [];
    _page = 1;

    // Populate user filter
    const userSel = document.getElementById('log-user-filter');
    if (userSel && users) {
      const cur = userSel.value;
      userSel.innerHTML = '<option value="todos">Todos os usuários</option>' +
        users.map(function(u) { return '<option value="' + u.user_id + '" ' + (u.user_id===cur?'selected':'') + '>' + u.user_name + '</option>'; }).join('');
    }
    _renderGrid();
  }

  function _renderGrid() {
    const tbody = document.getElementById('log-tbody');
    if (!tbody) return;
    if (!_data.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:32px">Nenhuma atividade registrada.</td></tr>';
      return;
    }
    const paged = App.Util.paginate(_data, _page, 50);
    tbody.innerHTML = paged.items.map(function(r) {
      const acao = _acaoBadge[r.acao] || { bg:'#f7fafc', cor:'#718096', label: r.acao };
      const icon = _moduloIcon[r.modulo] || '•';
      const dt = new Date(r.created_at).toLocaleString('pt-BR');
      return '<tr>' +
        '<td style="font-size:12px;color:var(--gray-500);white-space:nowrap">' + dt + '</td>' +
        '<td style="font-weight:600">' + r.user_name + '</td>' +
        '<td><span style="background:' + acao.bg + ';color:' + acao.cor + ';padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">' + acao.label + '</span></td>' +
        '<td>' + icon + ' ' + r.modulo + '</td>' +
        '<td style="font-size:12px;color:var(--gray-500)">' + (r.descricao||'—') + '</td>' +
      '</tr>';
    }).join('');
    App.Util.renderPagination('log-pagination', paged.page, paged.pages, paged.total, 'Log.goPage');
  }

  function goPage(p) { _page = p; _renderGrid(); }

  function exportCSV() {
    if (!_data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const header = 'Data/Hora;Usuário;Ação;Módulo;Descrição';
    const rows = _data.map(function(r) {
      return '"' + new Date(r.created_at).toLocaleString('pt-BR') + '";"' + r.user_name + '";"' + r.acao + '";"' + r.modulo + '";"' + (r.descricao||'') + '"';
    });
    const csv = [header, ...rows].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'log_atividades_' + new Date().toISOString().slice(0,10) + '.csv';
    a.click(); URL.revokeObjectURL(url);
    App.Toast.ok('CSV exportado!');
  }

  async function limpar() {
    if (!confirm('Limpar todo o histórico de atividades? Esta ação não pode ser desfeita.')) return;
    const res = await fetch('/api/data/log-atividades', { method: 'DELETE', headers: { Authorization: 'Bearer ' + _tk() } });
    if (res && res.ok) { _data = []; _renderGrid(); App.Toast.ok('Log limpo.'); }
    else App.Toast.err('Erro ao limpar.');
  }

  return { carregar, goPage, exportCSV, limpar };
})();

window.Log = Log;

// ── Modo Escuro ───────────────────────────────────────────────────────────────
const DarkMode = (() => {
  const KEY = 'ge_dark_mode';

  function aplicar(ativo) {
    document.body.classList.toggle('dark-mode', ativo);
    const icon  = document.getElementById('dark-icon');
    const label = document.getElementById('dark-label');
    if (icon)  icon.textContent  = ativo ? '☀️' : '🌙';
    if (label) label.textContent = ativo ? 'Modo claro' : 'Modo escuro';
  }

  function toggle() {
    const ativo = !document.body.classList.contains('dark-mode');
    localStorage.setItem(KEY, ativo ? '1' : '0');
    aplicar(ativo);
  }

  function iniciar() {
    const salvo = localStorage.getItem(KEY);
    // Se nunca configurou, usa preferência do sistema
    const prefereSistema = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const ativo = salvo !== null ? salvo === '1' : prefereSistema;
    aplicar(ativo);
    // Ouvir mudanças do sistema (apenas se não foi configurado manualmente)
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
      if (localStorage.getItem(KEY) === null) aplicar(e.matches);
    });
  }

  return { toggle, iniciar };
})();

window.DarkMode = DarkMode;

// ── Módulo Menu do Usuário ─────────────────────────────────────────────────────
const UserMenu = (() => {
  let _open = false;
  const _tk = () => localStorage.getItem('ge_token') || '';

  function toggle() {
    const panel = document.getElementById('user-menu-panel');
    if (!panel) return;
    _open = !_open;
    panel.hidden = !_open;
    if (_open) {
      const name  = window._currentUser?.name || document.getElementById('topbar-name')?.textContent || '';
      const email = window._currentUser?.email || '';
      const nameEl  = document.getElementById('user-menu-name');
      const emailEl = document.getElementById('user-menu-email');
      if (nameEl) nameEl.textContent = name;
      if (emailEl) emailEl.textContent = email;
    }
  }

  function fechar() {
    const panel = document.getElementById('user-menu-panel');
    if (panel) panel.hidden = true;
    _open = false;
  }

  function editar() {
    fechar();
    const name  = window._currentUser?.name || '';
    const email = window._currentUser?.email || '';
    App.Modal.open('Editar meu perfil', '<div style="display:grid;gap:12px">' +
      '<div class="field"><label>Nome</label><input id="um-nome" type="text" value="' + name + '" /></div>' +
      '<div class="field"><label>E-mail</label><input id="um-email" type="email" value="' + email + '" /></div>' +
      '<div style="border-top:1px solid var(--gray-100);margin:4px 0;padding-top:12px">' +
        '<div style="font-size:13px;font-weight:700;color:var(--g800);margin-bottom:10px">Alterar senha</div>' +
        '<div class="field"><label>Senha atual <span class="req">*</span></label><input id="um-senha-atual" type="password" placeholder="Necessária para confirmar" /></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">' +
          '<div class="field"><label>Nova senha <small class="opt">(opcional)</small></label><input id="um-senha-nova" type="password" placeholder="Mínimo 6 caracteres" /></div>' +
          '<div class="field"><label>Confirmar</label><input id="um-senha-conf" type="password" placeholder="Repita a nova senha" /></div>' +
        '</div>' +
      '</div>' +
      '<button class="btn btn-primary" onclick="UserMenu.salvar()">Salvar alterações</button>' +
    '</div>');
  }

  async function salvar() {
    const nome       = document.getElementById('um-nome')?.value?.trim();
    const email      = document.getElementById('um-email')?.value?.trim();
    const senhaAtual = document.getElementById('um-senha-atual')?.value;
    const senhaNova  = document.getElementById('um-senha-nova')?.value;
    const senhaConf  = document.getElementById('um-senha-conf')?.value;

    if (!nome) { App.Toast.err('Nome é obrigatório.'); return; }
    if (!senhaAtual) { App.Toast.err('Digite sua senha atual para confirmar.'); return; }
    if (senhaNova || senhaConf) {
      if (senhaNova.length < 6) { App.Toast.err('Nova senha deve ter ao menos 6 caracteres.'); return; }
      if (senhaNova !== senhaConf) { App.Toast.err('As senhas não coincidem.'); return; }
    }

    const body = { nome, email, senhaAtual };
    if (senhaNova) body.senhaNova = senhaNova;

    const res = await fetch('/api/data/perfil', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tk() },
      body: JSON.stringify(body)
    });

    if (res && res.ok) {
      App.Modal.close();
      App.Toast.ok('Perfil atualizado!');
      const nameEl = document.getElementById('topbar-name');
      if (nameEl) nameEl.textContent = nome;
      if (window._currentUser) { window._currentUser.name = nome; window._currentUser.email = email; }
    } else {
      const err = await res.json().catch(() => ({}));
      App.Toast.err(err.error || 'Erro ao atualizar perfil.');
    }
  }

  function iniciar() {
    document.addEventListener('click', function(e) {
      const panel   = document.getElementById('user-menu-panel');
      const trigger = document.getElementById('user-menu-trigger');
      if (_open && panel && trigger && !panel.contains(e.target) && !trigger.contains(e.target)) {
        fechar();
      }
    });
  }

  return { toggle, editar, salvar, iniciar };
})();

window.UserMenu = UserMenu;

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
  handleResize();
  DarkMode.iniciar();
  (async () => { await App.Auth.tryAutoLogin(); })();
});

// ── Grade de Pesquisas ────────────────────────────────────────────────────────
const PesquisasGrid = (() => {
  async function load() {
    const tbody = document.getElementById('ps-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';

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
  let _allData = [];
  let _page = 1;  // cache de todas as respostas

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
    const mes = document.getElementById('ps-mes-filter')?.value || 'todos';
    return data.filter(r => {
      const d = new Date(r.created_at);
      if (ano !== 'todos' && d.getFullYear() !== Number(ano)) return false;
      if (mes !== 'todos' && String(d.getMonth()+1).padStart(2,'0') !== mes) return false;

      return true;
    });
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
        ? ` <button class="btn btn-success btn-sm" onclick="Pesquisas.marcarTratado(\'${r.id}\')">Tratar</button>`
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
        <td>
          <button class="btn btn-ghost btn-sm" onclick="Pesquisas.detail(${JSON.stringify(r).replace(/"/g,'&quot;')})">Ver</button>${tratarBtn}${App.Auth.isAdmin() ? `<button class="btn btn-sm" style="background:none;border:none;cursor:pointer;color:#e53e3e;font-size:16px;padding:2px 6px;margin-left:2px" onclick="Pesquisas.excluir('${r.id}')" title="Excluir">🗑</button>` : ''}
        </td>
      </tr>`;
    }).join('');
  }

  async function loadGrid() {
    const tbody = document.getElementById('ps-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';

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
    const _filt = _filterData(_allData);
    const _paged = App.Util.paginate(_filt, _page);
    _renderGrid(_paged.items);
    App.Util.renderPagination('ps-pagination', _paged.page, _paged.pages, _paged.total, 'Pesquisas.goPage');
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

  async function marcarTratado(id) {
    const tk = localStorage.getItem('ge_token') || '';
    const res = await fetch('/api/data/pesquisas/' + id + '/tratado', {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + tk }
    });
    if (res && res.ok) { App.Toast.ok('Marcado como tratado!'); loadGrid(); }
    else App.Toast.err('Erro ao marcar.');
  }

  async function excluirPesquisa(id) {
    if (!confirm('Excluir esta resposta?')) return;
    const tk = localStorage.getItem('ge_token') || '';
    const res = await fetch('/api/data/pesquisas/' + id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + tk }
    });
    if (res && res.ok) { App.Toast.ok('Excluído.'); loadGrid(); }
    else App.Toast.err('Erro ao excluir.');
  }

  function goPage(p) {
    _page = p;
    const f = _filterData(_allData);
    const pg = App.Util.paginate(f, p);
    _renderGrid(pg.items);
    App.Util.renderPagination('ps-pagination', pg.page, pg.pages, pg.total, 'Pesquisas.goPage');
  }

  return { loadGrid, exportCSV, exportPDF, limpar, detail, marcarTratado, excluirPesquisa, goPage };
})();

// Expor globalmente
window.Pesquisas = Pesquisas;

// ── Módulo Carteira ──────────────────────────────────────────────────────────
const Carteira = (() => {
  let _clientes = [];
  let _page = 1;
  function _token() { return localStorage.getItem('ge_token') || ''; }
  function _fmt(v) { return 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function _tempo(dataEntrada, dataSaida) {
    const start = new Date(dataEntrada);
    const end = dataSaida ? new Date(dataSaida) : new Date();
    const m = (end.getFullYear()-start.getFullYear())*12 + (end.getMonth()-start.getMonth());
    const anos = Math.floor(m/12); const meses = m%12;
    return anos > 0 ? `${anos}a ${meses}m` : `${meses}m`;
  }

  function _populateYearFilter(data) {
    const sel = document.getElementById('cart-ano-filter');
    if (!sel) return;
    const anos = [...new Set(data.map(r => new Date(r.data_entrada).getFullYear()))].sort((a,b)=>b-a);
    const cur = sel.value;
    sel.innerHTML = '<option value="todos">Todos os anos</option>' +
      anos.map(a=>`<option value="${a}" ${String(a)===cur?'selected':''}>${a}</option>`).join('');
  }

  function _dadosFiltrados() {
    const busca = (document.getElementById('cart-busca')?.value || '').toLowerCase().trim();
    const status = document.getElementById('cart-status-filter')?.value || 'todos';
    const ano = document.getElementById('cart-ano-filter')?.value || 'todos';
    const mes = document.getElementById('cart-mes-filter')?.value || 'todos';
    return _clientes.filter(c => {
      const d = new Date(c.data_entrada);
      if (status !== 'todos' && c.status !== status) return false;
      if (ano !== 'todos' && d.getFullYear() !== Number(ano)) return false;
      if (mes !== 'todos' && String(d.getMonth()+1).padStart(2,'0') !== mes) return false;
      if (busca && !(
        (c.nome_empresa||'').toLowerCase().includes(busca) ||
        (c.codigo||'').toLowerCase().includes(busca) ||
        (c.cnpj||'').includes(busca)
      )) return false;
      return true;
    });
  }

  function _renderGrid(data) {
    const tbody = document.getElementById('cart-tbody');
    if (!tbody) return;
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--gray-400);padding:32px">Nenhum cliente encontrado.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(c => {
      const hon = parseFloat(c.honorario_atual||c.honorario_inicial||0);
      const rec = parseFloat(c.receita_acumulada||0);
      const statusBadge = c.status==='ativo'
        ? '<span style="background:#f0fff4;color:#38a169;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">Ativo</span>'
        : '<span style="background:#fff5f5;color:#e53e3e;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">Encerrado</span>';
      // Health Score (0-100)
            const scoreRetencao = Math.min(40, Math.round(mesesRel/3));
      const scoreReceita  = rec > 0 ? Math.min(30, Math.round(rec/1000)) : 0;
      const scoreSem      = c.status==='ativo' ? 20 : 0;
      const scoreReajuste = c.meses_sem_reajuste && c.meses_sem_reajuste > 12 ? 0 : 10;
      const health = Math.min(100, scoreRetencao + scoreReceita + scoreSem + scoreReajuste);
      const healthColor = health >= 70 ? '#38a169' : health >= 40 ? '#d69e2e' : '#e53e3e';
      const healthLabel = health >= 70 ? 'Saudável' : health >= 40 ? 'Atenção' : 'Risco';
      // Reajuste alert
      const semReajuste = c.meses_sem_reajuste || 0;
      const reajusteAlert = semReajuste > 12 && c.status==='ativo'
        ? `<span title="Sem reajuste há ${semReajuste} meses" style="color:#d69e2e;font-size:14px;margin-left:4px">⚠️</span>` : '';
      return `<tr>
        <td style="font-size:11px;color:var(--gray-400);font-weight:600">${c.codigo||'—'}</td>
        <td style="font-weight:600">${c.nome_empresa}${reajusteAlert}</td>
        <td style="font-size:12px;color:var(--gray-500)">${c.cnpj}</td>
        <td style="font-weight:600;color:var(--g700)">${_fmt(hon)}</td>
        <td>${_fmt(rec)}</td>
        <td style="font-size:12px;color:var(--gray-500)">${_tempo(c.data_entrada, c.data_saida)}</td>
        <td style="font-size:12px;color:var(--gray-500)">${c.origem||'—'}</td>
        <td><span style="background:${healthColor}20;color:${healthColor};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${healthLabel}</span></td>
        <td>${statusBadge}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-ghost btn-sm" onclick="Carteira.verFicha('${c.id}')">Ver ficha</button>
          ${c.status==='ativo' && App.Auth.isAdmin() ? `<button class="btn btn-sm" style="background:none;border:none;cursor:pointer;color:#1D9E75;font-size:14px;padding:2px 6px" onclick="Carteira.atualizarHonorario('${c.id}')" title="Atualizar honorário">$ +</button>` : ''}
          ${App.Auth.isAdmin() ? `<button class="btn btn-sm" style="background:none;border:none;cursor:pointer;color:#e53e3e;font-size:16px;padding:2px 6px" onclick="Carteira.excluir('${c.id}')" title="Excluir">🗑</button>` : ''}
        </td>
      </tr>`;
    }).join('');
  }

  async function load() {
    await Promise.all([loadDashboard(), loadGrid()]);
  }

  async function loadDashboard() {
    const res = await fetch('/api/data/carteira/dashboard', {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!res || !res.ok) return;
    const d = await res.json();
    const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
    set('cart-mrr', _fmt(d.mrr));
    set('cart-arr', _fmt(d.arr));
    set('cart-ativos', d.ativos);
    set('cart-ticket', _fmt(d.ticket_medio));
    set('cart-ltv-medio', _fmt(d.ltv_medio_projetado));
    set('cart-encerrados-sub', `${d.encerrados} encerrado${d.encerrados!==1?'s':''}`);
    const meses = Math.round(d.retencao_media_meses||0);
    const anos = Math.floor(meses/12); const m = meses%12;
    set('cart-retencao', meses>0?(anos>0?`${anos}a ${m}m`:`${m} meses`):'—');
  }

  async function loadGrid() {
    const tbody = document.getElementById('cart-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--gray-400);padding:32px">Carregando...</td></tr>';
    const res = await fetch('/api/data/clientes?status=todos', {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!res || !res.ok) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#e53e3e;padding:32px">Erro ao carregar.</td></tr>';
      return;
    }
    const { data } = await res.json();
    _clientes = data || [];
    _populateYearFilter(_clientes);
    const receitaTotal = _clientes.reduce((s,c) => s + parseFloat(c.receita_acumulada||0), 0);
    const el = document.getElementById('cart-receita-total');
    if (el) el.textContent = _fmt(receitaTotal);
    // Alerta de reajuste
    const semReajuste = _clientes.filter(c => c.status==='ativo' && (c.meses_sem_reajuste||0) > 12);
    const alertEl = document.getElementById('cart-alert-reajuste');
    if (alertEl) {
      alertEl.hidden = semReajuste.length === 0;
      alertEl.textContent = semReajuste.length > 0
        ? '⚠️ ' + semReajuste.length + ' cliente' + (semReajuste.length!==1?'s':'') + ' sem reajuste há mais de 12 meses'
        : '';
    }
    filtrar();
  }

  function filtrar() {
    _page = 1;
    const f = _dadosFiltrados();
    const pg = App.Util.paginate(f, _page, 20);
    _renderGrid(pg.items);
    App.Util.renderPagination('cart-pagination', pg.page, pg.pages, pg.total, 'Carteira.goPage');
  }

  function exportCSV() {
    const data = _dadosFiltrados();
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['codigo','nome_empresa','cnpj','honorario_atual','receita_acumulada','data_entrada','status','origem','cac'];
    const labels = {codigo:'Código',nome_empresa:'Empresa',cnpj:'CNPJ',honorario_atual:'Honorário',
      receita_acumulada:'Receita Acumulada',data_entrada:'Data Entrada',status:'Status',origem:'Origem',cac:'CAC'};
    const header = cols.map(c=>labels[c]).join(';');
    const rows = data.map(r=>cols.map(c=>`"${(r[c]??'').toString().replace(/"/g,'""')}"`).join(';'));
    const csv = [header,...rows].join('\n');
    const blob = new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href=url; a.download=`carteira_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    App.Toast.ok('CSV exportado!');
  }

  function exportPDF() {
    const data = _dadosFiltrados();
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const status = document.getElementById('cart-status-filter')?.value || 'todos';
    const ano = document.getElementById('cart-ano-filter')?.value || 'todos';
    const titulo = `Análise da Carteira — ${status==='todos'?'Todos':status==='ativo'?'Ativos':'Encerrados'} / ${ano==='todos'?'Todos os anos':ano}`;
    const cols = ['codigo','nome_empresa','cnpj','honorario_atual','receita_acumulada','data_entrada','status','origem'];
    const labels = {codigo:'Código',nome_empresa:'Empresa',cnpj:'CNPJ',honorario_atual:'Honorário',
      receita_acumulada:'Rec. Acumulada',data_entrada:'Entrada',status:'Status',origem:'Origem'};
    const rows = data.map(r=>`<tr>${cols.map(c=>{
      let v=r[c]??'—';
      if(c==='honorario_atual'||c==='receita_acumulada') v=_fmt(parseFloat(v)||0);
      if(c==='data_entrada'&&v!=='—') v=new Date(v).toLocaleDateString('pt-BR');
      return `<td>${v}</td>`;
    }).join('')}</tr>`).join('');
    const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${titulo}</title>
    <style>body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#222}
    h1{font-size:15px;color:#1a4233;margin-bottom:4px}p.sub{color:#666;font-size:11px;margin-bottom:12px}
    table{width:100%;border-collapse:collapse;font-size:10px}
    th{background:#1a4233;color:#fff;padding:6px 8px;text-align:left}
    td{padding:5px 8px;border-bottom:1px solid #eee}tr:nth-child(even) td{background:#f8f8f8}
    @media print{body{margin:10px}}</style></head><body>
    <h1>Grupo-E — ${titulo}</h1>
    <p class="sub">Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${data.length} cliente${data.length!==1?'s':''}</p>
    <table><thead><tr>${cols.map(c=>`<th>${labels[c]}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody></table>
    <script>window.onload=()=>{window.print();}<\/script></body></html>`;
    const win=window.open('','_blank');
    if(!win){App.Toast.err('Permita popups para exportar PDF.');return;}
    win.document.write(html);win.document.close();
    App.Toast.ok('PDF gerado — use Ctrl+P para salvar!');
  }

  async function limpar() {
    if (!App.Auth.isAdmin()) { App.Toast.err('Acesso restrito a administradores.'); return; }
    const total = _clientes.length;
    if (!total) { App.Toast.err('Não há clientes para remover.'); return; }
    const confirmado = await new Promise(resolve => {
      App.Modal.open('⚠️ Confirmar limpeza',
        `<div style="text-align:center;padding:10px 0">
          <p style="font-size:15px;margin-bottom:8px">Você está prestes a <strong>excluir permanentemente</strong></p>
          <p style="font-size:28px;font-weight:800;color:#e53e3e;margin:12px 0">${total} cliente${total!==1?'s':''}</p>
          <p style="color:var(--gray-500);font-size:13px">Todo o histórico de honorários e eventos será perdido.</p>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
            <button class="btn btn-ghost" onclick="App.Modal.close()">Cancelar</button>
            <button class="btn" style="background:#e53e3e;color:#fff;border:none"
              onclick="document.dispatchEvent(new CustomEvent('cart-confirm-limpar'))">Sim, limpar tudo</button>
          </div>
        </div>`, () => resolve(false), { noFooter: true });
      document.addEventListener('cart-confirm-limpar', () => { App.Modal.close(); resolve(true); }, {once:true});
    });
    if (!confirmado) return;
    const res = await fetch('/api/data/clientes/clear', {
      method:'DELETE', headers:{'Authorization':`Bearer ${_token()}`}
    });
    if (res && res.ok) {
      _clientes=[]; _renderGrid([]); await loadDashboard();
      App.Toast.ok('Todos os clientes foram removidos.');
    } else { App.Toast.err('Erro ao limpar.'); }
  }

  async function excluir(id) {
    if (!App.Auth.isAdmin()) return;
    const res = await fetch(`/api/data/clientes/${id}`, {
      method:'DELETE', headers:{'Authorization':`Bearer ${_token()}`}
    });
    if (res && res.ok) {
      _clientes = _clientes.filter(c=>c.id!==id);
      filtrar(); await loadDashboard();
      App.Toast.ok('Cliente excluído.');
    } else { App.Toast.err('Erro ao excluir.'); }
  }

  async function atualizarHonorario(id) {
    App.Modal.open('Atualizar honorário', `
      <div style="display:grid;gap:12px">
        <div class="field"><label>Novo valor (R$) <span class="req">*</span></label><input id="h-valor" type="number" min="0" step="0.01" placeholder="0,00" /></div>
        <div class="field"><label>Data de vigência <span class="req">*</span></label><input id="h-data" type="date" /></div>
        <div class="field"><label>Observação</label><input id="h-obs" type="text" placeholder="Ex: Reajuste IPCA 2026" /></div>
        <button class="btn btn-primary" onclick="Carteira.salvarHonorario('${id}')">Salvar</button>
      </div>
    `);
  }

  async function salvarHonorario(id) {
    const valor = document.getElementById('h-valor')?.value;
    const data = document.getElementById('h-data')?.value;
    const obs = document.getElementById('h-obs')?.value;
    if (!valor || !data) { App.Toast.err('Valor e data são obrigatórios.'); return; }
    const res = await fetch(`/api/data/clientes/${id}/honorario`, {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${_token()}`},
      body: JSON.stringify({ valor: parseFloat(valor), data_vigencia: data, obs })
    });
    if (res && res.ok) {
      App.Modal.close(); App.Toast.ok('Honorário atualizado!'); await load();
    } else { App.Toast.err('Erro ao atualizar honorário.'); }
  }

  async function verFicha(id) {
    const res = await fetch(`/api/data/clientes/${id}`, {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!res || !res.ok) { App.Toast.err('Erro ao carregar ficha.'); return; }
    const { cliente: c, honorarios, eventos } = await res.json();
    const honAtual = honorarios[0]?.valor || c.honorario_inicial;
    const timeline = eventos.slice(0,5).map(e => {
      const tipo = {entrada:'🟢',reajuste:'💰',saida:'🔴',baixa:'🔴',upgrade:'⬆️'}[e.tipo]||'•';
      return `<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:0.5px solid var(--gray-100)">
        <span style="font-size:16px">${tipo}</span>
        <div><div style="font-size:13px;font-weight:500">${e.descricao||e.tipo}</div>
        <div style="font-size:11px;color:var(--gray-400)">${new Date(e.data_evento).toLocaleDateString('pt-BR')}${e.valor_novo?' — '+_fmt(e.valor_novo):''}</div></div>
      </div>`;
    }).join('');
    App.Modal.open(`Ficha — ${c.nome_empresa}`, `
      <div style="display:grid;gap:14px">
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;background:var(--gray-50);padding:14px;border-radius:8px">
          <div style="text-align:center"><div style="font-size:11px;color:var(--gray-400);margin-bottom:4px">Honorário atual</div><div style="font-size:18px;font-weight:600;color:var(--g700)">${_fmt(honAtual)}</div></div>
          <div style="text-align:center"><div style="font-size:11px;color:var(--gray-400);margin-bottom:4px">Receita acumulada</div><div style="font-size:18px;font-weight:600;color:var(--g700)">${_fmt(c.receita_acumulada||0)}</div></div>
          <div style="text-align:center"><div style="font-size:11px;color:var(--gray-400);margin-bottom:4px">Tempo de relac.</div><div style="font-size:18px;font-weight:600;color:var(--g700)">${_tempo(c.data_entrada, c.data_saida)}</div></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
          <div><strong>MRR:</strong> ${_fmt(honAtual)}</div>
          <div><strong>ARR:</strong> ${_fmt(honAtual*12)}</div>
          <div><strong>Código:</strong> ${c.codigo||'—'}</div>
          <div><strong>Origem:</strong> ${c.origem||'—'}</div>
          <div><strong>CAC:</strong> ${_fmt(c.cac)}</div>
          <div><strong>Regime:</strong> ${c.regime_tributario||'—'}</div>
          <div><strong>Status:</strong> ${c.status}</div>
        </div>
        <div><strong style="font-size:13px">Histórico de honorários</strong>
          <div style="margin-top:6px">
          ${honorarios.map(h=>`<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:0.5px solid var(--gray-100);font-size:12px">
            <span>${new Date(h.data_vigencia).toLocaleDateString('pt-BR')}</span>
            <span style="font-weight:500">${_fmt(h.valor)}</span>
            ${h.obs?`<span style="color:var(--gray-400)">${h.obs}</span>`:''}
          </div>`).join('')}
          </div>
        </div>
        <div><strong style="font-size:13px">Timeline</strong><div style="margin-top:6px">${timeline||'<p style="color:var(--gray-400);font-size:12px">Sem eventos registrados.</p>'}</div></div>
      </div>
    `);
  }

  function goPage(p) { _page = p; const f = _dadosFiltrados(); const pg = App.Util.paginate(f, p, 20); _renderGrid(pg.items); App.Util.renderPagination('cart-pagination', pg.page, pg.pages, pg.total, 'Carteira.goPage'); }
  return { load, loadDashboard, loadGrid, filtrar, goPage, atualizarHonorario, salvarHonorario, verFicha, exportCSV, exportPDF, limpar, excluir };
})();

window.Carteira = Carteira;

// ── Módulo Atendimento ─────────────────────────────────────────────────────────────
const Atendimento = (() => {
  let _allData = [];
  let _page = 1;
  function _token() { return localStorage.getItem('ge_token') || ''; }

  function _populateYearFilter(data) {
    const sel = document.getElementById('at-ano-filter');
    if (!sel) return;
    const anos = [...new Set(data.map(r => new Date(r.created_at).getFullYear()))].sort((a,b)=>b-a);
    const cur = sel.value;
    sel.innerHTML = '<option value="todos">Todos os anos</option>' +
      anos.map(a=>`<option value="${a}" ${String(a)===cur?'selected':''}>${a}</option>`).join('');
  }

  function _filterData(data) {
    const ano = document.getElementById('at-ano-filter')?.value || 'todos';
    const mes = document.getElementById('at-mes-filter')?.value || 'todos';
    return data.filter(r => {
      const d = new Date(r.created_at);
      if (ano !== 'todos' && d.getFullYear() !== Number(ano)) return false;
      if (mes !== 'todos' && String(d.getMonth()+1).padStart(2,'0') !== mes) return false;

      return true;
    });
  }

  function _renderGrid(data) {
    const tbody = document.getElementById('at-tbody');
    if (!tbody) return;
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--gray-400);padding:24px">Nenhum registro encontrado.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(r => {
      const d = new Date(r.created_at).toLocaleString('pt-BR');
      const lixeira = App.Auth.isAdmin() ? `<button class="btn btn-sm" style="background:none;border:none;cursor:pointer;color:#e53e3e;font-size:16px;padding:2px 6px" onclick="Atendimento.excluir('${r.id}')" title="Excluir">🗑</button>` : '';
      return `<tr>
        <td style="font-size:12px;color:var(--gray-500)">${d}</td>
        <td>${r.analista}</td>
        <td style="font-weight:600">${r.cliente}</td>
        <td style="font-size:12px">${r.cnpj||'—'}</td>
        <td>${r.empresa}</td>
        <td>${r.departamento||'—'}</td>
        <td>${r.procurado||'—'}</td>
        <td style="font-size:12px;max-width:130px;word-break:break-word">${r.demanda}</td>
        <td style="font-size:12px;color:var(--gray-500);max-width:130px;word-break:break-word">${r.resumo||'—'}</td>
        <td>${lixeira}</td></tr>`;
    }).join('');
  }

  async function loadGrid() {
    const tbody = document.getElementById('at-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';
    const res = await fetch('/api/data/atendimentos?period=todos', {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!res || !res.ok) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#e53e3e;padding:24px">Erro ao carregar.</td></tr>';
      return;
    }
    const { data } = await res.json();
    _allData = data || [];
    _populateYearFilter(_allData);
    const _filtered = _filterData(_allData);
    const _paged = App.Util.paginate(_filtered, _page);
    _renderGrid(_paged.items);
    App.Util.renderPagination('at-pagination', _paged.page, _paged.pages, _paged.total, 'Atendimento.goPage');
  }

  function exportCSV() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at', 'analista', 'cliente', 'cnpj', 'empresa', 'departamento', 'demanda', 'resumo'];
    const labels = {'created_at':'Data','analista':'Analista','cliente':'Cliente','cnpj':'CNPJ','empresa':'Empresa','departamento':'Departamento','demanda':'Demanda','resumo':'Resumo'};
    const header = cols.map(c=>labels[c]||c).join(';');
    const rows = data.map(r => cols.map(c => {
      let v = r[c] ?? '';
      if (c==='created_at') v = new Date(v).toLocaleString('pt-BR');
      return `"${String(v).replace(/"/g,'""')}"`;
    }).join(';'));
    const csv = [header,...rows].join('\n');
    const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ano = document.getElementById('at-ano-filter')?.value||'todos';
    const mes = document.getElementById('at-mes-filter')?.value||'todos';
    a.href=url; a.download=`atendimentos_${ano}_${mes}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    App.Toast.ok('CSV exportado!');
  }

  function exportPDF() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at', 'analista', 'cliente', 'cnpj', 'empresa', 'departamento', 'demanda', 'resumo'];
    const labels = {'created_at':'Data','analista':'Analista','cliente':'Cliente','cnpj':'CNPJ','empresa':'Empresa','departamento':'Departamento','demanda':'Demanda','resumo':'Resumo'};
    const ano = document.getElementById('at-ano-filter')?.value||'todos';
    const mes = document.getElementById('at-mes-filter')?.value||'todos';
    const titulo = `Atendimento — ${ano==='todos'?'Todos os anos':ano} / ${mes==='todos'?'Todos os meses':mes}`;
    const rows = data.map(r=>`<tr>${cols.map(c=>{let v=r[c]??'—';if(c==='created_at')v=new Date(v).toLocaleString('pt-BR');return`<td>${v}</td>`;})}</tr>`).join('');
    const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${titulo}</title>
    <style>body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#222}
    h1{font-size:15px;color:#1a4233;margin-bottom:4px}p.sub{color:#666;font-size:11px;margin-bottom:12px}
    table{width:100%;border-collapse:collapse;font-size:10px}
    th{background:#1a4233;color:#fff;padding:6px 8px;text-align:left}
    td{padding:5px 8px;border-bottom:1px solid #eee}tr:nth-child(even) td{background:#f8f8f8}
    @media print{body{margin:10px}}</style></head><body>
    <h1>Grupo-E — ${titulo}</h1>
    <p class="sub">Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${data.length} registros</p>
    <table><thead><tr>${cols.map(c=>`<th>${labels[c]||c}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody></table>
    <script>window.onload=()=>{window.print();}<\/script></body></html>`;
    const win=window.open('','_blank');
    if(!win){App.Toast.err('Permita popups para exportar PDF.');return;}
    win.document.write(html);win.document.close();
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
          <p style="font-size:28px;font-weight:800;color:#e53e3e;margin:12px 0">${total} registro${total!==1?'s':''}</p>
          <p style="color:var(--gray-500);font-size:13px">Esta ação não pode ser desfeita.</p>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
            <button class="btn btn-ghost" onclick="App.Modal.close()">Cancelar</button>
            <button class="btn" style="background:#e53e3e;color:#fff;border:none"
              onclick="document.dispatchEvent(new CustomEvent('at-confirm-limpar'))">Sim, limpar tudo</button>
          </div>
        </div>`, () => resolve(false), { noFooter: true });
      document.addEventListener('at-confirm-limpar', () => { App.Modal.close(); resolve(true); }, {once:true});
    });
    if (!confirmado) return;
    const res = await fetch('/api/data/atendimentos/clear', {
      method:'DELETE', headers:{'Authorization':`Bearer ${_token()}`}
    });
    if (res && res.ok) {
      _allData=[]; _renderGrid([]); _populateYearFilter([]);
      App.Toast.ok('Todos os registros foram removidos.');
    } else { App.Toast.err('Erro ao limpar registros.'); }
  }

  async function excluir(id) {
    if (!App.Auth.isAdmin()) return;
    const res = await fetch(`/api/data/atendimentos/${id}`, {
      method:'DELETE', headers:{'Authorization':`Bearer ${_token()}`}
    });
    if (res && res.ok) {
      _allData = _allData.filter(r=>r.id!==id);
      _renderGrid(_filterData(_allData));
      App.Toast.ok('Registro excluído.');
    } else { App.Toast.err('Erro ao excluir.'); }
  }

  function goPage(p) { _page = p; const f = _filterData(_allData); const pg = App.Util.paginate(f, p); _renderGrid(pg.items); App.Util.renderPagination('at-pagination', pg.page, pg.pages, pg.total, 'Atendimento.goPage'); }
  return { loadGrid, exportCSV, exportPDF, limpar, excluir, goPage };
})();

window.Atendimento = Atendimento;

// ── Módulo Gestão de Clientes ─────────────────────────────────────────────────────────────
const Gestao = (() => {
  let _allData = [];
  let _page = 1;
  function _token() { return localStorage.getItem('ge_token') || ''; }

  function _populateYearFilter(data) {
    const sel = document.getElementById('gc-ano-filter');
    if (!sel) return;
    const anos = [...new Set(data.map(r => new Date(r.created_at).getFullYear()))].sort((a,b)=>b-a);
    const cur = sel.value;
    sel.innerHTML = '<option value="todos">Todos os anos</option>' +
      anos.map(a=>`<option value="${a}" ${String(a)===cur?'selected':''}>${a}</option>`).join('');
  }

  function _filterData(data) {
    const ano = document.getElementById('gc-ano-filter')?.value || 'todos';
    const mes = document.getElementById('gc-mes-filter')?.value || 'todos';
    return data.filter(r => {
      const d = new Date(r.created_at);
      if (ano !== 'todos' && d.getFullYear() !== Number(ano)) return false;
      if (mes !== 'todos' && String(d.getMonth()+1).padStart(2,'0') !== mes) return false;

      return true;
    });
  }

  function _renderGrid(data) {
    const tbody = document.getElementById('gc-tbody');
    if (!tbody) return;
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--gray-400);padding:24px">Nenhum registro encontrado.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(r => {
      const d = new Date(r.created_at).toLocaleString('pt-BR');
      const lixeira = App.Auth.isAdmin() ? `<button class="btn btn-sm" style="background:none;border:none;cursor:pointer;color:#e53e3e;font-size:16px;padding:2px 6px" onclick="Gestao.excluir('${r.id}')" title="Excluir">🗑</button>` : '';
      return `<tr>
        <td style="font-size:12px;color:var(--gray-500)">${d}</td>
        <td>${r.analista}</td>
        <td style="font-size:11px;color:var(--gray-400);font-weight:600">${r.codigo||'—'}</td>
        <td style="font-size:12px">${r.cnpj||'—'}</td>
        <td style="font-weight:600">${r.empresa}</td>
        <td>${r.solicitacao}</td>
        <td>${r.canal||'—'}</td>
        <td style="font-size:12px;color:var(--gray-500)">${r.data_sol ? new Date(r.data_sol).toLocaleDateString('pt-BR') : '—'}</td>
        <td style="font-size:12px;color:var(--gray-500)">${r.competencia ? new Date(r.competencia).toLocaleDateString('pt-BR') : '—'}</td>
        <td>${lixeira}</td></tr>`;
    }).join('');
  }

  async function loadGrid() {
    const tbody = document.getElementById('gc-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';
    const res = await fetch('/api/data/gestao?period=todos', {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!res || !res.ok) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#e53e3e;padding:24px">Erro ao carregar.</td></tr>';
      return;
    }
    const { data } = await res.json();
    _allData = data || [];
    _populateYearFilter(_allData);
    const _filtered = _filterData(_allData);
    const _paged = App.Util.paginate(_filtered, _page);
    _renderGrid(_paged.items);
    App.Util.renderPagination('gc-pagination', _paged.page, _paged.pages, _paged.total, 'Gestao.goPage');
  }

  function exportCSV() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at', 'analista', 'cnpj', 'empresa', 'solicitacao', 'canal', 'motivo'];
    const labels = {'created_at':'Data','analista':'Analista','cnpj':'CNPJ','empresa':'Empresa','solicitacao':'Solicitação','canal':'Canal','motivo':'Motivo'};
    const header = cols.map(c=>labels[c]||c).join(';');
    const rows = data.map(r => cols.map(c => {
      let v = r[c] ?? '';
      if (c==='created_at') v = new Date(v).toLocaleString('pt-BR');
      return `"${String(v).replace(/"/g,'""')}"`;
    }).join(';'));
    const csv = [header,...rows].join('\n');
    const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ano = document.getElementById('gc-ano-filter')?.value||'todos';
    const mes = document.getElementById('gc-mes-filter')?.value||'todos';
    a.href=url; a.download=`gestao_${ano}_${mes}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    App.Toast.ok('CSV exportado!');
  }

  function exportPDF() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at', 'analista', 'cnpj', 'empresa', 'solicitacao', 'canal', 'motivo'];
    const labels = {'created_at':'Data','analista':'Analista','cnpj':'CNPJ','empresa':'Empresa','solicitacao':'Solicitação','canal':'Canal','motivo':'Motivo'};
    const ano = document.getElementById('gc-ano-filter')?.value||'todos';
    const mes = document.getElementById('gc-mes-filter')?.value||'todos';
    const titulo = `Gestão de Clientes — ${ano==='todos'?'Todos os anos':ano} / ${mes==='todos'?'Todos os meses':mes}`;
    const rows = data.map(r=>`<tr>${cols.map(c=>{let v=r[c]??'—';if(c==='created_at')v=new Date(v).toLocaleString('pt-BR');return`<td>${v}</td>`;})}</tr>`).join('');
    const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${titulo}</title>
    <style>body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#222}
    h1{font-size:15px;color:#1a4233;margin-bottom:4px}p.sub{color:#666;font-size:11px;margin-bottom:12px}
    table{width:100%;border-collapse:collapse;font-size:10px}
    th{background:#1a4233;color:#fff;padding:6px 8px;text-align:left}
    td{padding:5px 8px;border-bottom:1px solid #eee}tr:nth-child(even) td{background:#f8f8f8}
    @media print{body{margin:10px}}</style></head><body>
    <h1>Grupo-E — ${titulo}</h1>
    <p class="sub">Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${data.length} registros</p>
    <table><thead><tr>${cols.map(c=>`<th>${labels[c]||c}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody></table>
    <script>window.onload=()=>{window.print();}<\/script></body></html>`;
    const win=window.open('','_blank');
    if(!win){App.Toast.err('Permita popups para exportar PDF.');return;}
    win.document.write(html);win.document.close();
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
          <p style="font-size:28px;font-weight:800;color:#e53e3e;margin:12px 0">${total} registro${total!==1?'s':''}</p>
          <p style="color:var(--gray-500);font-size:13px">Esta ação não pode ser desfeita.</p>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
            <button class="btn btn-ghost" onclick="App.Modal.close()">Cancelar</button>
            <button class="btn" style="background:#e53e3e;color:#fff;border:none"
              onclick="document.dispatchEvent(new CustomEvent('gc-confirm-limpar'))">Sim, limpar tudo</button>
          </div>
        </div>`, () => resolve(false), { noFooter: true });
      document.addEventListener('gc-confirm-limpar', () => { App.Modal.close(); resolve(true); }, {once:true});
    });
    if (!confirmado) return;
    const res = await fetch('/api/data/gestao/clear', {
      method:'DELETE', headers:{'Authorization':`Bearer ${_token()}`}
    });
    if (res && res.ok) {
      _allData=[]; _renderGrid([]); _populateYearFilter([]);
      App.Toast.ok('Todos os registros foram removidos.');
    } else { App.Toast.err('Erro ao limpar registros.'); }
  }

  async function excluir(id) {
    if (!App.Auth.isAdmin()) return;
    const res = await fetch(`/api/data/gestao/${id}`, {
      method:'DELETE', headers:{'Authorization':`Bearer ${_token()}`}
    });
    if (res && res.ok) {
      _allData = _allData.filter(r=>r.id!==id);
      _renderGrid(_filterData(_allData));
      App.Toast.ok('Registro excluído.');
    } else { App.Toast.err('Erro ao excluir.'); }
  }

  function goPage(p) { _page = p; const f = _filterData(_allData); const pg = App.Util.paginate(f, p); _renderGrid(pg.items); App.Util.renderPagination('gc-pagination', pg.page, pg.pages, pg.total, 'Gestao.goPage'); }
  return { loadGrid, exportCSV, exportPDF, limpar, excluir, goPage };
})();

window.Gestao = Gestao;

// ── Módulo Recuperação de Experiência ─────────────────────────────────────────────────────────────
const Recuperacao = (() => {
  let _allData = [];
  let _page = 1;
  function _token() { return localStorage.getItem('ge_token') || ''; }

  function _populateYearFilter(data) {
    const sel = document.getElementById('rc-ano-filter');
    if (!sel) return;
    const anos = [...new Set(data.map(r => new Date(r.created_at).getFullYear()))].sort((a,b)=>b-a);
    const cur = sel.value;
    sel.innerHTML = '<option value="todos">Todos os anos</option>' +
      anos.map(a=>`<option value="${a}" ${String(a)===cur?'selected':''}>${a}</option>`).join('');
  }

  function _filterData(data) {
    const ano = document.getElementById('rc-ano-filter')?.value || 'todos';
    const mes = document.getElementById('rc-mes-filter')?.value || 'todos';
    return data.filter(r => {
      const d = new Date(r.created_at);
      if (ano !== 'todos' && d.getFullYear() !== Number(ano)) return false;
      if (mes !== 'todos' && String(d.getMonth()+1).padStart(2,'0') !== mes) return false;

      return true;
    });
  }

  function _renderGrid(data) {
    const tbody = document.getElementById('rc-tbody');
    if (!tbody) return;
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--gray-400);padding:24px">Nenhum registro encontrado.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(r => {
      const d = new Date(r.created_at).toLocaleString('pt-BR');
      const lixeira = App.Auth.isAdmin() ? `<button class="btn btn-sm" style="background:none;border:none;cursor:pointer;color:#e53e3e;font-size:16px;padding:2px 6px" onclick="Recuperacao.excluir('${r.id}')" title="Excluir">🗑</button>` : '';
      const gc={'Muito Alta':'#e53e3e','Alta':'#dd6b20','Média':'#d69e2e','Baixa':'#38a169','Muito Baixa':'#2b6cb0'}[r.gravidade]||'#718096';
      return `<tr>
        <td style="font-size:12px;color:var(--gray-500)">${d}</td>
        <td>${r.analista}</td><td style="font-weight:600">${r.cliente}</td>
        <td style="font-size:12px">${r.cnpj||'—'}</td><td>${r.empresa}</td>
        <td><span style="background:${gc}20;color:${gc};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${r.gravidade}</span></td>
        <td style="font-size:12px;color:var(--gray-500);max-width:150px;word-break:break-word">${r.demonstrou}</td>
        <td>${lixeira}</td></tr>`;
    }).join('');
  }

  async function loadGrid() {
    const tbody = document.getElementById('rc-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';
    const res = await fetch('/api/data/recuperacoes?period=todos', {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!res || !res.ok) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#e53e3e;padding:24px">Erro ao carregar.</td></tr>';
      return;
    }
    const { data } = await res.json();
    _allData = data || [];
    _populateYearFilter(_allData);
    const _filtered = _filterData(_allData);
    const _paged = App.Util.paginate(_filtered, _page);
    _renderGrid(_paged.items);
    App.Util.renderPagination('rc-pagination', _paged.page, _paged.pages, _paged.total, 'Recuperacao.goPage');
  }

  function exportCSV() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at', 'analista', 'cliente', 'cnpj', 'empresa', 'gravidade', 'demonstrou'];
    const labels = {'created_at':'Data','analista':'Analista','cliente':'Cliente','cnpj':'CNPJ','empresa':'Empresa','gravidade':'Gravidade','demonstrou':'Demonstrou'};
    const header = cols.map(c=>labels[c]||c).join(';');
    const rows = data.map(r => cols.map(c => {
      let v = r[c] ?? '';
      if (c==='created_at') v = new Date(v).toLocaleString('pt-BR');
      return `"${String(v).replace(/"/g,'""')}"`;
    }).join(';'));
    const csv = [header,...rows].join('\n');
    const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ano = document.getElementById('rc-ano-filter')?.value||'todos';
    const mes = document.getElementById('rc-mes-filter')?.value||'todos';
    a.href=url; a.download=`recuperacoes_${ano}_${mes}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    App.Toast.ok('CSV exportado!');
  }

  function exportPDF() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at', 'analista', 'cliente', 'cnpj', 'empresa', 'gravidade', 'demonstrou'];
    const labels = {'created_at':'Data','analista':'Analista','cliente':'Cliente','cnpj':'CNPJ','empresa':'Empresa','gravidade':'Gravidade','demonstrou':'Demonstrou'};
    const ano = document.getElementById('rc-ano-filter')?.value||'todos';
    const mes = document.getElementById('rc-mes-filter')?.value||'todos';
    const titulo = `Recuperação de Experiência — ${ano==='todos'?'Todos os anos':ano} / ${mes==='todos'?'Todos os meses':mes}`;
    const rows = data.map(r=>`<tr>${cols.map(c=>{let v=r[c]??'—';if(c==='created_at')v=new Date(v).toLocaleString('pt-BR');return`<td>${v}</td>`;})}</tr>`).join('');
    const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${titulo}</title>
    <style>body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#222}
    h1{font-size:15px;color:#1a4233;margin-bottom:4px}p.sub{color:#666;font-size:11px;margin-bottom:12px}
    table{width:100%;border-collapse:collapse;font-size:10px}
    th{background:#1a4233;color:#fff;padding:6px 8px;text-align:left}
    td{padding:5px 8px;border-bottom:1px solid #eee}tr:nth-child(even) td{background:#f8f8f8}
    @media print{body{margin:10px}}</style></head><body>
    <h1>Grupo-E — ${titulo}</h1>
    <p class="sub">Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${data.length} registros</p>
    <table><thead><tr>${cols.map(c=>`<th>${labels[c]||c}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody></table>
    <script>window.onload=()=>{window.print();}<\/script></body></html>`;
    const win=window.open('','_blank');
    if(!win){App.Toast.err('Permita popups para exportar PDF.');return;}
    win.document.write(html);win.document.close();
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
          <p style="font-size:28px;font-weight:800;color:#e53e3e;margin:12px 0">${total} registro${total!==1?'s':''}</p>
          <p style="color:var(--gray-500);font-size:13px">Esta ação não pode ser desfeita.</p>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
            <button class="btn btn-ghost" onclick="App.Modal.close()">Cancelar</button>
            <button class="btn" style="background:#e53e3e;color:#fff;border:none"
              onclick="document.dispatchEvent(new CustomEvent('rc-confirm-limpar'))">Sim, limpar tudo</button>
          </div>
        </div>`, () => resolve(false), { noFooter: true });
      document.addEventListener('rc-confirm-limpar', () => { App.Modal.close(); resolve(true); }, {once:true});
    });
    if (!confirmado) return;
    const res = await fetch('/api/data/recuperacoes/clear', {
      method:'DELETE', headers:{'Authorization':`Bearer ${_token()}`}
    });
    if (res && res.ok) {
      _allData=[]; _renderGrid([]); _populateYearFilter([]);
      App.Toast.ok('Todos os registros foram removidos.');
    } else { App.Toast.err('Erro ao limpar registros.'); }
  }

  async function excluir(id) {
    if (!App.Auth.isAdmin()) return;
    const res = await fetch(`/api/data/recuperacoes/${id}`, {
      method:'DELETE', headers:{'Authorization':`Bearer ${_token()}`}
    });
    if (res && res.ok) {
      _allData = _allData.filter(r=>r.id!==id);
      _renderGrid(_filterData(_allData));
      App.Toast.ok('Registro excluído.');
    } else { App.Toast.err('Erro ao excluir.'); }
  }

  function goPage(p) { _page = p; const f = _filterData(_allData); const pg = App.Util.paginate(f, p); _renderGrid(pg.items); App.Util.renderPagination('rc-pagination', pg.page, pg.pages, pg.total, 'Recuperacao.goPage'); }
  return { loadGrid, exportCSV, exportPDF, limpar, excluir, goPage };
})();

window.Recuperacao = Recuperacao;

// ── Módulo Insatisfação ─────────────────────────────────────────────────────────────
const Insatisfacao = (() => {
  let _allData = [];
  let _page = 1;
  function _token() { return localStorage.getItem('ge_token') || ''; }

  function _populateYearFilter(data) {
    const sel = document.getElementById('in-ano-filter');
    if (!sel) return;
    const anos = [...new Set(data.map(r => new Date(r.created_at).getFullYear()))].sort((a,b)=>b-a);
    const cur = sel.value;
    sel.innerHTML = '<option value="todos">Todos os anos</option>' +
      anos.map(a=>`<option value="${a}" ${String(a)===cur?'selected':''}>${a}</option>`).join('');
  }

  function _filterData(data) {
    const ano = document.getElementById('in-ano-filter')?.value || 'todos';
    const mes = document.getElementById('in-mes-filter')?.value || 'todos';
    return data.filter(r => {
      const d = new Date(r.created_at);
      if (ano !== 'todos' && d.getFullYear() !== Number(ano)) return false;
      if (mes !== 'todos' && String(d.getMonth()+1).padStart(2,'0') !== mes) return false;

      return true;
    });
  }

  function _renderGrid(data) {
    const tbody = document.getElementById('in-tbody');
    if (!tbody) return;
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--gray-400);padding:24px">Nenhum registro encontrado.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(r => {
      const d = new Date(r.created_at).toLocaleString('pt-BR');
      const lixeira = App.Auth.isAdmin() ? `<button class="btn btn-sm" style="background:none;border:none;cursor:pointer;color:#e53e3e;font-size:16px;padding:2px 6px" onclick="Insatisfacao.excluir('${r.id}')" title="Excluir">🗑</button>` : '';
      const gc={'Muito Alta':'#e53e3e','Alta':'#dd6b20','Média':'#d69e2e','Baixa':'#38a169','Muito Baixa':'#2b6cb0'}[r.gravidade]||'#718096';
      return `<tr>
        <td style="font-size:12px;color:var(--gray-500)">${d}</td>
        <td>${r.analista}</td><td style="font-weight:600">${r.cliente}</td>
        <td style="font-size:12px">${r.cnpj||'—'}</td><td>${r.empresa}</td>
        <td>${r.reclamado||'—'}</td>
        <td><span style="background:${gc}20;color:${gc};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${r.gravidade}</span></td>
        <td style="font-size:12px;color:var(--gray-500)">${r.area||'—'}</td>
        <td style="font-size:12px;color:var(--gray-500)">${r.tipo||'—'}</td>
        <td style="font-size:12px;color:var(--gray-500);max-width:150px;word-break:break-word">${r.reclamacao}</td>
        <td>${lixeira}</td></tr>`;
    }).join('');
  }

  async function loadGrid() {
    const tbody = document.getElementById('in-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';
    const res = await fetch('/api/data/insatisfacoes?period=todos', {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!res || !res.ok) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#e53e3e;padding:24px">Erro ao carregar.</td></tr>';
      return;
    }
    const { data } = await res.json();
    _allData = data || [];
    _populateYearFilter(_allData);
    const _filtered = _filterData(_allData);
    const _paged = App.Util.paginate(_filtered, _page);
    _renderGrid(_paged.items);
    App.Util.renderPagination('in-pagination', _paged.page, _paged.pages, _paged.total, 'Insatisfacao.goPage');
  }

  function exportCSV() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at', 'analista', 'cliente', 'cnpj', 'empresa', 'reclamado', 'gravidade', 'reclamacao'];
    const labels = {'created_at':'Data','analista':'Analista','cliente':'Cliente','cnpj':'CNPJ','empresa':'Empresa','reclamado':'Reclamado','gravidade':'Gravidade','reclamacao':'Reclamação'};
    const header = cols.map(c=>labels[c]||c).join(';');
    const rows = data.map(r => cols.map(c => {
      let v = r[c] ?? '';
      if (c==='created_at') v = new Date(v).toLocaleString('pt-BR');
      return `"${String(v).replace(/"/g,'""')}"`;
    }).join(';'));
    const csv = [header,...rows].join('\n');
    const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ano = document.getElementById('in-ano-filter')?.value||'todos';
    const mes = document.getElementById('in-mes-filter')?.value||'todos';
    a.href=url; a.download=`insatisfacoes_${ano}_${mes}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    App.Toast.ok('CSV exportado!');
  }

  function exportPDF() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at', 'analista', 'cliente', 'cnpj', 'empresa', 'reclamado', 'gravidade', 'reclamacao'];
    const labels = {'created_at':'Data','analista':'Analista','cliente':'Cliente','cnpj':'CNPJ','empresa':'Empresa','reclamado':'Reclamado','gravidade':'Gravidade','reclamacao':'Reclamação'};
    const ano = document.getElementById('in-ano-filter')?.value||'todos';
    const mes = document.getElementById('in-mes-filter')?.value||'todos';
    const titulo = `Insatisfação — ${ano==='todos'?'Todos os anos':ano} / ${mes==='todos'?'Todos os meses':mes}`;
    const rows = data.map(r=>`<tr>${cols.map(c=>{let v=r[c]??'—';if(c==='created_at')v=new Date(v).toLocaleString('pt-BR');return`<td>${v}</td>`;})}</tr>`).join('');
    const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${titulo}</title>
    <style>body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#222}
    h1{font-size:15px;color:#1a4233;margin-bottom:4px}p.sub{color:#666;font-size:11px;margin-bottom:12px}
    table{width:100%;border-collapse:collapse;font-size:10px}
    th{background:#1a4233;color:#fff;padding:6px 8px;text-align:left}
    td{padding:5px 8px;border-bottom:1px solid #eee}tr:nth-child(even) td{background:#f8f8f8}
    @media print{body{margin:10px}}</style></head><body>
    <h1>Grupo-E — ${titulo}</h1>
    <p class="sub">Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${data.length} registros</p>
    <table><thead><tr>${cols.map(c=>`<th>${labels[c]||c}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody></table>
    <script>window.onload=()=>{window.print();}<\/script></body></html>`;
    const win=window.open('','_blank');
    if(!win){App.Toast.err('Permita popups para exportar PDF.');return;}
    win.document.write(html);win.document.close();
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
          <p style="font-size:28px;font-weight:800;color:#e53e3e;margin:12px 0">${total} registro${total!==1?'s':''}</p>
          <p style="color:var(--gray-500);font-size:13px">Esta ação não pode ser desfeita.</p>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
            <button class="btn btn-ghost" onclick="App.Modal.close()">Cancelar</button>
            <button class="btn" style="background:#e53e3e;color:#fff;border:none"
              onclick="document.dispatchEvent(new CustomEvent('in-confirm-limpar'))">Sim, limpar tudo</button>
          </div>
        </div>`, () => resolve(false), { noFooter: true });
      document.addEventListener('in-confirm-limpar', () => { App.Modal.close(); resolve(true); }, {once:true});
    });
    if (!confirmado) return;
    const res = await fetch('/api/data/insatisfacoes/clear', {
      method:'DELETE', headers:{'Authorization':`Bearer ${_token()}`}
    });
    if (res && res.ok) {
      _allData=[]; _renderGrid([]); _populateYearFilter([]);
      App.Toast.ok('Todos os registros foram removidos.');
    } else { App.Toast.err('Erro ao limpar registros.'); }
  }

  async function excluir(id) {
    if (!App.Auth.isAdmin()) return;
    const res = await fetch(`/api/data/insatisfacoes/${id}`, {
      method:'DELETE', headers:{'Authorization':`Bearer ${_token()}`}
    });
    if (res && res.ok) {
      _allData = _allData.filter(r=>r.id!==id);
      _renderGrid(_filterData(_allData));
      App.Toast.ok('Registro excluído.');
    } else { App.Toast.err('Erro ao excluir.'); }
  }

  function goPage(p) { _page = p; const f = _filterData(_allData); const pg = App.Util.paginate(f, p); _renderGrid(pg.items); App.Util.renderPagination('in-pagination', pg.page, pg.pages, pg.total, 'Insatisfacao.goPage'); }
  return { loadGrid, exportCSV, exportPDF, limpar, excluir, goPage };
})();

window.Insatisfacao = Insatisfacao;

// ── Módulo Clientes Sensíveis ─────────────────────────────────────────────────────────────
const Sensiveis = (() => {
  let _allData = [];
  let _page = 1;
  function _token() { return localStorage.getItem('ge_token') || ''; }

  function _populateYearFilter(data) {
    const sel = document.getElementById('cs-ano-filter');
    if (!sel) return;
    const anos = [...new Set(data.map(r => new Date(r.created_at).getFullYear()))].sort((a,b)=>b-a);
    const cur = sel.value;
    sel.innerHTML = '<option value="todos">Todos os anos</option>' +
      anos.map(a=>`<option value="${a}" ${String(a)===cur?'selected':''}>${a}</option>`).join('');
  }

  function _filterData(data) {
    const ano = document.getElementById('cs-ano-filter')?.value || 'todos';
    const mes = document.getElementById('cs-mes-filter')?.value || 'todos';
    return data.filter(r => {
      const d = new Date(r.created_at);
      if (ano !== 'todos' && d.getFullYear() !== Number(ano)) return false;
      if (mes !== 'todos' && String(d.getMonth()+1).padStart(2,'0') !== mes) return false;

      return true;
    });
  }

  function _renderGrid(data) {
    const tbody = document.getElementById('cs-tbody');
    if (!tbody) return;
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--gray-400);padding:24px">Nenhum registro encontrado.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(r => {
      const d = new Date(r.created_at).toLocaleString('pt-BR');
      const lixeira = App.Auth.isAdmin() ? `<button class="btn btn-sm" style="background:none;border:none;cursor:pointer;color:#e53e3e;font-size:16px;padding:2px 6px" onclick="Sensiveis.excluir('${r.id}')" title="Excluir">🗑</button>` : '';
      const gc={'Muito Alta':'#e53e3e','Alta':'#dd6b20','Média':'#d69e2e','Baixa':'#38a169','Muito Baixa':'#2b6cb0'}[r.gravidade]||'#718096';
      return `<tr>
        <td style="font-size:12px;color:var(--gray-500)">${d}</td>
        <td>${r.analista}</td><td style="font-weight:600">${r.cliente}</td>
        <td style="font-size:12px">${r.cnpj||'—'}</td><td>${r.empresa}</td>
        <td>${r.demonstrou}</td>
        <td><span style="background:${gc}20;color:${gc};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${r.gravidade}</span></td>
        <td style="font-size:12px;color:var(--gray-500);max-width:150px;word-break:break-word">${r.detalhe||'—'}</td>
        <td>${lixeira}</td></tr>`;
    }).join('');
  }

  async function loadGrid() {
    const tbody = document.getElementById('cs-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';
    const res = await fetch('/api/data/sensiveis?period=todos', {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!res || !res.ok) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#e53e3e;padding:24px">Erro ao carregar.</td></tr>';
      return;
    }
    const { data } = await res.json();
    _allData = data || [];
    _populateYearFilter(_allData);
    const _filtered = _filterData(_allData);
    const _paged = App.Util.paginate(_filtered, _page);
    _renderGrid(_paged.items);
    App.Util.renderPagination('cs-pagination', _paged.page, _paged.pages, _paged.total, 'Sensiveis.goPage');
  }

  function exportCSV() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at', 'analista', 'cliente', 'cnpj', 'empresa', 'demonstrou', 'gravidade', 'detalhe'];
    const labels = {'created_at':'Data','analista':'Analista','cliente':'Cliente','cnpj':'CNPJ','empresa':'Empresa','demonstrou':'Demonstrou','gravidade':'Gravidade','detalhe':'Detalhe'};
    const header = cols.map(c=>labels[c]||c).join(';');
    const rows = data.map(r => cols.map(c => {
      let v = r[c] ?? '';
      if (c==='created_at') v = new Date(v).toLocaleString('pt-BR');
      return `"${String(v).replace(/"/g,'""')}"`;
    }).join(';'));
    const csv = [header,...rows].join('\n');
    const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ano = document.getElementById('cs-ano-filter')?.value||'todos';
    const mes = document.getElementById('cs-mes-filter')?.value||'todos';
    a.href=url; a.download=`sensiveis_${ano}_${mes}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    App.Toast.ok('CSV exportado!');
  }

  function exportPDF() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at', 'analista', 'cliente', 'cnpj', 'empresa', 'demonstrou', 'gravidade', 'detalhe'];
    const labels = {'created_at':'Data','analista':'Analista','cliente':'Cliente','cnpj':'CNPJ','empresa':'Empresa','demonstrou':'Demonstrou','gravidade':'Gravidade','detalhe':'Detalhe'};
    const ano = document.getElementById('cs-ano-filter')?.value||'todos';
    const mes = document.getElementById('cs-mes-filter')?.value||'todos';
    const titulo = `Clientes Sensíveis — ${ano==='todos'?'Todos os anos':ano} / ${mes==='todos'?'Todos os meses':mes}`;
    const rows = data.map(r=>`<tr>${cols.map(c=>{let v=r[c]??'—';if(c==='created_at')v=new Date(v).toLocaleString('pt-BR');return`<td>${v}</td>`;})}</tr>`).join('');
    const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${titulo}</title>
    <style>body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#222}
    h1{font-size:15px;color:#1a4233;margin-bottom:4px}p.sub{color:#666;font-size:11px;margin-bottom:12px}
    table{width:100%;border-collapse:collapse;font-size:10px}
    th{background:#1a4233;color:#fff;padding:6px 8px;text-align:left}
    td{padding:5px 8px;border-bottom:1px solid #eee}tr:nth-child(even) td{background:#f8f8f8}
    @media print{body{margin:10px}}</style></head><body>
    <h1>Grupo-E — ${titulo}</h1>
    <p class="sub">Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${data.length} registros</p>
    <table><thead><tr>${cols.map(c=>`<th>${labels[c]||c}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody></table>
    <script>window.onload=()=>{window.print();}<\/script></body></html>`;
    const win=window.open('','_blank');
    if(!win){App.Toast.err('Permita popups para exportar PDF.');return;}
    win.document.write(html);win.document.close();
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
          <p style="font-size:28px;font-weight:800;color:#e53e3e;margin:12px 0">${total} registro${total!==1?'s':''}</p>
          <p style="color:var(--gray-500);font-size:13px">Esta ação não pode ser desfeita.</p>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
            <button class="btn btn-ghost" onclick="App.Modal.close()">Cancelar</button>
            <button class="btn" style="background:#e53e3e;color:#fff;border:none"
              onclick="document.dispatchEvent(new CustomEvent('cs-confirm-limpar'))">Sim, limpar tudo</button>
          </div>
        </div>`, () => resolve(false), { noFooter: true });
      document.addEventListener('cs-confirm-limpar', () => { App.Modal.close(); resolve(true); }, {once:true});
    });
    if (!confirmado) return;
    const res = await fetch('/api/data/sensiveis/clear', {
      method:'DELETE', headers:{'Authorization':`Bearer ${_token()}`}
    });
    if (res && res.ok) {
      _allData=[]; _renderGrid([]); _populateYearFilter([]);
      App.Toast.ok('Todos os registros foram removidos.');
    } else { App.Toast.err('Erro ao limpar registros.'); }
  }

  async function excluir(id) {
    if (!App.Auth.isAdmin()) return;
    const res = await fetch(`/api/data/sensiveis/${id}`, {
      method:'DELETE', headers:{'Authorization':`Bearer ${_token()}`}
    });
    if (res && res.ok) {
      _allData = _allData.filter(r=>r.id!==id);
      _renderGrid(_filterData(_allData));
      App.Toast.ok('Registro excluído.');
    } else { App.Toast.err('Erro ao excluir.'); }
  }

  function goPage(p) { _page = p; const f = _filterData(_allData); const pg = App.Util.paginate(f, p); _renderGrid(pg.items); App.Util.renderPagination('cs-pagination', pg.page, pg.pages, pg.total, 'Sensiveis.goPage'); }
  return { loadGrid, exportCSV, exportPDF, limpar, excluir, goPage };
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

// ── Módulo CAC / Investimentos em Aquisição ───────────────────────────────────
const CAC = (() => {
  let _data = [];
  let _page = 1;
  function _token() { return localStorage.getItem('ge_token') || ''; }
  function _fmt(v) { return 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  const _nomes = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const _nomesc = ['','Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

  function _mesLabel(mes, curto) {
    if (!mes) return '—';
    const [ano, m] = mes.split('-');
    return (curto ? _nomesc : _nomes)[parseInt(m)] + '/' + ano;
  }

  function _populateMesFilter(meses) {
    const sel = document.getElementById('cac-mes-filter');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="todos">Todos os períodos</option>' +
      meses.map(m => `<option value="${m}" ${m===cur?'selected':''}>${_mesLabel(m)}</option>`).join('');
  }

  async function load() {
    await Promise.all([loadDashboard(), loadGrid()]);
  }

  async function loadDashboard() {
    const mes = document.getElementById('cac-mes-filter')?.value || 'todos';
    const res = await fetch('/api/data/cac/dashboard?mes=' + mes, {
      headers: { 'Authorization': 'Bearer ' + _token() }
    });
    if (!res || !res.ok) return;
    const d = await res.json();
    const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
    set('cac-total-inv', _fmt(d.totalInv));
    set('cac-total-cli', d.totalCli);
    set('cac-medio', d.cacMedio > 0 ? _fmt(d.cacMedio) : '—');
    set('cac-ltv-cac', d.ltvCac && d.ltvCac !== '—' ? d.ltvCac + 'x' : '—');
    set('cac-melhor-canal', d.melhorCanal || '—');
    set('cac-maior-inv', _fmt(d.maiorInv));
    set('cac-ltv-medio', _fmt(d.ltvMedio));
    if (d.meses) _populateMesFilter(d.meses);
  }

  async function loadGrid() {
    const tbody = document.getElementById('cac-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--gray-400);padding:32px">Carregando...</td></tr>';
    const mes = document.getElementById('cac-mes-filter')?.value || 'todos';
    const res = await fetch('/api/data/investimentos?mes=' + mes, {
      headers: { 'Authorization': 'Bearer ' + _token() }
    });
    if (!res || !res.ok) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#e53e3e;padding:32px">Erro ao carregar.</td></tr>';
      return;
    }
    const { data } = await res.json();
    _data = data || [];
    _page = 1;
    _renderGrid();
  }

  function _renderGrid() {
    const tbody = document.getElementById('cac-tbody');
    if (!tbody) return;
    if (!_data.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--gray-400);padding:32px">Nenhum lançamento. Clique em "+ Lançar investimento" para começar.</td></tr>';
      return;
    }
    const paged = App.Util.paginate(_data, _page);
    tbody.innerHTML = paged.items.map(r => {
      const recBadge = r.recorrente ? '<span style="background:#ebf8ff;color:#2b6cb0;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:700;margin-left:4px">↩ Recorrente</span>' : '';
      const valorOrig = (r.valor_original && parseFloat(r.valor_original) !== parseFloat(r.valor)) ? '<div style="font-size:10px;color:var(--gray-400);text-decoration:line-through">' + _fmt(r.valor_original) + '</div>' : '';
      const editBtn = App.Auth.isAdmin() ? '<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px" data-id="' + r.id + '" data-valor="' + r.valor + '" data-desc="' + (r.descricao||'').replace(/'/g,'') + '" onclick="CAC.editarValor(this.dataset.id,this.dataset.valor,this.dataset.desc)">✏️</button>' : '';
      const delBtn = App.Auth.isAdmin() ? '<button class="btn btn-sm" style="background:none;border:none;cursor:pointer;color:#e53e3e;font-size:16px;padding:2px 4px" data-id="' + r.id + '" onclick="CAC.excluir(this.dataset.id)">🗑</button>' : '';
      return '<tr>' +
        '<td style="font-weight:600">' + _mesLabel(r.mes, true) + '</td>' +
        '<td><span style="background:var(--g100);color:var(--g700);padding:2px 10px;border-radius:10px;font-size:12px;font-weight:600">' + r.canal + '</span>' + recBadge + '</td>' +
        '<td>' + valorOrig + '<span style="font-weight:600;color:var(--g700)">' + _fmt(r.valor) + '</span></td>' +
        '<td style="font-size:12px;color:var(--gray-500)">' + (r.descricao||'—') + '</td>' +
        '<td style="font-size:12px;color:var(--gray-400)">' + (r.lancado_por||'—') + '</td>' +
        '<td style="white-space:nowrap">' + editBtn + ' ' + delBtn + '</td>' +
      '</tr>';
    }).join('');
    App.Util.renderPagination('cac-pagination', paged.page, paged.pages, paged.total, 'CAC.goPage');
  }

  function goPage(p) { _page = p; _renderGrid(); }

  function abrirLancamento() {
    App.Modal.open('Lançar investimento', '<div style="display:grid;gap:12px">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
        '<div class="field"><label>Mês/Ano <span class="req">*</span></label><input id="inv-mes" type="month" /></div>' +
        '<div class="field"><label>Valor (R$) <span class="req">*</span></label><input id="inv-valor" type="number" min="0" step="0.01" placeholder="0,00" /></div>' +
      '</div>' +
      '<div class="field"><label>Canal <span class="req">*</span></label>' +
        '<select id="inv-canal"><option value="">Selecione</option>' +
        '<option>Google Ads</option><option>Instagram Ads</option><option>Facebook Ads</option>' +
        '<option>LinkedIn Ads</option><option>Tráfego Pago</option><option>Evento</option>' +
        '<option>Parceiro</option><option>Prospecção Ativa</option><option>Indicação</option>' +
        '<option>Site / SEO</option><option>WhatsApp</option><option>Outro</option>' +
        '</select></div>' +
      '<div class="field"><label>Descrição <small style="color:var(--gray-400)">(opcional)</small></label>' +
        '<input id="inv-descricao" type="text" placeholder="Ex: Campanha abertura de empresas maio/2026" /></div>' +
      '<label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:var(--gray-700);padding:8px 12px;background:var(--g100);border-radius:8px;border:1px solid var(--g200)">' +
        '<input id="inv-recorrente" type="checkbox" style="width:16px;height:16px;accent-color:var(--g600)" />' +
        '<div><strong>Investimento recorrente</strong><br><span style="font-size:11px;color:var(--gray-400)">Marca este canal como custo fixo mensal</span></div>' +
      '</label>' +
      '<button class="btn btn-primary" onclick="CAC.salvar()">Lançar</button>' +
    '</div>');
  }

  async function salvar() {
    const mes   = document.getElementById('inv-mes')?.value;
    const canal = document.getElementById('inv-canal')?.value;
    const valor = document.getElementById('inv-valor')?.value;
    const desc  = document.getElementById('inv-descricao')?.value;
    if (!mes || !canal || !valor) { App.Toast.err('Preencha mês, canal e valor.'); return; }
    const res = await fetch('/api/data/investimentos', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + _token() },
      body: JSON.stringify({ mes, canal, valor: parseFloat(valor), descricao: desc||null, recorrente: document.getElementById('inv-recorrente')?.checked || false })
    });
    if (res && res.ok) { App.Modal.close(); App.Toast.ok('Investimento lançado!'); await load(); }
    else { App.Toast.err('Erro ao lançar investimento.'); }
  }

  async function editarValor(id, valorAtual, descAtual) {
    App.Modal.open('Editar investimento', '<div style="display:grid;gap:12px">' +
      '<div class="field"><label>Novo valor (R$) <span class="req">*</span></label>' +
        '<input id="inv-edit-valor" type="number" min="0" step="0.01" value="' + valorAtual + '" /></div>' +
      '<div class="field"><label>Descrição</label>' +
        '<input id="inv-edit-desc" type="text" value="' + (descAtual||'') + '" placeholder="Descreva o ajuste" /></div>' +
      '<p style="font-size:11px;color:var(--gray-400)">⚠️ O valor original será preservado no histórico.</p>' +
      '<button class="btn btn-primary" data-id="' + id + '" onclick="CAC.salvarEdicao(this.dataset.id)">Salvar reajuste</button>' +
    '</div>');
  }

  async function salvarEdicao(id) {
    const valor = document.getElementById('inv-edit-valor')?.value;
    const desc  = document.getElementById('inv-edit-desc')?.value;
    if (!valor) { App.Toast.err('Valor obrigatório.'); return; }
    const res = await fetch('/api/data/investimentos/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _token() },
      body: JSON.stringify({ valor: parseFloat(valor), descricao: desc||null })
    });
    if (res && res.ok) { App.Modal.close(); App.Toast.ok('Valor atualizado!'); await load(); }
    else App.Toast.err('Erro ao editar.');
  }

  async function excluir(id) {
    if (!confirm('Excluir este lançamento?')) return;
    const res = await fetch('/api/data/investimentos/' + id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + _token() }
    });
    if (res && res.ok) { App.Toast.ok('Lançamento excluído.'); await load(); }
    else { App.Toast.err('Erro ao excluir.'); }
  }

  function exportCSV() {
    if (!_data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const total = _data.reduce((s,r) => s + parseFloat(r.valor||0), 0);
    const header = 'Mês;Canal;Valor;Descrição;Lançado por';
    const rows = _data.map(r => '"' + _mesLabel(r.mes) + '";"' + r.canal + '";"' + r.valor + '";"' + (r.descricao||'') + '";"' + (r.lancado_por||'') + '"');
    const csv = [header, ...rows, ';;Total: R$ ' + total.toLocaleString('pt-BR',{minimumFractionDigits:2})].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'cac_investimentos_' + new Date().toISOString().slice(0,10) + '.csv';
    a.click(); URL.revokeObjectURL(url);
    App.Toast.ok('CSV exportado!');
  }

  function exportPDF() {
    if (!_data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const totalInv = _data.reduce((s,r) => s + parseFloat(r.valor||0), 0);
    const rows = _data.map(r =>
      '<tr><td>' + _mesLabel(r.mes) + '</td><td>' + r.canal + '</td>' +
      '<td style="font-weight:600">R$ ' + parseFloat(r.valor).toLocaleString('pt-BR',{minimumFractionDigits:2}) + '</td>' +
      '<td>' + (r.descricao||'—') + '</td><td>' + (r.lancado_por||'—') + '</td></tr>'
    ).join('');
    const html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>CAC</title>' +
      '<style>body{font-family:Arial,sans-serif;font-size:11px;margin:20px}h1{font-size:15px;color:#1a4233;margin-bottom:4px}' +
      'p.sub{color:#666;font-size:11px;margin-bottom:12px}table{width:100%;border-collapse:collapse}' +
      'th{background:#1a4233;color:#fff;padding:6px 8px;text-align:left}td{padding:5px 8px;border-bottom:1px solid #eee}' +
      'tr:nth-child(even) td{background:#f8f8f8}@media print{body{margin:10px}}</style></head><body>' +
      '<h1>Grupo-E — CAC / Investimentos em Aquisição</h1>' +
      '<p class="sub">Gerado em: ' + new Date().toLocaleString('pt-BR') + ' | Total: <strong>R$ ' + totalInv.toLocaleString('pt-BR',{minimumFractionDigits:2}) + '</strong></p>' +
      '<table><thead><tr><th>Mês</th><th>Canal</th><th>Valor</th><th>Descrição</th><th>Lançado por</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<script>window.onload=function(){window.print();}<\/script></body></html>';
    const win = window.open('', '_blank');
    if (!win) { App.Toast.err('Permita popups para exportar PDF.'); return; }
    win.document.write(html); win.document.close();
    App.Toast.ok('PDF gerado!');
  }

  async function limpar() {
    if (!confirm('Limpar todos os investimentos? Esta ação não pode ser desfeita.')) return;
    const res = await fetch('/api/data/investimentos/clear', { method: 'DELETE', headers: { Authorization: 'Bearer ' + _token() } });
    if (res && res.ok) { _data = []; _renderGrid(); await loadDashboard(); App.Toast.ok('Investimentos removidos.'); }
    else App.Toast.err('Erro ao limpar.');
  }
  return { load, loadDashboard, loadGrid, goPage, abrirLancamento, salvar, editarValor, salvarEdicao, excluir, limpar, exportCSV, exportPDF };
})();

window.CAC = CAC;



// ── Módulo Gamificação Mensal (v2 — média ponderada) ──────────────────────────
const Gamificacao = (() => {
  const _tk = () => localStorage.getItem('ge_token') || '';
  let _colaboradores = [];
  let _pesoMinimo = 10;

  function _mesAtual() { return new Date().toISOString().slice(0,7); }

  function _mesLabel(mes) {
    if (!mes) return '—';
    const [ano, m] = mes.split('-');
    const nomes = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    return nomes[parseInt(m)] + '/' + ano;
  }

  async function load() {
    const mesInput = document.getElementById('gam-mes-lanc');
    if (mesInput && !mesInput.value) mesInput.value = _mesAtual();
    await _loadConfig();
    await _populateMesFilter();
    await loadNotas();
  }

  async function _loadConfig() {
    const res = await fetch('/api/data/gam/config', { headers: { Authorization: 'Bearer ' + _tk() } });
    if (res && res.ok) {
      const d = await res.json();
      _pesoMinimo = d.peso_minimo;
    }
  }

  async function _populateMesFilter() {
    const res = await fetch('/api/data/gam/notas', { headers: { Authorization: 'Bearer ' + _tk() } });
    if (!res || !res.ok) return;
    const { data } = await res.json();
    const meses = [...new Set(data.map(n => n.mes))].sort().reverse();
    const sel = document.getElementById('gam-mes-filter');
    if (!sel) return;
    const cur = sel.value || _mesAtual();
    if (!meses.includes(_mesAtual())) meses.unshift(_mesAtual());
    sel.innerHTML = meses.map(m => '<option value="' + m + '" ' + (m===cur?'selected':'') + '>' + _mesLabel(m) + '</option>').join('');
  }

  async function loadNotas() {
    const tbody = document.getElementById('gam-tbody');
    if (!tbody) return;
    const mes = document.getElementById('gam-mes-filter')?.value || _mesAtual();
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';

    const res = await fetch('/api/data/gam/notas?mes=' + mes, { headers: { Authorization: 'Bearer ' + _tk() } });
    if (!res || !res.ok) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#e53e3e;padding:24px">Erro ao carregar.</td></tr>'; return; }
    const { data } = await res.json();

    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--gray-400);padding:24px">Nenhuma nota lançada para ' + _mesLabel(mes) + '.</td></tr>';
      return;
    }

    // Média Geral: MÉDIASE — apenas quem tem avaliacoes > 0
    const comAvaliacoes = data.filter(n => parseInt(n.avaliacoes) > 0);
    const mediasValidas = comAvaliacoes.map(n => parseFloat(n.media_individual));
    const mediaGeralSimples = mediasValidas.length
      ? mediasValidas.reduce((s,m) => s + m, 0) / mediasValidas.length
      : 0;

    // 1º: calcula nota final de quem tem avaliações
    const comNotaFinalCalc = comAvaliacoes.map(n => {
      const media = parseFloat(n.media_individual);
      const aval = parseInt(n.avaliacoes);
      const notaFinal = ((media * aval) + (mediaGeralSimples * _pesoMinimo)) / (aval + _pesoMinimo);
      return { ...n, notaFinal };
    });

    // 2º: menor nota FINAL (após fórmula)
    const menorNotaFinal = comNotaFinalCalc.length ? Math.min(...comNotaFinalCalc.map(n => n.notaFinal)) : 0;

    // 3º: zerados recebem a menor nota final
    const semNotaFinalCalc = data
      .filter(n => parseInt(n.avaliacoes) === 0)
      .map(n => ({ ...n, notaFinal: menorNotaFinal }));

    const comNotaFinal = [...comNotaFinalCalc, ...semNotaFinalCalc]
      .sort((a, b) => b.notaFinal - a.notaFinal);

    tbody.innerHTML = comNotaFinal.map((n, i) => {
      return '<tr>' +
        '<td style="font-weight:700;color:var(--g700)">' + (i+1) + 'º</td>' +
        '<td style="font-weight:600">' + n.nome + '</td>' +
        '<td>' + parseFloat(n.media_individual).toFixed(2) + '</td>' +
        '<td>' + n.avaliacoes + '</td>' +
        '<td><span style="background:var(--g100);color:var(--g700);padding:3px 10px;border-radius:10px;font-weight:700">' + n.notaFinal.toFixed(2) + '</span></td>' +
        '<td><button class="btn btn-sm" style="background:none;border:none;cursor:pointer;color:#e53e3e;font-size:16px" data-id="' + n.id + '" onclick="Gamificacao.excluirNota(this.dataset.id)">🗑</button></td>' +
      '</tr>';
    }).join('');
  }

  async function excluirNota(id) {
    if (!confirm('Excluir esta nota?')) return;
    const res = await fetch('/api/data/gam/notas/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + _tk() } });
    if (res && res.ok) { App.Toast.ok('Nota excluída.'); loadNotas(); }
    else App.Toast.err('Erro ao excluir.');
  }

  // ── Formulário de lançamento ──────────────────────────────────────────────
  async function loadFormLancamento() {
    const mes = document.getElementById('gam-mes-lanc')?.value;
    if (!mes) { App.Toast.err('Selecione o mês.'); return; }

    const res = await fetch('/api/data/gam/colaboradores', { headers: { Authorization: 'Bearer ' + _tk() } });
    if (!res || !res.ok) { App.Toast.err('Erro ao carregar colaboradores.'); return; }
    const { data } = await res.json();
    _colaboradores = (data || []).filter(c => c.ativo);

    const resNotas = await fetch('/api/data/gam/notas?mes=' + mes, { headers: { Authorization: 'Bearer ' + _tk() } });
    const notasData = resNotas && resNotas.ok ? (await resNotas.json()).data : [];
    const notasMap = {};
    notasData.forEach(n => { notasMap[n.colaborador_id] = n; });

    const grid = document.getElementById('gam-lancamento-grid');
    if (!grid) return;

    if (!_colaboradores.length) {
      grid.innerHTML = '<p style="text-align:center;color:var(--gray-400);padding:20px">Nenhum colaborador cadastrado. Clique em "Gerenciar Colaboradores" para adicionar.</p>';
      return;
    }

    grid.innerHTML = '<div class="table-wrap"><table class="data-table">' +
      '<thead><tr><th>Colaborador</th><th>Média Individual (0-5)</th><th>Qtd. Avaliações</th><th>Última atualização</th></tr></thead>' +
      '<tbody>' +
      _colaboradores.map(c => {
        const existente = notasMap[c.id];
        const dt = existente ? new Date(existente.updated_at).toLocaleString('pt-BR') : '—';
        return '<tr data-colab="' + c.id + '">' +
          '<td style="font-weight:600">' + c.nome + '</td>' +
          '<td><input type="number" min="0" max="5" step="0.01" value="' + (existente?.media_individual ?? '') + '" class="gam-input gam-media" style="width:90px;padding:6px 8px;border:1px solid var(--gray-200);border-radius:6px" /></td>' +
          '<td><input type="number" min="0" step="1" value="' + (existente?.avaliacoes ?? '') + '" class="gam-input gam-aval" style="width:90px;padding:6px 8px;border:1px solid var(--gray-200);border-radius:6px" /></td>' +
          '<td style="font-size:11px;color:var(--gray-400)">' + dt + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<button class="btn btn-primary" style="margin-top:14px" data-mes="' + mes + '" onclick="Gamificacao.salvarLote(this.dataset.mes)">💾 Salvar todas as notas</button>';
  }

  async function salvarLote(mes) {
    const rows = document.querySelectorAll('tr[data-colab]');
    let salvos = 0, erros = 0;

    for (const row of rows) {
      const colaborador_id = row.dataset.colab;
      const media = row.querySelector('.gam-media').value;
      const aval  = row.querySelector('.gam-aval').value;

      if (!media && !aval) continue;

      const res = await fetch('/api/data/gam/notas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tk() },
        body: JSON.stringify({ colaborador_id, mes, media_individual: parseFloat(media)||0, avaliacoes: parseInt(aval)||0 })
      });
      if (res && res.ok) salvos++; else erros++;
    }

    if (salvos > 0) App.Toast.ok(salvos + ' nota(s) salva(s)!' + (erros ? ' (' + erros + ' erro(s))' : ''));
    else App.Toast.err('Nenhuma nota foi salva. Preencha média e avaliações.');

    await _populateMesFilter();
    await loadNotas();
  }

  // ── Configuração Peso Mínimo ──────────────────────────────────────────────
  async function abrirConfig() {
    await _loadConfig();
    App.Modal.open('Configurar Peso Mínimo', '<div style="display:grid;gap:14px">' +
      '<p style="font-size:13px;color:var(--gray-500)">O Peso Mínimo equilibra o ranking: colaboradores com poucas avaliações têm a nota "puxada" em direção à média geral, evitando distorções.</p>' +
      '<div class="field"><label>Peso Mínimo</label><input id="gam-peso-input" type="number" min="0" step="1" value="' + _pesoMinimo + '" /></div>' +
      '<button class="btn btn-primary" onclick="Gamificacao.salvarConfig()">Salvar</button>' +
    '</div>');
  }

  async function salvarConfig() {
    const valor = document.getElementById('gam-peso-input')?.value;
    if (valor === '' || valor < 0) { App.Toast.err('Valor inválido.'); return; }
    const res = await fetch('/api/data/gam/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tk() },
      body: JSON.stringify({ peso_minimo: parseFloat(valor) })
    });
    if (res && res.ok) {
      App.Modal.close();
      App.Toast.ok('Peso Mínimo atualizado!');
      _pesoMinimo = parseFloat(valor);
      loadNotas();
    } else App.Toast.err('Erro ao salvar.');
  }

  // ── Gerenciar colaboradores ───────────────────────────────────────────────
  async function abrirColaboradores() {
    const res = await fetch('/api/data/gam/colaboradores', { headers: { Authorization: 'Bearer ' + _tk() } });
    const { data } = res && res.ok ? await res.json() : { data: [] };
    _colaboradores = data || [];

    App.Modal.open('Gerenciar Colaboradores', '<div style="display:grid;gap:14px">' +
      '<div style="display:flex;gap:8px">' +
        '<input id="gam-novo-nome" type="text" placeholder="Nome do colaborador" style="flex:1;padding:8px 12px;border:1px solid var(--gray-200);border-radius:8px" />' +
        '<button class="btn btn-success btn-sm" onclick="Gamificacao.adicionarColaborador()">+ Adicionar</button>' +
      '</div>' +
      '<div id="gam-colab-list" style="max-height:320px;overflow-y:auto">' + _renderColabList() + '</div>' +
    '</div>');
  }

  function _renderColabList() {
    if (!_colaboradores.length) return '<p style="text-align:center;color:var(--gray-400);padding:16px">Nenhum colaborador cadastrado.</p>';
    return _colaboradores.map(c => {
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--gray-100)">' +
        '<span style="font-weight:600;' + (!c.ativo ? 'opacity:.5;text-decoration:line-through' : '') + '">' + c.nome + '</span>' +
        '<div style="display:flex;gap:6px">' +
          '<button class="btn btn-sm" style="background:' + (c.ativo?'#fff5f5':'#f0fff4') + ';color:' + (c.ativo?'#e53e3e':'#38a169') + ';border:1px solid ' + (c.ativo?'#fed7d7':'#c6f6d5') + ';font-size:11px" data-id="' + c.id + '" data-ativo="' + c.ativo + '" onclick="Gamificacao.toggleColaborador(this.dataset.id)">' + (c.ativo ? 'Desativar' : 'Ativar') + '</button>' +
          '<button class="btn btn-sm" style="background:none;border:none;cursor:pointer;color:#e53e3e;font-size:14px" data-id="' + c.id + '" onclick="Gamificacao.excluirColaborador(this.dataset.id)">🗑</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  async function adicionarColaborador() {
    const input = document.getElementById('gam-novo-nome');
    const nome = input?.value?.trim();
    if (!nome) { App.Toast.err('Digite o nome.'); return; }
    const btn = event?.target;
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/data/gam/colaboradores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tk() },
        body: JSON.stringify({ nome })
      });
      if (res && res.ok) {
        const result = await res.json();
        _colaboradores.push(result.data);
        _colaboradores.sort((a,b) => a.nome.localeCompare(b.nome));
        if (input) input.value = '';
        const list = document.getElementById('gam-colab-list');
        if (list) list.innerHTML = _renderColabList();
        App.Toast.ok('Colaborador adicionado!');
      } else {
        const err = await res.json().catch(() => ({}));
        App.Toast.err(err.error || 'Erro ao adicionar.');
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function toggleColaborador(id) {
    const res = await fetch('/api/data/gam/colaboradores/' + id + '/toggle', { method: 'PATCH', headers: { Authorization: 'Bearer ' + _tk() } });
    if (res && res.ok) {
      const { ativo } = await res.json();
      const colab = _colaboradores.find(c => c.id === id);
      if (colab) colab.ativo = ativo;
      const list = document.getElementById('gam-colab-list');
      if (list) list.innerHTML = _renderColabList();
    } else App.Toast.err('Erro ao alterar status.');
  }

  async function excluirColaborador(id) {
    if (!confirm('Excluir este colaborador? Todas as notas dele também serão removidas.')) return;
    const res = await fetch('/api/data/gam/colaboradores/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + _tk() } });
    if (res && res.ok) {
      _colaboradores = _colaboradores.filter(c => c.id !== id);
      const list = document.getElementById('gam-colab-list');
      if (list) list.innerHTML = _renderColabList();
      App.Toast.ok('Excluído.');
    } else App.Toast.err('Erro ao excluir.');
  }

  return {
    load, loadNotas, excluirNota,
    loadFormLancamento, salvarLote,
    abrirConfig, salvarConfig,
    abrirColaboradores, adicionarColaborador, toggleColaborador, excluirColaborador,
  };
})();

window.Gamificacao = Gamificacao;
