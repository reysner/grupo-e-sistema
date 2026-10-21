'use strict';
// Rodar: node server/emailSinais/testes_email_sinais.js  (lógica pura, sem rede e sem banco)
const assert = require('assert');
const { enderecos, dominiosDeCliente, normalizarMensagem, sinaisPorContato, consolidar, naoIdentificados, atendimentoPorContato, consolidarAtendimento, diaBrasilia,
  aprenderContatos, mesclarAprendidos, mapaComAprendidos, lerIgnorados, dominioIgnorado } = require('./calculo');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };
const H = 3600000;
const AGORA = Date.UTC(2026, 9, 14, 12, 0, 0);
const internos = new Set(['escritorial.com.br']);
const mapaEmails = { 'joao@padaria.com.br': ['11111111000111'], 'maria@gmail.com': ['22222222000122'] };
const dominiosCliente = dominiosDeCliente(mapaEmails, internos);
// recebida de cliente (de) em uma caixa; enviada pelo escritório (de interno) para alguém (para)
const rec = (de, horasAtras, caixa, extra) => Object.assign({ caixa: caixa || 'Bruno', thread: 'x', t: AGORA - horasAtras * H, de, interno: false, auto: false, tamanho: 20000, anexo: false, para: ['bruno@escritorial.com.br'] }, extra || {});
const env = (para, horasAtras, caixa) => ({ caixa: caixa || 'Bruno', thread: 'x', t: AGORA - horasAtras * H, de: 'bruno@escritorial.com.br', interno: true, auto: false, tamanho: 5000, anexo: false, para: [].concat(para) });
const ctx = { agora: AGORA, mapaEmails, dominiosCliente };

