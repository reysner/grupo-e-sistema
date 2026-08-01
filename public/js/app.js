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

      if (!name || !email || !password) { Auth.showAlert('Preencha todos os campos.'); return; }
      if (password.length < 6) { Auth.showAlert('Senha deve ter ao menos 6 caracteres.'); return; }

      // Cadastro público sempre cria como "usuário" — o backend ignora
      // qualquer perfil enviado aqui. Virar administrador/contábil só é
      // feito depois, manualmente, por um admin (Administração → Usuários).
      const res  = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
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
      // Usuário contábil só tem acesso ao portal /contabil — redireciona imediatamente
      if (user.role === 'contabil') {
        window.location.href = '/contabil';
        return;
      }

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

      // Bloqueia contábil de usar o sistema principal
      if (currentUser.role === 'contabil') {
        window.location.href = '/contabil';
        return false;
      }

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
    async esqueciSenha() {
      const email = (document.getElementById('login-email')?.value || '').trim();
      const box = document.getElementById('forgot-msg');
      const mostrar = (txt, cor) => { if (box) { box.style.display = 'block'; box.style.color = cor; box.textContent = txt; } };
      if (!email) { mostrar('Digite seu e-mail no campo acima e clique novamente em "Esqueci minha senha".', '#fecaca'); return; }
      try {
        await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
      } catch (e) { /* resposta é sempre genérica */ }
      mostrar('Se o e-mail estiver cadastrado, enviamos o link de recuperação. Verifique sua caixa de entrada (e o spam).', '#bbf7d0');
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
    dashboard:'Dashboard', atendimento:'Atendimento', gestao:'Gestão de Clientes', carteira:'Inteligência da Carteira', perfil:'Meu Perfil', cac:'CAC / Investimentos em Aquisição', log:'Log de Atividades', gamificacao:'Gamificação Mensal', tickets:'Tickets Contábeis',
    insatisfacao:'Insatisfação', sensiveis:'Clientes Sensíveis',
    pesquisas:'Pesquisas de Satisfação', recuperacao:'Recuperação de Clientes',
    admin:'Administração de Usuários',
    'sucesso-cliente':'Sucesso do Cliente',
    'analise-inteligente':'Análise Inteligente',
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
      if (page === 'tickets')       window.Tickets?.load();
      if (page === 'atendimento') window.Atendimento?.loadGrid();
      if (page === 'gestao')      window.Gestao?.loadGrid();
      if (page === 'insatisfacao') window.Insatisfacao?.loadGrid();
      if (page === 'recuperacao') window.Recuperacao?.loadGrid();
      if (page === 'sensiveis')   window.Sensiveis?.loadGrid();
      if (page === 'admin')        (window.Admin || Admin)?.load();
      if (page === 'sucesso-cliente') window.SucessoCliente?.load();
      if (page === 'analise-inteligente') window.AnaliseInteligente?.load();
      return false;
    },
  };

  // ── Dashboard ─────────────────────────────────────────────────────────────
  const CHART_COLORS = ['#1a4233','#f5c518','#3182ce','#e53e3e','#38a169','#d69e2e','#9b2c2c','#2c7a7b'];
  let _charts = {};

  /** Converte minutos (número) em "Xh Ymin" (ou só "Ymin" se < 1h) — pra tooltip de gráfico. */
  function formatarMinutos(min) {
    const n = Math.round(Number(min) || 0);
    if (n < 60) return `${n} min`;
    const h = Math.floor(n / 60);
    const m = n % 60;
    return m ? `${h}h ${m}min` : `${h}h`;
  }

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
      const anaListaSel = document.getElementById('dash-analista');
      if (anaListaSel) {
        try {
          const resAn = await API.get('/api/analistas?ativo=true');
          if (resAn && resAn.ok) {
            const { analistas: listaAnalistas } = await resAn.json();
            const cur = anaListaSel.value;
            anaListaSel.innerHTML = '<option value="">Todos os analistas</option>' +
              (listaAnalistas || []).map(a => `<option value="${a.nome}" ${a.nome === cur ? 'selected' : ''}>${a.nome}</option>`).join('');
          }
        } catch (e) {
          console.error('[Dashboard] popular dash-analista', e);
        }
      }

      // ── ATENDIMENTO ──────────────────────────────────────────────────────────
      Dashboard.renderChart('c-at-empresa', 'bar',      c.atEmpresa,  'Empresa',     {indexAxis:'y'});
      Dashboard.renderChart('c-depto',      'bar',      c.atDepto,    'Departamento');
      Dashboard.renderChart('c-analista',   'bar',      c.atAnalista, 'Analista',    {indexAxis:'y'});
      Dashboard.renderChart('c-demanda',    'doughnut', c.atDemanda,  'Demanda');

      // ── SUCESSO DO CLIENTE ──────────────────────────────────────────────────
      await Dashboard.carregarSucessoCliente(period, analista);

      // ── GESTÃO ───────────────────────────────────────────────────────────────
      Dashboard.renderChart('c-gestao', 'doughnut', c.gcTipo,  'Solicitação');
      Dashboard.renderChart('c-canal',  'pie',      c.gcCanal, 'Canal');

      // ── INSATISFAÇÃO ─────────────────────────────────────────────────────────
      Dashboard.renderChart('c-ins-area',   'bar',      c.insArea,    'Área');
      Dashboard.renderChart('c-ins-tipo',   'bar',      c.insTipo,    'Tipo',        {indexAxis:'y'});
      Dashboard.renderChart('c-grav',       'doughnut', c.insGrav,    'Gravidade');
      Dashboard.renderChart('c-ins-empresa','bar',      c.insEmpresa, 'Empresa',     {indexAxis:'y'});

      // ── PESQUISAS NPS ────────────────────────────────────────────────────────
      Dashboard.renderChartNpsEvolucao(c.npsEvolucao || []);
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

    /**
     * Gráfico "Evolução mensal — NPS / CSAT / CES" (linha, 3 séries). O
     * canvas c-nps-evolucao existia no HTML e o backend já manda os dados
     * (charts.npsEvolucao — ver /api/data/dashboard), mas nada desenhava
     * nele: os cards de média (nps-row) usam os totais gerais, e esse
     * gráfico usa a evolução mês a mês — são coisas diferentes.
     * `linhas` = [{ mes:'07/2026', nps, csat, ces }, ...] (mais antigo primeiro).
     */
    renderChartNpsEvolucao(linhas) {
      const id = 'c-nps-evolucao';
      if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
      const ctx = document.getElementById(id);
      if (!ctx) return;
      if (!linhas || !linhas.length) {
        ctx.parentElement.innerHTML = '<p style="text-align:center;color:var(--gray-400);font-size:12px;padding:40px 0">Sem dados no período</p>';
        return;
      }
      const labels = linhas.map(r => r.mes);
      _charts[id] = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'NPS (0–10)',  data: linhas.map(r => r.nps  != null ? Number(r.nps)  : null), borderColor: '#f5c518', backgroundColor: '#f5c518', tension: 0.3, spanGaps: true },
            { label: 'CSAT (0–5)',  data: linhas.map(r => r.csat != null ? Number(r.csat) : null), borderColor: '#68d391', backgroundColor: '#68d391', tension: 0.3, spanGaps: true },
            { label: 'CES (0–5)',   data: linhas.map(r => r.ces  != null ? Number(r.ces)  : null), borderColor: '#76e4f7', backgroundColor: '#76e4f7', tension: 0.3, spanGaps: true },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 }, padding: 12 } } },
          scales: {
            x: { ticks: { font: { size: 10 } }, grid: { display: false } },
            y: { beginAtZero: true, max: 10, ticks: { stepSize: 2, font: { size: 10 } }, grid: { color: 'rgba(0,0,0,.05)' } },
          },
        },
      });
    },

    async carregarSucessoCliente(period, analista) {
      try {
        const qs = new URLSearchParams({ period: period || 'todos' });
        if (analista) qs.set('analista', analista);
        const [res, resEtapas, resMotivos] = await Promise.all([
          API.get(`/api/cs/dashboard?${qs.toString()}`),
          API.get(`/api/cs/dashboard/etapas?${qs.toString()}`),
          API.get(`/api/cs/dashboard/motivos?${qs.toString()}`),
        ]);
        if (res && res.ok) {
          const d = await res.json();
          Dashboard.renderChartStatusCS(d.porStatus || []);
          Dashboard.renderChart('cs-dash-departamento', 'bar', d.porDepartamento || [], 'Departamento');
          Dashboard.renderChart('cs-dash-analista', 'bar', d.porAnalista || [], 'Analista', { indexAxis: 'y' });
          Dashboard.renderChartDesempenhoCS(d.desempenhoAnalistas || []);
        }
        if (resEtapas && resEtapas.ok) {
          const dE = await resEtapas.json();
          Dashboard.renderChartEtapas(dE.porEtapa || []);
          Dashboard.renderChartAnalistaDepartamento(dE.porAnalistaDepartamento || []);
          Dashboard.renderChartAnalistaRespostaContinua(dE.porAnalistaRespostaContinua || []);
        }
        if (resMotivos && resMotivos.ok) {
          const dM = await resMotivos.json();
          Dashboard.renderChart('cs-dash-motivos', 'bar', dM.porMotivo || [], 'Motivo', { indexAxis: 'y' });
          Dashboard.renderTabelaSubmotivos(dM.porSubmotivo || []);
        }
      } catch (e) {
        console.error('[Dashboard] carregarSucessoCliente()', e);
      }
    },

    /**
     * Tabela "Detalhamento das solicitações" — o SUBMOTIVO (pedido
     * específico dentro de cada motivo, ex.: "Recálculo de Guia" dentro de
     * "Guias e Impostos") ranqueado por quantidade. Pedido direto da Thais
     * ao ver o gráfico com 63% em "Outros": "sempre há um pedido, uma
     * solicitação... o que de fato foi a solicitação do cliente? Tente
     * agrupar as mesmas solicitações". Esta tabela é o "relatório sobre
     * essas situações" que ela pediu — dá pra ver, por exemplo, "43 pedidos
     * de recálculo de guia" batendo o olho, com exportação em CSV.
     */
    _submotivosData: [],
    renderTabelaSubmotivos(porSubmotivo) {
      Dashboard._submotivosData = porSubmotivo || [];
      const tbody = document.getElementById('cs-dash-submotivos-tbody');
      if (!tbody) return;
      if (!porSubmotivo || !porSubmotivo.length) {
        tbody.innerHTML = '<tr><td colspan="3" style="color:var(--gray-400)">Nenhuma solicitação específica identificada ainda.</td></tr>';
        return;
      }
      const total = porSubmotivo.reduce((s, r) => s + r.n, 0);
      tbody.innerHTML = porSubmotivo.map(r => {
        const pct = total ? Math.round((r.n / total) * 100) : 0;
        return `<tr>
          <td>${esc(r.motivo)}</td>
          <td style="font-weight:600">${esc(r.submotivo)}</td>
          <td>${r.n} <span style="color:var(--gray-400);font-size:11px">(${pct}%)</span></td>
        </tr>`;
      }).join('');
    },
    exportSubmotivosCSV() {
      const dados = Dashboard._submotivosData || [];
      if (!dados.length) { App.Toast.err('Nada para exportar ainda.'); return; }
      const escCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const linhas = [['Motivo', 'Solicitação Específica', 'Quantidade'].map(escCsv).join(',')];
      dados.forEach(r => linhas.push([r.motivo, r.submotivo, r.n].map(escCsv).join(',')));
      const blob = new Blob(['﻿' + linhas.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `detalhamento_solicitacoes_${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    },

    /**
     * Doughnut "Status do SLA" — cor FIXA por significado (verde/amarelo/
     * vermelho), nunca pela ordem em que o banco devolveu as linhas (GROUP BY
     * não garante ordem — o renderChart genérico pinta por posição, o que
     * podia fazer o vermelho "ganhar" a cor amarela por acaso).
     */
    renderChartStatusCS(linhas) {
      const id = 'cs-dash-status';
      if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
      const ctx = document.getElementById(id);
      if (!ctx) return;
      if (!linhas || !linhas.length) {
        ctx.parentElement.innerHTML = '<p style="text-align:center;color:var(--gray-400);font-size:12px;padding:40px 0">Sem dados ainda</p>';
        return;
      }
      const CORES = { verde: '#38a169', amarelo: '#f5c518', vermelho: '#e53e3e' };
      const LABELS = { verde: '🟢 Verde', amarelo: '🟡 Amarelo', vermelho: '🔴 Vermelho' };
      const ordem = ['verde', 'amarelo', 'vermelho'];
      const porChave = Object.fromEntries(linhas.map(r => [r.label, r.n]));
      const presentes = ordem.filter(k => porChave[k] != null);
      const labels = presentes.map(k => LABELS[k]);
      const dataVals = presentes.map(k => porChave[k]);
      const bg = presentes.map(k => CORES[k]);
      _charts[id] = new Chart(ctx, {
        type: 'doughnut',
        data: { labels, datasets: [{ label: 'Status SLA', data: dataVals, backgroundColor: bg, borderColor: '#fff', borderWidth: 2 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 }, padding: 12 } } },
        },
      });
    },

    renderChartDesempenhoCS(linhas) {
      const id = 'cs-dash-desempenho';
      if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
      const ctx = document.getElementById(id);
      if (!ctx) return;
      if (!linhas.length) {
        ctx.parentElement.innerHTML = '<p style="text-align:center;color:var(--gray-400);font-size:12px;padding:40px 0">Sem dados suficientes ainda (precisa de pelo menos 3 tickets por analista)</p>';
        return;
      }
      const labels = linhas.map(r => r.label || 'Não informado');
      const dataVals = linhas.map(r => r.pct ?? 0);
      const cores = dataVals.map(p => (p < 50 ? '#e53e3e' : p < 80 ? '#f5c518' : '#38a169'));
      _charts[id] = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: '% dentro do SLA', data: dataVals, backgroundColor: cores, borderRadius: 4 }] },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { min: 0, max: 100, ticks: { font: { size: 10 }, callback: v => v + '%' }, grid: { color: 'rgba(0,0,0,.05)' } },
            y: { ticks: { font: { size: 10 } }, grid: { display: false } },
          },
          onClick: async (evt, elementos) => {
            if (!elementos.length) return;
            const analista = labels[elementos[0].index];
            Nav.go('sucesso-cliente');
            await window.SucessoCliente?.load();
            window.SucessoCliente?.filtrarPorAnalista(analista);
          },
        },
      });
    },

    /**
     * Ranking "resposta contínua" por analista — tempo de resposta em CADA
     * turno do cliente DEPOIS da transferência (não só a 1ª vez), atribuído
     * ao analista responsável final do ticket. Isola o que é de quem recebeu
     * o ticket transferido do que foi de quem aceitou/transferiu antes (ex.:
     * recepção do Sucesso do Cliente). Pior primeiro.
     */
    renderChartAnalistaRespostaContinua(linhas) {
      const id = 'cs-dash-analista-resposta';
      if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
      const ctx = document.getElementById(id);
      if (!ctx) return;
      if (!linhas || !linhas.length) {
        ctx.parentElement.innerHTML = '<p style="text-align:center;color:var(--gray-400);font-size:12px;padding:40px 0">Sem dados suficientes ainda (precisa de pelo menos 3 tickets transferidos, com troca de mensagens depois, por analista)</p>';
        return;
      }
      const labels = linhas.map(r => r.label || 'Não informado');
      const pctVals = linhas.map(r => r.pct ?? 0);
      const mediaVals = linhas.map(r => r.media_minutos ?? 0);
      const cores = pctVals.map(p => (p < 50 ? '#e53e3e' : p < 80 ? '#f5c518' : '#38a169'));
      _charts[id] = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: '% dentro do SLA (pós-transferência)', data: pctVals, backgroundColor: cores, borderRadius: 4 }] },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { afterLabel: (item) => `Tempo médio: ${formatarMinutos(mediaVals[item.dataIndex])}` } },
          },
          scales: {
            x: { min: 0, max: 100, ticks: { font: { size: 10 }, callback: v => v + '%' }, grid: { color: 'rgba(0,0,0,.05)' } },
            y: { ticks: { font: { size: 10 } }, grid: { display: false } },
          },
          onClick: async (evt, elementos) => {
            if (!elementos.length) return;
            const analista = labels[elementos[0].index];
            Nav.go('sucesso-cliente');
            await window.SucessoCliente?.load();
            window.SucessoCliente?.filtrarPorAnalistaEtapa(analista, 'resposta_continua');
          },
        },
      });
    },

    /**
     * "% dentro do SLA por etapa" — usa /api/cs/dashboard/etapas. Cada etapa
     * (aceite/transferência/departamento/promessa) já vem calculada e salva
     * por ticket (cs_tickets.sla) — aqui só resume tempo médio e % dentro
     * do prazo de cada uma, pra saber ONDE o atendimento está travando.
     */
    renderChartEtapas(linhas) {
      const id = 'cs-dash-etapas';
      if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
      const ctx = document.getElementById(id);
      if (!ctx) return;
      if (!linhas || !linhas.length) {
        ctx.parentElement.innerHTML = '<p style="text-align:center;color:var(--gray-400);font-size:12px;padding:40px 0">Sem dados no período</p>';
        return;
      }
      const ROTULOS = { aceite: 'Aceite', transferencia: 'Transferência', departamento: 'Analista (pós-transferência)', promessa: 'Promessa de transferência', promessa_resolucao: 'Resolvendo direto (sem transferir)', resposta_continua: 'Resposta contínua (pós-transferência)' };
      const ORDEM = ['aceite', 'transferencia', 'departamento', 'promessa', 'promessa_resolucao', 'resposta_continua'];
      const porChave = Object.fromEntries(linhas.map(r => [r.etapa, r]));
      const presentes = ORDEM.filter(k => porChave[k]);
      const labels = presentes.map(k => ROTULOS[k]);
      const pctVals = presentes.map(k => porChave[k].pct ?? 0);
      const mediaVals = presentes.map(k => porChave[k].media_minutos ?? 0);
      const cores = pctVals.map(p => (p < 50 ? '#e53e3e' : p < 80 ? '#f5c518' : '#38a169'));
      _charts[id] = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: '% dentro do SLA', data: pctVals, backgroundColor: cores, borderRadius: 4 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { afterLabel: (item) => `Tempo médio: ${formatarMinutos(mediaVals[item.dataIndex])}` } },
          },
          scales: {
            y: { min: 0, max: 100, ticks: { font: { size: 10 }, callback: v => v + '%' }, grid: { color: 'rgba(0,0,0,.05)' } },
            x: { ticks: { font: { size: 10 } }, grid: { display: false } },
          },
          // Clicar numa barra (ex.: "Promessa de transferência") leva pro
          // Histórico já filtrado pelos tickets vermelhos DAQUELA etapa —
          // são os que justificam o % baixo mostrado na barra.
          onClick: async (evt, elementos) => {
            if (!elementos.length) return;
            const etapaChave = presentes[elementos[0].index];
            Nav.go('sucesso-cliente');
            await window.SucessoCliente?.load();
            window.SucessoCliente?.filtrarPorEtapa(etapaChave);
          },
        },
      });
    },

    /**
     * Ranking de analistas SÓ na etapa "departamento" (resposta depois que o
     * ticket foi transferido pra ele) — responde diretamente "quem demora
     * pra pegar o ticket depois que a bola foi devolvida". Pior primeiro,
     * clique numa barra filtra o Histórico por esse analista.
     */
    renderChartAnalistaDepartamento(linhas) {
      const id = 'cs-dash-analista-departamento';
      if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
      const ctx = document.getElementById(id);
      if (!ctx) return;
      if (!linhas || !linhas.length) {
        ctx.parentElement.innerHTML = '<p style="text-align:center;color:var(--gray-400);font-size:12px;padding:40px 0">Sem dados suficientes ainda (precisa de pelo menos 3 tickets transferidos por analista)</p>';
        return;
      }
      const labels = linhas.map(r => r.label || 'Não informado');
      const pctVals = linhas.map(r => r.pct ?? 0);
      const mediaVals = linhas.map(r => r.media_minutos ?? 0);
      const cores = pctVals.map(p => (p < 50 ? '#e53e3e' : p < 80 ? '#f5c518' : '#38a169'));
      _charts[id] = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: '% dentro do SLA (pós-transferência)', data: pctVals, backgroundColor: cores, borderRadius: 4 }] },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { afterLabel: (item) => `Tempo médio: ${formatarMinutos(mediaVals[item.dataIndex])}` } },
          },
          scales: {
            x: { min: 0, max: 100, ticks: { font: { size: 10 }, callback: v => v + '%' }, grid: { color: 'rgba(0,0,0,.05)' } },
            y: { ticks: { font: { size: 10 } }, grid: { display: false } },
          },
          onClick: async (evt, elementos) => {
            if (!elementos.length) return;
            const analista = labels[elementos[0].index];
            Nav.go('sucesso-cliente');
            await window.SucessoCliente?.load();
            window.SucessoCliente?.filtrarPorAnalistaEtapa(analista, 'departamento');
          },
        },
      });
    },

    exportCSV() {
      const d = Dashboard._lastData;
      if (!d) { App.Toast.err('Carregue o Dashboard primeiro.'); return; }
      const period = document.getElementById('dash-period')?.value || 'todos';
      const c = d.chartsFull || d.charts;
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
      const c = d.chartsFull || d.charts;

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
      if (!res) return null;
      const data = await res.json();
      if (!res.ok) { Toast.err(data.error || 'Erro ao salvar.'); return null; }
      Util.clear(clearIds);
      Toast.ok(toastMsg);
      return data.id || null;
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
      if (!Util.requireFields([['gc-analista','Analista'],['gc-solicitacao','Solicitação'],['gc-cnpj','CNPJ'],['gc-empresa','Empresa'],['gc-data','Data'],['gc-competencia','Competência'],['gc-canal','Canal'],['gc-regime','Regime Tributário']])) return;
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
            grupo_empresas: Util.val('gc-grupo') || null,
            unidade: Util.val('gc-unidade') || null,
            tipo_entrada: gcSol,
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
      // Captura os dados do ticket ANTES do _submit (que limpa o formulário)
      const _gcSol  = gcSol;
      const _gcReg  = Util.val('gc-regime') || '';
      const _gcEmp  = Util.val('gc-empresa') || '';
      const _gcCnpj = Util.val('gc-cnpj') || '';
      const _gcDados = {
        analista: Util.val('gc-analista') || '',
        codigo: Util.val('gc-codigo') || '',
        data_sol: Util.val('gc-data') || '',
        canal: gcCanal || '',
        competencia: Util.val('gc-competencia') || '',
        motivo: Util.val('gc-motivo-saida') || Util.val('gc-motivo') || '',
        data_encerramento: Util.val('gc-data-saida') || '',
      };
      const _gestaoId = await Forms._submit('gestao', {
        analista: Util.val('gc-analista'), solicitacao: gcSol,
        cnpj: Util.val('gc-cnpj'), empresa: Util.val('gc-empresa'),
        data_sol: Util.val('gc-data'), competencia: Util.val('gc-competencia'),
        canal: gcCanal,
        regime_tributario: Util.val('gc-regime') || null,
        codigo: Util.val('gc-codigo') || null,
      }, ['gc-analista','gc-cnpj','gc-empresa','gc-data','gc-competencia','gc-motivo','gc-grupo','gc-unidade'], 'Gestão salva!');
      // Oferece abrir ticket para Baixa ou Saída de empresa
      if ((_gcSol === 'Baixa de empresa' || _gcSol === 'Saída de empresa') && App.Auth.isAdmin()) {
        setTimeout(() => window.Tickets?.perguntarAbrirTicket(_gcSol, _gcReg, _gcEmp, _gcCnpj, _gcDados, _gestaoId), 400);
      }
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
      Admin.carregarBackupsAutomaticos();
    },

    async carregarBackupsAutomaticos() {
      const tbody = document.getElementById('backups-auto-tbody');
      if (!tbody) return;
      try {
        const tk = localStorage.getItem('ge_token') || '';
        const res = await fetch('/api/data/backups-automaticos', { headers: { Authorization: 'Bearer ' + tk } });
        if (!res || !res.ok) throw new Error('Falha ao buscar.');
        const { data } = await res.json();
        if (!data || !data.length) {
          tbody.innerHTML = '<tr><td colspan="3" style="color:var(--gray-400)">Nenhum backup automático ainda (o primeiro roda na próxima madrugada).</td></tr>';
          return;
        }
        tbody.innerHTML = data.map(b => {
          const dt = new Date(b.gerado_em).toLocaleString('pt-BR');
          const totais = b.totais || {};
          const resumo = Object.entries(totais).map(([k, v]) => `${k}: ${v}`).join(' | ');
          return `<tr>
            <td>${dt}</td>
            <td style="font-size:12px;color:var(--gray-500)">${resumo || '—'}</td>
            <td><button class="btn btn-ghost btn-sm" onclick="App.Admin.baixarBackupAutomatico('${b.id}')">⬇ Baixar</button></td>
          </tr>`;
        }).join('');
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="3" style="color:var(--danger)">Não foi possível carregar os backups automáticos.</td></tr>';
      }
    },

    async baixarBackupAutomatico(id) {
      try {
        const tk = localStorage.getItem('ge_token') || '';
        const res = await fetch('/api/data/backups-automaticos/' + id + '/download', { headers: { Authorization: 'Bearer ' + tk } });
        if (!res || !res.ok) { App.Toast.err('Erro ao baixar backup.'); return; }
        const data = await res.json();
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const ts   = new Date(data.meta?.gerado_em || Date.now()).toISOString().slice(0,10);
        const a    = document.createElement('a');
        a.href = url; a.download = 'backup-automatico-grupo-e-' + ts + '.json';
        a.click(); URL.revokeObjectURL(url);
      } catch (e) {
        App.Toast.err('Erro ao baixar backup.');
      }
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
            <button class="btn btn-ghost btn-sm" onclick="App.Admin.openEditProfile('${u.id}','${u.name}','${u.email}','${u.role}')">✏️ Editar</button>
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
      // Escapa aspas duplas dentro do valor (nome poderia ter, ex.: Empresa "Fulano" Ltda)
      // — sem isso, um "" no meio do texto quebra as colunas ao abrir no Excel.
      const rows = users.map(u =>
        `"${String(u.name??'').replace(/"/g,'""')}";"${String(u.email??'').replace(/"/g,'""')}";"${u.role==='administrador'?'Administrador':'Usuário'}";"${u.ativo!==false?'Ativo':'Inativo'}"`
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
          <select id="m-role">
            <option value="usuario">Usuário</option>
            <option value="administrador">Administrador</option>
            <option value="contabil">Contábil — acesso só ao Portal Contábil</option>
          </select>
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

    openEditProfile(id, name, email, role) {
      App.Modal.open('Editar usuário', '<div style="display:grid;gap:12px">' +
        '<div class="field"><label>Nome</label><input id="eu-name" type="text" value="' + (name||'') + '" /></div>' +
        '<div class="field"><label>E-mail</label><input id="eu-email" type="email" value="' + (email||'') + '" /></div>' +
        '<div class="field"><label>Função</label><select id="eu-role">' +
          '<option value="usuario"' + (role==='usuario'?' selected':'') + '>Usuário</option>' +
          '<option value="administrador"' + (role==='administrador'?' selected':'') + '>Administrador</option>' +
          '<option value="contabil"' + (role==='contabil'?' selected':'') + '>Contábil — só Portal Contábil</option>' +
        '</select></div>' +
        '<button class="btn btn-primary" data-id="' + id + '" onclick="App.Admin.saveEdit(this.dataset.id)">Salvar</button>' +
      '</div>', null, { noFooter: true });
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
  // Regime Tributário é campo fixo — sempre visível independente da solicitação
  const gcRegimeWrap = document.getElementById('gc-regime-wrap');
  if (gcRegimeWrap) { gcRegimeWrap.style.display = 'flex'; gcRegimeWrap.hidden = false; }
  ['gc-honorario-wrap','gc-origem-wrap','gc-data-entrada-wrap'].forEach(id => {
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
    // Escapa aspas duplas dentro do valor — user_name/descricao são texto
    // livre e podem ter "" no meio, o que quebra as colunas no Excel.
    const esc = function(v) { return String(v == null ? '' : v).replace(/"/g, '""'); };
    const rows = _data.map(function(r) {
      return '"' + new Date(r.created_at).toLocaleString('pt-BR') + '";"' + esc(r.user_name) + '";"' + esc(r.acao) + '";"' + esc(r.modulo) + '";"' + esc(r.descricao||'') + '"';
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
  { const bf = document.getElementById('btn-forgot'); if (bf) bf.addEventListener('click', () => App.Auth.esqueciSenha()); }
  document.getElementById('btn-logout').addEventListener('click', (e) => { e.preventDefault(); App.Auth.logout(); });
  document.getElementById('btn-logout-top').addEventListener('click', () => App.Auth.logout());

  // Nav items
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', (e) => { e.preventDefault(); App.Nav.go(el.dataset.page); });
  });

  // Dashboard
  document.getElementById('dash-period')?.addEventListener('change', () => App.Dashboard.load());

  // Forms
  document.getElementById('btn-at-save')?.addEventListener('click', () => App.Forms.atendimento());
  document.getElementById('btn-gc-save')?.addEventListener('click', () => App.Forms.gestao());
  document.getElementById('btn-in-save')?.addEventListener('click', () => App.Forms.insatisfacao());
  document.getElementById('btn-cs-save')?.addEventListener('click', () => App.Forms.sensiveis());
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

  // `excluir` (não só `excluirPesquisa`) — o botão de lixeira na grid chama
  // `Pesquisas.excluir(id)`, mas só `excluirPesquisa` estava exposto aqui,
  // então o clique não fazia nada (TypeError silencioso no console).
  return { loadGrid, exportCSV, exportPDF, limpar, detail, marcarTratado, excluirPesquisa, excluir: excluirPesquisa, goPage };
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
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--gray-400);padding:32px">Nenhum cliente encontrado.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(c => {
      const hon = parseFloat(c.honorario_atual||c.honorario_inicial||0);
      const rec = parseFloat(c.receita_acumulada||0);
      const statusBadge = c.status==='ativo'
        ? '<span style="background:#f0fff4;color:#38a169;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">Ativo</span>'
        : '<span style="background:#fff5f5;color:#e53e3e;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">Encerrado</span>';
      // Health Score (0-100)
      const _iniRel = new Date(c.data_entrada);
      const _fimRel = c.data_saida ? new Date(c.data_saida) : new Date();
      const mesesRel = c.data_entrada
        ? Math.max(0, (_fimRel.getFullYear()-_iniRel.getFullYear())*12 + (_fimRel.getMonth()-_iniRel.getMonth()))
        : 0;
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
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--gray-400);padding:32px">Carregando...</td></tr>';
    const res = await fetch('/api/data/clientes?status=todos', {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!res || !res.ok) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#e53e3e;padding:32px">Erro ao carregar.</td></tr>';
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
    // Segunda trava além de "ser admin": precisa digitar a frase exata
    // (o backend também confere isso) — ação zera a Carteira inteira,
    // um clique errado antes não tinha proteção nenhuma além do backup diário.
    const FRASE_CONFIRMACAO = 'EXCLUIR TODOS OS CLIENTES';
    const confirmado = await new Promise(resolve => {
      App.Modal.open('⚠️ Confirmar limpeza',
        `<div style="text-align:center;padding:10px 0">
          <p style="font-size:15px;margin-bottom:8px">Você está prestes a <strong>excluir permanentemente</strong></p>
          <p style="font-size:28px;font-weight:800;color:#e53e3e;margin:12px 0">${total} cliente${total!==1?'s':''}</p>
          <p style="color:var(--gray-500);font-size:13px">Todo o histórico de honorários e eventos será perdido.</p>
          <p style="color:var(--gray-500);font-size:12px;margin-top:14px">Pra confirmar, digite <strong>${FRASE_CONFIRMACAO}</strong> abaixo:</p>
          <input id="cart-limpar-confirma-input" type="text" autocomplete="off"
            style="width:100%;padding:8px 10px;border:1px solid var(--gray-200);border-radius:8px;margin-top:6px;text-align:center;box-sizing:border-box" />
          <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
            <button class="btn btn-ghost" onclick="App.Modal.close()">Cancelar</button>
            <button class="btn" style="background:#e53e3e;color:#fff;border:none"
              onclick="document.dispatchEvent(new CustomEvent('cart-confirm-limpar'))">Sim, limpar tudo</button>
          </div>
        </div>`, () => resolve(false), { noFooter: true });
      document.addEventListener('cart-confirm-limpar', () => {
        const digitado = (document.getElementById('cart-limpar-confirma-input')?.value || '').trim();
        if (digitado !== FRASE_CONFIRMACAO) {
          App.Toast.err(`Digite exatamente "${FRASE_CONFIRMACAO}" pra confirmar.`);
          return;
        }
        App.Modal.close();
        resolve(true);
      }, {once:true});
    });
    if (!confirmado) return;
    const res = await fetch('/api/data/clientes/clear', {
      method:'DELETE',
      headers:{'Authorization':`Bearer ${_token()}`, 'Content-Type':'application/json'},
      body: JSON.stringify({ confirmar: FRASE_CONFIRMACAO }),
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
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--gray-400);padding:24px">Nenhum registro encontrado.</td></tr>';
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
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';
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
    _carregarAnalistasSelect();
  }

  async function _carregarAnalistasSelect() {
    const sel = document.getElementById('at-procurado');
    if (!sel) return;
    try {
      const res = await fetch('/api/analistas?ativo=true', { headers: { Authorization: `Bearer ${_token()}` } });
      if (!res || !res.ok) return;
      const { analistas } = await res.json();
      const atual = sel.value;
      sel.innerHTML = '<option value="">Selecione</option>' +
        (analistas || []).map(a => `<option value="${a.nome}">${a.nome}</option>`).join('');
      sel.value = atual;
    } catch (e) {
      console.error('[Atendimento] _carregarAnalistasSelect()', e);
    }
  }

  async function gerenciarAnalistas() {
    try {
      const res = await fetch('/api/analistas', { headers: { Authorization: `Bearer ${_token()}` } });
      if (!res || !res.ok) { App.Toast.err('Erro ao carregar analistas.'); return; }
      const { analistas } = await res.json();
      _renderAnalistasModal(analistas || []);
    } catch (e) {
      App.Toast.err('Erro ao carregar analistas.');
    }
  }

  function _renderAnalistasModal(lista) {
    const linhas = lista.map(a => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--gray-100)">
        <span style="${a.ativo ? '' : 'color:var(--gray-400);text-decoration:line-through'}">${a.nome}</span>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="Atendimento._toggleAnalista('${a.id}', ${!a.ativo})">${a.ativo ? 'Desativar' : 'Reativar'}</button>
          <button class="btn btn-sm" style="background:none;border:none;color:#e53e3e;cursor:pointer" onclick="Atendimento._excluirAnalista('${a.id}')" title="Excluir de vez">🗑</button>
        </div>
      </div>`).join('') || '<p style="color:var(--gray-400);font-size:13px;padding:12px 0">Nenhum analista cadastrado ainda.</p>';

    App.Modal.open('⚙️ Gerenciar Analistas',
      `<div style="display:flex;gap:8px;margin-bottom:16px">
        <input id="analista-novo-nome" type="text" placeholder="Nome do novo analista" style="flex:1;padding:8px 10px;border:1px solid var(--gray-200);border-radius:6px;font-size:13px">
        <button class="btn btn-sm" onclick="Atendimento._criarAnalista()">+ Adicionar</button>
      </div>
      <div style="max-height:320px;overflow-y:auto">${linhas}</div>`,
      () => App.Modal.close(), { noFooter: true });
  }

  async function _criarAnalista() {
    const input = document.getElementById('analista-novo-nome');
    const nome = (input?.value || '').trim();
    if (!nome) { App.Toast.err('Digite um nome.'); return; }
    try {
      const res = await fetch('/api/analistas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token()}` },
        body: JSON.stringify({ nome }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao criar.');
      App.Toast.ok('Analista adicionado!');
      await gerenciarAnalistas();
      await _carregarAnalistasSelect();
    } catch (e) {
      App.Toast.err(e.message);
    }
  }

  async function _toggleAnalista(id, ativo) {
    try {
      const res = await fetch(`/api/analistas/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token()}` },
        body: JSON.stringify({ ativo }),
      });
      if (!res.ok) throw new Error('Erro ao atualizar.');
      await gerenciarAnalistas();
      await _carregarAnalistasSelect();
    } catch (e) {
      App.Toast.err(e.message);
    }
  }

  async function _excluirAnalista(id) {
    if (!confirm('Excluir esse analista de vez? Atendimentos antigos continuam mostrando o nome, só não aparece mais na lista.')) return;
    try {
      const res = await fetch(`/api/analistas/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${_token()}` } });
      if (!res.ok) throw new Error('Erro ao excluir.');
      App.Toast.ok('Analista excluído.');
      await gerenciarAnalistas();
      await _carregarAnalistasSelect();
    } catch (e) {
      App.Toast.err(e.message);
    }
  }

  function exportCSV() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at', 'analista', 'cliente', 'cnpj', 'empresa', 'departamento', 'procurado', 'demanda', 'resumo'];
    const labels = {'created_at':'Data','analista':'Analista','cliente':'Cliente','cnpj':'CNPJ','empresa':'Empresa','departamento':'Departamento','procurado':'Procurado','demanda':'Demanda','resumo':'Resumo'};
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
    const cols = ['created_at', 'analista', 'cliente', 'cnpj', 'empresa', 'departamento', 'procurado', 'demanda', 'resumo'];
    const labels = {'created_at':'Data','analista':'Analista','cliente':'Cliente','cnpj':'CNPJ','empresa':'Empresa','departamento':'Departamento','procurado':'Procurado','demanda':'Demanda','resumo':'Resumo'};
    const ano = document.getElementById('at-ano-filter')?.value||'todos';
    const mes = document.getElementById('at-mes-filter')?.value||'todos';
    const titulo = `Atendimento — ${ano==='todos'?'Todos os anos':ano} / ${mes==='todos'?'Todos os meses':mes}`;
    const rows = data.map(r=>`<tr>${cols.map(c=>{let v=r[c]??'—';if(c==='created_at')v=new Date(v).toLocaleString('pt-BR');return`<td>${v}</td>`;}).join('')}</tr>`).join('');
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
  return { loadGrid, exportCSV, exportPDF, limpar, excluir, goPage, gerenciarAnalistas, _criarAnalista, _toggleAnalista, _excluirAnalista };
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

  const _FAIXA_LABEL = { acima: 'Acima da média', na_media: 'Na média', abaixo: 'Abaixo da média' };
  const _FAIXA_COR = { acima: '#38a169', na_media: '#2b6cb0', abaixo: '#e53e3e' };

  /**
   * Grupo de Empresas — mesmo padrão da lista canônica de Analistas
   * (ver Atendimento._carregarAnalistasSelect/gerenciarAnalistas): dropdown
   * gerenciável em vez de texto livre, pra não gerar duplicidade tipo
   * "Grupo Capanema" x "Grupo capanema". Alimenta tanto o <select> do
   * formulário (gc-grupo) quanto o filtro da grade (gc-grupo-filter).
   */
  async function _carregarGruposSelect() {
    const selForm = document.getElementById('gc-grupo');
    const selFiltro = document.getElementById('gc-grupo-filter');
    if (!selForm && !selFiltro) return;
    try {
      const res = await fetch('/api/grupos-empresas?ativo=true', { headers: { Authorization: `Bearer ${_token()}` } });
      if (!res || !res.ok) return;
      const { grupos } = await res.json();
      const lista = grupos || [];
      if (selForm) {
        const atual = selForm.value;
        selForm.innerHTML = '<option value="">Selecione (opcional)</option>' +
          lista.map(g => `<option value="${g.nome}">${g.nome}</option>`).join('');
        selForm.value = atual;
      }
      if (selFiltro) {
        const atual = selFiltro.value;
        selFiltro.innerHTML = '<option value="todos">Todos os grupos</option>' +
          lista.map(g => `<option value="${g.nome}">${g.nome}</option>`).join('');
        selFiltro.value = atual || 'todos';
      }
    } catch (e) {
      console.error('[Gestao] _carregarGruposSelect()', e);
    }
  }

  async function gerenciarGrupos() {
    try {
      const res = await fetch('/api/grupos-empresas', { headers: { Authorization: `Bearer ${_token()}` } });
      if (!res || !res.ok) { App.Toast.err('Erro ao carregar grupos.'); return; }
      const { grupos } = await res.json();
      _renderGruposModal(grupos || []);
    } catch (e) {
      App.Toast.err('Erro ao carregar grupos.');
    }
  }

  function _renderGruposModal(lista) {
    const linhas = lista.map(g => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--gray-100)">
        <span style="${g.ativo ? '' : 'color:var(--gray-400);text-decoration:line-through'}">${g.nome}</span>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="Gestao._toggleGrupo('${g.id}', ${!g.ativo})">${g.ativo ? 'Desativar' : 'Reativar'}</button>
          <button class="btn btn-sm" style="background:none;border:none;color:#e53e3e;cursor:pointer" onclick="Gestao._excluirGrupo('${g.id}')" title="Excluir de vez">🗑</button>
        </div>
      </div>`).join('') || '<p style="color:var(--gray-400);font-size:13px;padding:12px 0">Nenhum grupo cadastrado ainda.</p>';

    App.Modal.open('⚙️ Gerenciar Grupos de Empresas',
      `<div style="display:flex;gap:8px;margin-bottom:16px">
        <input id="grupo-novo-nome" type="text" placeholder="Nome do novo grupo (ex: Grupo Capanema)" style="flex:1;padding:8px 10px;border:1px solid var(--gray-200);border-radius:6px;font-size:13px">
        <button class="btn btn-sm" onclick="Gestao._criarGrupo()">+ Adicionar</button>
      </div>
      <div style="max-height:320px;overflow-y:auto">${linhas}</div>`,
      () => App.Modal.close(), { noFooter: true });
  }

  async function _criarGrupo() {
    const input = document.getElementById('grupo-novo-nome');
    const nome = (input?.value || '').trim();
    if (!nome) { App.Toast.err('Digite um nome.'); return; }
    try {
      const res = await fetch('/api/grupos-empresas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token()}` },
        body: JSON.stringify({ nome }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao criar.');
      App.Toast.ok('Grupo adicionado!');
      await gerenciarGrupos();
      await _carregarGruposSelect();
    } catch (e) {
      App.Toast.err(e.message);
    }
  }

  async function _toggleGrupo(id, ativo) {
    try {
      const res = await fetch(`/api/grupos-empresas/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token()}` },
        body: JSON.stringify({ ativo }),
      });
      if (!res.ok) throw new Error('Erro ao atualizar.');
      await gerenciarGrupos();
      await _carregarGruposSelect();
    } catch (e) {
      App.Toast.err(e.message);
    }
  }

  async function _excluirGrupo(id) {
    if (!confirm('Excluir esse grupo de vez? Registros antigos continuam mostrando o nome, só não aparece mais na lista.')) return;
    try {
      const res = await fetch(`/api/grupos-empresas/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${_token()}` } });
      if (!res.ok) throw new Error('Erro ao excluir.');
      App.Toast.ok('Grupo excluído.');
      await gerenciarGrupos();
      await _carregarGruposSelect();
    } catch (e) {
      App.Toast.err(e.message);
    }
  }

  /**
   * Unidade (ex.: "Escritorial Contadores", "Escritorial Soluções") — mesmo
   * padrão de lista canônica de Grupo de Empresas/Analistas: dropdown
   * gerenciável em vez de texto livre. Alimenta tanto o <select> do
   * formulário (gc-unidade) quanto o filtro da grade (gc-unidade-filter).
   */
  async function _carregarUnidadesSelect() {
    const selForm = document.getElementById('gc-unidade');
    const selFiltro = document.getElementById('gc-unidade-filter');
    if (!selForm && !selFiltro) return;
    try {
      const res = await fetch('/api/unidades?ativo=true', { headers: { Authorization: `Bearer ${_token()}` } });
      if (!res || !res.ok) return;
      const { unidades } = await res.json();
      const lista = unidades || [];
      if (selForm) {
        const atual = selForm.value;
        selForm.innerHTML = '<option value="">Selecione (opcional)</option>' +
          lista.map(u => `<option value="${u.nome}">${u.nome}</option>`).join('');
        selForm.value = atual;
      }
      if (selFiltro) {
        const atual = selFiltro.value;
        selFiltro.innerHTML = '<option value="todos">Todas as unidades</option>' +
          lista.map(u => `<option value="${u.nome}">${u.nome}</option>`).join('');
        selFiltro.value = atual || 'todos';
      }
    } catch (e) {
      console.error('[Gestao] _carregarUnidadesSelect()', e);
    }
  }

  async function gerenciarUnidades() {
    try {
      const res = await fetch('/api/unidades', { headers: { Authorization: `Bearer ${_token()}` } });
      if (!res || !res.ok) { App.Toast.err('Erro ao carregar unidades.'); return; }
      const { unidades } = await res.json();
      _renderUnidadesModal(unidades || []);
    } catch (e) {
      App.Toast.err('Erro ao carregar unidades.');
    }
  }

  function _renderUnidadesModal(lista) {
    const linhas = lista.map(u => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--gray-100)">
        <span style="${u.ativo ? '' : 'color:var(--gray-400);text-decoration:line-through'}">${u.nome}</span>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="Gestao._toggleUnidade('${u.id}', ${!u.ativo})">${u.ativo ? 'Desativar' : 'Reativar'}</button>
          <button class="btn btn-sm" style="background:none;border:none;color:#e53e3e;cursor:pointer" onclick="Gestao._excluirUnidade('${u.id}')" title="Excluir de vez">🗑</button>
        </div>
      </div>`).join('') || '<p style="color:var(--gray-400);font-size:13px;padding:12px 0">Nenhuma unidade cadastrada ainda.</p>';

    App.Modal.open('⚙️ Gerenciar Unidades',
      `<div style="display:flex;gap:8px;margin-bottom:16px">
        <input id="unidade-novo-nome" type="text" placeholder="Nome da unidade (ex: Escritorial Contadores)" style="flex:1;padding:8px 10px;border:1px solid var(--gray-200);border-radius:6px;font-size:13px">
        <button class="btn btn-sm" onclick="Gestao._criarUnidade()">+ Adicionar</button>
      </div>
      <div style="max-height:320px;overflow-y:auto">${linhas}</div>`,
      () => App.Modal.close(), { noFooter: true });
  }

  async function _criarUnidade() {
    const input = document.getElementById('unidade-novo-nome');
    const nome = (input?.value || '').trim();
    if (!nome) { App.Toast.err('Digite um nome.'); return; }
    try {
      const res = await fetch('/api/unidades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token()}` },
        body: JSON.stringify({ nome }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao criar.');
      App.Toast.ok('Unidade adicionada!');
      await gerenciarUnidades();
      await _carregarUnidadesSelect();
    } catch (e) {
      App.Toast.err(e.message);
    }
  }

  async function _toggleUnidade(id, ativo) {
    try {
      const res = await fetch(`/api/unidades/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token()}` },
        body: JSON.stringify({ ativo }),
      });
      if (!res.ok) throw new Error('Erro ao atualizar.');
      await gerenciarUnidades();
      await _carregarUnidadesSelect();
    } catch (e) {
      App.Toast.err(e.message);
    }
  }

  async function _excluirUnidade(id) {
    if (!confirm('Excluir essa unidade de vez? Registros antigos continuam mostrando o nome, só não aparece mais na lista.')) return;
    try {
      const res = await fetch(`/api/unidades/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${_token()}` } });
      if (!res.ok) throw new Error('Erro ao excluir.');
      App.Toast.ok('Unidade excluída.');
      await gerenciarUnidades();
      await _carregarUnidadesSelect();
    } catch (e) {
      App.Toast.err(e.message);
    }
  }

  function _filterData(data) {
    const ano = document.getElementById('gc-ano-filter')?.value || 'todos';
    const mes = document.getElementById('gc-mes-filter')?.value || 'todos';
    const grupo = document.getElementById('gc-grupo-filter')?.value || 'todos';
    const unidade = document.getElementById('gc-unidade-filter')?.value || 'todos';
    const faixa = document.getElementById('gc-faixa-filter')?.value || 'todos';
    const soInadimplente = document.getElementById('gc-inadimplente-filter')?.checked || false;
    return data.filter(r => {
      const d = new Date(r.created_at);
      if (ano !== 'todos' && d.getFullYear() !== Number(ano)) return false;
      if (mes !== 'todos' && String(d.getMonth()+1).padStart(2,'0') !== mes) return false;
      if (grupo !== 'todos' && r.grupo_empresas !== grupo) return false;
      if (unidade !== 'todos' && r.unidade !== unidade) return false;
      if (faixa !== 'todos' && r.faixa !== faixa) return false;
      if (soInadimplente && !r.inadimplente_cronico) return false;

      return true;
    });
  }

  function _renderGrid(data) {
    const tbody = document.getElementById('gc-tbody');
    if (!tbody) return;
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="14" style="text-align:center;color:var(--gray-400);padding:24px">Nenhum registro encontrado.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(r => {
      const d = new Date(r.created_at).toLocaleString('pt-BR');
      const lixeira = App.Auth.isAdmin() ? `<button class="btn btn-sm" style="background:none;border:none;cursor:pointer;color:#e53e3e;font-size:16px;padding:2px 6px" onclick="Gestao.excluir('${r.id}')" title="Excluir">🗑</button>` : '';
      const faixaTag = r.faixa ? `<span style="font-size:11px;font-weight:700;color:${_FAIXA_COR[r.faixa]}">${_FAIXA_LABEL[r.faixa]}</span>` : '<span style="color:var(--gray-400)">—</span>';
      const inadimplenteTag = r.inadimplente_cronico ? ' 🔴' : '';
      return `<tr>
        <td style="font-size:12px;color:var(--gray-500)">${d}</td>
        <td>${r.analista}</td>
        <td style="font-size:11px;color:var(--gray-400);font-weight:600">${r.codigo||'—'}</td>
        <td style="font-size:12px">${r.cnpj||'—'}</td>
        <td style="font-weight:600">${r.empresa}${inadimplenteTag}</td>
        <td>${r.solicitacao}</td>
        <td>${r.canal||'—'}</td>
        <td style="font-size:12px;color:var(--gray-500)">${r.data_sol ? new Date(r.data_sol).toLocaleDateString('pt-BR') : '—'}</td>
        <td style="font-size:12px;color:var(--gray-500)">${(() => {
          const c = r.competencia;
          if (!c) return '—';
          const m = String(c).match(/^(\d{4})-(\d{2})/);
          if (m) return m[2] + '/' + m[1];
          const d = new Date(c);
          return isNaN(d.getTime()) ? String(c) : d.toLocaleDateString('pt-BR');
        })()}</td>
        <td style="font-size:12px">${r.grupo_empresas || '—'}</td>
        <td style="font-size:12px">${r.unidade || '—'}</td>
        <td style="font-size:12px">${r.honorario_atual != null ? 'R$ ' + Number(r.honorario_atual).toLocaleString('pt-BR',{minimumFractionDigits:2}) : '—'}</td>
        <td>${faixaTag}</td>
        <td>${lixeira}</td></tr>`;
    }).join('');
  }

  async function loadGrid() {
    const tbody = document.getElementById('gc-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="14" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';
    const res = await fetch('/api/data/gestao?period=todos', {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!res || !res.ok) {
      tbody.innerHTML = '<tr><td colspan="14" style="text-align:center;color:#e53e3e;padding:24px">Erro ao carregar.</td></tr>';
      return;
    }
    const { data, ticketMedio, ticketMedioPorUnidade } = await res.json();
    _allData = data || [];
    _populateYearFilter(_allData);
    await _carregarGruposSelect();
    await _carregarUnidadesSelect();
    // Se um filtro de Unidade estiver selecionado, mostra o ticket médio
    // daquela unidade específica (ex.: só as ~100 empresas da Escritorial
    // Soluções); senão mostra a média geral da Carteira.
    const unidadeFiltro = document.getElementById('gc-unidade-filter')?.value || 'todos';
    const valorEl = document.getElementById('gc-ticket-medio-valor');
    if (valorEl) {
      if (unidadeFiltro !== 'todos' && Array.isArray(ticketMedioPorUnidade)) {
        const doUnidade = ticketMedioPorUnidade.find(u => u.unidade === unidadeFiltro);
        valorEl.textContent = doUnidade
          ? `R$ ${Number(doUnidade.ticket).toLocaleString('pt-BR',{minimumFractionDigits:2})} (${doUnidade.quantidade} empresa${doUnidade.quantidade!==1?'s':''})`
          : '—';
      } else {
        valorEl.textContent = ticketMedio ? 'R$ ' + Number(ticketMedio).toLocaleString('pt-BR',{minimumFractionDigits:2}) : '—';
      }
    }
    const _filtered = _filterData(_allData);
    const _paged = App.Util.paginate(_filtered, _page);
    _renderGrid(_paged.items);
    App.Util.renderPagination('gc-pagination', _paged.page, _paged.pages, _paged.total, 'Gestao.goPage');
  }

  function exportCSV() {
    const data = _filterData(_allData);
    if (!data.length) { App.Toast.err('Nenhum dado para exportar.'); return; }
    const cols = ['created_at', 'analista', 'cnpj', 'empresa', 'solicitacao', 'canal', 'motivo', 'grupo_empresas', 'unidade', 'honorario_atual', 'faixa', 'inadimplente_cronico'];
    const labels = {'created_at':'Data','analista':'Analista','cnpj':'CNPJ','empresa':'Empresa','solicitacao':'Solicitação','canal':'Canal','motivo':'Motivo','grupo_empresas':'Grupo de Empresas','unidade':'Unidade','honorario_atual':'Honorário Atual','faixa':'Faixa','inadimplente_cronico':'Inadimplente Crônico'};
    const header = cols.map(c=>labels[c]||c).join(';');
    const rows = data.map(r => cols.map(c => {
      let v = r[c] ?? '';
      if (c==='created_at') v = new Date(v).toLocaleString('pt-BR');
      if (c==='faixa') v = _FAIXA_LABEL[v] || '';
      if (c==='inadimplente_cronico') v = v ? 'Sim' : 'Não';
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
    const cols = ['created_at', 'analista', 'cnpj', 'empresa', 'solicitacao', 'canal', 'motivo', 'grupo_empresas', 'unidade', 'honorario_atual', 'faixa', 'inadimplente_cronico'];
    const labels = {'created_at':'Data','analista':'Analista','cnpj':'CNPJ','empresa':'Empresa','solicitacao':'Solicitação','canal':'Canal','motivo':'Motivo','grupo_empresas':'Grupo de Empresas','unidade':'Unidade','honorario_atual':'Honorário Atual','faixa':'Faixa','inadimplente_cronico':'Inadimplente Crônico'};
    const ano = document.getElementById('gc-ano-filter')?.value||'todos';
    const mes = document.getElementById('gc-mes-filter')?.value||'todos';
    const titulo = `Gestão de Clientes — ${ano==='todos'?'Todos os anos':ano} / ${mes==='todos'?'Todos os meses':mes}`;
    const rows = data.map(r=>`<tr>${cols.map(c=>{
      let v=r[c]??'—';
      if(c==='created_at')v=new Date(v).toLocaleString('pt-BR');
      if(c==='faixa')v=_FAIXA_LABEL[v]||'—';
      if(c==='inadimplente_cronico')v=v?'Sim':'Não';
      if(c==='honorario_atual'&&v!=='—')v='R$ '+Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2});
      return`<td>${v}</td>`;}).join('')}</tr>`).join('');
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

  // ── Importação em massa (planilha .xlsx/.csv) ───────────────────────────────
  // Nunca pergunta sobre abrir ticket — isso é só do fluxo manual (ver Forms.gestao()).
  function _semAcentos(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function _chaveNormalizada(s) { return _semAcentos(s).toLowerCase().trim().replace(/\s+/g, ' ').replace(/\s*\*\s*$/, ''); }

  // Cada campo aceita algumas variações de cabeçalho (maiúsculas/acentos não importam).
  const _CABECALHOS = {
    analista: ['analista responsavel', 'analista', 'analista responsável'],
    solicitacao: ['solicitacao', 'solicitação'],
    cnpj: ['cnpj'],
    empresa: ['empresa'],
    codigo: ['codigo do cliente', 'codigo', 'código do cliente', 'código'],
    data_sol: ['data da solicitacao', 'data solicitacao', 'data da solicitação'],
    competencia: ['fim da competencia', 'competencia', 'fim da competência', 'competência'],
    canal: ['canal da solicitacao', 'canal', 'canal da solicitação'],
    regime_tributario: ['regime tributario', 'regime', 'regime tributário'],
    motivo: ['motivo'],
    data_entrada: ['data de entrada do cliente', 'data de entrada', 'data entrada'],
    honorario_inicial: ['honorario inicial (r$)', 'honorario inicial', 'honorário inicial (r$)', 'honorário inicial'],
    origem: ['origem do cliente', 'origem'],
    data_saida: ['data de encerramento', 'data de saida', 'data encerramento', 'data de saída'],
    grupo_empresas: ['grupo de empresas', 'grupo empresas', 'grupo'],
    unidade: ['unidade', 'unidade (escritorial contadores/solucoes)', 'unidade (escritorial contadores/soluções)'],
    inadimplente_cronico: ['inadimplente cronico (sim/nao)', 'inadimplente cronico', 'inadimplente crônico (sim/não)', 'inadimplente crônico'],
  };

  function _valorPorCampo(linhaBruta, campo) {
    const variantes = _CABECALHOS[campo];
    for (const chaveOriginal of Object.keys(linhaBruta)) {
      if (variantes.includes(_chaveNormalizada(chaveOriginal))) return linhaBruta[chaveOriginal];
    }
    return '';
  }

  /** Converte Date/serial/"dd/mm/aaaa"/"aaaa-mm-dd" em "aaaa-mm-dd". Vazio se não reconhecer. */
  function _normalizarData(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date) {
      const y = v.getUTCFullYear(), m = String(v.getUTCMonth() + 1).padStart(2, '0'), d = String(v.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return '';
  }

  /** Converte Date/serial/"mm/aaaa"/"aaaa-mm" em "aaaa-mm". Vazio se não reconhecer. */
  function _normalizarCompetencia(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date) {
      return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}`;
    m = s.match(/^(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
    return '';
  }

  function _linhaPlanilhaParaLinhaImportacao(bruta) {
    return {
      analista: String(_valorPorCampo(bruta, 'analista') || '').trim(),
      solicitacao: String(_valorPorCampo(bruta, 'solicitacao') || '').trim(),
      cnpj: String(_valorPorCampo(bruta, 'cnpj') || '').trim(),
      empresa: String(_valorPorCampo(bruta, 'empresa') || '').trim(),
      codigo: String(_valorPorCampo(bruta, 'codigo') || '').trim() || null,
      data_sol: _normalizarData(_valorPorCampo(bruta, 'data_sol')),
      competencia: _normalizarCompetencia(_valorPorCampo(bruta, 'competencia')),
      canal: String(_valorPorCampo(bruta, 'canal') || '').trim(),
      regime_tributario: String(_valorPorCampo(bruta, 'regime_tributario') || '').trim(),
      motivo: String(_valorPorCampo(bruta, 'motivo') || '').trim() || null,
      data_entrada: _normalizarData(_valorPorCampo(bruta, 'data_entrada')),
      honorario_inicial: parseFloat(String(_valorPorCampo(bruta, 'honorario_inicial') || '').replace(',', '.')) || null,
      origem: String(_valorPorCampo(bruta, 'origem') || '').trim() || null,
      data_saida: _normalizarData(_valorPorCampo(bruta, 'data_saida')),
      grupo_empresas: String(_valorPorCampo(bruta, 'grupo_empresas') || '').trim() || null,
      unidade: String(_valorPorCampo(bruta, 'unidade') || '').trim() || null,
      inadimplente_cronico: _semAcentos(String(_valorPorCampo(bruta, 'inadimplente_cronico') || '')).trim().toLowerCase() === 'sim',
    };
  }

  function _resultadoImportacaoHTML(r) {
    const listaErros = (r.erros || []).map(e => `<li><strong>Linha ${e.linha}</strong> (${_esc(e.empresa)}): ${_esc(e.motivo)}</li>`).join('');
    const listaAvisos = (r.avisos || []).map(a => `<li><strong>Linha ${a.linha}</strong> (${_esc(a.empresa)}): ${_esc(a.motivo)}</li>`).join('');
    return `<div style="padding:6px 0">
      <p style="font-size:28px;font-weight:800;color:#38a169;margin:0 0 4px">${r.processados}</p>
      <p style="color:var(--gray-500);font-size:13px;margin-bottom:16px">registro${r.processados !== 1 ? 's' : ''} importado${r.processados !== 1 ? 's' : ''} com sucesso</p>
      ${listaAvisos ? `<div style="margin-bottom:14px"><p style="font-weight:700;color:#d69e2e;font-size:13px;margin-bottom:6px">⚠️ Avisos (${r.avisos.length})</p><ul style="font-size:12px;color:var(--gray-600);padding-left:18px;max-height:160px;overflow:auto">${listaAvisos}</ul></div>` : ''}
      ${listaErros ? `<div><p style="font-weight:700;color:#e53e3e;font-size:13px;margin-bottom:6px">❌ Linhas com erro — não foram importadas (${r.erros.length})</p><ul style="font-size:12px;color:var(--gray-600);padding-left:18px;max-height:160px;overflow:auto">${listaErros}</ul></div>` : ''}
      <div style="text-align:right;margin-top:16px"><button class="btn btn-primary" onclick="App.Modal.close()">Entendi</button></div>
    </div>`;
  }
  function _esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

  async function importarPlanilha(file) {
    const input = document.getElementById('gc-import-file');
    if (!file) return;
    if (!App.Auth.isAdmin()) { App.Toast.err('Importação restrita a administradores.'); if (input) input.value = ''; return; }
    if (typeof XLSX === 'undefined') { App.Toast.err('Biblioteca de planilha não carregou — recarregue a página e tente de novo.'); if (input) input.value = ''; return; }
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const brutas = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const linhas = brutas
        .map(_linhaPlanilhaParaLinhaImportacao)
        .filter(l => l.analista || l.empresa || l.cnpj); // ignora linhas totalmente vazias no fim da planilha
      if (!linhas.length) { App.Toast.err('Não encontrei nenhuma linha com dados na planilha.'); if (input) input.value = ''; return; }

      App.Toast.ok(`Importando ${linhas.length} linha(s)...`);
      const res = await fetch('/api/data/gestao/importar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_token()}` },
        body: JSON.stringify({ linhas }),
      });
      if (!res || !res.ok) {
        const err = await res?.json().catch(() => ({}));
        App.Toast.err(err?.error || 'Erro ao importar planilha.');
        return;
      }
      const resultado = await res.json();
      App.Modal.open('📤 Resultado da importação', _resultadoImportacaoHTML(resultado), () => {}, { noFooter: true });
      loadGrid();
    } catch (e) {
      console.error('[Gestao] importarPlanilha', e);
      App.Toast.err('Não consegui ler essa planilha. Confirme se é um .xlsx, .xls ou .csv válido.');
    } finally {
      if (input) input.value = '';
    }
  }

  return {
    loadGrid, exportCSV, exportPDF, limpar, excluir, goPage, importarPlanilha,
    gerenciarGrupos, _criarGrupo, _toggleGrupo, _excluirGrupo,
    gerenciarUnidades, _criarUnidade, _toggleUnidade, _excluirUnidade,
  };
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
    const rows = data.map(r=>`<tr>${cols.map(c=>{let v=r[c]??'—';if(c==='created_at')v=new Date(v).toLocaleString('pt-BR');return`<td>${v}</td>`;}).join('')}</tr>`).join('');
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
      tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:#e53e3e;padding:24px">Erro ao carregar.</td></tr>';
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
    const rows = data.map(r=>`<tr>${cols.map(c=>{let v=r[c]??'—';if(c==='created_at')v=new Date(v).toLocaleString('pt-BR');return`<td>${v}</td>`;}).join('')}</tr>`).join('');
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
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--gray-400);padding:24px">Nenhum registro encontrado.</td></tr>';
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
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--gray-400);padding:24px">Carregando...</td></tr>';
    const res = await fetch('/api/data/sensiveis?period=todos', {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!res || !res.ok) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#e53e3e;padding:24px">Erro ao carregar.</td></tr>';
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
    const rows = data.map(r=>`<tr>${cols.map(c=>{let v=r[c]??'—';if(c==='created_at')v=new Date(v).toLocaleString('pt-BR');return`<td>${v}</td>`;}).join('')}</tr>`).join('');
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
    // Mesma segunda trava que os outros módulos de exclusão já têm — o
    // botão só aparece pra admin na tela, mas a função em si não conferia
    // de novo (quem chamasse CAC.excluir(id) pelo console driblava isso).
    if (!App.Auth.isAdmin()) { App.Toast.err('Acesso restrito a administradores.'); return; }
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
    // Escapa aspas duplas dentro do valor — descricao é texto livre e pode
    // ter "" no meio, o que quebra as colunas ao abrir no Excel.
    const esc = v => String(v == null ? '' : v).replace(/"/g, '""');
    const rows = _data.map(r => '"' + esc(_mesLabel(r.mes)) + '";"' + esc(r.canal) + '";"' + esc(r.valor) + '";"' + esc(r.descricao||'') + '";"' + esc(r.lancado_por||'') + '"');
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
  let _mostrarConsolidado = true; // liga/desliga o card "Consolidado Geral" na página pública

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
      _mostrarConsolidado = d.mostrar_consolidado !== false;
      _atualizarBotaoConsolidado();
    }
  }

  function _atualizarBotaoConsolidado() {
    const btn = document.getElementById('gam-btn-consolidado');
    if (!btn) return;
    btn.textContent = _mostrarConsolidado ? '👁️ Consolidado Geral: Visível' : '🚫 Consolidado Geral: Oculto';
    btn.style.color = _mostrarConsolidado ? '' : '#e53e3e';
  }

  /**
   * Liga/desliga o card "Consolidado Geral" na página pública de
   * Gamificação — pedido da Thais: "quero criar um botão para ocultar e
   * desocultar o Consolidado Geral... ligo e desligo no painel interno,
   * somente para o consolidado geral". Não mexe no ranking mensal, só nesse
   * card específico. Reaproveita GET/PATCH /api/data/gam/config (mesma rota
   * do Peso Mínimo), só que enviando mostrar_consolidado em vez de
   * peso_minimo — o backend aceita os dois campos de forma independente.
   */
  async function toggleConsolidado() {
    const novoValor = !_mostrarConsolidado;
    const res = await fetch('/api/data/gam/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tk() },
      body: JSON.stringify({ mostrar_consolidado: novoValor })
    });
    if (res && res.ok) {
      _mostrarConsolidado = novoValor;
      _atualizarBotaoConsolidado();
      App.Toast.ok(novoValor ? 'Consolidado Geral agora está visível na página pública.' : 'Consolidado Geral ocultado da página pública.');
    } else {
      App.Toast.err('Erro ao alterar visibilidade do Consolidado Geral.');
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
      .sort((a, b) => {
        // Critério principal: maior nota final
        const diff = b.notaFinal - a.notaFinal;
        if (Math.abs(diff) >= 0.005) return diff;
        // Desempate 1: maior número de avaliações
        if (parseInt(b.avaliacoes) !== parseInt(a.avaliacoes)) return parseInt(b.avaliacoes) - parseInt(a.avaliacoes);
        // Desempate 2: maior média individual
        const diffMi = parseFloat(b.media_individual) - parseFloat(a.media_individual);
        if (Math.abs(diffMi) >= 0.005) return diffMi;
        // Desempate 3: ordem alfabética
        return (a.nome||'').localeCompare(b.nome||'', 'pt-BR');
      });

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
    abrirConfig, salvarConfig, toggleConsolidado,
    abrirColaboradores, adicionarColaborador, toggleColaborador, excluirColaborador,
  };
})();

