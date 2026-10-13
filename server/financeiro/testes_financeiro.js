'use strict';
// Rodar: node server/financeiro/testes_financeiro.js  (sem banco: regras de cobrança, próximo passo, valores ocultos e quem chega nas rotas)
process.env.LEGALIZACAO_SYNC_TOKEN = 'token-de-teste';
const assert = require('assert');
const http = require('http');
const express = require('express');
const auth = require('../auth');
const calc = require('./calculo');
const fin = require('./rotas');
const painel = require('../cs/painel');

let ok = 0;
const teste = async (nome, fn) => { await fn(); ok++; console.log('  ok -', nome); };
const B = (t) => '*Bruno Xavier:* ' + t;

function chamar(porta, caminho, { token, metodo = 'GET', corpo, sync } = {}) {
  return new Promise((resolve, reject) => {
    const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (sync) headers['X-Sync-Token'] = sync;
    if (dados) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = dados.length; }
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers }, (res) => {
      let c = ''; res.on('data', (d) => { c += d; }); res.on('end', () => resolve({ status: res.statusCode, corpo: c }));
    });
    req.on('error', reject); if (dados) req.write(dados); req.end();
  });
}
const token = (role, extra = {}) => auth.signAccess({ id: 'u-' + role, name: 'Teste ' + role, role, ...extra });

