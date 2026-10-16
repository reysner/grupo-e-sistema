/* Portal do Analista (/qualidade): tratativas de Qualidade, atendimentos do Zappy, e-mails e prioridades do próprio analista.
 * Toda checagem de acesso é feita pelo servidor (/api/qualidade); o navegador só desenha o que recebe. */
(function () {
  'use strict';

  var K_TOKEN = 'ql_token', K_REFRESH = 'ql_refresh', K_USER = 'ql_user';
  var ROT = { aberto: 'Aberto', em_tratamento: 'Em tratamento', finalizada: 'Aguardando validação', resolvido: 'Encerrado', cancelado: 'Cancelado', vencido: 'Vencido' };
  var COR = { aberto: '#b45309', em_tratamento: '#2563eb', finalizada: '#7c3aed', resolvido: '#166534', cancelado: '#6b7280', vencido: '#b91c1c' };
  var TITULOS = {
    visao: ['Visão Geral', 'Seu resumo do dia: o que vence, o que está sem resposta e como vão os atendimentos.'],
    prioridades: ['Prioridades', 'O que pede ação hoje, da mais urgente para a menos.'],
    tratativas: ['Tratativas', 'Inicie a tratativa, registre notas e observações e, ao concluir, finalize: a liderança é avisada e encerra o processo.'],
    nota: ['Minha nota', 'A composição da sua nota de atendimento do mês (Gamificação).'],
    atendimentos: ['Meus atendimentos', 'Suas conversas do Zappy dos últimos 180 dias: data, empresa, setor, nota e SLA.'],
    emails: ['Meus e-mails', 'E-mails de clientes que chegaram para você nos últimos 180 dias e os que estão sem resposta.'],
    evolucao: ['Evolução semanal', 'As últimas 12 semanas: atendimentos, tratativas lançadas e resolvidas.'],
  };
  var estado = { painel: null, secao: 'visao', filtroTrat: 'pendentes', analistaVer: '' };

  function $(id) { return document.getElementById(id); }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* sem armazenamento */ } return null; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function dt(s) { if (!s) return '—'; var x = String(s).slice(0, 10); return x.slice(8, 10) + '/' + x.slice(5, 7) + '/' + x.slice(0, 4); }
  function kpi(cor, rot, val, sub) {
    return '<div class="gp-kpi"><div class="gp-kpi-bar" style="background:' + cor + '"></div><div class="gp-kpi-label">' + rot + '</div><div class="gp-kpi-value" style="color:' + cor + '">' + val + '</div><div class="gp-kpi-sub">' + sub + '</div></div>';
  }
  function pill(sit) { var c = COR[sit] || '#6b7280'; return '<span class="pill" style="color:' + c + ';border-color:' + c + '55;background:' + c + '14">' + esc(ROT[sit] || sit) + '</span>'; }

  // ── sessão ───────────────────────────────────────────────────────────────────
  async function renovar() {
    var rt = ls(K_REFRESH); if (!rt) return false;
    try {
      var r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
      if (!r.ok) return false;
      var j = await r.json(); ls(K_TOKEN, j.token); ls(K_REFRESH, j.refreshToken); return true;
    } catch (e) { return false; }
  }
  async function chamar(url, opcoes, tentou) {
    var o = Object.assign({}, opcoes || {});
    o.headers = Object.assign({}, o.headers || {}, { Authorization: 'Bearer ' + (ls(K_TOKEN) || '') });
    var r = await fetch(url, o);
    if (r.status === 401 && !tentou && await renovar()) return chamar(url, opcoes, true);
    return r;
  }
  async function api(url) {
    var r = await chamar(url, { cache: 'no-store' });
    if (r.status === 401) { sair(true); throw new Error('Sessão expirada. Entre de novo.'); }
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.error || 'Erro ' + r.status); e.status = r.status; throw e; }
    return j;
  }
  function mostrarLogin(msg) {
    $('app').style.display = 'none'; $('login-screen').style.display = 'flex';
    var e = $('login-err'); e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none';
  }
  function sair(silencioso) {
    var rt = ls(K_REFRESH), tk = ls(K_TOKEN);
    if (!silencioso && rt && tk) fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify({ refreshToken: rt }) }).catch(function () {});
    ls(K_TOKEN, null); ls(K_REFRESH, null); ls(K_USER, null);
    estado.painel = null;
    mostrarLogin(silencioso ? 'Sua sessão expirou. Entre de novo.' : '');
  }
  async function entrar(ev) {
    ev.preventDefault();
    var btn = $('login-btn'); btn.disabled = true; btn.textContent = 'Entrando…';
    try {
      var r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('inp-email').value.trim(), password: $('inp-senha').value }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) { mostrarLogin(j.error || 'Não foi possível entrar.'); return; }
      var u = j.user;
      if (!(u.acesso_qualidade || u.role === 'administrador' || u.role === 'usuario')) { mostrarLogin('Este login não tem o acesso Qualidade. Fale com a liderança.'); return; }
      ls(K_TOKEN, j.token); ls(K_REFRESH, j.refreshToken); ls(K_USER, JSON.stringify(u));
      $('inp-senha').value = '';
      iniciar();
    } catch (e) { mostrarLogin('Sem conexão com o servidor. Tente de novo.'); }
    finally { btn.disabled = false; btn.textContent = 'Entrar'; }
  }
  function montarMenu(u) {
    if (!window.MenuUsuario || !$('menu-usuario')) return;
    window.MenuUsuario.montar({
      alvo: $('menu-usuario'), usuario: u, chamar: chamar,
      aoSair: function () { sair(false); },
      aoAtualizar: function (novo) { var a = {}; try { a = JSON.parse(ls(K_USER) || '{}') || {}; } catch (e) { a = {}; } ls(K_USER, JSON.stringify(Object.assign(a, { name: novo.name, email: novo.email }))); },
    });
  }

  // ── carga ────────────────────────────────────────────────────────────────────
  async function iniciar() {
    $('login-screen').style.display = 'none'; $('app').style.display = 'block';
    var u = null; try { u = JSON.parse(ls(K_USER) || 'null'); } catch (e) { u = null; }
    if (u && u.name) montarMenu(u);
    if (u && (u.role === 'administrador' || u.role === 'usuario')) carregarAnalistasVerComo();
    await carregar();
  }
  async function carregarAnalistasVerComo() {
    try {
      var j = await api('/api/cs/painel/qualidade/analistas?ativo=true');
      var sel = $('sel-analista');
      sel.innerHTML = '<option value="">Eu (meu login)</option>' + j.analistas.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.nome) + '</option>'; }).join('');
      sel.value = estado.analistaVer;
      sel.onchange = function () { estado.analistaVer = sel.value; carregar(); };
      $('ver-como').style.display = 'flex';
    } catch (e) { /* sem permissão para a lista: segue sem o seletor */ }
  }
  async function carregar() {
    ['visao', 'prioridades', 'tratativas', 'nota', 'atendimentos', 'emails', 'evolucao'].forEach(function (s) { $('sec-' + s).innerHTML = '<div class="vazio">Carregando…</div>'; });
    try {
      estado.painel = await api('/api/qualidade/painel' + (estado.analistaVer ? '?analista=' + encodeURIComponent(estado.analistaVer) : ''));
      desenhar();
    } catch (e) {
      ['visao', 'prioridades', 'tratativas', 'nota', 'atendimentos', 'emails', 'evolucao'].forEach(function (s) { $('sec-' + s).innerHTML = '<div class="card"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; });
    }
  }
  function semAnalista(p) {
    return '<div class="card"><div class="vazio">' + esc(p.aviso || 'Seu login ainda não está ligado a um analista da lista.') + '</div></div>';
  }
  function desenhar() {
    var p = estado.painel;
    $('atualizado').textContent = 'Atualizado em ' + new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    if (!p.analista) {
      ['visao', 'prioridades', 'tratativas', 'nota', 'atendimentos', 'emails', 'evolucao'].forEach(function (s) { $('sec-' + s).innerHTML = semAnalista(p); });
      irPara(estado.secao); return;
    }
    $('sub-analista').textContent = p.analista.nome;
    var pend = p.registros.filter(function (r) { return r.status === 'aberto' || r.status === 'em_tratamento'; }).length;
    $('badge-tratativas').textContent = pend || '';
    $('badge-prioridades').textContent = p.prioridades.length || '';
    desenharVisao(); desenharPrioridades(); desenharTratativas(); desenharNota(); desenharAtendimentos(); desenharEmails(); desenharEvolucao();
    irPara(estado.secao);
  }
  function irPara(sec) {
    estado.secao = sec;
    Array.prototype.forEach.call(document.querySelectorAll('.gp-nav-item'), function (b) { b.classList.toggle('active', b.getAttribute('data-sec') === sec); });
    Array.prototype.forEach.call(document.querySelectorAll('.gp-section'), function (s) { s.classList.toggle('ativa', s.id === 'sec-' + sec); });
    $('titulo').textContent = TITULOS[sec][0]; $('subtitulo').textContent = TITULOS[sec][1];
    if (sec === 'nota' && estado.painel && estado.painel.analista && !estado.notaCarregada) carregarNota();
  }

  // ── Visão Geral ──────────────────────────────────────────────────────────────
  function barras(lista, campo, cor) {
    var max = Math.max.apply(null, lista.map(function (x) { return x[campo]; }).concat([1]));
    return '<div style="display:flex;gap:6px;align-items:flex-end;height:90px">' + lista.map(function (x) {
      var h = Math.max(2, Math.round(x[campo] / max * 80));
      return '<div style="flex:1;text-align:center;font-size:10px;color:var(--text2)" title="Semana de ' + dt(x.semana) + ': ' + x[campo] + '"><div style="height:' + h + 'px;background:' + cor + ';border-radius:4px 4px 0 0;margin-top:' + (80 - h) + 'px"></div>' + x[campo] + '</div>';
    }).join('') + '</div>';
  }
  function desenharVisao() {
    var p = estado.painel, a = p.atendimentos, e = p.emails;
    var venc = p.registros.filter(function (r) { return r.situacao === 'vencido'; }).length;
    var abertos = p.registros.filter(function (r) { return r.status === 'aberto'; }).length;
    var trat = p.registros.filter(function (r) { return r.status === 'em_tratamento'; }).length;
    var top = p.prioridades.slice(0, 5).map(function (x) {
      return '<div class="linha-item"><span class="q">' + (x.nivel === 'alta' ? '🔴' : '🟠') + '</span><span class="r" style="flex:0 0 240px">' + esc(x.titulo) + '</span><span class="x">' + esc(x.detalhe) + '</span></div>';
    }).join('') || '<div class="linha-item"><span class="x">Nada urgente agora. Bom trabalho!</span></div>';
    $('sec-visao').innerHTML =
      '<div class="gp-kpi-row">' +
        kpi('#b91c1c', 'Tratativas vencidas', venc, 'prazo passou e ainda não foi resolvido') +
        kpi('#b45309', 'Em aberto', abertos, 'aguardando você começar') +
        kpi('#2563eb', 'Em tratamento', trat, 'você já está tratando') +
        kpi('#0f766e', 'Atendimentos (180 dias)', a.vinculado ? a.total : '—', a.vinculado ? 'conversas no Zappy' : 'seu login ainda não está ligado ao Zappy') +
        kpi('#7c3aed', 'E-mails sem resposta', e.lido_em ? e.sem_resposta : '—', e.lido_em ? 'de ' + e.recebidos + ' recebidos nos últimos ' + (e.janela_dias || 180) + ' dias' : 'leitura ainda não carregada') +
      '</div>' +
      '<div class="card"><div class="card-title">Prioridades de hoje</div><div class="card-sub">' + p.prioridades.length + ' item(ns) pedem ação. Veja todos em Prioridades.</div>' + top + '</div>' +
      '<div class="card"><div class="card-title">Atendimentos por semana</div><div class="card-sub">Últimas 12 semanas</div>' + (a.vinculado ? barras(a.semanas, 'n', '#0f766e') : '<div class="vazio">Sem atendimentos do Zappy ligados ao seu login.</div>') + '</div>';
  }

  // ── Prioridades ──────────────────────────────────────────────────────────────
  function desenharPrioridades() {
    var p = estado.painel;
    var grupo = function (nivel, rot) {
      var l = p.prioridades.filter(function (x) { return x.nivel === nivel; });
      if (!l.length) return '';
      return '<div class="card"><div class="card-title">' + rot + ' (' + l.length + ')</div>' + l.map(function (x) {
        var ic = { tratativa: '✅', email: '📧', sla: '🎧' }[x.tipo] || '•';
        return '<div class="linha-item"><span class="q">' + ic + '</span><span class="r" style="flex:0 0 260px">' + esc(x.titulo) + '</span><span class="x">' + esc(x.detalhe) + '</span></div>';
      }).join('') + '</div>';
    };
    $('sec-prioridades').innerHTML = (grupo('alta', 'Urgente') + grupo('media', 'Para acompanhar')) || '<div class="card"><div class="vazio">Nada pendente. Bom trabalho!</div></div>';
  }

  // ── Tratativas ───────────────────────────────────────────────────────────────
  var ROT_ACAO = { nota: 'Nota', iniciada: 'Iniciou a tratativa', finalizada: 'Finalizou', devolvida: 'Devolvida pela liderança', validada: 'Encerrada pela liderança' };
  function linhaTempo(r) {
    var n = r.notas || []; if (!n.length) return '';
    return '<div class="qa-reg-trat">' + n.map(function (x) {
      return '<div><strong>' + esc(ROT_ACAO[x.acao] || x.acao) + '</strong> · ' + dt(x.em) + (x.por ? ' · ' + esc(x.por) : '') + (x.texto ? ': ' + esc(x.texto) : '') + '</div>';
    }).join('') + '</div>';
  }
  function cartaoTrat(r) {
    var trabalhando = r.status === 'aberto' || r.status === 'em_tratamento';
    var meu = true;                                    // o analista, ou a liderança em nome dele (Ver como)
    var h = '<div class="qa-reg" id="r-' + esc(r.id) + '"><div class="qa-reg-topo">' + pill(r.situacao) + ' <strong>' + esc(r.tipo) + '</strong> <span class="cinza">· ' + esc((r.departamentos || []).join(', ')) + '</span></div>' +
      '<div class="qa-reg-txt">' + esc(r.detalhe) + '</div>' +
      '<div class="qa-reg-rod"><strong>' + esc(r.cliente_nome || 'Cliente') + '</strong> · lançado em ' + dt(r.criado_em) + ' por ' + esc(r.criado_por || '—') + ' · prazo <strong>' + dt(r.prazo) + '</strong>' +
        (r.resolvido_em ? ' · finalizado em ' + dt(r.resolvido_em) : '') + (r.validado_em ? ' · encerrado em ' + dt(r.validado_em) + (r.validado_por ? ' por ' + esc(r.validado_por) : '') : '') + '</div>' +
      (r.tratativa ? '<div class="qa-reg-trat"><strong>O que foi feito:</strong> ' + esc(r.tratativa) + '</div>' : '') + linhaTempo(r);
    if (r.status === 'finalizada') h += '<div class="qa-reg-trat" style="border-left:3px solid #7c3aed"><strong>Aguardando validação da liderança.</strong> Você será avisado se ela devolver para ajuste.</div>';
    if (trabalhando && meu) {
      if (estado.analistaVer) h += '<div class="cinza" style="font-size:11px;margin-top:8px">Você está agindo em nome do analista: o que registrar aparece como "' + esc((JSON.parse(ls(K_USER) || '{}') || {}).name || 'liderança') + ' (em nome de ...)".</div>';
      h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
        (r.status === 'aberto' ? '<button type="button" class="gp-footer-btn" style="width:auto" data-ini="' + esc(r.id) + '">▶ Iniciar tratativa</button>' : '') +
        '<button type="button" class="gp-footer-btn" style="width:auto" data-nota="' + esc(r.id) + '">📝 Adicionar nota</button>' +
        '<button type="button" class="login-btn" style="width:auto;margin:0;padding:7px 16px" data-res="' + esc(r.id) + '">✔ Finalizar tratativa</button></div>' +
        '<div id="n-' + esc(r.id) + '" style="display:none;margin-top:10px"><textarea id="nx-' + esc(r.id) + '" rows="2" maxlength="600" class="gp-input" style="width:100%" placeholder="Nota ou observação sobre a tratativa (ex.: liguei para o cliente, aguardando retorno)"></textarea>' +
        '<div style="margin-top:6px"><button type="button" class="gp-footer-btn" style="width:auto" data-nsalvar="' + esc(r.id) + '">Salvar nota</button> <span class="pop-erro" id="ne-' + esc(r.id) + '"></span></div></div>' +
        '<div id="t-' + esc(r.id) + '" style="display:none;margin-top:10px"><textarea id="tx-' + esc(r.id) + '" rows="3" maxlength="600" class="gp-input" style="width:100%" placeholder="O que foi feito para resolver? (mínimo de 5 caracteres)"></textarea>' +
        '<div style="margin-top:6px"><button type="button" class="login-btn" style="width:auto;margin:0;padding:7px 16px" data-conf="' + esc(r.id) + '">Confirmar finalização</button> <span class="pop-erro" id="e-' + esc(r.id) + '"></span></div>' +
        '<div class="cinza" style="font-size:11px;margin-top:4px">A liderança é avisada e dá o processo como finalizado.</div></div>';
    }
    return h + '</div>';
  }
  function desenharTratativas() {
    var p = estado.painel, f = estado.filtroTrat;
    var regs = p.registros.filter(function (r) {
      if (f === 'pendentes') return r.status === 'aberto' || r.status === 'em_tratamento';
      if (f === 'vencidas') return r.situacao === 'vencido';
      if (f === 'validar') return r.status === 'finalizada';
      if (f === 'resolvidas') return r.status === 'resolvido';
      return true;
    });
    var cont = function (fn) { return p.registros.filter(fn).length; };
    var abas = [['pendentes', 'Pendentes', cont(function (r) { return r.status === 'aberto' || r.status === 'em_tratamento'; })], ['vencidas', 'Vencidas', cont(function (r) { return r.situacao === 'vencido'; })],
      ['validar', 'Aguardando validação', cont(function (r) { return r.status === 'finalizada'; })], ['resolvidas', 'Encerradas', cont(function (r) { return r.status === 'resolvido'; })], ['todas', 'Todas', p.registros.length]];
    $('sec-tratativas').innerHTML = '<div class="card"><div class="filter-group" style="margin-bottom:14px">' + abas.map(function (a) {
      return '<button type="button" class="gp-footer-btn" style="width:auto;' + (a[0] === f ? 'background:var(--green,#1a4233);color:#fff' : '') + '" data-aba="' + a[0] + '">' + a[1] + ' (' + a[2] + ')</button>';
    }).join('') + '</div>' + (regs.length ? regs.map(cartaoTrat).join('') : '<div class="vazio">Nada nesta lista.</div>') + '</div>';
    Array.prototype.forEach.call(document.querySelectorAll('#sec-tratativas [data-aba]'), function (b) { b.addEventListener('click', function () { estado.filtroTrat = b.getAttribute('data-aba'); desenharTratativas(); }); });
    var enviar = async function (url, metodo, corpo, erroEl) {
      var r = await chamar(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) { if (erroEl) erroEl.textContent = j.error || 'Não foi possível salvar.'; else window.alert(j.error || 'Não foi possível salvar.'); return false; }
      return true;
    };
    var base = function (id) { return '/api/qualidade/' + encodeURIComponent(id); };
    Array.prototype.forEach.call(document.querySelectorAll('#sec-tratativas [data-ini]'), function (b) { b.addEventListener('click', async function () { if (await enviar(base(b.getAttribute('data-ini')) + '/tratar', 'PATCH', { status: 'em_tratamento' })) carregar(); }); });
    Array.prototype.forEach.call(document.querySelectorAll('#sec-tratativas [data-nota]'), function (b) { b.addEventListener('click', function () { var t = $('n-' + b.getAttribute('data-nota')); t.style.display = t.style.display === 'none' ? 'block' : 'none'; }); });
    Array.prototype.forEach.call(document.querySelectorAll('#sec-tratativas [data-res]'), function (b) { b.addEventListener('click', function () { var t = $('t-' + b.getAttribute('data-res')); t.style.display = t.style.display === 'none' ? 'block' : 'none'; }); });
    Array.prototype.forEach.call(document.querySelectorAll('#sec-tratativas [data-nsalvar]'), function (b) {
      b.addEventListener('click', async function () {
        var id = b.getAttribute('data-nsalvar'), erro = $('ne-' + id); erro.textContent = '';
        var tx = $('nx-' + id).value.trim();
        if (tx.length < 3) { erro.textContent = 'Escreva a nota (mínimo de 3 caracteres).'; return; }
        if (await enviar(base(id) + '/nota', 'POST', { texto: tx }, erro)) { estado.filtroTrat = estado.filtroTrat; carregar(); }
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#sec-tratativas [data-conf]'), function (b) {
      b.addEventListener('click', async function () {
        var id = b.getAttribute('data-conf'), erro = $('e-' + id); erro.textContent = '';
        var tx = $('tx-' + id).value.trim();
        if (tx.length < 5) { erro.textContent = 'Descreva o que foi feito (mínimo de 5 caracteres).'; return; }
        if (await enviar(base(id) + '/tratar', 'PATCH', { status: 'finalizada', tratativa: tx }, erro)) carregar();
      });
    });
  }

  // ── Minha nota (Gamificação) ─────────────────────────────────────────────────
  function mesAtual() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function linhaComp(rot, v) {
    var n = Number(v), cor = n < 0 ? '#b91c1c' : (n > 0 ? '#166534' : 'var(--text2)');
    return '<div class="linha-item"><span class="r" style="flex:1">' + rot + '</span><span style="font-weight:700;color:' + cor + '">' + (n > 0 ? '+' : '') + n.toFixed(2) + '</span></div>';
  }
  function desenharNota() {
    $('sec-nota').innerHTML = '<div class="card"><div class="filter-group" style="margin-bottom:12px"><span class="filter-label">Mês</span><input class="gp-input" type="month" id="nota-mes" value="' + mesAtual() + '">' +
      '<button type="button" class="gp-footer-btn" id="nota-ver" style="width:auto">Ver minha nota</button></div><div id="nota-corpo"><div class="vazio">Escolha um mês e clique em "Ver minha nota".</div></div></div>';
    $('nota-ver').addEventListener('click', carregarNota);
    estado.notaCarregada = false;
  }
  async function carregarNota() {
    var campo = $('nota-mes'), corpo = $('nota-corpo'); if (!campo || !corpo) return;
    estado.notaCarregada = true;
    corpo.innerHTML = '<div class="vazio">Carregando…</div>';
    try {
      var c = await api('/api/data/gam/minha-composicao?mes=' + campo.value);
      if (c.semDados || c.mediaBase === undefined) { corpo.innerHTML = '<div class="vazio">' + esc(c.mensagem || 'Sem nota calculada nesse mês ainda.') + '</div>'; return; }
      corpo.innerHTML = '<div class="blocos">' +
        '<div class="bloco"><div class="t">Nota final do mês</div><div class="v">' + Number(c.media_individual).toFixed(2) + '</div><div class="d">capada em 5</div></div>' +
        '<div class="bloco"><div class="t">Atendimentos avaliados</div><div class="v">' + c.avaliacoes + '</div><div class="d">avaliados pelo cliente no mês</div></div></div>' +
        '<div class="ficha-sec">Composição</div>' +
        '<div class="linha-item"><span class="r" style="flex:1">Nota base (média dos atendimentos)</span><span style="font-weight:700">' + Number(c.mediaBase).toFixed(2) + '</span></div>' +
        linhaComp('Bônus/desconto de velocidade (média)', c.bonusTransferencia) +
        (c.bonusAceite !== undefined ? linhaComp('Bônus/desconto de aceite do aguardando (média)', c.bonusAceite) : '') +
        linhaComp('Bônus/desconto de /Finalizar + reabertura (média)', c.bonusFinalizar) +
        (c.bonusAbandono !== undefined ? linhaComp('Desconto de abandono de atendimento (média)', c.bonusAbandono) : '');
    } catch (e) {
      corpo.innerHTML = '<div class="vazio">' + esc(e.status === 403 ? 'Seu login não tem a marca "Minha Nota". Peça à liderança para marcar em Usuários.' : e.message) + '</div>';
    }
  }

  // ── Meus atendimentos ────────────────────────────────────────────────────────
  function desenharAtendimentos() {
    var a = estado.painel.atendimentos;
    if (!a.vinculado) { $('sec-atendimentos').innerHTML = '<div class="card"><div class="vazio">Seu login ainda não está ligado a um usuário do Zappy. A liderança faz esse vínculo em Gamificação > Colaboradores.</div></div>'; return; }
    var linhas = a.lista.map(function (t) {
      var cor = { vermelho: '#dc2626', amarelo: '#d97706', verde: '#10b981' }[t.pior_status] || '#9ca3af';
      return '<tr><td>' + dt(t.abertura) + '</td><td>' + esc(t.cliente_nome || t.empresa_texto || '—') + '</td><td>' + esc(t.departamento || '—') + '</td><td class="c">' + (t.nota_avaliacao != null ? t.nota_avaliacao : '—') + '</td>' +
        '<td class="c"><span class="pill" style="color:' + cor + ';border-color:' + cor + '55;background:' + cor + '14">' + esc(t.pior_status || '—') + '</span></td></tr>';
    }).join('');
    $('sec-atendimentos').innerHTML =
      '<div class="gp-kpi-row">' + kpi('#0f766e', 'Atendimentos', a.total, 'últimos ' + a.janela_dias + ' dias') + kpi('#dc2626', 'SLA vermelho', a.sla_vermelho, 'antes da revisão da Gamificação') +
        kpi('#b45309', 'Notas baixas', a.notas_baixas, 'nota 1 ou 2') + kpi('#2563eb', 'Nota média', a.media_nota == null ? '—' : String(a.media_nota).replace('.', ','), 'avaliação do cliente') + '</div>' +
      '<div class="card"><div class="card-sub">Seus ' + a.lista.length + ' atendimentos mais recentes.</div>' +
        (a.lista.length ? '<div class="table-wrap"><table><thead><tr><th>Data</th><th>Empresa</th><th>Setor</th><th class="c">Nota</th><th class="c">SLA</th></tr></thead><tbody>' + linhas + '</tbody></table></div>' : '<div class="vazio">Nenhum atendimento no período.</div>') + '</div>';
  }

  // ── Meus e-mails ─────────────────────────────────────────────────────────────
  function desenharEmails() {
    var e = estado.painel.emails;
    if (!e.lido_em) { $('sec-emails').innerHTML = '<div class="card"><div class="vazio">A leitura de e-mails ainda não foi carregada.</div></div>'; return; }
    var linhas = e.clientes.map(function (c) {
      return '<tr><td>' + esc(c.nome || c.cnpj) + '</td><td class="c">' + c.recebidos + '</td><td class="c">' + (c.sem ? '<strong style="color:#dc2626">' + c.sem + '</strong>' : '0') + '</td></tr>';
    }).join('');
    $('sec-emails').innerHTML =
      '<div class="gp-kpi-row">' + kpi('#b45309', 'E-mails recebidos', e.recebidos, 'últimos ' + (e.janela_dias || 180) + ' dias') + kpi('#b91c1c', 'Sem resposta', e.sem_resposta, 'ninguém do escritório respondeu depois') +
        kpi('#256050', 'Clientes', e.clientes.length, 'que escreveram para você') + '</div>' +
      '<div class="nota">Só entram contatos ligados a uma empresa. A resposta de qualquer pessoa do escritório encerra a espera. Leitura de ' + esc(new Date(e.lido_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })) + '.</div>' +
      '<div class="card">' + (e.clientes.length ? '<div class="table-wrap"><table><thead><tr><th>Cliente</th><th class="c">Recebidos</th><th class="c">Sem resposta</th></tr></thead><tbody>' + linhas + '</tbody></table></div>' : '<div class="vazio">Nenhum e-mail de cliente para você na leitura.</div>') + '</div>';
  }

  // ── Evolução semanal ─────────────────────────────────────────────────────────
  function desenharEvolucao() {
    var ev = estado.painel.evolucao;
    var max = Math.max.apply(null, ev.map(function (x) { return Math.max(x.atendimentos, x.lancadas, x.resolvidas); }).concat([1]));
    var barra = function (v, cor) { return '<div style="display:flex;gap:6px;align-items:center"><div style="height:8px;border-radius:4px;background:' + cor + ';width:' + Math.max(2, Math.round(v / max * 100)) + 'px"></div>' + v + '</div>'; };
    $('sec-evolucao').innerHTML = '<div class="card"><div class="table-wrap"><table><thead><tr><th>Semana (segunda-feira)</th><th>Atendimentos</th><th>Tratativas lançadas</th><th>Tratativas resolvidas</th></tr></thead><tbody>' +
      ev.slice().reverse().map(function (x) { return '<tr><td>' + dt(x.semana) + '</td><td>' + barra(x.atendimentos, '#0f766e') + '</td><td>' + barra(x.lancadas, '#b45309') + '</td><td>' + barra(x.resolvidas, '#166534') + '</td></tr>'; }).join('') +
      '</tbody></table></div></div>';
  }

  // ── início ───────────────────────────────────────────────────────────────────
  $('login-form').addEventListener('submit', entrar);
  $('btn-atualizar').addEventListener('click', carregar);
  Array.prototype.forEach.call(document.querySelectorAll('.gp-nav-item'), function (b) { b.addEventListener('click', function () { irPara(b.getAttribute('data-sec')); }); });
  if (ls(K_TOKEN)) iniciar(); else mostrarLogin('');
})();