window.Gamificacao = Gamificacao;

// ── Módulo Tickets Contábeis ──────────────────────────────────────────────────
const Tickets = (() => {
  const _tk = () => localStorage.getItem('ge_token') || '';
  let _todos = [];
  let _filtroAtual = 'todos';

  const CHECKLIST_MAP = {
    'Baixa de empresa': {
      'Simples Nacional': ['Balanço','DRE','DEFIS','REINF'],
      'Lucro Presumido':  ['Balanço','DRE','ECD Baixa','ECF Baixa','DEFIS','REINF'],
      'Lucro Real':       ['Balanço','DRE','ECD Baixa','ECF Baixa','DEFIS','REINF'],
    },
    'Saída de empresa': {
      'Simples Nacional': ['Balanço','DRE','REINF'],
      'Lucro Presumido':  ['Balanço','DRE','ECD','REINF'],
      'Lucro Real':       ['Balanço','DRE','ECD','REINF'],
    },
  };

  const STATUS_LABEL = { nova:'🔴 Nova', resolvendo:'🟡 Resolvendo', encerrada:'🟢 Encerrada' };
  const STATUS_COLOR = { nova:'#fee2e2', resolvendo:'#fef9c3', encerrada:'#dcfce7' };
  const STATUS_TEXT  = { nova:'#991b1b', resolvendo:'#854d0e', encerrada:'#166534' };

  async function load() {
    const lista = document.getElementById('tk-lista');
    if (!lista) return;
    lista.innerHTML = '<div style="text-align:center;color:var(--gray-400);padding:40px">Carregando...</div>';
    const res = await fetch('/api/data/tickets', { headers: { Authorization: 'Bearer ' + _tk() } });
    if (!res || !res.ok) { lista.innerHTML = '<div style="text-align:center;color:#e53e3e;padding:40px">Erro ao carregar tickets.</div>'; return; }
    const { data } = await res.json();
    _todos = data || [];
    _renderLista();
  }

  function filtrar(f) {
    _filtroAtual = f;
    ['todos','nova','resolv','encerrada'].forEach(k => {
      const btn = document.getElementById('tk-filtro-' + k);
      if (btn) btn.style.fontWeight = (k === f || (k==='resolv' && f==='resolvendo')) ? '800' : '600';
    });
    _renderLista();
  }

  function _renderLista() {
    const lista = document.getElementById('tk-lista');
    if (!lista) return;
    const filtrados = _filtroAtual === 'todos' ? _todos : _todos.filter(t => t.status === _filtroAtual);
    const barraLimpar = (App.Auth.isAdmin() && _todos.length)
      ? '<div style="display:flex;justify-content:flex-end;margin-bottom:12px"><button onclick="Tickets.limparTickets()" style="background:#fff5f5;color:#e53e3e;border:1px solid #fed7d7;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer">🗑 Limpar Tickets</button></div>'
      : '';
    if (!filtrados.length) {
      lista.innerHTML = barraLimpar + '<div style="text-align:center;color:var(--gray-400);padding:40px">Nenhum ticket encontrado.</div>';
      return;
    }
    lista.innerHTML = barraLimpar + filtrados.map(t => {
      const dias = parseInt(t.dias) || 0;
      const total = t.checklist?.length || 0;
      const feitos = t.checklist?.filter(c => c.ok).length || 0;
      const mencoes = (t.mencoes||[]).map(m => m.nome).join(', ') || '—';
      return '<div style="background:#fff;border:1px solid var(--gray-200);border-radius:12px;padding:16px 20px;margin-bottom:12px;cursor:pointer;transition:box-shadow .15s" onclick="Tickets.abrirTicket(\'' + t.id + '\')" onmouseover="this.style.boxShadow=\'0 4px 16px rgba(0,0,0,.08)\'" onmouseout="this.style.boxShadow=\'none\'">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">' +
          '<div>' +
            '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
              '<span style="font-weight:800;font-size:15px;color:var(--g800)">' + t.empresa + '</span>' +
              '<span style="background:' + STATUS_COLOR[t.status] + ';color:' + STATUS_TEXT[t.status] + ';padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700">' + STATUS_LABEL[t.status] + '</span>' +
              '<span style="font-size:11px;color:var(--gray-400)">' + dias + ' dia' + (dias!==1?'s':'') + ' aberto</span>' +
            '</div>' +
            '<div style="font-size:12px;color:var(--gray-500);margin-top:4px">' + t.cnpj + ' · ' + t.regime + ' · ' + t.tipo_movimentacao + '</div>' +
            '<div style="font-size:12px;color:var(--gray-400);margin-top:2px">Responsáveis: ' + mencoes + '</div>' +
          '</div>' +
          '<div style="text-align:right;flex-shrink:0">' +
            '<div style="font-size:12px;font-weight:700;color:var(--g700)">' + feitos + '/' + total + ' itens</div>' +
            '<div style="background:var(--gray-100);border-radius:6px;height:6px;width:80px;margin-top:4px;overflow:hidden">' +
              '<div style="background:var(--g700);height:100%;width:' + (total ? Math.round(feitos/total*100) : 0) + '%"></div>' +
            '</div>' +
            '<div style="font-size:11px;color:var(--gray-400);margin-top:4px">Aberto por ' + t.criado_por + '</div>' +
            (App.Auth.isAdmin() ? '<button title="Excluir ticket" onclick="event.stopPropagation();Tickets.excluir(\'' + t.id + '\')" style="margin-top:8px;background:#fff5f5;color:#e53e3e;border:1px solid #fed7d7;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer">🗑 Excluir</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  async function abrirTicket(id) {
    const res = await fetch('/api/data/tickets/' + id, { headers: { Authorization: 'Bearer ' + _tk() } });
    if (!res || !res.ok) { App.Toast.err('Erro ao carregar ticket.'); return; }
    const { data: t } = await res.json();
    const diasStr = (parseInt(t.dias)||0) + ' dia(s) aberto(s)';

    const checklistHtml = (t.checklist||[]).map((c, i) => {
      const cor = c.ok ? '#166534' : 'var(--gray-600)';
      const bg  = c.ok ? '#dcfce7' : '#f8fafc';
      const info = c.ok ? ' — ' + c.por + ' em ' + new Date(c.em).toLocaleString('pt-BR') : '';
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:' + bg + ';border-radius:8px;margin-bottom:6px">' +
        '<input type="checkbox" ' + (c.ok?'checked':'') + ' style="width:16px;height:16px;cursor:pointer" data-idx="' + i + '" data-tid="' + id + '" onchange="Tickets.marcarItem(\'' + id + '\',' + i + ',this)">' +
        '<span style="font-weight:600;color:' + cor + '">' + (c.ok?'✅ ':'') + c.item + (c.ok?' OK':'') + '</span>' +
        '<span style="font-size:11px;color:var(--gray-400)">' + info + '</span>' +
      '</div>';
    }).join('');

    const interacoesHtml = (t.interacoes||[]).map(i => {
      const bg = i.is_automatica ? '#f0fdf4' : '#f8fafc';
      const bord = i.is_automatica ? '#bbf7d0' : 'var(--gray-200)';
      return '<div style="background:' + bg + ';border:1px solid ' + bord + ';border-radius:8px;padding:10px 14px;margin-bottom:8px">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
          '<span style="font-size:12px;font-weight:700;color:var(--g700)">' + (i.is_automatica ? '🤖 Sistema' : i.autor_nome) + '</span>' +
          '<span style="font-size:11px;color:var(--gray-400)">' + new Date(i.created_at).toLocaleString('pt-BR') + '</span>' +
        '</div>' +
        '<div style="font-size:13px;color:var(--gray-700)">' + i.comentario + '</div>' +
      '</div>';
    }).join('') || '<div style="color:var(--gray-400);font-size:13px;padding:8px">Nenhuma interação ainda.</div>';

    const isAdmin = App.Auth.isAdmin();

    // Bloco com os dados vindos da Gestão de Clientes
    let dg = t.dados_gestao;
    if (typeof dg === 'string') { try { dg = JSON.parse(dg); } catch(e){ dg = null; } }
    const _fmtData = (d) => { if (!d) return ''; const dt = new Date(d); return isNaN(dt) ? d : dt.toLocaleDateString('pt-BR'); };
    const _fmtComp = (c) => { if (!c) return ''; const m = String(c).match(/^(\d{4})-(\d{2})/); return m ? m[2] + '/' + m[1] : c; };
    const _linha = (rot, val) => val ? '<div style="display:flex;gap:6px;font-size:12px;padding:2px 0"><span style="color:var(--gray-400);min-width:130px">' + rot + '</span><span style="color:var(--gray-700);font-weight:600">' + val + '</span></div>' : '';
    const dadosGestaoHtml = (dg && Object.keys(dg).length) ? (
      '<div style="background:#f8fafc;border:1px solid var(--gray-200);border-radius:8px;padding:12px 14px">' +
        '<div style="font-size:12px;font-weight:700;color:var(--g800);margin-bottom:8px">📄 Dados da Gestão de Clientes</div>' +
        _linha('Analista', dg.analista) +
        _linha('Código do cliente', dg.codigo) +
        _linha('Data da solicitação', _fmtData(dg.data_sol)) +
        _linha('Canal', dg.canal) +
        _linha('Competência', _fmtComp(dg.competencia)) +
        _linha('Motivo da saída', dg.motivo) +
        _linha('Data de encerramento', _fmtData(dg.data_encerramento)) +
      '</div>'
    ) : '';

    const statusBtns = isAdmin ? (
      t.status !== 'encerrada'
        ? '<button class="btn btn-success btn-sm" onclick="Tickets.mudarStatus(\'' + id + '\',\'encerrada\')">✅ Encerrar ticket</button>'
        : '<button class="btn btn-ghost btn-sm" onclick="Tickets.mudarStatus(\'' + id + '\',\'resolvendo\')">🔄 Reabrir ticket</button>'
    ) : '';

    App.Modal.open('Ticket — ' + t.empresa,
      '<div style="display:grid;gap:16px">' +
        '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
          '<span style="background:' + STATUS_COLOR[t.status] + ';color:' + STATUS_TEXT[t.status] + ';padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700">' + STATUS_LABEL[t.status] + '</span>' +
          '<span style="font-size:12px;color:var(--gray-500)">⏱ ' + diasStr + '</span>' +
          '<span style="font-size:12px;color:var(--gray-500)">' + t.cnpj + ' · ' + t.regime + ' · ' + t.tipo_movimentacao + '</span>' +
        '</div>' +
        (t.observacoes ? '<div style="background:#f8fafc;border-radius:8px;padding:10px 14px;font-size:13px;color:var(--gray-700)"><strong>Observações:</strong> ' + t.observacoes + '</div>' : '') +
        dadosGestaoHtml +
        '<div>' +
          '<div style="font-size:13px;font-weight:700;color:var(--g800);margin-bottom:8px">📋 Checklist</div>' +
          checklistHtml +
        '</div>' +
        '<div>' +
          '<div style="font-size:13px;font-weight:700;color:var(--g800);margin-bottom:8px">💬 Interações</div>' +
          interacoesHtml +
        '</div>' +
        '<div>' +
          '<div style="font-size:13px;font-weight:700;color:var(--g800);margin-bottom:6px">Adicionar comentário</div>' +
          '<textarea id="tk-comentario-input" style="width:100%;min-height:70px;padding:8px 12px;border:1px solid var(--gray-200);border-radius:8px;font-size:13px;resize:vertical" placeholder="Digite seu comentário..."></textarea>' +
          '<div style="display:flex;gap:8px;margin-top:8px;justify-content:space-between;align-items:center">' +
            statusBtns +
            '<button class="btn btn-primary btn-sm" onclick="Tickets.enviarComentario(\'' + id + '\')">Enviar</button>' +
          '</div>' +
        '</div>' +
      '</div>',
      null, { noFooter: true }
    );
  }

  async function marcarItem(ticketId, idx, checkbox) {
    const res = await fetch('/api/data/tickets/' + ticketId + '/checklist', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tk() },
      body: JSON.stringify({ item_index: idx })
    });
    if (res && res.ok) {
      const { todosOk } = await res.json();
      if (todosOk) App.Toast.ok('✅ Checklist completo! Documentos direcionados para cs@escritorial.com.br');
      await abrirTicket(ticketId);
      load();
    } else {
      checkbox.checked = !checkbox.checked;
      App.Toast.err('Erro ao marcar item.');
    }
  }

  async function enviarComentario(ticketId) {
    const comentario = document.getElementById('tk-comentario-input')?.value?.trim();
    if (!comentario) { App.Toast.err('Digite um comentário.'); return; }
    const res = await fetch('/api/data/tickets/' + ticketId + '/interacoes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tk() },
      body: JSON.stringify({ comentario })
    });
    if (res && res.ok) {
      App.Toast.ok('Comentário enviado!');
      await abrirTicket(ticketId);
      load();
    } else App.Toast.err('Erro ao enviar comentário.');
  }

  async function mudarStatus(ticketId, status) {
    const res = await fetch('/api/data/tickets/' + ticketId + '/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tk() },
      body: JSON.stringify({ status })
    });
    if (res && res.ok) {
      App.Modal.close();
      App.Toast.ok(status === 'encerrada' ? 'Ticket encerrado!' : 'Ticket reaberto!');
      load();
    } else App.Toast.err('Erro ao atualizar status.');
  }

  let _ticketPend = null;

  async function perguntarAbrirTicket(solicitacao, regime, empresa, cnpj, dados, gestaoId) {
    empresa = (empresa || '').trim();
    cnpj = (cnpj || '').trim();
    if (!empresa || !cnpj) {
      App.Toast.err('Preencha Empresa e CNPJ antes de abrir o ticket.');
      return;
    }
    // Guarda os dados do ticket em memória (evita perder empresa/cnpj no onclick)
    _ticketPend = { solicitacao, regime, empresa, cnpj, dados: dados || {}, gestao_id: gestaoId || null };
    // Verifica se há checklist para esse tipo+regime
    const itens = (CHECKLIST_MAP[solicitacao] || {})[regime] || [];
    const itensHtml = itens.length
      ? '<div style="margin:8px 0;display:flex;flex-wrap:wrap;gap:6px">' + itens.map(i => '<span style="background:var(--g100);color:var(--g700);padding:2px 10px;border-radius:6px;font-size:12px;font-weight:600">' + i + '</span>').join('') + '</div>'
      : '<div style="color:var(--gray-400);font-size:12px">Nenhum checklist padrão para este regime.</div>';

    // Carrega usuários para mencionar
    const resU = await fetch('/api/data/tickets-usuarios', { headers: { Authorization: 'Bearer ' + _tk() } });
    const usuarios = resU && resU.ok ? (await resU.json()).data || [] : [];
    const usersHtml = usuarios.map(u =>
      '<label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer">' +
        '<input type="checkbox" value="' + u.id + '" class="tk-mencao-check" style="width:14px;height:14px"> ' +
        '<span style="font-size:13px">' + u.name + ' <span style="color:var(--gray-400);font-size:11px">(' + u.role + ')</span></span>' +
      '</label>'
    ).join('');

    App.Modal.open('📋 Abrir Ticket Contábil',
      '<div style="display:grid;gap:14px">' +
        '<div style="background:#f8fafc;border-radius:8px;padding:10px 14px">' +
          '<div style="font-weight:700;color:var(--g800)">' + empresa + '</div>' +
          '<div style="font-size:12px;color:var(--gray-500)">' + cnpj + ' · ' + (regime||'Regime não informado') + ' · ' + solicitacao + '</div>' +
        '</div>' +
        '<div>' +
          '<div style="font-size:13px;font-weight:700;margin-bottom:4px">Checklist automático:</div>' +
          itensHtml +
        '</div>' +
        '<div class="field"><label>Observações (opcional)</label><textarea id="tk-obs-nova" style="width:100%;min-height:60px;padding:8px 12px;border:1px solid var(--gray-200);border-radius:8px;font-size:13px;resize:vertical" placeholder="Informe o que é necessário..."></textarea></div>' +
        '<div>' +
          '<div style="font-size:13px;font-weight:700;margin-bottom:4px">Mencionar analistas contábeis:</div>' +
          '<div style="font-size:11px;color:var(--gray-400);margin-bottom:6px">⚡ Administradores são notificados automaticamente.</div>' +
          '<div style="max-height:160px;overflow-y:auto;border:1px solid var(--gray-200);border-radius:8px;padding:8px 12px">' + (usersHtml || '<span style="color:var(--gray-400);font-size:13px">Cadastre usuários com perfil Contábil para mencionar.</span>') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
          '<button class="btn btn-ghost" onclick="App.Modal.close()">Cancelar</button>' +
          '<button class="btn btn-primary" onclick="Tickets.criarTicket()">Abrir Ticket</button>' +
        '</div>' +
      '</div>',
      null, { noFooter: true }
    );
  }

  async function criarTicket() {
    if (!_ticketPend || !_ticketPend.empresa || !_ticketPend.cnpj) {
      App.Toast.err('Dados do ticket incompletos. Feche e tente novamente.');
      return;
    }
    const { solicitacao, regime, empresa, cnpj, dados, gestao_id } = _ticketPend;
    const obs = document.getElementById('tk-obs-nova')?.value?.trim() || null;
    const mencoes = [...document.querySelectorAll('.tk-mencao-check:checked')].map(c => c.value);
    const res = await fetch('/api/data/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tk() },
      body: JSON.stringify({ empresa, cnpj, regime, tipo_movimentacao: solicitacao, observacoes: obs, mencoes, dados_gestao: dados || {}, gestao_id: gestao_id || null })
    });
    if (res && res.ok) {
      App.Modal.close();
      App.Toast.ok('Ticket aberto para o Contábil!');
      if (document.getElementById('page-tickets') && !document.getElementById('page-tickets').hidden) load();
    } else App.Toast.err('Erro ao abrir ticket.');
  }

  async function excluir(id) {
    App.Modal.open('Excluir ticket',
      '<p style="color:var(--gray-600)">Excluir este ticket permanentemente? Esta ação não pode ser desfeita.</p>',
      async () => {
        const res = await fetch('/api/data/tickets/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + _tk() } });
        if (res && res.ok) { App.Modal.close(); App.Toast.ok('Ticket excluído.'); load(); }
        else App.Toast.err('Erro ao excluir ticket.');
      });
  }

  async function limparTickets() {
    App.Modal.open('Limpar todos os tickets',
      '<p style="color:var(--gray-600)">Isso vai excluir <strong>todos</strong> os tickets (e suas menções e interações), inclusive no Portal Contábil. Esta ação não pode ser desfeita.</p>',
      async () => {
        const res = await fetch('/api/data/tickets/clear', { method: 'DELETE', headers: { Authorization: 'Bearer ' + _tk() } });
        if (res && res.ok) { App.Modal.close(); App.Toast.ok('Todos os tickets foram removidos.'); load(); }
        else App.Toast.err('Erro ao limpar tickets.');
      });
  }

  return { load, filtrar, abrirTicket, marcarItem, enviarComentario, mudarStatus, perguntarAbrirTicket, criarTicket, excluir, limparTickets };
})();