teste('endereços saem em minúsculas, de qualquer formato de cabeçalho', () => {
  assert.deepStrictEqual([...enderecos('"João" <Joao@Padaria.com.br>, outro@x.com')], ['joao@padaria.com.br', 'outro@x.com']);
});
teste('domínio corporativo do cliente vale para outros e-mails da mesma empresa; e-mail livre não', () => {
  assert.ok(dominiosCliente['padaria.com.br'].has('11111111000111'));
  assert.ok(!dominiosCliente['gmail.com']);
});
teste('mensagem automática é reconhecida por cabeçalho, remetente e rótulo; interna nunca é automática', () => {
  const n = (h, meta, de) => normalizarMensagem(Object.assign({ from: de || 'cli@x.com.br' }, h), Object.assign({ thread: 't', t: 1, tamanho: 10 }, meta || {}), internos);
  assert.strictEqual(n({ 'list-unsubscribe': '<mailto:x>' }).auto, true);
  assert.strictEqual(n({ 'auto-submitted': 'auto-replied' }).auto, true);
  assert.strictEqual(n({ 'auto-submitted': 'no' }).auto, false);
  assert.strictEqual(n({}, {}, 'noreply@banco.com.br').auto, true);
  assert.strictEqual(n({}, { rotulos: ['CATEGORY_PROMOTIONS'] }).auto, true);
  assert.strictEqual(n({}, {}, 'bruno@escritorial.com.br').interno, true);
  assert.strictEqual(n({}, {}, 'bruno@escritorial.com.br').auto, false);
  assert.strictEqual(n({}, { tipo: 'multipart/mixed' }).anexo, true);
});
teste('contato que escreveu e ninguém respondeu aguarda, com a idade da última mensagem', () => {
  const s = sinaisPorContato([rec('joao@padaria.com.br', 30)], ctx);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].aguardando, true);
  assert.strictEqual(Math.round(s[0].horas), 30);
  assert.deepStrictEqual([...s[0].cnpjs], ['11111111000111']);
});
teste('resposta do escritório depois da última do contato encerra a espera', () => {
  const s = sinaisPorContato([rec('joao@padaria.com.br', 30), env('joao@padaria.com.br', 28)], ctx);
  assert.strictEqual(s[0].aguardando, false);
});
teste('resposta de OUTRA caixa também encerra a espera (colega respondeu)', () => {
  const s = sinaisPorContato([rec('joao@padaria.com.br', 30, 'Bruno'), env('joao@padaria.com.br', 20, 'Elma')], ctx);
  assert.strictEqual(s[0].aguardando, false);
});
teste('o mesmo e-mail copiado em várias caixas conta como uma mensagem e um contato', () => {
  const s = sinaisPorContato([rec('joao@padaria.com.br', 30, 'Bruno'), rec('joao@padaria.com.br', 30, 'Elma'), rec('joao@padaria.com.br', 30, 'Max')], ctx);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].recebidas, 1);
  assert.deepStrictEqual([...s[0].caixas].sort(), ['Bruno', 'Elma', 'Max']);
});
teste('cliente escreveu de novo depois da resposta: volta a aguardar', () => {
  const s = sinaisPorContato([rec('joao@padaria.com.br', 30), env('joao@padaria.com.br', 28), rec('joao@padaria.com.br', 10)], ctx);
  assert.strictEqual(s[0].aguardando, true);
  assert.strictEqual(Math.round(s[0].horas), 10);
});
teste('só mensagem automática ou interna não cria contato', () => {
  const s = sinaisPorContato([rec('noreply@banco.com.br', 30, 'Bruno', { auto: true }), env('ana@escritorial.com.br', 5)], ctx);
  assert.strictEqual(s.length, 0);
});
teste('mensagem curta depois de uma resposta nossa é "provável encerramento"; com anexo ou sem resposta nossa antes, não', () => {
  const curta = sinaisPorContato([env('joao@padaria.com.br', 30), rec('joao@padaria.com.br', 20, 'Bruno', { tamanho: 3000 })], ctx);
  assert.strictEqual(curta[0].provavelEncerramento, true);
  const comAnexo = sinaisPorContato([env('joao@padaria.com.br', 30), rec('joao@padaria.com.br', 20, 'Bruno', { tamanho: 3000, anexo: true })], ctx);
  assert.strictEqual(comAnexo[0].provavelEncerramento, false);
  const pedidoNovo = sinaisPorContato([rec('joao@padaria.com.br', 20, 'Bruno', { tamanho: 3000 })], ctx);
  assert.strictEqual(pedidoNovo[0].provavelEncerramento, false);
});
teste('ligação por domínio quando o endereço não está nos contatos', () => {
  const s = sinaisPorContato([rec('outra.pessoa@padaria.com.br', 10)], ctx);
  assert.deepStrictEqual([...s[0].cnpjs], ['11111111000111']);
  assert.strictEqual(s[0].porDominio, true);
});
teste('consolidar: contagens por cliente, faixas de espera, não identificados separados e sem endereço', () => {
  const contatos = sinaisPorContato([
    rec('joao@padaria.com.br', 200),                                           // aguarda 200 h
    rec('outra.pessoa@padaria.com.br', 30),                                    // outro contato da mesma empresa, aguarda 30 h
    rec('financeiro@padaria.com.br', 40, 'Bruno', { tamanho: 2000 }), env('financeiro@padaria.com.br', 60),   // obrigado
    rec('desconhecido@empresa.com.br', 100),                                   // sem ligação
    rec('maria@gmail.com', 2),                                                 // cliente, mas só 2 h
  ], ctx);
  const r = consolidar(contatos, { '11111111000111': 'Padaria', '22222222000122': 'Maria' });
  const p = r.clientes.find((c) => c.cnpj === '11111111000111');
  assert.strictEqual(p.contatos_ativos, 3);
  assert.strictEqual(p.aguardando_4h, 2);
  assert.strictEqual(p.aguardando_24h, 2);
  assert.strictEqual(p.aguardando_48h, 1);
  assert.strictEqual(p.aguardando_7d, 1);
  assert.strictEqual(p.provaveis_encerramentos, 1);
  assert.strictEqual(p.mais_antigo_h, 200);
  assert.deepStrictEqual([...p.caixas], ['Bruno']);
  const m = r.clientes.find((c) => c.cnpj === '22222222000122');
  assert.strictEqual(m.aguardando_4h, 0);
  assert.strictEqual(r.totais.nao_identificados, 1);
  assert.strictEqual(r.totais.aguardando_nao_identificados, 1);
  assert.strictEqual(r.totais.aguardando, 2);
  assert.ok(!/@/.test(JSON.stringify(r)), 'nenhum endereço de e-mail pode aparecer no resultado');
});

