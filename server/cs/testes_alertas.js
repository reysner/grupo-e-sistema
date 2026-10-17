'use strict';
// Rodar: node server/cs/testes_alertas.js  (alerta de prazo das ocorrências do módulo Qualidade)
const assert = require('assert');
const A = require('./alertasPrazo');

let ok = 0;
const teste = async (nome, fn) => { await fn(); ok++; console.log('  ok -', nome); };

(async () => {
  await teste('dias até o prazo e nível do alerta: amanhã, hoje e vencida (só nos últimos 7 dias); longe ou muito antigo não avisa', () => {
    assert.strictEqual(A.diasAte('2026-10-19', '2026-10-18'), 1);
    assert.strictEqual(A.diasAte('2026-10-18', '2026-10-18'), 0);
    assert.strictEqual(A.diasAte('2026-10-17', '2026-10-18'), -1);
    assert.strictEqual(A.diasAte('2026-11-01', '2026-10-18'), 14);
    assert.strictEqual(A.diasAte('2026-11-01T10:00:00Z', '2026-10-18'), 14, 'aceita data com hora');
    assert.strictEqual(A.diasAte('lixo', '2026-10-18'), null);
    assert.strictEqual(A.diasAte(null, '2026-10-18'), null);
    assert.strictEqual(A.diasAte('2026-03-01', '2026-02-28'), 1, 'vira o mês');
    assert.strictEqual(A.nivelDoAlerta(1), 'amanha');
    assert.strictEqual(A.nivelDoAlerta(0), 'hoje');
    assert.strictEqual(A.nivelDoAlerta(-1), 'vencida');
    assert.strictEqual(A.nivelDoAlerta(-7), 'vencida');
    assert.strictEqual(A.nivelDoAlerta(-8), null, 'vencida há muito tempo não gera aviso novo');
    assert.strictEqual(A.nivelDoAlerta(2), null);
    assert.strictEqual(A.nivelDoAlerta(null), null);
  });

  await teste('quem recebe depende da etapa; texto traz empresa, assunto, prazo e onde está parada', () => {
    assert.deepStrictEqual(A.destinoDoAlerta('com_analista'), ['responsaveis', 'gestores']);
    assert.deepStrictEqual(A.destinoDoAlerta('registrada'), ['gestores']);
    assert.deepStrictEqual(A.destinoDoAlerta('validacao_gestor'), ['gestores']);
    assert.deepStrictEqual(A.destinoDoAlerta('devolutiva_cliente'), ['sucesso']);
    assert.deepStrictEqual(A.destinoDoAlerta('encerrada'), [], 'encerrada não precisa de aviso');
    assert.deepStrictEqual(A.destinoDoAlerta('cancelada'), []);
    const t = A.textoDoAlerta('hoje', { cliente_nome: 'ALFA LTDA', assunto: 'Guia errada', prazo: '2026-10-18', etapa: 'com_analista' });
    assert.strictEqual(t.titulo, 'Prazo vence hoje');
    assert.strictEqual(t.texto, 'ALFA LTDA — Guia errada · prazo 18/10/2026 · com o analista');
    assert.strictEqual(A.textoDoAlerta('amanha', { prazo: '2026-10-19', etapa: 'registrada' }).titulo, 'Prazo vence amanhã');
    assert.strictEqual(A.textoDoAlerta('vencida', { prazo: '2026-10-17', etapa: 'validacao_gestor' }).titulo, 'Prazo vencido');
  });

  await teste('rodar: avisa cada ocorrência uma vez só (reexecutar no mesmo dia não repete) e manda para quem a etapa pede', async () => {
    const vistos = new Set();
    const regs = [
      { id: 'r1', cliente_nome: 'ALFA', assunto: 'A', etapa: 'com_analista', departamentos: ['Fiscal'], fila: 'gestor', analista_id: '7', prazo: '2026-10-19' },
      { id: 'r2', cliente_nome: 'BETA', assunto: 'B', etapa: 'devolutiva_cliente', departamentos: ['Pessoal'], fila: 'gestor', analista_id: '8', prazo: '2026-10-18' },
      { id: 'r3', cliente_nome: 'GAMA', assunto: 'C', etapa: 'registrada', departamentos: ['Fiscal'], fila: 'sucesso', analista_id: null, prazo: '2026-10-15' },
      { id: 'r4', cliente_nome: 'DELTA', assunto: 'D', etapa: 'com_analista', departamentos: ['Fiscal'], fila: 'gestor', analista_id: '9', prazo: '2026-11-30' },
    ];
    const pool = { query: async (sql, p) => {
      if (/CREATE TABLE|ALTER TABLE/i.test(sql)) return { rows: [] };
      if (/FROM cs_qualidade_registros/i.test(sql)) return { rows: regs };
      if (/INSERT INTO cs_qualidade_alertas/i.test(sql)) { const k = p.join('|'); if (vistos.has(k)) return { rows: [] }; vistos.add(k); return { rows: [{ registro_id: p[0] }] }; }
      return { rows: [] };
    } };
    const pushes = [], sino = [], logs = [];
    const deps = {
      pool, hoje: '2026-10-18',
      idsGestoresDe: async (d) => ['g-' + d.join(',')], idsDosResponsaveis: async (id) => ['resp-' + id], idsSucesso: async () => ['sucesso'],
      avisarPush: async (buscar, aviso) => { pushes.push({ ids: await buscar(), titulo: aviso.titulo, url: aviso.url }); },
      notificar: async (t, m) => { sino.push(t + ' | ' + m); }, registrarLog: async (t) => { logs.push(t); },
    };
    const r1 = await A.rodar(deps);
    assert.deepStrictEqual(r1, { avaliadas: 4, enviados: 3 }, 'r4 está longe do prazo: sem aviso');
    const por = (id) => pushes.find((x) => x.ids.length && x.titulo && x.ids.join(',').includes(id));
    assert.deepStrictEqual(pushes[0], { ids: ['resp-r1', 'g-Fiscal'], titulo: 'Prazo vence amanhã', url: '/cs?aba=analista' }, 'com o analista: responsáveis e gestor');
    assert.deepStrictEqual(pushes[1], { ids: ['sucesso'], titulo: 'Prazo vence hoje', url: '/cs?aba=sucesso' }, 'devolutiva: Sucesso do Cliente');
    assert.deepStrictEqual(pushes[2], { ids: ['sucesso'], titulo: 'Prazo vencido', url: '/cs?aba=gestor' }, 'fila do Sucesso (sem gestor): vai para o Sucesso do Cliente');
    assert.strictEqual(sino.length, 3);
    assert.strictEqual(logs.length, 3);
    assert.ok(logs[0].includes('ALFA — A'));
    const r2 = await A.rodar(deps);
    assert.deepStrictEqual(r2, { avaliadas: 4, enviados: 0 }, 'segunda execução no mesmo dia não repete nada');
    // o prazo mudou: o aviso vale de novo
    regs[0] = Object.assign({}, regs[0], { prazo: '2026-10-18' });
    const r3 = await A.rodar(deps);
    assert.strictEqual(r3.enviados, 1, 'prazo novo, aviso novo');
    assert.strictEqual(pushes[3].titulo, 'Prazo vence hoje');
  });

  console.log(`\n${ok} testes passaram.`);
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
