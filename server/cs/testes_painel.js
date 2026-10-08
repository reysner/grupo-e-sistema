'use strict';
// Rodar: node server/cs/testes_painel.js  (sem banco: só confere quem pode ou não chegar nas rotas do painel /cs)
const assert = require('assert');
const http = require('http');
const express = require('express');
const auth = require('../auth');
const painel = require('./painel');

let ok = 0;
const teste = async (nome, fn) => { await fn(); ok++; console.log('  ok -', nome); };

function chamar(porta, caminho, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, headers: token ? { Authorization: 'Bearer ' + token } : {} }, (res) => {
      let corpo = ''; res.on('data', (d) => { corpo += d; }); res.on('end', () => resolve({ status: res.statusCode, corpo }));
    });
    req.on('error', reject); req.end();
  });
}
const token = (role, extra = {}) => auth.signAccess({ id: 'u-' + role, name: 'Teste ' + role, role, ...extra });

(async () => {
  const app = express();
  app.use('/api/cs/painel', painel.router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const porta = server.address().port;
  const rotas = ['/api/cs/painel/dados', '/api/cs/painel/churn?ini=2026-01-01&fim=2026-01-31', '/api/cs/painel/cliente/qualquer'];

  await teste('sem login: 401 em todas as rotas', async () => {
    for (const r of rotas) assert.strictEqual((await chamar(porta, r)).status, 401, r);
  });
  await teste('token inválido: 401', async () => {
    assert.strictEqual((await chamar(porta, rotas[0], 'lixo')).status, 401);
  });
  await teste('contábil e colaborador (mesmo com acessos extras ligados): 403 em todas as rotas', async () => {
    for (const role of ['contabil', 'colaborador']) {
      for (const r of rotas) {
        const t = token(role, { acesso_minha_nota: true, acesso_legalizacao: true });
        assert.strictEqual((await chamar(porta, r, t)).status, 403, role + ' ' + r);
      }
    }
  });
  await teste('administrador e usuário passam pela porta (não recebem 401 nem 403)', async () => {
    for (const role of ['administrador', 'usuario']) {
      const r = await chamar(porta, '/api/cs/painel/churn?ini=2026-01-01&fim=2026-01-31', token(role));
      assert.ok(r.status !== 401 && r.status !== 403, role + ' recebeu ' + r.status);
    }
  });
  await teste('churn: datas inválidas viram 400 (para quem tem acesso)', async () => {
    const r = await chamar(porta, '/api/cs/painel/churn?ini=2026-02-01&fim=2026-01-01', token('administrador'));
    assert.strictEqual(r.status, 400);
  });
  await teste('ultimosMeses: janelas mensais e mês corrente até hoje', async () => {
    const m = painel.ultimosMeses('2026-10-07', 3);
    assert.deepStrictEqual(m.map((x) => [x.mes, x.ini, x.fim]), [['2026-08', '2026-08-01', '2026-08-31'], ['2026-09', '2026-09-01', '2026-09-30'], ['2026-10', '2026-10-01', '2026-10-07']]);
  });
  await teste('próximo passo: segue o termômetro que mais pesa; risco baixo = sem ação', async () => {
    const mk = (nivel, t) => ({ risco: { nivel, termometros: t } });
    assert.ok(/regulariza/i.test(painel.proximoPasso(mk('Alto', { financeiro: 90, atendimento: 10, operacional: null }), { financeiro: [{ qtd_atrasados: 3 }] })));
    assert.ok(/ligar/i.test(painel.proximoPasso(mk('Médio', { financeiro: 10, atendimento: 60, operacional: null }), { financeiro: [] })));
    assert.ok(/Acessórias/.test(painel.proximoPasso(mk('Alto', { financeiro: 0, atendimento: 0, operacional: 80 }), { financeiro: [] })));
    assert.ok(/sem ação/i.test(painel.proximoPasso(mk('Baixo', { financeiro: 0, atendimento: 0, operacional: null }), { financeiro: [] })));
    const susp = painel.proximoPasso({ risco: { nivel: 'Médio', suspenso: true, termometros: { financeiro: 100, atendimento: 0, operacional: null } } }, { financeiro: [{ qtd_atrasados: 3 }] });
    assert.ok(/suspenso no Omie/.test(susp) && /reativar o contrato/.test(susp), susp);
  });

  await teste('valores em R$: só o administrador recebe; Usuário recebe tudo oculto (honorário, soma do grupo, títulos)', async () => {
    assert.strictEqual(painel.veValores('administrador'), true);
    assert.strictEqual(painel.veValores('usuario'), false);
    assert.strictEqual(painel.veValores(undefined), false);
    const base = { totais: { clientes: 2 }, clientes: [
      { id: 'a', nome: 'A', honorario: 1250, categoria: 'Diamante', categoria_motivo: 'honorário R$ 1.250,00 (faixa a partir de R$ 1.000)' },
      { id: 'b', nome: 'B', honorario: null, categoria: 'Ouro', categoria_motivo: 'soma do grupo "X", 3 empresas: R$ 2.600,50 (faixa R$ 500 a 999)' },
    ] };
    const m = painel.mascararBase(base);
    assert.strictEqual(m.valores_ocultos, true);
    assert.ok(m.clientes.every((c) => c.honorario === null));
    assert.strictEqual(m.clientes[0].categoria_motivo, 'honorário R$ •••• (faixa a partir de R$ 1.000)');
    assert.strictEqual(m.clientes[1].categoria_motivo, 'soma do grupo "X", 3 empresas: R$ •••• (faixa R$ 500 a 999)');
    assert.strictEqual(base.clientes[0].honorario, 1250);               // não altera o cache compartilhado
    assert.ok(!JSON.stringify(m).includes('1.250') && !JSON.stringify(m).includes('2.600'));
    const f = painel.mascararFicha({ cliente: base.clientes[0], financeiro: [{ unidade: 'U', qtd: 2, valor_aberto: 900, valor_atrasado: 450, qtd_atrasados: 1 }], tickets: [] });
    assert.strictEqual(f.cliente.honorario, null);
    assert.deepStrictEqual([f.financeiro[0].valor_aberto, f.financeiro[0].valor_atrasado, f.financeiro[0].qtd_atrasados], [null, null, 1]);
  });

  server.close();
  console.log(`\n${ok} testes passaram.`);
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