teste('contato ligado a várias empresas é UM pedido: conta uma vez nos totais e vai para "compartilhado" em cada empresa', () => {
  const mapa2 = { 'socio@grupo.com.br': ['11111111000111', '33333333000133', '44444444000144'], 'joao@padaria.com.br': ['11111111000111'] };
  const c = sinaisPorContato([rec('socio@grupo.com.br', 50), rec('joao@padaria.com.br', 30)], { agora: AGORA, mapaEmails: mapa2, dominiosCliente: {} });
  const r = consolidar(c, {});
  assert.strictEqual(r.totais.aguardando, 2);
  assert.strictEqual(r.totais.aguardando_exclusivos, 1);
  assert.strictEqual(r.totais.aguardando_compartilhados, 1);
  const padaria = r.clientes.find((x) => x.cnpj === '11111111000111');
  assert.strictEqual(padaria.aguardando_4h, 1);
  assert.strictEqual(padaria.aguardando_compartilhado, 1);
  const outra = r.clientes.find((x) => x.cnpj === '33333333000133');
  assert.strictEqual(outra.aguardando_4h, 0);
  assert.strictEqual(outra.aguardando_compartilhado, 1);
});
teste('resolvido pelo Zappy não conta como espera, mas aparece como resolvido', () => {
  const c = sinaisPorContato([rec('joao@padaria.com.br', 50)], ctx);
  c[0].resolvidoZappy = true;
  const r = consolidar(c, {});
  assert.strictEqual(r.totais.aguardando, 0);
  assert.strictEqual(r.totais.resolvidos_zappy, 1);
  assert.strictEqual(r.clientes[0].aguardando_4h, 0);
  assert.strictEqual(r.clientes[0].resolvidos_zappy, 1);
});
teste('não identificados saem por domínio, e e-mail pessoal vira uma linha só, sem endereço', () => {
  const c = sinaisPorContato([
    rec('a@fornecedor.com.br', 30), rec('b@fornecedor.com.br', 60), rec('fulano@gmail.com', 40), rec('ciclano@hotmail.com', 10),
    rec('joao@padaria.com.br', 30),
  ], ctx);
  const l = naoIdentificados(c);
  const f = l.find((x) => x.dominio === 'fornecedor.com.br');
  assert.strictEqual(f.contatos, 2);
  assert.strictEqual(f.aguardando, 2);
  assert.strictEqual(f.mais_antigo_h, 60);
  const p = l.find((x) => x.pessoal);
  assert.strictEqual(p.contatos, 2);
  assert.ok(!l.some((x) => x.dominio === 'padaria.com.br'), 'cliente identificado não entra');
  assert.ok(!/fulano|ciclano|@/.test(JSON.stringify(l)), 'nenhum endereço pessoal no resultado');
});

// ── aprendizado de contatos ──
const conv = (thread, de, para, horasAtras, caixa) => Object.assign(rec(de, horasAtras, caixa || 'Bruno'), { thread, para: [].concat(para) });
const efetivo = { internos, mapaEmails };