window.Tickets = Tickets;

/**
 * Módulo Sucesso do Cliente — Frontend da aba "Agora"
 * ------------------------------------------------------------------
 * Convenção real confirmada no app.js (não a que eu tinha suposto antes):
 * cada módulo é um IIFE atribuído a `window.NomeDoModulo` (ex.: window.Tickets,
 * window.Carteira, window.Sensiveis) — NÃO window.App.<Modulo>. O objeto
 * `App` (App.Toast, App.Modal, App.Util, App.Auth) é só o núcleo compartilhado.
 *
 * IMPORTANTE: o prefixo "cs-" já é usado pelo módulo "Clientes Sensíveis"
 * (cs-pagination, cs-grid, cs-tbody...). Pra não colidir nem confundir,
 * este arquivo usa o prefixo "radar-" nos ids/classes (o nome que a própria
 * Continuidade já usa pra essa tela: "o radar de tickets fora do SLA").
 *
 * Nome do módulo: window.SucessoCliente (chave de página: "sucesso-cliente").
 *
 * INTEGRAÇÃO (já ajustada para os arquivos reais que a Thais subiu):
 *
 * 1. public/index.html — nav item (perto do de Tickets, dentro da <nav class="sidebar-nav">):
 *      <a class="nav-item admin-only" data-page="sucesso-cliente" href="#">
 *        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
 *          <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
 *        </svg>Sucesso do Cliente
 *      </a>
 *
 * 2. public/index.html — seção da página (perto de <section id="page-tickets">):
 *      <section id="page-sucesso-cliente" class="page admin-only" hidden>
 *        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
 *          <div id="radar-resumo" style="color:var(--gray-500);font-size:13px"></div>
 *          <div style="display:flex;gap:8px">
 *            <button class="btn btn-ghost btn-sm" onclick="SucessoCliente.toggleDashboard()">📊 Dashboard</button>
 *            <button class="btn btn-ghost btn-sm" onclick="SucessoCliente.testarConexao()">🔧 Testar conexão com Zappy</button>
 *            <button class="btn btn-sm" onclick="SucessoCliente.ingerirAgora()">🔄 Atualizar agora</button>
 *            <button class="btn btn-ghost btn-sm" onclick="SucessoCliente.iniciarBackfill()">📥 Carregar últimos 90 dias</button>
 *          </div>
 *        </div>
 *
 *        <div id="cs-dashboard" hidden style="margin-bottom:24px">
 *          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
 *            <select id="cs-dash-ano" class="radar-select" onchange="SucessoCliente.carregarDashboard()"><option value="">Todos os anos</option></select>
 *            <select id="cs-dash-mes" class="radar-select" onchange="SucessoCliente.carregarDashboard()">
 *              <option value="">Todos os meses</option>
 *              <option value="1">Janeiro</option><option value="2">Fevereiro</option><option value="3">Março</option>
 *              <option value="4">Abril</option><option value="5">Maio</option><option value="6">Junho</option>
 *              <option value="7">Julho</option><option value="8">Agosto</option><option value="9">Setembro</option>
 *              <option value="10">Outubro</option><option value="11">Novembro</option><option value="12">Dezembro</option>
 *            </select>
 *          </div>
 *          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
 *            <div class="nps-card"><div class="nps-label">Total de tickets</div><div class="nps-value" id="cs-kpi-total" style="color:#1a4233">—</div></div>
 *            <div class="nps-card"><div class="nps-label">Fora do SLA agora</div><div class="nps-value" id="cs-kpi-risco" style="color:#e53e3e">—</div></div>
 *            <div class="nps-card"><div class="nps-label">% dentro do SLA</div><div class="nps-value" id="cs-kpi-pct" style="color:#38a169">—</div></div>
 *          </div>
 *          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
 *            <div style="height:260px"><canvas id="cs-chart-status"></canvas></div>
 *            <div style="height:260px"><canvas id="cs-chart-departamento"></canvas></div>
 *            <div style="height:260px;grid-column:1 / -1"><canvas id="cs-chart-analista"></canvas></div>
 *          </div>
 *          <h4 style="margin:20px 0 4px">% dentro do SLA por analista (pior primeiro)</h4>
 *          <p style="color:var(--gray-500);font-size:12px;margin-bottom:8px">Clique numa barra pra ver os tickets vermelhos desse analista no Histórico, abaixo.</p>
 *          <div style="height:300px"><canvas id="cs-chart-desempenho"></canvas></div>
 *        </div>
 *
 *        <div id="radar-diagnostico"></div>
 *        <div id="radar-container"></div>
 *
 *        <hr style="margin:32px 0;border:none;border-top:1px solid var(--gray-200)">
 *
 *        <h3 style="margin-bottom:12px">Histórico de Atendimentos</h3>
 *        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
 *          <select id="hist-departamento" class="radar-select" onchange="SucessoCliente.filtrarHistorico()"><option value="">Todos os departamentos</option></select>
 *          <select id="hist-analista" class="radar-select" onchange="SucessoCliente.filtrarHistorico()"><option value="">Todos os analistas</option></select>
 *          <select id="hist-status" class="radar-select" onchange="SucessoCliente.filtrarHistorico()">
 *            <option value="">Todos os status</option>
 *            <option value="vermelho">🔴 Vermelho</option>
 *            <option value="amarelo">🟡 Amarelo</option>
 *            <option value="verde">🟢 Verde</option>
 *          </select>
 *          <button class="btn btn-ghost btn-sm" onclick="SucessoCliente.exportHistoricoCSV()">⬇ Exportar CSV</button>
 *          <button class="btn btn-ghost btn-sm" onclick="SucessoCliente.exportHistoricoPDF()">🖶 Exportar PDF</button>
 *        </div>
 *        <div id="hist-container"></div>
 *
 *        <hr style="margin:32px 0;border:none;border-top:1px solid var(--gray-200)">
 *
 *        <h3 style="margin-bottom:12px">Vínculos Pendentes de Confirmação</h3>
 *        <p style="color:var(--gray-500);font-size:13px;margin-bottom:12px">
 *          Números de telefone que apareceram em tickets e ainda não foram confirmados
 *          como cliente, fornecedor, interno ou software.
 *        </p>
 *        <div id="vinc-container"></div>
 *      </section>
 *
 * 3. public/index.html — no fim do <body>, perto dos outros <script src="js/...">:
 *      <link rel="stylesheet" href="css/cs.css">
 *      <script src="js/cs.js"></script>
 *
 * 4. public/js/app.js — PAGE_TITLES (perto do topo, junto dos outros):
 *      'sucesso-cliente':'Sucesso do Cliente',
 *
 * 5. public/js/app.js — dentro de Nav.go(page), junto das outras linhas "if (page === ...)":
 *      if (page === 'sucesso-cliente') window.SucessoCliente?.load();
 */
