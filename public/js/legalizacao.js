/* Legalização (/legalizacao): alvarás, certificados digitais e procurações. Mesmo modelo do /financeiro.
 * Toda checagem de acesso é feita pelo servidor (/api/data/legalizacao/*); aqui só se desenha o que ele devolveu. */
(function () {
  'use strict';

  // Mesma sessão do /cs e do /financeiro (mesmo navegador): entrou em uma página, entra nas outras.
  var K_TOKEN = 'cs_token', K_REFRESH = 'cs_refresh', K_USER = 'cs_user';
  var POR_PAGINA = 50;

  var SECOES = {
    visao: ['Visão Geral', 'Alvarás, certificados digitais e procuração de toda a carteira em um só lugar. Clique em um documento para ver a lista.'],
    prioridades: ['Prioridades', 'O que já venceu ou está para vencer, do mais urgente ao menos urgente. Clique na empresa para ver os detalhes.'],
    funcionamento: ['Alvarás de funcionamento', 'Situação e vencimento do alvará de funcionamento de cada cliente, vindos da consulta à prefeitura ou da pasta da Legalização.'],
    sanitario: ['Alvarás sanitários', 'Alvarás sanitários encontrados pela consulta noturna à prefeitura. Entram sozinhos quando a consulta encontra.'],
    certificados: ['Certificados digitais', 'Certificado digital de cada cliente, pessoa física (e-CPF) ou jurídica (e-CNPJ).'],
    procuracoes: ['Procurações', 'Procuração E-CAC e procuração FGTS Digital de cada cliente.'],
    carteira: ['Todos os clientes', 'Cada cliente com a situação de todos os seus documentos. Clique na empresa para abrir a ficha.'],
    solicitacoes: ['Solicitações', 'Renovações de alvará que já foram pedidas à prefeitura e aguardam andamento.'],
    evolucao: ['Evolução semanal', 'Como a situação dos documentos muda de semana para semana. Um retrato por semana, gravado todos os dias.'],
    qualidade: ['Qualidade dos dados', 'O que ainda impede a consulta automática ou deixa um documento sem data.'],
  };
  var NOMES_SEC = Object.keys(SECOES);

  var TIPOS = ['func', 'sanit', 'cert_pf', 'cert_pj', 'ecac', 'fgts'];
  var ROT_TIPO = { func: 'Alvará de funcionamento', sanit: 'Alvará sanitário', cert_pf: 'Certificado digital PF', cert_pj: 'Certificado digital PJ', ecac: 'Procuração E-CAC', fgts: 'Procuração FGTS Digital' };
  var ROT_CURTO = { func: 'Funcionamento', sanit: 'Sanitário', cert_pf: 'Certificado PF', cert_pj: 'Certificado PJ', ecac: 'E-CAC', fgts: 'FGTS Digital' };
  var ICO_TIPO = { func: '🏢', sanit: '🩺', cert_pf: '👤', cert_pj: '🏛️', ecac: '📜', fgts: '🧾' };
  var ST_ORDEM = ['vencido', 'vencendo', 'solicitacao', 'sem_data', 'ok'];
  var ROT_ST = { vencido: 'Vencido', vencendo: 'Vencendo', solicitacao: 'Solicitação', sem_data: 'Sem data', ok: 'Em dia' };
  var COR_ST = { vencido: '#dc2626', vencendo: '#d97706', solicitacao: '#2563eb', sem_data: '#9ca3af', ok: '#10b981' };
  var ROT_AUTO = { automatica: 'Consulta automática', pasta: 'Só pela pasta', sem_municipio: 'Sem município', pessoa_fisica: 'Pessoa física' };
  var ROT_PEND = {
    sem_municipio: 'Município não identificado',
    pasta: 'Cidade sem consulta automática',
    sem_data: 'Sem data, ainda não consultado',
    consultado: 'Consultado, nada localizado',
    conferir: 'Data lida do documento, aguardando conferência',
    sem_cadastro: 'Sem cadastro no Acessórias',
  };

  var estado = {
    linhas: [], dias: null, historico: [], secao: 'visao', fichaIx: null, inatId: null, lidoEm: null,
    f: {
      prioridades: { busca: '', tipo: '', sit: '', auto: '', pag: 1 },
      funcionamento: { busca: '', sit: '', auto: '', pag: 1 },
      sanitario: { busca: '', sit: '', auto: '', pag: 1 },
      certificados: { busca: '', tipo: '', sit: '', auto: '', pag: 1 },
      procuracoes: { busca: '', tipo: '', sit: '', auto: '', pag: 1 },
      carteira: { busca: '', sit: '', auto: '', pag: 1 },
      solicitacoes: { busca: '', tipo: '', auto: '', pag: 1 },
      qualidade: { busca: '', pend: '', pag: 1 },
    },
  };
  var sinoTimer = null;

  // ── utilidades ───────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function data(s) { return s ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) + '/' + String(s).slice(0, 4) : '—'; }
  function dataSemana(s) { return s ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) : ''; }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  function num(n) { return n == null ? '—' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function hojeIso() { var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); }
  function utc(iso) { return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)); }
  /** Dias até o vencimento (negativo = já venceu); null sem data. */
  function diasAte(venc) { return venc ? Math.round((utc(String(venc).slice(0, 10)) - utc(hojeIso())) / 86400000) : null; }
  function prazoTxt(i) {
    var d = i ? diasAte(i.vencimento) : null;
    if (d == null) return '—';
    if (d < 0) return 'venceu há ' + (-d) + ' d';
    if (d === 0) return 'vence hoje';
    return 'vence em ' + d + ' d';
  }
  function prazoHtml(i) {
    var d = i ? diasAte(i.vencimento) : null;
    if (d == null) return '<span class="cinza">—</span>';
    var cls = i.status === 'vencido' || d < 0 ? 'lg-prazo-venc' : (i.status === 'vencendo' ? 'lg-prazo-aviso' : '');
    return '<span class="' + cls + '" style="white-space:nowrap">' + esc(prazoTxt(i)) + '</span>';
  }
  function aviso(texto) {
    var a = document.createElement('div'); a.className = 'lg-aviso'; a.setAttribute('role', 'status'); a.textContent = texto;
    document.body.appendChild(a); setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 3200);
  }

  // ── sessão ────────────────────────────────────────────────────────────
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
  /** Chamada com o token da página e renovação da sessão; devolve a Response. */
  async function chamarApi(caminho, opcoes, tentou) {
    var o = Object.assign({ cache: 'no-store' }, opcoes || {});
    o.headers = Object.assign({}, o.headers || {}, { Authorization: 'Bearer ' + (ls(K_TOKEN) || '') });
    var r = await fetch(caminho, o);
    if (r.status === 401 && !tentou && await renovar()) return chamarApi(caminho, opcoes, true);
    return r;
  }
  async function api(caminho) {
    var r = await chamarApi(caminho);
    if (r.status === 401) { sair(true); throw new Error('Sessão expirada. Entre de novo.'); }
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || 'Erro ' + r.status);
    return j;
  }
  function podeEntrar(u) { return !!u && (u.role === 'administrador' || !!u.acesso_legalizacao); }
  async function entrar(ev) {
    ev.preventDefault();
    var btn = $('login-btn'); btn.disabled = true; btn.textContent = 'Entrando…';
    try {
      var r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('inp-email').value.trim(), password: $('inp-senha').value }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) { mostrarLogin(j.error || 'Não foi possível entrar.'); return; }
      if (!podeEntrar(j.user)) { mostrarLogin('Esse login não tem acesso à Legalização. Fale com a liderança.'); return; }
      ls(K_TOKEN, j.token); ls(K_REFRESH, j.refreshToken); ls(K_USER, JSON.stringify(j.user));
      $('inp-senha').value = '';
      iniciar();
    } catch (e) { mostrarLogin('Sem conexão com o servidor. Tente de novo.'); }
    finally { btn.disabled = false; btn.textContent = 'Entrar'; }
  }
  function sair(silencioso) {
    var rt = ls(K_REFRESH), tk = ls(K_TOKEN);
    if (!silencioso && rt && tk) fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify({ refreshToken: rt }) }).catch(function () { /* sair não depende do servidor */ });
    ls(K_TOKEN, null); ls(K_REFRESH, null); ls(K_USER, null);
    estado.linhas = []; estado.historico = [];
    if (sinoTimer) { clearInterval(sinoTimer); sinoTimer = null; }
    mostrarLogin(silencioso ? 'Sua sessão expirou. Entre de novo.' : '');
  }
  function montarMenuUsuario(u) {
    if (!window.MenuUsuario || !$('menu-usuario')) return;
    window.MenuUsuario.montar({
      alvo: $('menu-usuario'), usuario: u, chamar: chamarApi,
      rotulos: { colaborador: 'Legalização' },
      aoSair: function () { sair(false); },
      aoAtualizar: function (novo) { var atual = {}; try { atual = JSON.parse(ls(K_USER) || '{}') || {}; } catch (e) { atual = {}; } ls(K_USER, JSON.stringify(Object.assign(atual, { name: novo.name, email: novo.email }))); },
    });
  }

  // ── carga ──────────────────────────────────────────────────────
  async function iniciar() {
    var u = null; try { u = JSON.parse(ls(K_USER) || 'null'); } catch (e) { u = null; }
    if (!podeEntrar(u)) { mostrarLogin('Esse login não tem acesso à Legalização. Fale com a liderança.'); return; }
    $('login-screen').style.display = 'none';
    $('app').style.display = 'block';
    montarMenuUsuario(u);
    NOMES_SEC.forEach(function (s) { $('sec-' + s).innerHTML = '<div class="vazio">Carregando…</div>'; });
    carregarSino();
    if (!sinoTimer) sinoTimer = setInterval(carregarSino, 5 * 60 * 1000);
    await carregar();
  }
  async function carregar() {
    try {
      var j = await api('/api/data/legalizacao/painel');
      estado.linhas = (j.data || []).map(function (l, ix) { l._ix = ix; return l; });
      estado.dias = j.diasAlerta || null;
      estado.lidoEm = new Date();
      try { estado.historico = (await api('/api/data/legalizacao/historico')).data || []; } catch (e) { estado.historico = []; }   // o histórico nunca derruba a página
      desenharTudo();
    } catch (e) {
      NOMES_SEC.forEach(function (s) { $('sec-' + s).innerHTML = '<div class="card"><div class="vazio" style="color:var(--red)">' + esc(e.message) + '</div></div>'; });
    }
  }
  function desenharTudo() {
    var prio = docsPrioridade().filter(function (r) { return r.i.status === 'vencido'; }).length;
    var sol = docsDe(function (i) { return i.status === 'solicitacao'; }).length;
    $('badge-prio').textContent = prio || '';
    $('badge-sol').textContent = sol || '';
    var h = estado.lidoEm;
    $('atualizado').textContent = h ? 'Atualizado às ' + String(h.getHours()).padStart(2, '0') + ':' + String(h.getMinutes()).padStart(2, '0') : '';
    desenharVisao(); desenharEvolucao();
    ['prioridades', 'funcionamento', 'sanitario', 'certificados', 'procuracoes', 'carteira', 'solicitacoes', 'qualidade'].forEach(desenharLista);
    irPara(estado.secao);
    if (estado.fichaIx != null && $('ficha').style.display === 'flex') desenharFicha(estado.fichaIx);
  }
  function irPara(sec) {
    estado.secao = sec;
    Array.prototype.forEach.call(document.querySelectorAll('.gp-nav-item'), function (b) { b.classList.toggle('active', b.getAttribute('data-sec') === sec); });
    Array.prototype.forEach.call(document.querySelectorAll('.gp-section'), function (s) { s.classList.toggle('ativa', s.id === 'sec-' + sec); });
    $('titulo').textContent = SECOES[sec][0];
    $('subtitulo').textContent = SECOES[sec][1];
    var ativa = $('sec-' + sec); if (ativa) ativa.scrollTop = 0;
  }

  // ── modelo dos dados ─────────────────────────────────────────────────────
  function itemDe(l, tipo) {
    if (tipo === 'cert_pj') return l.cert && l.cert.tipo === 'pj' && !l.cert.desativado ? l.cert : null;   // certificado desativado sai de tudo (deixa de ser cobrado)
    if (tipo === 'cert_pf') return l.cert && l.cert.tipo === 'pf' && !l.cert.desativado ? l.cert : null;
    return l[tipo] || null;
  }
  function stDe(i) { return i && COR_ST[i.status] ? i.status : 'sem_data'; }
  /** Alvará (funcionamento/sanitário) sem data que JÁ foi consultado (consulta à prefeitura ou leitura da pasta) e nada foi localizado. */
  function consultadoSemAlvara(i, tipo) { return !!(i && (tipo === 'func' || tipo === 'sanit') && stDe(i) === 'sem_data' && i.consulta_em); }
  /** Todos os documentos (uma linha por documento) que passam no teste. */
  function docsDe(teste, tipos) {
    var out = [];
    estado.linhas.forEach(function (l) {
      (tipos || TIPOS).forEach(function (t) {
        var i = itemDe(l, t);
        if (i && (!teste || teste(i, l, t))) out.push({ l: l, tipo: t, i: i, st: stDe(i) });
      });
    });
    return out;
  }
  function docsPrioridade() {
    return docsDe(function (i) { var s = stDe(i); return s === 'vencido' || s === 'vencendo'; }).sort(function (a, b) {
      if (a.st !== b.st) return a.st === 'vencido' ? -1 : 1;
      var da = diasAte(a.i.vencimento), db = diasAte(b.i.vencimento);
      return (da == null ? 1e9 : da) - (db == null ? 1e9 : db);
    });
  }
  function contagem(tipo) {
    var c = { vencido: 0, vencendo: 0, solicitacao: 0, sem_data: 0, ok: 0, total: 0, proximo: null };
    docsDe(null, [tipo]).forEach(function (r) {
      c[r.st]++; c.total++;
      if ((r.st === 'vencendo' || r.st === 'ok') && r.i.vencimento && (!c.proximo || r.i.vencimento < c.proximo.venc)) c.proximo = { venc: r.i.vencimento, nome: r.l.nome_empresa };
    });
    return c;
  }
  function piorDe(l) {
    var pior = null;
    TIPOS.forEach(function (t) { var i = itemDe(l, t); if (!i) return; var s = stDe(i); if (pior == null || ST_ORDEM.indexOf(s) < ST_ORDEM.indexOf(pior)) pior = s; });
    return pior || 'sem_data';
  }
  function empresasComStatus(st) {
    var vistos = {}, n = 0;
    docsDe(function (i) { return stDe(i) === st; }).forEach(function (r) { if (!vistos[r.l._ix]) { vistos[r.l._ix] = 1; n++; } });
    return n;
  }

  // ── blocos reutilizáveis ─────────────────────────────────────────────────────
  function kpi(cor, rot, val, sub) {
    return '<div class="gp-kpi"><div class="gp-kpi-bar" style="background:' + cor + '"></div><div class="gp-kpi-label">' + rot + '</div><div class="gp-kpi-value" style="color:' + cor + '">' + val + '</div><div class="gp-kpi-sub">' + sub + '</div></div>';
  }
  function pillSt(st) {
    var c = COR_ST[st] || COR_ST.sem_data;
    return '<span class="pill" style="color:' + c + ';border-color:' + c + '55;background:' + c + '14">' + esc(ROT_ST[st] || st) + '</span>';
  }
  function pillAuto(l) {
    var cor = l.automacao === 'automatica' ? '#10b981' : (l.automacao === 'sem_municipio' ? '#dc2626' : '#6b7280');
    return '<span class="pill" style="color:' + cor + ';border-color:' + cor + '55;background:' + cor + '14">' + esc(ROT_AUTO[l.automacao] || '—') + '</span>';
  }
  function nomeLink(l) {
    return '<button class="link" data-ficha="' + l._ix + '">' + esc(l.nome_empresa || '—') + '</button>' +
      (l.sem_cadastro_acessorias ? ' <span class="pill" style="color:#92400e;border-color:#92400e55;background:#92400e14" title="Esta empresa não tem cadastro no Acessórias">sem cadastro</span>' : '');
  }
  function celEmpresa(l) { return nomeLink(l) + '<div class="sub">' + esc(l.cnpj || '') + '</div>'; }
  function celMunicipio(l) {
    var m = l.municipio ? esc(l.municipio) + (l.uf ? '/' + esc(l.uf) : '') : '<span class="cinza">sem município</span>';
    return m + '<div class="sub">' + esc(ROT_AUTO[l.automacao] || '') + '</div>';
  }
  function celDoc(i) {
    if (!i) return '<span class="cinza">—</span>';
    return '<div class="lg-cel">' + pillSt(stDe(i)) + (i.vencimento ? '<span class="sub">' + data(String(i.vencimento).slice(0, 10)) + '</span>' : '') + '</div>';
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
  function opcoes(lista, sel, todas) {
    return '<option value="">' + todas + '</option>' + lista.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (sel === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
  }
  var OPC_SIT = ST_ORDEM.map(function (s) { return [s, ROT_ST[s]]; });
  var OPC_AUTO = Object.keys(ROT_AUTO).map(function (a) { return [a, ROT_AUTO[a]]; });
  function bateBusca(l, q) {
    if (!q) return true;
    var dig = q.replace(/\D/g, '');
    return norm(l.nome_empresa).indexOf(q) >= 0 || (dig && String(l.cnpj || '').replace(/\D/g, '').indexOf(dig) >= 0) || norm(l.municipio).indexOf(q) >= 0;
  }

  // ── LISTAS (uma especificação por seção; o mesmo desenho serve à tela e à exportação) ──────────
  // linha = { l (empresa), tipo, i (documento), st (situação), pend, detalhe }
  function porNome(a, b) { return norm(a.l.nome_empresa) < norm(b.l.nome_empresa) ? -1 : 1; }
  function empresaRow(l) { return { l: l, tipo: null, i: null, st: piorDe(l) }; }
  var COL_EMPRESA = { t: 'Empresa', h: function (r) { return celEmpresa(r.l); }, x: function (r) { return r.l.nome_empresa || ''; } };
  var COL_CNPJ = { t: 'CNPJ/CPF', x: function (r) { return r.l.cnpj || ''; } };
  var COL_MUN = { t: 'Município', h: function (r) { return celMunicipio(r.l); }, x: function (r) { return r.l.municipio ? r.l.municipio + (r.l.uf ? '/' + r.l.uf : '') : ''; } };
  var COL_AUTO = { t: 'Consulta', x: function (r) { return ROT_AUTO[r.l.automacao] || ''; } };
  var COL_DOCNOME = { t: 'Documento', h: function (r) { return esc(ROT_CURTO[r.tipo]); }, x: function (r) { return ROT_TIPO[r.tipo]; } };
  var COL_SIT = { t: 'Situação', h: function (r) { return pillSt(r.st); }, x: function (r) { return ROT_ST[r.st]; } };
  var COL_VENC = { t: 'Vencimento', h: function (r) { return r.i && r.i.vencimento ? data(String(r.i.vencimento).slice(0, 10)) : '<span class="cinza">—</span>'; }, x: function (r) { return r.i && r.i.vencimento ? data(String(r.i.vencimento).slice(0, 10)) : ''; } };
  var COL_PRAZO = { t: 'Prazo', h: function (r) { return prazoHtml(r.i); }, x: function (r) { return r.i && r.i.vencimento ? prazoTxt(r.i) : ''; } };
  function obsDe(r) {
    var i = r.i; if (!i) return '';
    var p = [];
    if (i.status === 'solicitacao' && i.consulta_resumo) p.push(i.consulta_resumo);
    if (i.observacoes) p.push(i.observacoes);
    return p.join(' · ');
  }
  var COL_OBS = { t: 'Observação', h: function (r) { var t = obsDe(r); return (r.i && r.i.a_conferir ? '<span class="pill" style="color:#b45309;border-color:#b4530955;background:#b4530914" title="Data lida do documento; falta alguém conferir">a conferir</span> ' : '') + (t ? esc(t) : (r.i && r.i.a_conferir ? '' : '<span class="cinza">—</span>')); }, x: function (r) { return (r.i && r.i.a_conferir ? '[a conferir] ' : '') + obsDe(r); } };
  var COL_NUM = { t: 'Nº do alvará', h: function (r) { return r.i && r.i.numero ? esc(r.i.numero) : '<span class="cinza">—</span>'; }, x: function (r) { return r.i && r.i.numero ? r.i.numero : ''; } };

  function ehAdmin() { try { var u = JSON.parse(ls(K_USER) || 'null'); return !!u && u.role === 'administrador'; } catch (e) { return false; } }
  /** Certificado que o cliente não vai renovar: o analista informa (pedido ao administrador); o administrador desativa na hora. */
  function temBotaoCert(l) { return !!l && !!(itemDe(l, 'cert_pj') || itemDe(l, 'cert_pf')) && !!(l.cliente_id || (l.cert && l.cert.id)); }
  function botaoCert(l) {
    if (!temBotaoCert(l)) return '<span class="cinza">—</span>';
    return ehAdmin()
      ? '<button class="lg-acao perigo" data-acao="cert-desat" data-ix="' + l._ix + '" title="Desativa o certificado: sai da lista e dos indicadores e deixa de ser cobrado">🚫 Desativar</button>'
      : '<button class="lg-acao perigo" data-acao="cert-sol" data-ix="' + l._ix + '" title="Cliente sem movimento ou que não quer renovar: avisa o administrador para desativar e parar a cobrança">📝 Não vai renovar</button>';
  }
  var COL_ACAO_CERT = { t: 'Ação', acao: true, h: function (r) { return botaoCert(r.l); }, x: function () { return ''; } };

  var SPECS = {
    prioridades: {
      arquivo: 'legalizacao-prioridades', titulo: 'Legalização — Prioridades', filtros: ['busca', 'tipo', 'sit', 'auto'],
      tipos: TIPOS.map(function (t) { return [t, ROT_CURTO[t]]; }), sits: [['vencido', 'Vencido'], ['vencendo', 'Vencendo']],
      linhas: function () { return docsPrioridade(); },
      colunas: [COL_EMPRESA, COL_DOCNOME, COL_SIT, COL_VENC, COL_PRAZO, COL_MUN, COL_OBS],
      ajuda: 'Vencidos primeiro, do que venceu há mais tempo ao que venceu há menos; depois os que estão para vencer.',
      vazio: 'Nada vencido nem para vencer. 🎉',
    },
    funcionamento: {
      arquivo: 'legalizacao-funcionamento', titulo: 'Legalização — Alvarás de funcionamento', filtros: ['busca', 'sit', 'auto'],
      linhas: function () { return docsDe(null, ['func']).sort(porNome); },
      colunas: [COL_EMPRESA, COL_SIT, COL_VENC, COL_PRAZO, COL_NUM, COL_MUN, COL_OBS],
      ajuda: 'Uma linha por cliente que tem alvará de funcionamento cadastrado.',
      vazio: 'Nenhum alvará de funcionamento com este filtro.',
    },
    sanitario: {
      arquivo: 'legalizacao-sanitario', titulo: 'Legalização — Alvarás sanitários', filtros: ['busca', 'sit', 'auto'],
      linhas: function () { return docsDe(null, ['sanit']).sort(porNome); },
      colunas: [COL_EMPRESA, COL_SIT, COL_VENC, COL_PRAZO, COL_NUM, COL_MUN, COL_OBS],
      ajuda: 'O sanitário entra sozinho quando a consulta noturna à prefeitura encontra o documento.',
      vazio: 'Ainda sem alvarás sanitários com este filtro. O Sanitário entra sozinho quando a consulta noturna à prefeitura encontrar.',
    },
    certificados: {
      arquivo: 'legalizacao-certificados', titulo: 'Legalização — Certificados digitais', filtros: ['busca', 'tipo', 'sit', 'auto'],
      tipos: [['cert_pj', 'Pessoa jurídica (e-CNPJ)'], ['cert_pf', 'Pessoa física (e-CPF)']],
      linhas: function () { return docsDe(null, ['cert_pj', 'cert_pf']).sort(porNome); },
      colunas: [COL_EMPRESA, { t: 'Tipo', h: function (r) { return r.tipo === 'cert_pf' ? 'PF' : 'PJ'; }, x: function (r) { return r.tipo === 'cert_pf' ? 'PF' : 'PJ'; } }, COL_SIT, COL_VENC, COL_PRAZO, COL_OBS, COL_ACAO_CERT],
      ajuda: 'Um certificado por cliente: PJ para empresa, PF para pessoa física.',
      vazio: 'Nenhum certificado com este filtro.',
    },
    procuracoes: {
      arquivo: 'legalizacao-procuracoes', titulo: 'Legalização — Procurações', filtros: ['busca', 'tipo', 'sit', 'auto'],
      tipos: [['ecac', 'E-CAC'], ['fgts', 'FGTS Digital']],
      linhas: function () { return docsDe(null, ['ecac', 'fgts']).sort(porNome); },
      colunas: [COL_EMPRESA, COL_DOCNOME, COL_SIT, COL_VENC, COL_PRAZO, COL_OBS],
      ajuda: 'Procuração E-CAC e procuração FGTS Digital; a data é preenchida manualmente.',
      vazio: 'Nenhuma procuração com este filtro.',
    },
    carteira: {
      arquivo: 'legalizacao-clientes', titulo: 'Legalização — Todos os clientes', filtros: ['busca', 'sit', 'auto'], sitRotulo: 'Pior situação',
      linhas: function () { return estado.linhas.map(empresaRow).sort(porNome); },
      colunas: [
        COL_EMPRESA, COL_MUN,
        { t: 'Funcionamento', h: function (r) { return celDoc(r.l.func); }, x: function (r) { var i = r.l.func; return i ? ROT_ST[stDe(i)] + (i.vencimento ? ' · ' + data(String(i.vencimento).slice(0, 10)) : '') : ''; } },
        { t: 'Sanitário', h: function (r) { return celDoc(r.l.sanit); }, x: function (r) { var i = r.l.sanit; return i ? ROT_ST[stDe(i)] + (i.vencimento ? ' · ' + data(String(i.vencimento).slice(0, 10)) : '') : ''; } },
        { t: 'Certificado', h: function (r) { return (r.l.cert ? '<div class="sub">' + (r.l.cert.tipo === 'pf' ? 'PF' : 'PJ') + '</div>' : '') + celDoc(r.l.cert); }, x: function (r) { var i = r.l.cert; return i ? (i.tipo === 'pf' ? 'PF ' : 'PJ ') + ROT_ST[stDe(i)] + (i.vencimento ? ' · ' + data(String(i.vencimento).slice(0, 10)) : '') : ''; } },
        { t: 'E-CAC', h: function (r) { return celDoc(r.l.ecac); }, x: function (r) { var i = r.l.ecac; return i ? ROT_ST[stDe(i)] + (i.vencimento ? ' · ' + data(String(i.vencimento).slice(0, 10)) : '') : ''; } },
        { t: 'FGTS Digital', h: function (r) { return celDoc(r.l.fgts); }, x: function (r) { var i = r.l.fgts; return i ? ROT_ST[stDe(i)] + (i.vencimento ? ' · ' + data(String(i.vencimento).slice(0, 10)) : '') : ''; } },
      ],
      expExtra: [COL_CNPJ],
      ajuda: 'Todos os clientes da lista de Legalização. A situação filtrada é a pior entre os documentos do cliente.',
      vazio: 'Nenhum cliente com este filtro.',
    },
    solicitacoes: {
      arquivo: 'legalizacao-solicitacoes', titulo: 'Legalização — Solicitações em andamento', filtros: ['busca', 'tipo', 'auto'],
      tipos: TIPOS.map(function (t) { return [t, ROT_CURTO[t]]; }),
      linhas: function () { return docsDe(function (i) { return stDe(i) === 'solicitacao'; }).sort(porNome); },
      colunas: [COL_EMPRESA, COL_DOCNOME, COL_VENC, { t: 'Andamento', h: function (r) { return esc(r.i.consulta_resumo || '') || '<span class="cinza">sem detalhe da prefeitura</span>'; }, x: function (r) { return r.i.consulta_resumo || ''; } },
        { t: 'Solicitado em', h: function (r) { return r.i.consulta_data_solicitacao ? data(String(r.i.consulta_data_solicitacao).slice(0, 10)) : '<span class="cinza">—</span>'; }, x: function (r) { return r.i.consulta_data_solicitacao ? data(String(r.i.consulta_data_solicitacao).slice(0, 10)) : ''; } },
        COL_MUN],
      ajuda: 'Documentos cuja renovação já foi solicitada à prefeitura. Saem desta lista quando o novo documento é emitido.',
      vazio: 'Nenhuma renovação em andamento.',
    },
    qualidade: {
      arquivo: 'legalizacao-qualidade', titulo: 'Legalização — Qualidade dos dados', filtros: ['busca', 'pend'],
      pends: Object.keys(ROT_PEND).map(function (p) { return [p, ROT_PEND[p]]; }),
      linhas: function () { return linhasQualidade(); },
      colunas: [COL_EMPRESA, { t: 'Pendência', h: function (r) { return esc(ROT_PEND[r.pend]); }, x: function (r) { return ROT_PEND[r.pend]; } },
        { t: 'Documento', h: function (r) { return r.tipo ? esc(ROT_CURTO[r.tipo]) : '<span class="cinza">—</span>'; }, x: function (r) { return r.tipo ? ROT_TIPO[r.tipo] : ''; } }, COL_MUN],
      ajuda: 'Cada linha é uma pendência de cadastro. Corrigir aqui faz a consulta automática alcançar mais clientes.',
      vazio: 'Nenhuma pendência com este filtro.',
    },
  };

  function linhasQualidade() {
    var out = [];
    estado.linhas.forEach(function (l) {
      if (l.sem_cadastro_acessorias) out.push({ l: l, tipo: null, i: null, st: 'sem_data', pend: 'sem_cadastro' });
      if (l.automacao === 'sem_municipio') out.push({ l: l, tipo: null, i: null, st: 'sem_data', pend: 'sem_municipio' });
      if (l.automacao === 'pasta') out.push({ l: l, tipo: null, i: null, st: 'sem_data', pend: 'pasta' });
      TIPOS.forEach(function (t) {
        var i = itemDe(l, t); if (!i) return;
        // Alvará sem data: se alguma consulta (prefeitura/pasta) já olhou e não achou, não é pendência — é "consultado, nada localizado".
        if (stDe(i) === 'sem_data') out.push({ l: l, tipo: t, i: i, st: 'sem_data', pend: consultadoSemAlvara(i, t) ? 'consultado' : 'sem_data' });
        if (i.a_conferir) out.push({ l: l, tipo: t, i: i, st: stDe(i), pend: 'conferir' });
      });
    });
    return out.sort(porNome);
  }

  function filtrarLinhas(chave) {
    var spec = SPECS[chave], f = estado.f[chave], q = norm(f.busca).trim();
    return spec.linhas().filter(function (r) {
      if (q && !bateBusca(r.l, q)) return false;
      if (f.tipo && r.tipo !== f.tipo) return false;
      if (f.sit && r.st !== f.sit) return false;
      if (f.auto && r.l.automacao !== f.auto) return false;
      if (f.pend && r.pend !== f.pend) return false;
      return true;
    });
  }
  function desenharLista(chave) {
    var spec = SPECS[chave], f = estado.f[chave], lista = filtrarLinhas(chave);
    var paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA)); if (f.pag > paginas) f.pag = paginas; if (f.pag < 1) f.pag = 1;
    var pagina = lista.slice((f.pag - 1) * POR_PAGINA, f.pag * POR_PAGINA);
    var campos = '<span class="filter-label">Buscar</span><input class="gp-input" id="f-' + chave + '-busca" placeholder="Empresa, CNPJ ou município" value="' + esc(f.busca) + '">';
    if (spec.filtros.indexOf('tipo') >= 0) campos += '<span class="filter-label">Documento</span><select class="gp-select" id="f-' + chave + '-tipo">' + opcoes(spec.tipos, f.tipo, 'Todos') + '</select>';
    if (spec.filtros.indexOf('sit') >= 0) campos += '<span class="filter-label">' + esc(spec.sitRotulo || 'Situação') + '</span><select class="gp-select" id="f-' + chave + '-sit">' + opcoes(spec.sits || OPC_SIT, f.sit, 'Todas') + '</select>';
    if (spec.filtros.indexOf('auto') >= 0) campos += '<span class="filter-label">Consulta</span><select class="gp-select" id="f-' + chave + '-auto">' + opcoes(OPC_AUTO, f.auto, 'Todas') + '</select>';
    if (spec.filtros.indexOf('pend') >= 0) campos += '<span class="filter-label">Pendência</span><select class="gp-select" id="f-' + chave + '-pend">' + opcoes(spec.pends, f.pend, 'Todas') + '</select>';
    var cab = spec.colunas.map(function (c) { return '<th>' + esc(c.t) + '</th>'; }).join('');
    var corpo = pagina.map(function (r) {
      return '<tr>' + spec.colunas.map(function (c) { return '<td style="white-space:normal">' + (c.h ? c.h(r) : esc(c.x(r))) + '</td>'; }).join('') + '</tr>';
    }).join('');
    var topo = chave === 'qualidade' ? cartoesQualidade(f.pend) : '';
    $('sec-' + chave).innerHTML = topo +
      '<div class="card"><div class="filter-group" style="margin-bottom:14px">' + campos + '</div>' +
      '<div class="card-sub">' + num(lista.length) + ' registro(s). ' + esc(spec.ajuda) + '</div>' +
      (lista.length ? '<div class="table-wrap"><table><thead><tr>' + cab + '</tr></thead><tbody>' + corpo + '</tbody></table></div>' + paginacao(lista.length, f.pag, chave)
        : '<div class="vazio">' + esc(spec.vazio) + '</div>') + '</div>';
    var campo = { busca: 'busca', tipo: 'tipo', sit: 'sit', auto: 'auto', pend: 'pend' };
    spec.filtros.forEach(function (nome) { ligarCampo(chave, nome, campo[nome]); });
  }
  function ligarCampo(chave, nome, prop) {
    var el = $('f-' + chave + '-' + nome); if (!el) return;
    el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', function () {
      estado.f[chave][prop] = el.value; estado.f[chave].pag = 1;
      var pos = el.selectionStart; desenharLista(chave);
      var n = $('f-' + chave + '-' + nome); if (n && n.tagName === 'INPUT') { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* sem seleção */ } }
    });
  }
  function cartoesQualidade(sel) {
    var cont = {}; Object.keys(ROT_PEND).forEach(function (p) { cont[p] = 0; });
    linhasQualidade().forEach(function (r) { cont[r.pend]++; });
    var cor = { sem_municipio: '#dc2626', pasta: '#6b7280', sem_data: '#d97706', consultado: '#9ca3af', conferir: '#2563eb', sem_cadastro: '#92400e' };
    var sub = {
      sem_municipio: 'informe a cidade para a consulta automática alcançar',
      pasta: 'a consulta é feita pela pasta ou no portal da cidade',
      sem_data: 'nunca foi consultado: falta buscar a data',
      consultado: 'a consulta já rodou e não achou alvará (pode ser que não exista)',
      conferir: 'data lida do arquivo, falta conferir',
      sem_cadastro: 'aparece na lista, mas não no Acessórias',
    };
    return '<div class="gp-kpi-row">' + Object.keys(ROT_PEND).map(function (p) {
      return '<div class="gp-kpi" style="cursor:pointer" data-pend="' + p + '"><div class="gp-kpi-bar" style="background:' + cor[p] + '"></div><div class="gp-kpi-label">' + esc(ROT_PEND[p]) + (sel === p ? ' ✓' : '') + '</div><div class="gp-kpi-value" style="color:' + cor[p] + '">' + num(cont[p]) + '</div><div class="gp-kpi-sub">' + esc(sub[p]) + '</div></div>';
    }).join('') + '</div>';
  }

  // ── VISÃO GERAL ──────────────────────────────────────────────────────────────
  function barra(c) {
    if (!c.total) return '<div class="lg-barra"></div>';
    return '<div class="lg-barra" role="img" aria-label="Distribuição por situação">' + ST_ORDEM.filter(function (s) { return c[s]; }).map(function (s) {
      return '<span style="width:' + (100 * c[s] / c.total).toFixed(2) + '%;background:' + COR_ST[s] + '" title="' + esc(ROT_ST[s]) + ': ' + c[s] + '"></span>';
    }).join('') + '</div>';
  }
  function desenharVisao() {
    var tot = { vencido: 0, vencendo: 0, solicitacao: 0, sem_data: 0, ok: 0 };
    var porTipo = {};
    TIPOS.forEach(function (t) { var c = contagem(t); porTipo[t] = c; ST_ORDEM.forEach(function (s) { tot[s] += c[s]; }); });
    var d = estado.dias || {};
    var kpis = '<div class="gp-kpi-row">' +
      kpi('#dc2626', 'Vencidos', num(tot.vencido), num(empresasComStatus('vencido')) + ' empresa(s) · precisam de ação agora') +
      kpi('#d97706', 'Vencendo', num(tot.vencendo), 'funcionamento ' + (d.funcionamento || 30) + ' d · sanitário ' + (d.sanitario || 120) + ' d · certificado e procuração ' + (d.certificado || 30) + ' d') +
      kpi('#2563eb', 'Solicitação em andamento', num(tot.solicitacao), 'renovação já pedida à prefeitura') +
      kpi('#10b981', 'Em dia', num(tot.ok), 'tudo certo') +
      kpi('#9ca3af', 'Sem data', num(tot.sem_data), (function () { var n = docsDe(function (i, l, t) { return consultadoSemAlvara(i, t); }).length; return n ? num(n) + ' alvará(s) já consultado(s), nada localizado · ' + num(tot.sem_data - n) + ' sem consulta' : 'documento sem vencimento informado'; })()) +
      '</div>';
    var cartoes = '<div class="lg-docs">' + TIPOS.map(function (t) {
      var c = porTipo[t];
      var secao = t === 'func' ? 'funcionamento' : t === 'sanit' ? 'sanitario' : (t === 'cert_pf' || t === 'cert_pj') ? 'certificados' : 'procuracoes';
      var leg = ST_ORDEM.map(function (s) { return '<span class="lg-pt" style="background:' + COR_ST[s] + '"></span><span>' + esc(ROT_ST[s]) + '</span><b style="color:' + (s === 'sem_data' ? 'var(--text3)' : COR_ST[s]) + '">' + c[s] + '</b>'; }).join('');
      return '<button type="button" class="lg-doc" data-ir="' + secao + '" data-tipo="' + t + '">' +
        '<div class="lg-doc-topo"><span class="lg-doc-nome">' + ICO_TIPO[t] + ' ' + esc(ROT_TIPO[t]) + '</span><span class="lg-doc-total">' + num(c.total) + '</span></div>' +
        (c.total ? barra(c) + '<div class="lg-leg">' + leg + '</div>' +
          (c.proximo ? '<div class="lg-prox">⏳ Próximo a vencer: <b>' + esc(c.proximo.nome) + '</b> · ' + data(String(c.proximo.venc).slice(0, 10)) + '</div>' : '')
          : '<div class="lg-prox">' + (t === 'sanit' ? 'Ainda sem registros. O sanitário entra sozinho quando a consulta noturna à prefeitura encontrar.' : 'Nenhum registro ainda.') + '</div>') +
        '</button>';
    }).join('') + '</div>';
    var prio = docsPrioridade().slice(0, 8);
    var linhasPrio = prio.map(function (r) {
      return '<tr><td style="white-space:normal">' + nomeLink(r.l) + '</td><td>' + esc(ROT_CURTO[r.tipo]) + '</td><td class="c">' + pillSt(r.st) + '</td><td class="c">' + prazoHtml(r.i) + '</td></tr>';
    }).join('');
    var nPrio = docsPrioridade().length;
    var blocoPrio = '<div class="card"><div class="card-title">Para agir primeiro</div><div class="card-sub">Os 8 documentos mais urgentes. ' + (nPrio > 8 ? 'Há mais ' + (nPrio - 8) + ' na seção Prioridades.' : '') + '</div>' +
      (prio.length ? '<div class="table-wrap"><table><thead><tr><th>Empresa</th><th>Documento</th><th class="c">Situação</th><th class="c">Prazo</th></tr></thead><tbody>' + linhasPrio + '</tbody></table></div>' +
        '<div style="margin-top:12px"><button class="lg-acao" data-ir="prioridades">Ver todas as prioridades →</button></div>'
        : '<div class="vazio">Nada vencido nem para vencer. 🎉</div>') + '</div>';
    var q = linhasQualidade(), cq = {}; q.forEach(function (r) { cq[r.pend] = (cq[r.pend] || 0) + 1; });
    var blocoQual = '<div class="card"><div class="card-title">Atenção na base</div><div class="card-sub">Pendências de cadastro que travam a consulta automática ou deixam documento sem data.</div>' +
      '<div class="blocos">' +
      '<div class="bloco"><div class="t">Sem município</div><div class="v">' + num(cq.sem_municipio || 0) + '</div><div class="d">a consulta automática não alcança</div></div>' +
      '<div class="bloco"><div class="t">Só pela pasta</div><div class="v">' + num(cq.pasta || 0) + '</div><div class="d">cidade sem consulta automática</div></div>' +
      '<div class="bloco"><div class="t">Sem data, não consultado</div><div class="v">' + num(cq.sem_data || 0) + '</div><div class="d">falta buscar a data</div></div>' +
      '<div class="bloco"><div class="t">Consultado, nada localizado</div><div class="v">' + num(cq.consultado || 0) + '</div><div class="d">a consulta rodou e não achou alvará</div></div>' +
      '<div class="bloco"><div class="t">A conferir</div><div class="v">' + num(cq.conferir || 0) + '</div><div class="d">datas lidas aguardando conferência</div></div>' +
      '</div><div style="margin-top:12px"><button class="lg-acao" data-ir="qualidade">Abrir qualidade dos dados →</button></div></div>';
    $('sec-visao').innerHTML = kpis + cartoes + blocoPrio + blocoQual;
  }

  // ── EVOLUÇÃO SEMANAL ─────────────────────────────────────────────────────────
  function deltaHtml(atual, anterior, semanaAnt, bomSeDesce) {
    if (anterior == null || atual == null) return '';
    var d = atual - anterior;
    if (d === 0) return '<span class="delta igual">= igual à semana de ' + dataSemana(semanaAnt) + '</span>';
    var bom = bomSeDesce === null ? null : (bomSeDesce ? d < 0 : d > 0);
    return '<span class="delta ' + (bom === null ? 'neutro' : bom ? 'bom' : 'ruim') + '">' + (d < 0 ? '▼ ' : '▲ ') + num(Math.abs(d)) + ' desde ' + dataSemana(semanaAnt) + '</span>';
  }
  function graficoLinha(pontos, fmt) {
    if (!pontos.length) return '';
    var W = 440, H = 160, pl = 54, pr = 14, pt = 12, pb = 26;
    var ys = pontos.map(function (p) { return p.y; }), min = Math.min.apply(null, ys), max = Math.max.apply(null, ys);
    if (min === max) { min = Math.max(0, min - 1); max = max + 1; } else { var pad = (max - min) * 0.2; min = Math.max(0, min - pad); max += pad; }
    var X = function (i) { return pl + (pontos.length === 1 ? (W - pl - pr) / 2 : i * (W - pl - pr) / (pontos.length - 1)); };
    var Y = function (v) { return pt + (H - pt - pb) * (1 - (v - min) / (max - min)); };
    var linha = pontos.map(function (p, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.y).toFixed(1); }).join(' ');
    var area = pontos.length > 1 ? linha + ' L' + X(pontos.length - 1).toFixed(1) + ' ' + (H - pb) + ' L' + X(0).toFixed(1) + ' ' + (H - pb) + ' Z' : '';
    var pts = pontos.map(function (p, i) { return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="' + (i === pontos.length - 1 ? 4.5 : 3) + '" class="gl-pt"><title>' + esc(p.x + ': ' + fmt(p.y)) + '</title></circle>'; }).join('');
    var ult = pontos[pontos.length - 1];
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="gl" role="img" aria-label="Gráfico de evolução semanal">' +
      '<line x1="' + pl + '" y1="' + Y(min) + '" x2="' + (W - pr) + '" y2="' + Y(min) + '" class="gl-eixo"/><line x1="' + pl + '" y1="' + Y(max) + '" x2="' + (W - pr) + '" y2="' + Y(max) + '" class="gl-grade"/>' +
      '<text x="' + (pl - 6) + '" y="' + (Y(max) + 4) + '" text-anchor="end" class="gl-txt">' + esc(fmt(max)) + '</text><text x="' + (pl - 6) + '" y="' + (Y(min) + 4) + '" text-anchor="end" class="gl-txt">' + esc(fmt(min)) + '</text>' +
      (area ? '<path d="' + area + '" class="gl-area"/>' : '') + (pontos.length > 1 ? '<path d="' + linha + '" class="gl-linha"/>' : '') + pts +
      '<text x="' + X(pontos.length - 1).toFixed(1) + '" y="' + (Y(ult.y) - 9).toFixed(1) + '" text-anchor="' + (pontos.length > 1 ? 'end' : 'middle') + '" class="gl-val">' + esc(fmt(ult.y)) + '</text>' +
      '<text x="' + X(0).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (pontos.length > 1 ? 'start' : 'middle') + '" class="gl-txt">' + esc(pontos[0].x) + '</text>' +
      (pontos.length > 1 ? '<text x="' + X(pontos.length - 1).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="end" class="gl-txt">' + esc(ult.x) + '</text>' : '') + '</svg>';
  }
  function desenharEvolucao() {
    var h = estado.historico || [], alvo = $('sec-evolucao');
    if (!h.length) { alvo.innerHTML = '<div class="card"><div class="vazio">Ainda não há retrato semanal. O primeiro é gravado na próxima verificação diária.</div></div>'; return; }
    var ult = h[h.length - 1], ant = h.length > 1 ? h[h.length - 2] : null, sa = ant ? ant.semana : null;
    var kp = function (cor, rot, val, delta, sub) {
      return '<div class="gp-kpi"><div class="gp-kpi-bar" style="background:' + cor + '"></div><div class="gp-kpi-label">' + rot + '</div><div class="gp-kpi-value" style="color:' + cor + '">' + val + '</div><div class="gp-kpi-sub">' + delta + (delta ? '<br>' : '') + sub + '</div></div>';
    };
    var cards = '<div class="gp-kpi-row">' +
      kp('#dc2626', 'Vencidos', num(ult.vencidos), ant ? deltaHtml(ult.vencidos, ant.vencidos, sa, true) : '', 'documentos') +
      kp('#d97706', 'Vencendo', num(ult.vencendo), ant ? deltaHtml(ult.vencendo, ant.vencendo, sa, true) : '', 'documentos') +
      kp('#2563eb', 'Solicitação', num(ult.solicitacao), ant ? deltaHtml(ult.solicitacao, ant.solicitacao, sa, null) : '', 'renovações em andamento') +
      kp('#10b981', 'Em dia', num(ult.em_dia), ant ? deltaHtml(ult.em_dia, ant.em_dia, sa, false) : '', 'documentos') +
      kp('#9ca3af', 'Sem data', num(ult.sem_data), ant ? deltaHtml(ult.sem_data, ant.sem_data, sa, true) : '', 'documentos') +
      '</div>';
    var serie = function (campo) { return h.map(function (s) { return { x: dataSemana(s.semana), y: Number(s[campo]) || 0 }; }); };
    var n0 = function (v) { return num(Math.round(v)); };
    var graf = function (titulo, campo) { return '<div class="card gl-card"><div class="card-title">' + esc(titulo) + '</div>' + graficoLinha(serie(campo), n0) + '</div>'; };
    var graficos = '<div class="gl-grid">' + graf('Vencidos', 'vencidos') + graf('Vencendo', 'vencendo') + graf('Solicitação em andamento', 'solicitacao') + graf('Em dia', 'em_dia') + '</div>';
    var linhas = h.slice().reverse().map(function (s) {
      return '<tr><td><b>' + data(s.semana) + '</b><div class="sub">lido em ' + esc(data(String(s.atualizado_em).slice(0, 10))) + '</div></td><td class="c">' + num(s.clientes) + '</td>' +
        '<td class="c">' + num(s.vencidos) + '</td><td class="c">' + num(s.vencendo) + '</td><td class="c">' + num(s.solicitacao) + '</td><td class="c">' + num(s.em_dia) + '</td><td class="c">' + num(s.sem_data) + '</td></tr>';
    }).join('');
    var pt = ult.por_tipo || {};
    var linhasTipo = TIPOS.filter(function (t) { return pt[t]; }).map(function (t) {
      var c = pt[t];
      return '<tr><td><b>' + esc(ROT_TIPO[t]) + '</b></td><td class="c">' + num(c.total) + '</td><td class="c">' + num(c.vencido) + '</td><td class="c">' + num(c.vencendo) + '</td><td class="c">' + num(c.solicitacao) + '</td><td class="c">' + num(c.ok) + '</td><td class="c">' + num(c.sem_data) + '</td></tr>';
    }).join('');
    alvo.innerHTML =
      '<div class="nota"><strong>Como ler:</strong> um retrato por semana (de segunda a domingo), gravado todos os dias; a última leitura da semana vale. ' +
        (h.length === 1 ? 'O primeiro retrato é da semana de <strong>' + data(h[0].semana) + '</strong>: os gráficos ganham forma a cada nova semana.' : 'Há <strong>' + h.length + '</strong> semana(s) guardada(s), desde ' + data(h[0].semana) + '.') +
        ' Em vencidos, vencendo e sem data, descer é bom; em dia, subir é bom.</div>' +
      cards + graficos +
      '<div class="card"><div class="card-title">Semana a semana</div><div class="card-sub">A semana mais recente primeiro. Contagem de documentos.</div><div class="table-wrap"><table><thead><tr><th>Semana (início)</th><th class="c">Clientes</th><th class="c">Vencidos</th><th class="c">Vencendo</th><th class="c">Solicitação</th><th class="c">Em dia</th><th class="c">Sem data</th></tr></thead><tbody>' + linhas + '</tbody></table></div></div>' +
      (linhasTipo ? '<div class="card"><div class="card-title">Última semana, por documento</div><div class="table-wrap"><table><thead><tr><th>Documento</th><th class="c">Total</th><th class="c">Vencidos</th><th class="c">Vencendo</th><th class="c">Solicitação</th><th class="c">Em dia</th><th class="c">Sem data</th></tr></thead><tbody>' + linhasTipo + '</tbody></table></div></div>' : '');
  }

  // ── FICHA DA EMPRESA ─────────────────────────────────────────────────────────
  function abrirFicha(ix) {
    estado.fichaIx = ix;
    $('ficha').style.display = 'flex';
    desenharFicha(ix);
  }
  function fecharFicha() { $('ficha').style.display = 'none'; estado.fichaIx = null; }
  function desenharFicha(ix) {
    var l = estado.linhas[ix]; if (!l) { fecharFicha(); return; }
    $('ficha-nome').textContent = l.nome_empresa || '—';
    $('ficha-sub').innerHTML = esc(l.cnpj || '') + (l.codigo ? ' · cód. ' + esc(l.codigo) : '') + ' · ' + pillAuto(l);
    var docs = TIPOS.map(function (t) { var i = itemDe(l, t); return i ? { tipo: t, i: i, st: stDe(i) } : null; }).filter(Boolean);
    var blocos = '<div class="blocos">' + docs.map(function (r) {
      return '<div class="bloco"><div class="t">' + esc(ROT_CURTO[r.tipo]) + '</div><div class="v">' + pillSt(r.st) + '</div><div class="d">' + (r.i.vencimento ? data(String(r.i.vencimento).slice(0, 10)) + ' · ' + esc(prazoTxt(r.i)) : 'sem data de vencimento') + '</div></div>';
    }).join('') + '</div>';
    var tab = docs.length ? '<div class="table-wrap"><table><thead><tr><th>Documento</th><th class="c">Situação</th><th class="c">Vencimento</th><th>Nº</th><th>Observações e andamento</th></tr></thead><tbody>' +
      docs.map(function (r) {
        var obs = obsDe({ i: r.i });
        return '<tr><td><b>' + esc(ROT_TIPO[r.tipo]) + '</b></td><td class="c">' + pillSt(r.st) + '</td><td class="c">' + (r.i.vencimento ? data(String(r.i.vencimento).slice(0, 10)) : '—') + '</td>' +
          '<td>' + (r.i.numero ? esc(r.i.numero) : '<span class="cinza">—</span>') + '</td>' +
          '<td style="white-space:normal">' + (r.i.a_conferir ? '<span class="pill" style="color:#b45309;border-color:#b4530955;background:#b4530914">a conferir</span> ' : '') + (obs ? esc(obs) : '<span class="cinza">—</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="linha-item"><span class="x">Esta empresa ainda não tem documentos cadastrados.</span></div>';
    var mun = l.municipio ? esc(l.municipio) + (l.uf ? '/' + esc(l.uf) : '') : 'não informado';
    var cadastro = '<div class="lg-cadastro">' +
      '<div class="bloco"><div class="t">Município</div><div class="v">' + mun + '</div><div class="d">' + (l.prefeitura_integrada === true ? 'a prefeitura é consultada toda noite' : l.prefeitura_integrada === false ? 'cidade sem consulta automática' : 'ainda não conferido') + '</div></div>' +
      '<div class="bloco"><div class="t">Inscrição municipal</div><div class="v">' + (l.inscricao_municipal ? esc(l.inscricao_municipal) : '—') + '</div><div class="d">usada na consulta à prefeitura</div></div>' +
      '</div>';
    var acoes = '';
    if (l.cliente_id) {
      acoes += '<button class="lg-acao" data-acao="municipio" data-ix="' + ix + '">📍 ' + (l.municipio ? 'Corrigir município' : 'Informar município') + '</button>';
      acoes += '<button class="lg-acao" data-acao="im" data-ix="' + ix + '">🏷️ ' + (l.inscricao_municipal ? 'Corrigir inscrição municipal' : 'Informar inscrição municipal') + '</button>';
    }
    if (l.prefeitura_integrada === false && l.prefeitura_url) {
      acoes += '<a class="lg-acao" style="text-decoration:none" href="' + esc(l.prefeitura_url) + '" target="_blank" rel="noopener noreferrer">🔗 Portal da prefeitura</a>';
      if (l.prefeitura_url_sanitario) acoes += '<a class="lg-acao" style="text-decoration:none" href="' + esc(l.prefeitura_url_sanitario) + '" target="_blank" rel="noopener noreferrer">🔗 Portal do sanitário</a>';
    }
    if (l.cliente_id) acoes += '<button class="lg-acao perigo" data-acao="inativar" data-ix="' + ix + '" title="Pede ao administrador para inativar este cliente">🚫 Solicitar inativação</button>';
    if (temBotaoCert(l)) acoes += botaoCert(l);
    $('ficha-corpo').innerHTML =
      (l.sem_cadastro_acessorias ? '<div class="nota">⚠️ Esta empresa está na lista de Legalização, mas <strong>não tem cadastro no Acessórias</strong>.</div>' : '') +
      '<div class="ficha-sec">Situação dos documentos</div>' + blocos + tab +
      '<div class="ficha-sec">Cadastro</div>' + cadastro +
      (acoes ? '<div class="lg-acoes">' + acoes + '</div>' : '');
  }

  // ── AÇÕES DO CADASTRO ────────────────────────────────────────────────────────
  async function editarMunicipio(ix) {
    var l = estado.linhas[ix]; if (!l || !l.cliente_id) return;
    var v = prompt('Município e UF da empresa (ex.: Uberlândia/MG):', l.municipio ? l.municipio + (l.uf ? '/' + l.uf : '') : '');
    if (!v) return;
    var m = /^(.+?)\s*[\/,\-]\s*([A-Za-z]{2})\s*$/.exec(v.trim());
    if (!m) { alert('Use o formato Cidade/UF, por exemplo Uberlândia/MG.'); return; }
    var r = await chamarApi('/api/data/legalizacao/clientes/' + encodeURIComponent(l.cliente_id) + '/municipio', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ municipio: m[1], uf: m[2] }) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { alert(j.error || 'Erro ao salvar o município.'); return; }
    aviso('Município salvo.');
    await carregar();
  }
  async function editarIM(ix) {
    var l = estado.linhas[ix]; if (!l || !l.cliente_id) return;
    var v = prompt('Inscrição municipal desta empresa (deixe vazio para apagar):', l.inscricao_municipal || '');
    if (v === null) return;
    var r = await chamarApi('/api/data/legalizacao/clientes/' + encodeURIComponent(l.cliente_id) + '/inscricao-municipal', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inscricao_municipal: v }) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { alert(j.error || 'Erro ao salvar a inscrição municipal.'); return; }
    aviso('Inscrição municipal salva.');
    await carregar();
  }
  /** O mesmo modal serve para pedir a inativação do cliente e para avisar que o certificado não será renovado. */
  function textosModal(modo) {
    var cert = modo === 'cert';
    $('inat-titulo').textContent = cert ? 'Certificado que o cliente não vai renovar' : 'Solicitar inativação de cliente';
    $('inat-txt').innerHTML = cert ? 'Isso <b>não desativa na hora</b>: avisa o administrador, que confere e desativa o certificado para parar a cobrança.' : 'Isso <b>não desativa o cliente na hora</b>: envia um pedido para o administrador revisar e confirmar.';
    $('inat-obs').placeholder = cert ? 'Ex.: cliente sem movimento, não quer atualizar o certificado digital.' : 'Ex.: cliente encerrou a atividade em 08/2026, CNPJ baixado; sem contato há 3 meses.';
  }
  function abrirSolicitarCert(ix) {
    var l = estado.linhas[ix]; if (!l || !temBotaoCert(l)) return;
    estado.inatModo = 'cert';
    estado.inatCert = { clienteId: l.cliente_id || null, certId: l.cert && l.cert.tipo === 'pf' ? l.cert.id : null };
    textosModal('cert');
    $('inat-empresa').value = l.nome_empresa || '';
    $('inat-obs').value = '';
    $('inat-err').style.display = 'none';
    $('modal-inat').classList.add('aberto');
    $('inat-obs').focus();
  }
  /** Administrador: desativa o certificado direto (sem pedido). */
  async function desativarCert(ix) {
    var l = estado.linhas[ix]; if (!l || !temBotaoCert(l)) return;
    if (!window.confirm('Desativar o certificado de "' + (l.nome_empresa || 'esta empresa') + '"? Ele sai da lista e dos indicadores e deixa de ser cobrado.')) return;
    var url = l.cert.tipo === 'pj' && l.cliente_id ? '/api/data/legalizacao/certificados-cliente/' + encodeURIComponent(l.cliente_id) + '/desativar' : '/api/data/legalizacao/certificados/' + encodeURIComponent(l.cert.id) + '/desativar';
    var r = await chamarApi(url, { method: 'PATCH' });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { alert(j.error || 'Não foi possível desativar o certificado.'); return; }
    aviso('Certificado desativado.');
    await carregar();
  }
  function abrirInativar(ix) {
    var l = estado.linhas[ix]; if (!l || !l.cliente_id) return;
    estado.inatModo = 'cliente'; textosModal('cliente');
    estado.inatId = l.cliente_id;
    $('inat-empresa').value = l.nome_empresa || '';
    $('inat-obs').value = '';
    $('inat-err').style.display = 'none';
    $('modal-inat').classList.add('aberto');
    $('inat-obs').focus();
  }
  function fecharInativar() { $('modal-inat').classList.remove('aberto'); }
  async function enviarInativacao() {
    var obs = $('inat-obs').value.trim(), err = $('inat-err');
    err.style.display = 'none';
    if (!obs) { err.textContent = 'Escreva uma observação explicando o porquê.'; err.style.display = 'block'; return; }
    var btn = $('inat-enviar'); btn.disabled = true;
    try {
      var cert = estado.inatModo === 'cert' && estado.inatCert;
      var r = await chamarApi(cert ? '/api/data/legalizacao/solicitar-desativacao-certificado' : '/api/data/legalizacao/solicitar-inativacao', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cert ? { clienteId: cert.clienteId || undefined, certId: cert.certId || undefined, observacao: obs } : { clienteId: estado.inatId, observacao: obs }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) { err.textContent = j.error || 'Erro ao enviar a solicitação.'; err.style.display = 'block'; return; }
      fecharInativar();
      aviso('Solicitação enviada. O administrador vai revisar e confirmar.');
    } catch (e) { err.textContent = 'Sem conexão com o servidor. Tente de novo.'; err.style.display = 'block'; }
    finally { btn.disabled = false; }
  }

  // ── SININHO (avisos de vencimento; "lida" é por usuário) ─────────────────────
  async function carregarSino() {
    try {
      var r = await chamarApi('/api/data/legalizacao/notificacoes');
      if (!r.ok) return;
      var j = await r.json();
      var badge = $('sino-badge'), n = j.naoLidas || 0;
      badge.hidden = !n; badge.textContent = n > 99 ? '99+' : String(n);
      $('sino-lista').innerHTML = (j.data && j.data.length)
        ? j.data.map(function (x) {
          return '<div class="lg-sino-item' + (x.nova ? ' nova' : '') + '"><span>🔔</span><div><b>' + esc(x.titulo) + '</b>' + esc(x.mensagem) +
            '<div class="lg-sino-quando">' + esc(new Date(x.created_at).toLocaleString('pt-BR')) + '</div></div></div>';
        }).join('')
        : '<div class="lg-sino-vazio">Nenhuma notificação por enquanto.</div>';
    } catch (e) { /* o sino nunca derruba a página */ }
  }
  function abrirSino(v) {
    $('sino-painel').hidden = !v;
    $('btn-sino').setAttribute('aria-expanded', v ? 'true' : 'false');
    if (v) carregarSino();
  }

  // ── EXPORTAÇÃO (CSV e PDF) ───────────────────────────────────────────────────
  // Exporta TODAS as linhas do filtro atual da seção aberta (não só a página).
  function dadosExport(sec) {
    var spec = SPECS[sec];
    if (spec) {
      var f = estado.f[sec], lista = filtrarLinhas(sec);
      var colunas = spec.colunas.filter(function (c) { return !c.acao; });   // colunas de ação não vão para o CSV/PDF
      if (spec.expExtra) colunas = colunas.slice(0, 1).concat(spec.expExtra, colunas.slice(1));
      var filtros = [];
      if (f.busca) filtros.push('Busca: ' + f.busca);
      if (f.tipo) filtros.push('Documento: ' + (ROT_TIPO[f.tipo] || f.tipo));
      if (f.sit) filtros.push('Situação: ' + (ROT_ST[f.sit] || f.sit));
      if (f.auto) filtros.push('Consulta: ' + (ROT_AUTO[f.auto] || f.auto));
      if (f.pend) filtros.push('Pendência: ' + (ROT_PEND[f.pend] || f.pend));
      return {
        arquivo: spec.arquivo, titulo: spec.titulo, filtros: filtros,
        colunas: colunas.map(function (c) { return c.t; }),
        linhas: lista.map(function (r) { return colunas.map(function (c) { return c.x(r); }); }),
        orientacao: 'landscape', fonte: colunas.length > 6 ? 7 : 8,
      };
    }
    if (sec === 'visao') {
      return {
        arquivo: 'legalizacao-resumo', titulo: 'Legalização — Resumo por documento', filtros: [],
        colunas: ['Documento', 'Total', 'Vencido', 'Vencendo', 'Solicitação', 'Em dia', 'Sem data'],
        linhas: TIPOS.map(function (t) { var c = contagem(t); return [ROT_TIPO[t], c.total, c.vencido, c.vencendo, c.solicitacao, c.ok, c.sem_data]; }),
        orientacao: 'portrait',
      };
    }
    if (sec === 'evolucao') {
      var h = (estado.historico || []).slice().reverse();
      return {
        arquivo: 'legalizacao-evolucao', titulo: 'Legalização — Evolução semanal', filtros: ['Contagem de documentos por semana (segunda a domingo)'],
        colunas: ['Semana (início)', 'Clientes', 'Vencidos', 'Vencendo', 'Solicitação', 'Em dia', 'Sem data'],
        linhas: h.map(function (s) { return [data(s.semana), s.clientes, s.vencidos, s.vencendo, s.solicitacao, s.em_dia, s.sem_data]; }),
        orientacao: 'portrait',
      };
    }
    return null;
  }
  function exportar(formato) {
    var e = dadosExport(estado.secao);
    if (!e || !e.linhas.length) { alert('Não há dados para exportar nesta seção.'); return; }
    var u = null; try { u = JSON.parse(ls(K_USER) || 'null'); } catch (x) { u = null; }
    var sub = (e.filtros || []).filter(Boolean).concat(u && u.name ? ['Gerado por ' + u.name] : []);
    try {
      if (formato === 'csv') { window.Exportar.csv(e.arquivo, e.colunas, e.linhas); return; }
      var btn = $('btn-pdf'), rot = btn.textContent; btn.disabled = true; btn.textContent = 'Gerando PDF…';
      window.Exportar.pdf({ arquivo: e.arquivo, titulo: e.titulo, subtitulo: sub, colunas: e.colunas, linhas: e.linhas, orientacao: e.orientacao || 'landscape', fonte: e.fonte, paginaDe: 'Legalização' })
        .catch(function (err) { alert(err.message || 'Não foi possível gerar o PDF.'); })
        .then(function () { btn.disabled = false; btn.textContent = rot; });
    } catch (err) { alert(err.message || 'Não foi possível exportar.'); }
  }

  // ── eventos ──────────────────────────────────────────────────────────────────
  document.addEventListener('click', function (ev) {
    var alvo = ev.target;
    if (!$('sino-painel').hidden && !(alvo.closest && alvo.closest('.lg-sino-wrap'))) abrirSino(false);   // clicou fora do sino: fecha o painel
    var f = alvo.closest && alvo.closest('[data-ficha]');
    if (f) { abrirFicha(parseInt(f.getAttribute('data-ficha'), 10)); return; }
    var ir = alvo.closest && alvo.closest('[data-ir]');
    if (ir) {
      var tipo = ir.getAttribute('data-tipo'), sec = ir.getAttribute('data-ir');
      if (tipo && (sec === 'certificados' || sec === 'procuracoes')) { estado.f[sec].tipo = tipo; estado.f[sec].pag = 1; desenharLista(sec); }
      irPara(sec); return;
    }
    var pe = alvo.closest && alvo.closest('[data-pend]');
    if (pe) { estado.f.qualidade.pend = estado.f.qualidade.pend === pe.getAttribute('data-pend') ? '' : pe.getAttribute('data-pend'); estado.f.qualidade.pag = 1; desenharLista('qualidade'); return; }
    var ac = alvo.closest && alvo.closest('[data-acao]');
    if (ac) {
      var ix = parseInt(ac.getAttribute('data-ix'), 10), a = ac.getAttribute('data-acao');
      if (a === 'municipio') editarMunicipio(ix); else if (a === 'im') editarIM(ix); else if (a === 'inativar') abrirInativar(ix); else if (a === 'cert-sol') abrirSolicitarCert(ix); else if (a === 'cert-desat') desativarCert(ix);
      return;
    }
    var p = alvo.closest && alvo.closest('[data-pag]');
    if (p) {
      var chave = p.getAttribute('data-chave'); estado.f[chave].pag = parseInt(p.getAttribute('data-pag'), 10) || 1;
      desenharLista(chave);
      var topo = document.querySelector('.gp-section.ativa .filter-group'); if (topo && topo.scrollIntoView) topo.scrollIntoView({ block: 'start' });
      return;
    }
  });
  $('btn-sino').addEventListener('click', function (ev) { ev.stopPropagation(); abrirSino($('sino-painel').hidden); });
  $('btn-sino-lidas').addEventListener('click', async function () {
    await chamarApi('/api/data/legalizacao/notificacoes/lidas', { method: 'POST' });
    await carregarSino();
  });
  $('login-form').addEventListener('submit', entrar);
  $('btn-atualizar').addEventListener('click', function () { carregar(); });
  $('btn-csv').addEventListener('click', function () { exportar('csv'); });
  $('btn-pdf').addEventListener('click', function () { exportar('pdf'); });
  $('ficha-fechar').addEventListener('click', fecharFicha);
  $('ficha').addEventListener('click', function (ev) { if (ev.target === $('ficha')) fecharFicha(); });
  $('inat-fechar').addEventListener('click', fecharInativar);
  $('inat-cancelar').addEventListener('click', fecharInativar);
  $('inat-enviar').addEventListener('click', enviarInativacao);
  $('modal-inat').addEventListener('click', function (ev) { if (ev.target === $('modal-inat')) fecharInativar(); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if ($('modal-inat').classList.contains('aberto')) fecharInativar(); else { fecharFicha(); abrirSino(false); }
  });
  Array.prototype.forEach.call(document.querySelectorAll('.gp-nav-item'), function (b) { b.addEventListener('click', function () { irPara(b.getAttribute('data-sec')); }); });

  if (ls(K_TOKEN)) iniciar(); else mostrarLogin('');
})();
