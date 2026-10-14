/* Financeiro (/financeiro). Só leitura: toda checagem de acesso e a ocultação de valores são feitas pelo servidor (/api/financeiro). */
(function () {
  'use strict';

  // Mesma sessão do /cs (mesmo navegador): entrou em uma página, entra na outra.
  var K_TOKEN = 'cs_token', K_REFRESH = 'cs_refresh', K_USER = 'cs_user';
  var POR_PAGINA = 50;

  var SECOES = {
    visao: ['Visão Geral', 'Carteira, inadimplência, suspensos e cobranças em um só lugar. Material da reunião semanal.'],
    inadimplentes: ['Inadimplentes', 'Clientes com honorário vencido e não pago: meses em aberto, quantas vezes foi cobrado e o próximo passo. Clique no nome da empresa para ver cada honorário.'],
    suspensos: ['Suspensos no Omie', 'Contratos com situação "Suspenso" no Omie (lista lida toda segunda de manhã), com o débito que ficou em aberto.'],
    carteira: ['Todos os clientes', 'Todos os clientes ativos no Acessórias, com a situação financeira de cada um.'],
    cobrancas: ['Cobranças', 'Cobranças feitas pelo Bruno no Zappy, contadas por dia e por competência (mês do honorário em aberto).'],
    qualidade: ['Qualidade dos Dados', 'De onde vem cada número e o que ainda está sem dado.'],
  };
  var COR_SIT = { inadimplente: '#dc2626', suspenso: '#6b21a8', em_dia: '#10b981', sem_honorario: '#9ca3af' };
  var ROT_SIT = { inadimplente: 'Inadimplente', suspenso: '⏸ Suspenso', em_dia: 'Em dia', sem_honorario: 'Sem honorário no Omie' };
  var COR_CAT = { 'Diamante': '#0891b2', 'Ouro': '#c99a06', 'Prata': '#6b7280', 'Bronze': '#b45309' };
  var ICONE_CAT = { 'Diamante': '💎', 'Ouro': '🥇', 'Prata': '🥈', 'Bronze': '🥉' };
  var COR_FAIXA = { ate15: '#f59e0b', ate30: '#f97316', ate60: '#ef4444', ate90: '#dc2626', mais90: '#7f1d1d' };
  var ROT_TIPO = { cobranca: 'Cobrança de honorário em aberto', suspensao: 'Aviso de suspensão por falta de pagamento', boleto: 'Boleto do mês enviado', baixa: 'Baixa de pagamento informada' };
  var MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  var estado = {
    dados: null, secao: 'visao', ocultar: false,
    f: { inad: { busca: '', faixa: '', cat: '', cobr: '', pag: 1 }, susp: { busca: '', pag: 1 }, cart: { busca: '', sit: '', cat: '', pag: 1 } },
  };

  // ── utilidades ───────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function data(s) { return s ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) + '/' + String(s).slice(0, 4) : '—'; }
  function dataCurta(s) { return s ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) : '—'; }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  function valoresOcultos() { return !!(estado.ocultar || (estado.dados && estado.dados.valores_ocultos)); }
  function reais(v) {
    if (valoresOcultos()) return '<span class="oculto" title="Valor oculto">R$ ••••</span>';
    return v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  function num(n) { return n == null ? '—' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function pct(n, d) { return d ? Math.round(1000 * n / d) / 10 : 0; }
  function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  /** O honorário de um mês vence no mês seguinte (boleto de JUNHO vence em 10/07): "referente a" = mês anterior ao vencimento. */
  function competencia(venc) {
    var y = +String(venc).slice(0, 4), m = +String(venc).slice(5, 7) - 1;
    m -= 1; if (m < 0) { m = 11; y -= 1; }
    return MESES[m] + '/' + String(y).slice(2);
  }

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
      ls(K_TOKEN, j.token); ls(K_REFRESH, j.refreshToken); if (j.user) ls(K_USER, JSON.stringify(j.user));
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
  function podeEntrar(u) { return !!u && (['administrador', 'usuario'].indexOf(u.role) >= 0 || !!u.acesso_financeiro || !!u.acesso_cs); }
  async function entrar(ev) {
    ev.preventDefault();
    var btn = $('login-btn'); btn.disabled = true; btn.textContent = 'Entrando…';
    try {
      var r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('inp-email').value.trim(), password: $('inp-senha').value }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) { mostrarLogin(j.error || 'Não foi possível entrar.'); return; }
      if (!podeEntrar(j.user)) { mostrarLogin('Este painel é do Financeiro. Peça acesso à administração.'); return; }
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
  var NOMES_SEC = ['visao', 'inadimplentes', 'suspensos', 'carteira', 'cobrancas', 'qualidade'];
  async function iniciar(forcar) {
    $('login-screen').style.display = 'none';
    $('app').style.display = 'block';
    var u = null; try { u = JSON.parse(ls(K_USER) || 'null'); } catch (e) { u = null; }
    $('usuario').textContent = u && u.name ? 'Olá, ' + u.name : '';
    NOMES_SEC.forEach(function (s) { $('sec-' + s).innerHTML = '<div class="vazio">Carregando…</div>'; });
    try {
      estado.dados = await api('/api/financeiro/dados' + (forcar === true ? '?forcar=1' : ''));
      pintarBotaoValores();
      desenharTudo();
    } catch (e) {
      NOMES_SEC.forEach(function (s) { $('sec-' + s).innerHTML = '<div class="card"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; });
    }
  }
  function desenharTudo() {
    var d = estado.dados, k = d.kpis;
    $('badge-inad').textContent = k.inadimplentes || '';
    $('badge-susp').textContent = k.suspensos || '';
    $('atualizado').textContent = k.qualidade.financeiro_lido_em ? 'Omie lido em ' + data(k.qualidade.financeiro_lido_em.slice(0, 10)) + ' ' + k.qualidade.financeiro_lido_em.slice(11) : 'Omie ainda não lido';
    desenharVisao(); desenharInadimplentes(); desenharSuspensos(); desenharCarteira(); desenharCobrancas(); desenharQualidade();
    irPara(estado.secao);
  }
  function irPara(sec) {
    estado.secao = sec;
    Array.prototype.forEach.call(document.querySelectorAll('.gp-nav-item'), function (b) { b.classList.toggle('active', b.getAttribute('data-sec') === sec); });
    Array.prototype.forEach.call(document.querySelectorAll('.gp-section'), function (s) { s.classList.toggle('ativa', s.id === 'sec-' + sec); });
    $('titulo').textContent = SECOES[sec][0];
    $('subtitulo').textContent = SECOES[sec][1];
    var ativa = $('sec-' + sec); if (ativa) ativa.scrollTop = 0;
    var t = $('btn-csv-tit'); if (t) t.style.display = (sec === 'inadimplentes' || sec === 'suspensos') ? 'inline-flex' : 'none';
  }

  // ── blocos reutilizáveis ─────────────────────────────────────────────────────
  function kpi(cor, rot, val, sub) {
    return '<div class="gp-kpi"><div class="gp-kpi-bar" style="background:' + cor + '"></div><div class="gp-kpi-label">' + rot + '</div><div class="gp-kpi-value" style="color:' + cor + '">' + val + '</div><div class="gp-kpi-sub">' + sub + '</div></div>';
  }
  function pillSit(c) {
    var cor = COR_SIT[c.situacao] || '#9ca3af';
    var extra = c.suspenso && c.situacao !== 'suspenso' ? ' <span class="pill" style="color:#6b21a8;border-color:#6b21a855;background:#6b21a814" title="Contrato suspenso no Omie">⏸ Suspenso</span>' : '';
    return '<span class="pill" style="color:' + cor + ';border-color:' + cor + '55;background:' + cor + '14">' + ROT_SIT[c.situacao] + '</span>' + extra;
  }
  function pillCat(c) {
    if (!c.categoria) return '<span class="cinza">Sem categoria</span>';
    var cor = COR_CAT[c.categoria];
    return '<span class="pill" style="color:' + cor + ';border-color:' + cor + '66;background:' + cor + '14">' + ICONE_CAT[c.categoria] + ' ' + esc(c.categoria) + '</span>';
  }
  function nomeLink(c) {
    return '<button class="link" data-ficha="' + esc(c.doc) + '">' + esc(c.nome) + '</button>' + (c.cronico ? ' <span class="pill" style="color:#92400e;border-color:#92400e55;background:#92400e14" title="Marcado como inadimplente crônico na Carteira">crônico</span>' : '') + '<div class="sub">' + esc(c.cnpj || '') + (c.grupo ? ' · ' + esc(c.grupo) : '') + '</div>';
  }
  // Resumo dos meses em aberto para a LISTA (o mês a mês fica só na ficha, ao abrir a empresa).
  function resumoMeses(c) {
    var v = c.abertos.filter(function (t) { return t.vencido; });
    if (!v.length) return c.qtd_atrasados ? '<span class="cinza">' + c.qtd_atrasados + ' título(s) · detalhe na próxima leitura do Omie</span>' : '<span class="cinza">—</span>';
    var meses = []; v.forEach(function (t) { var m = competencia(t.vencimento); if (meses.indexOf(m) < 0) meses.push(m); });
    var nunca = v.filter(function (t) { return !t.cobrancas; }).length;
    var faixa = meses.length > 1 ? meses[0] + ' a ' + meses[meses.length - 1] : meses[0];
    return '<b>' + meses.length + ' ' + (meses.length === 1 ? 'mês' : 'meses') + '</b><div class="sub">' + esc(faixa) + (nunca && nunca < v.length ? ' · ' + nunca + ' nunca cobrado' + (nunca === 1 ? '' : 's') : '') + '</div>';
  }
  function celPasso(c) {
    var p = c.proximo_passo; return '<div class="passo ' + esc(p.gravidade) + '">' + esc(p.texto) + '</div>';
  }
  function celCobr(c) {
    if (!c.cobrancas) return c.qtd_atrasados ? '<span class="pill" style="color:#b91c1c;border-color:#b91c1c55;background:#b91c1c14">nunca</span>' : '<span class="cinza">—</span>';
    return '<b>' + c.cobrancas + '×</b><div class="sub">última ' + dataCurta(c.ultima_cobranca) + ' (há ' + c.dias_desde_cobranca + 'd)</div>';
  }
  function paginacao(total, pag, chave) {
    var paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    var de = Math.max(1, Math.min(pag - 1, paginas - 2)), ate = Math.min(paginas, de + 2), b = '';
    var bt = function (n, rot, ativo, tit) { return '<button type="button" class="pg-btn' + (ativo ? ' ativo' : '') + '" data-pag="' + n + '" data-chave="' + chave + '"' + (ativo ? ' aria-current="page"' : '') + ' title="' + tit + '">' + rot + '</button>'; };
    if (paginas > 1) {
      if (pag > 1) b += bt(pag - 1, '‹', false, 'Página anterior');
      for (var i = de; i <= ate; i++) b += bt(i, i, i === pag, 'Página ' + i);
      if (pag < paginas) b += bt(pag + 1, '›', false, 'Próxima página');
    }
    return '<nav class="paginacao" aria-label="Páginas da lista"><span class="pg-total">Total: ' + num(total) + ' registros</span>' + b + '</nav>';
  }
  function fatiar(lista, f) {
    var paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA)); if (f.pag > paginas) f.pag = paginas; if (f.pag < 1) f.pag = 1;
    return lista.slice((f.pag - 1) * POR_PAGINA, f.pag * POR_PAGINA);
  }
  function bateBusca(c, q) { return !q || norm(c.nome).indexOf(q) >= 0 || (c.doc || '').indexOf(q.replace(/\D/g, '') || '§') >= 0 || norm(c.grupo).indexOf(q) >= 0; }
  function opcoesCat(sel) {
    return '<option value="">Todas as categorias</option>' + ['Diamante', 'Ouro', 'Prata', 'Bronze'].map(function (k) { return '<option value="' + k + '"' + (sel === k ? ' selected' : '') + '>' + ICONE_CAT[k] + ' ' + k + '</option>'; }).join('');
  }

  // ── VISÃO GERAL ──────────────────────────────────────────────────────────────
  function desenharVisao() {
    var d = estado.dados, k = d.kpis, cl = d.clientes;
    var inad = cl.filter(function (c) { return c.situacao === 'inadimplente'; });
    var topValor = inad.slice().sort(function (a, b) { return (b.valor_atrasado || 0) - (a.valor_atrasado || 0) || b.dias_atraso - a.dias_atraso; }).slice(0, 8);
    var topDias = inad.slice().sort(function (a, b) { return b.dias_atraso - a.dias_atraso; }).slice(0, 8);
    var maxAging = Math.max.apply(null, k.aging.map(function (a) { return valoresOcultos() ? a.clientes : (a.valor || 0); }).concat([1]));
    var aging = k.aging.map(function (a) {
      var base = valoresOcultos() ? a.clientes : (a.valor || 0);
      return '<div class="aging-linha"><div>' + esc(a.rotulo) + '</div><div class="aging-trilho"><i style="width:' + Math.max(2, Math.round(100 * base / maxAging)) + '%;background:' + COR_FAIXA[a.id] + '"></i></div>' +
        '<div class="aging-num"><b>' + reais(a.valor) + '</b><small>' + a.clientes + ' cliente' + (a.clientes === 1 ? '' : 's') + '</small></div></div>';
    }).join('');
    var linha = function (c, quem) {
      return '<div class="item"><div class="n"><button class="link" data-ficha="' + esc(c.doc) + '">' + esc(c.nome) + '</button><div class="sub">' + c.dias_atraso + ' dias · ' + c.qtd_atrasados + ' título(s) · ' + (c.cobrancas ? 'cobrado ' + c.cobrancas + '×' : 'nunca cobrado') + '</div></div><div class="v">' + (quem === 'valor' ? reais(c.valor_atrasado) : c.dias_atraso + ' d') + '</div></div>';
    };
    $('sec-visao').innerHTML =
      '<div class="gp-kpi-row">' +
        kpi('#256050', 'Clientes ativos', num(k.clientes_ativos), num(k.clientes_com_honorario) + ' faturam no Omie') +
        kpi('#0891b2', 'Honorário mensal', reais(k.honorario_mensal), 'soma dos honorários em vigor no Omie') +
        kpi('#dc2626', 'Inadimplentes', num(k.inadimplentes), k.pct_inadimplentes + '% de quem fatura · ' + num(k.titulos_atrasados) + ' título(s) vencido(s)') +
        kpi('#b45309', 'Valor em atraso', reais(k.valor_atrasado), 'honorário vencido e não pago') +
        kpi('#6b21a8', 'Suspensos no Omie', num(k.suspensos), num(k.suspensos_com_debito) + ' com débito em aberto') +
        kpi('#7c3aed', 'Cobranças em 30 dias', num(k.cobrancas_30_dias), num(k.nunca_cobrados) + ' inadimplente(s) nunca cobrado(s)') +
      '</div>' +
      '<div class="duas">' +
        '<div class="card"><div class="card-title">Idade da dívida</div><div class="card-sub">Dias de atraso de cada honorário vencido. A barra mostra ' + (valoresOcultos() ? 'o número de clientes.' : 'o valor.') + '</div><div class="aging">' + aging + '</div></div>' +
        '<div class="card"><div class="card-title">Atenção agora</div><div class="card-sub">Pontos que pedem ação esta semana.</div><div class="lista-top">' +
          '<div class="item"><div class="n">Inadimplentes há mais de 90 dias</div><div class="v">' + num(k.mais_90_dias) + '</div></div>' +
          '<div class="item"><div class="n">Nunca cobrados no Zappy</div><div class="v">' + num(k.nunca_cobrados) + '</div></div>' +
          '<div class="item"><div class="n">Cobrados 3 vezes ou mais sem pagar</div><div class="v">' + num(k.cobrados_3_ou_mais) + '</div></div>' +
          '<div class="item"><div class="n">Suspensos com débito em aberto</div><div class="v">' + num(k.suspensos_com_debito) + '</div></div>' +
          '<div class="item"><div class="n">Vencem nos próximos 7 dias</div><div class="v">' + num(k.a_vencer_7_dias.titulos) + ' · ' + reais(k.a_vencer_7_dias.valor) + '</div></div>' +
          '<div class="item"><div class="n">Pagam sempre atrasado (média de 10 dias ou mais)</div><div class="v">' + num(k.maus_pagadores) + '</div></div>' +
          '<div class="item"><div class="n">Inadimplentes crônicos (marcados na Carteira)</div><div class="v">' + num(k.cronicos) + '</div></div>' +
        '</div></div>' +
      '</div>' +
      '<div class="duas">' +
        '<div class="card"><div class="card-title">Maiores valores em atraso</div><div class="lista-top">' + (topValor.map(function (c) { return linha(c, 'valor'); }).join('') || '<div class="vazio">Nenhum inadimplente.</div>') + '</div></div>' +
        '<div class="card"><div class="card-title">Mais tempo em atraso</div><div class="lista-top">' + (topDias.map(function (c) { return linha(c, 'dias'); }).join('') || '<div class="vazio">Nenhum inadimplente.</div>') + '</div></div>' +
      '</div>' +
      '<div class="nota"><strong>Como ler:</strong> honorário vencido = título do Omie com vencimento anterior a hoje e ainda não pago. O honorário de um mês vence no mês seguinte (o de junho vence em 10/07), por isso a competência mostrada é o mês anterior ao vencimento. "Cobrado" conta dias com cobrança do Bruno no Zappy, a partir de ' + data(k.qualidade.cobrancas_desde) + '.</div>';
  }

  // Listas filtradas (a mesma lógica serve a tela e a exportação)
  function listaInad() {
    var d = estado.dados, f = estado.f.inad, q = norm(f.busca.trim());
    var base = d.clientes.filter(function (c) { return c.situacao === 'inadimplente' || (c.suspenso && c.qtd_atrasados > 0); });
    var lista = base.filter(function (c) {
      if (!bateBusca(c, q)) return false;
      if (f.faixa && c.faixa !== f.faixa) return false;
      if (f.cat && c.categoria !== f.cat) return false;
      if (f.cobr === 'nunca' && c.cobrancas) return false;
      if (f.cobr === '3' && c.cobrancas < 3) return false;
      if (f.cobr === 'parado' && !(c.cobrancas && c.dias_desde_cobranca >= 15)) return false;
      return true;
    }).sort(function (a, b) { return (b.dias_atraso - a.dias_atraso) || ((b.valor_atrasado || 0) - (a.valor_atrasado || 0)); });
    return lista;
  }
  function listaSusp() {
    var d = estado.dados, f = estado.f.susp, q = norm(f.busca.trim());
    var lista = d.clientes.filter(function (c) { return c.suspenso && bateBusca(c, q); })
      .sort(function (a, b) { return (b.qtd_atrasados > 0) - (a.qtd_atrasados > 0) || b.dias_atraso - a.dias_atraso; });
    return lista;
  }
  function listaCart() {
    var d = estado.dados, f = estado.f.cart, q = norm(f.busca.trim());
    var lista = d.clientes.filter(function (c) { return bateBusca(c, q) && (!f.sit || c.situacao === f.sit || (f.sit === 'suspenso' && c.suspenso)) && (!f.cat || c.categoria === f.cat); })
      .sort(function (a, b) { return (b.honorario || 0) - (a.honorario || 0) || a.nome.localeCompare(b.nome); });
    return lista;
  }

  // ── INADIMPLENTES ────────────────────────────────────────────────────────────
  function desenharInadimplentes() {
    var d = estado.dados, f = estado.f.inad, lista = listaInad();
    var pagina = fatiar(lista, f);
    var linhas = pagina.map(function (c) {
      return '<tr><td style="white-space:normal;min-width:230px">' + nomeLink(c) + (c.suspenso ? ' <span class="pill" style="color:#6b21a8;border-color:#6b21a855;background:#6b21a814">⏸ Suspenso</span>' : '') + '<div style="margin-top:4px">' + pillCat(c) + '</div></td>' +
        '<td class="c" style="white-space:normal;min-width:150px">' + resumoMeses(c) + '</td>' +
        '<td class="c" style="font-family:var(--mono)">' + reais(c.valor_atrasado) + '</td>' +
        '<td class="c"><b>' + c.dias_atraso + '</b> d</td>' +
        '<td class="c">' + celCobr(c) + '</td>' +
        '<td style="white-space:normal">' + celPasso(c) + '</td></tr>';
    }).join('');
    var faixas = '<option value="">Qualquer atraso</option>' + d.kpis.aging.map(function (a) { return '<option value="' + a.id + '"' + (f.faixa === a.id ? ' selected' : '') + '>' + esc(a.rotulo) + ' (' + a.clientes + ')</option>'; }).join('');
    $('sec-inadimplentes').innerHTML =
      '<div class="card"><div class="filter-group" style="margin-bottom:14px">' +
        '<span class="filter-label">Buscar</span><input class="gp-input" id="i-busca" placeholder="Empresa, grupo ou CNPJ" value="' + esc(f.busca) + '">' +
        '<span class="filter-label">Atraso</span><select class="gp-select" id="i-faixa">' + faixas + '</select>' +
        '<span class="filter-label">Categoria</span><select class="gp-select" id="i-cat">' + opcoesCat(f.cat) + '</select>' +
        '<span class="filter-label">Cobrança</span><select class="gp-select" id="i-cobr">' +
          '<option value=""' + (!f.cobr ? ' selected' : '') + '>Todas</option><option value="nunca"' + (f.cobr === 'nunca' ? ' selected' : '') + '>Nunca cobrado</option>' +
          '<option value="3"' + (f.cobr === '3' ? ' selected' : '') + '>Cobrado 3× ou mais</option><option value="parado"' + (f.cobr === 'parado' ? ' selected' : '') + '>Sem cobrar há 15 dias ou mais</option></select>' +
      '</div>' +
      '<div class="card-sub">' + lista.length + ' cliente(s) · ordem: maior atraso primeiro. Clique na empresa para ver cada mês, o valor e quantas vezes foi cobrado.</div>' +
      (lista.length ? '<div class="table-wrap"><table><thead><tr><th>Empresa</th><th class="c">Meses em aberto</th><th class="c">Valor em atraso</th><th class="c">Atraso</th><th class="c">Cobranças</th><th>Próximo passo</th></tr></thead><tbody>' + linhas + '</tbody></table></div>' + paginacao(lista.length, f.pag, 'inad') : '<div class="vazio">Nenhum cliente neste filtro.</div>') +
      '</div>';
    ligarFiltros('inad', { 'i-busca': 'busca', 'i-faixa': 'faixa', 'i-cat': 'cat', 'i-cobr': 'cobr' }, desenharInadimplentes);
  }

  // ── SUSPENSOS ────────────────────────────────────────────────────────────────
  function desenharSuspensos() {
    var d = estado.dados, f = estado.f.susp, k = d.kpis, lista = listaSusp();
    var pagina = fatiar(lista, f);
    var linhas = pagina.map(function (c) {
      return '<tr><td style="white-space:normal;min-width:230px">' + nomeLink(c) + '<div style="margin-top:4px">' + pillCat(c) + '</div></td>' +
        '<td class="c" style="font-family:var(--mono)">' + (c.honorario != null || valoresOcultos() ? reais(c.honorario) : '<span class="cinza">sem honorário</span>') + '</td>' +
        '<td class="c">' + (c.qtd_atrasados ? '<b>' + c.qtd_atrasados + '</b> título(s)<div class="sub">' + reais(c.valor_atrasado) + ' · ' + c.dias_atraso + ' dias</div>' : '<span class="cinza">sem débito</span>') + '</td>' +
        '<td class="c" style="white-space:normal;min-width:150px">' + resumoMeses(c) + '</td>' +
        '<td class="c">' + celCobr(c) + '</td>' +
        '<td style="white-space:normal">' + celPasso(c) + '</td></tr>';
    }).join('');
    $('sec-suspensos').innerHTML =
      '<div class="gp-kpi-row">' +
        kpi('#6b21a8', 'Contratos suspensos', num(k.suspensos), 'lidos do Omie' + (k.qualidade.suspensos_lidos_em ? ' em ' + data(k.qualidade.suspensos_lidos_em) : '')) +
        kpi('#dc2626', 'Com débito em aberto', num(k.suspensos_com_debito), 'ainda devem honorário') +
        kpi('#0891b2', 'Honorário parado', reais(k.honorario_suspenso), 'valor mensal dos suspensos que têm honorário no Omie') +
      '</div>' +
      '<div class="card"><div class="filter-group" style="margin-bottom:14px"><span class="filter-label">Buscar</span><input class="gp-input" id="s-busca" placeholder="Empresa, grupo ou CNPJ" value="' + esc(f.busca) + '"></div>' +
      '<div class="card-sub">' + lista.length + ' cliente(s) suspenso(s). A lista vem do Omie e some do contrato quando ele é reativado lá.</div>' +
      (lista.length ? '<div class="table-wrap"><table><thead><tr><th>Empresa</th><th class="c">Honorário</th><th class="c">Débito</th><th class="c">Meses em aberto</th><th class="c">Cobranças</th><th>Próximo passo</th></tr></thead><tbody>' + linhas + '</tbody></table></div>' + paginacao(lista.length, f.pag, 'susp') : '<div class="vazio">Nenhum contrato suspenso.</div>') +
      '</div>';
    ligarFiltros('susp', { 's-busca': 'busca' }, desenharSuspensos);
  }

  // ── TODOS OS CLIENTES ────────────────────────────────────────────────────────
  function desenharCarteira() {
    var d = estado.dados, f = estado.f.cart, lista = listaCart();
    var pagina = fatiar(lista, f);
    var linhas = pagina.map(function (c) {
      var p = c.pontualidade;
      var pontual = p ? (p.media_dias <= 1 ? '<span style="color:#10b981;font-weight:600">em dia</span>' : '<span style="color:' + (p.media_dias >= 10 ? '#dc2626' : '#d97706') + ';font-weight:600">' + p.media_dias.toString().replace('.', ',') + ' d</span>') + '<div class="sub">' + p.pagos + ' pago(s)</div>' : '<span class="cinza">sem dado</span>';
      return '<tr><td style="white-space:normal;min-width:230px">' + nomeLink(c) + '</td><td class="c">' + pillSit(c) + '</td><td class="c">' + pillCat(c) + '</td>' +
        '<td class="c" style="font-family:var(--mono)">' + (c.honorario != null || valoresOcultos() ? reais(c.honorario) : '<span class="cinza">—</span>') + '</td>' +
        '<td class="c" style="font-family:var(--mono)">' + (c.qtd_atrasados ? reais(c.valor_atrasado) : '<span class="cinza">—</span>') + '</td>' +
        '<td class="c">' + pontual + '</td></tr>';
    }).join('');
    var sits = [['', 'Todas as situações'], ['inadimplente', 'Inadimplentes'], ['suspenso', 'Suspensos'], ['em_dia', 'Em dia'], ['sem_honorario', 'Sem honorário no Omie']];
    $('sec-carteira').innerHTML =
      '<div class="card"><div class="filter-group" style="margin-bottom:14px">' +
        '<span class="filter-label">Buscar</span><input class="gp-input" id="c-busca" placeholder="Empresa, grupo ou CNPJ" value="' + esc(f.busca) + '">' +
        '<span class="filter-label">Situação</span><select class="gp-select" id="c-sit">' + sits.map(function (s) { return '<option value="' + s[0] + '"' + (f.sit === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') + '</select>' +
        '<span class="filter-label">Categoria</span><select class="gp-select" id="c-cat">' + opcoesCat(f.cat) + '</select></div>' +
      '<div class="card-sub">' + lista.length + ' cliente(s) · ordem: maior honorário primeiro. "Atraso médio ao pagar" = quantos dias depois do vencimento o cliente costuma pagar, nos honorários pagos dos últimos meses.</div>' +
      (lista.length ? '<div class="table-wrap"><table><thead><tr><th>Empresa</th><th class="c">Situação</th><th class="c">Categoria</th><th class="c">Honorário</th><th class="c">Em atraso</th><th class="c" title="Dias de atraso, em média, nos honorários que o cliente já pagou (janela lida do Omie). Pagar antes do vencimento conta como 0.">Atraso médio ao pagar</th></tr></thead><tbody>' + linhas + '</tbody></table></div>' + paginacao(lista.length, f.pag, 'cart') : '<div class="vazio">Nenhum cliente neste filtro.</div>') +
      '</div>';
    ligarFiltros('cart', { 'c-busca': 'busca', 'c-sit': 'sit', 'c-cat': 'cat' }, desenharCarteira);
  }

  // ── COBRANÇAS ────────────────────────────────────────────────────────────────
  function desenharCobrancas() {
    var d = estado.dados, k = d.kpis;
    // competências em aberto: quantos títulos/clientes por mês de vencimento e quantas vezes foram cobrados
    var porMes = {};
    d.clientes.forEach(function (c) {
      c.abertos.filter(function (t) { return t.vencido; }).forEach(function (t) {
        var m = t.vencimento.slice(0, 7); var o = porMes[m] = porMes[m] || { mes: m, titulos: 0, clientes: {}, valor: 0, cobrancas: 0, nunca: 0 };
        o.titulos++; o.clientes[c.doc] = 1; o.valor += (t.valor || 0); o.cobrancas += t.cobrancas; if (!t.cobrancas) o.nunca++;
      });
    });
    var meses = Object.keys(porMes).sort().map(function (m) { return porMes[m]; });
    var linhasMes = meses.map(function (o) {
      return '<tr><td><b>' + competencia(o.mes + '-10') + '</b><div class="sub">vence em ' + o.mes.slice(5) + '/' + o.mes.slice(0, 4) + '</div></td><td class="c">' + num(o.titulos) + '</td><td class="c">' + Object.keys(o.clientes).length + '</td><td class="c" style="font-family:var(--mono)">' + reais(o.valor) + '</td>' +
        '<td class="c">' + (o.titulos ? (Math.round(10 * o.cobrancas / o.titulos) / 10).toString().replace('.', ',') : '—') + '×</td><td class="c">' + (o.nunca ? '<span class="pill" style="color:#b91c1c;border-color:#b91c1c55;background:#b91c1c14">' + o.nunca + '</span>' : '<span class="cinza">0</span>') + '</td></tr>';
    }).join('');
    var inad = d.clientes.filter(function (c) { return c.qtd_atrasados > 0; });
    var parados = inad.filter(function (c) { return c.cobrancas && c.dias_desde_cobranca >= 15; }).sort(function (a, b) { return b.dias_desde_cobranca - a.dias_desde_cobranca; }).slice(0, 10);
    var nunca = inad.filter(function (c) { return !c.cobrancas; }).sort(function (a, b) { return b.dias_atraso - a.dias_atraso; }).slice(0, 10);
    var item = function (c, sub) { return '<div class="item"><div class="n"><button class="link" data-ficha="' + esc(c.doc) + '">' + esc(c.nome) + '</button><div class="sub">' + sub + '</div></div><div class="v">' + reais(c.valor_atrasado) + '</div></div>'; };
    $('sec-cobrancas').innerHTML =
      '<div class="gp-kpi-row">' +
        kpi('#7c3aed', 'Cobranças em 30 dias', num(k.cobrancas_30_dias), 'dias com cobrança, por cliente') +
        kpi('#b91c1c', 'Nunca cobrados', num(k.nunca_cobrados), 'inadimplentes sem nenhuma cobrança no Zappy') +
        kpi('#d97706', 'Cobrados 3× ou mais', num(k.cobrados_3_ou_mais), 'continuam sem pagar') +
        kpi('#2563eb', 'Parados há 15 dias+', num(inad.filter(function (c) { return c.cobrancas && c.dias_desde_cobranca >= 15; }).length), 'cobrados antes, sem nova cobrança') +
      '</div>' +
      '<div class="card"><div class="card-title">Competências em aberto</div><div class="card-sub">Cada linha é o mês do honorário. "Cobrado em média" = vezes que cada título daquele mês já foi cobrado.</div>' +
        (meses.length ? '<div class="table-wrap"><table><thead><tr><th>Competência</th><th class="c">Títulos</th><th class="c">Clientes</th><th class="c">Valor</th><th class="c">Cobrado em média</th><th class="c">Nunca cobrados</th></tr></thead><tbody>' + linhasMes + '</tbody></table></div>' : '<div class="vazio">Sem detalhe título a título ainda: ele chega com a próxima leitura do Omie (rotina das 11h).</div>') + '</div>' +
      '<div class="duas">' +
        '<div class="card"><div class="card-title">Nunca cobrados</div><div class="card-sub">Maior atraso primeiro.</div><div class="lista-top">' + (nunca.map(function (c) { return item(c, c.dias_atraso + ' dias em atraso · ' + c.qtd_atrasados + ' título(s)'); }).join('') || '<div class="vazio">Todos os inadimplentes já foram cobrados.</div>') + '</div></div>' +
        '<div class="card"><div class="card-title">Sem nova cobrança há 15 dias ou mais</div><div class="card-sub">Cobrados antes e sem retorno.</div><div class="lista-top">' + (parados.map(function (c) { return item(c, 'última cobrança há ' + c.dias_desde_cobranca + ' dias · ' + c.cobrancas + ' cobrança(s)'); }).join('') || '<div class="vazio">Nenhum caso.</div>') + '</div></div>' +
      '</div>' +
      '<div class="nota">As cobranças vêm das mensagens enviadas pelo Bruno no Zappy (a partir de ' + data(k.qualidade.cobrancas_desde) + '). Cobrança por ligação ou por outro canal não aparece aqui. Um dia com várias mensagens conta uma vez. Se a mensagem cita datas de vencimento, só esses honorários contam; se não cita, vale para todos os que já estavam vencidos naquele dia.</div>';
  }

  // ── QUALIDADE ────────────────────────────────────────────────────────────────
  function desenharQualidade() {
    var k = estado.dados.kpis, q = k.qualidade;
    var linha = function (rot, val, obs) { return '<div class="linha-item"><span class="r" style="flex-basis:260px">' + rot + '</span><span class="x"><b>' + val + '</b> <span class="cinza">' + obs + '</span></span></div>'; };
    $('sec-qualidade').innerHTML =
      '<div class="card"><div class="card-title">Fontes</div><div class="card-sub">De onde cada informação vem.</div>' +
        linha('Honorário e títulos em aberto', q.financeiro_lido_em ? 'lido em ' + data(q.financeiro_lido_em.slice(0, 10)) + ' ' + q.financeiro_lido_em.slice(11) : 'ainda não lido', 'Omie (Finanças › Contas a Receber), rotina diária das 11h, nas duas empresas.') +
        linha('Detalhe título a título', q.titulos_lidos_em ? 'lido em ' + data(q.titulos_lidos_em.slice(0, 10)) + ' ' + q.titulos_lidos_em.slice(11) : 'ainda não lido', 'Vencimento, valor e situação de cada honorário em aberto.') +
        linha('Contratos suspensos', k.suspensos + ' contrato(s)', 'Omie (Contratos de Serviço, situação Suspenso), lido toda segunda de manhã.') +
        linha('Cobranças', 'desde ' + data(q.cobrancas_desde), 'Mensagens do Bruno no Zappy. Antes dessa data o Zappy não foi lido.') +
        linha('Clientes ativos', num(k.clientes_ativos), 'Acessórias: ao inativar lá, o cliente some daqui.') +
      '</div>' +
      '<div class="card"><div class="card-title">O que ainda está sem dado</div>' +
        linha('Ativos sem honorário no Omie', num(q.sem_honorario_no_omie), 'não aparecem como em dia nem como inadimplentes: podem ser clientes sem cobrança, sem contrato ou com outro CNPJ.') +
        linha('Inadimplentes sem detalhe de títulos', num(q.inadimplentes_sem_detalhe), 'têm o total em atraso, mas não a lista de meses. Entram com a próxima leitura do Omie.') +
      '</div>';
  }

  // ── FICHA DO CLIENTE ─────────────────────────────────────────────────────────
  var fichaDoc = null;
  async function abrirFicha(doc) {
    fichaDoc = doc;
    $('ficha').style.display = 'flex';
    $('ficha-nome').textContent = 'Carregando…'; $('ficha-sub').textContent = ''; $('ficha-passo').style.display = 'none'; $('ficha-corpo').innerHTML = '';
    try { desenharFicha(await api('/api/financeiro/ficha/' + encodeURIComponent(doc))); }
    catch (e) { $('ficha-nome').textContent = 'Não foi possível abrir'; $('ficha-corpo').innerHTML = '<div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div>'; }
  }
  function desenharFicha(f) {
    estado.ficha = f;
    var c = f.cliente;
    $('ficha-nome').textContent = c.nome;
    $('ficha-sub').innerHTML = esc(c.cnpj || '') + (c.grupo ? ' · grupo ' + esc(c.grupo) : '') + ' · ' + pillSit(c) + ' ' + pillCat(c);
    $('ficha-passo').style.display = 'block';
    $('ficha-passo').innerHTML = '<strong>Próximo passo:</strong> ' + esc(c.proximo_passo.texto);
    var p = c.pontualidade;
    var bloco = function (t, v, d) { return '<div class="bloco"><div class="t">' + t + '</div><div class="v">' + v + '</div><div class="d">' + d + '</div></div>'; };
    var blocos = '<div class="blocos">' +
      bloco('Honorário mensal', c.honorario != null || valoresOcultos() ? reais(c.honorario) : '—', c.fatura_no_omie ? 'em vigor no Omie' : 'sem honorário lido no Omie') +
      bloco('Em atraso', c.qtd_atrasados ? reais(c.valor_atrasado) : 'R$ 0,00', c.qtd_atrasados + ' título(s) vencido(s)') +
      bloco('Atraso mais antigo', c.qtd_atrasados ? c.dias_atraso + ' dias' : '—', c.mais_antigo ? 'vencido em ' + data(c.mais_antigo) : 'sem título vencido') +
      bloco('Cobranças do atraso', c.qtd_atrasados ? (c.cobrancas ? c.cobrancas + '×' : 'nunca') : '—', c.ultima_cobranca ? 'última em ' + data(c.ultima_cobranca) : 'no Zappy, desde ' + data(estado.dados.kpis.qualidade.cobrancas_desde)) +
      bloco('Pontualidade', p ? (p.media_dias <= 1 ? 'em dia' : p.media_dias.toString().replace('.', ',') + ' dias') : 'sem dado', p ? 'média de atraso em ' + p.pagos + ' honorário(s) pago(s) · pior caso ' + p.max_dias + ' dias' : 'sem honorário pago na janela lida') +
    '</div>';

    var titulos;
    if (c.abertos.length) {
      titulos = '<div class="table-wrap"><table><thead><tr><th>Competência</th><th>Vencimento</th><th class="c">Valor em aberto</th><th class="c">Situação</th><th class="c">Atraso</th><th class="c">Cobrado</th><th class="c">Última cobrança</th></tr></thead><tbody>' +
        c.abertos.map(function (t) {
          var sit = !t.vencido ? '<span class="pill" style="color:#2563eb;border-color:#2563eb55;background:#2563eb14">a vencer</span>' : t.situacao === 'P' ? '<span class="pill" style="color:#d97706;border-color:#d9770655;background:#d9770614">pago em parte</span>' : '<span class="pill" style="color:#dc2626;border-color:#dc262655;background:#dc262614">vencido</span>';
          return '<tr><td><b>' + competencia(t.vencimento) + '</b></td><td>' + data(t.vencimento) + '</td><td class="c" style="font-family:var(--mono)">' + reais(t.valor) + '</td><td class="c">' + sit + '</td>' +
            '<td class="c">' + (t.vencido ? t.dias_atraso + ' d' : '—') + '</td>' +
            '<td class="c">' + (t.vencido ? (t.cobrancas ? '<b>' + t.cobrancas + '×</b>' : '<span class="pill" style="color:#b91c1c;border-color:#b91c1c55;background:#b91c1c14">nunca</span>') : '—') + '</td>' +
            '<td class="c">' + (t.ultima_cobranca ? data(t.ultima_cobranca) : '—') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } else if (c.qtd_atrasados) {
      titulos = '<div class="linha-item"><span class="x">Este cliente tem ' + c.qtd_atrasados + ' título(s) vencido(s), mas o detalhe mês a mês ainda não foi lido do Omie. Chega com a próxima leitura (rotina das 11h).</span></div>';
    } else {
      titulos = '<div class="linha-item"><span class="x">Nenhum honorário em aberto.</span></div>';
    }

    var tempo = f.eventos.length ? '<div class="tempo">' + f.eventos.slice().reverse().map(function (e) {
      var cit = e.datas && e.datas.length ? 'cita os vencimentos ' + e.datas.map(data).join(', ') : 'sem vencimentos citados (vale para todos os vencidos no dia)';
      return '<div class="tempo-item"><div class="d">' + data(e.dia) + '</div><div>' + (e.conta ? '<span class="pill" style="color:#7c3aed;border-color:#7c3aed55;background:#7c3aed14">' + (e.tipo === 'suspensao' ? 'suspensão' : 'cobrança') + '</span>' : '<span class="pill" style="color:#6b7280;border-color:#6b728055;background:#6b728014">' + (e.tipo === 'boleto' ? 'boleto' : 'baixa') + '</span>') + '</div>' +
        '<div class="x">' + esc(ROT_TIPO[e.tipo] || e.tipo) + ' · ' + esc(cit) + (e.tickets.length ? ' · ticket #' + esc(e.tickets.join(', #')) : '') + '</div></div>';
    }).join('') + '</div>' : '<div class="linha-item"><span class="x">Nenhuma mensagem de cobrança do Bruno no Zappy desde ' + data(estado.dados.kpis.qualidade.cobrancas_desde) + '.</span></div>';

    $('ficha-corpo').innerHTML = blocos +
      '<div class="ficha-sec">Honorários em aberto</div>' + titulos +
      '<div class="ficha-sec">Linha do tempo no Zappy</div>' + tempo;
  }
  function fecharFicha() { $('ficha').style.display = 'none'; fichaDoc = null; }

  // ── EXPORTAÇÃO (CSV e PDF) ───────────────────────────────────────────────────
  // Exporta TODAS as linhas do filtro atual da seção aberta (não só a página). Os dados já vieram do servidor com as permissões e os
  // valores ocultos aplicados; com "Ocultar valores" ligado, os valores em R$ saem como "oculto".
  function moedaExp(v) { return valoresOcultos() ? 'oculto' : (v == null ? '' : Math.round(v * 100) / 100); }
  function mesesExp(c) {
    var ms = []; c.abertos.filter(function (t) { return t.vencido; }).forEach(function (t) { var m = competencia(t.vencimento); if (ms.indexOf(m) < 0) ms.push(m); });
    return { qtd: ms.length, de: ms[0] || '', ate: ms.length ? ms[ms.length - 1] : '' };
  }
  function dataExp(s) { return s ? data(s) : ''; }
  function rotuloFaixa(id) { var a = (estado.dados.kpis.aging || []).filter(function (x) { return x.id === id; })[0]; return a ? a.rotulo : ''; }
  var ROT_COBR = { nunca: 'Nunca cobrado', '3': 'Cobrado 3 vezes ou mais', parado: 'Sem cobrar há 15 dias ou mais' };

  function dadosExport(sec) {
    var d = estado.dados, k = d.kpis, f;
    var aviso = valoresOcultos() ? 'Valores em R$ ocultos.' : '';
    if (sec === 'visao') {
      var lin = [
        ['Clientes ativos', k.clientes_ativos], ['Clientes que faturam no Omie', k.clientes_com_honorario], ['Honorário mensal (R$)', moedaExp(k.honorario_mensal)],
        ['Inadimplentes', k.inadimplentes], ['% de inadimplentes (de quem fatura)', k.pct_inadimplentes], ['Valor em atraso (R$)', moedaExp(k.valor_atrasado)],
        ['Títulos vencidos', k.titulos_atrasados], ['Inadimplentes há mais de 90 dias', k.mais_90_dias], ['Inadimplentes nunca cobrados', k.nunca_cobrados],
        ['Cobrados 3 vezes ou mais sem pagar', k.cobrados_3_ou_mais], ['Inadimplentes crônicos (Carteira)', k.cronicos], ['Contratos suspensos no Omie', k.suspensos],
        ['Suspensos com débito em aberto', k.suspensos_com_debito], ['Honorário mensal parado nos suspensos (R$)', moedaExp(k.honorario_suspenso)],
        ['Cobranças nos últimos 30 dias (dias com cobrança)', k.cobrancas_30_dias], ['Títulos que vencem em 7 dias', k.a_vencer_7_dias.titulos], ['Valor que vence em 7 dias (R$)', moedaExp(k.a_vencer_7_dias.valor)],
        ['Pagam sempre atrasado (média de 10 dias ou mais)', k.maus_pagadores],
      ];
      k.aging.forEach(function (a) { lin.push(['Dívida de ' + a.rotulo.toLowerCase() + ': clientes', a.clientes]); lin.push(['Dívida de ' + a.rotulo.toLowerCase() + ': valor (R$)', moedaExp(a.valor)]); });
      return { arquivo: 'financeiro-resumo', titulo: 'Financeiro - Visão geral', filtros: [aviso], colunas: ['Indicador', 'Valor'], linhas: lin, alinhar: ['left', 'right'], orientacao: 'portrait', fonte: 9 };
    }
    if (sec === 'inadimplentes') {
      f = estado.f.inad;
      var fi = [];
      if (f.busca) fi.push('Busca: ' + f.busca); if (f.faixa) fi.push('Atraso: ' + rotuloFaixa(f.faixa)); if (f.cat) fi.push('Categoria: ' + f.cat); if (f.cobr) fi.push('Cobrança: ' + ROT_COBR[f.cobr]);
      var li = listaInad();
      return { arquivo: 'financeiro-inadimplentes', titulo: 'Financeiro - Inadimplentes', filtros: [li.length + ' cliente(s)' + (fi.length ? ' · ' + fi.join(' · ') : ' · sem filtro'), aviso],
        colunas: ['Empresa', 'CNPJ', 'Grupo', 'Categoria', 'Suspenso', 'Meses em aberto', 'Primeira competência', 'Última competência', 'Títulos vencidos', 'Valor em atraso (R$)', 'Dias de atraso', 'Cobranças', 'Última cobrança', 'Próximo passo'],
        linhas: li.map(function (c) { var m = mesesExp(c); return [c.nome, c.cnpj, c.grupo || '', c.categoria || '', c.suspenso ? 'Sim' : '', m.qtd, m.de, m.ate, c.qtd_atrasados, moedaExp(c.valor_atrasado), c.dias_atraso, c.cobrancas, dataExp(c.ultima_cobranca), c.proximo_passo.texto]; }),
        alinhar: ['left', 'left', 'left', 'left', 'center', 'center', 'center', 'center', 'center', 'right', 'center', 'center', 'center', 'left'], fonte: 6.5, porTitulo: li };
    }
    if (sec === 'suspensos') {
      f = estado.f.susp;
      var ls2 = listaSusp();
      return { arquivo: 'financeiro-suspensos', titulo: 'Financeiro - Suspensos no Omie', filtros: [ls2.length + ' cliente(s) suspenso(s)' + (f.busca ? ' · Busca: ' + f.busca : ''), aviso],
        colunas: ['Empresa', 'CNPJ', 'Grupo', 'Categoria', 'Honorário mensal (R$)', 'Títulos vencidos', 'Valor em atraso (R$)', 'Dias de atraso', 'Meses em aberto', 'Primeira competência', 'Última competência', 'Cobranças', 'Última cobrança', 'Próximo passo'],
        linhas: ls2.map(function (c) { var m = mesesExp(c); return [c.nome, c.cnpj, c.grupo || '', c.categoria || '', moedaExp(c.honorario), c.qtd_atrasados, moedaExp(c.valor_atrasado), c.dias_atraso, m.qtd, m.de, m.ate, c.cobrancas, dataExp(c.ultima_cobranca), c.proximo_passo.texto]; }),
        alinhar: ['left', 'left', 'left', 'left', 'right', 'center', 'right', 'center', 'center', 'center', 'center', 'center', 'center', 'left'], fonte: 6.5, porTitulo: ls2 };
    }
    if (sec === 'carteira') {
      f = estado.f.cart;
      var lc = listaCart();
      var fc = []; if (f.busca) fc.push('Busca: ' + f.busca); if (f.sit) fc.push('Situação: ' + (ROT_SIT[f.sit] || f.sit)); if (f.cat) fc.push('Categoria: ' + f.cat);
      return { arquivo: 'financeiro-todos-os-clientes', titulo: 'Financeiro - Todos os clientes', filtros: [lc.length + ' cliente(s)' + (fc.length ? ' · ' + fc.join(' · ') : ' · sem filtro'), aviso],
        colunas: ['Empresa', 'CNPJ', 'Grupo', 'Situação', 'Suspenso', 'Categoria', 'Honorário mensal (R$)', 'Títulos vencidos', 'Valor em atraso (R$)', 'Atraso médio ao pagar (dias)', 'Honorários pagos na janela'],
        linhas: lc.map(function (c) { var p = c.pontualidade; return [c.nome, c.cnpj, c.grupo || '', ROT_SIT[c.situacao].replace('⏸ ', ''), c.suspenso ? 'Sim' : '', c.categoria || '', moedaExp(c.honorario), c.qtd_atrasados, moedaExp(c.valor_atrasado), p ? p.media_dias : '', p ? p.pagos : '']; }),
        alinhar: ['left', 'left', 'left', 'left', 'center', 'left', 'right', 'center', 'right', 'center', 'center'], fonte: 7 };
    }
    if (sec === 'cobrancas') {
      var porMes = {};
      d.clientes.forEach(function (c) {
        c.abertos.filter(function (t) { return t.vencido; }).forEach(function (t) {
          var m = t.vencimento.slice(0, 7); var o = porMes[m] = porMes[m] || { mes: m, titulos: 0, clientes: {}, valor: 0, cobrancas: 0, nunca: 0 };
          o.titulos++; o.clientes[c.doc] = 1; o.valor += (t.valor || 0); o.cobrancas += t.cobrancas; if (!t.cobrancas) o.nunca++;
        });
      });
      var ms = Object.keys(porMes).sort().map(function (m) { return porMes[m]; });
      return { arquivo: 'financeiro-cobrancas-por-competencia', titulo: 'Financeiro - Cobranças por competência', filtros: ['Cobranças do Bruno no Zappy desde ' + data(k.qualidade.cobrancas_desde) + '.', aviso],
        colunas: ['Competência', 'Mês do vencimento', 'Títulos em aberto', 'Clientes', 'Valor (R$)', 'Cobrado em média (vezes)', 'Títulos nunca cobrados'],
        linhas: ms.map(function (o) { return [competencia(o.mes + '-10'), o.mes.slice(5) + '/' + o.mes.slice(0, 4), o.titulos, Object.keys(o.clientes).length, moedaExp(o.valor), o.titulos ? Math.round(10 * o.cobrancas / o.titulos) / 10 : '', o.nunca]; }),
        alinhar: ['left', 'center', 'center', 'center', 'right', 'center', 'center'], orientacao: 'portrait', fonte: 9 };
    }
    if (sec === 'qualidade') {
      var q = k.qualidade;
      return { arquivo: 'financeiro-qualidade-dos-dados', titulo: 'Financeiro - Qualidade dos dados', filtros: [],
        colunas: ['Item', 'Situação'], alinhar: ['left', 'left'], orientacao: 'portrait', fonte: 9,
        linhas: [['Honorário e títulos em aberto (Omie)', q.financeiro_lido_em ? 'lido em ' + q.financeiro_lido_em : 'ainda não lido'], ['Detalhe título a título', q.titulos_lidos_em ? 'lido em ' + q.titulos_lidos_em : 'ainda não lido'],
          ['Contratos suspensos (Omie)', k.suspensos + ' contrato(s)' + (q.suspensos_lidos_em ? ', lidos em ' + data(q.suspensos_lidos_em) : '')], ['Cobranças (Zappy)', 'desde ' + data(q.cobrancas_desde)],
          ['Clientes ativos (Acessórias)', k.clientes_ativos], ['Ativos sem honorário no Omie', q.sem_honorario_no_omie], ['Inadimplentes sem detalhe de títulos', q.inadimplentes_sem_detalhe]] };
    }
    return null;
  }
  /** Uma linha por honorário em aberto das empresas da lista (CSV "por título"). */
  function linhasPorTitulo(lista) {
    var r = [];
    lista.forEach(function (c) {
      c.abertos.forEach(function (t) {
        r.push([c.nome, c.cnpj, c.grupo || '', c.categoria || '', c.suspenso ? 'Sim' : '', competencia(t.vencimento), dataExp(t.vencimento), moedaExp(t.valor),
          t.vencido ? (t.situacao === 'P' ? 'vencido (pago em parte)' : 'vencido') : 'a vencer', t.dias_atraso, t.vencido ? t.cobrancas : '', dataExp(t.ultima_cobranca)]);
      });
    });
    return r;
  }
  var COLUNAS_TITULO = ['Empresa', 'CNPJ', 'Grupo', 'Categoria', 'Suspenso', 'Competência', 'Vencimento', 'Valor em aberto (R$)', 'Situação', 'Dias de atraso', 'Vezes cobrado', 'Última cobrança'];

  function exportar(formato, porTitulo) {
    var e = dadosExport(estado.secao);
    if (!e) { alert('Esta seção não tem relatório para exportar.'); return; }
    var u = null; try { u = JSON.parse(ls(K_USER) || 'null'); } catch (x) { u = null; }
    var sub = (e.filtros || []).filter(Boolean).concat(u && u.name ? ['Gerado por ' + u.name] : []);
    try {
      if (porTitulo) {
        var lt = linhasPorTitulo(e.porTitulo || []);
        if (!lt.length) { alert('Nenhum honorário em aberto com detalhe para exportar neste filtro.'); return; }
        window.Exportar.csv(e.arquivo + '-por-titulo', COLUNAS_TITULO, lt);
        return;
      }
      if (formato === 'csv') { window.Exportar.csv(e.arquivo, e.colunas, e.linhas); return; }
      var btn = $('btn-pdf'), rot = btn.textContent; btn.disabled = true; btn.textContent = 'Gerando PDF…';
      window.Exportar.pdf({ arquivo: e.arquivo, titulo: e.titulo, subtitulo: sub, colunas: e.colunas, linhas: e.linhas, alinhar: e.alinhar, orientacao: e.orientacao || 'landscape', fonte: e.fonte, paginaDe: 'Financeiro' })
        .catch(function (err) { alert(err.message || 'Não foi possível gerar o PDF.'); })
        .then(function () { btn.disabled = false; btn.textContent = rot; });
    } catch (err) { alert(err.message || 'Não foi possível exportar.'); }
  }

  // ── eventos ──────────────────────────────────────────────────────────────────
  /** Liga os campos de filtro de uma seção ao estado e desenha de novo (mantendo o cursor da busca). */
  function ligarFiltros(chave, campos, redesenhar) {
    Object.keys(campos).forEach(function (id) {
      var el = $(id); if (!el) return;
      el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', function () {
        estado.f[chave][campos[id]] = el.value; estado.f[chave].pag = 1;
        var pos = el.selectionStart; redesenhar();
        var n = $(id); if (n && n.tagName === 'INPUT') { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* sem seleção */ } }
      });
    });
  }
  var REDESENHO = { inad: function () { desenharInadimplentes(); }, susp: function () { desenharSuspensos(); }, cart: function () { desenharCarteira(); } };
  document.addEventListener('click', function (ev) {
    var f = ev.target.closest && ev.target.closest('[data-ficha]');
    if (f) { abrirFicha(f.getAttribute('data-ficha')); return; }
    var p = ev.target.closest && ev.target.closest('[data-pag]');
    if (p) {
      var chave = p.getAttribute('data-chave'); estado.f[chave].pag = parseInt(p.getAttribute('data-pag'), 10) || 1;
      REDESENHO[chave]();
      var topo = document.querySelector('.gp-section.ativa .filter-group'); if (topo && topo.scrollIntoView) topo.scrollIntoView({ block: 'start' });
    }
  });
  $('login-form').addEventListener('submit', entrar);
  $('btn-sair').addEventListener('click', function () { sair(false); });
  $('btn-atualizar').addEventListener('click', function () { iniciar(true); });
  $('btn-csv').addEventListener('click', function () { exportar('csv'); });
  $('btn-pdf').addEventListener('click', function () { exportar('pdf'); });
  $('btn-csv-tit').addEventListener('click', function () { exportar('csv', true); });
  // Botão "Ocultar valores" (quem vê valores): esconde todo R$ na tela, para apresentar sem mostrar valores. Lembra a escolha neste navegador.
  function pintarBotaoValores() {
    var b = $('btn-valores'); var ve = estado.dados && estado.dados.usuario && estado.dados.usuario.ve_valores;
    b.style.display = ve ? 'inline-flex' : 'none';
    b.textContent = estado.ocultar ? '🙈 Valores ocultos' : '👁 Ocultar valores';
    b.className = 'gp-footer-btn' + (estado.ocultar ? ' ativo' : '');
  }
  $('btn-valores').addEventListener('click', function () {
    estado.ocultar = !estado.ocultar; ls('fin_ocultar', estado.ocultar ? '1' : '0');
    pintarBotaoValores(); if (estado.dados) desenharTudo();
    if ($('ficha').style.display === 'flex' && estado.ficha) desenharFicha(estado.ficha);
  });
  estado.ocultar = ls('fin_ocultar') === '1';
  $('ficha-fechar').addEventListener('click', fecharFicha);
  $('ficha').addEventListener('click', function (ev) { if (ev.target === $('ficha')) fecharFicha(); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') fecharFicha(); });
  Array.prototype.forEach.call(document.querySelectorAll('.gp-nav-item'), function (b) { b.addEventListener('click', function () { irPara(b.getAttribute('data-sec')); }); });

  if (ls(K_TOKEN)) iniciar(); else mostrarLogin('');
})();