teste('e-mail pessoal na mesma conversa de contato de UMA empresa é associado a ela', () => {
  const r = aprenderContatos([
    conv('t1', 'joao@padaria.com.br', ['bruno@escritorial.com.br', 'socio.padaria@gmail.com'], 30),
    conv('t1', 'socio.padaria@gmail.com', 'bruno@escritorial.com.br', 20),
  ], efetivo);
  assert.deepStrictEqual(Object.assign({}, r.aprendidos['socio.padaria@gmail.com']), { cnpj: '11111111000111', conversas: 1, confianca: 'alta' });
  assert.ok(!r.aprendidos['joao@padaria.com.br'], 'quem já é contato não é reaprendido');
  assert.ok(!r.aprendidos['bruno@escritorial.com.br'], 'interno nunca é aprendido');
});
teste('sem contato cadastrado na conversa, nada é aprendido', () => {
  const r = aprenderContatos([conv('t2', 'fulano@gmail.com', 'bruno@escritorial.com.br', 10)], efetivo);
  assert.deepStrictEqual(Object.keys(r.aprendidos), []);
});
teste('várias empresas: aprende só se uma domina; empate é ambíguo e não aprende', () => {
  const mapa3 = { 'a@x.com': ['1'], 'b@y.com': ['2'] };
  const e3 = { internos, mapaEmails: mapa3 };
  const empate = aprenderContatos([conv('t1', 'a@x.com', 'p@gmail.com', 5), conv('t2', 'b@y.com', 'p@gmail.com', 6)], e3);
  assert.strictEqual(Object.keys(empate.aprendidos).length, 0);
  assert.strictEqual(empate.ambiguos, 1);
  const domina = aprenderContatos([conv('t1', 'a@x.com', 'p@gmail.com', 5), conv('t2', 'a@x.com', 'p@gmail.com', 6), conv('t3', 'b@y.com', 'p@gmail.com', 7)], e3);
  assert.strictEqual(domina.aprendidos['p@gmail.com'].cnpj, '1');
  assert.strictEqual(domina.aprendidos['p@gmail.com'].confianca, 'media');
});
teste('contato ligado a várias empresas não serve de âncora (seria chute)', () => {
  const r = aprenderContatos([conv('t1', 'socio@grupo.com', 'p@gmail.com', 5)], { internos, mapaEmails: { 'socio@grupo.com': ['1', '2', '3'] } });
  assert.strictEqual(Object.keys(r.aprendidos).length, 0);
});
teste('mesclar mantém o que já se sabia, atualiza e registra troca de empresa', () => {
  const antigos = { 'p@gmail.com': { cnpj: '1', conversas: 1, confianca: 'alta', desde: '2026-10-01', atualizado: '2026-10-01' } };
  const igual = mesclarAprendidos(antigos, { 'p@gmail.com': { cnpj: '1', conversas: 3, confianca: 'alta' } }, '2026-10-14');
  assert.strictEqual(igual.base['p@gmail.com'].conversas, 3);
  assert.strictEqual(igual.base['p@gmail.com'].desde, '2026-10-01');
  const troca = mesclarAprendidos(antigos, { 'p@gmail.com': { cnpj: '2', conversas: 5, confianca: 'media' } }, '2026-10-14');
  assert.deepStrictEqual([...troca.trocas], ['p@gmail.com']);
  assert.strictEqual(troca.base['p@gmail.com'].anterior, '1');
  const fraca = mesclarAprendidos(antigos, { 'p@gmail.com': { cnpj: '2', conversas: 1, confianca: 'alta' } }, '2026-10-14');
  assert.strictEqual(fraca.base['p@gmail.com'].cnpj, '1');
  const nova = mesclarAprendidos({}, { 'q@gmail.com': { cnpj: '9', conversas: 1, confianca: 'alta' } }, '2026-10-14');
  assert.strictEqual(nova.base['q@gmail.com'].desde, '2026-10-14');
});
teste('o contato aprendido passa a ser ligado à empresa nas contagens, e o cadastro do Acessórias sempre vence', () => {
  const mapaEf = mapaComAprendidos(mapaEmails, { 'socio@gmail.com': { cnpj: '11111111000111' }, 'maria@gmail.com': { cnpj: '99999999000199' } });
  assert.deepStrictEqual([...mapaEf['socio@gmail.com']], ['11111111000111']);
  assert.deepStrictEqual([...mapaEf['maria@gmail.com']], ['22222222000122']);
  const s = sinaisPorContato([rec('socio@gmail.com', 30)], { agora: AGORA, mapaEmails: mapaEf, dominiosCliente, aprendidos: { 'socio@gmail.com': {} } });
  assert.deepStrictEqual([...s[0].cnpjs], ['11111111000111']);
  assert.strictEqual(s[0].aprendido, true);
});
teste('domínios ignorados: exato, subdomínio e sufixo; domínio de cliente nunca é ignorado', () => {
  const regras = lerIgnorados('indeed.com  # vagas\n.gov.br\n\namazon.com');
  assert.deepStrictEqual([...regras], ['indeed.com', '.gov.br', 'amazon.com']);
  assert.strictEqual(dominioIgnorado('indeed.com', regras), true);
  assert.strictEqual(dominioIgnorado('mail.indeed.com', regras), true);
  assert.strictEqual(dominioIgnorado('uberlandia.mg.gov.br', regras), true);
  assert.strictEqual(dominioIgnorado('notindeed.com', regras), false);
  assert.strictEqual(dominioIgnorado('padaria.com.br', regras, dominiosCliente), false);
  assert.strictEqual(dominioIgnorado('indeed.com', regras, { 'indeed.com': new Set(['1']) }), false);
  const s = sinaisPorContato([rec('vagas@indeed.com', 30), rec('joao@padaria.com.br', 30)], Object.assign({}, ctx, { ignorarDominios: regras }));
  assert.strictEqual(s.length, 1);
});


