'use strict';
/**
 * Sinais de e-mail por cliente (piloto do Sucesso do Cliente) — funções PURAS, testadas em testes_email_sinais.js.
 *
 * Só METADADOS entram aqui: remetente, destinatários, data, marcas de mensagem automática, rótulos, tipo e tamanho.
 * Assunto e corpo NUNCA são lidos nem guardados. O que sai daqui para o sistema são só contagens por cliente.
 *
 * Unidade de análise: o CONTATO do cliente (endereço de e-mail), olhando todas as caixas do domínio juntas.
 * Um contato "aguarda resposta" quando a última mensagem humana dele é mais nova do que qualquer mensagem do
 * escritório endereçada a ele, em qualquer caixa. Assim, o mesmo e-mail copiado para várias pessoas conta uma vez,
 * e a resposta de um colega encerra a espera para todos.
 */

const LIVRES = new Set(['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.com.br', 'icloud.com', 'uol.com.br', 'bol.com.br',
  'live.com', 'terra.com.br', 'msn.com', 'globo.com', 'ig.com.br', 'oi.com.br', 'r7.com', 'zipmail.com.br']);
const AUTO_REMETENTE = /(^|[._-])(no-?reply|noreply|do-?not-?reply|nao-?responda|naoresponda|mailer-daemon|postmaster|notifica\w*|notification\w*|newsletter|news|marketing|alerta\w*|alert\w*|aviso\w*|boletos?|cobranca|faturamento|sac|suporte|atendimento|contato|comunicado\w*|robo|bot|system|sistema)([._-]|@)/i;
/** Mensagem curta de quem acabou de ser respondido: costuma ser "obrigado", "ok", "recebido". Heurística pelo tamanho. */
const LIMITE_CURTA = 12000;
/** Cópias da mesma mensagem em caixas diferentes chegam com horas de entrega quase iguais. */
const JANELA_COPIA_MS = 10 * 60 * 1000;

const enderecos = (s) => (String(s || '').toLowerCase().match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []);
const dominio = (e) => String(e || '').split('@')[1] || '';

/** domínio corporativo (não e-mail livre, não interno) -> Set de CNPJs, a partir do mapa e-mail -> CNPJs dos contatos do Acessórias. */
function dominiosDeCliente(mapaEmails, internos) {
  const out = {};
  Object.keys(mapaEmails || {}).forEach((e) => {
    const d = dominio(e);
    if (!d || LIVRES.has(d) || internos.has(d)) return;
    (mapaEmails[e] || []).forEach((c) => { (out[d] = out[d] || new Set()).add(c); });
  });
  return out;
}

/** Normaliza uma mensagem a partir dos cabeçalhos (nomes em minúsculas) e dos metadados do Gmail. */
function normalizarMensagem(h, meta, internos) {
  const de = enderecos(h.from)[0] || '';
  const interno = internos.has(dominio(de));
  const rotulos = meta.rotulos || [];
  const auto = !interno && (!!h['list-unsubscribe'] || /bulk|list|junk/i.test(h.precedence || '')
    || (!!h['auto-submitted'] && !/^no$/i.test(h['auto-submitted'])) || AUTO_REMETENTE.test(de)
    || rotulos.some((l) => /CATEGORY_(PROMOTIONS|UPDATES|FORUMS|SOCIAL)/.test(l)));
  return {
    caixa: meta.caixa || '', thread: meta.thread, t: Number(meta.t), de, interno, auto,
    tamanho: Number(meta.tamanho) || 0, anexo: /multipart\/mixed/i.test(meta.tipo || ''),
    para: enderecos((h.to || '') + ' ' + (h.cc || '')),
  };
}

/**
 * APRENDIZADO de contatos: um endereço que ainda não está nos contatos do Acessórias (e-mail pessoal do sócio, outro
 * funcionário, o contador da empresa) é associado à empresa quando aparece NA MESMA CONVERSA de contatos já cadastrados
 * de uma única empresa. Só olha quem participa da conversa (De/Para/Cc); assunto e texto nunca são lidos.
 *
 *  - uma empresa só nas conversas  -> aprende ('alta')
 *  - várias, e uma domina (≥2 conversas e ≥ o dobro da segunda) -> aprende ('media')
 *  - várias sem dominante -> ambíguo, não aprende
 * Contato já cadastrado, interno ou automático nunca é aprendido.
 */
