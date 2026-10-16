'use strict';
/**
 * Piloto de sinais de e-mail do Sucesso do Cliente — job LOCAL (roda na máquina do Reysner, não no Render).
 *
 *   node server/emailSinais/coletar.js [--dias=14] [--saida=arquivo.json] [--caixas=regex]
 *
 * O que faz: lê só CABEÇALHOS (De, Para, Cc, Data, marcas de automático, rótulos, tamanho) das caixas do domínio, liga cada
 * conversa a um cliente pelos contatos do Acessórias e conta, por cliente, quantas conversas estão esperando resposta.
 * Nunca lê assunto nem corpo e nunca guarda endereço de e-mail: o resultado são só contagens por cliente.
 *
 * Por enquanto é PRÉVIA: grava o resultado em um arquivo local e imprime um resumo. Não envia nada ao sistema.
 * A chave da conta de serviço do Gmail fica só nesta máquina (GMAIL_CHAVE_JSON; padrão em C:\Users\Grupo e\Segredos).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const calc = require('./calculo');

const RAIZ = path.join(__dirname, '..', '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, 'server', 'legalizacao', '.env') });

const CHAVE = process.env.GMAIL_CHAVE_JSON || 'C:/Users/Grupo e/Segredos/grupo-e-laudos-atendimento-1a37a6e0a420.json';
const ADMIN = process.env.GMAIL_ADMIN || 'reysner@escritorial.com.br';
const CACHE_MAPA = process.env.EMAIL_MAPA_CACHE || path.join(os.tmpdir(), 'mapa_emails_clientes.json');
const CACHE_MAX_DIAS = 7;
// Aprendizado: endereços que o sistema associou a uma empresa (ficam SÓ nesta máquina; o sistema recebe só contagens).
const ARQ_APRENDIDOS = process.env.EMAIL_APRENDIDOS || path.join(__dirname, 'aprendidos.json');
const ARQ_IGNORAR = path.join(__dirname, 'ignorar_dominios.txt');
const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a); return m ? [m[1], m[2]] : [a, '']; }));
const DIAS = Math.max(1, parseInt(argv.dias, 10) || 14);            // janela dos "pedidos esperando resposta" (bloco Hoje)
const HISTORICO = Math.max(DIAS, parseInt(argv.historico, 10) || 180);   // janela do histórico por destinatário (módulo Atendimento)
const LEITURA_DIAS = HISTORICO;                                      // o que se lê das caixas: cobre as duas

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
let chave = null;

async function token(sub, escopo) {
  if (!chave) chave = JSON.parse(fs.readFileSync(CHAVE, 'utf8'));
  const agora = Math.floor(Date.now() / 1000);
  const cab = b64({ alg: 'RS256', typ: 'JWT' });
  const corpo = b64({ iss: chave.client_email, sub, scope: escopo, aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3000 });
  const assinatura = crypto.createSign('RSA-SHA256').update(`${cab}.${corpo}`).sign(chave.private_key, 'base64url');
  let r = null;
  for (let i = 0; i < 5 && !r; i++) {
    try {
      r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cab}.${corpo}.${assinatura}` }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) { await esperar(2000 * (i + 1)); }
  }
  if (!r) throw new Error(`token ${sub}: sem conexão com o Google`);
  const j = await r.json();
  if (!r.ok) throw new Error(`token ${sub}: ${j.error} ${j.error_description || ''}`);
  return j.access_token;
}
async function api(url, tk, tentativas) {
  const n = tentativas || 8;
  for (let i = 0; i < n; i++) {
    let r;
    // falha de conexão (fetch failed, timeout) também é repetida, não só 429/5xx
    try { r = await fetch(url, { headers: { Authorization: 'Bearer ' + tk }, signal: AbortSignal.timeout(60000) }); }
    catch (e) { await esperar(2000 * (i + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { await esperar(1500 * (i + 1)); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${r.status} ${(j.error && j.error.message) || ''}`);
    return j;
  }
  throw new Error('falhou após tentativas');
}
async function emParalelo(itens, n, fn) {
  const saida = new Array(itens.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < itens.length) { const k = i++; saida[k] = await fn(itens[k], k); } }));
  return saida;
}

/** e-mail -> CNPJs, a partir dos contatos cadastrados no Acessórias. Lê um por vez (paralelo derruba a API) e guarda em cache. */
async function mapaDeContatos() {
  if (fs.existsSync(CACHE_MAPA)) {
    const idade = (Date.now() - fs.statSync(CACHE_MAPA).mtimeMs) / 86400000;
    if (idade <= CACHE_MAX_DIAS) return JSON.parse(fs.readFileSync(CACHE_MAPA, 'utf8'));
  }
  const { Pool } = require(path.join(RAIZ, 'node_modules', 'pg'));
  const pool = new Pool({ connectionString: (process.env.DATABASE_URL || '').trim(), ssl: { rejectUnauthorized: false }, max: 1 });
  const { rows } = await pool.query(`select regexp_replace(cnpj, '\\D', '', 'g') cnpj, nome_empresa from clientes where status = 'ativo' order by cnpj`);
  await pool.end();
  const emails = {}; const nomes = {}; let lidos = 0, falhas = 0;
  for (const c of rows) {
    nomes[c.cnpj] = c.nome_empresa;
    let ok = false;
    for (let t = 0; t < 4 && !ok; t++) {
      try {
        const r = await fetch(`https://api.acessorias.com/companies/${c.cnpj}/?registrationData&contacts`, { headers: { Authorization: `Bearer ${process.env.ACESSORIAS_API_TOKEN}` }, signal: AbortSignal.timeout(30000) });
        if (r.status === 429 || r.status >= 500) { await esperar(2500 * (t + 1)); continue; }
        if (!r.ok) break;
        const j = await r.json(); const emp = Array.isArray(j) ? j[0] : j;
        const lista = (emp && Array.isArray(emp.ContatosNaEmpresa)) ? emp.ContatosNaEmpresa : [];
        lista.forEach((x) => calc.enderecos(x['E-mail'] || x.Email || '').forEach((e) => { (emails[e] = emails[e] || []); if (!emails[e].includes(c.cnpj)) emails[e].push(c.cnpj); }));
        ok = true; lidos++;
      } catch (e) { await esperar(2000); }
    }
    if (!ok) falhas++;
    await esperar(450);
  }
  const mapa = { emails, nomes, lidos, falhas, total: rows.length };
  fs.writeFileSync(CACHE_MAPA, JSON.stringify(mapa));
  return mapa;
}

