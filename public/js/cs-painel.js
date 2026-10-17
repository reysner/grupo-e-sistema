/* Painel do Sucesso do Cliente (/cs). Só leitura: toda checagem de acesso é feita pelo servidor (/api/cs/painel). */
(function () {
  'use strict';

  var VERSAO = 'V.1.0 · 07/10/2026';
  var K_TOKEN = 'cs_token', K_REFRESH = 'cs_refresh', K_USER = 'cs_user';

  var COR_RISCO = { 'Alto': '#dc2626', 'Médio': '#d97706', 'Baixo': '#10b981', 'Incompleto': '#9ca3af', 'Suspenso': '#6b21a8' };
  var COR_TERM = { financeiro: '#b45309', atendimento: '#7c3aed', operacional: '#ef4444', tratativas: '#0e7490' };
  var NOME_TERM = { financeiro: 'Financeiro', atendimento: 'Atendimento', operacional: 'Operacional', tratativas: 'Tratativas' };
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
    consideracoes: ['Qualidade', 'Ocorrências registradas (reclamação, insatisfação, multa, caso grave...) com prazo e status. Elas aparecem nos Sinais de atenção, na seção Qualidade da empresa e pesam no risco de churn.'],
    atendimento: ['Atendimento', 'Atendimentos do Zappy e e-mails dos últimos 180 dias de cada cliente ativo. Clique na empresa para ver cada atendimento e os e-mails por destinatário.'],
    anual: ['Análise Anual', 'Faturamento ano a ano de cada cliente ativo no Acessórias, para avaliar se o honorário precisa de ajuste. Clique na empresa para ver a evolução.'],
    visao: ['Visão Geral', 'Clientes ativos, saídas por transferência e risco de perda — só CNPJ. Material da reunião semanal das lideranças.'],
    risco: ['Gestão da Permanência', 'Quem está em risco de sair e por quê: Financeiro, Atendimento e Operacional. Clique no nome da empresa para ver a ficha.'],
    churn: ['Churn', 'Saídas do período ÷ base ativa no início do período. Só contam as três "Transferida por…" do Acessórias.'],
    categorias: ['Categorias', 'Diamante, Ouro, Prata e Bronze pelo honorário, somando grupos de empresas. O motivo de cada categoria aparece sempre.'],
    sucesso: ['Portal do Sucesso do Cliente', 'Todas as ocorrências de todos os departamentos. O Sucesso do Cliente recebe a devolutiva do gestor, formaliza com o cliente e encerra; só o gestor final encerra o processo.'],
    gestor: ['Portal do Gestor', 'As ocorrências do seu departamento: analise, crie a tratativa (plano de ação, responsável e prazo) e abra para o analista. A validação do que o analista tratou volta para cá.'],
    analista: ['Portal do Analista', 'As ocorrências que o seu gestor abriu para você. Sua tratativa será validada pelo seu gestor; depois da nota que você deixar, a ocorrência segue para o Sucesso do Cliente, que faz a devolutiva ao cliente.'],
    qualidade: ['Qualidade dos Dados', 'De onde vem cada indicador e o que ainda está sem dado.'],
  };

  var estado = { dados: null, periodoChave: 'ultimos_12_meses', churnLivre: null, secao: 'visao', graficos: {}, filtroRisco: { busca: '', nivel: 'AltoMedio', cat: '', term: '', soAtend: false, todos: false }, abaChurn: 'transferida', catSel: '', filtroAnalise: { busca: '', soGrupos: false, tipo: '', pag: 1 }, abertosAnalise: {} };

  // ── utilidades ───────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  try { var abaUrl = new URLSearchParams(window.location.search).get('aba'); if (abaUrl && TITULOS[abaUrl]) estado.secao = abaUrl; } catch (e) { /* sem parâmetro */ }
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
      if (['administrador', 'usuario'].indexOf(j.user.role) < 0 && !j.user.acesso_cs && !j.user.acesso_gestor && !j.user.acesso_qualidade) { mostrarLogin('Este painel é da equipe do Sucesso do Cliente. Peça acesso à administração.'); return; }
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
    clearTimeout(avisoTimer); avisosDesde = null;
    estado.dados = null;
    mostrarLogin(silencioso ? 'Sua sessão expirou. Entre de novo.' : '');
  }

  // ── carga ────────────────────────────────────────────────────────────────────
  // Avisos de ocorrência nova (notificação do navegador + som): consulta a cada minuto, só com os avisos ligados neste navegador.
  var avisoTimer = null, avisosDesde = null;
  async function sondarAvisos() {
    clearTimeout(avisoTimer);
    try {
      if (window.Avisos && window.Avisos.ativo()) {
        var j = await api('/api/cs/painel/qualidade/avisos' + (avisosDesde ? '?desde=' + encodeURIComponent(avisosDesde) : ''));
        j.itens.forEach(function (a) { window.Avisos.alertar({ titulo: a.titulo, texto: a.texto, tag: a.id, aoClicar: function () { irPara(perfilCs().gestor ? 'gestor' : 'consideracoes'); } }); });
        avisosDesde = j.agora;
        if (j.itens.length && estado.secao === 'consideracoes') { estado.qResumo = null; if (estado.dados) desenharQualidadeMod(); else desenharQualidadeModLimitado(); }   // a tela já mostra o novo
        if (j.itens.length && estado.secao === 'gestor') { estado.g = null; desenharGestor(); }
        if (j.itens.length && estado.secao === 'sucesso') { estado.s = null; desenharSucesso(); }
      } else avisosDesde = null;
    } catch (e) { /* o aviso nunca derruba a página */ }
    avisoTimer = setTimeout(sondarAvisos, 60 * 1000);
  }
  function iniciarAvisosCs() {
    if (estado.avisosIniciados || !window.Avisos) return;
    estado.avisosIniciados = true;
    window.Avisos.montarControle($('avisos-ctl'), {
      token: function () { return ls(K_TOKEN) || ''; },
      // clique no aviso: abre a aba certa sem recarregar a página
      navegar: function (url) {
        var u = new URL(url, window.location.origin), aba = u.searchParams.get('aba');
        if (u.pathname === '/cs' && aba && TITULOS[aba]) { estado.g = null; estado.a = null; estado.s = null; irPara(aba); window.focus(); } else window.location.href = url;
      },
      aoMudar: function () { avisosDesde = null; sondarAvisos(); } });
    sondarAvisos();
  }

  async function iniciar(forcar) {
    $('login-screen').style.display = 'none';
    $('app').style.display = 'block';
    var u = null; try { u = JSON.parse(ls(K_USER) || 'null'); } catch (e) { u = null; }
    if (u && u.name) montarMenuUsuario(u);
    aplicarPerfilCs();
    if (!perfilCs().completo) return iniciarLimitado();   // gestor e analista: só os módulos deles, sem os dados da carteira
    ['visao', 'analise', 'anual', 'atendimento', 'consideracoes', 'risco', 'churn', 'categorias', 'qualidade'].forEach(function (s) { $('sec-' + s).innerHTML = '<div class="vazio">Carregando…</div>'; });
    try {
      estado.dados = await api('/api/cs/painel/dados' + (forcar === true ? '?forcar=1' : ''));
      try { estado.honorario = await api('/api/cs/painel/honorario-sugerido'); } catch (e) { estado.honorario = null; }
      await carregarMotivosChurn(true);
      try { estado.atend = await api('/api/cs/painel/atendimentos'); } catch (e) { estado.atend = null; }   // o módulo Atendimento avisa quando não chega
      try { estado.anual = await api('/api/cs/painel/anual'); } catch (e) { estado.anual = null; }   // a Análise Anual avisa quando não chega   // sem o percentual, as colunas novas mostram "—"
      pintarBotaoValores();
      estado.churnLivre = null;
      desenharTudo();
      iniciarAvisosCs();
    } catch (e) {
      ['visao', 'analise', 'anual', 'atendimento', 'consideracoes', 'risco', 'churn', 'categorias', 'qualidade'].forEach(function (s) { $('sec-' + s).innerHTML = '<div class="card"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; });
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
    desenharVisao(); desenharAnalise(); desenharAnual(); desenharAtendimento(); desenharQualidadeMod(); desenharRisco(); desenharChurn(); desenharCategorias(); desenharQualidade();
    if (perfilCs().gestor) desenharGestor();
    if (perfilCs().analista) desenharAnalista();
    desenharSucesso();
    irPara(estado.secao);
  }

  function irPara(sec) {
    estado.secao = sec;
    Array.prototype.forEach.call(document.querySelectorAll('.gp-nav-item'), function (b) { b.classList.toggle('active', b.getAttribute('data-sec') === sec); });
    Array.prototype.forEach.call(document.querySelectorAll('.gp-section'), function (s) { s.classList.toggle('ativa', s.id === 'sec-' + sec); });
    $('titulo').textContent = TITULOS[sec][0];
    $('subtitulo').textContent = TITULOS[sec][1];
    $('filtro-periodo').style.display = (sec === 'visao' || sec === 'churn') ? 'flex' : 'none';
    pintarBotaoValores();   // some nos portais
    if (sec === 'gestor' && estado.g && !estado.g.dados) desenharGestor();
    if (sec === 'analista' && (!estado.a || !estado.a.dados) && perfilCs().analista) desenharAnalista();
    if (sec === 'sucesso' && (!estado.s || !estado.s.dados)) desenharSucesso();
    var ativa = $('sec-' + sec); if (ativa) ativa.scrollTop = 0;
    if (sec === 'consideracoes' && estado.dados && !estado.qResumo) desenharQualidadeMod();   // recarrega depois de um registro novo
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
    if (p == null) return t === 'tratativas' ? '<span class="cinza">—</span>' : '<span class="cinza">sem dado</span>';
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
    var tres = ['financeiro', 'atendimento', 'operacional', 'tratativas'].map(function (k) {
      var tm = t.termometros[k];
      var com = d.clientes.filter(function (x) { return x.risco.termometros[k] != null; });
      var alto = com.filter(function (x) { return nivelTerm(x.risco.termometros[k], c) === 'Alto'; }).length;
      var med = com.filter(function (x) { return nivelTerm(x.risco.termometros[k], c) === 'Médio'; }).length;
      var bai = com.length - alto - med;
      var perg = { financeiro: 'O cliente está com honorário em atraso?', atendimento: 'O cliente teve falha de atendimento ou reclamou?', operacional: 'Estamos entregando guias e fechamentos no prazo?', tratativas: 'As ocorrências lançadas no módulo Qualidade estão sendo tratadas no prazo?' }[k];
      var regua = { financeiro: 'Fonte: Omie. Pesa os dias do título mais antigo em atraso e a quantidade de títulos.', atendimento: 'Fonte: Zappy depois da revisão da Gamificação, mais insatisfações registradas e pesquisas. Falha marcada como indevida não conta.', operacional: 'Fonte: entregas do Acessórias nos últimos 90 dias (entregues com atraso e vencidas sem entrega).', tratativas: 'Fonte: módulo Qualidade (erro, multa, reclamação, atraso, falha…, últimos 90 dias). Prazo vencido pesa mais; só entra na média enquanto houver tratativa em aberto. O plano de ação escrito na ficha não conta.' }[k];
      return '<div class="tres-card" style="border-top-color:' + COR_TERM[k] + '"><div class="tres-nome">' + NOME_TERM[k].toUpperCase() + '</div><div class="tres-perg">' + perg + '</div>' +
        '<div class="tres-dest"><b style="color:' + COR_TERM[k] + '">' + (com.length ? pct(alto + med, com.length) + '%' : '—') + '</b><span>em risco Médio ou Alto · ' + (alto + med) + ' de ' + com.length + ' com dado</span></div>' +
        barra([{ rot: 'Alto', n: alto, cor: COR_RISCO.Alto }, { rot: 'Médio', n: med, cor: COR_RISCO['Médio'] }, { rot: 'Baixo', n: bai, cor: COR_RISCO.Baixo }]) +
        (tm.sem_dado ? '<div class="sub" style="margin-top:6px">' + tm.sem_dado + (k === 'tratativas' ? ' cliente(s) sem tratativa em aberto (não entram na média).' : ' cliente(s) sem dado deste indicador (não presumimos que está em dia).') + '</div>' : '') +
        '<div class="tres-regua">' + regua + '</div></div>';
    }).join('');

    var dominantes = { financeiro: 0, atendimento: 0, operacional: 0, tratativas: 0 };
    d.clientes.filter(function (x) { return x.risco.nivel === 'Alto' || x.risco.nivel === 'Médio'; }).forEach(function (x) {
      var k = Object.keys(x.risco.termometros).filter(function (t2) { return x.risco.termometros[t2] != null; }).sort(function (a, b) { return x.risco.termometros[b] - x.risco.termometros[a]; })[0];
      if (k) dominantes[k]++;
    });
    var emRisco = t.risco.Alto + t.risco['Médio'];
    var pontos = [];
    if (t.risco.Alto) pontos.push('<strong>' + t.risco.Alto + ' cliente(s) em Alto risco</strong>: abra a Gestão da Permanência e combine o próximo passo de cada um.');
    if (emRisco) pontos.push('Dos ' + emRisco + ' clientes em risco Alto ou Médio, o termômetro que mais pesa é <strong>Financeiro em ' + dominantes.financeiro + '</strong>, Atendimento em ' + dominantes.atendimento + ', Operacional em ' + dominantes.operacional + ' e Tratativas em ' + dominantes.tratativas + '.');
    if (t.termometros.operacional.com_dado === 0) pontos.push('O termômetro <strong>Operacional ainda está sem dado</strong> (entregas do Acessórias em leitura). Enquanto isso, o risco é calculado só com Financeiro e Atendimento.');
    if (t.suspensos) pontos.push('<strong>' + t.suspensos + ' cliente(s) com contrato suspenso no Omie</strong>' + (t.suspensos_lidos_em ? ' (lista lida em ' + data(t.suspensos_lidos_em) + ', atualizada toda segunda)' : '') + ': a ação é de cobrança e as entregas deles não entram no Operacional. Filtre pelo selo ⏸ Suspenso na Gestão da Permanência.');
    if (p.fora_do_churn && p.fora_do_churn.a_confirmar) pontos.push(p.fora_do_churn.a_confirmar + ' saída(s) ainda <strong>a confirmar</strong> (sem motivo lido do Acessórias): o churn real fica entre ' + p.taxa + '% e ' + p.taxa_teto + '%.');
    if (p.presumidas) pontos.push('<strong>' + p.presumidas + ' saída(s) presumida(s) como transferência</strong> (sem motivo no Acessórias e sem resposta da Receita): contam no churn. Na aba Churn o administrador pode trocar para baixa.');
    pontos.push('<strong>' + pct(t.sem_reclamacao_30d, t.clientes) + '%</strong> dos clientes ficaram sem nenhuma reclamação nos últimos 30 dias (insatisfação registrada ou nota baixa).');

    $('sec-visao').innerHTML =
      '<div class="gp-kpi-row">' +
        kpi('#256050', 'Clientes ativos', t.clientes, 'CNPJ ativos na carteira') +
        kpi('#dc2626', 'Saídas no período', p.saidas_contadas, 'só "Transferida por…" · base de ' + p.base) +
        kpi('#d97706', 'Taxa de churn', (p.taxa == null ? '—' : p.taxa + '%'), p.fora_do_churn && p.fora_do_churn.a_confirmar ? 'teto de ' + p.taxa_teto + '% se as "a confirmar" forem transferências' : 'saídas ÷ base no início do período') +
        kpi('#7c3aed', 'Saíram em até 90 dias', p.menos_de_90_dias, 'desligados com menos de 90 dias de casa (todos os tipos)') +
        kpi('#10b981', 'Sem reclamação no mês', t.sem_reclamacao_30d, pct(t.sem_reclamacao_30d, t.clientes) + '% dos clientes · últimos 30 dias') +
        kpi('#b45309', 'Em Alto risco', t.risco.Alto, t.risco['Médio'] + ' em Médio risco') +
      '</div>' +
      '<div class="risco-card"><div class="risco-head"><div><div class="risco-titulo">RISCO DE PERDA</div><div class="risco-sub">Combina os quatro termômetros, cliente a cliente · ' + avaliados + ' clientes avaliados</div></div>' +
        (alertas ? '<div class="risco-alerta">⚠️ ' + alertas + ' alerta(s): termômetro muito alto em cliente de Médio risco</div>' : '') + '</div>' +
        '<div class="risco-blocos">' + blocoRisco('Alto', 'a partir de ' + c.alto + ' pontos') + blocoRisco('Médio', c.medio + ' a ' + (c.alto - 1) + ' pontos') + blocoRisco('Baixo', 'abaixo de ' + c.medio + ' pontos') + '</div>' +
        '<div class="sub">Os pesos dos quatro termômetros hoje são ' + ['financeiro', 'atendimento', 'operacional', 'tratativas'].map(function (k) { return NOME_TERM[k] + ' ' + d.config.pesos[k]; }).join(' · ') + ' (serão calibrados rodando, a partir das reuniões semanais).</div></div>' +
      '<div class="ficha-sec" style="margin-top:6px">Detalhamento do risco</div><div class="tres quatro">' + tres + '</div>' +
      '<div id="visao-fechamento" style="margin-top:14px"></div>' +
      '<div class="gp-charts-row">' +
        '<div class="gp-chart-card"><div class="gp-chart-title">Churn mês a mês — últimos 12 meses</div><div class="gp-chart-wrap"><canvas id="g-churn"></canvas></div></div>' +
        '<div class="gp-chart-card"><div class="gp-chart-title">Clientes por categoria</div><div class="gp-chart-wrap"><canvas id="g-cat"></canvas></div></div>' +
      '</div>' +
      '<div class="gp-bullets"><div class="gp-bullets-title">Pontos para a reunião</div>' + pontos.map(function (x) { return '<div class="gp-bullet"><span>•</span><span>' + x + '</span></div>'; }).join('') + '</div>' +
      '<div class="nota"><strong>Clientes</strong> = empresas com CNPJ ativas na carteira. Risco, churn e categorias consideram só CNPJ: CPF, CAEPF e CNO (' + t.desconsiderados_nao_cnpj + ' cadastros) ficam de fora desses indicadores e só aparecem na Análise Inteligente.</div>';

    desenharFechamento(estado.mesFechamento);   // Fechamento do mês: bloco entre o detalhamento do risco e os gráficos
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
        '<td class="c">' + celTerm(c, 'financeiro') + '</td><td class="c">' + celTerm(c, 'atendimento') + '</td><td class="c">' + celTerm(c, 'operacional') + '</td><td class="c">' + celTerm(c, 'tratativas') + '</td>' +
        '<td style="min-width:280px;white-space:normal">' + (chips || '<span class="cinza">sem sinais</span>') + '</td></tr>';
    }).join('');
    return { n: lista.length, html: lista.length ? '<div class="table-wrap"><table><thead><tr><th>Cliente</th><th class="c">Categoria</th><th class="c">Risco</th><th class="c">Financeiro</th><th class="c">Atendimento</th><th class="c">Operacional</th><th class="c">Tratativas</th><th>O que está puxando</th></tr></thead><tbody>' + corpo + '</tbody></table></div>' +
      (lista.length > mostrar.length ? '<div class="vazio">Mostrando ' + mostrar.length + ' de ' + lista.length + '. <button class="link" id="r-todos">Mostrar todos</button></div>' : '') : '<div class="vazio">Nenhum cliente neste filtro.</div>' };
  }
  function desenharRisco() {
    var d = estado.dados, f = estado.filtroRisco;
    var opt = function (v, rot, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(rot) + '</option>'; };
    $('sec-risco').innerHTML =
      '<details class="card leg" style="padding:12px 20px"><summary><span class="seta">▶</span> 📏 Legenda — como o risco é calculado <span style="font-weight:500;text-transform:none;letter-spacing:0">(clique para expandir)</span></summary><div class="corpo">' +
        '<div><strong style="color:#dc2626">Risco de perda</strong><br>Média dos termômetros que têm dado, de 0 a 100. Médio a partir de ' + d.config.cortes.medio + ', Alto a partir de ' + d.config.cortes.alto + '. Um termômetro muito alto sozinho gera alerta e sobe o cliente para Médio.</div>' +
        '<div><strong style="color:' + COR_TERM.financeiro + '">Financeiro</strong><br>Dias de atraso do título mais antigo (até 15 dias = 25 pontos; acima de 90 = 90), mais 10 pontos com 3 ou mais títulos. Cliente marcado como inadimplente crônico fica em 70, no mínimo.</div>' +
        '<div><strong style="color:' + COR_TERM.atendimento + '">Atendimento</strong><br>Insatisfações registradas (pesam pela gravidade e diminuem depois de 90 dias), notas baixas, e SLA vermelho do Zappy <em>depois da revisão da Gamificação</em>, e detratores das pesquisas.</div>' +
        '<div><strong style="color:' + COR_TERM.operacional + '">Operacional</strong><br>Proporção das entregas do Acessórias (últimos 90 dias) que chegam ao cliente e foram entregues com atraso ou venceram sem entrega: guias e declarações com multa, folha, FGTS, DCTFWeb, INSS e envios ao cliente. Tarefas internas (balancete, renovação de certificado, aniversário de sócio, cadastros) não contam. Entrega dentro do prazo técnico ou do prazo legal não é atraso. Só conta com <strong>5 entregas ou mais</strong> no período (com menos, a taxa não é confiável: fica sem dado). Empresa com contrato <strong>Suspenso no Omie</strong> (selo ⏸) também fica fora do Operacional: o atraso dela já pesa no Financeiro.</div>' +
        '<div><strong style="color:' + COR_TERM.tratativas + '">Tratativas</strong><br>Ocorrências <strong>lançadas no módulo Qualidade</strong> (erro, multa, reclamação, atraso, falha…) dos últimos 90 dias e o andamento da tratativa de cada uma. Só entra na média enquanto houver tratativa em aberto. O que se escreve em "Descreva a tratativa" na ficha é plano de ação e <strong>não conta</strong>.</div>' +
      '</div></details>' +
      '<div class="card"><div class="filter-group" style="margin-bottom:14px">' +
        '<span class="filter-label">Buscar</span><input class="gp-input" id="r-busca" placeholder="Nome ou CNPJ" value="' + esc(f.busca) + '">' +
        '<span class="filter-label">Risco</span><select class="gp-select" id="r-nivel">' + opt('AltoMedio', 'Alto e Médio', f.nivel === 'AltoMedio') + opt('Alto', 'Só Alto', f.nivel === 'Alto') + opt('Médio', 'Só Médio', f.nivel === 'Médio') + opt('Baixo', 'Baixo', f.nivel === 'Baixo') + opt('Suspenso', 'Suspensos (fora do risco)', f.nivel === 'Suspenso') + opt('todos', 'Todos', f.nivel === 'todos') + '</select>' +
        '<span class="filter-label">Categoria</span><select class="gp-select" id="r-cat">' + opt('', 'Todas', !f.cat) + ['Diamante', 'Ouro', 'Prata', 'Bronze'].map(function (k) { return opt(k, k, f.cat === k); }).join('') + '</select>' +
        '<span class="filter-label">Pesa mais</span><select class="gp-select" id="r-term">' + opt('', 'Qualquer', !f.term) + ['financeiro', 'atendimento', 'operacional', 'tratativas'].map(function (k) { return opt(k, NOME_TERM[k], f.term === k); }).join('') + '</select>' +
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
        '<td>' + selectMotivoChurn(s) + '</td>' +
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
        (lista.length ? '<div class="table-wrap"><table><thead><tr><th>Cliente</th><th class="c">Entrada</th><th class="c">Saída</th><th class="c">Tipo</th><th class="c">Na base do início</th><th class="c">Como foi classificada</th><th>Motivo do churn</th>' + (decide ? '<th class="c">Decisão</th>' : '') + '</tr></thead><tbody>' + linhas + '</tbody></table></div>' : '<div class="vazio">Nenhuma saída deste tipo no período.</div>') +
      '</div>' +
      '<div class="gp-chart-card"><div class="gp-chart-title">Churn mês a mês — últimos 12 meses</div><div class="gp-chart-wrap"><canvas id="g-churn2"></canvas></div></div>';
    ligarSelectsMotivo('#sec-churn', function () { desenharChurn(); });
    var gm = $('btn-gerenciar-motivos'); if (gm) gm.addEventListener('click', function () { abrirGerenciarMotivosChurn(function () { desenharChurn(); }); });
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
  // ── CHURN POR MOTIVO E FECHAMENTO DO MÊS ─────────────────────────────────────────
  // Cada saída pode receber um motivo da lista de "Motivo do Churn" (a mesma da Gestão de Clientes, gerenciável aqui pelo administrador).
  function normTxt(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function podeClassificarChurn() { return !!(estado.dados && estado.dados.usuario && ['administrador', 'usuario'].indexOf(estado.dados.usuario.papel) >= 0); }
  async function carregarMotivosChurn(forcar) {
    if (!estado.motivosChurn || forcar) { try { estado.motivosChurn = (await api('/api/cs/painel/churn-motivos/motivos')).motivos || []; } catch (e) { estado.motivosChurn = estado.motivosChurn || []; } }
    return estado.motivosChurn;
  }
  /** Motivo de uma saída: o definido no painel; senão o da Gestão de Clientes, se for um motivo da lista. */
  function motivoDaSaida(s) {
    if (s.motivo_churn) return s.motivo_churn;
    var a = normTxt(s.motivo_saida); if (!a) return null;
    var m = (estado.motivosChurn || []).filter(function (x) { return normTxt(x.nome) === a; })[0];
    return m ? m.nome : null;
  }
  function selectMotivoChurn(s) {
    var atual = motivoDaSaida(s), motivos = estado.motivosChurn || [];
    if (!podeClassificarChurn()) return atual ? esc(atual) : '<span class="cinza">sem motivo</span>';
    var achou = false;
    var opt = motivos.map(function (m) { var sel = m.nome === atual; if (sel) achou = true; return '<option value="' + esc(m.nome) + '"' + (sel ? ' selected' : '') + '>' + esc(m.nome) + '</option>'; }).join('');
    if (atual && !achou) opt = '<option value="' + esc(atual) + '" selected>' + esc(atual) + '</option>' + opt;   // motivo desativado depois: continua aparecendo
    return '<select class="gp-select q-motivo" data-id="' + esc(s.id) + '" style="max-width:260px"><option value="">Sem motivo</option>' + opt + '</select>';
  }
  /** Guarda o motivo no servidor e reflete na tela sem recarregar o painel inteiro. */
  async function salvarMotivoChurn(id, motivo, aoTerminar, opcoes) {
    var o = opcoes || {};   // o.novo: motivo digitado em "Outro" (entra na lista e é salvo); o.aoErro(msg): mostra o erro na janela em vez de alert
    var r = await chamarApi('/api/cs/painel/churn-motivos/definir', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o.novo ? { cliente_id: id, novo_motivo: o.novo } : { cliente_id: id, motivo: motivo || null }) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { if (o.aoErro) o.aoErro(j.error || 'Não foi possível salvar o motivo.'); else window.alert(j.error || 'Não foi possível salvar o motivo.'); if (aoTerminar) aoTerminar(false); return; }
    if (o.novo) await carregarMotivosChurn(true);   // o motivo novo já aparece na lista de todas as saídas
    var aplica = function (p) { ((p && p.saidas) || []).forEach(function (s) { if (String(s.id) === String(id)) s.motivo_churn = j.motivo; }); };
    var per = (estado.dados && estado.dados.churn && estado.dados.churn.periodos) || {};
    Object.keys(per).forEach(function (k) { aplica(per[k]); });
    aplica(estado.churnLivre);
    if (aoTerminar) aoTerminar(true);
  }
  /** Janela do "Outro": escreve qual é o motivo; ao incluir, ele entra na lista existente e já fica salvo na saída. */
  function abrirNovoMotivoChurn(id, aoSalvar, aoCancelar) {
    var ov = document.createElement('div'); ov.className = 'qa-overlay'; document.body.appendChild(ov);
    var salvo = false;
    var fechar = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); if (!salvo && aoCancelar) aoCancelar(); };
    ov.innerHTML = '<div class="qa-modal" role="dialog" aria-label="Novo motivo de churn"><div class="qa-modal-topo"><strong>Qual é o motivo do churn?</strong><button type="button" class="qa-x" id="nm-fechar" aria-label="Fechar">✕</button></div>' +
      '<div class="qa-modal-novo"><input id="nm-nome" type="text" maxlength="120" placeholder="Ex.: Churn por mudança de contador para a matriz"><button type="button" class="gp-footer-btn" id="nm-add" style="width:auto">Incluir e salvar</button></div>' +
      '<div class="cinza" style="font-size:12px;margin:6px 2px">O motivo entra na lista de motivos de churn (a mesma da Gestão de Clientes) e já fica salvo nesta saída.</div><div class="pop-erro" id="nm-erro" role="alert"></div></div>';
    $('nm-fechar').addEventListener('click', fechar);
    var campo = $('nm-nome'), botao = $('nm-add');
    var incluir = function () {
      var erro = $('nm-erro'); erro.textContent = '';
      var nome = String(campo.value || '').replace(/\s+/g, ' ').trim();
      if (nome.length < 3) { erro.textContent = 'Escreva qual é o motivo do churn (mínimo de 3 letras).'; return; }
      if (normTxt(nome) === 'outro') { erro.textContent = 'Escreva qual é o motivo em vez de "Outro".'; return; }
      botao.disabled = true;
      salvarMotivoChurn(id, null, function (ok) {
        if (!ok) { botao.disabled = false; return; }
        salvo = true; fechar(); if (aoSalvar) aoSalvar();
      }, { novo: nome, aoErro: function (m) { erro.textContent = m; } });
    };
    botao.addEventListener('click', incluir);
    campo.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); incluir(); } else if (ev.key === 'Escape') fechar(); });
    if (campo.focus) campo.focus();
  }
  function ligarSelectsMotivo(raiz, depois) {
    Array.prototype.forEach.call(document.querySelectorAll(raiz + ' .q-motivo'), function (sel) {
      sel.setAttribute('data-antes', sel.value);
      sel.addEventListener('change', function () {
        var id = sel.getAttribute('data-id');
        if (normTxt(sel.value) === 'outro') {   // "Outro": pede o motivo; cancelar volta para o que estava
          abrirNovoMotivoChurn(id, function () { if (depois) depois(); }, function () { sel.value = sel.getAttribute('data-antes') || ''; });
          return;
        }
        sel.setAttribute('data-antes', sel.value);
        salvarMotivoChurn(id, sel.value, function (ok) { if (ok && depois) depois(); });
      });
    });
  }
  /** Cartão "Churn por motivo": quantas das saídas que contam têm cada motivo. */
  function cartaoMotivosChurn(saidas, tituloExtra) {
    var contam = saidas.filter(function (s) { return s.tipo === 'transferida' && s.na_base; });
    var cont = {}, sem = 0;
    contam.forEach(function (s) { var m = motivoDaSaida(s); if (m) cont[m] = (cont[m] || 0) + 1; else sem++; });
    var lista = Object.keys(cont).map(function (k) { return { nome: k, qtd: cont[k] }; }).sort(function (a, b) { return b.qtd - a.qtd || a.nome.localeCompare(b.nome); });
    var max = Math.max.apply(null, lista.map(function (x) { return x.qtd; }).concat([sem, 1]));
    var linha = function (nome, qtd, cor) {
      return '<tr><td style="white-space:normal">' + nome + '</td><td class="c"><strong>' + qtd + '</strong></td><td class="c">' + (contam.length ? (100 * qtd / contam.length).toFixed(1).replace('.', ',') + '%' : '—') + '</td>' +
        '<td style="min-width:120px"><div style="height:8px;border-radius:4px;background:' + cor + ';width:' + Math.max(3, Math.round(qtd / max * 100)) + '%"></div></td></tr>';
    };
    return '<div class="card"><div class="card-title">Churn por motivo' + (tituloExtra || '') + '</div><div class="card-sub">' + contam.length + ' saída(s) que contam no churn' +
      (sem ? ' · <strong style="color:#b45309">' + sem + ' sem motivo classificado</strong>' : '') + '. O motivo é escolhido na lista da tabela de saídas.' +
      (ehAdminPainel() ? ' <button type="button" class="gp-footer-btn" id="btn-gerenciar-motivos" style="width:auto;padding:3px 10px;display:inline-flex">Gerenciar motivos</button>' : '') + '</div>' +
      (lista.length || sem ? '<div class="table-wrap"><table><thead><tr><th>Motivo</th><th class="c">Saídas</th><th class="c">%</th><th></th></tr></thead><tbody>' +
        lista.map(function (x) { return linha(esc(x.nome), x.qtd, '#dc2626aa'); }).join('') + (sem ? linha('<span class="cinza">Sem motivo classificado</span>', sem, '#9ca3af') : '') + '</tbody></table></div>'
        : '<div class="vazio">Nenhuma saída que conta no período.</div>') + '</div>';
  }
  /** Janela do administrador para incluir, desativar, reativar e excluir motivos de churn (a mesma lista da Gestão de Clientes). */
  async function abrirGerenciarMotivosChurn(aoFechar) {
    var ov = document.createElement('div'); ov.className = 'qa-overlay';
    document.body.appendChild(ov);
    var fechar = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); carregarMotivosChurn(true).then(function () { if (aoFechar) aoFechar(); }); };
    var desenhar = async function () {
      var j = await api('/api/motivos-churn');
      ov.innerHTML = '<div class="qa-modal" role="dialog" aria-label="Gerenciar motivos de churn"><div class="qa-modal-topo"><strong>Gerenciar motivos de churn</strong><button type="button" class="qa-x" id="mc-fechar" aria-label="Fechar">✕</button></div>' +
        '<div class="cinza" style="font-size:12px;margin-bottom:10px">É a mesma lista de "Motivo do Churn" da Gestão de Clientes. Desativar tira o motivo das escolhas, mas mantém nas saídas já classificadas.</div>' +
        '<div class="qa-modal-novo"><input id="mc-novo" type="text" maxlength="120" placeholder="Novo motivo (ex.: Churn por mudança de cidade)"><button type="button" class="gp-footer-btn" id="mc-add" style="width:auto">+ Adicionar</button></div>' +
        '<div class="qa-modal-lista">' + j.motivos.map(function (m) {
          return '<div class="qa-an-linha"><span class="' + (m.ativo ? '' : 'qa-an-inativo') + '" style="flex:1;min-width:0">' + esc(m.nome) + '</span><span class="qa-an-acoes">' +
            '<button type="button" class="gp-footer-btn" data-mtog="' + esc(m.id) + '" data-ativo="' + (m.ativo ? '1' : '0') + '" style="width:auto">' + (m.ativo ? 'Desativar' : 'Reativar') + '</button>' +
            '<button type="button" class="gp-footer-btn qa-excluir" data-mdel="' + esc(m.id) + '" data-nome="' + esc(m.nome) + '" style="width:auto">Excluir</button></span></div>';
        }).join('') + '</div><div class="pop-erro" id="mc-erro" role="alert"></div></div>';
      $('mc-fechar').addEventListener('click', fechar);
      var falha = function (m) { $('mc-erro').textContent = m; };
      var enviar = async function (metodo, url, corpo) {
        var r = await chamarApi(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
        var x = await r.json().catch(function () { return {}; });
        if (!r.ok) { falha(x.error || 'Não foi possível salvar.'); return false; }
        return true;
      };
      $('mc-add').addEventListener('click', async function () {
        var nome = $('mc-novo').value.replace(/\s+/g, ' ').trim();
        if (!nome) { falha('Digite o motivo.'); return; }
        if (await enviar('POST', '/api/motivos-churn', { nome: nome })) desenhar();
      });
      Array.prototype.forEach.call(ov.querySelectorAll('[data-mtog]'), function (b) {
        b.addEventListener('click', async function () { if (await enviar('PATCH', '/api/motivos-churn/' + encodeURIComponent(b.getAttribute('data-mtog')), { ativo: b.getAttribute('data-ativo') !== '1' })) desenhar(); });
      });
      Array.prototype.forEach.call(ov.querySelectorAll('[data-mdel]'), function (b) {
        b.addEventListener('click', async function () {
          if (!window.confirm('Excluir o motivo "' + b.getAttribute('data-nome') + '" da lista? Prefira desativar para manter o histórico.')) return;
          if (await enviar('DELETE', '/api/motivos-churn/' + encodeURIComponent(b.getAttribute('data-mdel')))) desenhar();
        });
      });
    };
    try { await desenhar(); } catch (e) { ov.innerHTML = '<div class="qa-modal"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; }
  }

  // ── Fechamento do mês ────────────────────────────────────────────────────────
  var MES_ABREV = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  async function desenharFechamento(mes) {
    var alvo = $('visao-fechamento'); if (!alvo) return;
    alvo.innerHTML = '<div class="vazio">Carregando…</div>';
    try {
      await carregarMotivosChurn();
      var f = await api('/api/cs/painel/churn-motivos/fechamento' + (mes ? '?mes=' + encodeURIComponent(mes) : ''));
      estado.mesFechamento = f.mes; estado.fechamento = f;
      var pp = f.delta_pp == null ? 'sem mês anterior para comparar' : (f.delta_pp > 0 ? '▲ ' : f.delta_pp < 0 ? '▼ ' : '') + String(Math.abs(f.delta_pp)).replace('.', ',') + ' p.p. vs mês anterior';
      var abas = f.abas.map(function (m, i) {
        return '<button type="button" class="' + (m === f.mes ? 'active' : '') + '" data-mes="' + m + '">' + MES_ABREV[parseInt(m.slice(5, 7), 10) - 1] + (i === f.abas.length - 1 ? '*' : '') + '</button>';
      }).join('');
      var linhas = f.lista.map(function (s) {
        return '<tr><td style="white-space:normal">' + esc(s.nome) + '<div class="sub">' + esc(s.cnpj || '') + '</div></td><td class="c">' + data(s.data_entrada) + '</td><td class="c">' + data(s.data_saida) + '</td><td>' + selectMotivoChurn({ id: s.id, motivo_churn: s.motivo, motivo_saida: null }) + '</td></tr>';
      }).join('');
      var motivos = f.motivos.map(function (m) {
        return '<tr><td style="white-space:normal">' + esc(m.nome) + '</td><td class="c"><strong>' + m.qtd + '</strong></td><td class="c">' + String(m.pct).replace('.', ',') + '%</td></tr>';
      }).join('');
      alvo.innerHTML =
        '<div class="card"><div class="card-title">Fechamento do mês — ' + esc(f.rotulo) + (f.parcial ? ' <span class="cinza" style="font-weight:500">(em andamento, até ' + data(f.fim) + ')</span>' : '') + '</div>' +
          '<div class="card-sub">Base = clientes CNPJ ativos no início do mês · saídas = as que contam como churn (transferidas) · % sobre a base do início do mês</div>' +
          '<div class="tabs" id="abas-fech">' + abas + '</div></div>' +
        '<div class="gp-kpi-row">' +
          kpi('#256050', 'Base no início', f.base, 'clientes CNPJ ativos em ' + data(f.ini)) +
          kpi('#dc2626', 'Churn do mês', f.taxa == null ? '—' : String(f.taxa).replace('.', ',') + '%', f.saidas + ' saída(s) · ' + pp) +
          kpi('#10b981', 'Retenção do mês', f.retencao == null ? '—' : String(f.retencao).replace('.', ',') + '%', 'clientes que seguiram ativos') +
          kpi('#7c3aed', 'Saíram com menos de 90 dias', f.menos_de_90_pct == null ? '—' : String(f.menos_de_90_pct).replace('.', ',') + '%', f.menos_de_90_dias + ' de ' + f.saidas + ' desligados') +
        '</div>' +
        '<div class="gp-kpi-row">' +
          kpi('#6b7280', 'Fora do churn', f.fora_do_churn.baixas + f.fora_do_churn.outras_saidas, 'baixas e outras saídas') +
          kpi('#d97706', 'A confirmar', f.fora_do_churn.a_confirmar, 'sem motivo no Acessórias nem resposta da Receita') +
          kpi('#0f766e', 'Com motivo classificado', f.classificadas + ' de ' + f.saidas, f.sem_motivo ? f.sem_motivo + ' ainda sem motivo' : 'tudo classificado') +
          kpi('#2563eb', 'Mês anterior', f.taxa_anterior == null ? '—' : String(f.taxa_anterior).replace('.', ',') + '%', f.saidas_anterior + ' saída(s) em ' + f.base_anterior + ' clientes') +
        '</div>' +
        '<div class="card"><div class="card-title">Leitura do mês</div><ul style="margin:6px 0 0 18px;line-height:1.7;font-size:13px">' + f.leitura.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></div>' +
        '<div class="card"><div class="card-title">Churn por motivo no mês</div>' +
          (f.motivos.length ? '<div class="table-wrap"><table><thead><tr><th>Motivo</th><th class="c">Saídas</th><th class="c">%</th></tr></thead><tbody>' + motivos + '</tbody></table></div>' : '<div class="vazio">Nenhuma saída classificada neste mês ainda.</div>') +
          (ehAdminPainel() ? '<div style="margin-top:10px"><button type="button" class="gp-footer-btn" id="btn-gerenciar-motivos-f" style="width:auto">Gerenciar motivos</button></div>' : '') + '</div>' +
        '<div class="card"><div class="card-title">Saídas do mês</div><div class="card-sub">Classifique o motivo de cada saída.</div>' +
          (f.lista.length ? '<div class="table-wrap"><table><thead><tr><th>Cliente</th><th class="c">Entrada</th><th class="c">Saída</th><th>Motivo do churn</th></tr></thead><tbody>' + linhas + '</tbody></table></div>' : '<div class="vazio">Nenhuma saída que conta no mês.</div>') + '</div>';
      Array.prototype.forEach.call(document.querySelectorAll('#abas-fech button'), function (b) { b.addEventListener('click', function () { desenharFechamento(b.getAttribute('data-mes')); }); });
      var g = $('btn-gerenciar-motivos-f'); if (g) g.addEventListener('click', function () { abrirGerenciarMotivosChurn(function () { desenharFechamento(f.mes); }); });
      ligarSelectsMotivo('#visao-fechamento', function () { desenharFechamento(f.mes); desenharChurn(); });
    } catch (e) { alvo.innerHTML = '<div class="card"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; }
  }

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

// ── ATENDIMENTO (módulo) ─────────────────────────────────────────────────────
  // Clientes ativos com os atendimentos do Zappy e os e-mails dos últimos 180 dias; ao clicar, a lista de atendimentos e os e-mails por destinatário.
  function filtroAtend() { return estado.filtroAtend || (estado.filtroAtend = { busca: '', soSem: false, pag: 1 }); }
  var ROT_DEST_GRUPO = 'grupo do escritório: pode ter sido respondido por outro e-mail';
  /** Texto de passar o mouse: e-mails por destinatário e quais estão sem resposta. */
  function dicaEmails(em) {
    if (!em) return 'Sem e-mails deste cliente na leitura';
    var ds = (em.destinatarios || []).slice().sort(function (a, b) { return b.recebidos - a.recebidos || a.nome.localeCompare(b.nome); });
    var l = [em.recebidos + ' e-mail(s) recebido(s) · ' + em.sem_resposta + ' sem resposta', ''];
    if (ds.length) { l.push('Recebidos por destinatário:'); ds.forEach(function (d) { l.push('• ' + d.nome + (d.grupo ? ' (grupo)' : '') + ': ' + d.recebidos); }); }
    var sem = ds.filter(function (d) { return d.sem > 0; });
    if (em.comp_recebidos) {
      l.push('', '+ ' + em.comp_recebidos + ' e-mail(s) de contatos que atendem várias empresas' + (em.comp_sem ? ' (' + em.comp_sem + ' sem resposta)' : '') + ', não somados acima');
      (em.comp_destinatarios || []).slice().sort(function (a, b) { return b.recebidos - a.recebidos || a.nome.localeCompare(b.nome); }).slice(0, 8).forEach(function (d) { l.push('• ' + d.nome + ': ' + d.recebidos); });
    }
    l.push('');
    if (sem.length) { l.push('Sem resposta:'); sem.forEach(function (d) { l.push('• ' + d.nome + ': ' + d.sem + (d.grupo ? ' (' + ROT_DEST_GRUPO + ')' : '')); }); }
    else l.push('Nenhum destinatário com e-mail sem resposta');
    return l.join('\n');
  }
  function linhasAtend() {
    var a = estado.atend, f = filtroAtend(), b = f.busca.trim().toLowerCase();
    var lista = ((a && a.clientes) || []).filter(function (c) {
      if (f.soSem && !(c.email && c.email.sem_resposta > 0)) return false;
      if (b && (c.nome || '').toLowerCase().indexOf(b) < 0 && soDig(c.cnpj).indexOf(b.replace(/\D/g, '') || '§') < 0) return false;
      return true;
    });
    lista.sort(function (x, y) { return (x.nome || '').localeCompare(y.nome || '', 'pt-BR', { sensitivity: 'base' }); });
    return lista;
  }
  function desenharAtendimento() {
    var alvo = $('sec-atendimento'); if (!alvo) return;
    var a = estado.atend, f = filtroAtend();
    if (!a) { alvo.innerHTML = '<div class="card"><div class="vazio">Não foi possível carregar o módulo Atendimento agora.</div></div>'; return; }
    var todos = a.clientes || [], lista = linhasAtend();
    var pag = Math.max(1, Math.ceil(lista.length / ANALISE_POR_PAGINA)); if (f.pag > pag) f.pag = pag; if (f.pag < 1) f.pag = 1;
    var totAt = 0, totRec = 0, totSem = 0, comSem = 0;
    todos.forEach(function (c) { totAt += c.atendimentos; if (c.email) { totRec += c.email.recebidos; totSem += c.email.sem_resposta; if (c.email.sem_resposta > 0) comSem++; } });
    var temEmail = !!a.email_lido_em;
    var corpo = lista.slice((f.pag - 1) * ANALISE_POR_PAGINA, f.pag * ANALISE_POR_PAGINA).map(function (c) {
      var em = c.email, tip = esc(dicaEmails(em));
      return '<tr><td style="white-space:normal;min-width:220px"><button class="link" data-atend="' + esc(c.id) + '">' + esc(c.nome) + '</button><div class="sub">' + esc(c.cnpj || '') + '</div></td>' +
        '<td class="c">' + pillCat(c) + '</td>' +
        '<td class="c"><strong>' + c.atendimentos + '</strong></td>' +
        '<td class="c">' + (c.sla_vermelho ? '<span style="color:#dc2626"><strong>' + c.sla_vermelho + '</strong></span>' : '0') + '</td>' +
        '<td class="c">' + (c.notas_baixas ? '<span style="color:#dc2626"><strong>' + c.notas_baixas + '</strong></span>' : '0') + '</td>' +
        '<td class="c">' + data(c.ultimo) + '</td>' +
        '<td class="c"><span class="hon-sug" tabindex="0" title="' + tip + '" aria-label="' + tip + '">' + (em ? em.recebidos + (em.comp_recebidos ? ' <span class="cinza" title="E-mails de contatos que atendem várias empresas, não somados">+' + em.comp_recebidos + '</span>' : '') : '<span class="cinza">—</span>') + '</span></td>' +
        '<td class="c"><span class="hon-sug" tabindex="0" title="' + tip + '" aria-label="' + tip + '">' + (em ? (em.sem_resposta ? '<strong style="color:#dc2626">' + em.sem_resposta + '</strong>' : '0') : '<span class="cinza">—</span>') + '</span></td></tr>';
    }).join('');
    alvo.innerHTML =
      '<div class="gp-kpi-row">' +
        kpi('#256050', 'Clientes ativos', todos.length, 'com atendimento ou não, nos últimos ' + a.janela_dias + ' dias') +
        kpi('#0f766e', 'Atendimentos (' + a.janela_dias + ' dias)', totAt, 'conversas no Zappy') +
        kpi('#b45309', 'E-mails recebidos', temEmail ? totRec : '—', temEmail ? 'de clientes, nos últimos ' + (a.email_janela_dias || 180) + ' dias' : 'leitura de e-mails ainda não carregada') +
        kpi('#b91c1c', 'E-mails sem resposta', temEmail ? totSem : '—', temEmail ? comSem + ' cliente(s) com e-mail sem resposta' : 'aguardando a primeira leitura') +
      '</div>' +
      '<div class="nota"><strong>Como ler.</strong> Atendimentos: conversas do Zappy com o cliente, depois da revisão da Gamificação. E-mails: leitura dos cabeçalhos das caixas do escritório (assunto e texto nunca são lidos); ' +
        'passe o mouse nos números de e-mail para ver quantos e-mails chegaram para cada destinatário e quais estão sem resposta. Os endereços de grupo (dptofiscal@, dptocontabil@, cs@ e outros) podem ser respondidos por outro endereço do escritório: ' +
        'a resposta de qualquer pessoa encerra a espera.' + (temEmail ? ' Última leitura de e-mails: ' + esc(new Date(a.email_lido_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })) + '.' : '') + '</div>' +
      '<div class="card"><div class="filter-group" style="margin-bottom:14px"><span class="filter-label">Buscar</span><input class="gp-input" id="at-busca" placeholder="Empresa ou CNPJ" value="' + esc(f.busca) + '">' +
        '<label style="font-size:12px;color:var(--text2);display:flex;gap:6px;align-items:center"><input type="checkbox" id="at-sem"' + (f.soSem ? ' checked' : '') + '> só com e-mail sem resposta</label></div>' +
        '<div class="card-sub">' + lista.length + ' cliente(s) · ordem alfabética. Clique na empresa para ver os atendimentos e os e-mails.</div>' +
        (lista.length ? '<div class="table-wrap"><table class="tab-analise"><colgroup><col style="width:30%"><col style="width:10%"><col style="width:10%"><col style="width:9%"><col style="width:9%"><col style="width:12%"><col style="width:10%"><col style="width:10%"></colgroup>' +
          '<thead><tr><th>Razão social</th><th class="c">Categoria</th><th class="c">Atendimentos</th><th class="c">SLA vermelho</th><th class="c">Notas baixas</th><th class="c">Último atendimento</th><th class="c">E-mails recebidos</th><th class="c">Sem resposta</th></tr></thead><tbody>' + corpo + '</tbody></table></div>' + paginacaoHtml(lista.length, f.pag, ANALISE_POR_PAGINA)
          : '<div class="vazio">Nenhum cliente neste filtro.</div>') + '</div>';
    var campo = $('at-busca'); if (campo) campo.addEventListener('input', function () { f.busca = campo.value; f.pag = 1; var pos = campo.selectionStart; desenharAtendimento(); var n = $('at-busca'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* sem seleção */ } });
    var ss = $('at-sem'); if (ss) ss.addEventListener('change', function () { f.soSem = ss.checked; f.pag = 1; desenharAtendimento(); });
    Array.prototype.forEach.call(document.querySelectorAll('#sec-atendimento [data-atend]'), function (bt) { bt.addEventListener('click', function () { abrirFichaAtendimento(bt.getAttribute('data-atend')); }); });
    Array.prototype.forEach.call(document.querySelectorAll('#sec-atendimento [data-pag]'), function (bt) {
      bt.addEventListener('click', function () {
        f.pag = parseInt(bt.getAttribute('data-pag'), 10) || 1; desenharAtendimento();
        var topo = document.querySelector('#sec-atendimento .filter-group'); if (topo && topo.scrollIntoView) topo.scrollIntoView({ block: 'start' });
      });
    });
  }
  /** Tabela data, setor, atendente, nota e SLA (a mesma que ficava na ficha da Gestão da Permanência). */
  function tabelaAtendimentos(tickets) {
    if (!tickets.length) return '<div class="linha-item"><span class="x">Nenhum atendimento no Zappy nos últimos 180 dias.</span></div>';
    return '<div class="table-wrap"><table><thead><tr><th>Data</th><th>Setor</th><th>Atendente</th><th class="c">Nota</th><th class="c">SLA</th></tr></thead><tbody>' + tickets.map(function (t) {
      var cor = { vermelho: '#dc2626', amarelo: '#d97706', verde: '#10b981' }[t.pior_status] || '#9ca3af';
      return '<tr><td>' + data(t.abertura) + '</td><td>' + esc(t.departamento || '—') + '</td><td>' + esc(t.analista || '—') + '</td><td class="c">' + (t.nota_avaliacao != null ? t.nota_avaliacao : '—') + '</td><td class="c"><span class="pill" style="color:' + cor + ';border-color:' + cor + '55;background:' + cor + '14">' + esc(t.pior_status || '—') + '</span></td></tr>';
    }).join('') + '</tbody></table></div>';
  }
  function linhasDestinatarios(ds) {
    return '<div class="table-wrap"><table><thead><tr><th>Destinatário</th><th class="c">Tipo</th><th class="c">E-mails recebidos</th><th class="c">Sem resposta</th></tr></thead><tbody>' + ds.map(function (d) {
      return '<tr><td>' + esc(d.nome) + '</td><td class="c">' + (d.grupo ? '<span class="cinza" title="' + esc(ROT_DEST_GRUPO) + '">grupo</span>' : 'pessoa') + '</td><td class="c">' + d.recebidos + '</td>' +
        '<td class="c">' + (d.sem ? '<strong style="color:#dc2626" title="' + esc(d.grupo ? ROT_DEST_GRUPO : 'Nenhum e-mail do escritório para este contato depois desse(s)') + '">' + d.sem + '</strong>' : '0') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
  }
  function ordenaDest(l) { return (l || []).slice().sort(function (a, b) { return b.sem - a.sem || b.recebidos - a.recebidos || a.nome.localeCompare(b.nome); }); }
  /** E-mails exclusivos do cliente e, à parte, os de contatos que atendem várias empresas (cada um com a relação por destinatário). */
  function tabelaDestinatarios(em) {
    var ds = ordenaDest(em && em.destinatarios), cds = ordenaDest(em && em.comp_destinatarios), comp = (em && em.comp_recebidos) || 0;
    if (!ds.length && !comp) return '<div class="linha-item"><span class="x">Sem e-mails deste cliente na leitura.</span></div>';
    var h = ds.length ? linhasDestinatarios(ds) : '<div class="linha-item"><span class="x">Nenhum e-mail exclusivo deste cliente.</span></div>';
    if (comp) {
      h += '<div class="ficha-sec" style="margin-top:14px">De contatos que atendem várias empresas (' + comp + (em.comp_sem ? ', ' + em.comp_sem + ' sem resposta' : '') + ')</div>' +
        '<div class="cinza" style="font-size:12px;margin-bottom:6px">Sócio, contador ou familiar ligado a mais de uma empresa: não dá para saber de qual delas é o e-mail, então não entram no total acima nem inflam cada empresa.</div>' +
        (cds.length ? linhasDestinatarios(cds) : '<div class="linha-item"><span class="x">A relação por destinatário aparece na próxima leitura de e-mails (segunda-feira, 08:30).</span></div>');
    }
    return h;
  }
  async function abrirFichaAtendimento(id) {
    document.querySelector('.ficha-box').classList.add('larga');
    $('ficha').style.display = 'flex';
    $('ficha-nome').textContent = 'Carregando…'; $('ficha-sub').textContent = ''; $('ficha-passo').style.display = 'none'; $('ficha-corpo').innerHTML = '';
    try {
      var f = await api('/api/cs/painel/atendimento/' + encodeURIComponent(id));
      var c = f.cliente, t = f.tickets, em = f.email;
      var vermelhos = t.filter(function (x) { return x.pior_status === 'vermelho'; }).length;
      var notasBaixas = t.filter(function (x) { return x.nota_avaliacao != null && x.nota_avaliacao <= 2; }).length;
      $('ficha-nome').textContent = c.nome;
      $('ficha-sub').innerHTML = esc(c.cnpj || '') + (c.grupo ? ' · Grupo ' + esc(c.grupo) : '') + (c.unidade ? ' · ' + esc(c.unidade) : '') + ' · cliente desde ' + data(c.entrada);
      var temEmail = !!f.email_lido_em;
      var tip = esc(dicaEmails(em));
      var blocoTip = function (t1, v, det, cor) { return bloco(t1, v, det, cor).replace('<div class="bloco">', '<div class="bloco" title="' + tip + '">'); };
      $('ficha-corpo').innerHTML =
        '<div class="blocos">' + bloco('Atendimentos (' + f.janela_dias + ' dias)', t.length, 'conversas no Zappy', null) +
          bloco('SLA vermelho', vermelhos, 'antes da revisão da Gamificação', vermelhos ? '#dc2626' : null) +
          bloco('Notas baixas', notasBaixas, 'nota 1 ou 2', notasBaixas ? '#dc2626' : null) +
          blocoTip('E-mails recebidos', temEmail ? (em ? em.recebidos : 0) : '—', temEmail ? 'últimos ' + (f.email_janela_dias || 180) + ' dias' + (em && em.comp_recebidos ? ' · +' + em.comp_recebidos + ' de contatos compartilhados' : '') : 'leitura ainda não carregada', null) +
          blocoTip('E-mails sem resposta', temEmail ? (em ? em.sem_resposta : 0) : '—', temEmail ? 'passe o mouse para ver por destinatário' : '', em && em.sem_resposta ? '#dc2626' : null) + '</div>' +
        '<div class="ficha-sec">Atendimentos (Zappy, ' + f.janela_dias + ' dias)</div>' + tabelaAtendimentos(t) +
        '<div class="ficha-sec">E-mails por destinatário</div>' + tabelaDestinatarios(em) +
        '<div class="nota" style="margin-top:10px">Os e-mails vêm da leitura dos cabeçalhos das caixas do escritório' + (temEmail ? ' (última leitura em ' + esc(new Date(f.email_lido_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })) + ')' : '') +
        '; assunto e texto nunca são lidos. Um e-mail conta como sem resposta quando ninguém do escritório escreveu para aquele contato depois dele, em nenhuma caixa. Endereços de grupo (dptofiscal@, dptocontabil@, contabil.fiscal@, escritorial@, gestao@, pralegal@, hands@, legalizacao@, deptopessoal@, dctfweb@, cs@) podem ser respondidos por outro endereço.</div>';
    } catch (e) { $('ficha-nome').textContent = 'Não foi possível abrir o atendimento'; $('ficha-corpo').innerHTML = '<div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div>'; }
  }

  // ── QUALIDADE: considerações por cliente (ficha) e módulo por analista ───────────
  // Registro feito na ficha do cliente pelo Sucesso do Cliente / Time Operacional (tipo, departamentos, descrição, analista e prazo).
  // O nome do analista vem sempre da lista de analistas (renomear lá renomeia aqui). Entra no termômetro de Atendimento do risco.
  var ROT_STATUS_Q = { aberto: 'Aberto', em_tratamento: 'Em tratamento', finalizada: 'Finalizada · validar', resolvido: 'Resolvido', cancelado: 'Cancelado', vencido: 'Vencido' };
  var COR_STATUS_Q = { aberto: '#b45309', em_tratamento: '#2563eb', finalizada: '#7c3aed', resolvido: '#166534', cancelado: '#6b7280', vencido: '#b91c1c' };
  var ROT_ACAO_Q = { nota: 'Nota', iniciada: 'Iniciou a tratativa', finalizada: 'Finalizou', devolvida: 'Devolvida ao analista', validada: 'Encerrada pela liderança', liberada: 'Aberta para o analista', analista_encerrou: 'Analista encerrou a tratativa', gestor_validou: 'Gestor validou', encerrada: 'Processo encerrado' };
  /** Linha do tempo (notas e eventos) de um registro. */
  function notasHtml(r) {
    var n = r.notas || []; if (!n.length) return '';
    return '<div class="qa-reg-trat">' + n.map(function (x) {
      return '<div><strong>' + esc(ROT_ACAO_Q[x.acao] || x.acao) + '</strong> · ' + data(x.em) + (x.por ? ' · ' + esc(x.por) : '') + (x.texto ? ': ' + esc(x.texto) : '') + '</div>';
    }).join('') + '</div>';
  }
  function pillStatusQ(sit) {
    var c = COR_STATUS_Q[sit] || '#6b7280';
    return '<span class="pill" style="color:' + c + ';border-color:' + c + '55;background:' + c + '14">' + esc(ROT_STATUS_Q[sit] || sit) + '</span>';
  }
  function hojeIsoLocal() {
    var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function usuarioLogadoNome() { try { var u = JSON.parse(ls(K_USER) || 'null'); return (u && u.name) || ''; } catch (e) { return ''; } }
  function ehAdminPainel() { return !!(estado.dados && estado.dados.usuario && estado.dados.usuario.papel === 'administrador'); }

  async function carregarOpcoesQ(forcarAnalistas) {
    if (!estado.qOpcoes) estado.qOpcoes = await api('/api/cs/painel/qualidade/opcoes');
    if (!estado.qAnalistas || forcarAnalistas) estado.qAnalistas = (await api('/api/cs/painel/qualidade/analistas?ativo=true')).analistas;
    return estado.qOpcoes;
  }

  /** LAYOUT ANTIGO guardado (17/10/2026): lista de registros sem recolher, com "Analista:". Também na tag Git consideracoes-sucesso-time-operacional-antigo. */
  function listaRegistrosQAntigo(regs) {
    if (!regs.length) return '<div class="linha-item"><span class="x">Nenhuma consideração registrada para este cliente.</span></div>';
    return regs.map(function (r) {
      return '<div class="qa-reg"><div class="qa-reg-topo">' + pillStatusQ(r.situacao) + ' <strong>' + esc(r.tipo) + '</strong> <span class="cinza">· ' + esc((r.departamentos || []).join(', ')) + '</span></div>' +
        '<div class="qa-reg-txt">' + esc(r.detalhe) + '</div>' +
        '<div class="qa-reg-rod">Analista: <strong>' + esc(r.analista_nome || '—') + '</strong> · lançado em ' + data(r.criado_em) + ' por ' + esc(r.criado_por || '—') + ' · prazo ' + data(r.prazo) +
          (r.resolvido_em ? ' · resolvido em ' + data(r.resolvido_em) : '') + '</div>' +
        (r.tratativa ? '<div class="qa-reg-trat"><strong>Tratativa:</strong> ' + esc(r.tratativa) + '</div>' : '') + notasHtml(r) + '</div>';
    }).join('');
  }

  /** LAYOUT ANTIGO guardado (17/10/2026): Tipo, Analista e Prazo na mesma linha; "Descreva a ocorrência" embaixo, em largura total. */
  function formularioQAntigo(o) {
    var optTipos = '<option value="">Selecione</option>' + o.tipos.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('');
    var optAn = '<option value="">Selecione</option>' + (estado.qAnalistas || []).map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.nome) + '</option>'; }).join('');
    var deps = o.departamentos.map(function (d) { return '<label class="qa-dep"><input type="checkbox" class="qa-dep-ck" value="' + esc(d) + '"> ' + esc(d) + '</label>'; }).join('');
    return '<div class="qa-form">' +
      '<div class="qa-linha">' +
        '<div class="qa-campo"><label for="qa-tipo">Tipo de registro <span class="req">*</span>' + (ehAdminPainel() ? ' <a href="#" id="qa-editar-tipos" class="qa-lnk">(editar lista)</a>' : '') + '</label><select id="qa-tipo">' + optTipos + '</select></div>' +
        '<div class="qa-campo"><label for="qa-analista">Analista <span class="req">*</span>' + (ehAdminPainel() ? ' <a href="#" id="qa-editar-an" class="qa-lnk">(editar lista)</a>' : '') + '</label><select id="qa-analista">' + optAn + '</select></div>' +
        '<div class="qa-campo"><label for="qa-prazo">Prazo para execução <span class="req">*</span></label><input type="date" id="qa-prazo" min="' + hojeIsoLocal() + '"></div>' +
      '</div>' +
      '<div class="qa-campo"><label>Departamentos envolvidos <span class="req">*</span></label><div class="qa-deps"><label class="qa-dep"><input type="checkbox" id="qa-dep-todos"> <strong>Todos</strong></label>' + deps + '</div></div>' +
      '<div class="qa-campo"><label for="qa-detalhe">Descreva a ocorrência <span class="req">*</span> <span class="cinza" id="qa-cont">0/' + o.max_detalhe + '</span></label>' +
        '<textarea id="qa-detalhe" maxlength="' + o.max_detalhe + '" rows="3" placeholder="Ex.: guia do Simples enviada com valor errado; cliente pagou a diferença e pediu retificação."></textarea></div>' +
      '<div class="qa-acoes"><button type="button" class="login-btn" id="qa-salvar" style="width:auto;margin:0;padding:9px 22px">Salvar</button>' +
        '<span class="cinza">Registra com a data de hoje e o seu nome (' + esc(usuarioLogadoNome() || 'você') + ').</span></div>' +
      '<div class="pop-erro" id="qa-erro" role="alert"></div></div>';
  }

  /** Cartão de um plano de ação (registro feito na ficha). */
  function cartaoRegistroQ(r) {
    return '<div class="qa-reg"><div class="qa-reg-topo">' + pillStatusQ(r.situacao) + ' <strong>' + esc(r.tipo) + '</strong> <span class="cinza">· ' + esc((r.departamentos || []).join(', ')) + '</span></div>' +
      '<div class="qa-reg-txt">' + esc(r.detalhe) + '</div>' +
      '<div class="qa-reg-rod">Responsável: <strong>' + esc(r.analista_nome || '—') + '</strong> · lançado em ' + data(r.criado_em) + ' por ' + esc(r.criado_por || '—') + ' · prazo ' + data(r.prazo) +
        (r.resolvido_em ? ' · resolvido em ' + data(r.resolvido_em) : '') + '</div>' +
      (r.tratativa ? '<div class="qa-reg-trat"><strong>Tratativa:</strong> ' + esc(r.tratativa) + '</div>' : '') + notasHtml(r) + '</div>';
  }
  function maisRecenteQ(a, b) { return String(b.criado_em || '').localeCompare(String(a.criado_em || '')); }
  /** Planos de ação da ficha: só o mais recente aparece; os anteriores ficam recolhidos sob uma seta. */
  function listaRegistrosQ(regs) {
    var planos = (regs || []).filter(function (r) { return r.origem !== 'modulo'; }).sort(maisRecenteQ);
    if (!planos.length) return '<div class="linha-item"><span class="x">Nenhum plano de ação registrado para este cliente.</span></div>';
    return recolhivelQ(planos);
  }
  /** Lista com o mais recente à vista e os anteriores recolhidos sob uma seta (<details>). */
  function recolhivelQ(lista, cartao) {
    cartao = cartao || cartaoRegistroQ;
    var h = cartao(lista[0]);
    if (lista.length > 1) h += '<details class="qa-mais"><summary><span class="sp">▸</span> ' + (lista.length - 1) + (lista.length - 1 === 1 ? ' registro anterior' : ' registros anteriores') + '</summary>' + lista.slice(1).map(cartao).join('') + '</details>';
    return h;
  }
  /** Seção Qualidade da ficha: as ocorrências LANÇADAS NO MÓDULO Qualidade (origem "modulo"), com tipo, departamentos, descrição, responsável, prazo e andamento. */
  function listaOcorrenciasQ(regs) {
    var oc = (regs || []).filter(function (r) { return r.origem === 'modulo' && r.status !== 'cancelado'; }).sort(maisRecenteQ);
    if (!oc.length) return '<div class="linha-item"><span class="x">Nenhuma ocorrência lançada no módulo Qualidade para este cliente.</span></div>';
    return recolhivelQ(oc, cartaoOcorrenciaQ);
  }
  /** Seção Acessórias da ficha: as obrigações que venceram sem entrega ou foram entregues com atraso. */
  function tabelaAcessorias(itens) {
    if (!itens.length) return '<div class="linha-item"><span class="x">Nenhuma obrigação em aberto ou atrasada nos últimos 90 dias.</span></div>';
    return '<div class="table-wrap"><table><thead><tr><th>Obrigação</th><th class="c">Competência</th><th class="c">Prazo</th><th class="c">Situação</th></tr></thead><tbody>' + itens.map(function (i) {
      var venc = i.situacao === 'vencida', cor = venc ? '#dc2626' : '#d97706';
      return '<tr><td style="white-space:normal">' + esc(i.nome) + '</td><td class="c">' + esc(i.competencia || '—') + '</td><td class="c">' + data(i.atraso || i.prazo) + '</td>' +
        '<td class="c"><span class="pill" style="color:' + cor + ';border-color:' + cor + '55;background:' + cor + '14">' + (venc ? 'Vencida sem entrega' : 'Entregue com atraso' + (i.entrega ? ' em ' + data(i.entrega) : '')) + '</span></td></tr>';
    }).join('') + '</tbody></table></div>';
  }

  /** Formulário do plano de ação: só os Departamentos em cima (sem tipo de registro); "Descreva a tratativa" ao lado do Responsável e do Prazo. */
  function formularioQ(o) {
    var respLista = (estado.qAnalistas || []).map(function (a) { return '<label class="qa-dep"><input type="checkbox" class="qa-resp-ck" value="' + esc(a.id) + '" data-nome="' + esc(a.nome) + '"> ' + esc(a.nome) + '</label>'; }).join('');
    var deps = o.departamentos.map(function (d) { return '<label class="qa-dep"><input type="checkbox" class="qa-dep-ck" value="' + esc(d) + '"> ' + esc(d) + '</label>'; }).join('');
    return '<div class="qa-form">' +
      '<div class="qa-linha">' +
        '<div class="qa-campo qa-deps-campo"><label>Departamentos envolvidos <span class="req">*</span></label><div class="qa-deps"><label class="qa-dep"><input type="checkbox" id="qa-dep-todos"> <strong>Todos</strong></label>' + deps + '</div></div>' +
      '</div>' +
      '<div class="qa-grade">' +
        '<div class="qa-campo qa-larga"><label for="qa-detalhe">Descreva a tratativa: <span class="req">*</span> <span class="cinza" id="qa-cont">0/' + o.max_detalhe + '</span></label>' +
          '<textarea id="qa-detalhe" maxlength="' + o.max_detalhe + '" rows="4" placeholder="Ex.: plano de ação sobre o que aparece em Sinais de atenção: guia retificada, cliente avisado, conferência dobrada no fechamento."></textarea></div>' +
        '<div class="qa-lateral">' +
          '<div class="qa-campo"><label>Responsável(is) <span class="req">*</span>' + (ehAdminPainel() ? ' <a href="#" id="qa-editar-an" class="qa-lnk">(editar lista)</a>' : '') + '</label>' +
            '<details class="qa-multi" id="qa-resp"><summary id="qa-resp-rot">Selecione</summary><div class="qa-multi-lista">' + (respLista || '<span class="cinza">Nenhum analista ativo na lista.</span>') + '</div></details></div>' +
          '<div class="qa-campo"><label for="qa-prazo">Prazo para execução <span class="req">*</span></label><input type="date" id="qa-prazo" min="' + hojeIsoLocal() + '"></div>' +
        '</div>' +
      '</div>' +
      '<div class="qa-acoes"><button type="button" class="login-btn" id="qa-salvar" style="width:auto;margin:0;padding:9px 22px">Salvar</button>' +
        '<span class="cinza">Registra com a data de hoje e o seu nome (' + esc(usuarioLogadoNome() || 'você') + '). Plano de ação: não entra no card Tratativa nem no risco de churn.</span></div>' +
      '<div class="pop-erro" id="qa-erro" role="alert"></div></div>';
  }

  async function montarConsideracoes(c) {
    var alvo = $('qa-secao'); if (!alvo) return;
    alvo.innerHTML = '<div class="cinza">Carregando…</div>';
    try {
      var o = await carregarOpcoesQ();
      var lista = await api('/api/cs/painel/qualidade/cliente/' + encodeURIComponent(c.id));
      alvo.innerHTML = formularioQ(o) + '<div class="qa-lista">' + listaRegistrosQ(lista.registros) + '</div>';
      var oc = $('qa-ocorrencias');
      if (oc) { oc.innerHTML = listaOcorrenciasQ(lista.registros); ligarAcoesOcorrenciaQ('#qa-ocorrencias', function () { estado.qResumo = null; montarConsideracoes(c); }); }
      var cont = $('qa-cont'), det = $('qa-detalhe');
      det.addEventListener('input', function () { cont.textContent = det.value.length + '/' + o.max_detalhe; });
      var todos = $('qa-dep-todos');
      todos.addEventListener('change', function () { Array.prototype.forEach.call(document.querySelectorAll('.qa-dep-ck'), function (k) { k.checked = todos.checked; }); });
      Array.prototype.forEach.call(document.querySelectorAll('.qa-dep-ck'), function (k) {
        k.addEventListener('change', function () { todos.checked = document.querySelectorAll('.qa-dep-ck:checked').length === o.departamentos.length; });
      });
      // Responsáveis: lista com caixas de marcar (pode escolher mais de um); o texto do campo resume a escolha e a lista fecha ao clicar fora.
      var resumoResp = function () {
        var marc = Array.prototype.filter.call(document.querySelectorAll('.qa-resp-ck'), function (k) { return k.checked; });
        var rot = $('qa-resp-rot'); if (rot) rot.textContent = !marc.length ? 'Selecione' : marc.length === 1 ? marc[0].getAttribute('data-nome') : marc.length + ' responsáveis';
      };
      Array.prototype.forEach.call(document.querySelectorAll('.qa-resp-ck'), function (k) { k.addEventListener('change', resumoResp); });
      var fechaResp = function (ev) { var d = $('qa-resp'); if (!d) { document.removeEventListener('click', fechaResp); return; } if (d.open && !(d.contains && d.contains(ev.target))) d.open = false; };
      document.addEventListener('click', fechaResp);
      var ed = $('qa-editar-an'); if (ed) ed.addEventListener('click', function (ev) { ev.preventDefault(); abrirGerenciarAnalistas(function () { montarConsideracoes(c); }); });
      $('qa-salvar').addEventListener('click', async function () {
        var erro = $('qa-erro'); erro.textContent = '';
        var deps = Array.prototype.map.call(document.querySelectorAll('.qa-dep-ck:checked'), function (k) { return k.value; });
        var resp = Array.prototype.filter.call(document.querySelectorAll('.qa-resp-ck'), function (k) { return k.checked; }).map(function (k) { return k.value; });
        var corpo = { cliente_id: c.id, departamentos: deps, detalhe: det.value, analistas_ids: resp, prazo: $('qa-prazo').value };
        if (!deps.length) { erro.textContent = 'Escolha ao menos um departamento envolvido.'; return; }
        if (!resp.length) { erro.textContent = 'Escolha ao menos um responsável.'; return; }
        if (!corpo.prazo) { erro.textContent = 'Informe o prazo para execução.'; return; }
        if (det.value.trim().length < 5) { erro.textContent = 'Descreva a tratativa (mínimo de 5 caracteres).'; return; }
        $('qa-salvar').disabled = true;
        try {
          var resp = await chamarApi('/api/cs/painel/qualidade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
          var j = await resp.json().catch(function () { return {}; });
          if (!resp.ok) { erro.textContent = j.error || 'Não foi possível salvar.'; $('qa-salvar').disabled = false; return; }
          estado.qResumo = null;       // o módulo Qualidade recarrega ao abrir
          await montarConsideracoes(c);
        } catch (e) { erro.textContent = 'Sem conexão com o servidor. Tente de novo.'; $('qa-salvar').disabled = false; }
      });
    } catch (e) { alvo.innerHTML = '<div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div>'; }
  }

  /** Janela simples para o administrador editar o nome completo, ativar/desativar e incluir analistas (a mesma lista do módulo Atendimento). */
  async function abrirGerenciarAnalistas(aoFechar) {
    var ov = document.createElement('div'); ov.className = 'qa-overlay';
    document.body.appendChild(ov);
    var fechar = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); estado.qAnalistas = null; if (aoFechar) aoFechar(); };
    var desenhar = async function () {
      var j = await api('/api/cs/painel/qualidade/analistas');
      ov.innerHTML = '<div class="qa-modal" role="dialog" aria-label="Gerenciar analistas"><div class="qa-modal-topo"><strong>Gerenciar analistas</strong><button type="button" class="qa-x" id="qa-fechar" aria-label="Fechar">✕</button></div>' +
        '<div class="qa-modal-novo"><input id="qa-novo" type="text" placeholder="Nome completo do novo analista"><button type="button" class="gp-footer-btn" id="qa-add" style="width:auto">+ Adicionar</button></div>' +
        '<div class="qa-modal-lista">' + j.analistas.map(function (a) {
          return '<div class="qa-an-linha"><span class="' + (a.ativo ? '' : 'qa-an-inativo') + '">' + esc(a.nome) + '</span><span class="qa-an-acoes">' +
            '<button type="button" class="gp-footer-btn" data-ren="' + esc(a.id) + '" data-nome="' + esc(a.nome) + '" style="width:auto">Editar nome</button>' +
            '<button type="button" class="gp-footer-btn" data-tog="' + esc(a.id) + '" data-ativo="' + (a.ativo ? '1' : '0') + '" style="width:auto">' + (a.ativo ? 'Desativar' : 'Reativar') + '</button>' +
            '<button type="button" class="gp-footer-btn qa-excluir" data-del="' + esc(a.id) + '" data-nome="' + esc(a.nome) + '" style="width:auto" title="Tira o analista da lista de vez">Excluir</button></span></div>';
        }).join('') + '</div><div class="pop-erro" id="qa-an-erro" role="alert"></div></div>';
      $('qa-fechar').addEventListener('click', fechar);
      var falha = function (m) { $('qa-an-erro').textContent = m; };
      var patch = async function (id, corpo) {
        var r = await chamarApi('/api/analistas/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
        var x = await r.json().catch(function () { return {}; });
        if (!r.ok) { falha(x.error || 'Não foi possível salvar.'); return false; }
        return true;
      };
      $('qa-add').addEventListener('click', async function () {
        var nome = $('qa-novo').value.replace(/\s+/g, ' ').trim(); if (!nome) { falha('Digite o nome.'); return; }
        var r = await chamarApi('/api/analistas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome: nome }) });
        var x = await r.json().catch(function () { return {}; });
        if (!r.ok) { falha(x.error || 'Não foi possível adicionar.'); return; }
        desenhar();
      });
      Array.prototype.forEach.call(ov.querySelectorAll('[data-ren]'), function (b) {
        b.addEventListener('click', async function () {
          var novo = window.prompt('Nome completo do analista:', b.getAttribute('data-nome'));
          if (novo == null) return; novo = novo.replace(/\s+/g, ' ').trim();
          if (!novo || novo === b.getAttribute('data-nome')) return;
          if (await patch(b.getAttribute('data-ren'), { nome: novo })) desenhar();
        });
      });
      Array.prototype.forEach.call(ov.querySelectorAll('[data-del]'), function (b) {
        b.addEventListener('click', async function () {
          if (!window.confirm('Excluir "' + b.getAttribute('data-nome') + '" da lista de analistas? Isso não pode ser desfeito.')) return;
          var r = await chamarApi('/api/analistas/' + encodeURIComponent(b.getAttribute('data-del')), { method: 'DELETE' });
          var x = await r.json().catch(function () { return {}; });
          if (!r.ok) { falha(x.error || 'Não foi possível excluir.'); return; }
          desenhar();
        });
      });
      Array.prototype.forEach.call(ov.querySelectorAll('[data-tog]'), function (b) {
        b.addEventListener('click', async function () { if (await patch(b.getAttribute('data-tog'), { ativo: b.getAttribute('data-ativo') !== '1' })) desenhar(); });
      });
    };
    try { await desenhar(); } catch (e) { ov.innerHTML = '<div class="qa-modal"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; }
  }

  /** Janela do administrador para incluir, renomear, ajustar o peso no risco, desativar e excluir os tipos de registro. */
  async function abrirGerenciarTipos(aoFechar) {
    var ov = document.createElement('div'); ov.className = 'qa-overlay';
    document.body.appendChild(ov);
    var fechar = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); estado.qOpcoes = null; estado.qResumo = null; if (aoFechar) aoFechar(); };
    var desenhar = async function () {
      var j = await api('/api/cs/painel/qualidade/tipos');
      ov.innerHTML = '<div class="qa-modal" role="dialog" aria-label="Gerenciar tipos de registro"><div class="qa-modal-topo"><strong>Gerenciar tipos de registro</strong><button type="button" class="qa-x" id="qt-fechar" aria-label="Fechar">✕</button></div>' +
        '<div class="cinza" style="font-size:12px;margin-bottom:10px">O <strong>peso</strong> é quantos pontos o registro soma no termômetro de Atendimento do risco do cliente (0 só registra, sem pesar; máximo 50).</div>' +
        '<div class="qa-modal-novo"><input id="qt-novo" type="text" maxlength="40" placeholder="Novo tipo (ex.: Retrabalho)"><input id="qt-peso-novo" type="number" min="0" max="50" value="10" style="max-width:70px" title="Peso no risco (pontos)"><button type="button" class="gp-footer-btn" id="qt-add" style="width:auto">+ Adicionar</button></div>' +
        '<div class="qa-modal-lista">' + j.tipos.map(function (t) {
          return '<div class="qa-an-linha" data-id="' + t.id + '"><span style="display:flex;gap:6px;align-items:center;flex:1;min-width:0">' +
            '<input class="qt-nome" type="text" maxlength="40" value="' + esc(t.nome) + '" style="flex:1;min-width:0;padding:6px 8px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;font-size:13px' + (t.ativo ? '' : ';text-decoration:line-through;color:var(--text2)') + '">' +
            '<input class="qt-peso" type="number" min="0" max="50" value="' + t.peso + '" style="width:62px;padding:6px 8px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;font-size:13px" title="Peso no risco (pontos)"></span>' +
            '<span class="qa-an-acoes"><span class="cinza" style="font-size:11px" title="Registros que usam este tipo">' + t.usos + ' uso(s)</span>' +
            '<button type="button" class="gp-footer-btn" data-qsalvar="' + t.id + '" style="width:auto">Salvar</button>' +
            '<button type="button" class="gp-footer-btn" data-qtog="' + t.id + '" data-ativo="' + (t.ativo ? '1' : '0') + '" style="width:auto">' + (t.ativo ? 'Desativar' : 'Reativar') + '</button>' +
            '<button type="button" class="gp-footer-btn qa-excluir" data-qdel="' + t.id + '" data-nome="' + esc(t.nome) + '" style="width:auto">Excluir</button></span></div>';
        }).join('') + '</div><div class="pop-erro" id="qt-erro" role="alert"></div></div>';
      $('qt-fechar').addEventListener('click', fechar);
      var falha = function (m) { $('qt-erro').textContent = m; };
      var enviar = async function (metodo, url, corpo) {
        var r = await chamarApi(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
        var x = await r.json().catch(function () { return {}; });
        if (!r.ok) { falha(x.error || 'Não foi possível salvar.'); return false; }
        return true;
      };
      $('qt-add').addEventListener('click', async function () {
        var nome = $('qt-novo').value.replace(/\s+/g, ' ').trim();
        if (!nome) { falha('Digite o nome do tipo.'); return; }
        if (await enviar('POST', '/api/cs/painel/qualidade/tipos', { nome: nome, peso: $('qt-peso-novo').value })) desenhar();
      });
      Array.prototype.forEach.call(ov.querySelectorAll('[data-qsalvar]'), function (b) {
        b.addEventListener('click', async function () {
          var linha = b.closest('[data-id]');
          if (await enviar('PATCH', '/api/cs/painel/qualidade/tipos/' + b.getAttribute('data-qsalvar'), { nome: linha.querySelector('.qt-nome').value.replace(/\s+/g, ' ').trim(), peso: linha.querySelector('.qt-peso').value })) desenhar();
        });
      });
      Array.prototype.forEach.call(ov.querySelectorAll('[data-qtog]'), function (b) {
        b.addEventListener('click', async function () { if (await enviar('PATCH', '/api/cs/painel/qualidade/tipos/' + b.getAttribute('data-qtog'), { ativo: b.getAttribute('data-ativo') !== '1' })) desenhar(); });
      });
      Array.prototype.forEach.call(ov.querySelectorAll('[data-qdel]'), function (b) {
        b.addEventListener('click', async function () {
          if (!window.confirm('Excluir o tipo "' + b.getAttribute('data-nome') + '"? Isso não pode ser desfeito.')) return;
          if (await enviar('DELETE', '/api/cs/painel/qualidade/tipos/' + b.getAttribute('data-qdel'))) desenhar();
        });
      });
    };
    try { await desenhar(); } catch (e) { ov.innerHTML = '<div class="qa-modal"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; }
  }

  // ── Módulo Qualidade: uma linha por analista ───────────────────────────────────
  /** Lançamentos dos últimos 7 dias, de todos os analistas: qualquer administrador abre o analista e interage. */
  function recentesQ() {
    var rs = estado.qRecentes || []; if (!rs.length) return '';
    return '<div class="card"><div class="card-title">Lançamentos dos últimos 7 dias</div><div class="card-sub">' + rs.length + ' registro(s). Clique no analista para validar, devolver, ajustar o prazo ou cancelar.</div>' +
      '<div class="table-wrap"><table><thead><tr><th>Lançado em</th><th>Empresa</th><th>Tipo</th><th>Analista</th><th class="c">Prazo</th><th class="c">Status</th></tr></thead><tbody>' + rs.map(function (r) {
        return '<tr><td>' + data(r.criado_em) + '<div class="sub">' + esc(r.criado_por || '—') + '</div></td><td style="white-space:normal">' + esc(r.cliente_nome || '—') + '</td><td>' + esc(r.tipo) + '</td>' +
          '<td>' + (r.analista_id ? '<button class="link" data-qan="' + esc(r.analista_id) + '">' + esc(r.analista_nome || '—') + '</button>' : '<span class="cinza">ocorrência (sem responsável)</span>') + '</td><td class="c">' + data(r.prazo) + '</td><td class="c">' + pillStatusQ(r.situacao) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }
  function filtroQ() { return estado.filtroQ || (estado.filtroQ = { busca: '', todos: false }); }
  async function carregarResumoQ() {
    estado.qResumo = await api('/api/cs/painel/qualidade/resumo');
    try { estado.qRecentes = (await api('/api/cs/painel/qualidade/recentes?dias=7')).registros; } catch (e) { estado.qRecentes = []; }
  }
  // ── MÓDULO QUALIDADE: ocorrências, pesos e lista ──────────────────────────────────────
  var DEPS_OCORRENCIA = [['Comercial', 'Comercial'], ['Contábil', 'Contábil'], ['Financeiro', 'Financeiro'], ['Fiscal', 'Fiscal'], ['Legalização', 'Legalização'], ['Pessoal', 'Pessoal'], ['Sucesso', 'Sucesso do Cliente']];
  var ROT_ETAPA_Q = { registrada: 'registrada, aguardando análise', tratativa_definida: 'tratativa definida', com_analista: 'com o analista', validacao_gestor: 'em validação do gestor', devolutiva_cliente: 'devolutiva ao cliente (Sucesso do Cliente)', encerrada: 'encerrada' };
  var COR_PRIORIDADE = { 'Muito Alta': '#b91c1c', Alta: '#c2410c', 'Média': '#1d4ed8', Baixa: '#6b7280' };
  function rotuloDepto(d) { return d === 'Sucesso' ? 'Sucesso do Cliente' : d; }
  function pillPrioridadeQ(p) {
    if (!p) return '<span class="cinza">—</span>';
    var c = COR_PRIORIDADE[p] || '#6b7280';
    return '<span class="pill" style="color:' + c + ';border-color:' + c + '55;background:' + c + '14">' + esc(p) + '</span>';
  }
  function tamanhoTxt(n) { n = Number(n) || 0; return n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function curtoQ(t, n) { t = String(t || '').split(/\s+/).join(' ').trim(); return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…'; }
  function anexosQ(r) {
    var a = r.anexos || []; if (!a.length) return '';
    return '<div class="qa-anexos">' + a.map(function (x) { return '<a href="#" data-anexo="' + esc(x.id) + '" data-nome="' + esc(x.nome) + '" title="Baixar o arquivo">📎 ' + esc(x.nome) + ' <span class="cinza">(' + tamanhoTxt(x.tamanho) + ')</span></a>'; }).join('') + '</div>';
  }
  /** Cartão de uma ocorrência (seção Qualidade da ficha): tipo, prioridade, departamento, assunto, descrição, anexos e andamento. */
  function cartaoOcorrenciaQ(r, semAcoes) {
    return '<div class="qa-reg"><div class="qa-reg-topo">' + pillStatusQ(r.situacao || r.status) + ' <strong>' + esc(r.tipo) + '</strong> ' + pillPrioridadeQ(r.prioridade) + ' <span class="cinza">· ' + esc((r.departamentos || []).map(rotuloDepto).join(', ')) + '</span></div>' +
      (r.assunto ? '<div class="qa-reg-txt"><strong>' + esc(r.assunto) + '</strong></div>' : '') +
      '<div class="qa-reg-txt">' + esc(r.detalhe) + '</div>' +
      '<div class="qa-reg-rod">Registrada em ' + data(r.criado_em) + ' por ' + esc(r.criado_por || '—') + (r.prazo ? ' · prazo ' + data(r.prazo) : '') + (r.resolvido_em ? ' · resolvida em ' + data(r.resolvido_em) : '') + '</div>' +
      '<div class="qa-reg-rod">' + (r.etapa ? 'Etapa: <strong>' + esc(ROT_ETAPA_Q[r.etapa] || r.etapa) + '</strong>' : '') + (r.fila ? (r.etapa ? ' · ' : '') + (r.fila === 'gestor' ? 'encaminhada ao gestor de ' + esc(rotuloDepto((r.departamentos || [])[0])) : 'encaminhada ao Sucesso do Cliente (departamento sem gestor)') : '') + '</div>' +
      anexosQ(r) + (semAcoes ? '' : acoesOcorrenciaQ(r)) + (r.tratativa ? '<div class="qa-reg-trat"><strong>Tratativa:</strong> ' + esc(r.tratativa) + '</div>' : '') + notasHtml(r) + '</div>';
  }
  function podeAgirQ() { return !!(estado.dados && estado.dados.usuario && ['administrador', 'usuario'].indexOf(estado.dados.usuario.papel) >= 0); }
  /** Ações da liderança em uma ocorrência (na seção Qualidade da ficha): resolver e cancelar; excluir só o administrador. */
  function acoesOcorrenciaQ(r) {
    var aberta = r.status === 'aberto' || r.status === 'em_tratamento' || r.status === 'finalizada';
    var b = (podeAgirQ() && aberta ? '<button type="button" class="gp-footer-btn" data-oc-res="' + esc(r.id) + '" style="width:auto">Resolver</button> <button type="button" class="gp-footer-btn" data-oc-can="' + esc(r.id) + '" style="width:auto">Cancelar</button> ' : '') +
      (ehAdminPainel() ? '<button type="button" class="gp-footer-btn qa-excluir" data-oc-del="' + esc(r.id) + '" style="width:auto" title="Apaga a ocorrência de vez (teste ou lançamento errado)">Excluir</button>' : '');
    if (ehAdminPainel() && aberta) b = '<button type="button" class="gp-footer-btn" data-oc-prazo="' + esc(r.id) + '" style="width:auto" title="Muda o prazo para execução">Alterar prazo</button> ' + b;
    return b ? '<div class="qa-oc-acoes">' + b + '</div>' : '';
  }
  function ligarAcoesOcorrenciaQ(raiz, depois) {
    var muda = async function (id, corpo, msg) {
      var resp = await chamarApi('/api/cs/painel/qualidade/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      var j = await resp.json().catch(function () { return {}; });
      if (!resp.ok) { window.alert(j.error || msg); return; }
      if (depois) depois();
    };
    Array.prototype.forEach.call(document.querySelectorAll(raiz + ' [data-oc-res]'), function (b) {
      b.addEventListener('click', function () {
        var t = window.prompt('O que foi feito para resolver esta ocorrência? (mínimo de 5 caracteres)');
        if (t === null) return;
        muda(b.getAttribute('data-oc-res'), { status: 'resolvido', tratativa: t }, 'Não foi possível resolver a ocorrência.');
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll(raiz + ' [data-oc-prazo]'), function (b) {
      b.addEventListener('click', function () {
        var t = window.prompt('Novo prazo para execução (dd/mm/aaaa):');
        if (t === null) return;
        var p = String(t).trim().split('/');
        if (p.length !== 3) { window.alert('Use o formato dd/mm/aaaa, por exemplo 25/10/2026.'); return; }
        muda(b.getAttribute('data-oc-prazo'), { prazo: p[2] + '-' + ('0' + p[1]).slice(-2) + '-' + ('0' + p[0]).slice(-2) }, 'Não foi possível alterar o prazo.');
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll(raiz + ' [data-oc-can]'), function (b) {
      b.addEventListener('click', function () {
        if (!window.confirm('Cancelar esta ocorrência? Ela deixa de aparecer e de pesar no risco (fica no histórico).')) return;
        muda(b.getAttribute('data-oc-can'), { status: 'cancelado' }, 'Não foi possível cancelar a ocorrência.');
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll(raiz + ' [data-oc-del]'), function (b) {
      b.addEventListener('click', async function () {
        if (!window.confirm('Excluir esta ocorrência de vez? Isso não pode ser desfeito. (Para só tirar do risco e manter o histórico, use Cancelar.)')) return;
        var resp = await chamarApi('/api/cs/painel/qualidade/' + encodeURIComponent(b.getAttribute('data-oc-del')), { method: 'DELETE' });
        var j = await resp.json().catch(function () { return {}; });
        if (!resp.ok) { window.alert(j.error || 'Não foi possível excluir.'); return; }
        if (depois) depois();
      });
    });
  }
  async function baixarAnexoQ(id, nome) {
    try {
      var r = await chamarApi('/api/cs/painel/qualidade/anexo/' + encodeURIComponent(id));
      if (!r.ok) { var j = await r.json().catch(function () { return {}; }); window.alert(j.error || 'Não foi possível baixar o anexo.'); return; }
      var url = URL.createObjectURL(await r.blob());
      var a = document.createElement('a'); a.href = url; a.download = nome || 'anexo'; document.body.appendChild(a); a.click();
      setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); URL.revokeObjectURL(url); }, 1000);
    } catch (e) { window.alert('Sem conexão com o servidor. Tente de novo.'); }
  }
  if (document.addEventListener) document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('[data-anexo]') : null;
    if (a) { ev.preventDefault(); baixarAnexoQ(a.getAttribute('data-anexo'), a.getAttribute('data-nome')); }
  });

  /** Quadro "Como a Tratativa pesa no risco de churn": só o administrador vê; o peso de cada tipo se edita aqui e tipos novos já entram no formulário. */
  function comoPesaTratativa(tipos, aberto) {
    var linhas = (tipos || []).map(function (t) {
      return '<tr><td>' + esc(t.nome) + '</td><td class="c"><input type="number" class="qt-inline" min="0" max="50" value="' + t.peso + '" data-tid="' + esc(t.id) + '" aria-label="Peso de ' + esc(t.nome) + '"></td><td class="c"><strong>' + (t.peso * 2) + '</strong></td></tr>';
    }).join('');
    var novo = '<tr><td><input type="text" class="qt-novo-nome" id="qpn-nome" maxlength="40" placeholder="Novo tipo (ex.: Retrabalho)"></td><td class="c"><input type="number" class="qt-inline" id="qpn-peso" min="0" max="50" value="10" aria-label="Peso do novo tipo"></td><td class="c"><button type="button" class="gp-footer-btn" id="qpn-add" style="width:auto">+ Adicionar tipo</button></td></tr>';
    return '<details class="card leg" id="q-peso-box"' + (aberto ? ' open' : '') + ' style="padding:12px 20px"><summary><span class="seta">▶</span> 🔒 Como a Tratativa pesa no risco de churn <span style="font-weight:500;text-transform:none;letter-spacing:0">(só administradores · clique para expandir)</span></summary><div class="corpo">' +
      '<div><strong>Quem alimenta</strong><br>Só o que é <strong>registrado no módulo Qualidade</strong> (erro, multa, reclamação, atraso, falha…): aparece nos Sinais de atenção da ficha, na seção Qualidade da empresa, no card Tratativas da Visão Geral e pesa no risco, que agora tem quatro critérios: Financeiro, Atendimento, Operacional e Tratativas. O plano de ação escrito na ficha ("Descreva a tratativa") <strong>não conta</strong>.</div>' +
      '<div><strong>Como cada ocorrência pesa</strong><br>Vale o <strong>dobro do peso do seu tipo</strong> (tabela abaixo), multiplicado por: 1,5 se o prazo venceu · 1 em aberto ou em tratamento · 0,5 finalizada aguardando validação · 0,25 resolvida. Ocorrência com mais de 45 dias vale metade. Vale o que foi registrado nos últimos 90 dias, a soma é limitada a 100 por cliente e a cancelada não entra.</div>' +
      '<div><strong>Quando entra na média</strong><br>Só enquanto houver tratativa em aberto (aberta, em tratamento ou finalizada aguardando validação). Sem pendência o termômetro fica de fora: uma tratativa resolvida não esconde um cliente com Financeiro alto e o risco não vira "parcial" à toa. Um termômetro a partir de 75 pontos já gera alerta e sobe o cliente para, no mínimo, Médio.</div>' +
      '<div><strong>Pesos por tipo</strong> <span class="cinza">(edite o peso e saia do campo para salvar; um tipo novo já aparece no formulário Registrar ocorrência)</span>' +
        '<div class="table-wrap" style="margin-top:6px"><table><thead><tr><th>Tipo</th><th class="c">Peso do tipo (0 a 50)</th><th class="c">Vale na Tratativa (×2)</th></tr></thead><tbody>' + linhas + novo + '</tbody></table></div></div>' +
      '</div></details>';
  }

  /** (Fora do módulo Qualidade desde 17/10/2026: a lista vai para o Portal do Gestor, que reaproveita esta tabela.) Tabela "Ocorrências registradas": a lista do módulo, com as ações da liderança (resolver, cancelar; excluir só o administrador). */
  function tabelaOcorrenciasMod(oc) {
    var adm = ehAdminPainel();
    var corpo = (oc || []).map(function (r) {
      var aberta = r.status === 'aberto' || r.status === 'em_tratamento' || r.status === 'finalizada';
      return '<tr><td>' + data(r.criado_em) + '<div class="sub">' + esc(r.criado_por || '—') + '</div></td>' +
        '<td style="white-space:normal;min-width:170px">' + esc(r.cliente_nome || '—') + '</td>' +
        '<td>' + esc(r.tipo) + '</td><td class="c">' + pillPrioridadeQ(r.prioridade) + '</td><td>' + esc((r.departamentos || []).map(rotuloDepto).join(', ')) + '</td>' +
        '<td style="white-space:normal;min-width:260px"><strong>' + esc(r.assunto || '—') + '</strong><div class="sub" title="' + esc(r.detalhe) + '">' + esc(curtoQ(r.detalhe, 150)) + '</div>' + anexosQ(r) + notasHtml(r) + '</td>' +
        '<td class="c">' + pillStatusQ(r.situacao || r.status) + '</td>' +
        '<td class="c" style="white-space:nowrap">' +
          (aberta ? '<button type="button" class="gp-footer-btn" data-oc-res="' + esc(r.id) + '" style="width:auto">Resolver</button> <button type="button" class="gp-footer-btn" data-oc-can="' + esc(r.id) + '" style="width:auto">Cancelar</button> ' : '') +
          (adm ? '<button type="button" class="gp-footer-btn qa-excluir" data-oc-del="' + esc(r.id) + '" style="width:auto" title="Apaga a ocorrência de vez (teste ou lançamento errado)">Excluir</button>' : '') + '</td></tr>';
    }).join('');
    return '<div class="card"><div class="card-title">Ocorrências registradas</div><div class="card-sub">' + (oc || []).length + ' ocorrência(s). Cada uma aparece nos Sinais de atenção e na seção Qualidade da empresa e pesa no termômetro Tratativas enquanto estiver em aberto.</div>' +
      ((oc || []).length ? '<div class="table-wrap"><table><thead><tr><th>Registrada em</th><th>Empresa</th><th>Tipo</th><th class="c">Prioridade</th><th>Departamento</th><th>Assunto</th><th class="c">Status</th><th class="c"></th></tr></thead><tbody>' + corpo + '</tbody></table></div>'
        : '<div class="vazio">Nenhuma ocorrência registrada ainda. Clique em "Registrar ocorrência" para lançar a primeira.</div>') + '</div>';
  }

  /** Opções do campo Tipo de ocorrência: os tipos ativos, como os administradores criaram e editaram (nome e peso ficam em "Gerenciar tipos"). */
  function opcoesTiposOc(lista) { return '<option value="">Selecione o tipo…</option>' + (lista || []).map(function (t) { return '<option>' + esc(t) + '</option>'; }).join(''); }
  /** Formulário "Registrar ocorrência" (o miolo da janela). */
  function formularioOcorrenciaQ(o) {
    var tipos = opcoesTiposOc(o.tipos);
    var deps = '<option value="">Selecione o departamento…</option>' + DEPS_OCORRENCIA.map(function (d) { return '<option value="' + esc(d[0]) + '">' + esc(d[1]) + '</option>'; }).join('');
    var pri = (o.prioridades || ['Muito Alta', 'Alta', 'Média', 'Baixa']).map(function (p) { return '<option' + (p === 'Média' ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('');
    return '<div class="qa-modal-topo"><strong style="font-size:22px;color:#256050">Registrar ocorrência</strong><button type="button" class="qa-x" id="oc-fechar" aria-label="Fechar">✕</button></div>' +
      '<div class="qa-oc-obs">⚠ Usar só para fatos fora do padrão (reclamação, insatisfação, multa, caso grave), não para o atendimento do dia a dia.</div>' +
      '<div class="qa-oc-quem">Registrando como <strong>' + esc(usuarioLogadoNome() || 'você') + '</strong> em <strong>' + hojeIsoLocal().split('-').reverse().join('/') + '</strong>. Quem registra e a data ficam gravados na ocorrência.</div>' +
      '<div class="qa-oc-linha qa-oc-l1">' +
        '<div class="qa-campo"><label for="oc-assunto">Assunto da ocorrência</label><input type="text" id="oc-assunto" maxlength="100" placeholder="Qual o assunto da ocorrência?"></div>' +
        '<div class="qa-campo"><label for="oc-anexo">Arquivo anexo</label><input type="file" id="oc-anexo" multiple><div class="cinza qa-oc-dica">Até ' + (o.max_anexos || 5) + ' arquivos de ' + Math.round((o.max_anexo || 10485760) / 1048576) + ' MB cada</div></div>' +
        '<div class="qa-campo"><label for="oc-prior">Prioridade</label><select id="oc-prior">' + pri + '</select></div>' +
        '<div class="qa-campo"><label for="oc-prazo">Prazo para execução <span class="req">*</span></label><input type="date" id="oc-prazo" min="' + hojeIsoLocal() + '"></div>' +
      '</div>' +
      '<div class="qa-oc-linha qa-oc-l2">' +
        '<div class="qa-campo"><label for="oc-emp">Empresa</label><input type="text" id="oc-emp" autocomplete="off" placeholder="Digite o início do nome ou o CNPJ"><div class="qa-oc-sel" id="oc-emp-sel" hidden></div><div class="qa-oc-lista" id="oc-emp-lista" hidden></div></div>' +
        '<div class="qa-campo"><label for="oc-tipo">Tipo de ocorrência <span class="req">*</span>' + (ehAdminPainel() ? ' <a href="#" id="oc-editar-tipos" class="qa-lnk">(editar lista)</a>' : '') + '</label><select id="oc-tipo">' + tipos + '</select></div>' +
        '<div class="qa-campo"><label for="oc-dep">Departamento</label><select id="oc-dep">' + deps + '</select></div>' +
      '</div>' +
      '<div class="qa-campo"><label for="oc-det">Descrição / Detalhes da ocorrência <span class="cinza" id="oc-cont">0/' + (o.max_detalhe || 2000) + '</span></label><textarea id="oc-det" rows="6" maxlength="' + (o.max_detalhe || 2000) + '" placeholder="Descrição / Detalhes da ocorrência"></textarea></div>' +
      '<div class="qa-oc-linha qa-oc-bot"><button type="button" class="qa-btn-ok" id="oc-ok">✉ OK - Registrar</button><button type="button" class="qa-btn-cancel" id="oc-cancel">↩ Cancelar</button></div>' +
      '<div class="pop-erro" id="oc-erro" role="alert"></div>';
  }

  /** Janela "Registrar ocorrência": empresa com sugestão ao digitar, descrição até 2000, anexos; ao registrar vai para o módulo, os Sinais de atenção e o risco. */
  async function abrirRegistrarOcorrencia(aoSalvar) {
    estado.qOpcoes = null;   // sempre a lista de tipos atual (outro administrador pode ter criado ou editado tipos)
    var o; try { o = await carregarOpcoesQ(); } catch (e) { window.alert(e.message || 'Não foi possível abrir o formulário.'); return; }
    var ov = document.createElement('div'); ov.className = 'qa-overlay'; document.body.appendChild(ov);
    var fechar = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); };
    ov.innerHTML = '<div class="qa-modal qa-modal-oc" role="dialog" aria-label="Registrar ocorrência">' + formularioOcorrenciaQ(o) + '</div>';
    $('oc-fechar').addEventListener('click', fechar); $('oc-cancel').addEventListener('click', fechar);
    // administrador: edita a lista de tipos sem sair do formulário; ao fechar, o campo já mostra os tipos novos e os renomeados
    var edTipos = $('oc-editar-tipos');
    if (edTipos) edTipos.addEventListener('click', function (ev) {
      ev.preventDefault();
      abrirGerenciarTipos(async function () {
        estado.qOpcoes = null;
        try { o = await carregarOpcoesQ(); } catch (e) { return; }
        var s = $('oc-tipo'), atual = s.value;
        s.innerHTML = opcoesTiposOc(o.tipos);
        if ((o.tipos || []).indexOf(atual) >= 0) s.value = atual;
      });
    });
    var campo = $('oc-emp'), lista = $('oc-emp-lista'), sel = $('oc-emp-sel'), det = $('oc-det'), erro = $('oc-erro');
    var emp = null, itens = [], idx = -1, tmr = null;
    det.addEventListener('input', function () { $('oc-cont').textContent = det.value.length + '/' + (o.max_detalhe || 2000); });
    var desenhaLista = function () {
      lista.hidden = false;
      lista.innerHTML = itens.length ? itens.map(function (e, i) { return '<div class="qa-oc-item' + (i === idx ? ' ativo' : '') + '" data-i="' + i + '">' + esc(e.nome) + ' <span class="cinza">' + esc(e.cnpj || '') + '</span></div>'; }).join('')
        : '<div class="qa-oc-item cinza">Nenhuma empresa ativa encontrada com esse início.</div>';
    };
    var escolhe = function (i) {
      var e = itens[i]; if (!e) return;
      emp = e; campo.value = e.nome; lista.hidden = true; sel.hidden = false; sel.textContent = '✔ ' + e.nome + (e.cnpj ? ' · ' + e.cnpj : '');
    };
    campo.addEventListener('input', function () {
      emp = null; sel.hidden = true; clearTimeout(tmr);
      var q = campo.value.trim(); if (!q) { lista.hidden = true; return; }
      tmr = setTimeout(async function () {
        try { itens = (await api('/api/cs/painel/qualidade/empresas?q=' + encodeURIComponent(q))).empresas || []; } catch (e) { itens = []; }
        idx = -1; desenhaLista();
      }, 200);
    });
    campo.addEventListener('keydown', function (ev) {
      if (lista.hidden || !itens.length) return;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); idx = Math.min(itens.length - 1, idx + 1); desenhaLista(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); idx = Math.max(0, idx - 1); desenhaLista(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); escolhe(idx >= 0 ? idx : 0); }
      else if (ev.key === 'Escape') { lista.hidden = true; }
    });
    lista.addEventListener('mousedown', function (ev) { var d = ev.target && ev.target.closest ? ev.target.closest('[data-i]') : null; if (d) { ev.preventDefault(); escolhe(parseInt(d.getAttribute('data-i'), 10)); } });
    $('oc-ok').addEventListener('click', async function () {
      erro.textContent = '';
      var assunto = $('oc-assunto').value.trim(), tipo = $('oc-tipo').value, dep = $('oc-dep').value, texto = det.value.trim();
      var arqs = Array.prototype.slice.call(($('oc-anexo').files || []));
      if (assunto.length < 3) { erro.textContent = 'Qual o assunto da ocorrência?'; return; }
      if (!emp) { erro.textContent = 'Qual a empresa? Digite o início do nome e escolha na lista.'; return; }
      if (!tipo) { erro.textContent = 'Escolha o tipo de ocorrência.'; return; }
      if (!dep) { erro.textContent = 'Qual o departamento?'; return; }
      if (texto.length < 5) { erro.textContent = 'Descreva a ocorrência (mínimo de 5 caracteres).'; return; }
      var prazo = $('oc-prazo').value;
      if (!prazo) { erro.textContent = 'Informe o prazo para execução.'; return; }
      if (prazo < hojeIsoLocal()) { erro.textContent = 'O prazo não pode ser uma data que já passou.'; return; }
      if (arqs.length > (o.max_anexos || 5)) { erro.textContent = 'Só é possível anexar até ' + (o.max_anexos || 5) + ' arquivos.'; return; }
      var grande = arqs.filter(function (f) { return f.size > (o.max_anexo || 10485760); })[0];
      if (grande) { erro.textContent = 'O arquivo "' + grande.name + '" passa de ' + Math.round((o.max_anexo || 10485760) / 1048576) + ' MB.'; return; }
      if (!window.confirm('Deseja realmente registrar esta ocorrência para "' + emp.nome + '"?')) return;
      var ok = $('oc-ok'); ok.disabled = true; ok.textContent = 'Registrando…';
      var reabrir = function () { ok.disabled = false; ok.textContent = '✉ OK - Registrar'; };
      try {
        var r = await chamarApi('/api/cs/painel/qualidade/ocorrencias', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cliente_id: emp.id, assunto: assunto, tipo: tipo, prioridade: $('oc-prior').value, departamento: dep, prazo: prazo, detalhe: det.value }) });
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok) { erro.textContent = j.error || 'Não foi possível registrar a ocorrência.'; reabrir(); return; }
        var falhas = [];
        for (var i = 0; i < arqs.length; i++) {
          ok.textContent = 'Enviando anexo ' + (i + 1) + ' de ' + arqs.length + '…';
          try {
            var ra = await chamarApi('/api/cs/painel/qualidade/ocorrencias/' + encodeURIComponent(j.registro.id) + '/anexo?nome=' + encodeURIComponent(arqs[i].name) + '&tipo=' + encodeURIComponent(arqs[i].type || ''), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: arqs[i] });
            if (!ra.ok) { var ja = await ra.json().catch(function () { return {}; }); falhas.push(arqs[i].name + ': ' + (ja.error || 'falhou')); }
          } catch (e) { falhas.push(arqs[i].name + ': sem conexão'); }
        }
        fechar();
        var destino = j.destino ? 'Ocorrência registrada. ' + j.destino : '';
        if (falhas.length) window.alert((destino ? destino + '\n\n' : '') + 'Nem todos os anexos subiram:\n' + falhas.join('\n'));
        else if (destino) window.alert(destino);
        if (aoSalvar) aoSalvar();
      } catch (e) { erro.textContent = 'Sem conexão com o servidor. Tente de novo.'; reabrir(); }
    });
    if ($('oc-assunto').focus) $('oc-assunto').focus();
  }

  // ── PERFIL: o /cs mostra só os módulos de cada pessoa (o servidor confere cada rota) ──────────────────
  function usuarioCs() { try { return JSON.parse(ls(K_USER) || 'null') || {}; } catch (e) { return {}; } }
  /** completo = administrador, usuário ou equipe do CS (todos os módulos de sempre); o administrador também vê os dois portais; gestor e analista, só os deles. */
  function perfilDe(u) {
    u = u || {};
    var adm = u.role === 'administrador';
    return { completo: adm || u.role === 'usuario' || !!u.acesso_cs, admin: adm, gestor: adm || !!u.acesso_gestor, analista: adm || !!u.acesso_qualidade };
  }
  function perfilCs() { return perfilDe(usuarioCs()); }
  function aplicarPerfilCs() {
    var p = perfilCs();
    Array.prototype.forEach.call(document.querySelectorAll('.gp-nav-item'), function (b) {
      var sec = b.getAttribute('data-sec');
      var ok = p.completo ? (sec === 'gestor' ? p.gestor : sec === 'analista' ? p.analista : true) : (sec === 'consideracoes' || (sec === 'gestor' && p.gestor) || (sec === 'analista' && p.analista) || (sec === 'sucesso' && !!(estado.eu && estado.eu.sucesso)));
      b.style.display = ok ? '' : 'none';
    });
    Array.prototype.forEach.call(document.querySelectorAll('.gp-nav-divider'), function (d) { d.style.display = p.completo ? '' : 'none'; });
    if (!p.completo) {
      ['btn-csv', 'btn-pdf', 'btn-valores', 'btn-atualizar', 'filtro-periodo'].forEach(function (id) { var e = $(id); if (e) e.style.display = 'none'; });
      var sucessoOk = !!(estado.eu && estado.eu.sucesso);
      if (['consideracoes', 'gestor', 'analista', 'sucesso'].indexOf(estado.secao) < 0 || (estado.secao === 'gestor' && !p.gestor) || (estado.secao === 'analista' && !p.analista) || (estado.secao === 'sucesso' && !sucessoOk)) estado.secao = p.gestor ? 'gestor' : 'consideracoes';
    } else if ((estado.secao === 'gestor' && !p.gestor) || (estado.secao === 'analista' && !p.analista)) estado.secao = 'visao';
  }
  async function iniciarLimitado() {
    var p = perfilCs();
    ['consideracoes', 'gestor', 'analista', 'sucesso'].forEach(function (s) { var e = $('sec-' + s); if (e) e.innerHTML = '<div class="vazio">Carregando…</div>'; });
    try {
      try { estado.eu = await api('/api/cs/painel/qualidade/eu'); } catch (e) { estado.eu = null; }
      aplicarPerfilCs();   // agora que se sabe se é do Sucesso do Cliente
      p = perfilCs();
      estado.dados = null;   // sem os dados da carteira
      $('atualizado').textContent = '';
      await desenharQualidadeModLimitado();
      if (p.gestor) await desenharGestor();
      if (p.analista) desenharAnalista();
      if (estado.eu && estado.eu.sucesso) desenharSucesso();
      irPara(estado.secao);
      iniciarAvisosCs();
    } catch (e) { $('sec-consideracoes').innerHTML = '<div class="card"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; }
  }

  // ── Qualidade para quem só registra (gestor ou analista): registrar e acompanhar as próprias ocorrências ──
  var ETAPA_CURTA = { registrada: 'Aguardando análise', tratativa_definida: 'Tratativa definida', com_analista: 'Com o analista', validacao_gestor: 'Em validação', devolutiva_cliente: 'Devolutiva ao cliente', encerrada: 'Encerrada' };
  var COR_ETAPA = { registrada: '#b45309', tratativa_definida: '#2563eb', com_analista: '#7c3aed', validacao_gestor: '#0e7490', devolutiva_cliente: '#c2410c', encerrada: '#166534' };
  var ETAPAS_Q = ['registrada', 'tratativa_definida', 'com_analista', 'validacao_gestor', 'devolutiva_cliente', 'encerrada'];
  function pillEtapaQ(e) { var c = COR_ETAPA[e] || '#6b7280'; return '<span class="pill" style="color:' + c + ';border-color:' + c + '55;background:' + c + '14">' + esc(ETAPA_CURTA[e] || e || '—') + '</span>'; }
  var OBS_REGISTRO = 'Usar só para fatos fora do padrão (reclamação, insatisfação, multa, caso grave), não para o atendimento do dia a dia.';
  function destinoCurto(r) { return r.fila === 'gestor' ? 'Gestor de ' + rotuloDepto((r.departamentos || [])[0]) : r.fila === 'sucesso' ? 'Sucesso do Cliente' : '—'; }
  function htmlMinhasOcorrencias(lista) {
    var corpo = (lista || []).map(function (r) {
      return '<tr><td>' + data(r.criado_em) + '</td><td style="white-space:normal;min-width:170px">' + esc(r.cliente_nome || '—') + '</td><td>' + esc(r.tipo) + '</td><td class="c">' + pillPrioridadeQ(r.prioridade) + '</td>' +
        '<td style="white-space:normal;min-width:220px"><strong>' + esc(r.assunto || '—') + '</strong>' + anexosQ(r) + '</td><td class="c">' + data(r.prazo) + '</td><td>' + esc(destinoCurto(r)) + '</td><td class="c">' + pillEtapaQ(r.etapa) + '</td></tr>';
    }).join('');
    return '<div class="card"><div class="card-title">Minhas ocorrências</div><div class="card-sub">As ocorrências que você registrou. Quem registra não precisa ser quem trata: cada uma vai para o gestor do departamento escolhido (ou para o Sucesso do Cliente, se o departamento ainda não tem gestor).</div>' +
      ((lista || []).length ? '<div class="table-wrap"><table><thead><tr><th>Registrada em</th><th>Empresa</th><th>Tipo</th><th class="c">Prioridade</th><th>Assunto</th><th class="c">Prazo</th><th>Encaminhada a</th><th class="c">Etapa</th></tr></thead><tbody>' + corpo + '</tbody></table></div>'
        : '<div class="vazio">Você ainda não registrou nenhuma ocorrência.</div>') + '</div>';
  }
  async function desenharQualidadeModLimitado() {
    var alvo = $('sec-consideracoes'); if (!alvo) return;
    var lista = [];
    try { lista = (await api('/api/cs/painel/qualidade/ocorrencias/minhas')).registros || []; } catch (e) { lista = []; }
    alvo.innerHTML = '<div class="qa-barra"><button type="button" class="login-btn" id="q-registrar" style="width:auto;margin:0;padding:10px 22px">＋ Registrar ocorrência</button><span class="qa-obs">⚠ ' + OBS_REGISTRO + '</span></div>' + htmlMinhasOcorrencias(lista);
    var reg = $('q-registrar'); if (reg) reg.addEventListener('click', function () { abrirRegistrarOcorrencia(function () { desenharQualidadeModLimitado(); }); });
  }

  // ── PORTAL DO ANALISTA ────────────────────────────────────────────────────────────────
  function formNotaObs(p, rotuloNota) {
    return '<div class="qa-campo"><label for="' + p + '-nota">' + rotuloNota + ' <span class="req">*</span> <span class="cinza" id="' + p + '-cont">0/600</span></label><textarea id="' + p + '-nota" rows="3" maxlength="600"></textarea></div>' +
      '<div class="qa-campo"><label for="' + p + '-obs">Observação</label><textarea id="' + p + '-obs" rows="2" maxlength="1000" placeholder="Opcional"></textarea></div>';
  }
  function ligarContador(p) { var t = $(p + '-nota'), c = $(p + '-cont'); if (t && c) t.addEventListener('input', function () { c.textContent = t.value.length + '/600'; }); }
  async function postarQ(url, corpo) {
    var r = await chamarApi(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) });
    var j = await r.json().catch(function () { return {}; });
    return { ok: r.ok, j: j };
  }
  /** As devolutivas já dadas: analista, gestor (validação) e gestor final (encerramento), cada uma com nota e observação. */
  function htmlRetornos(r) {
    var bloco = function (quem, em, nota, obs) { return '<div class="qa-reg-trat"><strong>' + quem + ' · ' + data(em) + ':</strong> ' + esc(nota) + (obs ? '<div class="cinza" style="margin-top:3px"><em>Observação:</em> ' + esc(obs) + '</div>' : '') + '</div>'; };
    var b = [];
    if (r.analista_nota) b.push(bloco('Analista' + (r.analista_por ? ' (' + esc(r.analista_por) + ')' : ''), r.analista_em, r.analista_nota, r.analista_obs));
    if (r.validacao_nota) b.push(bloco('Gestor validou' + (r.validacao_por ? ' (' + esc(r.validacao_por) + ')' : ''), r.validacao_em, r.validacao_nota, r.validacao_obs));
    if (r.final_nota) b.push(bloco('Encerrada pelo gestor final' + (r.encerrada_por ? ' (' + esc(r.encerrada_por) + ')' : ''), r.encerrada_em, r.final_nota, r.final_obs));
    return b.length ? '<div class="ficha-sec">Devolutivas</div>' + b.join('') : '';
  }
  /** O plano que o gestor definiu (o que o analista precisa fazer). */
  function htmlPlanoGestor(r) {
    return '<div class="ficha-sec">Plano de ação do gestor</div><div class="qa-reg"><div class="qa-reg-txt">' + esc(r.plano_acao || '—') + '</div>' +
      '<div class="qa-reg-rod">Departamento ' + esc(rotuloDepto(r.tratativa_depto || '')) + ' · prazo <strong>' + data(r.prazo) + '</strong>' + (r.tratativa_definida_por ? ' · definido por ' + esc(r.tratativa_definida_por) : '') + (r.liberada_em ? ' · aberto em ' + data(r.liberada_em) : '') + '</div>' +
      (r.gestor_obs ? '<div class="qa-reg-trat"><strong>Observação do gestor:</strong> ' + esc(r.gestor_obs) + '</div>' : '') + '</div>';
  }
  function filtrarPortal(regs, f) {
    var b = String((f && f.busca) || '').trim().toLowerCase();
    return (regs || []).filter(function (r) {
      if (f.depto && (r.departamentos || []).indexOf(f.depto) < 0) return false;
      if (f.analista && String(r.analista_id) !== String(f.analista)) return false;
      if (f.etapa === 'vencidas') { if (r.situacao !== 'vencido') return false; } else if (f.etapa && r.etapa !== f.etapa) return false;
      if (b && String(r.cliente_nome || '').toLowerCase().indexOf(b) < 0 && String(r.assunto || '').toLowerCase().indexOf(b) < 0) return false;
      return true;
    });
  }
  function htmlAnalista(d, f) {
    var regs = d.registros || [], lista = filtrarPortal(regs, f), c = contagemEtapasGestor(regs);
    var op = function (v, rot, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(rot) + '</option>'; };
    var optE = op('', 'Todas as etapas', !f.etapa) + ['com_analista', 'validacao_gestor', 'devolutiva_cliente', 'encerrada'].map(function (e) { return op(e, ETAPA_CURTA[e], f.etapa === e); }).join('') + op('vencidas', 'Vencidas', f.etapa === 'vencidas');
    var selAn = d.todos ? '<span class="filter-label">Analista</span><select class="gp-select" id="a-analista">' + op('', 'Todos os analistas', !f.analista) + (d.analistas || []).map(function (a) { return op(a.id, a.nome, String(f.analista) === String(a.id)); }).join('') + '</select>' : '';
    var corpo = lista.map(function (r) {
      var acao = r.etapa === 'com_analista' ? 'Tratar' : 'Ver';
      return '<tr><td>' + data(r.liberada_em || r.criado_em) + '</td><td style="white-space:normal;min-width:170px">' + esc(r.cliente_nome || '—') + '</td><td>' + esc(r.tipo) + '</td><td class="c">' + pillPrioridadeQ(r.prioridade) + '</td>' +
        '<td style="white-space:normal;min-width:240px"><strong>' + esc(r.assunto || '—') + '</strong><div class="sub" title="' + esc(r.plano_acao || '') + '">' + esc(curtoQ(r.plano_acao || r.detalhe, 130)) + '</div></td>' +
        (d.todos ? '<td>' + esc(r.analista_nome || '—') + '</td>' : '') +
        '<td class="c">' + data(r.prazo) + '</td><td class="c">' + pillEtapaQ(r.etapa) + (r.situacao === 'vencido' ? '<div><span class="pill" style="color:#b91c1c;border-color:#b91c1c55;background:#b91c1c14">vencida</span></div>' : '') + '</td>' +
        '<td class="c" style="white-space:nowrap"><button type="button" class="gp-footer-btn" data-aabrir="' + esc(r.id) + '" style="width:auto">' + acao + '</button></td></tr>';
    }).join('');
    return '<div class="qa-obs" style="margin-bottom:14px">ℹ Trâmite: o gestor do departamento analisa a ocorrência, cria a tratativa e abre para você. <strong>Sua tratativa será validada pelo seu gestor.</strong> Depois da nota que você deixar, a ocorrência é direcionada ao <strong>Sucesso do Cliente</strong>, que faz a devolutiva ao cliente.</div>' +
      '<div class="gp-kpi-row">' +
        kpi('#7c3aed', 'Com ' + (d.todos ? 'os analistas' : 'você'), c.com_analista, 'para tratar') +
        kpi('#0e7490', 'Em validação', c.validacao_gestor, 'com o gestor') +
        kpi('#c2410c', 'Devolutiva ao cliente', c.devolutiva_cliente, 'com o Sucesso do Cliente') +
        kpi('#166534', 'Encerradas', c.encerrada, 'processo finalizado') +
        kpi('#b91c1c', 'Vencidas', c.vencidas, 'prazo passou') +
      '</div>' +
      '<div class="card"><div class="filter-group" style="margin-bottom:14px">' + selAn +
        '<span class="filter-label">Etapa</span><select class="gp-select" id="a-etapa">' + optE + '</select>' +
        '<span class="filter-label">Buscar</span><input class="gp-input" id="a-busca" placeholder="Empresa ou assunto" value="' + esc(f.busca || '') + '">' +
        '<button type="button" class="gp-footer-btn" id="a-atualizar" style="width:auto">↻ Atualizar</button></div>' +
        '<div class="card-sub">' + lista.length + ' ocorrência(s)' + (d.todos ? ' · você é administrador: vê as de todos e age em nome do analista' : (d.analista ? ' · analista: ' + esc(d.analista.nome) : '')) + '</div>' +
        (lista.length ? '<div class="table-wrap"><table><thead><tr><th>Aberta em</th><th>Empresa</th><th>Tipo</th><th class="c">Prioridade</th><th>Assunto e plano</th>' + (d.todos ? '<th>Analista</th>' : '') + '<th class="c">Prazo</th><th class="c">Etapa</th><th class="c"></th></tr></thead><tbody>' + corpo + '</tbody></table></div>'
          : '<div class="vazio">Nenhuma ocorrência aberta para ' + (d.todos ? 'este filtro' : 'você') + ' por enquanto.</div>') + '</div>';
  }
  async function desenharAnalista() {
    var alvo = $('sec-analista'); if (!alvo) return;
    if (!estado.a) estado.a = { dados: null, f: { analista: '', etapa: '', busca: '' } };
    var a = estado.a;
    if (!a.dados) {
      alvo.innerHTML = '<div class="vazio">Carregando…</div>';
      try {
        await carregarOpcoesQ();
        a.dados = await api('/api/cs/painel/qualidade/analista/ocorrencias' + (a.f.analista ? '?analista=' + encodeURIComponent(a.f.analista) : ''));
        a.dados.analistas = estado.qAnalistas || [];
      } catch (e) { alvo.innerHTML = '<div class="card"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; return; }
    }
    var ba = $('badge-analista'); if (ba) ba.textContent = contagemEtapasGestor(a.dados.registros).com_analista || '';
    alvo.innerHTML = htmlAnalista(a.dados, a.f);
    var liga = function (id, prop, evento, refaz) { var e = $(id); if (e) e.addEventListener(evento || 'change', function () { a.f[prop] = e.value; var pos = e.selectionStart; if (refaz) a.dados = null; desenharAnalista(); if (prop === 'busca') { var n = $('a-busca'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (x) { /* sem seleção */ } } } }); };
    liga('a-analista', 'analista', 'change', true); liga('a-etapa', 'etapa'); liga('a-busca', 'busca', 'input');
    var at = $('a-atualizar'); if (at) at.addEventListener('click', function () { a.dados = null; desenharAnalista(); });
    Array.prototype.forEach.call(alvo.querySelectorAll('[data-aabrir]'), function (b) { b.addEventListener('click', function () { abrirOcorrenciaAnalista(b.getAttribute('data-aabrir')); }); });
  }
  function htmlOcorrenciaAnalista(r, emNomeDe) {
    var topo = '<div class="qa-modal-topo"><strong style="font-size:20px;color:#256050">' + esc(r.assunto || 'Ocorrência') + '</strong><button type="button" class="qa-x" id="ao-fechar" aria-label="Fechar">✕</button></div>' +
      '<div class="cinza" style="font-size:12.5px;margin-bottom:10px">' + esc(r.cliente_nome || '') + ' · ' + pillEtapaQ(r.etapa) + '</div>' + cartaoOcorrenciaQ(r, true) + htmlPlanoGestor(r);
    if (r.etapa !== 'com_analista') {
      return topo + htmlRetornos(r) + '<div class="qa-oc-linha qa-oc-bot" style="grid-template-columns:1fr"><button type="button" class="qa-btn-cancel" id="ao-cancel">Fechar</button></div>';
    }
    return topo + htmlRetornos(r) +
      (emNomeDe ? '<div class="qa-obs" style="margin:10px 0">Você está agindo em nome de <strong>' + esc(emNomeDe) + '</strong>: o que registrar aparece com o seu nome e o dele.</div>' : '') +
      '<div class="ficha-sec">Sua tratativa</div>' +
      '<div class="qa-campo"><label for="ao-nota-rapida">Anotação no meio do caminho <span class="cinza">(opcional; fica no histórico)</span></label><div style="display:flex;gap:8px"><input type="text" id="ao-nota-rapida" maxlength="600" style="flex:1" placeholder="Ex.: liguei para o cliente, aguardando retorno"><button type="button" class="gp-footer-btn" id="ao-anotar" style="width:auto">Anotar</button></div></div>' +
      '<div class="ficha-sec">Encerrar a tratativa</div>' + formNotaObs('ao', 'Nota (o que foi feito)') +
      '<div class="qa-obs" style="margin:6px 0">ℹ Ao clicar em <strong>Encerrada</strong>, a ocorrência vai para a validação do seu gestor; depois, para o Sucesso do Cliente fazer a devolutiva ao cliente.</div>' +
      '<div class="qa-oc-linha qa-oc-bot"><button type="button" class="qa-btn-cancel" id="ao-cancel" style="background:#64748b">Fechar</button><button type="button" class="qa-btn-ok" id="ao-encerrar">Encerrada: enviar para validação</button></div>' +
      '<div class="pop-erro" id="ao-erro" role="alert"></div>';
  }
  function abrirOcorrenciaAnalista(id) {
    var d = estado.a && estado.a.dados, r = ((d && d.registros) || []).filter(function (x) { return String(x.id) === String(id); })[0]; if (!r) return;
    var emNome = d.todos || (d.analista && false) ? r.analista_nome : '';
    var ov = document.createElement('div'); ov.className = 'qa-overlay'; document.body.appendChild(ov);
    var fechar = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); };
    ov.innerHTML = '<div class="qa-modal qa-modal-oc" role="dialog" aria-label="Ocorrência">' + htmlOcorrenciaAnalista(r, emNome) + '</div>';
    $('ao-fechar').addEventListener('click', fechar); $('ao-cancel').addEventListener('click', fechar);
    if (!$('ao-encerrar')) return;
    ligarContador('ao');
    var erro = $('ao-erro'), url = '/api/cs/painel/qualidade/analista/ocorrencias/' + encodeURIComponent(r.id);
    $('ao-anotar').addEventListener('click', async function () {
      erro.textContent = ''; var t = $('ao-nota-rapida').value.trim();
      if (t.length < 3) { erro.textContent = 'Escreva a anotação (mínimo de 3 caracteres).'; return; }
      var x = await postarQ(url + '/nota', { texto: t });
      if (!x.ok) { erro.textContent = x.j.error || 'Não foi possível anotar.'; return; }
      estado.a.dados = null; fechar(); desenharAnalista();
    });
    $('ao-encerrar').addEventListener('click', async function () {
      erro.textContent = '';
      var nota = $('ao-nota').value.trim();
      if (nota.length < 5) { erro.textContent = 'Deixe a nota do que foi feito (mínimo de 5 caracteres).'; return; }
      if (!window.confirm('Encerrar a sua tratativa e enviar para a validação do gestor? Depois disso você não edita mais.')) return;
      var b = $('ao-encerrar'); b.disabled = true;
      var x = await postarQ(url + '/encerrar', { nota: nota, obs: $('ao-obs').value });
      if (!x.ok) { erro.textContent = x.j.error || 'Não foi possível encerrar.'; b.disabled = false; return; }
      estado.a.dados = null; fechar(); desenharAnalista();
    });
  }

  // ── PORTAL DO SUCESSO DO CLIENTE ──────────────────────────────────────────────────────
  function htmlSucesso(d, f) {
    var regs = d.registros || [], lista = filtrarPortal(regs, f), c = contagemEtapasGestor(regs);
    var op = function (v, rot, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(rot) + '</option>'; };
    var optD = op('', 'Todos os departamentos', !f.depto) + DEPS_OCORRENCIA.map(function (x) { return op(x[0], x[1], f.depto === x[0]); }).join('');
    var optE = op('', 'Todas as etapas', !f.etapa) + ETAPAS_Q.map(function (e) { return op(e, ETAPA_CURTA[e], f.etapa === e); }).join('') + op('vencidas', 'Vencidas', f.etapa === 'vencidas');
    var vistos = {}, analistas = [];
    regs.forEach(function (r) { if (r.analista_id && !vistos[r.analista_id]) { vistos[r.analista_id] = 1; analistas.push({ id: r.analista_id, nome: r.analista_nome || '—' }); } });
    analistas.sort(function (a, b) { return String(a.nome).localeCompare(String(b.nome), 'pt-BR'); });
    var optA = op('', 'Todos os analistas', !f.analista) + analistas.map(function (a) { return op(a.id, a.nome, String(f.analista) === String(a.id)); }).join('');
    var corpo = lista.map(function (r) {
      var fila = r.etapa === 'devolutiva_cliente';
      return '<tr' + (fila ? ' style="background:rgba(194,65,12,.07)"' : '') + '><td>' + data(r.criado_em) + '<div class="sub">' + esc(r.criado_por || '—') + '</div></td><td style="white-space:normal;min-width:170px">' + esc(r.cliente_nome || '—') + '</td>' +
        '<td>' + esc(r.tipo) + '</td><td class="c">' + pillPrioridadeQ(r.prioridade) + '</td><td>' + esc((r.departamentos || []).map(rotuloDepto).join(', ')) + '</td>' +
        '<td style="white-space:normal;min-width:230px"><strong>' + esc(r.assunto || '—') + '</strong><div class="sub" title="' + esc(r.detalhe) + '">' + esc(curtoQ(r.detalhe, 120)) + '</div></td>' +
        '<td>' + esc(r.analista_nome || '—') + '</td><td class="c">' + data(r.prazo) + '</td><td class="c">' + pillEtapaQ(r.etapa) + '</td>' +
        '<td class="c" style="white-space:nowrap"><button type="button" class="gp-footer-btn" data-sabrir="' + esc(r.id) + '" style="width:auto">' + (fila ? (d.final ? 'Devolutiva e encerrar' : 'Ver devolutiva') : 'Ver') + '</button></td></tr>';
    }).join('');
    return '<div class="qa-obs" style="margin-bottom:14px">ℹ Aqui o Sucesso do Cliente recebe a devolutiva do gestor, faz as formalizações com o cliente e <strong>encerra o caso</strong>. ' + (d.final ? 'Você é o <strong>gestor final</strong>: só você encerra o processo.' : 'Só o <strong>gestor final</strong> encerra o processo (para um diretor não encerrar achando que está encerrando só no departamento dele).') + '</div>' +
      '<div class="gp-kpi-row">' +
        kpi('#c2410c', 'Devolutiva ao cliente', c.devolutiva_cliente, 'aguardando o Sucesso do Cliente') +
        kpi('#0e7490', 'Em validação', c.validacao_gestor, 'com os gestores') +
        kpi('#7c3aed', 'Com o analista', c.com_analista, 'em tratamento') +
        kpi('#b45309', 'Aguardando análise', c.registrada + c.tratativa_definida, 'ainda com o gestor') +
        kpi('#166534', 'Encerradas', c.encerrada, 'processo finalizado') +
        kpi('#b91c1c', 'Vencidas', c.vencidas, 'prazo passou') +
      '</div>' +
      '<div class="card"><div class="filter-group" style="margin-bottom:14px">' +
        '<span class="filter-label">Departamento</span><select class="gp-select" id="s-depto">' + optD + '</select>' +
        '<span class="filter-label">Analista</span><select class="gp-select" id="s-analista">' + optA + '</select>' +
        '<span class="filter-label">Etapa</span><select class="gp-select" id="s-etapa">' + optE + '</select>' +
        '<span class="filter-label">Buscar</span><input class="gp-input" id="s-busca" placeholder="Empresa ou assunto" value="' + esc(f.busca || '') + '">' +
        '<button type="button" class="gp-footer-btn" id="s-atualizar" style="width:auto">↻ Atualizar</button></div>' +
        '<div class="card-sub">' + lista.length + ' ocorrência(s) · as da devolutiva ao cliente vêm primeiro</div>' +
        (lista.length ? '<div class="table-wrap"><table><thead><tr><th>Registrada em</th><th>Empresa</th><th>Tipo</th><th class="c">Prioridade</th><th>Departamento</th><th>Assunto</th><th>Analista</th><th class="c">Prazo</th><th class="c">Etapa</th><th class="c"></th></tr></thead><tbody>' + corpo + '</tbody></table></div>'
          : '<div class="vazio">Nenhuma ocorrência neste filtro.</div>') + '</div>';
  }
  async function desenharSucesso() {
    var alvo = $('sec-sucesso'); if (!alvo) return;
    if (!estado.s) estado.s = { dados: null, f: { depto: '', analista: '', etapa: '', busca: '' } };
    var s = estado.s;
    if (!s.dados) {
      alvo.innerHTML = '<div class="vazio">Carregando…</div>';
      try { s.dados = await api('/api/cs/painel/qualidade/sucesso/ocorrencias'); }
      catch (e) { alvo.innerHTML = '<div class="card"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; return; }
    }
    var bs = $('badge-sucesso'); if (bs) bs.textContent = contagemEtapasGestor(s.dados.registros).devolutiva_cliente || '';
    alvo.innerHTML = htmlSucesso(s.dados, s.f);
    var liga = function (id, prop, evento) { var e = $(id); if (e) e.addEventListener(evento || 'change', function () { s.f[prop] = e.value; var pos = e.selectionStart; desenharSucesso(); if (prop === 'busca') { var n = $('s-busca'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (x) { /* sem seleção */ } } } }); };
    liga('s-depto', 'depto'); liga('s-analista', 'analista'); liga('s-etapa', 'etapa'); liga('s-busca', 'busca', 'input');
    var at = $('s-atualizar'); if (at) at.addEventListener('click', function () { estado.s.dados = null; desenharSucesso(); });
    Array.prototype.forEach.call(alvo.querySelectorAll('[data-sabrir]'), function (b) { b.addEventListener('click', function () { abrirOcorrenciaSucesso(b.getAttribute('data-sabrir')); }); });
  }
  function htmlOcorrenciaSucesso(r, final) {
    var topo = '<div class="qa-modal-topo"><strong style="font-size:20px;color:#256050">' + esc(r.assunto || 'Ocorrência') + '</strong><button type="button" class="qa-x" id="so-fechar" aria-label="Fechar">✕</button></div>' +
      '<div class="cinza" style="font-size:12.5px;margin-bottom:10px">' + esc(r.cliente_nome || '') + ' · ' + pillEtapaQ(r.etapa) + '</div>' + cartaoOcorrenciaQ(r, true) + (r.plano_acao ? htmlPlanoGestor(r) : '') + htmlRetornos(r);
    if (r.etapa !== 'devolutiva_cliente') return topo + '<div class="qa-oc-linha qa-oc-bot" style="grid-template-columns:1fr"><button type="button" class="qa-btn-cancel" id="so-cancel">Fechar</button></div>';
    if (!final) return topo + '<div class="qa-obs" style="margin:10px 0">ℹ Esta ocorrência está na devolutiva ao cliente. Faça as formalizações com o cliente; <strong>só o gestor final encerra o processo</strong>.</div><div class="qa-oc-linha qa-oc-bot" style="grid-template-columns:1fr"><button type="button" class="qa-btn-cancel" id="so-cancel">Fechar</button></div>';
    return topo + '<div class="ficha-sec">Devolutiva ao cliente e encerramento</div>' + formNotaObs('so', 'Nota (o que foi devolvido ao cliente)') +
      '<div class="qa-obs" style="margin:6px 0">⚠ Ao clicar em <strong>Encerrada</strong> o processo termina de vez, para todos os departamentos.</div>' +
      '<div class="qa-oc-linha qa-oc-bot"><button type="button" class="qa-btn-cancel" id="so-cancel" style="background:#64748b">Fechar</button><button type="button" class="qa-btn-ok" id="so-encerrar">Encerrada: finalizar o processo</button></div>' +
      '<div class="pop-erro" id="so-erro" role="alert"></div>';
  }
  function abrirOcorrenciaSucesso(id) {
    var d = estado.s && estado.s.dados, r = ((d && d.registros) || []).filter(function (x) { return String(x.id) === String(id); })[0]; if (!r) return;
    var ov = document.createElement('div'); ov.className = 'qa-overlay'; document.body.appendChild(ov);
    var fechar = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); };
    ov.innerHTML = '<div class="qa-modal qa-modal-oc" role="dialog" aria-label="Ocorrência">' + htmlOcorrenciaSucesso(r, !!d.final) + '</div>';
    $('so-fechar').addEventListener('click', fechar); $('so-cancel').addEventListener('click', fechar);
    if (!$('so-encerrar')) return;
    ligarContador('so');
    var erro = $('so-erro');
    $('so-encerrar').addEventListener('click', async function () {
      erro.textContent = ''; var nota = $('so-nota').value.trim();
      if (nota.length < 5) { erro.textContent = 'Deixe a nota da devolutiva (mínimo de 5 caracteres).'; return; }
      if (!window.confirm('Finalizar o processo desta ocorrência de vez? Isso encerra o caso para todos os departamentos.')) return;
      var b = $('so-encerrar'); b.disabled = true;
      var x = await postarQ('/api/cs/painel/qualidade/sucesso/ocorrencias/' + encodeURIComponent(r.id) + '/encerrar', { nota: nota, obs: $('so-obs').value });
      if (!x.ok) { erro.textContent = x.j.error || 'Não foi possível encerrar.'; b.disabled = false; return; }
      estado.s.dados = null; fechar(); desenharSucesso();
    });
  }

  // ── PORTAL DO GESTOR ──────────────────────────────────────────────────────────────────
  function filtrarGestor(regs, f) {
    var b = String((f && f.busca) || '').trim().toLowerCase();
    return (regs || []).filter(function (r) {
      if (f.depto && (r.departamentos || []).indexOf(f.depto) < 0) return false;
      if (f.analista && String(r.analista_id) !== String(f.analista)) return false;
      if (f.etapa === 'vencidas') { if (r.situacao !== 'vencido') return false; } else if (f.etapa && r.etapa !== f.etapa) return false;
      if (b && String(r.cliente_nome || '').toLowerCase().indexOf(b) < 0 && String(r.assunto || '').toLowerCase().indexOf(b) < 0) return false;
      return true;
    });
  }
  function contagemEtapasGestor(regs) {
    var c = { vencidas: 0 }; ETAPAS_Q.forEach(function (e) { c[e] = 0; });
    (regs || []).forEach(function (r) { if (c[r.etapa] !== undefined) c[r.etapa]++; if (r.situacao === 'vencido') c.vencidas++; });
    return c;
  }
  function htmlGestor(d, f) {
    var regs = d.registros || [], esc_ = d.escopo || {}, lista = filtrarGestor(regs, f), c = contagemEtapasGestor(regs);
    var deptos = esc_.todos ? DEPS_OCORRENCIA.map(function (x) { return x[0]; }) : (esc_.deptos || []);
    var op = function (v, rot, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(rot) + '</option>'; };
    var optD = op('', 'Todos os departamentos', !f.depto) + deptos.map(function (x) { return op(x, rotuloDepto(x), f.depto === x); }).join('');
    var ids = {}; regs.forEach(function (r) { if (r.analista_id) ids[r.analista_id] = r.analista_nome || '—'; });
    var optA = op('', 'Todos os analistas', !f.analista) + Object.keys(ids).sort(function (a, b) { return ids[a].localeCompare(ids[b]); }).map(function (k) { return op(k, ids[k], String(f.analista) === String(k)); }).join('');
    var optE = op('', 'Todas as etapas', !f.etapa) + ETAPAS_Q.map(function (e) { return op(e, ETAPA_CURTA[e], f.etapa === e); }).join('') + op('vencidas', 'Vencidas', f.etapa === 'vencidas');
    var corpo = lista.map(function (r) {
      var acao = r.etapa === 'registrada' ? 'Analisar e criar tratativa' : r.etapa === 'tratativa_definida' ? 'Editar / abrir para o analista' : 'Ver';
      return '<tr><td>' + data(r.criado_em) + '<div class="sub">' + esc(r.criado_por || '—') + '</div></td><td style="white-space:normal;min-width:170px">' + esc(r.cliente_nome || '—') + '</td>' +
        '<td>' + esc(r.tipo) + '</td><td class="c">' + pillPrioridadeQ(r.prioridade) + '</td><td>' + esc((r.departamentos || []).map(rotuloDepto).join(', ')) + '</td>' +
        '<td style="white-space:normal;min-width:240px"><strong>' + esc(r.assunto || '—') + '</strong><div class="sub" title="' + esc(r.detalhe) + '">' + esc(curtoQ(r.detalhe, 140)) + '</div>' + anexosQ(r) + '</td>' +
        '<td>' + (r.analista_nome ? esc(r.analista_nome) : '<span class="cinza">—</span>') + '</td><td class="c">' + data(r.prazo) + '</td>' +
        '<td class="c">' + pillEtapaQ(r.etapa) + (r.situacao === 'vencido' ? '<div><span class="pill" style="color:#b91c1c;border-color:#b91c1c55;background:#b91c1c14">vencida</span></div>' : '') + '</td>' +
        '<td class="c" style="white-space:nowrap"><button type="button" class="gp-footer-btn" data-gabrir="' + esc(r.id) + '" style="width:auto">' + acao + '</button></td></tr>';
    }).join('');
    return '<div class="qa-obs" style="margin-bottom:14px">ℹ Trâmite: você analisa a ocorrência, cria a tratativa (plano de ação, responsável e departamento, podendo ajustar o prazo) e abre para o analista. Quando o analista deixar a nota, a validação volta para você; depois de validada, segue para o <strong>Sucesso do Cliente</strong>, que faz a devolutiva ao cliente.</div>' +
      '<div class="gp-kpi-row">' +
        kpi('#b45309', 'Aguardando análise', c.registrada, 'registradas, sem tratativa') +
        kpi('#2563eb', 'Tratativa definida', c.tratativa_definida, 'ainda não abertas ao analista') +
        kpi('#7c3aed', 'Com o analista', c.com_analista, 'em tratamento') +
        kpi('#0e7490', 'Em validação', c.validacao_gestor, 'aguardando você') +
        kpi('#c2410c', 'Devolutiva ao cliente', c.devolutiva_cliente, 'com o Sucesso do Cliente') +
        kpi('#b91c1c', 'Vencidas', c.vencidas, 'prazo passou') +
      '</div>' +
      '<div class="card"><div class="filter-group" style="margin-bottom:14px">' +
        '<span class="filter-label">Departamento</span><select class="gp-select" id="g-depto">' + optD + '</select>' +
        '<span class="filter-label">Analista</span><select class="gp-select" id="g-analista">' + optA + '</select>' +
        '<span class="filter-label">Etapa</span><select class="gp-select" id="g-etapa">' + optE + '</select>' +
        '<span class="filter-label">Buscar</span><input class="gp-input" id="g-busca" placeholder="Empresa ou assunto" value="' + esc(f.busca || '') + '">' +
        '<button type="button" class="gp-footer-btn" id="g-atualizar" style="width:auto">↻ Atualizar</button></div>' +
        '<div class="card-sub">' + lista.length + ' ocorrência(s)' + (esc_.todos ? ' · todos os departamentos' : ' · seus departamentos: ' + esc(deptos.map(rotuloDepto).join(', '))) + '</div>' +
        (lista.length ? '<div class="table-wrap"><table><thead><tr><th>Registrada em</th><th>Empresa</th><th>Tipo</th><th class="c">Prioridade</th><th>Departamento</th><th>Assunto</th><th>Responsável</th><th class="c">Prazo</th><th class="c">Etapa</th><th class="c"></th></tr></thead><tbody>' + corpo + '</tbody></table></div>'
          : '<div class="vazio">Nenhuma ocorrência neste filtro.</div>') + '</div>';
  }
  async function desenharGestor() {
    var alvo = $('sec-gestor'); if (!alvo) return;
    if (!estado.g) estado.g = { dados: null, f: { depto: '', analista: '', etapa: '', busca: '' } };
    var g = estado.g;
    if (!g.dados) {
      alvo.innerHTML = '<div class="vazio">Carregando…</div>';
      try { g.dados = await api('/api/cs/painel/qualidade/gestor/ocorrencias'); await carregarOpcoesQ(); }
      catch (e) { alvo.innerHTML = '<div class="card"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; return; }
    }
    var bg = $('badge-gestor'); if (bg) bg.textContent = contagemEtapasGestor(g.dados.registros).registrada || '';
    alvo.innerHTML = htmlGestor(g.dados, g.f);
    var liga = function (id, prop, evento) { var e = $(id); if (e) e.addEventListener(evento || 'change', function () { g.f[prop] = e.value; var pos = e.selectionStart; desenharGestor(); if (prop === 'busca') { var n = $('g-busca'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (x) { /* sem seleção */ } } } }); };
    liga('g-depto', 'depto'); liga('g-analista', 'analista'); liga('g-etapa', 'etapa'); liga('g-busca', 'busca', 'input');
    var at = $('g-atualizar'); if (at) at.addEventListener('click', function () { estado.g.dados = null; desenharGestor(); });
    Array.prototype.forEach.call(alvo.querySelectorAll('[data-gabrir]'), function (b) { b.addEventListener('click', function () { abrirOcorrenciaGestor(b.getAttribute('data-gabrir')); }); });
  }
  /** Janela da ocorrência no Portal do Gestor: detalhes e a tratativa (editável até abrir para o analista). */
  function htmlTratativaGestor(r, analistas) {
    var editavel = r.etapa === 'registrada' || r.etapa === 'tratativa_definida';
    var depAtual = r.tratativa_depto || (r.departamentos || [])[0] || '';
    var optA = '<option value="">Escolha o analista…</option>' + (analistas || []).map(function (a) { return '<option value="' + esc(a.id) + '"' + (String(r.analista_id) === String(a.id) ? ' selected' : '') + '>' + esc(a.nome) + '</option>'; }).join('');
    var optD = DEPS_OCORRENCIA.map(function (d) { return '<option value="' + esc(d[0]) + '"' + (depAtual === d[0] ? ' selected' : '') + '>' + esc(d[1]) + '</option>'; }).join('');
    var topo = '<div class="qa-modal-topo"><strong style="font-size:20px;color:#256050">' + esc(r.assunto || 'Ocorrência') + '</strong><button type="button" class="qa-x" id="gt-fechar" aria-label="Fechar">✕</button></div>' +
      '<div class="cinza" style="font-size:12.5px;margin-bottom:10px">' + esc(r.cliente_nome || '') + ' · ' + pillEtapaQ(r.etapa) + '</div>' + cartaoOcorrenciaQ(r, true);
    if (!editavel && r.etapa === 'validacao_gestor') {
      return topo + htmlPlanoGestor(r) + htmlRetornos(r) +
        '<div class="ficha-sec">Validar a tratativa</div>' + formNotaObs('gv', 'Nota da validação') +
        '<div class="qa-obs" style="margin:6px 0">ℹ <strong>Validar</strong> envia a ocorrência ao Sucesso do Cliente, que faz a devolutiva ao cliente. <strong>Devolver</strong> volta para o analista ajustar (a nota diz o que falta).</div>' +
        '<div class="qa-oc-linha qa-g-botoes"><button type="button" class="qa-btn-cancel" id="gt-cancel" style="background:#64748b">Fechar</button><button type="button" class="qa-btn-ok" id="gv-devolver" style="background:#b45309">Devolver ao analista</button><button type="button" class="qa-btn-ok" id="gv-validar">Validar: enviar ao Sucesso do Cliente</button></div>' +
        '<div class="pop-erro" id="gv-erro" role="alert"></div>';
    }
    if (!editavel) {
      return topo + htmlRetornos(r) + '<div class="ficha-sec">Tratativa</div><div class="qa-reg"><div class="qa-reg-txt">' + esc(r.plano_acao || '—') + '</div>' +
        '<div class="qa-reg-rod">Responsável: <strong>' + esc(r.analista_nome || '—') + '</strong> · departamento ' + esc(rotuloDepto(r.tratativa_depto || '')) + ' · prazo ' + data(r.prazo) + (r.tratativa_definida_por ? ' · definida por ' + esc(r.tratativa_definida_por) : '') + (r.liberada_em ? ' · aberta ao analista em ' + data(r.liberada_em) : '') + '</div>' +
        (r.gestor_obs ? '<div class="qa-reg-trat"><strong>Observação:</strong> ' + esc(r.gestor_obs) + '</div>' : '') + '</div>' +
        '<div class="qa-oc-linha qa-oc-bot" style="grid-template-columns:1fr"><button type="button" class="qa-btn-cancel" id="gt-cancel">Fechar</button></div>';
    }
    return topo + '<div class="ficha-sec">Criar a tratativa</div>' +
      '<div class="qa-campo"><label for="gt-plano">Plano de ação <span class="req">*</span> <span class="cinza" id="gt-cont">0/2000</span></label><textarea id="gt-plano" rows="5" maxlength="2000" placeholder="O que será feito para resolver e evitar que se repita">' + esc(r.plano_acao || '') + '</textarea></div>' +
      '<div class="qa-oc-linha qa-g-grid">' +
        '<div class="qa-campo"><label for="gt-analista">Responsável <span class="req">*</span></label><select id="gt-analista">' + optA + '</select></div>' +
        '<div class="qa-campo"><label for="gt-depto">Departamento que trata <span class="req">*</span></label><select id="gt-depto">' + optD + '</select></div>' +
        '<div class="qa-campo"><label for="gt-prazo">Prazo para execução (SLA) <span class="req">*</span></label><input type="date" id="gt-prazo" min="' + hojeIsoLocal() + '" value="' + esc(r.prazo || '') + '"></div>' +
      '</div>' +
      '<div class="qa-campo"><label for="gt-obs">Observação</label><textarea id="gt-obs" rows="2" maxlength="600" placeholder="Opcional: orientação ao analista">' + esc(r.gestor_obs || '') + '</textarea></div>' +
      '<div class="cinza" style="font-size:12px;margin:6px 0">Salvar guarda a tratativa e você ainda pode editar. <strong>Salvar e abrir para o analista</strong> libera para ele tratar; depois disso não se edita mais por aqui.</div>' +
      '<div class="qa-oc-linha qa-g-botoes"><button type="button" class="qa-btn-cancel" id="gt-cancel" style="background:#64748b">Fechar</button><button type="button" class="qa-btn-ok" id="gt-salvar" style="background:#2563eb">Salvar tratativa</button><button type="button" class="qa-btn-ok" id="gt-abrir">Salvar e abrir para o analista</button></div>' +
      '<div class="pop-erro" id="gt-erro" role="alert"></div>';
  }
  function abrirOcorrenciaGestor(id) {
    var r = ((estado.g && estado.g.dados && estado.g.dados.registros) || []).filter(function (x) { return String(x.id) === String(id); })[0]; if (!r) return;
    var ov = document.createElement('div'); ov.className = 'qa-overlay'; document.body.appendChild(ov);
    var fechar = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); };
    ov.innerHTML = '<div class="qa-modal qa-modal-oc" role="dialog" aria-label="Ocorrência">' + htmlTratativaGestor(r, estado.qAnalistas || []) + '</div>';
    $('gt-fechar').addEventListener('click', fechar); $('gt-cancel').addEventListener('click', fechar);
    if ($('gv-validar')) {   // validação do que o analista tratou
      ligarContador('gv');
      var verro = $('gv-erro'), base = '/api/cs/painel/qualidade/gestor/ocorrencias/' + encodeURIComponent(r.id);
      var decidir = async function (acao, confirmacao) {
        verro.textContent = ''; var nota = $('gv-nota').value.trim();
        if (nota.length < 5) { verro.textContent = acao === 'devolver' ? 'Diga na nota o que o analista precisa ajustar (mínimo de 5 caracteres).' : 'Deixe a nota da validação (mínimo de 5 caracteres).'; return; }
        if (!window.confirm(confirmacao)) return;
        $('gv-validar').disabled = true; $('gv-devolver').disabled = true;
        var x = await postarQ(base + '/' + acao, { nota: nota, obs: $('gv-obs').value });
        if (!x.ok) { verro.textContent = x.j.error || 'Não foi possível concluir.'; $('gv-validar').disabled = false; $('gv-devolver').disabled = false; return; }
        estado.g.dados = null; fechar(); desenharGestor();
      };
      $('gv-validar').addEventListener('click', function () { decidir('validar', 'Validar e enviar ao Sucesso do Cliente para a devolutiva ao cliente?'); });
      $('gv-devolver').addEventListener('click', function () { decidir('devolver', 'Devolver ao analista para ajustar?'); });
      return;
    }
    if (!$('gt-salvar')) return;
    var plano = $('gt-plano'), erro = $('gt-erro');
    plano.addEventListener('input', function () { $('gt-cont').textContent = plano.value.length + '/2000'; });
    $('gt-cont').textContent = plano.value.length + '/2000';
    var salvar = async function (abrir) {
      erro.textContent = '';
      var corpo = { plano: plano.value, analista_id: $('gt-analista').value, departamento: $('gt-depto').value, prazo: $('gt-prazo').value, obs: $('gt-obs').value };
      if (plano.value.trim().length < 5) { erro.textContent = 'Descreva o plano de ação (mínimo de 5 caracteres).'; return; }
      if (!corpo.analista_id) { erro.textContent = 'Escolha o responsável (analista).'; return; }
      if (!corpo.prazo) { erro.textContent = 'Informe o prazo para execução.'; return; }
      if (corpo.prazo < hojeIsoLocal()) { erro.textContent = 'O prazo não pode ser uma data que já passou.'; return; }
      if (abrir) {
        var nome = $('gt-analista').options[$('gt-analista').selectedIndex].text;
        if (!window.confirm('Abrir esta ocorrência para ' + nome + '? Depois disso você não edita mais a tratativa por aqui.')) return;
      }
      var b1 = $('gt-salvar'), b2 = $('gt-abrir'); b1.disabled = true; b2.disabled = true;
      try {
        var resp = await chamarApi('/api/cs/painel/qualidade/gestor/ocorrencias/' + encodeURIComponent(r.id) + '/tratativa', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
        var j = await resp.json().catch(function () { return {}; });
        if (!resp.ok) { erro.textContent = j.error || 'Não foi possível salvar a tratativa.'; b1.disabled = false; b2.disabled = false; return; }
        if (abrir) {
          var ra = await chamarApi('/api/cs/painel/qualidade/gestor/ocorrencias/' + encodeURIComponent(r.id) + '/abrir', { method: 'POST' });
          var ja = await ra.json().catch(function () { return {}; });
          if (!ra.ok) { erro.textContent = 'A tratativa foi salva, mas não abriu para o analista: ' + (ja.error || 'tente de novo.'); b1.disabled = false; b2.disabled = false; estado.g.dados = null; return; }
        }
        fechar(); estado.g.dados = null; desenharGestor();
      } catch (e) { erro.textContent = 'Sem conexão com o servidor. Tente de novo.'; b1.disabled = false; b2.disabled = false; }
    };
    $('gt-salvar').addEventListener('click', function () { salvar(false); });
    $('gt-abrir').addEventListener('click', function () { salvar(true); });
  }

  /** Janela "Gerenciar gestores por departamento" (o miolo). j = resposta de /qualidade/gestores. */
  function htmlGestoresQ(j) {
    var optU = '<option value="">Escolha a pessoa…</option>' + (j.usuarios || []).map(function (u) { return '<option value="' + esc(u.id) + '"' + (u.sem_login ? ' disabled' : '') + '>' + esc(u.name) + (u.sem_login ? ' (sem login vinculado)' : '') + '</option>'; }).join('');
    return '<div class="qa-modal-topo"><strong>Gerenciar gestores por departamento</strong><button type="button" class="qa-x" id="qg-fechar" aria-label="Fechar">✕</button></div>' +
      '<div class="cinza" style="font-size:12px;margin-bottom:10px">As pessoas desta lista são os analistas, com o nome completo. Para incluir ou excluir alguém, use <button type="button" class="gp-footer-btn" id="qg-analistas" style="width:auto;display:inline-block;padding:2px 8px">Gerenciar analistas</button> (quem não tiver login vinculado aparece desabilitado). Administradores sem cadastro de analista também aparecem, para diretor ou gestor final.</div>' +
      '<div class="cinza" style="font-size:12px;margin-bottom:10px">A ocorrência vai para o gestor do departamento escolhido. Departamento sem gestor: vai para o Sucesso do Cliente. Pode haver mais de um gestor por departamento; o diretor fica acima do gestor (diretores costumam ser administradores e já enxergam tudo, por isso não recebem a fila). O gestor final é quem encerra o processo no portal do Sucesso do Cliente.</div>' +
      (j.departamentos || []).map(function (d) {
        var chips = d.gestores.length ? d.gestores.map(function (g) {
          return '<span class="qg-chip">' + esc(g.nome) + ' <small>' + (g.papel === 'diretor' ? 'diretor' : g.papel === 'final' ? 'gestor final' : 'gestor') + '</small><button type="button" data-gdel="' + esc(g.id) + '" title="Retirar" aria-label="Retirar ' + esc(g.nome) + '">✕</button></span>';
        }).join('') : '<span class="cinza">sem gestor: as ocorrências vão para o Sucesso do Cliente</span>';
        return '<div class="qg-dep"><div class="qg-dep-nome">' + esc(d.rotulo) + '</div><div class="qg-chips">' + chips + '</div>' +
          '<div class="qg-add"><select data-gsel="' + esc(d.codigo) + '">' + optU + '</select><select data-gpap="' + esc(d.codigo) + '"><option value="gestor">Gestor</option><option value="diretor">Diretor</option><option value="final">Gestor final</option></select>' +
          '<button type="button" class="gp-footer-btn" data-gadd="' + esc(d.codigo) + '" style="width:auto">+ Adicionar</button></div></div>';
      }).join('') + '<div class="pop-erro" id="qg-erro" role="alert"></div>';
  }
  async function abrirGerenciarGestores(aoFechar) {
    var ov = document.createElement('div'); ov.className = 'qa-overlay'; document.body.appendChild(ov);
    var fechar = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); if (aoFechar) aoFechar(); };
    var desenhar = async function () {
      var j;
      try { j = await api('/api/cs/painel/qualidade/gestores'); } catch (e) { window.alert(e.message || 'Não foi possível ler os gestores.'); fechar(); return; }
      ov.innerHTML = '<div class="qa-modal qa-modal-gest" role="dialog" aria-label="Gerenciar gestores">' + htmlGestoresQ(j) + '</div>';
      $('qg-fechar').addEventListener('click', fechar);
      $('qg-analistas').addEventListener('click', function () { abrirGerenciarAnalistas(desenhar); });
      var falha = function (m) { $('qg-erro').textContent = m; };
      Array.prototype.forEach.call(ov.querySelectorAll('[data-gadd]'), function (b) {
        b.addEventListener('click', async function () {
          var dep = b.getAttribute('data-gadd'), u = ov.querySelector('[data-gsel="' + dep + '"]').value, papel = ov.querySelector('[data-gpap="' + dep + '"]').value;
          if (!u) { falha('Escolha a pessoa para ' + dep + '.'); return; }
          var r = await chamarApi('/api/cs/painel/qualidade/gestores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: u, departamento: dep, papel: papel }) });
          var x = await r.json().catch(function () { return {}; });
          if (!r.ok) { falha(x.error || 'Não foi possível cadastrar.'); return; }
          desenhar();
        });
      });
      Array.prototype.forEach.call(ov.querySelectorAll('[data-gdel]'), function (b) {
        b.addEventListener('click', async function () {
          if (!window.confirm('Retirar esta pessoa da lista de gestores do departamento?')) return;
          var r = await chamarApi('/api/cs/painel/qualidade/gestores/' + encodeURIComponent(b.getAttribute('data-gdel')), { method: 'DELETE' });
          var x = await r.json().catch(function () { return {}; });
          if (!r.ok) { falha(x.error || 'Não foi possível retirar.'); return; }
          desenhar();
        });
      });
    };
    desenhar();
  }

  async function desenharQualidadeMod() {
    var alvo = $('sec-consideracoes'); if (!alvo) return;
    try { if (!estado.qResumo) { alvo.innerHTML = '<div class="vazio">Carregando…</div>'; await carregarResumoQ(); } }
    catch (e) { alvo.innerHTML = '<div class="card"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; return; }
    var r = estado.qResumo;
    var tot = { abertos: 0, em_tratamento: 0, vencidos: 0, resolvidos: 0, a_validar: 0 };
    r.analistas.forEach(function (a) { tot.abertos += a.abertos; tot.em_tratamento += a.em_tratamento; tot.vencidos += a.vencidos; tot.resolvidos += a.resolvidos; tot.a_validar += a.a_validar || 0; });
    var bq = $('badge-qualmod'); if (bq) bq.textContent = tot.a_validar || '';          // aviso no menu: tratativas finalizadas aguardando validação
    var aviso = '';
    if (tot.a_validar) {
      var quem = r.analistas.filter(function (a) { return a.a_validar > 0; });
      aviso = '<div class="qa-aviso" role="alert"><div><strong>' + tot.a_validar + ' tratativa(s) finalizada(s) aguardando a sua validação.</strong> ' +
        'O analista informou que concluiu: abra o analista, confira o que foi feito e clique em "Dar como finalizado" para encerrar o processo (ou "Devolver ao analista").</div><div class="qa-aviso-acoes">' +
        quem.map(function (a) { return '<button type="button" class="gp-footer-btn" data-qan="' + esc(a.id) + '" style="width:auto">' + esc(a.nome) + ' (' + a.a_validar + ')</button>'; }).join('') + '</div></div>';
    }
    var pesoBox = '';
    if (ehAdminPainel()) {
      var tiposQ = [];
      try { tiposQ = ((await api('/api/cs/painel/qualidade/tipos')).tipos || []).filter(function (t) { return t.ativo; }); } catch (e) { tiposQ = []; }
      pesoBox = comoPesaTratativa(tiposQ, estado.qPesoAberto);
    }
    alvo.innerHTML =
      '<div class="qa-barra"><button type="button" class="login-btn" id="q-registrar" style="width:auto;margin:0;padding:10px 22px">＋ Registrar ocorrência</button>' +
        (ehAdminPainel() ? '<button type="button" class="gp-footer-btn" id="q-gerenciar" style="width:auto">Gerenciar analistas</button><button type="button" class="gp-footer-btn" id="q-tipos" style="width:auto">Gerenciar tipos de registro</button><button type="button" class="gp-footer-btn" id="q-gestores" style="width:auto">Gerenciar gestores</button>' : '') + '<span class="qa-obs">⚠ Usar só para fatos fora do padrão (reclamação, insatisfação, multa, caso grave), não para o atendimento do dia a dia.</span></div>' +
      '<div class="gp-kpi-row">' +
        kpi('#7c3aed', 'A validar', tot.a_validar, 'finalizadas pelo analista, aguardando você') +
        kpi('#b45309', 'Em aberto', tot.abertos, 'aguardando o analista começar') +
        kpi('#2563eb', 'Em tratamento', tot.em_tratamento, 'o analista já está tratando') +
        kpi('#b91c1c', 'Vencidos', tot.vencidos, 'prazo passou e ainda não foi resolvido') +
        kpi('#166534', 'Resolvidos', tot.resolvidos, 'considerações encerradas') +
      '</div>' +
      aviso + recentesQ() + pesoBox;
    var atualiza = function () { estado.qResumo = null; desenharQualidadeMod(); };
    var reg = $('q-registrar'); if (reg) reg.addEventListener('click', function () { abrirRegistrarOcorrencia(atualiza); });
    var g = $('q-gerenciar'); if (g) g.addEventListener('click', function () { abrirGerenciarAnalistas(atualiza); });
    var gt = $('q-tipos'); if (gt) gt.addEventListener('click', function () { estado.qOpcoes = null; abrirGerenciarTipos(function () { desenharQualidadeMod(); }); });
    var gg = $('q-gestores'); if (gg) gg.addEventListener('click', function () { abrirGerenciarGestores(null); });
    Array.prototype.forEach.call(document.querySelectorAll('#sec-consideracoes [data-qan]'), function (bt) { bt.addEventListener('click', function () { abrirFichaAnalistaQ(bt.getAttribute('data-qan')); }); });
    var box = $('q-peso-box'); if (box) box.addEventListener('toggle', function () { estado.qPesoAberto = !!box.open; });
    Array.prototype.forEach.call(document.querySelectorAll('#sec-consideracoes .qt-inline[data-tid]'), function (inp) {
      inp.addEventListener('change', async function () {
        var resp = await chamarApi('/api/cs/painel/qualidade/tipos/' + encodeURIComponent(inp.getAttribute('data-tid')), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peso: inp.value }) });
        var j = await resp.json().catch(function () { return {}; });
        if (!resp.ok) window.alert(j.error || 'Não foi possível salvar o peso.');
        estado.qOpcoes = null; desenharQualidadeMod();
      });
    });
    var add = $('qpn-add'); if (add) add.addEventListener('click', async function () {
      var nome = $('qpn-nome').value;
      var resp = await chamarApi('/api/cs/painel/qualidade/tipos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome: nome, peso: $('qpn-peso').value }) });
      var j = await resp.json().catch(function () { return {}; });
      if (!resp.ok) { window.alert(j.error || 'Não foi possível incluir o tipo.'); return; }
      estado.qOpcoes = null; estado.qPesoAberto = true; desenharQualidadeMod();
    });
  }

  async function abrirFichaAnalistaQ(id) {
    $('ficha').style.display = 'flex';
    $('ficha-nome').textContent = 'Carregando…'; $('ficha-sub').textContent = ''; $('ficha-passo').style.display = 'none'; $('ficha-corpo').innerHTML = '';
    try {
      var j = await api('/api/cs/painel/qualidade/analista/' + encodeURIComponent(id));
      var a = j.analista, regs = j.registros;
      var cont = function (s) { return regs.filter(function (r) { return r.situacao === s; }).length; };
      $('ficha-nome').textContent = a.nome;
      $('ficha-sub').textContent = 'Considerações registradas para este analista (Sucesso do Cliente / Time Operacional)';
      var linhas = regs.map(function (r) {
        var abertos = r.status === 'aberto' || r.status === 'em_tratamento';
        return '<tr><td>' + data(r.criado_em) + '</td><td>' + data(r.prazo) + '</td><td>' + pillStatusQ(r.situacao) + '</td>' +
          '<td style="white-space:normal">' + esc(r.cliente_nome || '—') + '<div class="sub">' + esc(r.cnpj || '') + '</div></td>' +
          '<td>' + esc(r.tipo) + '<div class="sub">' + esc((r.departamentos || []).join(', ')) + '</div></td>' +
          '<td style="white-space:normal;min-width:220px">' + esc(r.detalhe) + (r.tratativa ? '<div class="qa-reg-trat"><strong>Tratativa:</strong> ' + esc(r.tratativa) + '</div>' : '') + notasHtml(r) + '<div class="sub">lançado por ' + esc(r.criado_por || '—') + '</div></td>' +
          '<td style="white-space:normal">' + (r.status === 'finalizada' ?
            '<button type="button" class="login-btn" data-qvalida="' + esc(r.id) + '" style="width:auto;margin:0;padding:6px 12px">Dar como finalizado</button> ' +
            '<button type="button" class="gp-footer-btn" data-qdevolve="' + esc(r.id) + '" style="width:auto">Devolver ao analista</button>' : abertos ?
            (r.status === 'aberto' ? '<button type="button" class="gp-footer-btn" data-qst="' + esc(r.id) + '" data-novo="em_tratamento" style="width:auto">Em tratamento</button> ' : '') +
            '<button type="button" class="gp-footer-btn" data-qst="' + esc(r.id) + '" data-novo="resolvido" style="width:auto">Resolver</button> ' +
            '<button type="button" class="gp-footer-btn" data-qpz="' + esc(r.id) + '" data-prazo="' + esc(r.prazo) + '" style="width:auto">Prazo</button> ' +
            '<button type="button" class="gp-footer-btn" data-qst="' + esc(r.id) + '" data-novo="cancelado" style="width:auto">Cancelar</button>' : '') +
          (ehAdminPainel() ? ' <button type="button" class="gp-footer-btn qa-excluir" data-qdel="' + esc(r.id) + '" style="width:auto" title="Apaga o registro de vez (teste ou lançamento errado)">Excluir</button>' : '') + '</td></tr>';
      }).join('');
      var adminLogin = '';
      if (ehAdminPainel()) {
        var us = [];
        try { us = (await api('/api/users')).users || []; } catch (e) { us = []; }
        adminLogin = '<div class="qa-linha" style="margin:10px 0"><div class="qa-campo"><label for="qa-login">Login deste analista (para a página Minhas tratativas)</label><select id="qa-login"><option value="">Sem login ligado</option>' +
          us.filter(function (u) { return u.ativo !== false; }).map(function (u) { return '<option value="' + esc(u.id) + '"' + (String(a.user_id) === String(u.id) ? ' selected' : '') + '>' + esc(u.name) + ' · ' + esc(u.email) + '</option>'; }).join('') + '</select></div></div>';
      }
      $('ficha-corpo').innerHTML =
        '<div class="blocos">' + bloco('Em aberto', cont('aberto'), 'aguardando o analista começar', cont('aberto') ? '#b45309' : null) +
          bloco('A validar', cont('finalizada'), 'finalizadas pelo analista', cont('finalizada') ? '#7c3aed' : null) +
          bloco('Em tratamento', cont('em_tratamento'), 'o analista já está tratando', null) +
          bloco('Vencidos', cont('vencido'), 'prazo passou sem resolver', cont('vencido') ? '#b91c1c' : null) +
          bloco('Resolvidos', cont('resolvido'), 'encerradas', null) + '</div>' + adminLogin +
        '<div class="ficha-sec">Registros</div>' +
        (regs.length ? '<div class="table-wrap"><table><thead><tr><th>Lançamento</th><th>Prazo</th><th>Status</th><th>Empresa</th><th>Tipo / departamentos</th><th>Ocorrência</th><th>Ações</th></tr></thead><tbody>' + linhas + '</tbody></table></div>'
          : '<div class="linha-item"><span class="x">Nenhuma consideração registrada para este analista.</span></div>');
      var lg = $('qa-login');
      if (lg) lg.addEventListener('change', async function () {
        var r = await chamarApi('/api/cs/painel/qualidade/vinculo/' + encodeURIComponent(a.id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: lg.value || null }) });
        if (!r.ok) { var x = await r.json().catch(function () { return {}; }); window.alert(x.error || 'Não foi possível ligar o login.'); } else estado.qResumo = null;
      });
      var mudar = async function (rid, corpo) {
        var r = await chamarApi('/api/cs/painel/qualidade/' + encodeURIComponent(rid), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
        var x = await r.json().catch(function () { return {}; });
        if (!r.ok) { window.alert(x.error || 'Não foi possível atualizar.'); return; }
        estado.qResumo = null; abrirFichaAnalistaQ(id); desenharQualidadeMod();
      };
      Array.prototype.forEach.call(document.querySelectorAll('#ficha-corpo [data-qst]'), function (b) {
        b.addEventListener('click', function () {
          var novo = b.getAttribute('data-novo'), rid = b.getAttribute('data-qst');
          if (novo === 'resolvido') { var t = window.prompt('O que foi feito para resolver?'); if (t == null) return; mudar(rid, { status: 'resolvido', tratativa: t }); }
          else if (novo === 'cancelado') { if (window.confirm('Cancelar esta consideração? Ela deixa de pesar no risco do cliente.')) mudar(rid, { status: 'cancelado' }); }
          else mudar(rid, { status: novo });
        });
      });
      Array.prototype.forEach.call(document.querySelectorAll('#ficha-corpo [data-qdel]'), function (b) {
        b.addEventListener('click', async function () {
          if (!window.confirm('Excluir este registro de vez? Isso não pode ser desfeito. (Para só tirar do risco e manter o histórico, use Cancelar.)')) return;
          var r = await chamarApi('/api/cs/painel/qualidade/' + encodeURIComponent(b.getAttribute('data-qdel')), { method: 'DELETE' });
          var x = await r.json().catch(function () { return {}; });
          if (!r.ok) { window.alert(x.error || 'Não foi possível excluir.'); return; }
          estado.qResumo = null; abrirFichaAnalistaQ(id); desenharQualidadeMod();
        });
      });
      Array.prototype.forEach.call(document.querySelectorAll('#ficha-corpo [data-qvalida]'), function (b) {
        b.addEventListener('click', function () { if (window.confirm('Dar esta tratativa como finalizada e encerrar o processo?')) mudar(b.getAttribute('data-qvalida'), { status: 'resolvido' }); });
      });
      Array.prototype.forEach.call(document.querySelectorAll('#ficha-corpo [data-qdevolve]'), function (b) {
        b.addEventListener('click', function () {
          var m = window.prompt('O que falta? (o analista vai ver este motivo)'); if (m == null) return;
          mudar(b.getAttribute('data-qdevolve'), { status: 'em_tratamento', motivo: m });
        });
      });
      Array.prototype.forEach.call(document.querySelectorAll('#ficha-corpo [data-qpz]'), function (b) {
        b.addEventListener('click', function () {
          var p = window.prompt('Novo prazo (AAAA-MM-DD):', b.getAttribute('data-prazo')); if (p == null) return;
          mudar(b.getAttribute('data-qpz'), { prazo: p.trim() });
        });
      });
    } catch (e) { $('ficha-nome').textContent = 'Não foi possível abrir o analista'; $('ficha-corpo').innerHTML = '<div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div>'; }
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
        linha('Tratativas com dado', t.termometros.tratativas.com_dado, 'Só tem dado quem tem ocorrência lançada no módulo Qualidade com tratativa em aberto (últimos 90 dias); os demais ficam de fora da média.') +
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
      if (p == null) return bloco(NOME_TERM[k], k === 'tratativas' ? 'Nada em aberto' : 'Sem dado', esc(det || 'sem informação desta fonte'), null);
      var n = nivelTerm(p, cortes);
      return bloco(NOME_TERM[k], n + ' · ' + p, esc(det), COR_RISCO[n]);
    };
    var blocos1 = '<div class="blocos">' + bloco('Risco de perda', r.nivel + (r.pontos != null ? ' · ' + r.pontos : '') + (r.alerta ? ' ⚠️' : ''), r.alerta ? '<span style="color:#dc2626">termômetro muito alto: alerta</span>' : 'média dos termômetros com dado', COR_RISCO[r.nivel]) + '</div>' +
      '<div class="blocos">' + termBloco('financeiro') + termBloco('atendimento') + termBloco('operacional') + termBloco('tratativas') + '</div>';
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
    var resumoAt = '<div class="blocos">' + bloco('Atendimentos (90 dias)', f.tickets.length, 'conversas no Zappy', null) + bloco('SLA vermelho', vermelhos, 'antes da revisão da Gamificação', vermelhos ? '#dc2626' : null) + bloco('Notas baixas', notasBaixas, 'nota 1 ou 2', notasBaixas ? '#dc2626' : null) + '</div>';
    // a lista de atendimentos (data, setor, atendente, nota, SLA) agora vive no módulo Atendimento
    var tick = '<div class="nota" style="margin-top:8px">A lista completa dos atendimentos e dos e-mails por destinatário está no módulo <strong>Atendimento</strong>.</div>';
    // e-mails: pedidos esperando resposta (leitura semanal) e histórico de 180 dias, quando a leitura existir
    var emailSec = '';
    if (f.emails) {
      var es = f.emails.sinais, eh = f.emails.historico, ep = [];
      var tipEm = eh ? esc(dicaEmails(eh)) : '';
      if (es) {
        var aguard = es.aguardando_4h + es.aguardando_compartilhado;
        ep.push(bloco('E-mails aguardando resposta', aguard, aguard ? 'o mais antigo há ' + (es.mais_antigo_h >= 48 ? Math.round(es.mais_antigo_h / 24) + ' dias' : es.mais_antigo_h + ' h') : 'nenhum pedido esperando (últimos 14 dias)', aguard ? '#dc2626' : null));
      }
      if (eh) {
        ep.push(bloco('E-mails recebidos (180 dias)', eh.recebidos, 'cópias em várias caixas contam uma vez', null).replace('<div class="bloco">', '<div class="bloco" title="' + tipEm + '">'));
        ep.push(bloco('Sem resposta (180 dias)', eh.sem_resposta, 'passe o mouse para ver por destinatário', eh.sem_resposta ? '#dc2626' : null).replace('<div class="bloco">', '<div class="bloco" title="' + tipEm + '">'));
      }
      if (ep.length) emailSec = '<div class="ficha-sec">E-mails</div><div class="blocos">' + ep.join('') + '</div>';
    }
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

    // Sinais de atenção = só o resumo de cada critério; o detalhe fica nas seções Financeiro, Acessórias, Qualidade e Atendimentos logo abaixo.
    var sinais = (r.motivos || []).map(function (m) { return '<span class="chip" style="color:#dc2626;border-color:#dc262655">' + esc(m) + '</span>'; }).join('') || '<span class="cinza">nenhum sinal de atenção</span>';

    // Seção Atendimentos: só o que pesa (SLA vermelho, nota baixa, insatisfação, cliente sensível, pesquisa); a lista completa e os e-mails ficam no módulo Atendimento.
    var ruins = f.tickets.filter(function (t) { return t.pior_status === 'vermelho' || (t.nota_avaliacao != null && t.nota_avaliacao <= 2); });
    var sub = function (t) { return '<div class="cinza" style="font-size:12px;font-weight:700;margin:12px 0 4px">' + t + '</div>'; };
    var atendSec = secaoFicha('atendimentos', 'Atendimentos', resumoAt +
      sub('Atendimentos com SLA vermelho ou nota baixa (90 dias)') + (ruins.length ? tabelaAtendimentos(ruins) : '<div class="linha-item"><span class="x">Nenhum atendimento com SLA vermelho ou nota baixa nos últimos 90 dias.</span></div>') +
      sub('Insatisfações registradas (180 dias)') + insat + (sens ? sub('Cliente sensível (90 dias)') + sens : '') + (pesq ? sub('Pesquisas (180 dias)') + pesq : '') + '<div class="nota" style="margin-top:10px">Atendimentos do Zappy e e-mails (recebidos e sem resposta, por destinatário) estão no módulo <strong>Atendimento</strong>.</div>');
    $('ficha-corpo').innerHTML = blocos1 + blocos2 +
      '<div class="ficha-sec">Sinais de atenção</div><div>' + sinais + '</div>' +
      '<div class="ficha-sec">Considerações Sucesso do Cliente / Time Operacional</div><div id="qa-secao"></div>' +
      secaoFicha('financeiro', 'Financeiro', fin) +
      secaoFicha('acessorias', 'Acessórias', oper + '<div id="ac-lista" style="margin-top:8px"><span class="cinza">Consultando as obrigações no Acessórias…</span></div>') +
      secaoFicha('qualidade', 'Qualidade', '<div id="qa-ocorrencias"><span class="cinza">Carregando…</span></div>') +
      atendSec;
    ligarSecoesFicha();
    montarConsideracoes(c);
    carregarAcessoriasFicha(c.id);
  }

  /** Lista de obrigações do Acessórias (em aberto ou com atraso), consultada na hora; mostra o resultado só se a ficha ainda é a do mesmo cliente. */
  async function carregarAcessoriasFicha(id) {
    var mesma = function () { return !!$('ac-lista') && !!estado.ficha && String(estado.ficha.cliente.id) === String(id); };
    try {
      var j = await api('/api/cs/painel/cliente/' + encodeURIComponent(id) + '/acessorias');
      if (!mesma()) return;
      $('ac-lista').innerHTML = tabelaAcessorias(j.itens || []) + '<div class="cinza" style="font-size:11px;margin-top:4px">Consultado no Acessórias agora (últimos ' + j.janela_dias + ' dias). Só entram as entregas que chegam ao cliente.</div>';
    } catch (e) {
      if (mesma()) $('ac-lista').innerHTML = '<div class="linha-item"><span class="x">Não foi possível listar as obrigações agora (' + esc(e.message) + '). Os totais acima vêm da última leitura.</span></div>';
    }
  }

  /** Seções da ficha que recolhem: começam recolhidas (só o nome e a setinha) e lembram, neste navegador, as que a pessoa abriu. */
  var CHAVE_SECOES = 'cs_ficha_abertas';
  function secoesAbertas() { try { return JSON.parse(ls(CHAVE_SECOES) || '{}') || {}; } catch (e) { return {}; } }
  function secaoFicha(chave, titulo, corpo) {
    return '<details class="ficha-det" data-sec="' + chave + '"' + (secoesAbertas()[chave] ? ' open' : '') + '><summary class="ficha-sec"><span class="sp">▸</span> ' + titulo + '</summary>' + corpo + '</details>';
  }
  function ligarSecoesFicha() {
    Array.prototype.forEach.call(document.querySelectorAll('#ficha-corpo .ficha-det'), function (d) {
      d.addEventListener('toggle', function () { var m = secoesAbertas(); m[d.getAttribute('data-sec')] = d.open ? 1 : 0; ls(CHAVE_SECOES, JSON.stringify(m)); });
    });
  }

  function fecharFicha() { $('ficha').style.display = 'none'; document.querySelector('.ficha-box').classList.remove('larga'); }

  // ── EXPORTAÇÃO (CSV e PDF) ───────────────────────────────────────────────────
  // Exporta TODAS as linhas do filtro atual da seção aberta (não só a página). Os dados já vieram do servidor com as permissões e os
  // valores ocultos aplicados; com "Ocultar valores" ligado, os valores em R$ saem como "oculto".
  var SEC_EXPORTA = { visao: 1, analise: 1, anual: 1, atendimento: 1, risco: 1, churn: 1, categorias: 1 };
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
      ['financeiro', 'atendimento', 'operacional', 'tratativas'].forEach(function (k) {
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
    if (sec === 'atendimento') {
      if (!estado.atend) return null;
      var fat = filtroAtend(), la = linhasAtend(), fx2 = []; if (fat.busca) fx2.push('Busca: ' + fat.busca); if (fat.soSem) fx2.push('Só com e-mail sem resposta');
      return { arquivo: 'cs-atendimento', titulo: 'Painel do Sucesso do Cliente - Atendimento (' + estado.atend.janela_dias + ' dias)',
        filtros: [la.length + ' cliente(s)' + (fx2.length ? ' · ' + fx2.join(' · ') : '') + ' · ordem alfabética', aviso],
        colunas: ['Razão social', 'Documento', 'Categoria', 'Atendimentos', 'SLA vermelho', 'Notas baixas', 'Último atendimento', 'E-mails recebidos', 'E-mails sem resposta', 'Sem resposta por destinatário'],
        linhas: la.map(function (c) {
          var sem = c.email ? (c.email.destinatarios || []).filter(function (d) { return d.sem > 0; }).map(function (d) { return d.nome + ': ' + d.sem; }).join(' | ') : '';
          return [c.nome, c.cnpj || '', c.categoria || '', c.atendimentos, c.sla_vermelho, c.notas_baixas, c.ultimo ? data(c.ultimo) : '', c.email ? c.email.recebidos : '', c.email ? c.email.sem_resposta : '', sem];
        }),
        alinhar: ['left', 'left', 'left', 'center', 'center', 'center', 'center', 'center', 'center', 'left'], fonte: 7 };
    }
    if (sec === 'risco') {
      var fr = estado.filtroRisco, lr = filtrarRisco();
      var fx = ['Risco: ' + (ROT_NIVEL[fr.nivel] || fr.nivel)]; if (fr.busca) fx.push('Busca: ' + fr.busca); if (fr.cat) fx.push('Categoria: ' + fr.cat); if (fr.term) fx.push('Pesa mais: ' + NOME_TERM[fr.term]); if (fr.soAtend) fx.push('Só com sinal de Atendimento');
      return { arquivo: 'cs-gestao-da-permanencia', titulo: 'Painel do Sucesso do Cliente - Gestão da Permanência', filtros: [lr.length + ' cliente(s) · ' + fx.join(' · ') + ' · ordem alfabética', aviso],
        colunas: ['Cliente', 'CNPJ', 'Categoria', 'Risco', 'Pontos', 'Financeiro', 'Atendimento', 'Operacional', 'Tratativas', 'Suspenso no Omie', 'Honorário (R$)', 'O que está puxando'],
        linhas: lr.map(function (c) {
          var tm = c.risco.termometros, v = function (x) { return x == null ? 'sem dado' : x; };
          return [c.nome, c.cnpj || '', c.categoria || '', c.risco.nivel, c.risco.pontos == null ? '' : c.risco.pontos, v(tm.financeiro), v(tm.atendimento), v(tm.operacional), tm.tratativas == null ? '' : tm.tratativas, c.risco.suspenso ? 'Sim' : '', moedaExp(c.honorario), (c.risco.motivos || []).join(' | ')];
        }),
        alinhar: ['left', 'left', 'left', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'right', 'left'], fonte: 7 };
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
  /** O botão "Ocultar valores" só faz sentido onde há valores em R$: os portais (Gestor, Analista e Sucesso do Cliente) não têm. */
  function botaoValoresVisivel(admin, sec) { return !!admin && ['gestor', 'analista', 'sucesso'].indexOf(sec) < 0; }
  function pintarBotaoValores() {
    var b = $('btn-valores'); var admin = estado.dados && estado.dados.usuario && estado.dados.usuario.papel === 'administrador';
    b.style.display = botaoValoresVisivel(admin, estado.secao) ? 'inline-flex' : 'none';
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