function aprenderContatos(msgs, ctx) {
  const mapa = ctx.mapaEmails || {};
  const internos = ctx.internos || new Set();
  const porConversa = {};
  (msgs || []).forEach((m) => { const k = m.caixa + '|' + m.thread; (porConversa[k] = porConversa[k] || []).push(m); });
  const evidencia = {};   // endereço -> { cnpj -> nº de conversas }
  Object.keys(porConversa).forEach((k) => {
    const participantes = new Set();
    porConversa[k].forEach((m) => { [m.de].concat(m.para || []).forEach((a) => { if (a && !internos.has(dominio(a))) participantes.add(a); }); });
    const empresas = new Set();
    participantes.forEach((a) => { const c = mapa[a]; if (c && c.length === 1) empresas.add(c[0]); });
    if (!empresas.size) return;
    participantes.forEach((a) => {
      if (mapa[a] || AUTO_REMETENTE.test(a)) return;
      empresas.forEach((c) => { (evidencia[a] = evidencia[a] || {})[c] = ((evidencia[a] || {})[c] || 0) + 1; });
    });
  });
  const aprendidos = {}; let ambiguos = 0;
  Object.keys(evidencia).forEach((a) => {
    const lista = Object.entries(evidencia[a]).sort((x, y) => y[1] - x[1]);
    if (lista.length === 1) { aprendidos[a] = { cnpj: lista[0][0], conversas: lista[0][1], confianca: 'alta' }; return; }
    if (lista[0][1] >= 2 && lista[0][1] >= 2 * lista[1][1]) { aprendidos[a] = { cnpj: lista[0][0], conversas: lista[0][1], confianca: 'media' }; return; }
    ambiguos++;
  });
  return { aprendidos, ambiguos };
}

/** Junta o que já se sabia com o aprendizado de hoje. Devolve { base, trocas }: trocas = endereços que mudaram de empresa. */
function mesclarAprendidos(antigos, novos, hojeIso) {
  const base = {}; const trocas = [];
  Object.keys(antigos || {}).forEach((a) => { base[a] = antigos[a]; });
  Object.keys(novos || {}).forEach((a) => {
    const n = novos[a]; const v = base[a];
    if (!v) { base[a] = { cnpj: n.cnpj, conversas: n.conversas, confianca: n.confianca, desde: hojeIso, atualizado: hojeIso }; return; }
    if (v.cnpj === n.cnpj) { base[a] = Object.assign({}, v, { conversas: Math.max(v.conversas, n.conversas), atualizado: hojeIso, confianca: n.confianca === 'alta' ? 'alta' : v.confianca }); return; }
    if (n.conversas > v.conversas) { trocas.push(a); base[a] = { cnpj: n.cnpj, conversas: n.conversas, confianca: n.confianca, desde: hojeIso, atualizado: hojeIso, anterior: v.cnpj }; }
  });
  return { base, trocas };
}

/** Mapa efetivo = contatos do Acessórias + aprendidos (o do Acessórias sempre vence). */
function mapaComAprendidos(mapaEmails, aprendidos) {
  const out = Object.assign({}, mapaEmails);
  Object.keys(aprendidos || {}).forEach((a) => { if (!out[a]) out[a] = [aprendidos[a].cnpj]; });
  return out;
}

/** Linhas de ignorar_dominios.txt: "dominio.com" casa exato (e subdomínios); ".gov.br" casa qualquer final. Comentário com #. */
function lerIgnorados(texto) {
  return String(texto || '').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean);
}
function dominioIgnorado(dom, regras, dominiosCliente) {
  if (!dom || (dominiosCliente && dominiosCliente[dom])) return false;   // domínio de cliente nunca é ignorado
  return (regras || []).some((r) => (r[0] === '.' ? dom.endsWith(r) : dom === r || dom.endsWith('.' + r)));
}

/**
 * Uma entrada por contato externo (humano) que escreveu na janela.
 * `aguardando`: nenhuma mensagem do escritório para ele depois da última dele, em nenhuma caixa.
 */
