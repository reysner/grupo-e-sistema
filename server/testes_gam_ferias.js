'use strict';
// Rodar: node server/testes_gam_ferias.js  (Consolidado Geral da Gamificação com meses de férias; sem banco: o pool é simulado)
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fonte = fs.readFileSync(path.join(__dirname, 'routes', 'data.js'), 'utf8');
const a = fonte.indexOf('async function calcularConsolidadoGamificacao'), b = fonte.indexOf('// ── GAMIFICAÇÃO — rota pública', a);
assert.ok(a > 0 && b > a, 'função do consolidado encontrada');
const corpo = fonte.slice(a, b);

let ok = 0;
const teste = async (nome, fn) => { await fn(); ok++; console.log('  ok -', nome); };

/** Banco simulado: só responde as consultas que o consolidado faz. */
function poolSimulado({ colabs, notas, ferias, ferias_quebrada }) {
  return {
    query: async (sql, params) => {
      if (/SELECT DISTINCT mes FROM gam_notas/.test(sql)) return { rows: [...new Set(notas.map((n) => n.mes))].sort().map((mes) => ({ mes })) };
      if (/FROM gam_colaboradores WHERE ativo = true/.test(sql)) return { rows: colabs.map((c) => ({ id: c.id, nome: c.nome })) };
      if (/FROM gam_notas n/.test(sql)) return { rows: notas.filter((n) => n.mes === params[0]).map((n) => ({ id: n.id, nome: colabs.find((c) => c.id === n.id).nome, media_individual: n.mi, avaliacoes: n.av })) };
      if (/FROM gam_ferias/.test(sql)) { if (ferias_quebrada) throw new Error('tabela inexistente'); return { rows: (ferias || []).map((f) => ({ colaborador_id: f.id, mes: f.mes })) }; }
      throw new Error('consulta inesperada: ' + sql);
    },
  };
}
const consolidar = (cenario, peso = 10) => new Function('pool', corpo + '\nreturn calcularConsolidadoGamificacao;')(poolSimulado(cenario))(peso);

const colabs = [{ id: 'k', nome: 'Kelen' }, { id: 'm', nome: 'Max' }];
// Kelen: julho com 6 avaliações e média 4,67 (férias); Max normal nos três meses
const notas = [
  { id: 'k', mes: '2026-06', mi: 4.95, av: 15 }, { id: 'm', mes: '2026-06', mi: 4.95, av: 15 },
  { id: 'k', mes: '2026-07', mi: 4.67, av: 6 }, { id: 'm', mes: '2026-07', mi: 5, av: 39 },
  { id: 'k', mes: '2026-08', mi: 4.97, av: 29 }, { id: 'm', mes: '2026-08', mi: 5, av: 43 },
];

(async () => {
  const sem = await consolidar({ colabs, notas });
  const k0 = sem.find((x) => x.nome === 'Kelen');
  await teste('sem férias marcadas, tudo igual a antes: média simples de todos os meses', () => {
    assert.strictEqual(k0.meses_avaliados, 3);
    assert.strictEqual(k0.meses_ferias, 0);
    assert.strictEqual(k0.media_geral, k0.media_sem_ajuste);
  });

  const com = await consolidar({ colabs, notas, ferias: [{ id: 'k', mes: '2026-07' }] });
  const k1 = com.find((x) => x.nome === 'Kelen'), m1 = com.find((x) => x.nome === 'Max'), m0 = sem.find((x) => x.nome === 'Max');
  await teste('o mês de férias sai da média da própria pessoa: sobem a média e a contagem de férias, caem os meses usados', () => {
    assert.strictEqual(k1.meses_avaliados, 2);
    assert.strictEqual(k1.meses_ferias, 1);
    assert.ok(parseFloat(k1.media_geral) > parseFloat(k0.media_geral), 'a média da Kelen sobe');
    assert.strictEqual(k1.media_sem_ajuste, k0.media_geral, 'guarda a média sem o ajuste para transparência');
  });
  await teste('é o mesmo que trocar a nota do mês pela média dos outros meses dela', () => {
    // nota final de cada mês da Kelen = (mi*av + mediaGeralDoMes*peso)/(av+peso); mediaGeral do mês = média simples das médias de quem tem avaliação
    const nf = (mi, av, mg) => (mi * av + mg * 10) / (av + 10);
    const jun = nf(4.95, 15, (4.95 + 4.95) / 2), ago = nf(4.97, 29, (4.97 + 5) / 2);
    assert.strictEqual(k1.media_geral, ((jun + ago) / 2).toFixed(4));
    const ju = nf(4.67, 6, (4.67 + 5) / 2);
    const trocado = (jun + (jun + ago) / 2 + ago) / 3;   // julho trocado pela média dos outros dois
    assert.strictEqual(trocado.toFixed(4), k1.media_geral, 'média com o mês trocado = média sem o mês');
    assert.ok(ju < jun && ju < ago, 'o mês de férias realmente era o mais baixo');
  });
  await teste('as férias de uma pessoa não mexem na média dos outros', () => {
    assert.strictEqual(m1.media_geral, m0.media_geral);
    assert.strictEqual(m1.meses_ferias, 0);
  });
  await teste('todos os meses da pessoa marcados: não há outra base, segue com todos (nunca fica sem nota)', async () => {
    const tudo = await consolidar({ colabs, notas, ferias: [{ id: 'k', mes: '2026-06' }, { id: 'k', mes: '2026-07' }, { id: 'k', mes: '2026-08' }] });
    const k = tudo.find((x) => x.nome === 'Kelen');
    assert.strictEqual(k.meses_avaliados, 3);
    assert.strictEqual(k.meses_ferias, 0);
    assert.strictEqual(k.media_geral, k0.media_geral);
  });
  await teste('tabela de férias indisponível: o consolidado continua funcionando sem ninguém em férias', async () => {
    const r = await consolidar({ colabs, notas, ferias_quebrada: true });
    assert.strictEqual(r.find((x) => x.nome === 'Kelen').media_geral, k0.media_geral);
  });
  await teste('o consolidado diz QUAIS meses são de férias (o Relatório da Temporada mostra a média dos outros no lugar)', () => {
    assert.deepStrictEqual(k1.ferias_meses, ['2026-07']);
    assert.deepStrictEqual(m1.ferias_meses, []);
    assert.deepStrictEqual(k0.ferias_meses, []);
  });
  await teste('Relatório da Temporada: mês de férias vira a média dos outros meses, marcado com †, e não serve de ponta da evolução', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    const i = app.indexOf('function _montarRelatorioTemporada'), j = app.indexOf('const destaqueEvolucao', i);
    const rel = app.slice(i, j);
    assert.ok(rel.includes('c.ferias_meses') && rel.includes('ferias: true, notaReal: p.nota'), 'a trajetória troca a nota do mês de férias pela média dos outros');
    assert.ok(rel.includes('!p.ferias') && rel.includes("p.ferias ? '<td class=\"ferias\""), 'não é ponta da evolução e a célula sai marcada');
    assert.ok(app.includes('<b>†</b> = mês de férias ou afastamento'), 'a legenda explica o †');
  });
  await teste('as rotas de férias são só do administrador', () => {
    assert.ok(/router\.post\('\/gam\/ferias', requireAdmin/.test(fonte) && /router\.delete\('\/gam\/ferias', requireAdmin/.test(fonte));
  });
  console.log(`\n${ok} testes passaram.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
