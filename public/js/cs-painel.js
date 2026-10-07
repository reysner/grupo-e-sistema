/* Painel do Sucesso do Cliente (/cs). Só leitura: toda checagem de acesso é feita pelo servidor (/api/cs/painel). */
(function () {
  'use strict';

  var VERSAO = 'V.1.0 · 07/10/2026';
  var K_TOKEN = 'cs_token', K_REFRESH = 'cs_refresh', K_USER = 'cs_user';

  var COR_RISCO = { 'Alto': '#dc2626', 'Médio': '#d97706', 'Baixo': '#10b981', 'Incompleto': '#9ca3af' };
  var COR_TERM = { financeiro: '#b45309', atendimento: '#7c3aed', operacional: '#ef4444' };
  var NOME_TERM = { financeiro: 'Financeiro', atendimento: 'Atendimento', operacional: 'Operacional' };
  var COR_CAT = { 'Diamante': '#0891b2', 'Ouro': '#c99a06', 'Prata': '#6b7280', 'Bronze': '#b45309' };
  var ICONE_CAT = { 'Diamante': '💎', 'Ouro': '🥇', 'Prata': '🥈', 'Bronze': '🥉' };
  var TIPO_SAIDA = {
    transferida: { rot: 'Transferida', cor: '#dc2626', conta: true },
    a_confirmar: { rot: 'A confirmar', cor: '#d97706' },
    baixa: { rot: 'Baixa', cor: '#6b7280' },
    outra_saida: { rot: 'Outra saída', cor: '#6b7280' },
  };
  var TITULOS = {
    visao: ['Visão Geral', 'Clientes ativos, saídas por transferência e risco de perda — só CNPJ. Material da reunião semanal das lideranças.'],
    risco: ['Gestão da Permanência', 'Quem está em risco de sair e por quê: Financeiro, Atendimento e Operacional. Clique no nome da empresa para ver a ficha.'],
    churn: ['Churn', 'Saídas do período ÷ base ativa no início do período. Só contam as três "Transferida por…" do Acessórias.'],
    categorias: ['Categorias', 'Diamante, Ouro, Prata e Bronze pelo honorário, somando grupos de empresas. O motivo de cada categoria aparece sempre.'],
    qualidade: ['Qualidade dos Dados', 'De onde vem cada indicador e o que ainda está sem dado.'],
  };

  var estado = { dados: null, periodoChave: 'ultimos_12_meses', churnLivre: null, secao: 'visao', graficos: {}, filtroRisco: { busca: '', nivel: 'AltoMedio', cat: '', term: '', soAtend: false, todos: false }, abaChurn: 'transferida', catSel: '' };

  // ── utilidades ───────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function data(s) { return s ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) + '/' + String(s).slice(0, 4) : '—'; }
  function reais(v) { return v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function pct(n, d) { return d ? Math.round(100 * n / d) : 0; }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  function nivelTerm(p, cortes) { return p == null ? null : (p >= cortes.alto ? 'Alto' : p >= cortes.medio ? 'Médio' : 'Baixo'); }

  // ── sessão ───────────────────────────────────────────────────────────────────
  function mostrarLogin(msg) {
    $('app').style.display = 'none';
    $('login-screen').style.display = 'flex';
    var e = $('login-err');
    if (msg) { e.textContent = msg; e.style.display = 'block'; } else { e.style.display = 'none'; }
  }

  async function renovar() {
    var rt = ls(K_REFRESH);
    if (!rt) return false;
    try {
      var r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
      if (!r.ok) return false;
      var j = await r.json();
      ls(K_TOKEN, j.token); ls(K_REFRESH, j.refreshToken);
      return true;
    } catch (e) { return false; }
  }

  async function api(caminho, tentou) {
    var r = await fetch(caminho, { headers: { Authorization: 'Bearer ' + (ls(K_TOKEN) || '') }, cache: 'no-store' });
    if (r.status === 401 && !tentou) { if (await renovar()) return api(caminho, true); }
    if (r.status === 401) { sair(true); throw new Error('Sessão expirada. Entre de novo.'); }
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || 'Erro ' + r.status);
    return j;
  }

  async function entrar(ev) {
    ev.preventDefault();
    var btn = $('login-btn'); btn.disabled = true; btn.textContent = 'Entrando…';
    try {
      var r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('inp-email').value.trim(), password: $('inp-senha').value }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) { mostrarLogin(j.error || 'Não foi possível entrar.'); return; }
      if (['administrador', 'usuario'].indexOf(j.user.role) < 0) { mostrarLogin('Este painel é da equipe do Sucesso do Cliente. Peça acesso à administração.'); return; }
      ls(K_TOKEN, j.token); ls(K_REFRESH, j.refreshToken); ls(K_USER, JSON.stringify(j.user));
      $('inp-senha').value = '';
      iniciar();
    } catch (e) { mostrarLogin('Sem conexão com o servidor. Tente de novo.'); }
    finally { btn.disabled = false; btn.textContent = 'Entrar'; }
  }

  function sair(silencioso) {
    var rt = ls(K_REFRESH), tk = ls(K_TOKEN);
    if (!silencioso && rt && tk) fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify({ refreshToken: rt }) }).catch(function () {});
    ls(K_TOKEN, null); ls(K_REFRESH, null); ls(K_USER, null);
    estado.dados = null;
    mostrarLogin(silencioso ? 'Sua sessão expirou. Entre de novo.' : '');
  }

  // ── carga ────────────────────────────────────────────────────────────────────
  async function iniciar() {
    $('login-screen').style.display = 'none';
    $('app').style.display = 'block';
    var u = null; try { u = JSON.parse(ls(K_USER) || 'null'); } catch (e) { u = null; }
    $('usuario').textContent = u && u.name ? 'Olá, ' + u.name : '';
    ['visao', 'risco', 'churn', 'categorias', 'qualidade'].forEach(function (s) { $('sec-' + s).innerHTML = '<div class="vazio">Carregando…</div>'; });
    try {
      estado.dados = await api('/api/cs/painel/dados');
      estado.churnLivre = null;
      desenharTudo();
    } catch (e) {
      ['visao', 'risco', 'churn', 'categorias', 'qualidade'].forEach(function (s) { $('sec-' + s).innerHTML = '<div class="card"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; });
    }
  }

  function periodoAtual() {
    var d = estado.dados;
    if (estado.periodoChave === 'livre' && estado.churnLivre) return estado.churnLivre;
    return d.churn.periodos[estado.periodoChave] || d.churn.periodos.ultimos_12_meses;
  }

  function desenharTudo() {
    var d = estado.dados;
    var t = d.totais;
    $('badge-risco').textContent = t.risco.Alto || '';
    $('badge-churn').textContent = periodoAtual().saidas_contadas;
    $('atualizado').textContent = 'Atualizado em ' + new Date(d.gerado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    desenharVisao(); desenharRisco(); desenharChurn(); desenharCategorias(); desenharQualidade();
    irPara(estado.secao);
  }

  function irPara(sec) {
    estado.secao = sec;
    Array.prototype.forEach.call(document.querySelectorAll('.gp-nav-item'), function (b) { b.classList.toggle('active', b.getAttribute('data-sec') === sec); });
    Array.prototype.forEach.call(document.querySelectorAll('.gp-section'), function (s) { s.classList.toggle('ativa', s.id === 'sec-' + sec); });
    $('titulo').textContent = TITULOS[sec][0];
    $('subtitulo').textContent = TITULOS[sec][1];
    $('filtro-periodo').style.display = (sec === 'visao' || sec === 'churn') ? 'flex' : 'none';
    var ativa = $('sec-' + sec); if (ativa) ativa.scrollTop = 0;
  }

  // ── gráficos ─────────────────────────────────────────────────────────────────
  function graf(id, config) {
    if (estado.graficos[id]) { estado.graficos[id].destroy(); delete estado.graficos[id]; }
    var el = $(id); if (!el || typeof Chart === 'undefined') return;
    estado.graficos[id] = new Chart(el, config);
  }
  var OPC = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 11 }, color: '#5a5a5a' } } } };

  // ── blocos reutilizáveis ─────────────────────────────────────────────────────
  function kpi(cor, rot, val, sub) {
    return '<div class="gp-kpi"><div class="gp-kpi-bar" style="background:' + cor + '"></div><div class="gp-kpi-label">' + rot + '</div><div class="gp-kpi-value" style="color:' + cor + '">' + val + '</div><div class="gp-kpi-sub">' + sub + '</div></div>';
  }
  function pillRisco(r) {
    var c = COR_RISCO[r.nivel] || '#9ca3af';
    return '<span class="pill" style="color:' + c + ';border-color:' + c + '55;background:' + c + '14">' + esc(r.nivel) + (r.pontos != null ? ' · ' + r.pontos : '') + (r.alerta ? ' ⚠️' : '') + '</span>';
  }
  function pillCat(c) {
    if (!c.categoria) return '<span class="cinza">Sem categoria</span>';
    var cor = COR_CAT[c.categoria];
    return '<span class="pill" style="color:' + cor + ';border-color:' + cor + '66;background:' + cor + '14">' + ICONE_CAT[c.categoria] + ' ' + esc(c.categoria) + '</span>';
  }
  function celTerm(c, t) {
    var p = c.risco.termometros[t];
    if (p == null) return '<span class="cinza">sem dado</span>';
    var n = nivelTerm(p, estado.dados.config.cortes), cor = COR_RISCO[n];
    return '<span style="color:' + cor + ';font-weight:700;white-space:nowrap">' + p + '</span>';
  }
  function barra(partes) {
    var tot = partes.reduce(function (a, p) { return a + p.n; }, 0);
    if (!tot) return '<div class="barra"></div>';
    return '<div class="barra">' + partes.map(function (p) { return '<div title="' + esc(p.rot) + ': ' + p.n + '" style="width:' + (100 * p.n / tot) + '%;background:' + p.cor + '"></div>'; }).join('') + '</div>' +
      '<div class="linhas">' + partes.map(function (p) { return '<div><i style="background:' + p.cor + '"></i>' + esc(p.rot) + '<b>' + p.n + '</b></div>'; }).join('') + '</div>';
  }
  function nomeLink(c) {
    return '<button class="link" data-ficha="' + esc(c.id) + '">' + esc(c.nome) + '</button><div class="sub">' + esc(c.cnpj || '') + '</div>';
  }

  // ── VISÃO GERAL ──────────────────────────────────────────────────────────────
  function desenharVisao() {
    var d = estado.dados, t = d.totais, p = periodoAtual();
    var avaliados = t.risco.Alto + t.risco['Médio'] + t.risco.Baixo;
    var alertas = d.clientes.filter(function (c) { return c.risco.alerta && c.risco.nivel !== 'Alto'; }).length;
    var blocoRisco = function (nivel, regra) {
      var cor = COR_RISCO[nivel], n = t.risco[nivel];
      return '<button class="risco-bloco" data-nivel="' + nivel + '" style="border-color:' + cor + '55;background:' + cor + '0d"><div class="rot" style="color:' + cor + '">' + nivel + '</div>' +
        '<div class="num"><span class="pct" style="color:' + cor + '">' + (avaliados ? pct(n, avaliados) + '%' : '—') + '</span><span class="qtd">' + n + ' <small>cliente' + (n === 1 ? '' : 's') + '</small></span></div><div class="reg">' + regra + '</div></button>';
    };
    var c = d.config.cortes;
    var tres = ['financeiro', 'atendimento', 'operacional'].map(function (k) {
      var tm = t.termometros[k];
      var com = d.clientes.filter(function (x) { return x.risco.termometros[k] != null; });
      var alto = com.filter(function (x) { return nivelTerm(x.risco.termometros[k], c) === 'Alto'; }).length;
      var med = com.filter(function (x) { return nivelTerm(x.risco.termometros[k], c) === 'Médio'; }).length;
      var bai = com.length - alto - med;
      var perg = { financeiro: 'O cliente está com honorário em atraso?', atendimento: 'O cliente teve falha de atendimento ou reclamou?', operacional: 'Estamos entregando guias e fechamentos no prazo?' }[k];
      var regua = { financeiro: 'Fonte: Omie. Pesa os dias do título mais antigo em atraso e a quantidade de títulos.', atendimento: 'Fonte: Zappy depois da revisão da Gamificação, mais insatisfações registradas e pesquisas. Falha marcada como indevida não conta.', operacional: 'Fonte: entregas do Acessórias nos últimos 90 dias (entregues com atraso e vencidas sem entrega).' }[k];
      return '<div class="tres-card" style="border-top-color:' + COR_TERM[k] + '"><div class="tres-nome">' + NOME_TERM[k].toUpperCase() + '</div><div class="tres-perg">' + perg + '</div>' +
        '<div class="tres-dest"><b style="color:' + COR_TERM[k] + '">' + (com.length ? pct(alto + med, com.length) + '%' : '—') + '</b><span>em risco Médio ou Alto · ' + (alto + med) + ' de ' + com.length + ' com dado</span></div>' +
        barra([{ rot: 'Alto', n: alto, cor: COR_RISCO.Alto }, { rot: 'Médio', n: med, cor: COR_RISCO['Médio'] }, { rot: 'Baixo', n: bai, cor: COR_RISCO.Baixo }]) +
        (tm.sem_dado ? '<div class="sub" style="margin-top:6px">' + tm.sem_dado + ' cliente(s) sem dado deste indicador (não presumimos que está em dia).</div>' : '') +
        '<div class="tres-regua">' + regua + '</div></div>';
    }).join('');

    var dominantes = { financeiro: 0, atendimento: 0, operacional: 0 };
    d.clientes.filter(function (x) { return x.risco.nivel === 'Alto' || x.risco.nivel === 'Médio'; }).forEach(function (x) {
      var k = Object.keys(x.risco.termometros).filter(function (t2) { return x.risco.termometros[t2] != null; }).sort(function (a, b) { return x.risco.termometros[b] - x.risco.termometros[a]; })[0];
      if (k) dominantes[k]++;
    });
    var emRisco = t.risco.Alto + t.risco['Médio'];
    var pontos = [];
    if (t.risco.Alto) pontos.push('<strong>' + t.risco.Alto + ' cliente(s) em Alto risco</strong>: abra a Gestão da Permanência e combine o próximo passo de cada um.');
    if (emRisco) pontos.push('Dos ' + emRisco + ' clientes em risco Alto ou Médio, o termômetro que mais pesa é <strong>Financeiro em ' + dominantes.financeiro + '</strong>, Atendimento em ' + dominantes.atendimento + ' e Operacional em ' + dominantes.operacional + '.');
    if (t.termometros.operacional.com_dado === 0) pontos.push('O termômetro <strong>Operacional ainda está sem dado</strong> (entregas do Acessórias em leitura). Enquanto isso, o risco é calculado só com Financeiro e Atendimento.');
    if (p.fora_do_churn && p.fora_do_churn.a_confirmar) pontos.push(p.fora_do_churn.a_confirmar + ' saída(s) ainda <strong>a confirmar</strong> (sem motivo lido do Acessórias): o churn real fica entre ' + p.taxa + '% e ' + p.taxa_teto + '%.');
    pontos.push('<strong>' + pct(t.sem_reclamacao_30d, t.clientes) + '%</strong> dos clientes ficaram sem nenhuma reclamação nos últimos 30 dias (insatisfação registrada, nota baixa ou abandono).');

    $('sec-visao').innerHTML =
      '<div class="nota"><strong>Clientes</strong> = empresas com CNPJ ativas na carteira. CPF, CAEPF e CNO ficam de fora de todos os indicadores deste painel (' + t.desconsiderados_nao_cnpj + ' cadastros).</div>' +
      '<div class="gp-kpi-row">' +
        kpi('#256050', 'Clientes ativos', t.clientes, 'CNPJ ativos na carteira') +
        kpi('#dc2626', 'Saídas no período', p.saidas_contadas, 'só "Transferida por…" · base de ' + p.base) +
        kpi('#d97706', 'Taxa de churn', (p.taxa == null ? '—' : p.taxa + '%'), p.fora_do_churn && p.fora_do_churn.a_confirmar ? 'teto de ' + p.taxa_teto + '% se as "a confirmar" forem transferências' : 'saídas ÷ base no início do período') +
        kpi('#7c3aed', 'Saíram em até 90 dias', p.menos_de_90_dias, 'desligados com menos de 90 dias de casa (todos os tipos)') +
        kpi('#10b981', 'Sem reclamação no mês', t.sem_reclamacao_30d, pct(t.sem_reclamacao_30d, t.clientes) + '% dos clientes · últimos 30 dias') +
        kpi('#b45309', 'Em Alto risco', t.risco.Alto, t.risco['Médio'] + ' em Médio risco') +
      '</div>' +
      '<div class="risco-card"><div class="risco-head"><div><div class="risco-titulo">RISCO DE PERDA</div><div class="risco-sub">Combina os três termômetros, cliente a cliente · ' + avaliados + ' clientes avaliados</div></div>' +
        (alertas ? '<div class="risco-alerta">⚠️ ' + alertas + ' alerta(s): termômetro muito alto em cliente de Médio risco</div>' : '') + '</div>' +
        '<div class="risco-blocos">' + blocoRisco('Alto', 'a partir de ' + c.alto + ' pontos') + blocoRisco('Médio', c.medio + ' a ' + (c.alto - 1) + ' pontos') + blocoRisco('Baixo', 'abaixo de ' + c.medio + ' pontos') + '</div>' +
        '<div class="sub">Os pesos dos três termômetros hoje são ' + ['financeiro', 'atendimento', 'operacional'].map(function (k) { return NOME_TERM[k] + ' ' + d.config.pesos[k]; }).join(' · ') + ' (serão calibrados rodando, a partir das reuniões semanais).</div></div>' +
      '<div class="ficha-sec" style="margin-top:6px">Detalhamento do risco</div><div class="tres">' + tres + '</div>' +
      '<div class="gp-charts-row">' +
        '<div class="gp-chart-card"><div class="gp-chart-title">Churn mês a mês — últimos 12 meses</div><div class="gp-chart-wrap"><canvas id="g-churn"></canvas></div></div>' +
        '<div class="gp-chart-card"><div class="gp-chart-title">Clientes por categoria</div><div class="gp-chart-wrap"><canvas id="g-cat"></canvas></div></div>' +
      '</div>' +
      '<div class="gp-bullets"><div class="gp-bullets-title">Pontos para a reunião</div>' + pontos.map(function (x) { return '<div class="gp-bullet"><span>•</span><span>' + x + '</span></div>'; }).join('') + '</div>';

    var ev = d.churn.evolucao;
    graf('g-churn', { data: { labels: ev.map(function (m) { return m.mes.slice(5) + '/' + m.mes.slice(2, 4); }), datasets: [
      { type: 'bar', label: 'Saídas', data: ev.map(function (m) { return m.saidas; }), backgroundColor: '#dc262688', yAxisID: 'y' },
      { type: 'line', label: 'Taxa de churn (%)', data: ev.map(function (m) { return m.taxa; }), borderColor: '#256050', backgroundColor: '#256050', tension: .3, yAxisID: 'y1' }] },
      options: Object.assign({}, OPC, { scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: function (v) { return v + '%'; } } } } }) });
    var cats = ['Diamante', 'Ouro', 'Prata', 'Bronze'];
    graf('g-cat', { type: 'doughnut', data: { labels: cats.concat(['Sem categoria']), datasets: [{ data: cats.map(function (k) { return t.categorias[k]; }).concat([t.categorias.sem_categoria]), backgroundColor: cats.map(function (k) { return COR_CAT[k]; }).concat(['#d1d5db']), borderWidth: 0 }] }, options: Object.assign({}, OPC, { cutout: '58%', plugins: { legend: { position: 'right', labels: { font: { size: 11 } } } } }) });
  }

  // ── GESTÃO DA PERMANÊNCIA ────────────────────────────────────────────────────
  function dominante(c) {
    var ks = Object.keys(c.risco.termometros).filter(function (k) { return c.risco.termometros[k] != null; });
    ks.sort(function (a, b) { return c.risco.termometros[b] - c.risco.termometros[a]; });
    return ks[0] || null;
  }
  function filtrarRisco() {
    var f = estado.filtroRisco, b = f.busca.trim().toLowerCase();
    return estado.dados.clientes.filter(function (c) {
      if (f.nivel === 'AltoMedio' && c.risco.nivel !== 'Alto' && c.risco.nivel !== 'Médio') return false;
      if (f.nivel && f.nivel !== 'AltoMedio' && f.nivel !== 'todos' && c.risco.nivel !== f.nivel) return false;
      if (f.cat && c.categoria !== f.cat) return false;
      if (f.term && dominante(c) !== f.term) return false;
      if (f.soAtend && !(c.risco.termometros.atendimento > 0)) return false;
      if (b && (c.nome || '').toLowerCase().indexOf(b) < 0 && String(c.cnpj || '').replace(/\D/g, '').indexOf(b.replace(/\D/g, '') || '§') < 0) return false;
      return true;
    });
  }
  function linhasRisco() {
    var f = estado.filtroRisco, lista = filtrarRisco(), mostrar = f.todos ? lista : lista.slice(0, 150);
    var corpo = mostrar.map(function (c) {
      var chips = (c.risco.motivos || []).slice(0, 3).map(function (m) { return '<span class="chip" style="color:#dc2626;border-color:#dc262655">' + esc(m) + '</span>'; }).join('');
      return '<tr><td style="min-width:220px;max-width:280px;white-space:normal">' + nomeLink(c) + '</td><td class="c">' + pillCat(c) + '</td><td class="c">' + pillRisco(c.risco) + '</td>' +
        '<td class="c">' + celTerm(c, 'financeiro') + '</td><td class="c">' + celTerm(c, 'atendimento') + '</td><td class="c">' + celTerm(c, 'operacional') + '</td>' +
        '<td style="min-width:280px;white-space:normal">' + (chips || '<span class="cinza">sem sinais</span>') + '</td></tr>';
    }).join('');
    return { n: lista.length, html: lista.length ? '<div class="table-wrap"><table><thead><tr><th>Cliente</th><th class="c">Categoria</th><th class="c">Risco</th><th class="c">Financeiro</th><th class="c">Atendimento</th><th class="c">Operacional</th><th>O que está puxando</th></tr></thead><tbody>' + corpo + '</tbody></table></div>' +
      (lista.length > mostrar.length ? '<div class="vazio">Mostrando ' + mostrar.length + ' de ' + lista.length + '. <button class="link" id="r-todos">Mostrar todos</button></div>' : '') : '<div class="vazio">Nenhum cliente neste filtro.</div>' };
  }
  function desenharRisco() {
    var d = estado.dados, f = estado.filtroRisco;
    var opt = function (v, rot, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(rot) + '</option>'; };
    $('sec-risco').innerHTML =
      '<details class="card leg" style="padding:12px 20px"><summary><span class="seta">▶</span> 📏 Legenda — como o risco é calculado <span style="font-weight:500;text-transform:none;letter-spacing:0">(clique para expandir)</span></summary><div class="corpo">' +
        '<div><strong style="color:#dc2626">Risco de perda</strong><br>Média dos termômetros que têm dado, de 0 a 100. Médio a partir de ' + d.config.cortes.medio + ', Alto a partir de ' + d.config.cortes.alto + '. Um termômetro muito alto sozinho gera alerta e sobe o cliente para Médio.</div>' +
        '<div><strong style="color:' + COR_TERM.financeiro + '">Financeiro</strong><br>Dias de atraso do título mais antigo (até 15 dias = 25 pontos; acima de 90 = 90), mais 10 pontos com 3 ou mais títulos. Cliente marcado como inadimplente crônico fica em 70, no mínimo.</div>' +
        '<div><strong style="color:' + COR_TERM.atendimento + '">Atendimento</strong><br>Insatisfações registradas (pesam pela gravidade e diminuem depois de 90 dias), notas baixas, SLA vermelho e abandonos do Zappy <em>depois da revisão da Gamificação</em>, e detratores das pesquisas.</div>' +
        '<div><strong style="color:' + COR_TERM.operacional + '">Operacional</strong><br>Proporção de entregas do Acessórias (últimos 90 dias) que foram entregues com atraso ou venceram sem entrega. Entrega dentro do prazo técnico ou do prazo legal não conta como atraso.</div>' +
      '</div></details>' +
      '<div class="card"><div class="filter-group" style="margin-bottom:14px">' +
        '<span class="filter-label">Buscar</span><input class="gp-input" id="r-busca" placeholder="Nome ou CNPJ" value="' + esc(f.busca) + '">' +
        '<span class="filter-label">Risco</span><select class="gp-select" id="r-nivel">' + opt('AltoMedio', 'Alto e Médio', f.nivel === 'AltoMedio') + opt('Alto', 'Só Alto', f.nivel === 'Alto') + opt('Médio', 'Só Médio', f.nivel === 'Médio') + opt('Baixo', 'Baixo', f.nivel === 'Baixo') + opt('todos', 'Todos', f.nivel === 'todos') + '</select>' +
        '<span class="filter-label">Categoria</span><select class="gp-select" id="r-cat">' + opt('', 'Todas', !f.cat) + ['Diamante', 'Ouro', 'Prata', 'Bronze'].map(function (k) { return opt(k, k, f.cat === k); }).join('') + '</select>' +
        '<span class="filter-label">Pesa mais</span><select class="gp-select" id="r-term">' + opt('', 'Qualquer', !f.term) + ['financeiro', 'atendimento', 'operacional'].map(function (k) { return opt(k, NOME_TERM[k], f.term === k); }).join('') + '</select>' +
        '<label style="font-size:12px;color:var(--text2);display:flex;gap:6px;align-items:center"><input type="checkbox" id="r-atend"' + (f.soAtend ? ' checked' : '') + '> só com sinal de Atendimento</label></div>' +
      '<div id="r-lista"></div></div>';
    pintarListaRisco();
    var refaz = function () { f.busca = $('r-busca').value; f.nivel = $('r-nivel').value; f.cat = $('r-cat').value; f.term = $('r-term').value; f.soAtend = $('r-atend').checked; f.todos = false; pintarListaRisco(); };
    ['r-busca', 'r-nivel', 'r-cat', 'r-term', 'r-atend'].forEach(function (id) { $(id).addEventListener(id === 'r-busca' ? 'input' : 'change', refaz); });
  }
  function pintarListaRisco() {
    var r = linhasRisco();
    $('r-lista').innerHTML = '<div class="card-sub">' + r.n + ' cliente(s) · ordem: pontos de risco, do maior para o menor</div>' + r.html;
    var b = $('r-todos'); if (b) b.addEventListener('click', function () { estado.filtroRisco.todos = true; pintarListaRisco(); });
  }

  // ── CHURN ────────────────────────────────────────────────────────────────────
  function desenharChurn() {
    var d = estado.dados, p = periodoAtual();
    var abas = [['transferida', 'Transferidas (contam)'], ['a_confirmar', 'A confirmar'], ['baixa', 'Baixas'], ['outra_saida', 'Outras saídas']];
    var cont = function (tp) { return p.saidas.filter(function (s) { return s.tipo === tp; }).length; };
    var lista = p.saidas.filter(function (s) { return s.tipo === estado.abaChurn; });
    var linhas = lista.map(function (s) {
      var t = TIPO_SAIDA[s.tipo];
      return '<tr><td style="white-space:normal">' + esc(s.nome) + '<div class="sub">' + esc(s.cnpj || '') + '</div></td><td class="c">' + data(s.data_entrada) + '</td><td class="c">' + data(s.data_saida) + '</td>' +
        '<td class="c"><span class="pill" style="color:' + t.cor + ';border-color:' + t.cor + '55;background:' + t.cor + '14">' + t.rot + '</span></td>' +
        '<td class="c">' + (s.na_base ? 'Sim' : '<span class="cinza">entrou no período</span>') + '</td><td class="c"><span class="cinza">' + esc(s.origem || '—') + '</span></td></tr>';
    }).join('');
    $('sec-churn').innerHTML =
      '<div class="gp-kpi-row">' +
        kpi('#256050', 'Base no início do período', p.base, 'clientes CNPJ ativos em ' + data(p.ini)) +
        kpi('#dc2626', 'Saídas que contam', p.saidas_contadas, 'Transferida por conveniência, mau atendimento ou preço') +
        kpi('#d97706', 'Taxa de churn', p.taxa == null ? '—' : p.taxa + '%', p.fora_do_churn.a_confirmar ? 'teto de ' + p.taxa_teto + '% com as a confirmar' : 'saídas que contam ÷ base') +
        kpi('#7c3aed', 'Saíram em até 90 dias', p.menos_de_90_dias, 'de casa, todos os tipos') +
        kpi('#6b7280', 'Fora do churn', p.fora_do_churn.baixas + p.fora_do_churn.outras_saidas, 'baixas e outras saídas') +
      '</div>' +
      '<div class="nota">Período de <strong>' + data(p.ini) + '</strong> a <strong>' + data(p.fim) + '</strong>. Contam como churn as saídas cujo motivo no Acessórias começa com: <strong>' + d.churn.padroes.map(esc).join('</strong>, <strong>') + '</strong>. Baixas não contam. Quando o Acessórias não informa o motivo, a situação do CNPJ na Receita ajuda a separar baixa de transferência; o que não for possível fica "a confirmar". Só CNPJ.</div>' +
      '<div class="card"><div class="card-title">Saídas do período</div><div class="card-sub">Clique na aba para ver cada tipo de saída.</div>' +
        '<div class="tabs" id="abas-churn">' + abas.map(function (a) { return '<button data-aba="' + a[0] + '" class="' + (estado.abaChurn === a[0] ? 'active' : '') + '">' + a[1] + ' (' + cont(a[0]) + ')</button>'; }).join('') + '</div>' +
        (lista.length ? '<div class="table-wrap"><table><thead><tr><th>Cliente</th><th class="c">Entrada</th><th class="c">Saída</th><th class="c">Tipo</th><th class="c">Na base do início</th><th class="c">Como foi classificada</th></tr></thead><tbody>' + linhas + '</tbody></table></div>' : '<div class="vazio">Nenhuma saída deste tipo no período.</div>') +
      '</div>' +
      '<div class="gp-chart-card"><div class="gp-chart-title">Churn mês a mês — últimos 12 meses</div><div class="gp-chart-wrap"><canvas id="g-churn2"></canvas></div></div>';
    Array.prototype.forEach.call(document.querySelectorAll('#abas-churn button'), function (b) { b.addEventListener('click', function () { estado.abaChurn = b.getAttribute('data-aba'); desenharChurn(); }); });
    var ev = d.churn.evolucao;
    graf('g-churn2', { data: { labels: ev.map(function (m) { return m.mes.slice(5) + '/' + m.mes.slice(2, 4); }), datasets: [
      { type: 'bar', label: 'Saídas que contam', data: ev.map(function (m) { return m.saidas; }), backgroundColor: '#dc262688', yAxisID: 'y' },
      { type: 'line', label: 'Taxa (%)', data: ev.map(function (m) { return m.taxa; }), borderColor: '#256050', backgroundColor: '#256050', tension: .3, yAxisID: 'y1' }] },
      options: Object.assign({}, OPC, { scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: function (v) { return v + '%'; } } } } }) });
  }

  // ── CATEGORIAS ───────────────────────────────────────────────────────────────
  function desenharCategorias() {
    var d = estado.dados, t = d.totais;
    var cats = ['Diamante', 'Ouro', 'Prata', 'Bronze'];
    var sel = estado.catSel;
    var lista = d.clientes.filter(function (c) { return sel === 'sem' ? !c.categoria : (sel ? c.categoria === sel : true); });
    var linhas = lista.slice(0, 300).map(function (c) {
      return '<tr><td style="white-space:normal;min-width:220px">' + nomeLink(c) + '</td><td class="c">' + pillCat(c) + '</td><td class="c" style="font-family:var(--mono)">' + reais(c.honorario) + '</td><td style="white-space:normal;min-width:260px;color:var(--text2);font-size:12px">' + esc(c.categoria_motivo || '') + '</td><td class="c">' + pillRisco(c.risco) + '</td></tr>';
    }).join('');
    $('sec-categorias').innerHTML =
      '<div class="gp-kpi-row">' + cats.map(function (k) { return '<button class="gp-kpi" data-cat="' + k + '" style="text-align:left;cursor:pointer;' + (sel === k ? 'outline:2px solid ' + COR_CAT[k] : '') + '"><div class="gp-kpi-bar" style="background:' + COR_CAT[k] + '"></div><div class="gp-kpi-label">' + ICONE_CAT[k] + ' ' + k + '</div><div class="gp-kpi-value" style="color:' + COR_CAT[k] + '">' + t.categorias[k] + '</div><div class="gp-kpi-sub">' + pct(t.categorias[k], t.clientes) + '% dos clientes</div></button>'; }).join('') +
        '<button class="gp-kpi" data-cat="sem" style="text-align:left;cursor:pointer;' + (sel === 'sem' ? 'outline:2px solid #9ca3af' : '') + '"><div class="gp-kpi-bar" style="background:#9ca3af"></div><div class="gp-kpi-label">Sem categoria</div><div class="gp-kpi-value" style="color:#6b7280">' + t.categorias.sem_categoria + '</div><div class="gp-kpi-sub">sem honorário nem grupo/TAG</div></button></div>' +
      '<div class="nota">Categoria = a maior entre o honorário do cliente, a soma do honorário do grupo de empresas e o piso Ouro das TAGs do Acessórias. O motivo aparece em cada linha. Só CNPJ neste painel.</div>' +
      '<div class="card"><div class="card-title">' + (sel === 'sem' ? 'Clientes sem categoria' : sel ? 'Clientes ' + sel : 'Todos os clientes') + '</div><div class="card-sub">' + lista.length + ' cliente(s)' + (sel ? ' · <button class="link" id="c-limpar">limpar filtro</button>' : ' · clique em uma categoria acima para filtrar') + '</div>' +
        '<div class="table-wrap"><table><thead><tr><th>Cliente</th><th class="c">Categoria</th><th class="c">Honorário</th><th>Motivo da categoria</th><th class="c">Risco</th></tr></thead><tbody>' + linhas + '</tbody></table></div>' +
        (lista.length > 300 ? '<div class="vazio">Mostrando 300 de ' + lista.length + '. Use o filtro por categoria.</div>' : '') + '</div>';
    Array.prototype.forEach.call(document.querySelectorAll('#sec-categorias [data-cat]'), function (b) { b.addEventListener('click', function () { estado.catSel = b.getAttribute('data-cat'); desenharCategorias(); }); });
    var l = $('c-limpar'); if (l) l.addEventListener('click', function () { estado.catSel = ''; desenharCategorias(); });
  }

  // ── QUALIDADE DOS DADOS ──────────────────────────────────────────────────────
  function desenharQualidade() {
    var d = estado.dados, t = d.totais;
    var linha = function (rot, valor, nota) { return '<tr><td>' + rot + '</td><td class="c" style="font-family:var(--mono);font-weight:700">' + valor + '</td><td style="white-space:normal;color:var(--text2);font-size:12px">' + nota + '</td></tr>'; };
    $('sec-qualidade').innerHTML =
      '<div class="card"><div class="card-title">Cobertura de cada indicador</div><div class="card-sub">Quando um indicador não tem dado, ele não entra na média: o painel nunca presume que o cliente está em dia.</div><div class="table-wrap"><table><thead><tr><th>Indicador</th><th class="c">Clientes</th><th>Observação</th></tr></thead><tbody>' +
        linha('Clientes CNPJ ativos', t.clientes, 'Base de todos os indicadores.') +
        linha('Cadastros fora do painel (CPF, CAEPF, CNO, sem documento)', t.desconsiderados_nao_cnpj, 'Não entram em risco, churn nem categorias deste painel.') +
        linha('Financeiro com dado', t.termometros.financeiro.com_dado, t.termometros.financeiro.sem_dado + ' sem dado do Omie.') +
        linha('Atendimento com dado', t.termometros.atendimento.com_dado, 'Sem ocorrência conta como 0 (nenhuma falha registrada).') +
        linha('Operacional com dado', t.termometros.operacional.com_dado, 'Entregas do Acessórias lidas para ' + t.operacional_lido + ' empresas; ' + t.termometros.operacional.sem_dado + ' ainda sem entregas no período.') +
        linha('Sem categoria', t.categorias.sem_categoria, 'Sem honorário cadastrado e sem grupo ou TAG que defina a categoria.') +
      '</tbody></table></div></div>' +
      '<div class="card"><div class="card-title">Fontes</div><div class="card-sub" style="margin-bottom:0;line-height:1.8">Financeiro: Omie (títulos em aberto) · Atendimento: Zappy depois da revisão da Gamificação, insatisfações e pesquisas registradas no Grupo-E · Operacional: entregas do Acessórias · Categorias: honorário do Grupo-E e TAGs do Acessórias · Churn: motivo de cancelamento do Acessórias e situação do CNPJ na Receita. Atualizado em ' + new Date(d.gerado_em).toLocaleString('pt-BR') + '.</div></div>';
  }

  // ── FICHA DO CLIENTE ─────────────────────────────────────────────────────────
  function bloco(t, v, det, cor) { return '<div class="bloco"><div class="t">' + t + '</div><div class="v"' + (cor ? ' style="color:' + cor + '"' : '') + '>' + v + '</div><div class="d">' + det + '</div></div>'; }

  async function abrirFicha(id) {
    $('ficha').style.display = 'flex';
    $('ficha-nome').textContent = 'Carregando…'; $('ficha-sub').textContent = ''; $('ficha-passo').style.display = 'none'; $('ficha-corpo').innerHTML = '';
    try {
      var f = await api('/api/cs/painel/cliente/' + encodeURIComponent(id));
      desenharFicha(f);
    } catch (e) { $('ficha-nome').textContent = 'Não foi possível abrir a ficha'; $('ficha-corpo').innerHTML = '<div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div>'; }
  }

  function desenharFicha(f) {
    var c = f.cliente, r = c.risco, cortes = estado.dados.config.cortes;
    $('ficha-nome').textContent = c.nome;
    $('ficha-sub').innerHTML = esc(c.cnpj) + (c.grupo ? ' · Grupo ' + esc(c.grupo) : '') + (c.unidade ? ' · ' + esc(c.unidade) : '') + ' · cliente desde ' + data(c.entrada);
    var passo = $('ficha-passo'); passo.style.display = 'block'; passo.innerHTML = '<strong>Próximo passo:</strong> ' + esc(f.proximo_passo);

    var termBloco = function (k) {
      var p = r.termometros[k];
      var det = (r.detalhes && r.detalhes[k] && r.detalhes[k][0]) || '';
      if (p == null) return bloco(NOME_TERM[k], 'Sem dado', esc(det || 'sem informação desta fonte'), null);
      var n = nivelTerm(p, cortes);
      return bloco(NOME_TERM[k], n + ' · ' + p, esc(det), COR_RISCO[n]);
    };
    var blocos1 = '<div class="blocos">' + bloco('Risco de perda', r.nivel + (r.pontos != null ? ' · ' + r.pontos : '') + (r.alerta ? ' ⚠️' : ''), r.alerta ? '<span style="color:#dc2626">termômetro muito alto: alerta</span>' : 'média dos termômetros com dado', COR_RISCO[r.nivel]) + '</div>' +
      '<div class="blocos">' + termBloco('financeiro') + termBloco('atendimento') + termBloco('operacional') + '</div>';
    var blocos2 = '<div class="blocos" style="margin-bottom:6px">' +
      bloco('Categoria', c.categoria ? ICONE_CAT[c.categoria] + ' ' + esc(c.categoria) : 'Sem categoria', esc(c.categoria_motivo || ''), c.categoria ? COR_CAT[c.categoria] : null) +
      bloco('Honorário', reais(c.honorario), c.grupo ? 'soma do grupo entra na categoria' : 'mensal') + '</div>';

    // Financeiro
    var fin = f.financeiro.length ? f.financeiro.map(function (x) {
      return '<div class="linha-item"><span class="q"><span class="quad" style="background:' + (x.qtd_atrasados ? '#dc2626' : '#10b981') + '"></span></span><span class="r">' + esc(x.unidade) + '</span><span class="x">' +
        (x.qtd_atrasados ? x.qtd_atrasados + ' título(s) em atraso · ' + reais(x.valor_atrasado) + ' · o mais antigo vence em ' + data(x.mais_antigo) : 'em dia') + (x.qtd ? ' · ' + x.qtd + ' em aberto no total (' + reais(x.valor_aberto) + ')' : '') + '</span></div>';
    }).join('') : '<div class="linha-item"><span class="x">Sem título em aberto no Omie' + (r.termometros.financeiro == null ? ' (e sem dado do Financeiro para este CNPJ)' : '') + '.</span></div>';

    // Atendimento
    var notasBaixas = f.tickets.filter(function (t) { return t.nota_avaliacao != null && t.nota_avaliacao <= 2; }).length;
    var vermelhos = f.tickets.filter(function (t) { return t.pior_status === 'vermelho'; }).length;
    var resumoAt = '<div class="blocos">' + bloco('Atendimentos (90 dias)', f.tickets.length, 'conversas no Zappy', null) + bloco('SLA vermelho', vermelhos, 'antes da revisão da Gamificação', vermelhos ? '#dc2626' : null) + bloco('Notas baixas', notasBaixas, 'nota 1 ou 2', notasBaixas ? '#dc2626' : null) + bloco('Abandonos', f.abandonos.length, 'cliente ficou sem resposta (já revisados)', f.abandonos.length ? '#dc2626' : null) + '</div>';
    var tick = f.tickets.length ? '<div class="table-wrap"><table><thead><tr><th>Data</th><th>Setor</th><th>Atendente</th><th class="c">Nota</th><th class="c">SLA</th></tr></thead><tbody>' + f.tickets.slice(0, 10).map(function (t) {
      var cor = { vermelho: '#dc2626', amarelo: '#d97706', verde: '#10b981' }[t.pior_status] || '#9ca3af';
      return '<tr><td>' + data(t.abertura) + '</td><td>' + esc(t.departamento || '—') + '</td><td>' + esc(t.analista || '—') + '</td><td class="c">' + (t.nota_avaliacao != null ? t.nota_avaliacao : '—') + '</td><td class="c"><span class="pill" style="color:' + cor + ';border-color:' + cor + '55;background:' + cor + '14">' + esc(t.pior_status || '—') + '</span></td></tr>';
    }).join('') + '</tbody></table></div>' : '';
    var insat = f.insatisfacoes.length ? f.insatisfacoes.map(function (i) {
      return '<div class="linha-item"><span class="q">⚠️</span><span class="r">' + data(i.created_at) + ' · ' + esc(i.gravidade) + '</span><span class="x">' + esc(i.reclamacao) + (i.reclamado ? ' <span class="cinza">(reclamado: ' + esc(i.reclamado) + ')</span>' : '') + ' <span class="cinza">— registrado por ' + esc(i.analista) + '</span></span></div>';
    }).join('') : '<div class="linha-item"><span class="x">Nenhuma insatisfação registrada nos últimos 180 dias.</span></div>';
    var sens = f.sensiveis.length ? f.sensiveis.map(function (i) {
      return '<div class="linha-item"><span class="q">🌡️</span><span class="r">' + data(i.created_at) + ' · ' + esc(i.gravidade) + '</span><span class="x">' + esc(i.demonstrou) + ' <span class="cinza">— ' + esc(i.analista) + '</span></span></div>';
    }).join('') : '';
    var pesq = f.pesquisas.length ? f.pesquisas.map(function (p) {
      return '<div class="linha-item"><span class="q">📋</span><span class="r">' + data(p.created_at) + '</span><span class="x">NPS ' + p.nps + ' · CSAT ' + p.csat + ' · CES ' + p.ces + (p.pontos ? ' · ' + esc(p.pontos) : '') + '</span></div>';
    }).join('') : '';

    // Operacional
    var e = f.entregas;
    var oper = e && e.total ? '<div class="blocos">' + bloco('Entregas (90 dias)', e.total, 'lidas do Acessórias em ' + data(e.atualizado_em), null) + bloco('Entregues com atraso', e.atrasadas_entregues, 'status "Ent. atrasada"', e.atrasadas_entregues ? '#dc2626' : null) + bloco('Vencidas sem entrega', e.vencidas_pendentes, 'status "Atrasada!" ou pendente vencida', e.vencidas_pendentes ? '#dc2626' : null) + '</div>'
      : '<div class="linha-item"><span class="x">Sem entregas lidas do Acessórias para este cliente no período' + (e ? ' (última leitura em ' + data(e.atualizado_em) + ')' : ' (ainda não lido)') + '.</span></div>';

    var sinais = (r.motivos || []).map(function (m) { return '<span class="chip" style="color:#dc2626;border-color:#dc262655">' + esc(m) + '</span>'; }).join('') || '<span class="cinza">nenhum sinal de atenção</span>';

    $('ficha-corpo').innerHTML = blocos1 + blocos2 +
      '<div class="ficha-sec">Sinais de atenção</div><div>' + sinais + '</div>' +
      '<div class="ficha-sec">Financeiro</div>' + fin +
      '<div class="ficha-sec">Atendimento (Zappy, 90 dias)</div>' + resumoAt + tick +
      '<div class="ficha-sec">Insatisfações registradas (180 dias)</div>' + insat + sens + (pesq ? '<div class="ficha-sec">Pesquisas de satisfação</div>' + pesq : '') +
      '<div class="ficha-sec">Operacional (entregas do Acessórias)</div>' + oper;
  }

  function fecharFicha() { $('ficha').style.display = 'none'; }

  // ── eventos ──────────────────────────────────────────────────────────────────
  document.addEventListener('click', function (ev) {
    var f = ev.target.closest && ev.target.closest('[data-ficha]');
    if (f) { abrirFicha(f.getAttribute('data-ficha')); return; }
    var n = ev.target.closest && ev.target.closest('.risco-bloco');
    if (n) { estado.filtroRisco.nivel = n.getAttribute('data-nivel'); estado.filtroRisco.todos = false; desenharRisco(); irPara('risco'); }
  });
  $('login-form').addEventListener('submit', entrar);
  $('btn-sair').addEventListener('click', function () { sair(false); });
  $('ficha-fechar').addEventListener('click', fecharFicha);
  $('ficha').addEventListener('click', function (ev) { if (ev.target === $('ficha')) fecharFicha(); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') fecharFicha(); });
  Array.prototype.forEach.call(document.querySelectorAll('.gp-nav-item'), function (b) { b.addEventListener('click', function () { irPara(b.getAttribute('data-sec')); }); });

  $('sel-periodo').addEventListener('change', function () {
    estado.periodoChave = this.value;
    $('datas-livres').style.display = this.value === 'livre' ? 'flex' : 'none';
    if (this.value !== 'livre' && estado.dados) { desenharTudo(); }
  });
  $('btn-aplicar').addEventListener('click', async function () {
    var ini = $('dt-ini').value, fim = $('dt-fim').value;
    if (!ini || !fim || ini > fim) { alert('Informe as duas datas, com a primeira antes da segunda.'); return; }
    try { estado.churnLivre = await api('/api/cs/painel/churn?ini=' + ini + '&fim=' + fim); desenharTudo(); }
    catch (e) { alert(e.message); }
  });

  $('login-versao').textContent = VERSAO; $('app-versao').textContent = VERSAO;
  if (ls(K_TOKEN)) iniciar(); else mostrarLogin('');
})();