function sinaisPorContato(msgs, ctx) {
  const agora = ctx.agora || Date.now();
  const dominios = ctx.dominiosCliente || {};
  const mapa = ctx.mapaEmails || {};
  const internas = (msgs || []).filter((m) => m.interno);
  // endereço -> horários em que o escritório escreveu para ele
  const enviosPara = {};
  internas.forEach((m) => m.para.forEach((a) => { (enviosPara[a] = enviosPara[a] || []).push(m.t); }));
  const porContato = {};
  const ignorar = ctx.ignorarDominios || [];
  (msgs || []).forEach((m) => { if (!m.interno && !m.auto && m.de && !dominioIgnorado(dominio(m.de), ignorar, dominios)) (porContato[m.de] = porContato[m.de] || []).push(m); });
  const out = [];
  Object.keys(porContato).forEach((de) => {
    const arr = porContato[de].slice().sort((a, b) => a.t - b.t);
    const ultima = arr[arr.length - 1];
    const envios = enviosPara[de] || [];
    const respondeuDepois = envios.some((t) => t > ultima.t);
    const jaRespondemosAntes = envios.some((t) => t < ultima.t);
    const cnpjs = new Set(); let porDominio = false;
    (mapa[de] || []).forEach((c) => cnpjs.add(c));
    if (!cnpjs.size && dominios[dominio(de)]) { dominios[dominio(de)].forEach((c) => cnpjs.add(c)); porDominio = true; }
    const caixas = Array.from(new Set(arr.filter((m) => ultima.t - m.t <= JANELA_COPIA_MS).map((m) => m.caixa).filter(Boolean)));
    // mensagens recebidas deduplicadas: cópias em várias caixas (mesmo remetente, horas quase iguais) contam uma vez
    let recebidas = 0, anterior = null;
    arr.forEach((m) => { if (anterior == null || m.t - anterior > JANELA_COPIA_MS) recebidas++; anterior = m.t; });
    out.push({
      cnpjs: Array.from(cnpjs), porDominio, aprendido: !!(ctx.aprendidos && ctx.aprendidos[de]), aguardando: !respondeuDepois,
      horas: Math.max(0, (agora - ultima.t) / 3600000), recebidas, caixas,
      provavelEncerramento: jaRespondemosAntes && ultima.tamanho > 0 && ultima.tamanho <= LIMITE_CURTA && !ultima.anexo,
      tamanhoUltima: ultima.tamanho, respondidoAntes: jaRespondemosAntes,
      ultimaT: ultima.t, dominioContato: dominio(de),
    });
  });
  return out;
}

/**
 * Contagens por cliente (e totais). Nenhum endereço, assunto ou texto passa por aqui.
 *
 * - Um contato ligado a UMA empresa entra nas faixas de espera dela (aguardando_4h, _24h, _48h, _7d).
 * - Um contato ligado a VÁRIAS empresas (sócio, contador do grupo) é UM pedido só: entra em `aguardando_compartilhado`
 *   de cada empresa e uma vez nos totais, para não parecer que há dezenas de clientes esperando.
 * - `resolvidoZappy` (preenchido por quem chama, depois de cruzar com o Zappy): o escritório já falou com o cliente
 *   depois do e-mail, então não conta como espera.
 */