(async () => {
  // ── classificação das mensagens do Bruno ──
  await teste('só mensagem do Bruno conta: outra pessoa ou o cliente não geram cobrança', () => {
    assert.strictEqual(calc.classificarMensagem('*Elma:* identificamos honorários em aberto'), null);
    assert.strictEqual(calc.classificarMensagem('Boa tarde, vou pagar o honorário em aberto hoje'), null);
  });
  await teste('cobrança, suspensão, boleto do mês e baixa são reconhecidos (modelos reais do Zappy)', () => {
    const c = calc.classificarMensagem(B('Olá!! Tudo bem? Estou entrando em contato para informar que identificamos alguns honorários em aberto, referentes à empresa.'));
    assert.deepStrictEqual([c.tipo, c.conta], ['cobranca', true]);
    const p = calc.classificarMensagem(B('Verificamos que o pagamento dos honorários contábeis encontra-se pendente em nosso sistema.'));
    assert.strictEqual(p.tipo, 'cobranca');
    const s = calc.classificarMensagem(B('devido à falta de pagamento dos honorários em aberto, os serviços contábeis da empresa serão suspensos até a regularização.'));
    assert.deepStrictEqual([s.tipo, s.conta], ['suspensao', true]);
    const b = calc.classificarMensagem(B('Bom dia, tudo bem? Segue em anexo o boleto referente ao honorário contábil do mês de JUNHO de 2026. Vencimento: 10/07/2026'));
    assert.deepStrictEqual([b.tipo, b.conta, b.datas], ['boleto', false, ['2026-07-10']]);
    const x = calc.classificarMensagem(B('Foi realizado o pagamento do valor correto do honorário mensal, restando em aberto apenas o valor de R$ 100,00'));
    assert.deepStrictEqual([x.tipo, x.conta], ['baixa', false]);
    assert.strictEqual(calc.classificarMensagem(B('Perfeito! Ajudo em algo mais? 😊')), null);
    assert.strictEqual(calc.classificarMensagem(B('Não haverá cobrança por esse serviço.')), null);
  });
  await teste('datas citadas: dd/mm/aaaa e dd/mm/aa', () => {
    const c = calc.classificarMensagem(B('Constam os seguintes valores em aberto: 10/04/2026 — R$ 217,96 e 11/05/26 R$ 217,96'));
    assert.strictEqual(c.tipo, 'cobranca');
    assert.deepStrictEqual(c.datas, ['2026-04-10', '2026-05-11']);
  });
  await teste('vários avisos no mesmo dia viram um só evento; cobrança vence boleto no tipo do dia', () => {
    const ev = calc.eventosPorDia([
      { dia: '2026-09-15', texto: B('Segue o boleto referente ao honorário do mês de AGOSTO. Vencimento: 10/09/2026'), ticket: '100' },
      { dia: '2026-09-15', texto: B('Identificamos honorários em aberto da empresa.'), ticket: '100' },
      { dia: '2026-09-15', texto: B('Conseguiu verificar os honorários em aberto?'), ticket: '101' },
      { dia: '2026-09-16', texto: B('Perfeito!'), ticket: '100' },
    ]);
    assert.strictEqual(ev.length, 1);
    assert.deepStrictEqual([ev[0].dia, ev[0].tipo, ev[0].conta, ev[0].tickets.sort()], ['2026-09-15', 'cobranca', true, ['100', '101']]);
  });

  // ── "quantas vezes cada competência foi cobrada" (o exemplo do pedido: setembro cobrou maio a agosto) ──
  await teste('setembro cobra maio a agosto = 1 cada; outubro cobra de novo = maio 2, junho 2... e agosto 2', () => {
    const titulos = ['2026-05-10', '2026-06-10', '2026-07-10', '2026-08-10'].map((v) => ({ vencimento: v, valor: 500 }));
    const set = calc.eventosPorDia([{ dia: '2026-09-15', texto: B('Identificamos honorários em aberto da empresa em nosso sistema.') }]);
    assert.deepStrictEqual(calc.contarCobrancas(titulos, set).map((t) => t.cobrancas), [1, 1, 1, 1]);
    const out = calc.eventosPorDia([
      { dia: '2026-09-15', texto: B('Identificamos honorários em aberto da empresa em nosso sistema.') },
      { dia: '2026-10-06', texto: B('Conseguiu verificar a situação dos honorários em aberto?') },
    ]);
    const r = calc.contarCobrancas(titulos, out);
    assert.deepStrictEqual(r.map((t) => t.cobrancas), [2, 2, 2, 2]);
    assert.strictEqual(r[0].ultima_cobranca, '2026-10-06');
    assert.strictEqual(r[0].primeira_cobranca, '2026-09-15');
  });
  await teste('não conta: título ainda não vencido na data, já pago na data, ou fora das datas que a mensagem citou', () => {
    const ev = calc.eventosPorDia([{ dia: '2026-09-15', texto: B('Constam em aberto os honorários com vencimento em 10/06/2026 e 10/07/2026.') }]);
    const t = [
      { vencimento: '2026-06-10' },                         // citado -> conta
      { vencimento: '2026-07-10', pago_em: '2026-09-01' },  // citado, mas já estava pago em 15/09 -> não conta
      { vencimento: '2026-08-10' },                         // vencido, mas a mensagem não citou -> não conta
      { vencimento: '2026-09-20' },                         // ainda não tinha vencido -> não conta
    ];
    assert.deepStrictEqual(calc.contarCobrancas(t, ev).map((x) => x.cobrancas), [1, 0, 0, 0]);
  });
  await teste('boleto do mês e baixa não entram na contagem de cobrança', () => {
    const ev = calc.eventosPorDia([{ dia: '2026-09-15', texto: B('Segue em anexo o boleto referente ao honorário contábil do mês de AGOSTO. Vencimento: 10/09/2026') }]);
    assert.deepStrictEqual(calc.contarCobrancas([{ vencimento: '2026-08-10' }], ev).map((x) => x.cobrancas), [0]);
  });

  // ── próximo passo ──
  await teste('próximo passo: nunca cobrado, aguardar, cobrar de novo, ligar, avaliar suspensão, suspenso, em dia', () => {
    const base = { suspenso: false, diasAtraso: 20, qtdAtrasados: 2, cobrancas: 0, ultimaCobranca: null, hoje: '2026-10-13' };
    assert.strictEqual(calc.proximoPasso(base).codigo, 'cobrar_agora');
    assert.strictEqual(calc.proximoPasso({ ...base, cobrancas: 1, ultimaCobranca: '2026-10-10' }).codigo, 'aguardar');
    assert.strictEqual(calc.proximoPasso({ ...base, cobrancas: 1, ultimaCobranca: '2026-09-25' }).codigo, 'cobrar_de_novo');
    assert.strictEqual(calc.proximoPasso({ ...base, cobrancas: 3, ultimaCobranca: '2026-09-20' }).codigo, 'ligar');
    assert.strictEqual(calc.proximoPasso({ ...base, diasAtraso: 100, cobrancas: 2, ultimaCobranca: '2026-10-12' }).codigo, 'avaliar_suspensao');
    assert.strictEqual(calc.proximoPasso({ ...base, suspenso: true }).codigo, 'suspenso_com_debito');
    assert.strictEqual(calc.proximoPasso({ ...base, suspenso: true, qtdAtrasados: 0 }).codigo, 'suspenso');
    assert.strictEqual(calc.proximoPasso({ ...base, qtdAtrasados: 0, diasAtraso: 0 }).codigo, 'em_dia');
  });
  await teste('faixas de atraso', () => {
    assert.strictEqual(calc.faixaDeAtraso(0), null);
    assert.deepStrictEqual([1, 15, 16, 30, 31, 60, 61, 90, 91, 400].map((d) => calc.faixaDeAtraso(d).id), ['ate15', 'ate15', 'ate30', 'ate30', 'ate60', 'ate60', 'ate90', 'ate90', 'mais90', 'mais90']);
  });

  // ── composição e valores ocultos ──
  const DOC_A = '11222333000181', DOC_B = '44555666000122', DOC_C = '77888999000133';
  const dados = fin.compor({
    hoje: '2026-10-13',
    clientes: [
      { id: 'a', nome: 'ALFA LTDA', cnpj: '11.222.333/0001-81', grupo: null, cronico: false },
      { id: 'b', nome: 'BETA LTDA', cnpj: '44.555.666/0001-22', grupo: 'Grupo B', cronico: true },
      { id: 'c', nome: 'GAMA LTDA', cnpj: '77.888.999/0001-33', grupo: null, cronico: false },
    ],
    categorias: { a: { categoria: 'Ouro' } },
    honorarios: new Map([[DOC_A, 800], [DOC_B, 350]]),
    abertoAgg: new Map([[DOC_A, { qtd: 3, aberto: 2400, atrasado: 1600, qtd_atrasados: 2, mais_antigo: '2026-07-10' }], [DOC_C, { qtd: 1, aberto: 123, atrasado: 123, qtd_atrasados: 1, mais_antigo: '2026-06-10' }]]),
    titulos: [
      { doc: DOC_A, rec: '1', venc: '2026-07-10', aberto: 800, doc_valor: 800, sit: 'A' },
      { doc: DOC_A, rec: '2', venc: '2026-08-10', aberto: 800, doc_valor: 800, sit: 'A' },
      { doc: DOC_A, rec: '3', venc: '2026-10-20', aberto: 800, doc_valor: 800, sit: 'V' },
    ],
    suspensos: new Map([[DOC_C, { contrato: '12' }]]),
    mensagens: [{ doc: DOC_A, dia: '2026-09-15', texto: B('Identificamos honorários em aberto da empresa.'), ticket: '900' }],
  });
  await teste('composição: inadimplente com títulos, em dia, suspenso com débito sem detalhe; indicadores', () => {
    const a = dados.clientes.find((c) => c.id === 'a'), b = dados.clientes.find((c) => c.id === 'b'), c = dados.clientes.find((x) => x.id === 'c');
    assert.deepStrictEqual([a.situacao, a.qtd_atrasados, a.valor_atrasado, a.dias_atraso, a.faixa], ['inadimplente', 2, 1600, 95, 'mais90']);
    assert.deepStrictEqual([a.cobrancas, a.ultima_cobranca, a.abertos.length], [1, '2026-09-15', 3]);
    assert.deepStrictEqual(a.abertos.map((t) => t.cobrancas), [1, 1, 0]);      // o a vencer não conta
    assert.strictEqual(b.situacao, 'em_dia');
    assert.deepStrictEqual([c.situacao, c.suspenso, c.detalhe_titulos, c.qtd_atrasados], ['inadimplente', true, false, 1]);
    assert.strictEqual(c.proximo_passo.codigo, 'suspenso_com_debito');
    const k = dados.kpis;
    assert.deepStrictEqual([k.clientes_ativos, k.clientes_com_honorario, k.inadimplentes, k.suspensos, k.suspensos_com_debito, k.nunca_cobrados], [3, 2, 2, 1, 1, 1]);
    assert.strictEqual(k.valor_atrasado, 1723);
    assert.strictEqual(k.qualidade.inadimplentes_sem_detalhe, 1);
  });
  await teste('valores ocultos: nenhum valor em R$ sai do servidor para quem não vê valores', () => {
    const m = fin.mascarar({ kpis: dados.kpis, clientes: dados.clientes });
    assert.strictEqual(m.valores_ocultos, true);
    assert.ok(m.clientes.every((c) => c.honorario === null && c.valor_atrasado === null && c.valor_aberto === null && c.abertos.every((t) => t.valor === null)));
    assert.deepStrictEqual([m.kpis.honorario_mensal, m.kpis.valor_atrasado, m.kpis.honorario_suspenso, m.kpis.a_vencer_7_dias.valor], [null, null, null, null]);
    assert.ok(m.kpis.aging.every((a) => a.valor === null));
    assert.strictEqual(m.clientes.find((c) => c.id === 'a').qtd_atrasados, 2);   // contagens continuam
    const txt = JSON.stringify(m);
    assert.ok(!/\b(800|1600|1723|2400|350|123)\b/.test(txt.replace(/"(doc|cnpj)":"[0-9.\/-]+"/g, '')), 'algum valor vazou: ' + txt.slice(0, 400));
    assert.strictEqual(dados.clientes[0].honorario, 800);                          // não altera o cache compartilhado
  });
  await teste('quem vê valores: administrador e acesso_financeiro; usuário e acesso_cs não', () => {
    assert.strictEqual(fin.veValores({ role: 'administrador' }), true);
    assert.strictEqual(fin.veValores({ role: 'usuario', acessoFinanceiro: true }), true);
    assert.strictEqual(fin.veValores({ role: 'contabil', acessoFinanceiro: true }), true);
    assert.strictEqual(fin.veValores({ role: 'usuario' }), false);
    assert.strictEqual(fin.veValores({ role: 'colaborador', acessoCs: true }), false);
    assert.strictEqual(fin.veValores(undefined), false);
  });

  // ── quem chega nas rotas (isolamento: o servidor decide) ──
  const app = express();
  app.use(express.json());
  app.use('/api/financeiro', fin.router);
  app.use('/api/cs/painel', painel.router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const porta = server.address().port;
  const FICHA_INVALIDA = '/api/financeiro/ficha/123';       // 400 para quem passa pela porta (sem tocar no banco)
  const CHURN_INVALIDO = '/api/cs/painel/churn?ini=2026-02-01&fim=2026-01-01';

  await teste('financeiro: sem login 401; token inválido 401', async () => {
    assert.strictEqual((await chamar(porta, '/api/financeiro/dados')).status, 401);
    assert.strictEqual((await chamar(porta, FICHA_INVALIDA, { token: 'lixo' })).status, 401);
  });
  await teste('financeiro: contábil e colaborador sem as marcas = 403 (mesmo com Minha Nota e Legalização)', async () => {
    for (const role of ['contabil', 'colaborador']) {
      const t = token(role, { acesso_minha_nota: true, acesso_legalizacao: true });
      for (const r of ['/api/financeiro/dados', FICHA_INVALIDA]) assert.strictEqual((await chamar(porta, r, { token: t })).status, 403, role + ' ' + r);
    }
  });
  await teste('financeiro: administrador, usuário, acesso_cs e acesso_financeiro passam pela porta', async () => {
    const tokens = [token('administrador'), token('usuario'), token('contabil', { acesso_cs: true }), token('colaborador', { acesso_cs: true }), token('contabil', { acesso_financeiro: true }), token('colaborador', { acesso_financeiro: true })];
    for (const t of tokens) assert.strictEqual((await chamar(porta, FICHA_INVALIDA, { token: t })).status, 400);
  });
  await teste('/cs: acesso_cs abre o painel para contábil/colaborador; acesso_financeiro sozinho NÃO abre o /cs', async () => {
    assert.strictEqual((await chamar(porta, CHURN_INVALIDO, { token: token('contabil', { acesso_cs: true }) })).status, 400);
    assert.strictEqual((await chamar(porta, CHURN_INVALIDO, { token: token('colaborador', { acesso_cs: true }) })).status, 400);
    assert.strictEqual((await chamar(porta, CHURN_INVALIDO, { token: token('contabil', { acesso_financeiro: true }) })).status, 403);
    assert.strictEqual((await chamar(porta, CHURN_INVALIDO, { token: token('colaborador', { acesso_financeiro: true }) })).status, 403);
  });
  await teste('POST /titulos: só com o token de sincronização (usuário logado, mesmo administrador, não grava)', async () => {
    assert.strictEqual((await chamar(porta, '/api/financeiro/titulos', { metodo: 'POST', corpo: {} })).status, 401);
    assert.strictEqual((await chamar(porta, '/api/financeiro/titulos', { metodo: 'POST', corpo: {}, token: token('administrador') })).status, 401);
    assert.strictEqual((await chamar(porta, '/api/financeiro/titulos', { metodo: 'POST', corpo: {}, sync: 'errado' })).status, 401);
    assert.strictEqual((await chamar(porta, '/api/financeiro/titulos', { metodo: 'POST', corpo: { unidade: 'X' }, sync: 'token-de-teste' })).status, 400);
  });

  server.close();
  console.log(`\n${ok} testes passaram.`);
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