(function () {
  'use strict';

  // Cores próprias (não reaproveita o CHART_COLORS/_charts do Dashboard geral
  // de propósito — módulo isolado, não deve depender de estado interno de
  // outro módulo). Paleta consistente com o resto do Grupo-E.
  const CS_CHART_COLORS = ['#1a4233', '#e53e3e', '#f5c518', '#3182ce', '#38a169', '#9b2c2c', '#2c7a7b', '#d69e2e'];
  const _csCharts = {};

  const SucessoCliente = {
    _timer: null,
    _intervaloMs: 60000, // 1 min — ~600 tickets/mês é volume baixo, não precisa ser mais agressivo

    /** Chamado pelo Nav.go('sucesso-cliente') ao abrir a aba. */
    async load() {
      await this.carregar();
      await this.carregarFiltros();
      await this.filtrarHistorico();
      await this.carregarVinculosPendentes();
      if (this._timer) clearInterval(this._timer);
      this._timer = setInterval(() => this.carregar(), this._intervaloMs);
    },

    /** Opcional: parar o auto-refresh se algum dia o app tiver hook de "saiu da aba". */
    destruir() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
    },

    async carregar() {
      const container = document.getElementById('radar-container');
      const resumo = document.getElementById('radar-resumo');
      if (!container) return;
      try {
        const resp = await fetch('/api/cs/agora', { headers: SucessoCliente._authHeaders() });
        const texto = await resp.text();
        let data;
        try { data = texto ? JSON.parse(texto) : {}; } catch (e) { data = null; }
        if (!resp.ok || !data) {
          const detalhe = data && data.error ? data.error : (texto || '').slice(0, 200);
          throw new Error('HTTP ' + resp.status + (detalhe ? ' — ' + detalhe : ''));
        }
        const { tickets } = data;
        SucessoCliente._render(container, tickets || []);
        if (resumo) {
          resumo.textContent = (tickets || []).length
            ? `${tickets.length} ticket${tickets.length !== 1 ? 's' : ''} fora do SLA agora`
            : 'Tudo dentro do SLA';
        }
      } catch (e) {
        container.innerHTML =
          '<p class="radar-erro">Não foi possível carregar o radar agora.</p>' +
          '<p style="font-family:monospace;font-size:12px;color:var(--gray-500)">' + SucessoCliente._esc(e.message) + '</p>';
        console.error('[SucessoCliente] carregar()', e);
      }
    },

    async ingerirAgora() {
      try {
        const resp = await fetch('/api/cs/ingerir', { method: 'POST', headers: SucessoCliente._authHeaders() });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
        const extra = data.ignoradosPreDataInicio ? ` (${data.ignoradosPreDataInicio} ignorados por serem anteriores à data de início da coleta)` : '';
        if (window.App && App.Toast) App.Toast.ok(`Ingestão concluída: ${data.processados} tickets atualizados${extra}.`);
        await SucessoCliente.carregar();
      } catch (e) {
        if (window.App && App.Toast) App.Toast.err('Falha ao atualizar tickets.');
        console.error('[SucessoCliente] ingerirAgora()', e);
      }
    },

    /**
     * Botão "Carregar últimos 90 dias" — carga retroativa ÚNICA (não é o que
     * roda automaticamente a cada 5 min). Pede confirmação porque pode levar
     * alguns minutos; a chamada volta na hora (roda em segundo plano no
     * servidor) e os tickets vão aparecendo no Histórico conforme processados.
     */
    async iniciarBackfill() {
      const ok = window.confirm(
        'Isso vai buscar os tickets dos últimos 90 dias (carga única, não afeta a coleta automática).\n\n' +
        'Pode levar alguns minutos rodando em segundo plano. Continuar?'
      );
      if (!ok) return;
      try {
        const resp = await fetch('/api/cs/backfill?dias=90', { method: 'POST', headers: SucessoCliente._authHeaders() });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
        if (window.App && App.Toast) App.Toast.ok(data.mensagem || 'Carga retroativa iniciada.');
      } catch (e) {
        if (window.App && App.Toast) App.Toast.err('Falha ao iniciar carga retroativa: ' + e.message);
        console.error('[SucessoCliente] iniciarBackfill()', e);
      }
    },

    /**
     * Botão "Recalcular SLA" — reprocessa os relógios de TODOS os tickets já
     * salvos com a fórmula ATUAL do motor (server/cs/slaEngine.js), sem
     * chamar o Zappy de novo. Necessário porque o Dashboard só LÊ o que já
     * está calculado e guardado no banco — corrigir o código não atualiza
     * sozinho os tickets antigos (foi o caso dos tickets #46296/#46251/
     * #45963 continuarem vermelhos mesmo depois do ajuste no slaEngine).
     * Roda em segundo plano — com milhares de tickets pode levar alguns
     * minutos.
     */
    async recalcularSLA() {
      const ok = window.confirm(
        'Isso vai reprocessar o SLA de TODOS os tickets já salvos, usando a fórmula mais recente ' +
        '(sem buscar nada novo no Zappy). Útil depois de qualquer ajuste no motor de SLA.\n\n' +
        'Pode levar alguns minutos rodando em segundo plano. Continuar?'
      );
      if (!ok) return;
      try {
        const resp = await fetch('/api/cs/recalcular-sla', { method: 'POST', headers: SucessoCliente._authHeaders() });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
        if (window.App && App.Toast) App.Toast.ok(data.mensagem || 'Recálculo de SLA iniciado.');
      } catch (e) {
        if (window.App && App.Toast) App.Toast.err('Falha ao iniciar recálculo de SLA: ' + e.message);
        console.error('[SucessoCliente] recalcularSLA()', e);
      }
    },

    /**
     * Gráfico "% dentro do SLA por analista" — ordenado do pior pro melhor
     * (o backend já manda nessa ordem), cor por faixa (vermelho <50%,
     * amarelo 50–79%, verde ≥80%) em vez de uma cor por analista. Clicar
     * numa barra filtra o Histórico por esse analista + status vermelho,
     * pra já mostrar os tickets que justificam o número.
     */
    _renderChartDesempenho(linhas) {
      const id = 'cs-chart-desempenho';
      if (typeof Chart === 'undefined') return;
      if (_csCharts[id]) { _csCharts[id].destroy(); delete _csCharts[id]; }
      const ctx = document.getElementById(id);
      if (!ctx) return;
      if (!linhas.length) {
        ctx.parentElement.innerHTML = '<p style="text-align:center;color:var(--gray-400);font-size:12px;padding:40px 0">Sem dados suficientes ainda (precisa de pelo menos 3 tickets por analista)</p>';
        return;
      }
      const labels = linhas.map(r => r.label || 'Não informado');
      const dataVals = linhas.map(r => r.pct ?? 0);
      const cores = dataVals.map(p => (p < 50 ? '#e53e3e' : p < 80 ? '#f5c518' : '#38a169'));
      _csCharts[id] = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: '% dentro do SLA', data: dataVals, backgroundColor: cores, borderRadius: 4 }] },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { min: 0, max: 100, ticks: { font: { size: 10 }, callback: v => v + '%' }, grid: { color: 'rgba(0,0,0,.05)' } },
            y: { ticks: { font: { size: 10 } }, grid: { display: false } },
          },
          onClick: (evt, elementos) => {
            if (!elementos.length) return;
            const analista = labels[elementos[0].index];
            SucessoCliente.filtrarPorAnalista(analista);
          },
        },
      });
    },

    /** Ao clicar numa barra do gráfico de desempenho: filtra o Histórico por esse analista + vermelho. */
    filtrarPorAnalista(nomeAnalista) {
      const selAna = document.getElementById('hist-analista');
      const selStatus = document.getElementById('hist-status');
      if (selAna) selAna.value = nomeAnalista;
      if (selStatus) selStatus.value = 'vermelho';
      SucessoCliente.filtrarHistorico();
      const container = document.getElementById('hist-container');
      if (container) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    /**
     * Ao clicar numa barra do gráfico "% dentro do SLA por etapa": filtra o
     * Histórico pelos tickets vermelhos NAQUELA etapa específica (não pelo
     * status geral do ticket) — são exatamente os tickets que justificam
     * o número baixo mostrado na barra.
     */
    filtrarPorEtapa(etapaChave) {
      const selEtapa = document.getElementById('hist-etapa');
      const selStatus = document.getElementById('hist-status');
      const selAna = document.getElementById('hist-analista');
      const selDepto = document.getElementById('hist-departamento');
      if (selEtapa) selEtapa.value = etapaChave;
      if (selStatus) selStatus.value = 'vermelho';
      if (selAna) selAna.value = '';
      if (selDepto) selDepto.value = '';
      SucessoCliente.filtrarHistorico();
      const container = document.getElementById('hist-container');
      if (container) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    /**
     * Ao clicar numa barra dos rankings "por analista" que são ESPECÍFICOS
     * de uma etapa (departamento = 1ª resposta pós-transferência; ou
     * resposta_continua = toda resposta pós-transferência): filtra o
     * Histórico por esse analista + essa etapa + vermelho, ao mesmo tempo.
     * Sem isso, o clique caía no filtro genérico (status geral do ticket),
     * que podia estar verde mesmo quando aquela etapa específica foi
     * vermelha — mostrando "nenhum ticket encontrado" de forma enganosa.
     */
    filtrarPorAnalistaEtapa(nomeAnalista, etapaChave) {
      const selAna = document.getElementById('hist-analista');
      const selEtapa = document.getElementById('hist-etapa');
      const selStatus = document.getElementById('hist-status');
      const selDepto = document.getElementById('hist-departamento');
      if (selAna) selAna.value = nomeAnalista;
      if (selEtapa) selEtapa.value = etapaChave;
      if (selStatus) selStatus.value = 'vermelho';
      if (selDepto) selDepto.value = '';
      SucessoCliente.filtrarHistorico();
      const container = document.getElementById('hist-container');
      if (container) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    /**
     * Doughnut "Status do SLA" — cor FIXA por significado (verde/amarelo/
     * vermelho), nunca por posição na lista. O `_renderChart` genérico
     * (usado nos outros gráficos) pinta pela ordem em que o banco devolveu
     * as linhas — como GROUP BY não garante ordem, o vermelho podia
     * "ganhar" a cor amarela por acaso. Aqui não: a cor vem de um mapa fixo.
     */
    _renderChartStatus(id, linhas) {
      if (typeof Chart === 'undefined') return;
      if (_csCharts[id]) { _csCharts[id].destroy(); delete _csCharts[id]; }
      const ctx = document.getElementById(id);
      if (!ctx) return;
      if (!linhas || !linhas.length) {
        ctx.parentElement.innerHTML = '<p style="text-align:center;color:var(--gray-400);font-size:12px;padding:40px 0">Sem dados ainda</p>';
        return;
      }
      const CORES = { verde: '#38a169', amarelo: '#f5c518', vermelho: '#e53e3e' };
      const LABELS = { verde: '🟢 Verde', amarelo: '🟡 Amarelo', vermelho: '🔴 Vermelho' };
      const ordem = ['verde', 'amarelo', 'vermelho']; // ordem fixa de exibição, também não depende do banco
      const porChave = Object.fromEntries(linhas.map(r => [r.label, r.n]));
      const presentes = ordem.filter(k => porChave[k] != null);
      const labels = presentes.map(k => LABELS[k]);
      const dataVals = presentes.map(k => porChave[k]);
      const bg = presentes.map(k => CORES[k]);
      _csCharts[id] = new Chart(ctx, {
        type: 'doughnut',
        data: { labels, datasets: [{ label: 'Status SLA', data: dataVals, backgroundColor: bg, borderColor: '#fff', borderWidth: 2 }] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 }, padding: 12 } } },
        },
      });
    },

    /** Mesmo padrão de renderChart usado no Dashboard principal do app.js, só que isolado aqui dentro. */
    _renderChart(id, type, rows, labelKey, extra = {}) {
      if (typeof Chart === 'undefined') return; // biblioteca ainda não carregou — evita erro
      if (_csCharts[id]) { _csCharts[id].destroy(); delete _csCharts[id]; }
      const ctx = document.getElementById(id);
      if (!ctx) return;
      if (!rows || !rows.length) {
        ctx.parentElement.innerHTML = '<p style="text-align:center;color:var(--gray-400);font-size:12px;padding:40px 0">Sem dados ainda</p>';
        return;
      }
      const isHBar = extra.indexAxis === 'y';
      const labels = rows.map(r => r.label || 'Não informado');
      const dataVals = rows.map(r => Number(r.n));
      const isBar = type === 'bar';
      const bg = labels.map((_, i) => CS_CHART_COLORS[i % CS_CHART_COLORS.length]);
      _csCharts[id] = new Chart(ctx, {
        type,
        data: { labels, datasets: [{ label: labelKey, data: dataVals, backgroundColor: bg, borderColor: '#fff', borderWidth: isBar ? 0 : 2, borderRadius: isBar ? 4 : 0 }] },
        options: {
          indexAxis: extra.indexAxis || 'x',
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: !isBar, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 }, padding: 12 } } },
          scales: isBar ? {
            x: isHBar ? { beginAtZero: true, ticks: { stepSize: 1, font: { size: 10 } }, grid: { color: 'rgba(0,0,0,.05)' } } : { ticks: { font: { size: 10 }, maxRotation: 35 }, grid: { display: false } },
            y: isHBar ? { ticks: { font: { size: 10 } }, grid: { display: false } } : { beginAtZero: true, ticks: { stepSize: 1, font: { size: 10 } }, grid: { color: 'rgba(0,0,0,.05)' } },
          } : {},
        },
      });
    },

    /**
     * Botão "Testar conexão com Zappy" — usa SÓ o endpoint que já sabemos
     * que existe (GET /tickets/:id), sem depender do palpite do endpoint
     * de listagem em lote. Pede um número de ticket real e mostra o
     * resultado (ou o erro, já explicado) direto na tela — sem precisar
     * abrir o Console do navegador.
     */
    async testarConexao() {
      const div = document.getElementById('radar-diagnostico');
      if (!div) return;
      const ticketId = window.prompt('Número de um ticket REAL do Zappy pra testar (ex.: 46072):', '46072');
      if (!ticketId) return;
      div.innerHTML = '<p style="color:var(--gray-500)">Testando...</p>';
      try {
        const resp = await fetch('/api/cs/diagnostico?ticketId=' + encodeURIComponent(ticketId), {
          headers: SucessoCliente._authHeaders(),
        });
        const data = await resp.json();
        if (data.ok) {
          div.innerHTML =
            '<div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:12px;margin-bottom:16px">' +
            '<strong>✅ Conexão funcionando!</strong><br>' +
            'Ticket #' + SucessoCliente._esc(data.ticket.id) + ' — status: ' + SucessoCliente._esc(data.ticket.status) +
            (data.ticket.contact ? ' — contato: ' + SucessoCliente._esc(data.ticket.contact.name || '') : '') +
            '</div>';
        } else {
          div.innerHTML =
            '<div style="background:#fdecec;border:1px solid #f5b5b5;border-radius:8px;padding:12px;margin-bottom:16px">' +
            '<strong>❌ Erro na conexão</strong><br>' +
            '<span style="font-family:monospace;font-size:12px">' + SucessoCliente._esc(data.error) + '</span>' +
            '</div>';
        }
      } catch (e) {
        div.innerHTML = '<div style="background:#fdecec;border-radius:8px;padding:12px">❌ Falha ao testar: ' + SucessoCliente._esc(e.message) + '</div>';
      }
    },

    /**
     * Popula os <select> de departamento/analista da tela de Histórico com
     * os valores já vistos nos tickets gravados (GET /api/cs/filtros).
     * Chamado uma vez ao abrir a aba (load()).
     */
    async carregarFiltros() {
      const selDep = document.getElementById('hist-departamento');
      const selAna = document.getElementById('hist-analista');
      if (!selDep || !selAna) return; // seção de histórico ainda não colada no HTML
      try {
        const resp = await fetch('/api/cs/filtros', { headers: SucessoCliente._authHeaders() });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const { departamentos, analistas } = await resp.json();
        const preencher = (select, valores) => {
          const atual = select.value;
          select.querySelectorAll('option[data-dinamico]').forEach(o => o.remove());
          (valores || []).forEach(v => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            opt.setAttribute('data-dinamico', '1');
            select.appendChild(opt);
          });
          select.value = atual;
        };
        preencher(selDep, departamentos);
        preencher(selAna, analistas);
      } catch (e) {
        console.error('[SucessoCliente] carregarFiltros()', e);
      }
    },

    /**
     * Busca o histórico de tickets (GET /api/cs/historico) já aplicando os
     * filtros selecionados nos <select> da tela, e renderiza a tabela.
     * Chamado pelo botão "Filtrar" e uma vez ao abrir a aba.
     */
    /**
     * Texto simples explicando o que cada etapa do SLA mede — mostrado
     * acima da lista do Histórico sempre que um filtro de etapa está ativo
     * (seja por clique num gráfico ou escolhendo no seletor "Etapa"), pra
     * não precisar perguntar de novo o que cada relógio significa.
     */
    _EXPLICACAO_ETAPA: {
      aceite: 'Tempo entre a 1ª mensagem do cliente e alguém da equipe aceitar o atendimento. Prazo: 15 min úteis.',
      transferencia: 'Tempo entre o aceite do ticket e a transferência efetiva para o departamento certo. Prazo: 15 min úteis.',
      departamento: 'Tempo excedido (30 min úteis) para o analista dar a 1ª resposta depois que o ticket chegou transferido para ele. Não conta o que acontece depois disso na conversa (ex.: se o analista já respondeu e está esperando o cliente, isso é outro relógio — "vez do cliente").',
      promessa: 'Alguém avisou que VAI transferir (ex.: "vou te direcionar...") mas ainda não transferiu de fato. Mede quanto tempo demora até a transferência acontecer. Prazo: 15 min úteis.',
      promessa_resolucao: 'Alguém avisou que vai RESOLVER direto, sem transferir. Prazo pro silêncio: 2h. Mas se o analista já respondeu e está esperando o cliente se posicionar (ex.: aguardando comprovante, confirmação), esse tempo de espera NÃO conta contra o prazo — só conta se o analista demorar mais de 30 min pra responder algo específico que o cliente perguntou.',
      resposta_continua: 'Tempo de resposta em CADA mensagem do cliente depois da transferência (não só a primeira) — mostra se o ritmo de atendimento se mantém do início ao fim da conversa. Prazo: 30 min úteis por troca.',
    },

    _mostrarExplicacaoEtapa(etapaChave) {
      const el = document.getElementById('hist-explicacao-etapa');
      if (!el) return;
      const texto = SucessoCliente._EXPLICACAO_ETAPA[etapaChave];
      if (!texto) { el.innerHTML = ''; return; }
      el.innerHTML =
        '<div style="background:#f0f9f4;border:1px solid #c6f6d5;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:var(--gray-700,#374151)">' +
        '<strong>Sobre este filtro:</strong> ' + SucessoCliente._esc(texto) +
        '</div>';
    },

    async filtrarHistorico() {
      const container = document.getElementById('hist-container');
      if (!container) return; // seção de histórico ainda não colada no HTML
      const departamento = (document.getElementById('hist-departamento') || {}).value || '';
      const analista = (document.getElementById('hist-analista') || {}).value || '';
      const status = (document.getElementById('hist-status') || {}).value || '';
      const etapa = (document.getElementById('hist-etapa') || {}).value || '';
      SucessoCliente._mostrarExplicacaoEtapa(etapa);
      container.innerHTML = '<p style="color:var(--gray-500)">Carregando...</p>';
      try {
        const qs = new URLSearchParams();
        if (departamento) qs.set('departamento', departamento);
        if (analista) qs.set('analista', analista);
        if (status) qs.set('status', status);
        if (etapa) qs.set('etapa', etapa);
        const resp = await fetch('/api/cs/historico?' + qs.toString(), { headers: SucessoCliente._authHeaders() });
        const texto = await resp.text();
        let data;
        try { data = texto ? JSON.parse(texto) : {}; } catch (e) { data = null; }
        if (!resp.ok || !data) {
          const detalhe = data && data.error ? data.error : (texto || '').slice(0, 200);
          throw new Error('HTTP ' + resp.status + (detalhe ? ' — ' + detalhe : ''));
        }
        SucessoCliente._ultimoHistorico = data.tickets || []; // guardado p/ exportCSV/exportPDF sem refazer a chamada
        SucessoCliente._renderHistorico(container, SucessoCliente._ultimoHistorico);
      } catch (e) {
        SucessoCliente._ultimoHistorico = [];
        container.innerHTML =
          '<p class="radar-erro">Não foi possível carregar o histórico.</p>' +
          '<p style="font-family:monospace;font-size:12px;color:var(--gray-500)">' + SucessoCliente._esc(e.message) + '</p>';
        console.error('[SucessoCliente] filtrarHistorico()', e);
      }
    },

    // Colunas/labels compartilhadas pelos dois exports (mesmo padrão usado em
    // app.js — ver Atendimento.exportCSV/exportPDF: separador ";", BOM no CSV,
    // popup + window.print() no PDF).
    _colunasHistorico: ['zappy_id', 'abertura', 'encerramento', 'empresa', 'departamento', 'analista', 'pior_status'],
    _labelsHistorico: {
      zappy_id: 'Ticket', abertura: 'Abertura', encerramento: 'Encerramento', empresa: 'Empresa',
      departamento: 'Departamento', analista: 'Analista', pior_status: 'Status SLA',
    },
    _valorHistorico(r, c) {
      if (c === 'empresa') return r.empresa_nome || r.empresa_texto || '—';
      if (c === 'abertura' || c === 'encerramento') return r[c] ? new Date(r[c]).toLocaleString('pt-BR') : '—';
      if (c === 'pior_status') {
        // Com filtro de etapa ativo, exporta o status DAQUELA etapa (mesma
        // lógica da bolinha na tela) em vez do status geral do ticket.
        const s = r.etapa_status || r.pior_status;
        return s === 'vermelho' ? 'Vermelho' : s === 'amarelo' ? 'Amarelo' : s === 'verde' ? 'Verde' : '—';
      }
      return r[c] ?? '—';
    },

    /** Botão "Exportar CSV" — usa os dados já carregados na tela (filtro atual aplicado). */
    exportHistoricoCSV() {
      const data = SucessoCliente._ultimoHistorico || [];
      if (!data.length) { if (window.App && App.Toast) App.Toast.err('Nenhum dado para exportar.'); return; }
      const cols = SucessoCliente._colunasHistorico;
      const labels = SucessoCliente._labelsHistorico;
      const header = cols.map(c => labels[c]).join(';');
      const rows = data.map(r => cols.map(c => `"${String(SucessoCliente._valorHistorico(r, c)).replace(/"/g, '""')}"`).join(';'));
      const csv = [header, ...rows].join('\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sucesso_cliente_historico_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      if (window.App && App.Toast) App.Toast.ok('CSV exportado!');
    },

    /** Botão "Exportar PDF" — mesmo padrão dos outros módulos: popup + Ctrl+P / Salvar como PDF. */
    exportHistoricoPDF() {
      const data = SucessoCliente._ultimoHistorico || [];
      if (!data.length) { if (window.App && App.Toast) App.Toast.err('Nenhum dado para exportar.'); return; }
      const cols = SucessoCliente._colunasHistorico;
      const labels = SucessoCliente._labelsHistorico;
      const rows = data.map(r =>
        '<tr>' + cols.map(c => '<td>' + SucessoCliente._esc(String(SucessoCliente._valorHistorico(r, c))) + '</td>').join('') + '</tr>'
      ).join('');
      const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Histórico — Sucesso do Cliente</title>
      <style>body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#222}
      h1{font-size:15px;color:#1a4233;margin-bottom:4px}p.sub{color:#666;font-size:11px;margin-bottom:12px}
      table{width:100%;border-collapse:collapse;font-size:10px}
      th{background:#1a4233;color:#fff;padding:6px 8px;text-align:left}
      td{padding:5px 8px;border-bottom:1px solid #eee}tr:nth-child(even) td{background:#f8f8f8}
      @media print{body{margin:10px}}</style></head><body>
      <h1>Grupo-E — Histórico de Atendimentos (Sucesso do Cliente)</h1>
      <p class="sub">Gerado em: ${new Date().toLocaleString('pt-BR')} | Total: ${data.length} registros</p>
      <table><thead><tr>${cols.map(c => '<th>' + labels[c] + '</th>').join('')}</tr></thead>
      <tbody>${rows}</tbody></table>
      <script>window.onload=()=>{window.print();}<\/script></body></html>`;
      const win = window.open('', '_blank');
      if (!win) { if (window.App && App.Toast) App.Toast.err('Permita popups para exportar PDF.'); return; }
      win.document.write(html);
      win.document.close();
      if (window.App && App.Toast) App.Toast.ok('PDF gerado — use Ctrl+P para salvar!');
    },

    _renderHistorico(container, tickets) {
      if (!tickets.length) {
        container.innerHTML = '<p style="color:var(--gray-500)">Nenhum ticket encontrado com esses filtros.</p>';
        return;
      }
      const linhas = tickets.map(SucessoCliente._linhaHistorico).join('');
      container.innerHTML =
        '<table class="radar-tabela">' +
        '<thead><tr><th></th><th>Ticket</th><th>Empresa</th><th>Departamento</th><th>Analista</th><th>Abertura</th><th>Encerramento</th></tr></thead>' +
        '<tbody>' + linhas + '</tbody>' +
        '</table>';
    },

    _linhaHistorico(t) {
      // Quando o Histórico está filtrado por uma ETAPA específica (ex.:
      // "Promessa de transferência"), a bolinha mostra o status DAQUELA
      // etapa (t.etapa_status) — não o status geral do ticket (pior_status),
      // que costuma estar verde em ticket já encerrado mesmo quando aquela
      // etapa em particular foi vermelha no seu momento.
      const statusExibido = t.etapa_status || t.pior_status;
      const cor = statusExibido === 'vermelho' ? '🔴' : (statusExibido === 'amarelo' ? '🟡' : '🟢');
      const empresa = t.empresa_nome || t.empresa_texto || '(sem vínculo)';
      const fmt = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
      return (
        '<tr class="radar-linha radar-' + (statusExibido || '') + '">' +
        '<td>' + cor + '</td>' +
        '<td>#' + SucessoCliente._esc(t.zappy_id || '—') + '</td>' +
        '<td>' + SucessoCliente._esc(empresa) + '</td>' +
        '<td>' + SucessoCliente._esc(t.departamento || '—') + '</td>' +
        '<td>' + SucessoCliente._esc(t.analista || '—') + '</td>' +
        '<td>' + fmt(t.abertura) + '</td>' +
        '<td>' + fmt(t.encerramento) + '</td>' +
        '</tr>'
      );
    },

    /**
     * Busca a fila de vínculos pendentes (GET /api/cs/vinculos/pendentes) e
     * renderiza a lista com o campo editável + botão confirmar de cada um.
     * Chamado ao abrir a aba e de novo depois de cada confirmação.
     */
    async carregarVinculosPendentes() {
      const container = document.getElementById('vinc-container');
      if (!container) return; // seção ainda não colada no HTML
      container.innerHTML = '<p style="color:var(--gray-500)">Carregando...</p>';
      try {
        const resp = await fetch('/api/cs/vinculos/pendentes', { headers: SucessoCliente._authHeaders() });
        const texto = await resp.text();
        let data;
        try { data = texto ? JSON.parse(texto) : {}; } catch (e) { data = null; }
        if (!resp.ok || !data) {
          const detalhe = data && data.error ? data.error : (texto || '').slice(0, 200);
          throw new Error('HTTP ' + resp.status + (detalhe ? ' — ' + detalhe : ''));
        }
        SucessoCliente._ultimosVinculos = data.vinculos || [];
        SucessoCliente._renderVinculos(container, SucessoCliente._ultimosVinculos);
      } catch (e) {
        container.innerHTML =
          '<p class="radar-erro">Não foi possível carregar os vínculos pendentes.</p>' +
          '<p style="font-family:monospace;font-size:12px;color:var(--gray-500)">' + SucessoCliente._esc(e.message) + '</p>';
        console.error('[SucessoCliente] carregarVinculosPendentes()', e);
      }
    },

    _renderVinculos(container, vinculos) {
      if (!vinculos.length) {
        container.innerHTML = '<p class="radar-ok">✅ Nenhum vínculo pendente — tudo confirmado.</p>';
        return;
      }
      const linhas = vinculos.map(SucessoCliente._linhaVinculo).join('');
      container.innerHTML =
        '<table class="radar-tabela">' +
        '<thead><tr><th>Telefone</th><th>Empresa (sugestão)</th><th>Tipo</th><th></th></tr></thead>' +
        '<tbody>' + linhas + '</tbody>' +
        '</table>';
    },

    _linhaVinculo(v) {
      const conf = v.confianca != null ? ` (${v.confianca}% de confiança)` : '';
      const empresaId = 'vinc-empresa-' + v.id;
      const tipoId = 'vinc-tipo-' + v.id;
      return (
        '<tr>' +
        '<td>' + SucessoCliente._esc(v.telefone) + '</td>' +
        '<td><input type="text" id="' + empresaId + '" value="' + SucessoCliente._esc(v.empresa_nome || '') + '" ' +
          'placeholder="Nome da empresa" style="width:220px;padding:6px 8px;border:1px solid #ddd;border-radius:6px;font-size:13px">' +
          '<div style="color:var(--gray-500);font-size:11px">' + SucessoCliente._esc(conf.trim()) + '</div></td>' +
        '<td><select id="' + tipoId + '" class="radar-select">' +
          '<option value="cliente"' + (v.cliente_id ? ' selected' : '') + '>Cliente</option>' +
          '<option value="fornecedor">Fornecedor</option>' +
          '<option value="interno">Interno</option>' +
          '<option value="software">Software</option>' +
          '</select></td>' +
        '<td><button class="btn btn-sm" onclick="SucessoCliente.confirmarVinculoLinha(\'' + v.id + '\')">✅ Confirmar</button></td>' +
        '</tr>'
      );
    },

    /** Botão "Confirmar" de uma linha da fila de vínculos pendentes. */
    async confirmarVinculoLinha(id) {
      const empresaInput = document.getElementById('vinc-empresa-' + id);
      const tipoSelect = document.getElementById('vinc-tipo-' + id);
      if (!empresaInput || !tipoSelect) return;
      const original = (SucessoCliente._ultimosVinculos || []).find(v => String(v.id) === String(id));
      const tipo = tipoSelect.value;
      const empresaNome = empresaInput.value.trim();
      if (tipo === 'cliente' && !empresaNome) {
        if (window.App && App.Toast) App.Toast.err('Preencha o nome da empresa antes de confirmar como cliente.');
        return;
      }
      try {
        const resp = await fetch('/api/cs/vinculos/' + encodeURIComponent(id) + '/confirmar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...SucessoCliente._authHeaders() },
          body: JSON.stringify({
            clienteId: original ? original.cliente_id : null,
            empresaNome,
            cnpj: original ? original.cnpj : null,
            tipo,
          }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
        if (window.App && App.Toast) App.Toast.ok('Vínculo confirmado!');
        await SucessoCliente.carregarVinculosPendentes();
      } catch (e) {
        if (window.App && App.Toast) App.Toast.err('Falha ao confirmar vínculo: ' + e.message);
        console.error('[SucessoCliente] confirmarVinculoLinha()', e);
      }
    },

    // Mesmo padrão usado nos outros módulos do app.js (ex.: linha "const _tk = () => localStorage.getItem('ge_token') || '';")
    _authHeaders() {
      const token = localStorage.getItem('ge_token') || '';
      return token ? { Authorization: 'Bearer ' + token } : {};
    },

    _render(container, tickets) {
      if (!tickets.length) {
        container.innerHTML = '<p class="radar-ok">✅ Nenhum ticket fora do SLA agora.</p>';
        return;
      }
      const linhas = tickets.map(SucessoCliente._linha).join('');
      container.innerHTML =
        '<table class="radar-tabela">' +
        '<thead><tr><th></th><th>Ticket</th><th>Empresa</th><th>Departamento</th><th>Analista</th><th>Relógio</th><th>Tempo</th></tr></thead>' +
        '<tbody>' + linhas + '</tbody>' +
        '</table>';
    },

    _linha(t) {
      let sla = {};
      try { sla = typeof t.sla === 'string' ? JSON.parse(t.sla) : (t.sla || {}); } catch (e) { sla = {}; }
      const radar = sla.radar || null;
      const cor = t.pior_status === 'vermelho' ? '🔴' : (t.pior_status === 'amarelo' ? '🟡' : '🟢');
      const empresa = t.empresa_nome || t.empresa_texto || '(sem vínculo)';
      const relogio = radar ? radar.rotulo : '—';
      const tempo = radar ? (radar.minutos_uteis + ' min (limite ' + (radar.limite ?? '—') + ')') : '—';
      return (
        '<tr class="radar-linha radar-' + (t.pior_status || '') + '">' +
        '<td>' + cor + '</td>' +
        '<td>#' + SucessoCliente._esc(t.zappy_id || '—') + '</td>' +
        '<td>' + SucessoCliente._esc(empresa) + '</td>' +
        '<td>' + SucessoCliente._esc(t.departamento || '—') + '</td>' +
        '<td>' + SucessoCliente._esc(t.analista || '—') + '</td>' +
        '<td>' + SucessoCliente._esc(relogio) + '</td>' +
        '<td>' + SucessoCliente._esc(tempo) + '</td>' +
        '</tr>'
      );
    },

    _esc(s) {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => map[c]);
    },
  };

  window.SucessoCliente = SucessoCliente;
})();


// ── Análise Inteligente — churn (risco de cancelamento) e sentimento ──────────
// Módulo isolado (não mexe em nenhum outro módulo): só lê /api/data/churn e
// /api/data/sentimento, que também são novos e não alteram nenhuma tabela
// existente. Sem custo, sem IA paga — tudo por regras e palavras-chave.
(function () {
  'use strict';

  function authHeaders() {
    const tk = localStorage.getItem('ge_token') || '';
    return { Authorization: 'Bearer ' + tk };
  }

  function esc(s) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => map[c]);
  }

  const AnaliseInteligente = {
    async load() {
      AnaliseInteligente.carregarChurn();
      AnaliseInteligente.carregarSentimento();
      AnaliseInteligente.carregarChurnConversas();
      AnaliseInteligente.carregarInsatisfacaoConversas();
      AnaliseInteligente.carregarAfastamento();
      AnaliseInteligente.carregarMotivosCliente();
      AnaliseInteligente.carregarTratados();
    },

    async carregarChurnConversas() {
      const tbody = document.getElementById('churn-conversas-tbody');
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--gray-400)">Carregando...</td></tr>';
      try {
        const res = await fetch('/api/cs/churn?dias=180', { headers: authHeaders() });
        if (!res.ok) throw new Error('Falha ao buscar.');
        const { data } = await res.json();
        AnaliseInteligente._churnData = data || [];
        if (!data || !data.length) {
          tbody.innerHTML = '<tr><td colspan="6" style="color:var(--gray-400)">Nenhum sinal de churn encontrado nas conversas dos últimos 180 dias.</td></tr>';
          return;
        }
        tbody.innerHTML = data.map((c, idx) => {
          const dt = new Date(c.ultima_hora).toLocaleString('pt-BR');
          const nomeVinculo = c.vinculado
            ? esc(c.empresa)
            : `${esc(c.empresa)} <span style="color:var(--gray-400);font-size:11px">(não vinculado)</span>`;
          const temMais = (c.detalhes && c.detalhes.length > 1);
          const ocorrenciasCell = temMais
            ? `<a href="#" onclick="AnaliseInteligente.toggleChurnDetalhe(${idx});return false" style="cursor:pointer;text-decoration:underline;font-weight:600" title="Ver as ${c.ocorrencias} mensagens que bateram">${c.ocorrencias} <span id="churn-seta-${idx}">▾</span></a>`
            : c.ocorrencias;
          return `<tr id="churn-row-${idx}">
            <td style="font-weight:600">${nomeVinculo}</td>
            <td style="font-size:12px;color:var(--gray-500)">${c.zappy_id ? '#' + esc(c.zappy_id) : '—'}</td>
            <td style="font-size:12px;color:var(--gray-500)">${dt}</td>
            <td>${ocorrenciasCell}</td>
            <td style="font-size:12px;color:var(--gray-600)"><em>"${esc(c.frase_detectada)}"</em> — ${esc((c.trecho||'').slice(0,140))}${(c.trecho||'').length>140?'...':''}</td>
            <td><button class="btn btn-ghost btn-sm" onclick="AnaliseInteligente.tratarChurn('${c.ticket_id}')">✔ Tratar</button></td>
          </tr>`;
        }).join('');
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" style="color:var(--danger)">Não foi possível analisar as conversas agora.</td></tr>';
      }
    },

    /**
     * Expande/recolhe uma linha extra logo abaixo da empresa clicada,
     * listando TODAS as mensagens que bateram com alguma frase de churn
     * (não só a mais recente) — pedido da Thais depois de ver "3
     * ocorrências" no ticket #46449 sem conseguir ver quais eram as 3.
     */
    toggleChurnDetalhe(idx) {
      const row = document.getElementById(`churn-row-${idx}`);
      if (!row) return;
      const existente = document.getElementById(`churn-detalhe-${idx}`);
      const seta = document.getElementById(`churn-seta-${idx}`);
      if (existente) {
        existente.remove();
        if (seta) seta.textContent = '▾';
        return;
      }
      if (seta) seta.textContent = '▴';
      const item = (AnaliseInteligente._churnData || [])[idx];
      const detalhes = (item && item.detalhes) || [];
      const linhas = detalhes.map(d => {
        const dt = new Date(d.hora).toLocaleString('pt-BR');
        return `<div style="padding:8px 0;border-bottom:1px solid var(--gray-100)">
          <div style="font-size:12px;color:var(--gray-500)">${dt} — Ticket ${d.zappy_id ? '#' + esc(d.zappy_id) : '—'}</div>
          <div style="font-size:13px;color:var(--gray-700)"><em>"${esc(d.frase)}"</em> — ${esc(d.trecho || '')}</div>
        </div>`;
      }).join('') || '<p style="color:var(--gray-400);font-size:13px">Sem detalhes disponíveis.</p>';
      const html = `<tr id="churn-detalhe-${idx}"><td colspan="6" style="background:var(--gray-50);padding:10px 16px">
        <div style="font-size:12px;font-weight:600;color:var(--gray-600);margin-bottom:6px">Todas as mensagens que bateram (${detalhes.length}):</div>
        ${linhas}
      </td></tr>`;
      row.insertAdjacentHTML('afterend', html);
    },

    /**
     * Marca o ticket como falso alarme (não é churn de verdade) — some da
     * lista a partir de agora, mesmo que a mensagem continue batendo com
     * alguma frase da lista em varreduras futuras.
     */
    async tratarChurn(ticketId) {
      const motivo = window.prompt('O que foi feito / motivo do tratamento? (ex: "falso alarme, não é risco" ou "cliente contatado e resolvido" — opcional)');
      if (motivo === null) return; // cancelou o prompt
      try {
        const res = await fetch('/api/cs/churn/' + encodeURIComponent(ticketId) + '/tratar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ motivo }),
        });
        if (!res.ok) throw new Error('Falha ao tratar.');
        if (window.App && App.Toast) App.Toast.ok('Marcado como tratado — não vai aparecer mais nessa lista.');
        AnaliseInteligente.carregarChurnConversas();
      } catch (e) {
        if (window.App && App.Toast) App.Toast.err('Não foi possível marcar como tratado.');
      }
    },

    /**
     * "Insatisfação nas Conversas" — igual ao Possíveis Churns, mas com uma
     * lista bem mais ampla de palavras (não só frases de risco de
     * cancelamento) e varrendo TODO atendimento, não só o que vira pesquisa.
     * Lista uma linha por MENSAGEM (não agrupa por empresa).
     */
    async carregarInsatisfacaoConversas() {
      const tbody = document.getElementById('insatisfacao-conversas-tbody');
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--gray-400)">Carregando...</td></tr>';
      try {
        const res = await fetch('/api/cs/insatisfacao-conversas?dias=180', { headers: authHeaders() });
        if (!res.ok) throw new Error('Falha ao buscar.');
        const { data } = await res.json();
        if (!data || !data.length) {
          tbody.innerHTML = '<tr><td colspan="6" style="color:var(--gray-400)">Nenhum sinal de insatisfação encontrado nas conversas dos últimos 180 dias.</td></tr>';
          return;
        }
        tbody.innerHTML = data.map(c => {
          const dt = new Date(c.hora).toLocaleString('pt-BR');
          const nomeVinculo = c.vinculado
            ? esc(c.empresa)
            : `${esc(c.empresa)} <span style="color:var(--gray-400);font-size:11px">(não vinculado)</span>`;
          return `<tr>
            <td style="font-size:12px;color:var(--gray-500)">${dt}</td>
            <td style="font-weight:600">${nomeVinculo}</td>
            <td style="font-size:12px;color:var(--gray-500)">${c.zappy_id ? '#' + esc(c.zappy_id) : '—'}</td>
            <td style="font-size:12px"><span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:10px;font-weight:600">${esc(c.palavra_detectada)}</span></td>
            <td style="font-size:12px;color:var(--gray-600)">${esc((c.trecho||'').slice(0,140))}${(c.trecho||'').length>140?'...':''}</td>
            <td><button class="btn btn-ghost btn-sm" onclick="AnaliseInteligente.tratarInsatisfacao('${c.mensagem_id}')">✔ Tratar</button></td>
          </tr>`;
        }).join('');
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" style="color:var(--danger)">Não foi possível analisar as conversas agora.</td></tr>';
      }
    },

    /** Marca a MENSAGEM (não o ticket inteiro) como revisada. */
    async tratarInsatisfacao(mensagemId) {
      const motivo = window.prompt('O que foi feito / motivo do tratamento? (ex: "falso alarme, não é problema real" ou "cliente contatado e resolvido" — opcional)');
      if (motivo === null) return;
      try {
        const res = await fetch('/api/cs/insatisfacao-conversas/' + encodeURIComponent(mensagemId) + '/tratar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ motivo }),
        });
        if (!res.ok) throw new Error('Falha ao tratar.');
        if (window.App && App.Toast) App.Toast.ok('Marcado como tratado — não vai aparecer mais nessa lista.');
        AnaliseInteligente.carregarInsatisfacaoConversas();
      } catch (e) {
        if (window.App && App.Toast) App.Toast.err('Não foi possível marcar como tratado.');
      }
    },

    /**
     * "Afastamento" — clientes ativos que já não mandam mensagem no Zappy
     * há muito tempo. Guarda a lista completa em memória e o filtro de dias
     * (#afast-dias-filter) só reaplica sobre o que já foi carregado, sem
     * bater no servidor de novo.
     */
    async carregarAfastamento() {
      const tbody = document.getElementById('afastamento-tbody');
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--gray-400)">Carregando...</td></tr>';
      try {
        const res = await fetch('/api/cs/afastamento', { headers: authHeaders() });
        if (!res.ok) throw new Error('Falha ao buscar.');
        const { data } = await res.json();
        AnaliseInteligente._afastamentoData = data || [];
        AnaliseInteligente.filtrarAfastamento();
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="7" style="color:var(--danger)">Não foi possível calcular o afastamento agora.</td></tr>';
      }
    },

    filtrarAfastamento() {
      const tbody = document.getElementById('afastamento-tbody');
      if (!tbody) return;
      const minDias = parseInt(document.getElementById('afast-dias-filter')?.value || '0', 10);
      const todos = AnaliseInteligente._afastamentoData || [];
      const filtrados = todos.filter(c => c.sem_historico || (c.dias_sem_contato || 0) >= minDias);
      if (!filtrados.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="color:var(--gray-400)">Nenhum cliente nessa faixa de afastamento.</td></tr>';
        return;
      }
      tbody.innerHTML = filtrados.map(c => {
        const ultimo = c.ultimo_contato ? new Date(c.ultimo_contato).toLocaleDateString('pt-BR') : '—';
        const dias = c.sem_historico
          ? '<span style="color:var(--gray-400);font-size:12px">sem histórico</span>'
          : `<span style="font-weight:700;color:${c.dias_sem_contato >= 90 ? '#e53e3e' : c.dias_sem_contato >= 60 ? '#dd6b20' : 'var(--gray-700)'}">${c.dias_sem_contato} dias</span>`;
        return `<tr>
          <td style="font-weight:600">${esc(c.empresa || '—')}</td>
          <td style="font-size:12px;color:var(--gray-500)">${esc(c.cnpj || '—')}</td>
          <td style="font-size:12px">${esc(c.grupo_empresas || '—')}</td>
          <td style="font-size:12px">${esc(c.unidade || '—')}</td>
          <td style="font-size:12px;color:var(--gray-500)">${ultimo}</td>
          <td>${dias}</td>
          <td><button class="btn btn-ghost btn-sm" onclick="AnaliseInteligente.tratarAfastamento('${c.cliente_id}')">✔ Tratar</button></td>
        </tr>`;
      }).join('');
    },

    /**
     * Marca o cliente como acompanhado (já ligamos, confirmamos que está
     * tudo bem, etc). Some da lista por até 30 dias ou até ele voltar a
     * mandar mensagem no Zappy — o que vier primeiro (ver rota no backend).
     */
    async tratarAfastamento(clienteId) {
      const motivo = window.prompt('O que foi feito? (ex: ligamos e está tudo bem — opcional)');
      if (motivo === null) return;
      try {
        const res = await fetch('/api/cs/afastamento/' + encodeURIComponent(clienteId) + '/tratar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ motivo }),
        });
        if (!res.ok) throw new Error('Falha ao tratar.');
        if (window.App && App.Toast) App.Toast.ok('Marcado como acompanhado — some da lista por até 30 dias.');
        AnaliseInteligente.carregarAfastamento();
      } catch (e) {
        if (window.App && App.Toast) App.Toast.err('Não foi possível marcar como tratado.');
      }
    },

    // Cor fixa por motivo — usada no resumo, na legenda e na barra empilhada
    // de cada cliente, pra dar pra "bater o olho" e reconhecer o padrão sem
    // precisar abrir nada (pedido da Thais depois de ver a 1ª versão: "só
    // bate o olho e não dá pra analisar os insights estratégicos").
    _CORES_MOTIVO: {
      'Guias e Impostos': '#3b82f6',
      'Boletos e Honorários': '#10b981',
      'Folha de Pagamento / DP': '#8b5cf6',
      'Notas Fiscais': '#0ea5e9',
      'Documentos e Declarações': '#6366f1',
      'Abertura/Alteração/Baixa de Empresa': '#f59e0b',
      'Certificado Digital': '#ec4899',
      'Prazos e Obrigações Acessórias': '#d97706',
      'Dúvida Fiscal/Tributária': '#06b6d4',
      'Erros e Reclamações Operacionais': '#ef4444',
      'Quer Falar com Alguém Específico': '#78716c',
      'Outros / Não identificado': '#cbd5e0',
    },
    _corMotivo(label) { return AnaliseInteligente._CORES_MOTIVO[label] || '#94a3b8'; },

    /**
     * "Motivos de Abertura por Cliente" — resumo executivo no topo (total,
     * % não identificado, motivo #1), depois cada empresa com uma barra
     * proporcional (visual, sem precisar abrir) e no fim as palavras mais
     * comuns em "Outros" pra calibrar a lista sem ler ticket a ticket.
     */
    async carregarMotivosCliente() {
      const tbody = document.getElementById('motivos-cliente-tbody');
      const resumoEl = document.getElementById('motivos-resumo');
      const legendaEl = document.getElementById('motivos-legenda');
      const palavrasEl = document.getElementById('motivos-palavras-outros');
      const submotivosTbody = document.getElementById('motivos-submotivos-tbody');
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--gray-400)">Carregando...</td></tr>';
      if (resumoEl) resumoEl.innerHTML = '';
      if (legendaEl) legendaEl.innerHTML = '';
      if (palavrasEl) palavrasEl.innerHTML = '';
      if (submotivosTbody) submotivosTbody.innerHTML = '<tr><td colspan="3" style="color:var(--gray-400)">Carregando...</td></tr>';
      try {
        const res = await fetch('/api/cs/motivos?dias=180', { headers: authHeaders() });
        if (!res.ok) throw new Error('Falha ao buscar.');
        const { data, resumo, palavrasNaoClassificadas } = await res.json();
        AnaliseInteligente._motivosData = data || [];
        AnaliseInteligente._submotivosData = (resumo && resumo.porSubmotivoGeral) || [];

        // ── "O que de fato foi pedido" — ranking de solicitações específicas ──
        // Pedido direto da Thais: "sempre há um pedido, uma solicitação... o
        // que de fato foi a solicitação do cliente? Tente agrupar as mesmas
        // solicitações". Esse é o relatório que ela pediu, com export CSV.
        if (submotivosTbody) {
          const subs = AnaliseInteligente._submotivosData;
          if (!subs.length) {
            submotivosTbody.innerHTML = '<tr><td colspan="3" style="color:var(--gray-400)">Nenhuma solicitação específica identificada ainda.</td></tr>';
          } else {
            const totalSub = subs.reduce((s, r) => s + r.n, 0);
            submotivosTbody.innerHTML = subs.map(r => {
              const pct = totalSub ? Math.round((r.n / totalSub) * 100) : 0;
              return `<tr>
                <td><span style="width:9px;height:9px;border-radius:2px;background:${AnaliseInteligente._corMotivo(r.motivo)};display:inline-block;margin-right:6px"></span>${esc(r.motivo)}</td>
                <td style="font-weight:600">${esc(r.submotivo)}</td>
                <td>${r.n} <span style="color:var(--gray-400);font-size:11px">(${pct}%)</span></td>
              </tr>`;
            }).join('');
          }
        }

        // ── Resumo executivo ──────────────────────────────────────────────
        if (resumoEl && resumo) {
          const cards = [
            { label: 'Tickets analisados (180 dias)', valor: resumo.totalTickets, cor: 'var(--g700)' },
            { label: 'Motivo mais comum', valor: resumo.motivoTop ? resumo.motivoTop.label : '—', sub: resumo.motivoTop ? `${resumo.motivoTop.n} tickets` : '', cor: 'var(--g700)' },
            { label: 'Não identificados', valor: resumo.percentOutros + '%', sub: 'do total — quanto menor, melhor', cor: resumo.percentOutros >= 40 ? '#e53e3e' : resumo.percentOutros >= 20 ? '#dd6b20' : '#38a169' },
          ];
          resumoEl.innerHTML = cards.map(c => `
            <div style="background:#fff;border:1px solid var(--gray-200);border-radius:10px;padding:12px 18px;min-width:170px;flex:1">
              <div style="font-size:11px;color:var(--gray-500);font-weight:600;margin-bottom:4px">${esc(c.label)}</div>
              <div style="font-size:20px;font-weight:800;color:${c.cor}">${esc(String(c.valor))}</div>
              ${c.sub ? `<div style="font-size:11px;color:var(--gray-400)">${esc(c.sub)}</div>` : ''}
            </div>`).join('');
        }

        // ── Legenda de cores ──────────────────────────────────────────────
        if (legendaEl && resumo && resumo.porMotivoGeral) {
          legendaEl.innerHTML = resumo.porMotivoGeral.map(m => `
            <span style="display:inline-flex;align-items:center;gap:5px">
              <span style="width:10px;height:10px;border-radius:3px;background:${AnaliseInteligente._corMotivo(m.label)};display:inline-block"></span>
              ${esc(m.label)} (${m.n})
            </span>`).join('');
        }

        if (!data || !data.length) {
          tbody.innerHTML = '<tr><td colspan="5" style="color:var(--gray-400)">Nenhum ticket classificado nos últimos 180 dias.</td></tr>';
        } else {
          tbody.innerHTML = data.map((c, idx) => {
            const nomeVinculo = c.vinculado
              ? esc(c.empresa)
              : `${esc(c.empresa)} <span style="color:var(--gray-400);font-size:11px">(não vinculado)</span>`;
            // Barra empilhada: um <span> por motivo, largura proporcional ao total do cliente.
            const segmentos = Object.entries(c.porMotivo || {})
              .sort((a, b) => b[1] - a[1])
              .map(([label, n]) => {
                const pct = c.totalTickets ? (n / c.totalTickets * 100) : 0;
                return `<span title="${esc(label)}: ${n}" style="display:inline-block;height:100%;width:${pct}%;background:${AnaliseInteligente._corMotivo(label)}"></span>`;
              }).join('');
            const barra = `<div style="display:flex;height:16px;width:100%;border-radius:4px;overflow:hidden;background:var(--gray-100)">${segmentos}</div>`;
            return `<tr id="motivo-row-${idx}">
              <td style="font-weight:600">${nomeVinculo}</td>
              <td>${c.totalTickets}</td>
              <td>${barra}</td>
              <td style="font-size:12px"><span style="background:var(--g100);color:var(--g700);padding:2px 8px;border-radius:10px;font-weight:600">${esc(c.motivoPrincipal || '—')}</span></td>
              <td><a href="#" onclick="AnaliseInteligente.toggleMotivoDetalhe(${idx});return false" style="cursor:pointer;text-decoration:underline;font-weight:600">Ver tickets <span id="motivo-seta-${idx}">▾</span></a></td>
            </tr>`;
          }).join('');
        }

        // ── Palavras mais frequentes em "Outros" ──────────────────────────
        if (palavrasEl) {
          if (!palavrasNaoClassificadas || !palavrasNaoClassificadas.length) {
            palavrasEl.innerHTML = '<span style="color:var(--gray-400);font-size:12px">Nada relevante sobrando — a lista está cobrindo bem os casos.</span>';
          } else {
            palavrasEl.innerHTML = palavrasNaoClassificadas.map(p => `
              <span style="background:var(--gray-100);color:var(--gray-700);padding:4px 10px;border-radius:8px;font-size:12px;font-weight:600">${esc(p.palavra)} <span style="color:var(--gray-400);font-weight:400">(${p.n})</span></span>
            `).join('');
          }
        }
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" style="color:var(--danger)">Não foi possível analisar os motivos agora.</td></tr>';
      }
    },

    /** Exporta o ranking de solicitações específicas (motivo + submotivo) em CSV — o "relatório sobre essas situações" pedido pela Thais. */
    exportSubmotivosCSV() {
      const dados = AnaliseInteligente._submotivosData || [];
      if (!dados.length) { App.Toast.err('Nada para exportar ainda.'); return; }
      const escCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const linhas = [['Motivo', 'Solicitação Específica', 'Quantidade'].map(escCsv).join(',')];
      dados.forEach(r => linhas.push([r.motivo, r.submotivo, r.n].map(escCsv).join(',')));
      const blob = new Blob(['﻿' + linhas.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `solicitacoes_por_cliente_${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    },

    /** Expande/recolhe a lista de tickets (motivo + trecho) de uma empresa. */
    toggleMotivoDetalhe(idx) {
      const row = document.getElementById(`motivo-row-${idx}`);
      if (!row) return;
      const existente = document.getElementById(`motivo-detalhe-${idx}`);
      const seta = document.getElementById(`motivo-seta-${idx}`);
      if (existente) {
        existente.remove();
        if (seta) seta.textContent = '▾';
        return;
      }
      if (seta) seta.textContent = '▴';
      const item = (AnaliseInteligente._motivosData || [])[idx];
      const detalhes = (item && item.detalhes) || [];
      const linhas = detalhes.map(d => {
        const dt = new Date(d.hora).toLocaleString('pt-BR');
        const pessoa = d.pessoaSolicitada
          ? ` <span style="background:var(--g100);color:var(--g700);padding:1px 6px;border-radius:8px;font-size:11px">pediu: ${esc(d.pessoaSolicitada)}</span>`
          : '';
        // Motivo → Submotivo: pedido da Thais pra ver A SOLICITAÇÃO ESPECÍFICA
        // (ex.: "Guias e Impostos → Recálculo/Correção de Guia"), não só a
        // categoria ampla — "o que de fato foi a solicitação do cliente?".
        const motivoTexto = d.submotivo ? `${esc(d.motivo)} → ${esc(d.submotivo)}` : esc(d.motivo);
        return `<div style="padding:8px 0;border-bottom:1px solid var(--gray-100)">
          <div style="font-size:12px;color:var(--gray-500)">${dt} — Ticket ${d.zappy_id ? '#' + esc(d.zappy_id) : '—'} — ${esc(d.departamento || '—')}</div>
          <div style="font-size:13px;color:var(--gray-700)"><strong>${motivoTexto}</strong>${pessoa} — ${esc(d.trecho || '')}</div>
        </div>`;
      }).join('') || '<p style="color:var(--gray-400);font-size:13px">Sem detalhes disponíveis.</p>';
      const resumoMotivos = Object.entries(item?.porMotivo || {})
        .sort((a, b) => b[1] - a[1])
        .map(([m, n]) => `${esc(m)}: ${n}`).join(' · ');
      const html = `<tr id="motivo-detalhe-${idx}"><td colspan="5" style="background:var(--gray-50);padding:10px 16px">
        <div style="font-size:12px;font-weight:600;color:var(--gray-600);margin-bottom:6px">Resumo: ${resumoMotivos}</div>
        ${linhas}
      </td></tr>`;
      row.insertAdjacentHTML('afterend', html);
    },

    /**
     * Relatório unificado de tudo que já foi tratado (Churn + Insatisfação +
     * Afastamento) — pedido da Thais: "não consigo extrair um relatório dos
     * processos que tratei?". Some diferente dos outros: aqui não filtra o
     * item da lista, é o histórico do que já foi revisado.
     */
    async carregarTratados() {
      const tbody = document.getElementById('tratados-tbody');
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--gray-400)">Carregando...</td></tr>';
      try {
        const res = await fetch('/api/cs/tratados?dias=365', { headers: authHeaders() });
        if (!res.ok) throw new Error('Falha ao buscar.');
        const { data } = await res.json();
        AnaliseInteligente._tratadosData = data || [];
        if (!data || !data.length) {
          tbody.innerHTML = '<tr><td colspan="7" style="color:var(--gray-400)">Nenhum item tratado ainda nos últimos 365 dias.</td></tr>';
          return;
        }
        const rotulos = {
          churn: { label: 'Churn', bg: '#fef3c7', fg: '#92400e' },
          insatisfacao: { label: 'Insatisfação', bg: '#fee2e2', fg: '#991b1b' },
          afastamento: { label: 'Afastamento', bg: '#dbeafe', fg: '#1e40af' },
        };
        tbody.innerHTML = data.map(c => {
          const r = rotulos[c.tipo] || { label: c.tipo, bg: '#e2e8f0', fg: '#334155' };
          const dt = new Date(c.tratado_em).toLocaleString('pt-BR');
          const trecho = c.trecho ? `${esc(c.trecho.slice(0,120))}${c.trecho.length>120?'...':''}` : '—';
          return `<tr>
            <td style="font-size:12px"><span style="background:${r.bg};color:${r.fg};padding:2px 8px;border-radius:10px;font-weight:600">${r.label}</span></td>
            <td style="font-size:12px;color:var(--gray-500)">${dt}</td>
            <td style="font-weight:600">${esc(c.empresa || '—')}</td>
            <td style="font-size:12px;color:var(--gray-500)">${c.zappy_id ? '#' + esc(c.zappy_id) : '—'}</td>
            <td style="font-size:12px;color:var(--gray-600)">${trecho}</td>
            <td style="font-size:12px">${esc(c.motivo || '—')}</td>
            <td style="font-size:12px;color:var(--gray-500)">${esc(c.tratado_por || '—')}</td>
          </tr>`;
        }).join('');
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="7" style="color:var(--danger)">Não foi possível carregar o relatório agora.</td></tr>';
      }
    },

    exportTratadosCSV() {
      const data = AnaliseInteligente._tratadosData || [];
      if (!data.length) { if (window.App && App.Toast) App.Toast.err('Nenhum dado para exportar.'); return; }
      const rotulos = { churn: 'Churn', insatisfacao: 'Insatisfação', afastamento: 'Afastamento' };
      const header = ['Tipo','Data do tratamento','Empresa','CNPJ','Ticket','Trecho','Motivo','Tratado por'].join(';');
      const linhas = data.map(c => [
        rotulos[c.tipo] || c.tipo,
        new Date(c.tratado_em).toLocaleString('pt-BR'),
        c.empresa || '',
        c.cnpj || '',
        c.zappy_id ? '#' + c.zappy_id : '',
        c.trecho || '',
        c.motivo || '',
        c.tratado_por || '',
      ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(';'));
      const csv = [header, ...linhas].join('\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `tratados_${new Date().toISOString().slice(0,10)}.csv`;
      a.click(); URL.revokeObjectURL(url);
      if (window.App && App.Toast) App.Toast.ok('CSV exportado!');
    },

    async carregarChurn() {
      const tbody = document.getElementById('churn-tbody');
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan="4" style="color:var(--gray-400)">Carregando...</td></tr>';
      try {
        const res = await fetch('/api/data/churn', { headers: authHeaders() });
        if (!res.ok) throw new Error('Falha ao buscar.');
        const { data } = await res.json();
        if (!data || !data.length) {
          tbody.innerHTML = '<tr><td colspan="4" style="color:var(--gray-400)">Nenhum cliente ativo cadastrado na Carteira ainda.</td></tr>';
          return;
        }
        const cores = {
          vermelho: { bg: '#fff5f5', fg: '#e53e3e', label: 'Alto risco' },
          amarelo:  { bg: '#fffbeb', fg: '#d69e2e', label: 'Atenção' },
          verde:    { bg: '#f0fff4', fg: '#38a169', label: 'Baixo risco' },
        };
        tbody.innerHTML = data.map(c => {
          const cor = cores[c.nivel] || cores.verde;
          const motivos = (c.motivos || []).length ? c.motivos.join('; ') : 'Nenhum sinal de risco identificado.';
          return `<tr>
            <td style="font-weight:600">${esc(c.empresa)}</td>
            <td style="font-size:12px;color:var(--gray-500)">${esc(c.cnpj)}</td>
            <td><span style="background:${cor.bg};color:${cor.fg};padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700">${cor.label} (${c.score})</span></td>
            <td style="font-size:12px;color:var(--gray-600)">${esc(motivos)}</td>
          </tr>`;
        }).join('');
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:var(--danger)">Não foi possível calcular o risco de cancelamento agora.</td></tr>';
      }
    },

    async carregarSentimento() {
      const resumoEl = document.getElementById('sentimento-resumo');
      const tbody = document.getElementById('sentimento-tbody');
      if (!resumoEl || !tbody) return;
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--gray-400)">Carregando...</td></tr>';
      try {
        const res = await fetch('/api/data/sentimento', { headers: authHeaders() });
        if (!res.ok) throw new Error('Falha ao buscar.');
        const { resumo, comentarios } = await res.json();

        const cartoes = [
          { key: 'positivo', label: '😊 Positivos', cor: '#38a169' },
          { key: 'neutro', label: '😐 Neutros', cor: '#94a3b8' },
          { key: 'negativo', label: '😞 Negativos', cor: '#e53e3e' },
        ];
        resumoEl.innerHTML = cartoes.map(c => `
          <div style="background:#fff;border:1px solid var(--gray-200);border-radius:10px;padding:12px 20px;text-align:center;min-width:100px">
            <div style="font-size:24px;font-weight:800;color:${c.cor}">${(resumo && resumo[c.key]) || 0}</div>
            <div style="font-size:11px;color:var(--gray-500);font-weight:600">${c.label}</div>
          </div>
        `).join('');

        if (!comentarios || !comentarios.length) {
          tbody.innerHTML = '<tr><td colspan="5" style="color:var(--gray-400)">Nenhum comentário registrado ainda.</td></tr>';
          return;
        }
        const rotulos = {
          positivo: { cor: '#38a169', label: 'Positivo' },
          neutro: { cor: '#94a3b8', label: 'Neutro' },
          negativo: { cor: '#e53e3e', label: 'Negativo' },
          sem_comentario: { cor: '#cbd5e0', label: '—' },
        };
        tbody.innerHTML = comentarios.map(c => {
          const r = rotulos[c.sentimento] || rotulos.neutro;
          const dt = new Date(c.created_at).toLocaleDateString('pt-BR');
          return `<tr>
            <td style="font-size:12px;color:var(--gray-500)">${dt}</td>
            <td>${esc(c.cliente || '—')}</td>
            <td>${esc(c.empresa || '—')}</td>
            <td style="font-size:13px">${esc(c.pontos || '—')}</td>
            <td><span style="color:${r.cor};font-weight:700;font-size:12px">${r.label}</span></td>
          </tr>`;
        }).join('');
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" style="color:var(--danger)">Não foi possível carregar o sentimento agora.</td></tr>';
      }
    },
  };

  window.AnaliseInteligente = AnaliseInteligente;
})();