function consolidar(contatos, nomes, minHoras) {
  const corte = minHoras == null ? 4 : minHoras;
  const por = {};
  const tot = {
    contatos: 0, identificados: 0, nao_identificados: 0, aguardando: 0, aguardando_exclusivos: 0, aguardando_compartilhados: 0,
    aguardando_nao_identificados: 0, provaveis_encerramentos: 0, resolvidos_zappy: 0,
  };
  contatos.forEach((s) => {
    tot.contatos++;
    const aguarda = s.aguardando && s.horas >= corte;
    if (!s.cnpjs.length) {
      tot.nao_identificados++;
      if (aguarda && !s.provavelEncerramento) tot.aguardando_nao_identificados++;
      return;
    }
    tot.identificados++;
    const compartilhado = s.cnpjs.length > 1;
    const resolvido = aguarda && !!s.resolvidoZappy;
    const encerra = aguarda && !resolvido && s.provavelEncerramento;
    const espera = aguarda && !resolvido && !encerra;
    if (resolvido) tot.resolvidos_zappy++;
    else if (encerra) tot.provaveis_encerramentos++;
    else if (espera) { tot.aguardando++; if (compartilhado) tot.aguardando_compartilhados++; else tot.aguardando_exclusivos++; }
    s.cnpjs.forEach((c) => {
      const r = (por[c] = por[c] || {
        cnpj: c, nome: (nomes && nomes[c]) || null, contatos_ativos: 0, mensagens_recebidas: 0,
        aguardando_4h: 0, aguardando_24h: 0, aguardando_48h: 0, aguardando_7d: 0, aguardando_compartilhado: 0, mais_antigo_h: 0,
        provaveis_encerramentos: 0, resolvidos_zappy: 0, caixas: [],
      });
      r.contatos_ativos++;
      r.mensagens_recebidas += s.recebidas;
      if (resolvido) { r.resolvidos_zappy++; return; }
      if (encerra) { r.provaveis_encerramentos++; return; }
      if (!espera) return;
      if (compartilhado) r.aguardando_compartilhado++;
      else {
        r.aguardando_4h++;
        if (s.horas >= 24) r.aguardando_24h++;
        if (s.horas >= 48) r.aguardando_48h++;
        if (s.horas >= 168) r.aguardando_7d++;
      }
      r.mais_antigo_h = Math.max(r.mais_antigo_h, Math.round(s.horas));
      s.caixas.forEach((cx) => { if (r.caixas.indexOf(cx) < 0) r.caixas.push(cx); });
    });
  });
  const clientes = Object.values(por).sort((a, b) =>
    (b.aguardando_4h + b.aguardando_compartilhado) - (a.aguardando_4h + a.aguardando_compartilhado) || b.mais_antigo_h - a.mais_antigo_h || b.contatos_ativos - a.contatos_ativos);
  return { totais: tot, clientes };
}

/**
 * Quem escreveu e NÃO se liga a nenhum cliente, agrupado por domínio (sem endereço pessoal) para a liderança decidir
 * o que é fornecedor, lead ou cliente com cadastro incompleto. E-mail pessoal (gmail etc.) vira uma linha só.
 */
function naoIdentificados(contatos, minHoras) {
  const corte = minHoras == null ? 4 : minHoras;
  const por = {};
  contatos.filter((s) => !s.cnpjs.length).forEach((s) => {
    const livre = LIVRES.has(s.dominioContato);
    const chave = livre ? '(e-mail pessoal)' : (s.dominioContato || '(sem domínio)');
    const r = (por[chave] = por[chave] || { dominio: chave, pessoal: livre, contatos: 0, aguardando: 0, mais_antigo_h: 0, caixas: [] });
    r.contatos++;
    if (s.aguardando && s.horas >= corte && !s.provavelEncerramento) {
      r.aguardando++;
      r.mais_antigo_h = Math.max(r.mais_antigo_h, Math.round(s.horas));
      s.caixas.forEach((cx) => { if (r.caixas.indexOf(cx) < 0) r.caixas.push(cx); });
    }
  });
  return Object.values(por).sort((a, b) => b.aguardando - a.aguardando || b.contatos - a.contatos);
}

/**
 * HISTÓRICO de e-mails por cliente em janela longa (módulo Atendimento): para cada contato externo, quantos e-mails ele mandou
 * (cópias em várias caixas viram um só), quais ficaram SEM resposta e por qual endereço INTERNO (Para/Cc) cada um entrou.
 *
 * Um e-mail está sem resposta quando o escritório não escreveu para aquele contato depois dele, em NENHUMA caixa: a resposta de
 * um colega, ou de outro endereço do mesmo grupo (dptofiscal@, cs@ etc.), encerra a espera. Ficam de fora: e-mail com menos de
 * 4 h e o último e-mail curto, sem anexo, de quem já tinha recebido resposta (provável "obrigado").
 *
 * Só contatos LIGADOS a empresa entram. Nenhum endereço do cliente sai daqui; os endereços internos devem ser trocados por nomes
 * por quem chama.
 */