/**
 * Cruza com o Zappy: se o escritório falou com o cliente (qualquer ticket das empresas do contato) DEPOIS do e-mail,
 * a espera já foi resolvida por outro canal. Só leitura; marca `resolvidoZappy` no contato.
 */
async function cruzarZappy(contatos) {
  const { Pool } = require(path.join(RAIZ, 'node_modules', 'pg'));
  const pool = new Pool({ connectionString: (process.env.DATABASE_URL || '').trim(), ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    for (const c of contatos) {
      if (!(c.aguardando && c.horas >= 4 && c.cnpjs.length)) continue;
      const q = await pool.query(
        `select 1 from cs_mensagens m
           join cs_tickets t on t.id = m.ticket_id
           join cs_vinculos v on v.id = t.vinculo_id
           join clientes cl on cl.id::text = v.cliente_id
          where regexp_replace(cl.cnpj, '\\D', '', 'g') = any($1) and m.remetente = 'escritorio' and m.hora > to_timestamp($2 / 1000.0)
          limit 1`, [c.cnpjs, c.ultimaT]);
      c.resolvidoZappy = q.rows.length > 0;
    }
  } finally { await pool.end(); }
}

// Cache por caixa (SÓ nesta máquina, fora do Git: contém endereços): cada mensagem é lida uma vez; nas rodadas seguintes só as novas.
const CACHE_DIR = process.env.EMAIL_CACHE_DIR || path.join(__dirname, 'cache');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_');

async function lerCaixa(usuario, rotulo, internos) {
  const tk = await token(usuario.toLowerCase(), 'https://www.googleapis.com/auth/gmail.readonly');
  const ids = []; let pg = '';
  do {
    const j = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent('newer_than:' + LEITURA_DIAS + 'd')}&maxResults=500${pg ? '&pageToken=' + pg : ''}&fields=nextPageToken,messages(id,threadId)`, tk);
    (j.messages || []).forEach((m) => ids.push(m)); pg = j.nextPageToken || '';
  } while (pg);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const arqCache = path.join(CACHE_DIR, slug(usuario) + '.json');
  let cache = {};
  if (fs.existsSync(arqCache)) { try { cache = JSON.parse(fs.readFileSync(arqCache, 'utf8')); } catch (e) { cache = {}; } }
  const H = ['From', 'To', 'Cc', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted'].map((h) => 'metadataHeaders=' + h).join('&');
  const novos = ids.filter((m) => !cache[m.id]);
  await emParalelo(novos, 5, async (m) => {
    // format=metadata: só os cabeçalhos pedidos; assunto e corpo não são solicitados.
    const j = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&${H}&fields=threadId,internalDate,sizeEstimate,labelIds,payload(mimeType,headers)`, tk);
    const h = {}; ((j.payload && j.payload.headers) || []).forEach((x) => { h[x.name.toLowerCase()] = x.value; });
    const n = calc.normalizarMensagem(h, { caixa: rotulo, thread: j.threadId, t: j.internalDate, tamanho: j.sizeEstimate, rotulos: j.labelIds, tipo: j.payload && j.payload.mimeType }, internos);
    delete n.caixa;
    cache[m.id] = n;
  });
  // o que saiu da janela deixa o cache; grava por cima só depois de ler tudo
  const vivos = {};
  ids.forEach((m) => { if (cache[m.id]) vivos[m.id] = cache[m.id]; });
  fs.writeFileSync(arqCache + '.tmp', JSON.stringify(vivos));
  fs.renameSync(arqCache + '.tmp', arqCache);
  return ids.filter((m) => vivos[m.id]).map((m) => Object.assign({ caixa: rotulo }, vivos[m.id]));
}