// ── histórico por destinatário (módulo Atendimento) ──
const internosAt = new Set(['escritorial.com.br']);
const ctxAt = Object.assign({ internos: internosAt }, ctx);
const recPara = (de, horasAtras, para, extra) => rec(de, horasAtras, 'Bruno', Object.assign({ para }, extra || {}));
teste('histórico: conta e-mails por destinatário interno e marca os sem resposta; cópia em várias caixas é um e-mail só', () => {
  const m = [
    recPara('joao@padaria.com.br', 100, ['dptofiscal@escritorial.com.br', 'bruno@escritorial.com.br']),
    recPara('joao@padaria.com.br', 100, ['dptofiscal@escritorial.com.br']),                    // cópia em outra caixa, mesma hora
    env('joao@padaria.com.br', 90),                                                             // alguém respondeu
    recPara('joao@padaria.com.br', 30, ['dptofiscal@escritorial.com.br'], { tamanho: 50000 }),
    recPara('joao@padaria.com.br', 10, ['bruno@escritorial.com.br'], { tamanho: 50000 }),
  ];
  const c = atendimentoPorContato(m, ctxAt);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].recebidos, 3);
  assert.strictEqual(c[0].semResposta, 2);
  const soTotais = (x) => ({ recebidos: x.recebidos, sem: x.sem });
  assert.deepStrictEqual(soTotais(c[0].porDest['dptofiscal@escritorial.com.br']), { recebidos: 2, sem: 1 });
  assert.deepStrictEqual(soTotais(c[0].porDest['bruno@escritorial.com.br']), { recebidos: 2, sem: 1 });
  const por = consolidarAtendimento(c);
  assert.deepStrictEqual([por[0].cnpj, por[0].recebidos, por[0].sem_resposta], ['11111111000111', 3, 2]);
});
teste('histórico: resposta de qualquer endereço do escritório encerra; menos de 4 h e "obrigado" curto não contam', () => {
  const resp = atendimentoPorContato([recPara('joao@padaria.com.br', 50, ['cs@escritorial.com.br']), env('joao@padaria.com.br', 40)], ctxAt);
  assert.strictEqual(resp[0].semResposta, 0);
  const novo = atendimentoPorContato([recPara('joao@padaria.com.br', 2, ['cs@escritorial.com.br'])], ctxAt);   // 2 h: ainda dentro do prazo
  assert.strictEqual(novo[0].semResposta, 0);
  const obrig = atendimentoPorContato([recPara('joao@padaria.com.br', 50, ['cs@escritorial.com.br']), env('joao@padaria.com.br', 40), recPara('joao@padaria.com.br', 30, ['cs@escritorial.com.br'], { tamanho: 3000 })], ctxAt);
  assert.strictEqual(obrig[0].semResposta, 0);
});
teste('histórico: contato ligado a duas empresas vai para "compartilhados" e não infla o total de nenhuma', () => {
  const m2 = Object.assign({}, mapaEmails, { 'socio@yahoo.com.br': ['11111111000111', '33333333000133'] });
  const c = atendimentoPorContato([recPara('socio@yahoo.com.br', 50, ['cs@escritorial.com.br']), recPara('joao@padaria.com.br', 20, ['cs@escritorial.com.br'])],
    Object.assign({}, ctxAt, { mapaEmails: m2 }));
  const por = Object.fromEntries(consolidarAtendimento(c).map((x) => [x.cnpj, x]));
  assert.deepStrictEqual([por['11111111000111'].recebidos, por['11111111000111'].compartilhados_recebidos, por['11111111000111'].compartilhados_sem], [1, 1, 1]);
  assert.deepStrictEqual([por['33333333000133'].recebidos, por['33333333000133'].compartilhados_recebidos], [0, 1]);
  assert.deepStrictEqual(por['33333333000133'].compartilhados_destinatarios['cs@escritorial.com.br'].sem, 1);   // a relação por destinatário também vale para os compartilhados
});
teste('histórico: contato sem empresa não entra; resolvido pelo Zappy zera a espera mas mantém os recebidos', () => {
  assert.strictEqual(atendimentoPorContato([recPara('fulano@desconhecido.com', 50, ['cs@escritorial.com.br'])], ctxAt).length, 0);
  const c = atendimentoPorContato([recPara('joao@padaria.com.br', 50, ['cs@escritorial.com.br'])], ctxAt);
  c[0].resolvidoZappy = true;
  const por = consolidarAtendimento(c);
  assert.deepStrictEqual([por[0].recebidos, por[0].sem_resposta, por[0].destinatarios['cs@escritorial.com.br'].sem], [1, 0, 0]);
});