function atendimentoPorContato(msgs, ctx) {
  const agora = ctx.agora || Date.now();
  const corte = (ctx.minHoras == null ? 4 : ctx.minHoras) * 3600000;
  const dominios = ctx.dominiosCliente || {}, mapa = ctx.mapaEmails || {}, internos = ctx.internos || new Set(), ignorar = ctx.ignorarDominios || [];
  const enviosPara = {};
  (msgs || []).forEach((m) => { if (m.interno) (m.para || []).forEach((a) => { (enviosPara[a] = enviosPara[a] || []).push(m.t); }); });
  const porContato = {};
  (msgs || []).forEach((m) => { if (!m.interno && !m.auto && m.de && !dominioIgnorado(dominio(m.de), ignorar, dominios)) (porContato[m.de] = porContato[m.de] || []).push(m); });
  const out = [];
  Object.keys(porContato).forEach((de) => {
    const cnpjs = new Set();
    (mapa[de] || []).forEach((c) => cnpjs.add(c));
    if (!cnpjs.size && dominios[dominio(de)]) dominios[dominio(de)].forEach((c) => cnpjs.add(c));
    if (!cnpjs.size) return;
    const arr = porContato[de].slice().sort((a, b) => a.t - b.t);
    const emails = [];
    arr.forEach((m) => {
      const dest = (m.para || []).filter((a) => internos.has(dominio(a)));
      const ult = emails[emails.length - 1];
      if (ult && m.t - ult.t <= JANELA_COPIA_MS) { ult.t = m.t; ult.tamanho = m.tamanho; ult.anexo = m.anexo; dest.forEach((a) => ult.dest.add(a)); }
      else emails.push({ t: m.t, dest: new Set(dest), tamanho: m.tamanho, anexo: m.anexo });
    });
    const envios = enviosPara[de] || [];
    let ultimoEnvio = -Infinity; envios.forEach((t) => { if (t > ultimoEnvio) ultimoEnvio = t; });
    const ultimo = emails[emails.length - 1];
    const jaRespondemosAntes = envios.some((t) => t < ultimo.t);
    const encerra = jaRespondemosAntes && ultimo.tamanho > 0 && ultimo.tamanho <= LIMITE_CURTA && !ultimo.anexo;
    const sem = emails.filter((e) => e.t > ultimoEnvio && agora - e.t >= corte && !(encerra && e === ultimo));
    const porDest = {};
    emails.forEach((e) => {
      const abre = sem.indexOf(e) >= 0;
      e.dest.forEach((a) => { const r = (porDest[a] = porDest[a] || { recebidos: 0, sem: 0 }); r.recebidos++; if (abre) r.sem++; });
    });
    out.push({ cnpjs: Array.from(cnpjs), recebidos: emails.length, semResposta: sem.length, porDest,
      aguardando: sem.indexOf(ultimo) >= 0, horas: Math.max(0, (agora - ultimo.t) / 3600000), ultimaT: ultimo.t });
  });
  return out;
}

/**
 * Soma por cliente (CNPJ): { cnpj, recebidos, sem_resposta, destinatarios: { endereco: { recebidos, sem } }, compartilhados_recebidos, compartilhados_sem }.
 * Só contatos ligados a UMA empresa entram nos totais e nos destinatários. Contato ligado a várias empresas (sócio, contador, familiar)
 * não permite saber de qual empresa é o e-mail: vai para os campos compartilhados_*, para não inflar a conta de cada uma.
 */
function consolidarAtendimento(contatos) {
  const por = {};
  (contatos || []).forEach((s) => {
    s.cnpjs.forEach((c) => {
      const r = (por[c] = por[c] || { cnpj: c, recebidos: 0, sem_resposta: 0, destinatarios: {}, compartilhados_recebidos: 0, compartilhados_sem: 0 });
      const resolvido = !!s.resolvidoZappy;          // o escritório já falou com o cliente pelo Zappy depois do e-mail
      if (s.cnpjs.length > 1) { r.compartilhados_recebidos += s.recebidos; if (!resolvido) r.compartilhados_sem += s.semResposta; return; }
      r.recebidos += s.recebidos;
      if (!resolvido) r.sem_resposta += s.semResposta;
      Object.keys(s.porDest).forEach((a) => {
        const d = (r.destinatarios[a] = r.destinatarios[a] || { recebidos: 0, sem: 0 });
        d.recebidos += s.porDest[a].recebidos;
        if (!resolvido) d.sem += s.porDest[a].sem;
      });
    });
  });
  return Object.values(por);
}

module.exports = { enderecos, dominio, dominiosDeCliente, normalizarMensagem, sinaisPorContato, consolidar, naoIdentificados, atendimentoPorContato, consolidarAtendimento, aprenderContatos, mesclarAprendidos, mapaComAprendidos, lerIgnorados, dominioIgnorado, LIVRES, LIMITE_CURTA, JANELA_COPIA_MS };
