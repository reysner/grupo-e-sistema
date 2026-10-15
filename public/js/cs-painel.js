/* Painel do Sucesso do Cliente (/cs). Só leitura: toda checagem de acesso é feita pelo servidor (/api/cs/painel). */
(function () {
  'use strict';

  var VERSAO = 'V.1.0 · 07/10/2026';
  var K_TOKEN = 'cs_token', K_REFRESH = 'cs_refresh', K_USER = 'cs_user';

  var COR_RISCO = { 'Alto': '#dc2626', 'Médio': '#d97706', 'Baixo': '#10b981', 'Incompleto': '#9ca3af', 'Suspenso': '#6b21a8' };
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
    analise: ['Análise Inteligente', 'Regime tributário, faturamento, honorários e funcionários de cada cliente; grupos de empresas e matriz com filiais somados, com a lupa para ver cada empresa, para uma análise completa.'],
    anual: ['Análise Anual', 'Faturamento ano a ano de cada cliente ativo no Acessórias, para avaliar se o honorário precisa de ajuste. Clique na empresa para ver a evolução.'],
    visao: ['Visão Geral', 'Clientes ativos, saídas por transferência e risco de perda — só CNPJ. Material da reunião semanal das lideranças.'],
    risco: ['Gestão da Permanência', 'Quem está em risco de sair e por quê: Financeiro, Atendimento e Operacional. Clique no nome da empresa para ver a ficha.'],
    churn: ['Churn', 'Saídas do período ÷ base ativa no início do período. Só contam as três "Transferida por…" do Acessórias.'],
    categorias: ['Categorias', 'Diamante, Ouro, Prata e Bronze pelo honorário, somando grupos de empresas. O motivo de cada categoria aparece sempre.'],
    qualidade: ['Qualidade dos Dados', 'De onde vem cada indicador e o que ainda está sem dado.'],
  };

  var estado = { dados: null, periodoChave: 'ultimos_12_meses', churnLivre: null, secao: 'visao', graficos: {}, filtroRisco: { busca: '', nivel: 'AltoMedio', cat: '', term: '', soAtend: false, todos: false }, abaChurn: 'transferida', catSel: '', filtroAnalise: { busca: '', soGrupos: false, tipo: '', pag: 1 }, abertosAnalise: {} };

  // ── utilidades ───────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function data(s) { return s ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) + '/' + String(s).slice(0, 4) : '—'; }
  // Valores em R$: o perfil "Usuário" recebe tudo oculto do servidor (dados.valores_ocultos); o administrador pode ocultar na tela (botão "Valores ocultos").
  function valoresOcultos() { return !!(estado.ocultar || (estado.dados && estado.dados.valores_ocultos)); }
  function reais(v) {
    if (valoresOcultos()) return '<span class="oculto" title="Valor oculto">R$ ••••</span>';
    return v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  function motivoTxt(m) { return valoresOcultos() ? String(m || '').replace(/(honorário |empresas: )R\$ [\d.]+,\d{2}/g, '$1R$ ••••') : (m || ''); }
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

  // chamada genérica (PATCH etc.) com o token da página e renovação da sessão; usada pelo menu do usuário
  async function chamarApi(caminho, opcoes, tentou) {
    var o = Object.assign({}, opcoes || {});
    o.headers = Object.assign({}, o.headers || {}, { Authorization: 'Bearer ' + (ls(K_TOKEN) || '') });
    var r = await fetch(caminho, o);
    if (r.status === 401 && !tentou && await renovar()) return chamarApi(caminho, opcoes, true);
    return r;
  }
  function montarMenuUsuario(u) {
    if (!window.MenuUsuario || !$('menu-usuario')) return;
    window.MenuUsuario.montar({
      alvo: $('menu-usuario'), usuario: u, chamar: chamarApi,
      rotulos: { colaborador: 'Colaborador' },
      aoSair: function () { sair(false); },
      aoAtualizar: function (novo) { var atual = {}; try { atual = JSON.parse(ls(K_USER) || '{}') || {}; } catch (e) { atual = {}; } ls(K_USER, JSON.stringify(Object.assign(atual, { name: novo.name, email: novo.email }))); }
    });
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
      if (['administrador', 'usuario'].indexOf(j.user.role) < 0 && !j.user.acesso_cs) { mostrarLogin('Este painel é da equipe do Sucesso do Cliente. Peça acesso à administração.'); return; }
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
  async function iniciar(forcar) {
    $('login-screen').style.display = 'none';
    $('app').style.display = 'block';
    var u = null; try { u = JSON.parse(ls(K_USER) || 'null'); } catch (e) { u = null; }
    if (u && u.name) montarMenuUsuario(u);
    ['visao', 'analise', 'anual', 'risco', 'churn', 'categorias', 'qualidade'].forEach(function (s) { $('sec-' + s).innerHTML = '<div class="vazio">Carregando…</div>'; });
    try {
      estado.dados = await api('/api/cs/painel/dados' + (forcar === true ? '?forcar=1' : ''));
      try { estado.honorario = await api('/api/cs/painel/honorario-sugerido'); } catch (e) { estado.honorario = null; }
      try { estado.anual = await api('/api/cs/painel/anual'); } catch (e) { estado.anual = null; }   // a Análise Anual avisa quando não chega   // sem o percentual, as colunas novas mostram "—"
      pintarBotaoValores();
      estado.churnLivre = null;
      desenharTudo();
    } catch (e) {
      ['visao', 'analise', 'anual', 'risco', 'churn', 'categorias', 'qualidade'].forEach(function (s) { $('sec-' + s).innerHTML = '<div class="card"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; });
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
    desenharVisao(); desenharAnalise(); desenharAnual(); desenharRisco(); desenharChurn(); desenharCategorias(); desenharQualidade();
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
    ['btn-csv', 'btn-pdf'].forEach(function (id) { var b = $(id); if (b) b.style.display = SEC_EXPORTA[sec] ? 'inline-flex' : 'none'; });
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
  // Selo das empresas com contrato "Suspenso" no Omie (some quando o contrato é reativado lá).
  function seloSuspenso(r) {
    return r && r.suspenso ? ' <span class="pill" title="Contrato suspenso no Omie. As entregas não entram no Operacional." style="color:#6b21a8;border-color:#6b21a855;background:#6b21a814">⏸ Suspenso</span>' : '';
  }
  function nomeLink(c) {
    return '<button class="link" data-ficha="' + esc(c.id) + '">' + esc(c.nome) + '</button>' + seloSuspenso(c.risco) + '<div class="sub">' + esc(c.cnpj || '') + '</div>';
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
    if (t.suspensos) pontos.push('<strong>' + t.suspensos + ' cliente(s) com contrato suspenso no Omie</strong>' + (t.suspensos_lidos_em ? ' (lista lida em ' + data(t.suspensos_lidos_em) + ', atualizada toda segunda)' : '') + ': a ação é de cobrança e as entregas deles não entram no Operacional. Filtre pelo selo ⏸ Suspenso na Gestão da Permanência.');
    if (p.fora_do_churn && p.fora_do_churn.a_confirmar) pontos.push(p.fora_do_churn.a_confirmar + ' saída(s) ainda <strong>a confirmar</strong> (sem motivo lido do Acessórias): o churn real fica entre ' + p.taxa + '% e ' + p.taxa_teto + '%.');
    if (p.presumidas) pontos.push('<strong>' + p.presumidas + ' saída(s) presumida(s) como transferência</strong> (sem motivo no Acessórias e sem resposta da Receita): contam no churn. Na aba Churn o administrador pode trocar para baixa.');
    pontos.push('<strong>' + pct(t.sem_reclamacao_30d, t.clientes) + '%</strong> dos clientes ficaram sem nenhuma reclamação nos últimos 30 dias (insatisfação registrada, nota baixa ou abandono).');

    $('sec-visao').innerHTML =
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
      '<div class="gp-bullets"><div class="gp-bullets-title">Pontos para a reunião</div>' + pontos.map(function (x) { return '<div class="gp-bullet"><span>•</span><span>' + x + '</span></div>'; }).join('') + '</div>' +
      '<div class="nota"><strong>Clientes</strong> = empresas com CNPJ ativas na carteira. Risco, churn e categorias consideram só CNPJ: CPF, CAEPF e CNO (' + t.desconsiderados_nao_cnpj + ' cadastros) ficam de fora desses indicadores e só aparecem na Análise Inteligente.</div>';

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
    }).sort(function (x, y) { return (x.nome || '').localeCompare(y.nome || '', 'pt-BR', { sensitivity: 'base' }); });   // ordem alfabética
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
        '<div><strong style="color:' + COR_TERM.operacional + '">Operacional</strong><br>Proporção das entregas do Acessórias (últimos 90 dias) que chegam ao cliente e foram entregues com atraso ou venceram sem entrega: guias e declarações com multa, folha, FGTS, DCTFWeb, INSS e envios ao cliente. Tarefas internas (balancete, renovação de certificado, aniversário de sócio, cadastros) não contam. Entrega dentro do prazo técnico ou do prazo legal não é atraso. Só conta com <strong>5 entregas ou mais</strong> no período (com menos, a taxa não é confiável: fica sem dado). Empresa com contrato <strong>Suspenso no Omie</strong> (selo ⏸) também fica fora do Operacional: o atraso dela já pesa no Financeiro.</div>' +
      '</div></details>' +
      '<div class="card"><div class="filter-group" style="margin-bottom:14px">' +
        '<span class="filter-label">Buscar</span><input class="gp-input" id="r-busca" placeholder="Nome ou CNPJ" value="' + esc(f.busca) + '">' +
        '<span class="filter-label">Risco</span><select class="gp-select" id="r-nivel">' + opt('AltoMedio', 'Alto e Médio', f.nivel === 'AltoMedio') + opt('Alto', 'Só Alto', f.nivel === 'Alto') + opt('Médio', 'Só Médio', f.nivel === 'Médio') + opt('Baixo', 'Baixo', f.nivel === 'Baixo') + opt('Suspenso', 'Suspensos (fora do risco)', f.nivel === 'Suspenso') + opt('todos', 'Todos', f.nivel === 'todos') + '</select>' +
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
    $('r-lista').innerHTML = '<div class="card-sub">' + r.n + ' cliente(s) · ordem alfabética</div>' + r.html;
    var b = $('r-todos'); if (b) b.addEventListener('click', function () { estado.filtroRisco.todos = true; pintarListaRisco(); });
  }

  // ── CHURN ────────────────────────────────────────────────────────────────────
  async function decidirSaida(id, tipo, nome, saida) {
    var rotulo = tipo === 'transferida' ? 'CONTA como churn (transferida)' : 'é BAIXA e não conta como churn';
    var mes = saida ? saida.slice(5, 7) + '/' + saida.slice(0, 4) : '';
    if (!window.confirm(nome + '\n\nSaída em ' + data(saida) + '. Esta saída ' + rotulo + (tipo === 'transferida' ? ' no mês da saída (' + mes + ')' : '') + '.\n\nConfirmar?')) return;
    var url = '/api/cs/churn/saidas/' + encodeURIComponent(id) + '/classificacao';
    var enviar = function () { return fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (ls(K_TOKEN) || '') }, body: JSON.stringify({ tipo: tipo }) }); };
    try {
      var r = await enviar();
      if (r.status === 401 && await renovar()) r = await enviar();
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) { window.alert(j.error || 'Não foi possível salvar a decisão.'); return; }
      iniciar(true);
    } catch (e) { window.alert('Sem conexão com o servidor. Tente de novo.'); }
  }

  function desenharChurn() {
    var d = estado.dados, p = periodoAtual();
    var abas = [['transferida', 'Transferidas (contam)'], ['a_confirmar', 'A confirmar'], ['baixa', 'Baixas'], ['outra_saida', 'Outras saídas']];
    var cont = function (tp) { return p.saidas.filter(function (s) { return s.tipo === tp; }).length; };
    abas = abas.filter(function (a) { return a[0] !== 'a_confirmar' || cont('a_confirmar') > 0; });
    var ROT_ORIGEM = { acessorias: 'Acessórias', sistema: 'sistema', receita: 'Receita (CNPJ)', manual: 'definida pelo administrador', presumida: 'presumida (sem motivo no Acessórias)' };
    var lista = p.saidas.filter(function (s) { return s.tipo === estado.abaChurn; });
    // Saída "a confirmar" (sem motivo no Acessórias e sem resposta da Receita): o administrador decide se conta como churn. Vale no mês da saída.
    var decide = !!(d.usuario && d.usuario.papel === 'administrador') && lista.some(function (s) { return s.origem === 'presumida'; });
    var linhas = lista.map(function (s) {
      var t = TIPO_SAIDA[s.tipo];
      return '<tr><td style="white-space:normal">' + esc(s.nome) + '<div class="sub">' + esc(s.cnpj || '') + '</div></td><td class="c">' + data(s.data_entrada) + '</td><td class="c">' + data(s.data_saida) + '</td>' +
        '<td class="c"><span class="pill" style="color:' + t.cor + ';border-color:' + t.cor + '55;background:' + t.cor + '14">' + t.rot + '</span></td>' +
        '<td class="c">' + (s.na_base ? 'Sim' : '<span class="cinza">entrou no período</span>') + '</td><td class="c"><span class="cinza">' + esc(ROT_ORIGEM[s.origem] || s.origem || '—') + '</span></td>' +
        (decide ? '<td class="c" style="white-space:nowrap">' + (s.origem !== 'presumida' ? '' : '<button class="gp-footer-btn" style="width:auto;padding:4px 8px;display:inline-flex" data-decide="transferida" data-id="' + esc(s.id) + '" data-nome="' + esc(s.nome) + '" data-saida="' + esc(s.data_saida) + '" title="Confirma a transferência (conta como churn no mês da saída)">Confirmar transferência</button> <button class="gp-footer-btn" style="width:auto;padding:4px 8px;display:inline-flex" data-decide="baixa" data-id="' + esc(s.id) + '" data-nome="' + esc(s.nome) + '" data-saida="' + esc(s.data_saida) + '" title="É baixa: não conta como churn">É baixa</button>') + '</td>' : '') + '</tr>';
    }).join('');
    $('sec-churn').innerHTML =
      '<div class="gp-kpi-row">' +
        kpi('#256050', 'Base no início do período', p.base, 'clientes CNPJ ativos em ' + data(p.ini)) +
        kpi('#dc2626', 'Saídas que contam', p.saidas_contadas, 'Transferida por conveniência, mau atendimento ou preço') +
        kpi('#d97706', 'Taxa de churn', p.taxa == null ? '—' : p.taxa + '%', p.fora_do_churn.a_confirmar ? 'teto de ' + p.taxa_teto + '% com as a confirmar' : 'saídas que contam ÷ base') +
        kpi('#7c3aed', 'Saíram em até 90 dias', p.menos_de_90_dias, 'de casa, todos os tipos') +
        kpi('#6b7280', 'Fora do churn', p.fora_do_churn.baixas + p.fora_do_churn.outras_saidas, 'baixas e outras saídas') +
      '</div>' +
      '<div class="nota">Período de <strong>' + data(p.ini) + '</strong> a <strong>' + data(p.fim) + '</strong>. Contam como churn as saídas cujo motivo no Acessórias começa com: <strong>' + d.churn.padroes.map(esc).join('</strong>, <strong>') + '</strong>. Baixas não contam. Quando o Acessórias não informa o motivo, a situação do CNPJ na Receita ajuda a separar baixa de transferência; o que não for possível é presumido como transferência (marcado "presumida"; o administrador pode trocar para baixa). Só CNPJ.</div>' +
      '<div class="card"><div class="card-title">Saídas do período</div><div class="card-sub">Clique na aba para ver cada tipo de saída.</div>' +
        '<div class="tabs" id="abas-churn">' + abas.map(function (a) { return '<button data-aba="' + a[0] + '" class="' + (estado.abaChurn === a[0] ? 'active' : '') + '">' + a[1] + ' (' + cont(a[0]) + ')</button>'; }).join('') + '</div>' +
        (lista.length ? '<div class="table-wrap"><table><thead><tr><th>Cliente</th><th class="c">Entrada</th><th class="c">Saída</th><th class="c">Tipo</th><th class="c">Na base do início</th><th class="c">Como foi classificada</th>' + (decide ? '<th class="c">Decisão</th>' : '') + '</tr></thead><tbody>' + linhas + '</tbody></table></div>' : '<div class="vazio">Nenhuma saída deste tipo no período.</div>') +
      '</div>' +
      '<div class="gp-chart-card"><div class="gp-chart-title">Churn mês a mês — últimos 12 meses</div><div class="gp-chart-wrap"><canvas id="g-churn2"></canvas></div></div>';
    Array.prototype.forEach.call(document.querySelectorAll('#sec-churn [data-decide]'), function (b) {
      b.addEventListener('click', function () { decidirSaida(b.getAttribute('data-id'), b.getAttribute('data-decide'), b.getAttribute('data-nome'), b.getAttribute('data-saida')); });
    });
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
      return '<tr><td style="white-space:normal;min-width:220px">' + nomeLink(c) + '</td><td class="c">' + pillCat(c) + '</td><td class="c" style="font-family:var(--mono)">' + reais(c.honorario) + '</td><td style="white-space:normal;min-width:260px;color:var(--text2);font-size:12px">' + esc(motivoTxt(c.categoria_motivo)) + '</td><td class="c">' + pillRisco(c.risco) + '</td></tr>';
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

  // ── ANÁLISE INTELIGENTE ──────────────────────────────────────────────────────
  // Grupo de empresas (Gestão de Clientes) e matriz + filiais (mesma raiz de CNPJ) viram UMA linha consolidada
  // (funcionários, honorários e faturamento somados); a lupa abre as empresas do grupo logo abaixo, cada uma com os seus números.
  function somar(itens, f) { var n = 0, algum = false; itens.forEach(function (c) { var v = f(c); if (v != null) { n += Number(v); algum = true; } }); return algum ? n : null; }
  function montarEntidades(clientes) {
    var porGrupo = {}, ordem = [], restantes = [];
    clientes.forEach(function (c) {
      var g = String(c.grupo || '').trim();
      if (g) { var k = 'g:' + g.toLowerCase(); if (!porGrupo[k]) { porGrupo[k] = { chave: k, tipo: 'grupo', nome: g, itens: [] }; ordem.push(k); } porGrupo[k].itens.push(c); }
      else restantes.push(c);
    });
    var porRaiz = {};
    restantes.forEach(function (c) {
      var d = String(c.cnpj || '').replace(/\D/g, ''); var r = c.tipo_doc === 'CNPJ' && d.length === 14 ? d.slice(0, 8) : c.id;
      var k = 'r:' + r; if (!porRaiz[k]) { porRaiz[k] = { chave: k, tipo: 'filiais', nome: c.nome, itens: [] }; ordem.push(k); } porRaiz[k].itens.push(c);
    });
    var todos = {}; Object.keys(porGrupo).forEach(function (k) { todos[k] = porGrupo[k]; }); Object.keys(porRaiz).forEach(function (k) { todos[k] = porRaiz[k]; });
    return ordem.map(function (k) {
      var e = todos[k]; var it = e.itens;
      // matriz (ordem 0001) primeiro; o nome da linha de matriz+filiais é o da matriz
      it.sort(function (a, b) { return String(a.cnpj).indexOf('/0001-') >= 0 ? -1 : String(b.cnpj).indexOf('/0001-') >= 0 ? 1 : a.nome.localeCompare(b.nome); });
      if (e.tipo === 'filiais') e.nome = it[0].nome;
      e.unico = it.length === 1;
      e.funcionarios = somar(it, function (c) { return c.questor ? (c.questor.funcionarios == null ? 0 : c.questor.funcionarios) : null; });
      e.honorario = somar(it, function (c) { return c.honorario; });
      e.faturamento = somar(it, function (c) { return c.questor ? c.questor.faturamento : null; });
      return e;
    });
  }
  // Faturamento de 12 meses: zero aparece como "sem faturamento" (não como R$ 0,00); empresa fora do Questor = "sem dado".
  // Perfil Usuário e "Ocultar valores" sempre veem a máscara (não revela nem se é zero). ⚠ = o Questor avisou que falta configurar o faturamento (passe o mouse).
  function celFat(q) {
    if (!q) return '<span class="cinza">sem dado</span>';
    if (valoresOcultos()) return reais(null) + avisoFat(q);
    if (q.faturamento == null) return '<span class="cinza">sem dado</span>' + avisoFat(q);
    if (q.faturamento === 0) return '<span class="cinza">sem faturamento</span>' + avisoFat(q);
    return reais(q.faturamento) + avisoFat(q);
  }
  function celFatTotal(v) {
    if (valoresOcultos()) return reais(null);
    if (v == null) return '<span class="cinza">sem dado</span>';
    return v === 0 ? '<span class="cinza">sem faturamento</span>' : reais(v);
  }
  // ⚠ quando o Questor avisou que há natureza com movimentação sem configuração de faturamento (o valor pode estar incompleto).
  function avisoFat(q) { return q && q.aviso ? ' <span class="aviso-fat" title="' + esc(q.aviso) + '" tabindex="0" aria-label="' + esc(q.aviso) + '">⚠</span>' : ''; }
  function celNum(v) { return v == null ? '<span class="cinza">—</span>' : v === 0 ? '0' : String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  // Só CNPJ tem risco/ficha; CPF, CAEPF e CNO (só na Análise Inteligente) mostram o nome simples e o tipo do documento.
  function nomeAnalise(c) {
    if (c.risco) return nomeLink(c);
    return esc(c.nome) + ' <span class="pill" style="color:#6b7280;border-color:#6b728055;background:#6b728014" title="Documento do tipo ' + esc(c.tipo_doc) + ' (fora do risco, que considera só CNPJ)">' + esc(c.tipo_doc) + '</span><div class="sub">' + esc(c.cnpj || '') + '</div>';
  }
  // ── HONORÁRIO SUGERIDO (pedido do Reysner, 15/10/2026) ─────────────────────────
  // sugerido (mensal) = percentual × faturamento médio mensal (faturamento de 12 meses ÷ 12). O percentual é um só para a equipe
  // (guardado no servidor; só o administrador altera). Análise: ✔ cobrado ≥ sugerido · ▲ de L% a 100% do sugerido · ✖ abaixo de L%.
  function cfgHon() { return estado.honorario || { percentual: null, limite_amarelo: 80, pode_editar: false }; }
  function honSugerido(fat) {
    var p = cfgHon().percentual;
    if (p == null || fat == null || !(fat > 0)) return null;
    return Math.round(fat / 12 * p) / 100;
  }
  function honAnalise(cobrado, sug) {
    if (sug == null || cobrado == null) return null;
    var r = cobrado / sug, lim = cfgHon().limite_amarelo / 100;
    return r >= 1 ? 'ok' : (r >= lim ? 'medio' : 'baixo');
  }
  var ICO_HON = { ok: ['✔', 'an-ok', 'No valor sugerido ou acima'], medio: ['▲', 'an-medio', 'Tomando distância do valor sugerido'], baixo: ['✖', 'an-baixo', 'Muito abaixo do valor sugerido'] };
  function moedaTxt(v) { return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function pctTxt(n) { return String(Math.round(n * 10) / 10).replace('.', ','); }
  function dicaHon(cobrado, sug) {
    if (cobrado == null) return 'Sem honorário cobrado cadastrado. Sugerido: ' + moedaTxt(sug) + ' por mês.';
    var dif = cobrado - sug;
    return 'Cobrado ' + moedaTxt(cobrado) + ' · sugerido ' + moedaTxt(sug) + ' · diferença ' + (dif >= 0 ? '+' : '−') + moedaTxt(Math.abs(dif)) +
      ' (cobra ' + pctTxt(100 * cobrado / sug) + '% do sugerido)';
  }
  function celSugerido(fat, cobrado) {
    if (valoresOcultos()) return reais(null);
    var s = honSugerido(fat);
    if (s == null) return '<span class="cinza">—</span>';
    var d = dicaHon(cobrado, s);
    return '<span class="hon-sug" tabindex="0" title="' + esc(d) + '" aria-label="' + esc(d) + '">' + reais(s) + '</span>';
  }
  function celAnalise(fat, cobrado) {
    if (valoresOcultos()) return '<span class="cinza">—</span>';
    var s = honSugerido(fat), n = honAnalise(cobrado, s);
    if (!n) return '<span class="cinza">—</span>';
    var i = ICO_HON[n], d = i[2] + '. ' + dicaHon(cobrado, s);
    return '<span class="an-ico ' + i[1] + '" role="img" tabindex="0" title="' + esc(d) + '" aria-label="' + esc(d) + '">' + i[0] + '</span>';
  }
  function botaoPct(id) {
    id = id || 'btn-pct';
    var c = cfgHon(), rot = c.percentual == null ? '%' : pctTxt(c.percentual) + '%';
    var dica = 'Honorário sugerido = percentual × faturamento médio mensal (12 meses ÷ 12)' + (c.pode_editar ? '. Clique para alterar o percentual.' : '.');
    return c.pode_editar
      ? '<button type="button" class="mini-pct" id="' + id + '" title="' + esc(dica) + '" aria-haspopup="dialog">' + esc(rot) + '</button>'
      : '<span class="mini-pct fixo" title="' + esc(dica) + '">' + esc(rot) + '</span>';
  }
  function legendaHon() {
    if (valoresOcultos()) return '';
    var c = cfgHon();
    if (c.percentual == null) return ' · <span class="cinza">Defina o percentual no botão % da coluna Honorário sugerido para ver a análise.</span>';
    return ' · Sugerido = ' + pctTxt(c.percentual) + '% do faturamento médio mensal (12 meses ÷ 12). <span class="an-ok">✔</span> cobrado no sugerido ou acima · ' +
      '<span class="an-medio">▲</span> de ' + pctTxt(c.limite_amarelo) + '% a 100% do sugerido · <span class="an-baixo">✖</span> abaixo de ' + pctTxt(c.limite_amarelo) + '%';
  }
  function fecharPopPct() { var p = $('pop-pct'); if (p && p.parentNode) p.parentNode.removeChild(p); }
  function abrirPopPct(btn) {
    fecharPopPct();
    var c = cfgHon(), r = btn.getBoundingClientRect(), p = document.createElement('div');
    p.id = 'pop-pct'; p.className = 'pop-pct'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Percentual do honorário sugerido');
    p.innerHTML = '<label for="pct-valor">Percentual sobre o faturamento médio mensal</label>' +
      '<div class="pop-linha"><input id="pct-valor" type="text" inputmode="decimal" value="' + esc(c.percentual == null ? '' : String(c.percentual).replace('.', ',')) + '" placeholder="Ex.: 0,5"><span>%</span></div>' +
      '<label for="pct-limite">Amarelo a partir de (% do sugerido)</label>' +
      '<div class="pop-linha"><input id="pct-limite" type="text" inputmode="decimal" value="' + esc(String(c.limite_amarelo).replace('.', ',')) + '"><span>%</span></div>' +
      '<div class="pop-dica">Abaixo desse limite o símbolo fica vermelho.</div><div class="pop-erro" id="pct-erro" role="alert"></div>' +
      '<div class="pop-acoes"><button type="button" class="gp-footer-btn" id="pct-cancelar" style="width:auto">Cancelar</button>' +
      '<button type="button" class="login-btn" id="pct-salvar" style="width:auto;margin:0;padding:8px 16px">Salvar</button></div>';
    document.body.appendChild(p);
    p.style.top = Math.round(r.bottom + 6) + 'px';
    p.style.left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - 300)) + 'px';
    $('pct-valor').focus();
    $('pct-cancelar').addEventListener('click', fecharPopPct);
    var salvar = async function () {
      var v = $('pct-valor').value.trim().replace(',', '.'), l = $('pct-limite').value.trim().replace(',', '.'), erro = $('pct-erro');
      erro.textContent = '';
      var corpo = { percentual: v === '' ? null : parseFloat(v), limite_amarelo: parseFloat(l) };
      if (v !== '' && !(corpo.percentual > 0 && corpo.percentual <= 100)) { erro.textContent = 'Informe um percentual maior que 0 e até 100.'; return; }
      if (!(corpo.limite_amarelo >= 1 && corpo.limite_amarelo <= 99)) { erro.textContent = 'O limite do amarelo fica entre 1 e 99%.'; return; }
      $('pct-salvar').disabled = true;
      try {
        var resp = await chamarApi('/api/cs/painel/honorario-sugerido', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
        var j = await resp.json().catch(function () { return {}; });
        if (!resp.ok) { erro.textContent = j.error || 'Não foi possível salvar.'; $('pct-salvar').disabled = false; return; }
        estado.honorario = Object.assign({}, j, { pode_editar: true });
        fecharPopPct();
        desenharAnalise();
        if (estado.fichaGrupoAberta && $('ficha').style.display === 'flex') abrirFichaGrupo(estado.fichaGrupoAberta);   // a ficha do grupo aberta acompanha o novo percentual
      } catch (e) { erro.textContent = 'Sem conexão com o servidor. Tente de novo.'; $('pct-salvar').disabled = false; }
    };
    $('pct-salvar').addEventListener('click', salvar);
    p.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') salvar(); if (ev.key === 'Escape') fecharPopPct(); });
  }
  document.addEventListener('click', function (ev) {
    var p = $('pop-pct');
    if (p && !p.contains(ev.target) && !(ev.target.closest && ev.target.closest('#btn-pct, #btn-pct-ficha'))) fecharPopPct();
  });

  /** Categoria da linha de grupo / matriz com filiais: a das empresas (a categoria já é calculada pela soma do grupo); se divergirem, a mais alta. */
  function categoriaDoGrupo(e) {
    var ordem = ['Diamante', 'Ouro', 'Prata', 'Bronze'];
    var cats = (e.itens || []).map(function (i) { return i.categoria; }).filter(Boolean);
    if (!cats.length) return null;
    return cats.sort(function (a, b) { return ordem.indexOf(a) - ordem.indexOf(b); })[0];
  }
  function linhaAnalise(c, filho) {
    var q = c.questor;
    return '<tr class="' + (filho ? 'filho' : '') + '"><td style="padding-left:' + (filho ? '38px' : '12px') + ';white-space:normal;min-width:240px">' + nomeAnalise(c) + '</td>' +
      '<td class="c">' + pillCat(c) + '</td>' +
      '<td class="c">' + (c.regime ? esc(c.regime) : '<span class="cinza">—</span>') + '</td>' +
      '<td class="c">' + (q ? celNum(q.funcionarios == null ? 0 : q.funcionarios) : '<span class="cinza">sem dado</span>') + '</td>' +
      '<td class="c" style="font-family:var(--mono)">' + reais(c.honorario) + '</td>' +
      '<td class="c" style="font-family:var(--mono)">' + celFat(q) + '</td>' +
      '<td class="c" style="font-family:var(--mono)">' + celSugerido(q ? q.faturamento : null, c.honorario) + '</td>' +
      '<td class="c">' + celAnalise(q ? q.faturamento : null, c.honorario) + '</td></tr>';
  }
  var ANALISE_POR_PAGINA = 50;
  // Paginação no rodapé da tabela: "Total: N registros  [1] [2] [3] ›" (modelo pedido pelo Reysner, 11/10/2026). Mostra só 3 números de página (a atual no meio) mais as setas.
  function paginacaoHtml(total, pag, porPag) {
    var paginas = Math.max(1, Math.ceil(total / porPag)), p = [], i;
    var de = Math.max(1, Math.min(pag - 1, paginas - 2)), ate = Math.min(paginas, de + 2);
    for (i = de; i <= ate; i++) p.push(i);
    var bt = function (n, rot, ativo, titulo) { return '<button type="button" class="pg-btn' + (ativo ? ' ativo' : '') + '" data-pag="' + n + '"' + (ativo ? ' aria-current="page"' : '') + ' title="' + titulo + '">' + rot + '</button>'; };
    return '<nav class="paginacao" aria-label="Páginas da lista"><span class="pg-total">Total: ' + String(total).replace(/B(?=(d{3})+(?!d))/g, '.') + ' registros</span>' +
      (paginas > 1 ? (pag > 1 ? bt(pag - 1, '‹', false, 'Página anterior') : '') +
        p.map(function (n) { return n === '…' ? '<span class="pg-gap">…</span>' : bt(n, n, n === pag, 'Página ' + n); }).join('') +
        (pag < paginas ? bt(pag + 1, '›', false, 'Próxima página') : '') : '') + '</nav>';
  }
  // Linhas da Análise Inteligente já filtradas e ordenadas (usada pela tela e pela exportação).
  function analiseFiltrada() {
    var d = estado.dados, f = estado.filtroAnalise, b = f.busca.trim().toLowerCase();
    var base = d.clientes.concat(d.clientes_outros || []), contTipo = { CNPJ: 0, CPF: 0, CAEPF: 0, CNO: 0 };
    base.forEach(function (c) { if (contTipo[c.tipo_doc] != null) contTipo[c.tipo_doc]++; });
    if (f.tipo) base = base.filter(function (c) { return c.tipo_doc === f.tipo; });
    var todasEnts = montarEntidades(base); estado.entidadesAnalise = {}; todasEnts.forEach(function (e) { estado.entidadesAnalise[e.chave] = e; });
    var ents = todasEnts.filter(function (e) {
      if (f.soGrupos && e.unico) return false;
      if (!b) return true;
      return e.itens.some(function (c) { return (c.nome || '').toLowerCase().indexOf(b) >= 0 || String(c.cnpj || '').replace(/\D/g, '').indexOf(b.replace(/\D/g, '') || '§') >= 0; }) || e.nome.toLowerCase().indexOf(b) >= 0;
    });
    ents.sort(function (a, c) { return (c.faturamento == null ? -1 : c.faturamento) - (a.faturamento == null ? -1 : a.faturamento) || a.nome.localeCompare(c.nome); });
    return { contTipo: contTipo, todasEnts: todasEnts, ents: ents };
  }
  function desenharAnalise() {
    var d = estado.dados, t = d.totais, f = estado.filtroAnalise;
    var semQuestor = !d.totais.questor_lido_em && !d.clientes.concat(d.clientes_outros || []).some(function (c) { return c.questor; });
    var an = analiseFiltrada(), contTipo = an.contTipo, ents = an.ents;
    var totFat = somar(ents, function (e) { return e.faturamento; }), totHon = somar(ents, function (e) { return e.honorario; }), totFun = somar(ents, function (e) { return e.funcionarios; });
    var nGrupos = ents.filter(function (e) { return !e.unico; }).length;
    var paginasAn = Math.max(1, Math.ceil(ents.length / ANALISE_POR_PAGINA)); if (f.pag > paginasAn) f.pag = paginasAn; if (f.pag < 1) f.pag = 1;
    var linhas = ents.slice((f.pag - 1) * ANALISE_POR_PAGINA, f.pag * ANALISE_POR_PAGINA).map(function (e) {
      if (e.unico) return linhaAnalise(e.itens[0], false);
      var aberto = !!estado.abertosAnalise[e.chave];
      var rotulo = e.tipo === 'grupo' ? 'GRUPO ' + esc(e.nome.toUpperCase()) : esc(e.nome) + ' <span class="cinza">e filiais</span>';
      var topo = '<tr class="grupo"><td style="white-space:normal;min-width:240px"><button class="lupa" data-abre="' + esc(e.chave) + '" title="' + (aberto ? 'Recolher' : 'Ver as ' + e.itens.length + ' empresas') + '" aria-expanded="' + aberto + '">' + (aberto ? '🔽' : '🔍') + '</button> <button class="link" data-grupo="' + esc(e.chave) + '" title="Abrir a ficha do grupo"><strong>' + rotulo + '</strong></button> <span class="pill" style="color:#256050;border-color:#25605055;background:#25605014">' + e.itens.length + ' empresas</span></td>' +
        '<td class="c">' + pillCat({ categoria: categoriaDoGrupo(e) }) + '</td><td class="c"><span class="cinza">—</span></td>' +
        '<td class="c"><strong>' + celNum(e.funcionarios) + '</strong></td><td class="c" style="font-family:var(--mono)"><strong>' + reais(e.honorario) + '</strong></td><td class="c" style="font-family:var(--mono)"><strong>' + celFatTotal(e.faturamento) + '</strong></td>' +
        '<td class="c" style="font-family:var(--mono)"><strong>' + celSugerido(e.faturamento, e.honorario) + '</strong></td><td class="c">' + celAnalise(e.faturamento, e.honorario) + '</td></tr>';
      return topo + (aberto ? e.itens.map(function (c) { return linhaAnalise(c, true); }).join('') : '');
    }).join('');
    var per = t.questor_periodo ? (t.questor_periodo.ini.slice(5) + '/' + t.questor_periodo.ini.slice(0, 4) + ' a ' + t.questor_periodo.fim.slice(5) + '/' + t.questor_periodo.fim.slice(0, 4)) : '12 meses';
    $('sec-analise').innerHTML =
      (semQuestor ? '<div class="nota" style="border-color:#d97706"><strong>Dados do Questor ainda não carregados.</strong> Faturamento e funcionários chegam pela rotina mensal (a partir do dia 25); até lá aparecem como "sem dado". As empresas, os grupos e os honorários já estão listados.</div>' : '') +
      '<div class="gp-kpi-row">' + kpi('#256050', 'Faturamento (12 meses)', totFat == null && !valoresOcultos() ? '—' : reais(totFat), per) +
        kpi('#b45309', 'Honorários (mensal)', totHon == null && !valoresOcultos() ? '—' : reais(totHon), 'soma dos clientes listados') +
        kpi('#7c3aed', 'Funcionários', celNum(totFun), 'ativos no Questor (0 = sem empregados)') + kpi('#10b981', 'Grupos e filiais', nGrupos, 'linhas consolidadas') + '</div>' +
      '<div class="nota">Faturamento dos últimos 12 meses já lançados, lido do módulo Fiscal do Questor' + (t.questor_lido_em ? ' em ' + data(t.questor_lido_em) : '') + '. <strong>Grupo de empresas</strong> (Gestão de Clientes) e <strong>matriz com filiais</strong> aparecem somados em uma linha; clique na lupa para ver cada empresa. Cliente sem funcionário no Questor aparece com 0; sem dado = empresa que não está no Questor. Clientes ativos no Acessórias; ao inativar, a empresa some. O filtro <strong>Documento</strong> separa CNPJ, CPF, CAEPF e CNO (só esta tela lista CPF, CAEPF e CNO; o risco considera só CNPJ).</div>' +
      '<div class="card"><div class="filter-group" style="margin-bottom:14px"><span class="filter-label">Buscar</span><input class="gp-input" id="a-busca" placeholder="Empresa, grupo ou CNPJ" value="' + esc(f.busca) + '">' +
        '<span class="filter-label">Documento</span><select class="gp-select" id="a-tipo"><option value=""' + (!f.tipo ? ' selected' : '') + '>Todos (' + (contTipo.CNPJ + contTipo.CPF + contTipo.CAEPF + contTipo.CNO) + ')</option>' + ['CNPJ', 'CPF', 'CAEPF', 'CNO'].map(function (k) { return '<option value="' + k + '"' + (f.tipo === k ? ' selected' : '') + '>Só ' + k + ' (' + contTipo[k] + ')</option>'; }).join('') + '</select>' +
        '<label style="font-size:12px;color:var(--text2);display:flex;gap:6px;align-items:center"><input type="checkbox" id="a-grupos"' + (f.soGrupos ? ' checked' : '') + '> só grupos e matriz com filiais</label></div>' +
        '<div class="card-sub">' + ents.length + ' linha(s) · ordem: faturamento, do maior para o menor' + legendaHon() + '</div>' +
        (ents.length ? '<div class="table-wrap"><table class="tab-analise"><colgroup><col style="width:25%"><col style="width:10%"><col style="width:11%"><col style="width:8%"><col style="width:11%"><col style="width:13%"><col style="width:14%"><col style="width:8%"></colgroup><thead><tr><th>Razão social</th><th class="c">Categoria</th><th class="c">Regime tributário</th><th class="c">Funcionários</th><th class="c">Honorários</th><th class="c">Faturamento (12 meses)</th><th class="c">Honorário sugerido ' + botaoPct() + '</th><th class="c">Análise</th></tr></thead><tbody>' + linhas + '</tbody></table></div>' : '<div class="vazio">Nada encontrado neste filtro.</div>') +
        (ents.length ? paginacaoHtml(ents.length, f.pag, ANALISE_POR_PAGINA) : '') + '</div>';
    var bpct = $('btn-pct'); if (bpct) bpct.addEventListener('click', function (ev) { ev.stopPropagation(); abrirPopPct(bpct); });
    Array.prototype.forEach.call(document.querySelectorAll('#sec-analise [data-abre]'), function (bt) { bt.addEventListener('click', function () { var k = bt.getAttribute('data-abre'); estado.abertosAnalise[k] = !estado.abertosAnalise[k]; desenharAnalise(); }); });
    Array.prototype.forEach.call(document.querySelectorAll('#sec-analise [data-grupo]'), function (bt) { bt.addEventListener('click', function () { abrirFichaGrupo(bt.getAttribute('data-grupo')); }); });
    var campo = $('a-busca'); if (campo) { campo.addEventListener('input', function () { f.busca = campo.value; f.pag = 1; var pos = campo.selectionStart; desenharAnalise(); var n = $('a-busca'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* sem seleção */ } }); }
    var tp = $('a-tipo'); if (tp) tp.addEventListener('change', function () { f.tipo = tp.value; f.pag = 1; desenharAnalise(); });
    var g = $('a-grupos'); if (g) g.addEventListener('change', function () { f.soGrupos = g.checked; f.pag = 1; desenharAnalise(); });
    Array.prototype.forEach.call(document.querySelectorAll('#sec-analise [data-pag]'), function (bt) {
      bt.addEventListener('click', function () {
        f.pag = parseInt(bt.getAttribute('data-pag'), 10) || 1; desenharAnalise();
        var topo = document.querySelector('#sec-analise .filter-group'); if (topo && topo.scrollIntoView) topo.scrollIntoView({ block: 'start' });
      });
    });
  }

  // ── ANÁLISE ANUAL (pedido do Reysner, 15/10/2026) ────────────────────────────
  // Faturamento por ano civil de cada cliente ATIVO (lido do Questor por rotina local; só administrador vê valores). Destaca quem subiu pelo menos
  // X% sobre o ano anterior, para avaliar reajuste de honorário. Funcionários e regime POR ANO ainda não estão na API do Questor: hoje só o atual.
  function cfgAnual() { return (estado.anual && estado.anual.config) || { percentual: 30, pode_editar: false }; }
  function filtroAnual() { return estado.filtroAnual || (estado.filtroAnual = { busca: '', ano: null, soDestaque: false, regra: 'ou', ordem: 'alfa', tipo: '', pag: 1 }); }
  function soDig(s) { return String(s || '').replace(/\D/g, ''); }
  /** Anos completos disponíveis (do segundo ano da série até o último ano fechado) e o ano parcial em curso, se houver. */
  function anosAnual() {
    var a = estado.anual; if (!a || !a.ate || !a.ano_inicial) return { completos: [], parcial: null, ini: null };
    var ano = parseInt(a.ate.slice(0, 4), 10), mes = parseInt(a.ate.slice(5, 7), 10);
    var ult = mes === 12 ? ano : ano - 1, completos = [];
    for (var y = a.ano_inicial + 1; y <= ult; y++) completos.push(y);
    return { completos: completos, parcial: mes === 12 ? null : { ano: ano, mes: mes }, ini: a.ano_inicial };
  }
  var REGIME_GENERICO = 'Lucro (Presumido/Real)';
  function mapaAnual() {
    var m = {};
    ((estado.anual && estado.anual.itens) || []).forEach(function (it) {
      var o = {};
      // regime sempre específico (Simples, Presumido ou Real): rótulos genéricos de leituras antigas viram "sem informação"
      it.anos.forEach(function (x) { if (x.regime === 'Fora do Simples' || x.regime === REGIME_GENERICO) x.regime = null; o[x.ano] = x; });
      m[it.cnpj] = o;
    });
    return m;
  }
  /** Honorário cobrado por ano (Omie): { cnpj: { ano: { total, meses, mensal } } }. */
  function mapaHonAnual() {
    var m = {};
    ((estado.anual && estado.anual.itens) || []).forEach(function (it) {
      var o = {}; (it.honorarios || []).forEach(function (h) { o[h.ano] = h; }); m[it.cnpj] = o;
    });
    return m;
  }
  var REAJUSTE_PADRAO = 5;   // % que o honorário do Omie precisa ter subido (desde o ano anterior) para contar como reajustado; o administrador altera no botão %
  function reajusteMin() { var c = (estado.anual && estado.anual.config) || {}; return c.reajuste_min > 0 ? c.reajuste_min : REAJUSTE_PADRAO; }
  /** Honorário mensal típico do Omie: o do ano anterior (hp) e o mais recente (hc, do último ano com cobrança a partir do ano analisado). */
  function honOmie(mh, doc, ano) {
    var hon = mh[doc] || {}, ys = Object.keys(hon).map(Number).filter(function (y) { return y >= ano && hon[y].mensal > 0; }).sort(function (a, b) { return b - a; });
    var ant = hon[ano - 1] && hon[ano - 1].mensal > 0 ? hon[ano - 1].mensal : null, hoje = ys.length ? hon[ys[0]].mensal : null;
    return { hp: ant, hc: hoje, hcAno: ys.length ? ys[0] : null, vh: varPct(ant, hoje) };
  }
  /** Situação do reajuste de quem está em "Rever honorário": 'nao' (subiu menos que o mínimo), 'sim', 'sem-dado' (sem os dois valores no Omie) ou null (não é destaque). */
  function reajusteLinha(l) {
    if (!destaqueLinha(l)) return null;
    if (l.vh == null) return 'sem-dado';
    return l.vh >= reajusteMin() ? 'sim' : 'nao';
  }
  /** variação % de b sobre a; null quando não há base (a <= 0 ou ausente). */
  function varPct(a, b) { return a == null || b == null || !(a > 0) ? null : (b - a) / a * 100; }
  function destaqueAnual(v) { return v != null && v >= cfgAnual().percentual; }
  function pctAnual(v) { return v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + pctTxt(Math.abs(v)) + '%'; }
  function funcDoAno(anos, ano) { var x = anos && anos[ano]; return x && x.funcionarios != null ? x.funcionarios : null; }
  function regimeDoAnoAnual(anos, ano) { var x = anos && anos[ano]; return x && x.regime ? x.regime : null; }
  /**
   * Mudança de regime entre dois anos. Os anos vêm de fontes diferentes (ECF da Receita, opção pelo Simples, ou o cadastro do Questor),
   * então "Fora do Simples" (sem detalhe) contra "Lucro Presumido" NÃO é mudança: só conta passar de/para o Simples, ou trocar entre
   * dois regimes específicos (Presumido, Real, Arbitrado...).
   */
  function regimeMudou(a, b) {
    if (!a || !b || a === b) return false;
    var simples = function (r) { return r === 'Simples Nacional' || r === 'MEI'; };
    if (simples(a) !== simples(b)) return true;
    if (simples(a) && simples(b)) return a !== b;                  // Simples <-> MEI
    return a !== REGIME_GENERICO && b !== REGIME_GENERICO;          // dois regimes específicos e diferentes
  }
  var ROT_REGRA = { ambos: 'faturamento e funcionários', ou: 'faturamento ou funcionários', fat: 'faturamento', func: 'funcionários' };
  var ROT_ORDEM = { alfa: 'ordem alfabética', alta: 'maior alta de faturamento primeiro' };
  /** Regime como chip colorido e curto: Simples, Presumido, Real (Imune/Isenta em cinza). O texto completo fica no title. */
  function chipRegime(r) {
    if (!r) return '<span class="cinza">—</span>';
    var t = String(r), cls = 'rg-outro', curto = t;
    if (/simples/i.test(t)) { cls = 'rg-simples'; curto = 'Simples'; }
    else if (/presumido/i.test(t)) { cls = 'rg-presumido'; curto = 'Presumido'; }
    else if (/real/i.test(t)) { cls = 'rg-real'; curto = 'Real'; }
    else if (/imune/i.test(t)) { cls = 'rg-outro'; curto = 'Imune'; }
    else if (/isent/i.test(t)) { cls = 'rg-outro'; curto = 'Isenta'; }
    return '<span class="chip-regime ' + cls + '" title="' + esc(t) + '">' + esc(curto) + '</span>';
  }
  function celRegime(rp, rc, mudou, ano) {
    if (!rp && !rc) return '<span class="cinza">—</span>';
    if (mudou) return '<span class="regime-muda" title="O regime mudou entre ' + (ano - 1) + ' e ' + ano + '">' + chipRegime(rp) + '<span class="regime-seta" aria-hidden="true">→</span>' + chipRegime(rc) + '</span>';
    return chipRegime(rc || rp);
  }
  /** Aviso (passar o mouse) de um cliente sem faturamento usado no ano: o total do relatório do Questor não fecha com a soma dos meses. */
  function avisoFatAnual(anos, ano) { var x = anos && anos[ano]; return x && x.faturamento == null && x.aviso ? x.aviso : ''; }
  function semDadoFat(anos, ano) {
    var av = avisoFatAnual(anos, ano);
    return av ? '<span class="cinza aviso-fat" tabindex="0" title="' + esc(av) + '" aria-label="' + esc(av) + '">sem dado ⚠</span>' : '<span class="cinza">sem dado</span>';
  }
  /** Destaque pela regra escolhida: "ambos" exige as DUAS variações (faturamento e funcionários) no limite ou acima; quando não há folha para comparar, vale o faturamento. */
  function destaquePorValores(l, regra) {
    var r = regra || filtroAnual().regra || 'ou';
    if (r === 'fat') return destaqueAnual(l.v);
    if (r === 'func') return destaqueAnual(l.vf);
    if (r === 'ou') return destaqueAnual(l.v) || destaqueAnual(l.vf);        // qualquer um dos dois no limite
    // "ambos": faturamento E funcionários no limite; sem folha nos dois anos (vf nulo) decide só o faturamento
    return destaqueAnual(l.v) && (l.vf == null || destaqueAnual(l.vf));
  }
  /** Rever honorário: pelos valores (regra escolhida) OU porque o regime mudou entre os dois anos (muda o trabalho do escritório). */
  function destaqueLinha(l, regra) { return destaquePorValores(l, regra) || !!l.mudouRegime; }
  /** Os motivos do destaque, para o tooltip, a ficha e a exportação. */
  function motivosRever(l) {
    var m = [];
    if (destaquePorValores(l)) {
      if (destaqueAnual(l.v)) m.push('faturamento ' + pctAnual(l.v));
      if (destaqueAnual(l.vf)) m.push('funcionários ' + pctAnual(l.vf));
    }
    if (l.mudouRegime) m.push('mudou de regime (' + l.rp + ' → ' + l.rc + ')');
    return m;
  }
  function linhasAnual() {
    var d = estado.dados, f = filtroAnual(), ac = anosAnual(), mapa = mapaAnual();
    var ano = f.ano || (ac.completos.length ? ac.completos[ac.completos.length - 1] : null);
    var base = d.clientes.concat(d.clientes_outros || []), b = f.busca.trim().toLowerCase();
    var contTipo = { CNPJ: 0, CPF: 0, CAEPF: 0, CNO: 0 };
    base.forEach(function (c) { if (contTipo[c.tipo_doc] != null) contTipo[c.tipo_doc]++; });
    if (f.tipo) base = base.filter(function (c) { return c.tipo_doc === f.tipo; });                  // filtro Documento: só CNPJ, CPF, CAEPF ou CNO
    var mh = mapaHonAnual();
    var linhas = base.map(function (c) {
      var doc = soDig(c.cnpj), anos = mapa[doc] || null, ho = honOmie(mh, doc, ano);
      var prev = anos && anos[ano - 1] ? anos[ano - 1].faturamento : null, cur = anos && anos[ano] ? anos[ano].faturamento : null;
      var fp = funcDoAno(anos, ano - 1), fc = funcDoAno(anos, ano);
      var rp = regimeDoAnoAnual(anos, ano - 1), rc = regimeDoAnoAnual(anos, ano);
      return { c: c, doc: doc, anos: anos, prev: prev, cur: cur, v: varPct(prev, cur), fp: fp, fc: fc, vf: varPct(fp, fc), rp: rp, rc: rc, mudouRegime: regimeMudou(rp, rc), hp: ho.hp, hc: ho.hc, hcAno: ho.hcAno, vh: ho.vh };
    });
    var comDado = linhas.filter(function (l) { return l.anos; }).length;
    var todas = linhas.length;
    if (b) linhas = linhas.filter(function (l) { return (l.c.nome || '').toLowerCase().indexOf(b) >= 0 || l.doc.indexOf(b.replace(/\D/g, '') || '§') >= 0; });
    var subiram = linhas.filter(function (l) { return destaqueLinha(l); });
    var mudaram = linhas.filter(function (l) { return l.mudouRegime; }).length;
    var semReajuste = subiram.filter(function (l) { return reajusteLinha(l) === 'nao'; }).length;
    if (f.soDestaque) linhas = subiram;
    if (f.soSemReajuste) linhas = linhas.filter(function (l) { return reajusteLinha(l) === 'nao'; });
    var porNome = function (x, y) { return (x.c.nome || '').localeCompare(y.c.nome || '', 'pt-BR', { sensitivity: 'base' }); };
    if ((f.ordem || 'alfa') === 'alta') linhas.sort(function (x, y) { return (y.v == null ? -1e9 : y.v) - (x.v == null ? -1e9 : x.v) || porNome(x, y); });
    else linhas.sort(porNome);
    return { ano: ano, linhas: linhas, comDado: comDado, todas: todas, subiram: subiram.length, semReajuste: semReajuste, mudaram: mudaram, contTipo: contTipo };
  }
  function celVar(v, dest) {
    if (v == null) return '<span class="cinza">—</span>';
    return '<span class="' + (dest ? 'an-baixo-up' : (v < 0 ? 'an-baixo' : '')) + '"><strong>' + esc(pctAnual(v)) + '</strong></span>';
  }
  function desenharAnual() {
    var alvo = $('sec-anual'); if (!alvo) return;
    var a = estado.anual, f = filtroAnual(), ac = anosAnual();
    if (!a) { alvo.innerHTML = '<div class="card"><div class="vazio">Não foi possível carregar a análise anual agora.</div></div>'; return; }
    if (a.valores_ocultos) { alvo.innerHTML = '<div class="card"><div class="vazio">O perfil Usuário não vê valores em R$. A Análise Anual compara faturamento, então fica disponível só para o administrador.</div></div>'; return; }
    if (!a.itens || !a.itens.length || !ac.completos.length) {
      alvo.innerHTML = '<div class="nota" style="border-color:#d97706"><strong>Faturamento por ano ainda não carregado.</strong> A rotina que lê o Questor (server/questor/extrairAnual.js) roda no computador com a VPN e envia os totais por ano. Assim que chegar, a lista aparece aqui.</div>'; return;
    }
    var r = linhasAnual(), ano = r.ano, pag = Math.max(1, Math.ceil(r.linhas.length / ANALISE_POR_PAGINA)); if (f.pag > pag) f.pag = pag; if (f.pag < 1) f.pag = 1;
    var X = cfgAnual().percentual, regra = f.regra || 'ou';
    var totPrev = 0, totCur = 0; r.linhas.forEach(function (l) { if (l.prev != null && l.cur != null) { totPrev += l.prev; totCur += l.cur; } });
    var comFunc = r.linhas.filter(function (l) { return l.fp != null && l.fc != null; }).length;
    var corpo = r.linhas.slice((f.pag - 1) * ANALISE_POR_PAGINA, f.pag * ANALISE_POR_PAGINA).map(function (l) {
      var c = l.c, dest = destaqueLinha(l);
      var vTxt = l.v != null ? celVar(l.v, destaqueAnual(l.v)) : (l.prev === 0 && l.cur > 0 ? '<span class="pill" style="color:#2563eb;border-color:#2563eb55;background:#2563eb14">novo</span>' : '<span class="cinza">—</span>');
      var funcTxt = l.fp == null && l.fc == null ? '<span class="cinza">sem folha</span>' : (l.fp == null ? '—' : l.fp) + ' → ' + (l.fc == null ? '—' : l.fc);
      var regTxt = celRegime(l.rp, l.rc, l.mudouRegime, ano);
      return '<tr><td style="white-space:normal;min-width:200px"><button class="link" data-anual="' + esc(l.doc) + '">' + esc(c.nome) + '</button><div class="sub">' + esc(c.cnpj || '') + '</div></td>' +
        '<td class="c">' + pillCat(c) + '</td>' +
        '<td class="c">' + regTxt + '</td>' +
        '<td class="c" style="font-family:var(--mono)">' + (l.anos && l.prev != null ? reais(l.prev) : semDadoFat(l.anos, ano - 1)) + '</td>' +
        '<td class="c" style="font-family:var(--mono)">' + (l.anos && l.cur != null ? reais(l.cur) : semDadoFat(l.anos, ano)) + '</td>' +
        '<td class="c">' + vTxt + '</td>' +
        '<td class="c">' + funcTxt + '</td>' +
        '<td class="c">' + celVar(l.vf, destaqueAnual(l.vf)) + '</td>' +
        '<td class="c">' + (dest ? '<span class="pill" style="color:#b45309;border-color:#b4530955;background:#b4530914" title="Rever honorário: ' + esc(motivosRever(l).join(' · ')) + (regra === 'ambos' && l.vf == null && destaquePorValores(l) ? ' (sem folha para comparar: decidido pelo faturamento)' : '') + '">Rever honorário</span>' : (l.anos ? '<span class="cinza" title="Abaixo do limite de ' + esc(pctTxt(X)) + '% em ' + esc(ROT_REGRA[regra]) + '">Abaixo do limite</span>' : '<span class="cinza">—</span>')) + '</td></tr>';
    }).join('');
    var optAnos = ac.completos.map(function (y) { return '<option value="' + y + '"' + (y === ano ? ' selected' : '') + '>' + y + ' × ' + (y - 1) + '</option>'; }).join('');
    var optRegra = Object.keys(ROT_REGRA).map(function (k) { return '<option value="' + k + '"' + (k === regra ? ' selected' : '') + '>' + esc(ROT_REGRA[k].charAt(0).toUpperCase() + ROT_REGRA[k].slice(1)) + '</option>'; }).join('');
    var parcial = ac.parcial ? ' O ano de ' + ac.parcial.ano + ' tem só ' + ac.parcial.mes + ' mês(es) lançado(s) e por isso fica de fora da comparação.' : '';
    var pctDelta = totPrev > 0 ? (totCur - totPrev) / totPrev * 100 : null;
    alvo.innerHTML =
      '<div class="gp-kpi-row">' +
        kpi('#256050', 'Clientes com histórico', r.comDado + ' de ' + r.todas, 'ativos no Acessórias com dados do Questor') +
        kpi('#b45309', 'Rever honorário', r.subiram, 'subiram ' + pctTxt(X) + '% ou mais em ' + ROT_REGRA[regra] + ' (' + ano + ' sobre ' + (ano - 1) + ')') +
        kpi('#b91c1c', 'Rever, sem reajuste', r.semReajuste, 'honorário do Omie subiu menos de ' + pctTxt(reajusteMin()) + '% desde ' + (ano - 1)) +
        kpi('#7c3aed', 'Mudaram de regime', r.mudaram, 'entre ' + (ano - 1) + ' e ' + ano + ', pelos dados da Receita') +
        kpi('#0f766e', 'Faturamento ' + ano, valoresOcultos() ? reais(null) : reais(totCur), pctDelta == null ? 'sem base para comparar' : pctAnual(pctDelta) + ' sobre ' + (ano - 1) + ' (clientes da lista)') +
      '</div>' +
      '<div class="nota"><strong>Fontes.</strong> Faturamento por ano civil: Questor (módulo Fiscal). Funcionários: total de empregados ativos no <strong>último mês com folha</strong> de cada ano (Questor, Folha); a contagem é por empresa e fica na matriz. ' +
        'Regime: <strong>Receita Federal</strong> (ECF e opção pelo Simples; para anos ainda sem ECF vale a última conhecida, indicada na ficha). O cadastro de regime do Questor não é usado. ' +
        'Só clientes <strong>ativos no Acessórias</strong>.' + esc(parcial) + ' <strong>A mudança de regime tributário entre os dois anos também gera "Rever honorário"</strong>, qualquer que seja a regra escolhida. <strong>Honorário no Omie:</strong> ao clicar na empresa, a ficha compara o honorário mensal cobrado (mediana dos meses, dois ambientes) com a variação do faturamento; o painel "Rever, sem reajuste" e o filtro "só sem reajuste" separam quem subiu menos de ' + pctTxt(reajusteMin()) + '% desde o ano anterior. Com a regra "faturamento e funcionários", quem não tem folha nos dois anos é decidido só pelo faturamento. O limite de ' + esc(pctTxt(X)) + '% é um só para a equipe' + (cfgAnual().pode_editar ? ' (botão % no título da coluna Variação).' : '.') + '</div>' +
      '<div class="card"><div class="filter-group" style="margin-bottom:14px"><span class="filter-label">Buscar</span><input class="gp-input" id="n-busca" placeholder="Empresa ou CNPJ" value="' + esc(f.busca) + '">' +
        '<span class="filter-label">Documento</span><select class="gp-select" id="n-tipo"><option value=""' + (!f.tipo ? ' selected' : '') + '>Todos (' + (r.contTipo.CNPJ + r.contTipo.CPF + r.contTipo.CAEPF + r.contTipo.CNO) + ')</option>' + ['CNPJ', 'CPF', 'CAEPF', 'CNO'].map(function (t) { return '<option value="' + t + '"' + (f.tipo === t ? ' selected' : '') + '>Só ' + t + ' (' + r.contTipo[t] + ')</option>'; }).join('') + '</select>' +
        '<span class="filter-label">Comparar</span><select class="gp-select" id="n-ano">' + optAnos + '</select>' +
        '<span class="filter-label">Destacar quem subiu</span><select class="gp-select" id="n-regra">' + optRegra + '</select>' +
        '<span class="filter-label">Ordenar</span><select class="gp-select" id="n-ordem"><option value="alfa"' + ((f.ordem || 'alfa') === 'alfa' ? ' selected' : '') + '>Ordem alfabética</option><option value="alta"' + (f.ordem === 'alta' ? ' selected' : '') + '>Maior alta de faturamento</option></select>' +
        '<label style="font-size:12px;color:var(--text2);display:flex;gap:6px;align-items:center"><input type="checkbox" id="n-dest"' + (f.soDestaque ? ' checked' : '') + '> só os destacados</label>' +
        '<label style="font-size:12px;color:var(--text2);display:flex;gap:6px;align-items:center"><input type="checkbox" id="n-semrj"' + (f.soSemReajuste ? ' checked' : '') + '> só sem reajuste</label>' + botaoReajuste() + '</div>' +
        '<div class="card-sub">' + r.linhas.length + ' cliente(s) · ' + comFunc + ' com folha nos dois anos · ' + ROT_ORDEM[f.ordem || 'alfa'] + '. Clique na empresa para ver ano a ano.</div>' +
        (r.linhas.length ? '<div class="table-wrap"><table class="tab-analise"><colgroup><col style="width:21%"><col style="width:9%"><col style="width:17%"><col style="width:11%"><col style="width:11%"><col style="width:8%"><col style="width:8%"><col style="width:7%"><col style="width:8%"></colgroup>' +
          '<thead><tr><th>Razão social</th><th class="c">Categoria</th><th class="c">Regime ' + (ano - 1) + ' → ' + ano + '</th><th class="c">Faturamento ' + (ano - 1) + '</th><th class="c">Faturamento ' + ano + '</th>' +
          '<th class="c">Variação ' + botaoPctAnual() + '</th><th class="c">Funcionários</th><th class="c">Variação</th><th class="c">Análise</th></tr></thead><tbody>' + corpo + '</tbody></table></div>' + paginacaoHtml(r.linhas.length, f.pag, ANALISE_POR_PAGINA)
          : '<div class="vazio">Nenhum cliente neste filtro.</div>') + '</div>';
    var campo = $('n-busca'); if (campo) campo.addEventListener('input', function () { f.busca = campo.value; f.pag = 1; var pos = campo.selectionStart; desenharAnual(); var n = $('n-busca'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* sem seleção */ } });
    var st = $('n-tipo'); if (st) st.addEventListener('change', function () { f.tipo = st.value; f.pag = 1; desenharAnual(); });
    var sa = $('n-ano'); if (sa) sa.addEventListener('change', function () { f.ano = parseInt(sa.value, 10); f.pag = 1; desenharAnual(); });
    var sr = $('n-regra'); if (sr) sr.addEventListener('change', function () { f.regra = sr.value; f.pag = 1; desenharAnual(); });
    var so = $('n-ordem'); if (so) so.addEventListener('change', function () { f.ordem = so.value; f.pag = 1; desenharAnual(); });
    var sd = $('n-dest'); if (sd) sd.addEventListener('change', function () { f.soDestaque = sd.checked; f.pag = 1; desenharAnual(); });
    var sj = $('n-semrj'); if (sj) sj.addEventListener('change', function () { f.soSemReajuste = sj.checked; f.pag = 1; desenharAnual(); });
    var br = $('btn-pct-rj'); if (br) br.addEventListener('click', function (ev) { ev.stopPropagation(); abrirPopAnual(br, 'reajuste_min'); });
    var bp = $('btn-pct-anual'); if (bp) bp.addEventListener('click', function (ev) { ev.stopPropagation(); abrirPopAnual(bp); });
    Array.prototype.forEach.call(document.querySelectorAll('#sec-anual [data-anual]'), function (bt) { bt.addEventListener('click', function () { abrirFichaAnual(bt.getAttribute('data-anual')); }); });
    Array.prototype.forEach.call(document.querySelectorAll('#sec-anual [data-pag]'), function (bt) {
      bt.addEventListener('click', function () {
        f.pag = parseInt(bt.getAttribute('data-pag'), 10) || 1; desenharAnual();
        var topo = document.querySelector('#sec-anual .filter-group'); if (topo && topo.scrollIntoView) topo.scrollIntoView({ block: 'start' });
      });
    });
  }
  function botaoPctAnual() {
    var c = cfgAnual(), dica = 'Destaca quem subiu esse percentual ou mais sobre o ano anterior' + (c.pode_editar ? '. Clique para alterar.' : '.');
    return c.pode_editar
      ? '<button type="button" class="mini-pct" id="btn-pct-anual" title="' + esc(dica) + '" aria-haspopup="dialog">' + esc(pctTxt(c.percentual)) + '%</button>'
      : '<span class="mini-pct fixo" title="' + esc(dica) + '">' + esc(pctTxt(c.percentual)) + '%</span>';
  }
  function botaoReajuste() {
    var c = cfgAnual(), dica = 'Quem está em "Rever honorário" e teve o honorário do Omie subindo menos que esse percentual desde o ano anterior conta como "sem reajuste"' + (c.pode_editar ? '. Clique para alterar.' : '.');
    return c.pode_editar
      ? '<button type="button" class="mini-pct" id="btn-pct-rj" title="' + esc(dica) + '" aria-haspopup="dialog">' + esc(pctTxt(reajusteMin())) + '%</button>'
      : '<span class="mini-pct fixo" title="' + esc(dica) + '">' + esc(pctTxt(reajusteMin())) + '%</span>';
  }
  /** Popover do percentual editável: campo 'percentual' (limite de variação do faturamento) ou 'reajuste_min' (corte do "sem reajuste"). */
  function abrirPopAnual(btn, campo) {
    campo = campo || 'percentual';
    var rj = campo === 'reajuste_min';
    fecharPopPct();
    var c = cfgAnual(), r = btn.getBoundingClientRect(), p = document.createElement('div'), atual = rj ? reajusteMin() : c.percentual;
    p.id = 'pop-pct'; p.className = 'pop-pct'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', rj ? 'Corte do sem reajuste' : 'Limite de variação do faturamento');
    p.innerHTML = '<label for="pa-valor">' + (rj ? 'Sem reajuste: honorário subiu menos de' : 'Destacar quem subiu pelo menos') + '</label>' +
      '<div class="pop-linha"><input id="pa-valor" type="text" inputmode="decimal" value="' + esc(String(atual).replace('.', ',')) + '"><span>%</span></div>' +
      '<div class="pop-dica">' + (rj ? 'Compara o honorário mensal do Omie de hoje com o do ano anterior. Vale para toda a equipe.' : 'Compara o faturamento do ano escolhido com o ano anterior. Vale para toda a equipe.') + '</div><div class="pop-erro" id="pa-erro" role="alert"></div>' +
      '<div class="pop-acoes"><button type="button" class="gp-footer-btn" id="pa-cancelar" style="width:auto">Cancelar</button>' +
      '<button type="button" class="login-btn" id="pa-salvar" style="width:auto;margin:0;padding:8px 16px">Salvar</button></div>';
    document.body.appendChild(p);
    p.style.top = Math.round(r.bottom + 6) + 'px';
    p.style.left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - 300)) + 'px';
    $('pa-valor').focus();
    $('pa-cancelar').addEventListener('click', fecharPopPct);
    var salvar = async function () {
      var v = parseFloat($('pa-valor').value.trim().replace(',', '.')), erro = $('pa-erro'); erro.textContent = '';
      if (!(v > 0 && v <= 1000)) { erro.textContent = 'Informe um percentual maior que 0 e até 1000.'; return; }
      $('pa-salvar').disabled = true;
      try {
        var resp = await chamarApi('/api/cs/painel/anual', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rj ? { reajuste_min: v } : { percentual: v }) });
        var j = await resp.json().catch(function () { return {}; });
        if (!resp.ok) { erro.textContent = j.error || 'Não foi possível salvar.'; $('pa-salvar').disabled = false; return; }
        estado.anual.config = Object.assign({}, estado.anual.config, { percentual: j.percentual, reajuste_min: j.reajuste_min, pode_editar: true });
        fecharPopPct(); desenharAnual();
      } catch (e) { erro.textContent = 'Sem conexão com o servidor. Tente de novo.'; $('pa-salvar').disabled = false; }
    };
    $('pa-salvar').addEventListener('click', salvar);
    p.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') salvar(); if (ev.key === 'Escape') fecharPopPct(); });
  }
  // Ficha de um cliente: ano a ano, desde o primeiro ano lido (mesmo modelo da ficha do outro módulo).
  function abrirFichaAnual(doc) {
    var d = estado.dados, c = d.clientes.concat(d.clientes_outros || []).filter(function (x) { return soDig(x.cnpj) === doc; })[0]; if (!c) return;
    var anos = (mapaAnual()[doc]) || {}, ac = anosAnual(), X = cfgAnual().percentual, hon = mapaHonAnual()[doc] || {};
    document.querySelector('.ficha-box').classList.add('larga');   // janela larga: a tabela ano a ano cabe sem rolagem
    $('ficha').style.display = 'flex';
    $('ficha-nome').textContent = c.nome;
    $('ficha-sub').innerHTML = esc(c.cnpj || '') + (c.grupo ? ' · Grupo ' + esc(c.grupo) : '') + ' · cliente desde ' + data(c.entrada);
    var lista = Object.keys(anos).map(Number).sort();
    // começa no primeiro ano em que o cliente apareceu com faturamento, folha ou regime informado
    while (lista.length && !(anos[lista[0]].faturamento > 0) && anos[lista[0]].funcionarios == null) lista.shift();
    var max = Math.max.apply(null, lista.map(function (y) { return Math.abs(anos[y].faturamento || 0); }).concat([1]));
    var linhas = lista.map(function (y, i) {
      var x = anos[y], ant = i > 0 ? anos[lista[i - 1]] : null, v = ant ? varPct(ant.faturamento, x.faturamento) : null, vf = ant ? varPct(ant.funcionarios, x.funcionarios) : null;
      var parcial = ac.parcial && y === ac.parcial.ano, fat = x.faturamento == null ? 0 : x.faturamento;
      var larg = Math.max(2, Math.round(Math.abs(fat) / max * 100));
      var mud = ant && regimeMudou(ant.regime, x.regime);
      var h = hon[y], hAnt = i > 0 ? hon[lista[i - 1]] : null, vh = h && hAnt ? varPct(hAnt.mensal, h.mensal) : null;
      return '<tr><td><strong>' + y + '</strong>' + (parcial ? ' <span class="cinza">até ' + String(ac.parcial.mes).padStart(2, '0') + '/' + y + '</span>' : '') + '</td>' +
        '<td class="c" style="font-family:var(--mono)">' + (x.faturamento == null ? semDadoFat(anos, y) : reais(x.faturamento)) + '</td>' +
        '<td class="c">' + (parcial ? '<span class="cinza">parcial</span>' : celVar(v, destaqueAnual(v))) + '</td>' +
        '<td style="min-width:90px"><div class="barra-ano" style="width:' + larg + '%"></div></td>' +
        '<td class="c">' + (x.funcionarios == null ? '<span class="cinza">sem folha</span>' : x.funcionarios) + '</td>' +
        '<td class="c">' + (parcial ? '' : celVar(vf, destaqueAnual(vf))) + '</td>' +
        '<td class="c" style="white-space:normal">' + (x.regime ? chipRegime(x.regime) + (mud ? ' <span class="regime-seta" title="Mudou em relação ao ano anterior">●</span>' : '') + (x.regime_fonte ? '<div class="sub">' + esc(x.regime_fonte) + '</div>' : '') : '<span class="cinza">—</span>') + '</td>' +
        '<td class="c" style="font-family:var(--mono)">' + (h ? reais(h.mensal) + '<div class="sub">' + h.meses + (h.meses === 1 ? ' mês' : ' meses') + ' cobrados</div>' : '<span class="cinza">—</span>') + '</td>' +
        '<td class="c">' + (vh == null ? '' : celVar(vh, false)) + '</td></tr>';
    }).join('');
    var ultComp = ac.completos.length ? ac.completos[ac.completos.length - 1] : null;
    var A1 = ultComp && anos[ultComp - 1] ? anos[ultComp - 1] : null, A2 = ultComp && anos[ultComp] ? anos[ultComp] : null;
    var v = A1 && A2 ? varPct(A1.faturamento, A2.faturamento) : null, vf = A1 && A2 ? varPct(A1.funcionarios, A2.funcionarios) : null;
    var passo = $('ficha-passo'); passo.style.display = 'block';
    var sug = A2 && A2.faturamento != null ? honSugerido(A2.faturamento) : null;
    var partes = [];
    if (v == null) partes.push('sem base para comparar o faturamento de ' + (ultComp || '') + ' com o ano anterior');
    else partes.push('o faturamento ' + (v >= 0 ? 'subiu ' : 'caiu ') + esc(pctTxt(Math.abs(v))) + '%');
    if (vf != null) partes.push('os funcionários ' + (vf >= 0 ? 'subiram ' : 'caíram ') + esc(pctTxt(Math.abs(vf))) + '% (' + A1.funcionarios + ' → ' + A2.funcionarios + ')');
    else partes.push('sem folha nos dois anos para comparar funcionários');
    var ambos = destaqueAnual(v) && destaqueAnual(vf);
    var mudouReg = A1 && A2 && regimeMudou(A1.regime, A2.regime);
    var ho = ultComp ? honOmie(mapaHonAnual(), doc, ultComp) : null;
    passo.innerHTML = '<strong>Leitura:</strong> em ' + ultComp + ' sobre ' + (ultComp - 1) + ', ' + partes.join('; ') + '.' +
      (ambos ? ' Os dois passaram do limite de ' + esc(pctTxt(X)) + ': vale avaliar reajuste do honorário.' : (destaqueAnual(v) && vf == null ? ' O faturamento passou do limite de ' + esc(pctTxt(X)) + '% e não há folha para comparar: vale avaliar reajuste do honorário.' : (destaqueAnual(v) ? ' O faturamento passou do limite de ' + esc(pctTxt(X)) + '%, mas os funcionários não acompanharam.' : ''))) +
      (mudouReg ? ' O regime mudou de ' + esc(A1.regime) + ' para ' + esc(A2.regime) + ': muda o trabalho do escritório, vale avaliar reajuste do honorário.' : '') +
      (ho && ho.hp != null && ho.hc != null && !valoresOcultos() ? ' Honorário cobrado no Omie: ' + esc(moedaTxt(ho.hp)) + ' por mês em ' + (ultComp - 1) + ' → ' + esc(moedaTxt(ho.hc)) + ' em ' + ho.hcAno + ' (' + esc(pctAnual(ho.vh)) + (v != null ? ' contra faturamento ' + esc(pctAnual(v)) : '') + (destaqueLinha({ v: v, vf: vf, mudouRegime: mudouReg }) ? (ho.vh >= reajusteMin() ? ': já reajustado' : ': sem reajuste') : '') + ').' : '') +
      (sug != null && c.honorario != null && !valoresOcultos() ? ' Com o faturamento de ' + ultComp + ', o honorário sugerido é ' + esc(moedaTxt(sug)) + ' por mês (hoje cobra ' + esc(moedaTxt(c.honorario)) + ').' : '');
    var q = c.questor;
    // honorário cobrado no Omie x "Rever honorário": só aparece aqui, ao abrir a empresa
    var blocoOmie = '';
    if (ho && (ho.hp != null || ho.hc != null)) {
      var lj = { v: v, vf: vf, mudouRegime: !!mudouReg, rp: A1 && A1.regime, rc: A2 && A2.regime }, rjF = reajusteLinha(Object.assign({ vh: ho.vh }, lj));
      var sitTxt = ho.hc == null ? 'sem honorário no Omie' : (rjF === 'nao' ? 'Sem reajuste' : rjF === 'sim' ? 'Reajustado' : rjF === 'sem-dado' ? 'sem base para comparar' : 'fora do "Rever honorário"');
      var corSit = rjF === 'nao' ? '#b91c1c' : rjF === 'sim' ? '#166534' : null;
      var detSit = destaqueLinha(lj) ? 'Rever honorário: ' + esc(motivosRever(lj).join(' · ')) : 'abaixo do limite de ' + esc(pctTxt(X)) + '%';
      blocoOmie = '<div class="ficha-sec">Honorário no Omie × faturamento</div><div class="blocos">' +
        bloco('Honorário mensal ' + (ultComp - 1), ho.hp != null ? reais(ho.hp) : '—', 'valor típico cobrado no ano', null) +
        bloco('Honorário mensal hoje', ho.hc != null ? reais(ho.hc) : '—', ho.hcAno ? 'valor típico em ' + ho.hcAno : '', null) +
        bloco('Variação do honorário', ho.vh != null ? esc(pctAnual(ho.vh)) : '—', 'contra faturamento ' + (v != null ? esc(pctAnual(v)) : '—') + ' em ' + ultComp, null) +
        bloco('Situação', sitTxt, detSit, corSit) + '</div>';
    }
    var blocos = '<div class="blocos">' +
      bloco('Honorário mensal', reais(c.honorario), 'cobrado hoje', null) +
      bloco('Funcionários (hoje)', q ? celNum(q.funcionarios == null ? 0 : q.funcionarios) : 'sem dado', 'Questor, folha atual', null) +
      bloco('Regime tributário (hoje)', c.regime ? esc(c.regime) : '—', 'cadastro do Acessórias', null) + '</div>';
    $('ficha-corpo').innerHTML = blocos + '<div class="ficha-sec">Ano a ano</div>' +
      (lista.length ? '<div class="table-wrap"><table><thead><tr><th>Ano</th><th class="c">Faturamento</th><th class="c">Variação</th><th></th><th class="c">Funcionários</th><th class="c">Variação</th><th class="c">Regime tributário</th><th class="c">Honorário mensal</th><th class="c">Variação</th></tr></thead><tbody>' + linhas + '</tbody></table></div>' + blocoOmie +
        '<div class="nota" style="margin-top:10px">Funcionários: total do último mês com folha de cada ano. Regime: dados da Receita Federal; abaixo de cada regime está a fonte (ECF do ano, opção pelo Simples ou a última ECF conhecida). Faturamento: exatamente o que o Questor devolve. Honorário mensal: valor típico cobrado por mês no Omie (categoria Serviços Honorários Contábeis, dois ambientes somados); o histórico do Omie começa no fim de 2023 e o ano em curso é parcial.</div>'
        : '<div class="linha-item"><span class="x">Este cliente ainda não tem dados do Questor por ano.</span></div>');
  }

  // Ficha do grupo (mesmo modelo da ficha do cliente): números consolidados e, abaixo, cada empresa com os seus.
  function abrirFichaGrupo(chave) {
    var e = estado.entidadesAnalise && estado.entidadesAnalise[chave]; if (!e) return;
    estado.fichaGrupoAberta = chave;
    document.querySelector('.ficha-box').classList.add('larga');   // janela larga: a tabela das empresas cabe sem rolagem
    $('ficha').style.display = 'flex';
    $('ficha-nome').textContent = e.tipo === 'grupo' ? 'Grupo ' + e.nome : e.nome + ' e filiais';
    $('ficha-sub').textContent = e.itens.length + ' empresas · ' + (e.tipo === 'grupo' ? 'grupo de empresas (Gestão de Clientes)' : 'matriz e filiais (mesma raiz de CNPJ)');
    var passo = $('ficha-passo'); passo.style.display = 'block';
    var sugG = honSugerido(e.faturamento), anG = honAnalise(e.honorario, sugG);
    var abaixo = e.itens.filter(function (c) { return honAnalise(c.honorario, honSugerido(c.questor ? c.questor.faturamento : null)) === 'baixo'; }).length;
    passo.innerHTML = '<strong>Leitura do grupo:</strong> ' + (valoresOcultos() ? 'valores em R$ ocultos.'
      : (sugG == null || anG == null ? 'sem faturamento ou honorário para comparar o grupo com o honorário sugerido.'
        : esc(dicaHon(e.honorario, sugG)) + '.' + (abaixo ? ' ' + abaixo + ' empresa(s) do grupo estão abaixo de ' + esc(pctTxt(cfgHon().limite_amarelo)) + '% do sugerido.' : '')));
    var blocos = '<div class="blocos">' + bloco('Funcionários', celNum(e.funcionarios), 'soma das empresas do grupo (Questor)', null) +
      bloco('Honorários', reais(e.honorario), 'mensal, soma do grupo', null) + bloco('Faturamento', reais(e.faturamento), '12 meses, soma do grupo', null) +
      bloco('Honorário sugerido', celSugerido(e.faturamento, e.honorario) + ' ' + celAnalise(e.faturamento, e.honorario), cfgHon().percentual == null ? 'defina o percentual na tabela' : pctTxt(cfgHon().percentual) + '% do faturamento médio mensal', null) + '</div>';
    var corpo = e.itens.map(function (c) {
      var q = c.questor;
      return '<tr><td style="white-space:normal;min-width:220px">' + nomeAnalise(c) + '</td><td class="c">' + pillCat(c) + '</td><td class="c">' + (c.regime ? esc(c.regime) : '<span class="cinza">—</span>') +
        '</td><td class="c">' + (q ? celNum(q.funcionarios == null ? 0 : q.funcionarios) : '<span class="cinza">sem dado</span>') + '</td><td class="c" style="font-family:var(--mono)">' + reais(c.honorario) + '</td><td class="c" style="font-family:var(--mono)">' + celFat(q) + '</td><td class="c" style="font-family:var(--mono)">' + celSugerido(q ? q.faturamento : null, c.honorario) + '</td><td class="c">' + celAnalise(q ? q.faturamento : null, c.honorario) + '</td></tr>';
    }).join('');
    $('ficha-corpo').innerHTML = blocos + '<div class="ficha-sec">Empresas do grupo</div><div class="table-wrap"><table><thead><tr><th>Empresa</th><th class="c">Categoria</th><th class="c">Regime</th><th class="c">Funcionários</th><th class="c">Honorário</th><th class="c">Faturamento (12 meses)</th><th class="c">Honorário sugerido ' + botaoPct('btn-pct-ficha') + '</th><th class="c">Análise</th></tr></thead><tbody>' + corpo + '</tbody></table></div>' +
      '<div class="nota" style="margin-top:10px">Sugerido = ' + (cfgHon().percentual == null ? 'percentual definido no botão %' : esc(pctTxt(cfgHon().percentual)) + '% do faturamento médio mensal (12 meses ÷ 12)') + '. <span class="an-ok">✔</span> cobrado no sugerido ou acima · <span class="an-medio">▲</span> de ' + esc(pctTxt(cfgHon().limite_amarelo)) + '% a 100% do sugerido · <span class="an-baixo">✖</span> abaixo de ' + esc(pctTxt(cfgHon().limite_amarelo)) + '%.</div>';
    var bf = $('btn-pct-ficha'); if (bf) bf.addEventListener('click', function (ev) { ev.stopPropagation(); abrirPopPct(bf); });
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
    document.querySelector('.ficha-box').classList.remove('larga');
    $('ficha').style.display = 'flex';
    $('ficha-nome').textContent = 'Carregando…'; $('ficha-sub').textContent = ''; $('ficha-passo').style.display = 'none'; $('ficha-corpo').innerHTML = '';
    try {
      var f = await api('/api/cs/painel/cliente/' + encodeURIComponent(id));
      desenharFicha(f);
    } catch (e) { $('ficha-nome').textContent = 'Não foi possível abrir a ficha'; $('ficha-corpo').innerHTML = '<div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div>'; }
  }

  function desenharFicha(f) {
    estado.ficha = f;
    var c = f.cliente, r = c.risco, cortes = estado.dados.config.cortes;
    $('ficha-nome').innerHTML = esc(c.nome) + seloSuspenso(r);
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
      bloco('Categoria', c.categoria ? ICONE_CAT[c.categoria] + ' ' + esc(c.categoria) : 'Sem categoria', esc(motivoTxt(c.categoria_motivo)), c.categoria ? COR_CAT[c.categoria] : null) +
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
    var oper = r.suspenso ? '<div class="linha-item"><span class="q">⏸</span><span class="x">Contrato suspenso no Omie: as entregas atrasadas abaixo são efeito da suspensão e não entram no termômetro Operacional.</span></div>' : '';
    oper += e && e.total ? '<div class="blocos">' + bloco('Entregas (90 dias)', e.total, 'lidas do Acessórias em ' + data(e.atualizado_em), null) + bloco('Entregues com atraso', e.atrasadas_entregues, 'status "Ent. atrasada"', e.atrasadas_entregues ? '#dc2626' : null) + bloco('Vencidas sem entrega', e.vencidas_pendentes, 'status "Atrasada!" ou pendente vencida', e.vencidas_pendentes ? '#dc2626' : null) + '</div>'
      : '<div class="linha-item"><span class="x">Sem entregas lidas do Acessórias para este cliente no período' + (e ? ' (última leitura em ' + data(e.atualizado_em) + ')' : ' (ainda não lido)') + '.</span></div>';

    var sinais = (r.motivos || []).map(function (m) { return '<span class="chip" style="color:#dc2626;border-color:#dc262655">' + esc(m) + '</span>'; }).join('') || '<span class="cinza">nenhum sinal de atenção</span>';

    $('ficha-corpo').innerHTML = blocos1 + blocos2 +
      '<div class="ficha-sec">Sinais de atenção</div><div>' + sinais + '</div>' +
      '<div class="ficha-sec">Financeiro</div>' + fin +
      '<div class="ficha-sec">Atendimento (Zappy, 90 dias)</div>' + resumoAt + tick +
      '<div class="ficha-sec">Insatisfações registradas (180 dias)</div>' + insat + sens + (pesq ? '<div class="ficha-sec">Pesquisas de satisfação</div>' + pesq : '') +
      '<div class="ficha-sec">Operacional (entregas do Acessórias)</div>' + oper;
  }

  function fecharFicha() { $('ficha').style.display = 'none'; document.querySelector('.ficha-box').classList.remove('larga'); }

  // ── EXPORTAÇÃO (CSV e PDF) ───────────────────────────────────────────────────
  // Exporta TODAS as linhas do filtro atual da seção aberta (não só a página). Os dados já vieram do servidor com as permissões e os
  // valores ocultos aplicados; com "Ocultar valores" ligado, os valores em R$ saem como "oculto".
  var SEC_EXPORTA = { visao: 1, analise: 1, anual: 1, risco: 1, churn: 1, categorias: 1 };
  function moedaExp(v) { return valoresOcultos() ? 'oculto' : (v == null ? '' : Math.round(v * 100) / 100); }
  function fatExp(q) {
    if (valoresOcultos()) return 'oculto';
    if (!q || q.faturamento == null) return 'sem dado';
    return q.faturamento === 0 ? 'sem faturamento' : Math.round(q.faturamento * 100) / 100;
  }
  function funcExp(q) { return q ? (q.funcionarios == null ? 0 : q.funcionarios) : 'sem dado'; }
  function sugExp(fat) {
    if (valoresOcultos()) return 'oculto';
    var s = honSugerido(fat);
    return s == null ? '' : s;
  }
  var ROT_ANALISE_EXP = { ok: 'No sugerido ou acima', medio: 'Tomando distância', baixo: 'Muito abaixo' };
  function analiseExp(fat, cobrado) {
    if (valoresOcultos()) return 'oculto';
    var n = honAnalise(cobrado, honSugerido(fat));
    return n ? ROT_ANALISE_EXP[n] : '';
  }
  var ROT_NIVEL = { AltoMedio: 'Alto e Médio', Alto: 'Só Alto', 'Médio': 'Só Médio', Baixo: 'Baixo', Suspenso: 'Suspensos (fora do risco)', todos: 'Todos' };

  function dadosExport(sec) {
    var d = estado.dados, t = d.totais, aviso = valoresOcultos() ? 'Valores em R$ ocultos.' : '';
    if (sec === 'visao') {
      var p = periodoAtual();
      var lin = [
        ['Clientes ativos (CNPJ)', t.clientes],
        ['Período do churn', data(p.ini) + ' a ' + data(p.fim)], ['Base no início do período', p.base], ['Saídas que contam (Transferida por...)', p.saidas_contadas],
        ['Taxa de churn (%)', p.taxa == null ? '' : p.taxa], ['Teto do churn com as saídas a confirmar (%)', p.taxa_teto == null ? '' : p.taxa_teto], ['Saíram em até 90 dias', p.menos_de_90_dias],
        ['Risco Alto', t.risco.Alto], ['Risco Médio', t.risco['Médio']], ['Risco Baixo', t.risco.Baixo], ['Suspensos no Omie (fora do risco)', t.suspensos || 0],
        ['Clientes sem reclamação nos últimos 30 dias', t.sem_reclamacao_30d],
        ['Categoria Diamante', t.categorias.Diamante], ['Categoria Ouro', t.categorias.Ouro], ['Categoria Prata', t.categorias.Prata], ['Categoria Bronze', t.categorias.Bronze], ['Sem categoria', t.categorias.sem_categoria],
      ];
      ['financeiro', 'atendimento', 'operacional'].forEach(function (k) {
        var tm = t.termometros[k];
        lin.push(['Termômetro ' + NOME_TERM[k] + ': clientes com dado', tm.com_dado]); lin.push(['Termômetro ' + NOME_TERM[k] + ': em alerta', tm.em_alerta]); lin.push(['Termômetro ' + NOME_TERM[k] + ': Médio ou mais', tm.medio_ou_mais]);
      });
      return { arquivo: 'cs-visao-geral', titulo: 'Painel do Sucesso do Cliente - Visão geral', filtros: [aviso], colunas: ['Indicador', 'Valor'], linhas: lin, alinhar: ['left', 'right'], orientacao: 'portrait', fonte: 9 };
    }
    if (sec === 'analise') {
      var f = estado.filtroAnalise, a = analiseFiltrada(), linhas = [];
      var linhaEmp = function (c, nivel) {
        var q = c.questor;
        return [nivel, c.nome, c.cnpj || '', c.tipo_doc || 'CNPJ', c.categoria || '', c.regime || '', funcExp(q), moedaExp(c.honorario), fatExp(q), sugExp(q ? q.faturamento : null), analiseExp(q ? q.faturamento : null, c.honorario), q && q.aviso ? 'Natureza sem configuração de faturamento no Questor' : ''];
      };
      a.ents.forEach(function (e) {
        if (e.unico) { linhas.push(linhaEmp(e.itens[0], 'Empresa')); return; }
        var fat = valoresOcultos() ? 'oculto' : (e.faturamento == null ? 'sem dado' : e.faturamento === 0 ? 'sem faturamento' : Math.round(e.faturamento * 100) / 100);
        linhas.push([e.tipo === 'grupo' ? 'Grupo' : 'Matriz e filiais', e.tipo === 'grupo' ? 'GRUPO ' + e.nome.toUpperCase() : e.nome + ' e filiais', e.itens.length + ' empresas', '', categoriaDoGrupo(e) || '', '', e.funcionarios == null ? 'sem dado' : e.funcionarios, moedaExp(e.honorario), fat, sugExp(e.faturamento), analiseExp(e.faturamento, e.honorario), '']);
        e.itens.forEach(function (c) { linhas.push(linhaEmp(c, '  Empresa do grupo')); });
      });
      var fl = []; if (f.busca) fl.push('Busca: ' + f.busca); if (f.tipo) fl.push('Documento: ' + f.tipo); if (f.soGrupos) fl.push('Só grupos e matriz com filiais');
      return { arquivo: 'cs-analise-inteligente', titulo: 'Painel do Sucesso do Cliente - Análise Inteligente', filtros: [a.ents.length + ' linha(s)' + (fl.length ? ' · ' + fl.join(' · ') : ' · sem filtro') + ' · ordem: faturamento, do maior para o menor', aviso],
        colunas: ['Nível', 'Razão social', 'Documento', 'Tipo', 'Categoria', 'Regime tributário', 'Funcionários', 'Honorários (R$)', 'Faturamento 12 meses (R$)', 'Honorário sugerido (R$)', 'Análise', 'Aviso do Questor'], linhas: linhas,
        alinhar: ['left', 'left', 'left', 'center', 'center', 'left', 'center', 'right', 'right', 'right', 'center', 'left'], fonte: 7 };
    }
    if (sec === 'anual') {
      if (!estado.anual || estado.anual.valores_ocultos || !estado.anual.itens || !estado.anual.itens.length || !anosAnual().completos.length) return null;   // sem carga: nada para exportar
      var ra = linhasAnual(), fa = filtroAnual(), Xa = cfgAnual().percentual;
      var fan = []; if (fa.busca) fan.push('Busca: ' + fa.busca); if (fa.tipo) fan.push('Documento: ' + fa.tipo); if (fa.soDestaque) fan.push('Só os destacados'); if (fa.soSemReajuste) fan.push('Só sem reajuste');
      return { arquivo: 'cs-analise-anual', titulo: 'Painel do Sucesso do Cliente - Análise Anual (' + ra.ano + ' × ' + (ra.ano - 1) + ')',
        filtros: [ra.linhas.length + ' cliente(s) · rever honorário: ' + pctTxt(Xa) + '% ou mais em ' + ROT_REGRA[fa.regra || 'ou'] + (fan.length ? ' · ' + fan.join(' · ') : '') + ' · ' + ROT_ORDEM[fa.ordem || 'alfa'], aviso],
        colunas: ['Razão social', 'Documento', 'Categoria', 'Regime ' + (ra.ano - 1), 'Regime ' + ra.ano, 'Faturamento ' + (ra.ano - 1) + ' (R$)', 'Faturamento ' + ra.ano + ' (R$)', 'Variação faturamento (%)',
          'Funcionários ' + (ra.ano - 1), 'Funcionários ' + ra.ano, 'Variação funcionários (%)', 'Rever honorário', 'Motivo', 'Honorário Omie ' + (ra.ano - 1) + ' (mensal R$)', 'Honorário Omie hoje (mensal R$)', 'Variação honorário (%)', 'Reajuste'],
        linhas: ra.linhas.map(function (l) {
          return [l.c.nome, l.c.cnpj || '', l.c.categoria || '', l.rp || '', l.rc || '', l.anos ? moedaExp(l.prev) : 'sem dado', l.anos ? moedaExp(l.cur) : 'sem dado',
            l.v == null ? '' : Math.round(l.v * 10) / 10, l.fp == null ? '' : l.fp, l.fc == null ? '' : l.fc, l.vf == null ? '' : Math.round(l.vf * 10) / 10,
            destaqueLinha(l) ? 'Sim' : '', destaqueLinha(l) ? motivosRever(l).join(' · ') : '',
            moedaExp(l.hp), moedaExp(l.hc), l.vh == null || valoresOcultos() ? '' : Math.round(l.vh * 10) / 10,
            { nao: 'Sem reajuste', sim: 'Reajustado', 'sem-dado': 'Sem dado no Omie' }[reajusteLinha(l)] || ''];
        }),
        alinhar: ['left', 'left', 'center', 'left', 'left', 'right', 'right', 'right', 'center', 'center', 'right', 'center', 'left', 'right', 'right', 'right', 'center'], fonte: 6 };
    }
    if (sec === 'risco') {
      var fr = estado.filtroRisco, lr = filtrarRisco();
      var fx = ['Risco: ' + (ROT_NIVEL[fr.nivel] || fr.nivel)]; if (fr.busca) fx.push('Busca: ' + fr.busca); if (fr.cat) fx.push('Categoria: ' + fr.cat); if (fr.term) fx.push('Pesa mais: ' + NOME_TERM[fr.term]); if (fr.soAtend) fx.push('Só com sinal de Atendimento');
      return { arquivo: 'cs-gestao-da-permanencia', titulo: 'Painel do Sucesso do Cliente - Gestão da Permanência', filtros: [lr.length + ' cliente(s) · ' + fx.join(' · ') + ' · ordem alfabética', aviso],
        colunas: ['Cliente', 'CNPJ', 'Categoria', 'Risco', 'Pontos', 'Financeiro', 'Atendimento', 'Operacional', 'Suspenso no Omie', 'Honorário (R$)', 'O que está puxando'],
        linhas: lr.map(function (c) {
          var tm = c.risco.termometros, v = function (x) { return x == null ? 'sem dado' : x; };
          return [c.nome, c.cnpj || '', c.categoria || '', c.risco.nivel, c.risco.pontos == null ? '' : c.risco.pontos, v(tm.financeiro), v(tm.atendimento), v(tm.operacional), c.risco.suspenso ? 'Sim' : '', moedaExp(c.honorario), (c.risco.motivos || []).join(' | ')];
        }),
        alinhar: ['left', 'left', 'left', 'center', 'center', 'center', 'center', 'center', 'center', 'right', 'left'], fonte: 7 };
    }
    if (sec === 'churn') {
      var pc = periodoAtual();
      return { arquivo: 'cs-churn-saidas', titulo: 'Painel do Sucesso do Cliente - Churn: saídas do período',
        filtros: ['Período de ' + data(pc.ini) + ' a ' + data(pc.fim) + ' · base ' + pc.base + ' · saídas que contam ' + pc.saidas_contadas + ' · taxa ' + (pc.taxa == null ? '-' : pc.taxa + '%'), 'Todas as saídas do período, com o tipo de cada uma.'],
        colunas: ['Cliente', 'CNPJ', 'Entrada', 'Saída', 'Tipo', 'Na base do início', 'Como foi classificada'],
        linhas: pc.saidas.map(function (s) { var tp = TIPO_SAIDA[s.tipo] || { rot: s.tipo }; return [s.nome, s.cnpj || '', data(s.data_entrada), data(s.data_saida), tp.rot, s.na_base ? 'Sim' : 'Entrou no período', ({ acessorias: 'Acessórias', sistema: 'sistema', receita: 'Receita (CNPJ)', manual: 'definida pelo administrador', presumida: 'presumida (sem motivo no Acessórias)' })[s.origem] || s.origem || '']; }),
        alinhar: ['left', 'left', 'center', 'center', 'left', 'center', 'left'], fonte: 7.5 };
    }
    if (sec === 'categorias') {
      var sel = estado.catSel;
      var lc = d.clientes.filter(function (c) { return sel === 'sem' ? !c.categoria : (sel ? c.categoria === sel : true); });
      return { arquivo: 'cs-categorias', titulo: 'Painel do Sucesso do Cliente - Categorias', filtros: [lc.length + ' cliente(s) · ' + (sel === 'sem' ? 'Sem categoria' : sel ? 'Categoria ' + sel : 'Todas as categorias'), aviso],
        colunas: ['Cliente', 'CNPJ', 'Categoria', 'Honorário (R$)', 'Motivo da categoria', 'Risco', 'Pontos'],
        linhas: lc.map(function (c) { return [c.nome, c.cnpj || '', c.categoria || 'Sem categoria', moedaExp(c.honorario), motivoTxt(c.categoria_motivo), c.risco.nivel, c.risco.pontos == null ? '' : c.risco.pontos]; }),
        alinhar: ['left', 'left', 'left', 'right', 'left', 'center', 'center'], fonte: 7 };
    }
    return null;
  }
  function exportar(formato) {
    var e = dadosExport(estado.secao);
    if (!e) { alert('Esta seção não tem relatório para exportar.'); return; }
    var u = null; try { u = JSON.parse(ls(K_USER) || 'null'); } catch (x) { u = null; }
    var sub = (e.filtros || []).filter(Boolean).concat(u && u.name ? ['Gerado por ' + u.name] : []);
    try {
      if (formato === 'csv') { window.Exportar.csv(e.arquivo, e.colunas, e.linhas); return; }
      var btn = $('btn-pdf'), rot = btn.textContent; btn.disabled = true; btn.textContent = 'Gerando PDF…';
      window.Exportar.pdf({ arquivo: e.arquivo, titulo: e.titulo, subtitulo: sub, colunas: e.colunas, linhas: e.linhas, alinhar: e.alinhar, orientacao: e.orientacao || 'landscape', fonte: e.fonte, paginaDe: 'Sucesso do Cliente' })
        .catch(function (err) { alert(err.message || 'Não foi possível gerar o PDF.'); })
        .then(function () { btn.disabled = false; btn.textContent = rot; });
    } catch (err) { alert(err.message || 'Não foi possível exportar.'); }
  }

  // ── eventos ──────────────────────────────────────────────────────────────────
  document.addEventListener('click', function (ev) {
    var f = ev.target.closest && ev.target.closest('[data-ficha]');
    if (f) { abrirFicha(f.getAttribute('data-ficha')); return; }
    var n = ev.target.closest && ev.target.closest('.risco-bloco');
    if (n) { estado.filtroRisco.nivel = n.getAttribute('data-nivel'); estado.filtroRisco.todos = false; desenharRisco(); irPara('risco'); }
  });
  $('login-form').addEventListener('submit', entrar);
  $('btn-atualizar').addEventListener('click', function () { iniciar(true); });
  $('btn-csv').addEventListener('click', function () { exportar('csv'); });
  $('btn-pdf').addEventListener('click', function () { exportar('pdf'); });
  // Botão "Valores ocultos" (só administrador): esconde todo valor em R$ na tela, para apresentar sem mostrar valores. Lembra a escolha neste navegador.
  function pintarBotaoValores() {
    var b = $('btn-valores'); var admin = estado.dados && estado.dados.usuario && estado.dados.usuario.papel === 'administrador';
    b.style.display = admin ? 'inline-flex' : 'none';
    b.textContent = estado.ocultar ? '🙈 Valores ocultos' : '👁 Ocultar valores';
    b.className = 'gp-footer-btn' + (estado.ocultar ? ' ativo' : '');
  }
  $('btn-valores').addEventListener('click', function () {
    estado.ocultar = !estado.ocultar; try { localStorage.setItem('cs_ocultar', estado.ocultar ? '1' : '0'); } catch (e) { /* sem armazenamento */ }
    pintarBotaoValores(); if (estado.dados) desenharTudo();
    if ($('ficha').style.display === 'flex' && estado.ficha) desenharFicha(estado.ficha);
  });
  try { estado.ocultar = localStorage.getItem('cs_ocultar') === '1'; } catch (e) { estado.ocultar = false; }
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

  $('login-versao').textContent = VERSAO;   // a etiqueta de versão saiu do menu lateral (pedido do Reysner, 09/10/2026)
  if (ls(K_TOKEN)) iniciar(); else mostrarLogin('');
})();