teste('histórico por dia: cada destinatário guarda [recebidos, sem resposta] por dia de Brasília, e o dia some quando já foi atendido pelo Zappy', () => {
  const m = [
    recPara('joao@padaria.com.br', 100, ['bruno@escritorial.com.br']),
    env('joao@padaria.com.br', 90),
    recPara('joao@padaria.com.br', 30, ['bruno@escritorial.com.br'], { tamanho: 50000 }),
  ];
  const c = atendimentoPorContato(m, ctxAt);
  const dias = c[0].porDest['bruno@escritorial.com.br'].dias;
  const soma = (campo) => Object.keys(dias).reduce((t, k) => t + dias[k][campo], 0);
  assert.strictEqual(soma(0), c[0].porDest['bruno@escritorial.com.br'].recebidos, 'os dias somam o total de recebidos');
  assert.strictEqual(soma(1), c[0].porDest['bruno@escritorial.com.br'].sem, 'e o total de sem resposta');
  Object.keys(dias).forEach((k) => assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(k)));
  assert.strictEqual(diaBrasilia(Date.UTC(2026, 9, 12, 2, 30)), '2026-10-11', '02h30 UTC é 23h30 do dia anterior em Brasília');
  const resolvido = c.map((x) => Object.assign({}, x, { resolvidoZappy: true }));
  const por = consolidarAtendimento(resolvido)[0].destinatarios['bruno@escritorial.com.br'];
  assert.strictEqual(Object.keys(por.dias).reduce((t, k) => t + por.dias[k][1], 0), 0, 'atendido pelo Zappy: nenhum dia fica "sem resposta"');
  assert.strictEqual(Object.keys(por.dias).reduce((t, k) => t + por.dias[k][0], 0), por.recebidos);
});
console.log(`\n${ok} testes passaram.`);
process.exit(0);