(async () => {
  const inicio = Date.now();
  // --reenviar=arquivo.json: manda de novo uma leitura já feita (arquivo gerado por esta rotina), sem reler as caixas.
  if (argv.reenviar) {
    const doc = JSON.parse(fs.readFileSync(argv.reenviar, 'utf8'));
    if ((doc.erros || []).length) { console.log('NÃO ENVIADO: a leitura salva tem caixa(s) com erro.'); process.exitCode = 2; return; }
    await enviarAoSistema({ janela_dias: doc.janela_dias, caixas_lidas: Object.keys(doc.volume_por_caixa || {}).length, caixas_com_erro: 0, totais: doc.totais, clientes: doc.clientes, nao_identificados: doc.nao_identificados });
    return;
  }
  const tkDir = await token(ADMIN, 'https://www.googleapis.com/auth/admin.directory.user.readonly');
  const dir = await api('https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=200&fields=users(primaryEmail,name/fullName,aliases,suspended,archived)', tkDir);
  let usuarios = (dir.users || []).filter((u) => !u.suspended && !u.archived);
  const internos = new Set(usuarios.map((u) => calc.dominio(u.primaryEmail.toLowerCase())).concat(['escritorial.com.br', 'escritorialcontabil.com.br']));
  if (argv.caixas) { const re = new RegExp(argv.caixas, 'i'); usuarios = usuarios.filter((u) => re.test(u.primaryEmail) || re.test((u.name && u.name.fullName) || '')); }

  const mapa = await mapaDeContatos();
  const dominiosCliente = calc.dominiosDeCliente(mapa.emails, internos);
  console.log(`mapa de contatos: ${mapa.lidos}/${mapa.total} clientes lidos, ${Object.keys(mapa.emails).length} endereços; caixas: ${usuarios.length}; janela: ${DIAS} dias`);

  const ARQ_MSGS = path.join(os.tmpdir(), 'email_msgs_cache.json');   // contém endereços de e-mail: uso local, apague depois
  let todas = []; const erros = []; const volume = {};
  const usarCache = argv['usar-cache'] !== undefined && fs.existsSync(ARQ_MSGS);
  if (usarCache) { todas = JSON.parse(fs.readFileSync(ARQ_MSGS, 'utf8')); console.log(`usando cache de ${todas.length} mensagens (${ARQ_MSGS})`); }
  for (const u of usarCache ? [] : usuarios) {
    const rotulo = (u.name && u.name.fullName) || u.primaryEmail;
    try {
      const msgs = await lerCaixa(u.primaryEmail, rotulo, internos);
      volume[rotulo] = msgs.length;
      msgs.forEach((m) => todas.push(m));
      console.log(`  ${rotulo}: ${msgs.length} mensagens`);
    } catch (e) { erros.push({ caixa: rotulo, erro: e.message }); console.log(`  ${rotulo}: ERRO ${e.message}`); }
  }
  if (!usarCache && argv['guardar-cache'] !== undefined && !erros.length) fs.writeFileSync(ARQ_MSGS, JSON.stringify(todas));
  // todas as caixas juntas: o mesmo e-mail copiado em várias caixas conta uma vez e a resposta de um colega encerra a espera
  // aprendizado: e-mail que aparece nas mesmas conversas de contatos de UMA empresa passa a valer como contato dela
  const hoje = new Date().toISOString().slice(0, 10);
  const antigos = fs.existsSync(ARQ_APRENDIDOS) ? JSON.parse(fs.readFileSync(ARQ_APRENDIDOS, 'utf8')) : {};
  const novos = calc.aprenderContatos(todas, { mapaEmails: mapa.emails, internos });   // âncoras: só o cadastro do Acessórias
  const fundido = calc.mesclarAprendidos(antigos, novos.aprendidos, hoje);
  const mapaEfetivo = calc.mapaComAprendidos(mapa.emails, fundido.base);
  if (argv['sem-gravar'] === undefined) fs.writeFileSync(ARQ_APRENDIDOS, JSON.stringify(fundido.base, null, 1));
  const ignorar = fs.existsSync(ARQ_IGNORAR) ? calc.lerIgnorados(fs.readFileSync(ARQ_IGNORAR, 'utf8')) : [];
  const total = Object.keys(fundido.base).length;
  console.log(`aprendizado: ${Object.keys(novos.aprendidos).length} endereço(s) associados nesta rodada (${total} no total), ${novos.ambiguos} ambíguo(s), ${fundido.trocas.length} troca(s) de empresa; ${ignorar.length} regra(s) de domínio ignorado`);
  const corteJanela = Date.now() - DIAS * 86400000;
  const contatos = calc.sinaisPorContato(todas.filter((m) => m.t >= corteJanela), { agora: Date.now(), mapaEmails: mapaEfetivo, dominiosCliente, aprendidos: fundido.base, ignorarDominios: ignorar });
  const viaAprendizado = contatos.filter((c) => c.aprendido && c.cnpjs.length).length;
  await cruzarZappy(contatos);
  const r = calc.consolidar(contatos, mapa.nomes);
  // histórico por destinatário (módulo Atendimento): janela longa, mesma ligação a clientes
  const contatosHist = calc.atendimentoPorContato(todas, { agora: Date.now(), mapaEmails: mapaEfetivo, dominiosCliente, ignorarDominios: ignorar, internos });
  await cruzarZappy(contatosHist);
  const nomesDiretorio = {};
  (dir.users || []).forEach((u) => { const nome = (u.name && u.name.fullName) || u.primaryEmail; [u.primaryEmail].concat(u.aliases || []).forEach((a) => { nomesDiretorio[String(a).toLowerCase()] = nome; }); });
  const historico = clientesParaEnvio(calc.consolidarAtendimento(contatosHist), nomesDiretorio);
  console.log(`histórico ${HISTORICO} dias: ${historico.length} cliente(s) com e-mail; ${historico.reduce((s, c) => s + c.recebidos, 0)} e-mails, ${historico.reduce((s, c) => s + c.sem_resposta, 0)} sem resposta`);
  const semLigacao = calc.naoIdentificados(contatos);
  // calibragem do "provável obrigado": tamanho da última mensagem de quem já tinha recebido resposta nossa
  const faixas = { ate3k: 0, ate6k: 0, ate12k: 0, ate30k: 0, mais30k: 0 };
  contatos.filter((c) => c.aguardando && c.horas >= 4 && c.respondidoAntes).forEach((c) => {
    const k = c.tamanhoUltima;
    faixas[k <= 3000 ? 'ate3k' : k <= 6000 ? 'ate6k' : k <= 12000 ? 'ate12k' : k <= 30000 ? 'ate30k' : 'mais30k']++;
  });
  console.log('Tamanho da última mensagem (contatos que já tinham recebido resposta nossa):', JSON.stringify(faixas));
  const saida = argv.saida || path.join(os.tmpdir(), 'email_sinais_previa.json');
  const doc = { gerado_em: new Date().toISOString(), janela_dias: DIAS, mapa: { lidos: mapa.lidos, total: mapa.total }, volume_por_caixa: volume, erros, faixas_tamanho: faixas, nao_identificados: semLigacao, aprendizado: { novos: Object.keys(novos.aprendidos).length, total, ambiguos: novos.ambiguos, trocas: fundido.trocas.length, contatos_ligados_por_aprendizado: viaAprendizado }, ...r, historico_dias: HISTORICO, historico_clientes: historico.length };
  fs.writeFileSync(saida, JSON.stringify(doc, null, 1));
  const t = r.totais;
  if (erros.length) console.log(`ATENÇÃO: PRÉVIA INCOMPLETA — ${erros.length} caixa(s) não foram lidas: ${erros.map((e) => e.caixa).join(", ")}`);
  console.log(`\nRESUMO: ${usuarios.length} caixas · ${t.contatos} contatos externos escreveram (${t.identificados} ligados a cliente, ${t.nao_identificados} sem ligação) · aguardando resposta ≥4 h: ${t.aguardando} (+${t.provaveis_encerramentos} prováveis "obrigado") · ${erros.length} caixa(s) com erro`);
  console.log(`${r.clientes.filter((c) => c.aguardando_4h > 0).length} cliente(s) com conversa aguardando; arquivo: ${saida}; ${Math.round((Date.now() - inicio) / 1000)} s`);

  // Envio ao sistema (só com --enviar): somente contagens por cliente e por domínio, nunca endereço, assunto ou texto.
  if (argv.enviar !== undefined) {
    if (erros.length) { console.log('NÃO ENVIADO: há caixa(s) com erro; leitura incompleta não substitui a anterior.'); process.exitCode = 2; return; }
    if (argv.caixas) { console.log('NÃO ENVIADO: --caixas lê só parte do domínio; envio exige todas as caixas.'); process.exitCode = 2; return; }
    await enviarAoSistema({ janela_dias: DIAS, caixas_lidas: usuarios.length, caixas_com_erro: 0, totais: r.totais, clientes: r.clientes, nao_identificados: semLigacao });
    await enviarAtendimento({ janela_dias: HISTORICO, caixas_lidas: usuarios.length, caixas_com_erro: 0, clientes: historico });
  }
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });


/**
 * Histórico de 180 dias por destinatário interno. Os endereços do escritório viram o nome da pessoa (diretório do Google) ou ficam como
 * endereço quando são grupos; nada de cliente sai desta máquina.
 */
const GRUPOS = new Set(['dptofiscal@escritorial.com.br', 'dptocontabil@escritorial.com.br', 'contabil.fiscal@escritorial.com.br', 'escritorial@escritorial.com.br',
  'gestao@escritorial.com.br', 'pralegal@escritorial.com.br', 'hands@escritorial.com.br', 'legalizacao@escritorial.com.br', 'legalizacao@escritorialcontabil.com.br',
  'deptopessoal@escritorial.com.br', 'dctfweb@escritorial.com.br', 'cs@escritorial.com.br']);
function clientesParaEnvio(porCliente, nomesDiretorio) {
  const nomear = (dest) => {
    const por = {};
    Object.keys(dest || {}).forEach((a) => {
      const grupo = GRUPOS.has(a);
      const nome = grupo ? a : (nomesDiretorio[a] || a);
      const r = (por[nome] = por[nome] || { nome, grupo, recebidos: 0, sem: 0 });
      r.recebidos += dest[a].recebidos; r.sem += dest[a].sem;
    });
    return Object.values(por).sort((x, y) => y.recebidos - x.recebidos);
  };
  return porCliente.map((c) => ({
    cnpj: c.cnpj, recebidos: c.recebidos, sem_resposta: c.sem_resposta, compartilhados_recebidos: c.compartilhados_recebidos || 0, compartilhados_sem: c.compartilhados_sem || 0,
    destinatarios: nomear(c.destinatarios), compartilhados_destinatarios: nomear(c.compartilhados_destinatarios),
  }));
}
async function enviarAtendimento(corpo) {
  const url = (process.env.APP_URL || '').replace(/\/$/, '') + '/api/cs/email-sinais/atendimento';
  const tokenSync = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
  if (!process.env.APP_URL || !tokenSync) { console.log('HISTÓRICO NÃO ENVIADO: faltam APP_URL e o token de sincronização no .env.'); process.exitCode = 2; return; }
  const resp = await fetch(url, { method: 'POST', headers: { 'X-Sync-Token': tokenSync, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(180000) });
  const j = await resp.json().catch(() => ({}));
  console.log(resp.ok ? `HISTÓRICO ENVIADO: ${j.clientes} cliente(s) gravados no sistema.` : `ERRO NO ENVIO DO HISTÓRICO (${resp.status}): ${j.error || ''}${j.detalhe ? ' — ' + j.detalhe : ''}`);
  if (!resp.ok) process.exitCode = 1;
}

/** POST das contagens ao sistema (token de sincronização). Só contagens por cliente e por domínio; nunca endereço, assunto ou texto. */
async function enviarAoSistema(corpo) {
  const url = (process.env.APP_URL || '').replace(/\/$/, '') + '/api/cs/email-sinais';
  const tokenSync = process.env.LEGALIZACAO_SYNC_TOKEN || process.env.CERTISEGURO_SYNC_TOKEN;
  if (!process.env.APP_URL || !tokenSync) { console.log('NÃO ENVIADO: faltam APP_URL e o token de sincronização no .env.'); process.exitCode = 2; return; }
  const resp = await fetch(url, { method: 'POST', headers: { 'X-Sync-Token': tokenSync, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(120000) });
  const j = await resp.json().catch(() => ({}));
  console.log(resp.ok ? `ENVIADO: ${j.clientes} cliente(s) gravados no sistema.` : `ERRO NO ENVIO (${resp.status}): ${j.error || ''}${j.detalhe ? ' — ' + j.detalhe : ''}`);
  if (!resp.ok) process.exitCode = 1;
}
