'use strict';
// Rodar: node server/cs/testes_risco.js  (lógica pura, sem banco nem rede)
const assert = require('assert');
const { termometroFinanceiro, termometroAtendimento, termometroOperacional, termometroTratativas, calcularRisco, diasEntre } = require('./riscoCalculo');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };
const HOJE = '2026-10-06';

teste('diasEntre', () => {
  assert.strictEqual(diasEntre('2026-09-06', '2026-10-06'), 30);
  assert.strictEqual(diasEntre('2026-10-06', '2026-10-06'), 0);
});

teste('financeiro: sem dado do Omie não é presumido em dia', () => {
  assert.strictEqual(termometroFinanceiro({ temDado: false }).pontos, null);
  assert.strictEqual(termometroFinanceiro(null).pontos, null);
});

teste('financeiro: em dia = 0; atraso cresce com os dias; 3+ títulos somam 10; crônico garante 70', () => {
  const base = { temDado: true, hoje: HOJE, valorAtrasado: 500 };
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 0 }).pontos, 0);
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 1, maisAntigo: '2026-10-01' }).pontos, 25);   // 5 dias
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 1, maisAntigo: '2026-09-15' }).pontos, 40);   // 21 dias
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 1, maisAntigo: '2026-08-25' }).pontos, 60);   // 42 dias
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 1, maisAntigo: '2026-07-30' }).pontos, 75);   // 68 dias
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 1, maisAntigo: '2026-05-01' }).pontos, 90);   // 158 dias
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 3, maisAntigo: '2026-10-01' }).pontos, 35);   // 25 + 10
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 6, maisAntigo: '2026-05-01' }).pontos, 100);  // limitado a 100
  assert.strictEqual(termometroFinanceiro({ ...base, qtdAtrasados: 0, cronico: true }).pontos, 70);
  assert.ok(termometroFinanceiro({ ...base, qtdAtrasados: 2, maisAntigo: '2026-09-15' }).detalhe[0].includes('2 títulos'));
});

teste('atendimento: sem ocorrências = 0 e explica', () => {
  const r = termometroAtendimento({ tickets90: 4 });
  assert.strictEqual(r.pontos, 0);
  assert.ok(r.detalhe[0].includes('Sem ocorrências'));
  assert.ok(termometroAtendimento({}).detalhe[0].includes('Sem atendimentos'));
});

teste('atendimento: insatisfação pesa pela gravidade e perde metade depois de 90 dias', () => {
  assert.strictEqual(termometroAtendimento({ insatisfacoes: [{ gravidade: 'Alta', dias: 10 }] }).pontos, 30);
  assert.strictEqual(termometroAtendimento({ insatisfacoes: [{ gravidade: 'Muito Alta', dias: 120 }] }).pontos, 20);
  assert.strictEqual(termometroAtendimento({ insatisfacoes: [{ gravidade: 'Média', dias: 200 }] }).pontos, 0); // fora da janela
  assert.strictEqual(termometroAtendimento({ insatisfacoes: [{ gravidade: 'Muito alta', dias: 5 }, { gravidade: 'Alta', dias: 5 }, { gravidade: 'Alta', dias: 5 }] }).pontos, 100);
});

teste('atendimento: notas baixas, SLA vermelho, detratores e sensíveis somam e respeitam o teto', () => {
  assert.strictEqual(termometroAtendimento({ notasBaixas: 2 }).pontos, 40);
  assert.strictEqual(termometroAtendimento({ slaVermelho: 10 }).pontos, 20);
  assert.strictEqual(termometroAtendimento({ detratores: 5 }).pontos, 30);
  assert.strictEqual(termometroAtendimento({ sensiveis: [{ gravidade: 'Alta', dias: 30 }] }).pontos, 22);
  assert.strictEqual(termometroAtendimento({ notasBaixas: 3, slaVermelho: 4, detratores: 2 }).pontos, 100); // 60+20+30 = 110 -> 100
});

teste('atendimento: a Qualidade não pesa mais aqui (virou o termômetro Tratativas)', () => {
  assert.strictEqual(termometroAtendimento({ qualidade: [{ tipo: 'Multa', status: 'aberto', dias: 5 }] }).pontos, 0);
});

teste('tratativas: pesa pelo tipo (dobro), vencida x1,5, a validar x0,5, resolvida x0,25, antiga metade, cancelada não entra, teto 100', () => {
  const t = (qualidade) => termometroTratativas({ qualidade });
  assert.strictEqual(t([{ tipo: 'Multa', status: 'aberto', dias: 5 }]).pontos, 50);
  assert.strictEqual(t([{ tipo: 'Erro', status: 'em_tratamento', dias: 5 }]).pontos, 30);
  assert.strictEqual(t([{ tipo: 'Erro', status: 'aberto', dias: 5, vencida: true }]).pontos, 45);            // prazo vencido: x1,5
  assert.strictEqual(t([{ tipo: 'Erro', status: 'finalizada', dias: 5 }]).pontos, 15);                       // aguardando validação: x0,5
  assert.strictEqual(t([{ tipo: 'Multa', status: 'aberto', dias: 60 }]).pontos, 25);                          // passou de 45 dias: metade
  assert.strictEqual(t([{ tipo: 'Multa', status: 'aberto', dias: 1 }, { tipo: 'Multa', status: 'cancelado', dias: 1 }]).pontos, 50);   // cancelada não entra
  assert.strictEqual(t([{ tipo: 'Multa', status: 'aberto', dias: 1 }, { tipo: 'Multa', status: 'aberto', dias: 1, vencida: true }, { tipo: 'Erro', status: 'aberto', dias: 1 }]).pontos, 100);   // teto
  assert.strictEqual(t([{ tipo: 'Tipo novo', status: 'aberto', dias: 2, peso: 18 }]).pontos, 36);           // peso do cadastro de tipos
  assert.strictEqual(t([{ tipo: 'Multa', status: 'aberto', dias: 2, peso: 0 }]).pontos, 0);                  // peso 0 = só registra, não pesa
  // resolvida entra na soma enquanto houver outra pendente
  assert.strictEqual(t([{ tipo: 'Multa', status: 'aberto', dias: 1 }, { tipo: 'Erro', status: 'resolvido', dias: 1 }]).pontos, 58);   // 50 + 30 x 0,25 = 57,5
  assert.strictEqual(t([{ tipo: 'Atraso', status: 'aberto', dias: 2, vencida: true }]).detalhe[0], '1 ocorrência de qualidade registrada nos últimos 90 dias (1 em aberto, 1 com prazo vencido)');
  assert.strictEqual(t([{ tipo: 'Atraso', status: 'aberto', dias: 2 }, { tipo: 'Erro', status: 'finalizada', dias: 2 }, { tipo: 'Multa', status: 'resolvido', dias: 2 }]).detalhe[0], '3 ocorrências de qualidade registradas nos últimos 90 dias (1 em aberto, 1 aguardando validação)');
});

teste('tratativas: ocorrência já resolvida nos últimos 90 dias aparece nos Sinais de atenção (sem pesar no risco)', () => {
  const t = termometroTratativas({ qualidade: [{ tipo: 'Atraso', status: 'resolvido', dias: 2 }] });
  assert.strictEqual(t.pontos, 5, 'alimenta o card: Atraso 10 x2 x0,25');
  assert.strictEqual(t.foraDaMedia, true, 'mas fica fora da média');
  assert.strictEqual(t.sinal, '1 ocorrência de qualidade registrada nos últimos 90 dias (1 resolvida · Atraso)');
  const r = calcularRisco({ financeiro: { pontos: 0, detalhe: ['f'] }, atendimento: { pontos: 0, detalhe: ['a'] }, operacional: { pontos: 0, detalhe: ['o'] }, tratativas: t });
  assert.ok(r.motivos.includes(t.sinal), 'entra nos motivos (Sinais de atenção)');
  assert.strictEqual(r.pontos, 0, 'e o risco continua igual');
  const dois = termometroTratativas({ qualidade: [{ tipo: 'Erro', status: 'resolvido', dias: 5 }, { tipo: 'Multa', status: 'resolvido', dias: 6 }] });
  assert.strictEqual(dois.sinal, '2 ocorrências de qualidade registradas nos últimos 90 dias (2 resolvidas · Erro, Multa)');
  assert.ok(!termometroTratativas({ qualidade: [] }).sinal && termometroTratativas({ qualidade: [] }).pontos === null, 'sem ocorrência, sem sinal e sem dado');
  assert.ok(!termometroTratativas({ qualidade: [{ tipo: 'Atraso', status: 'resolvido', dias: 120 }] }).sinal, 'passou de 90 dias: sem sinal');
  const muitas = termometroTratativas({ qualidade: [1, 2, 3, 4].map(() => ({ tipo: 'Multa', status: 'resolvido', dias: 2 })) });
  assert.strictEqual(muitas.pontos, 25, 'resolvidas valem no máximo 25 no card');
});
teste('tratativas: sem pendência fica sem dado (fora da média) e não deixa o risco parcial', () => {
  assert.strictEqual(termometroTratativas({ qualidade: [] }).pontos, null);
  const so = termometroTratativas({ qualidade: [{ tipo: 'Multa', status: 'resolvido', dias: 3 }] });
  assert.ok(so.pontos > 0 && so.pontos <= 25 && so.foraDaMedia === true, 'só resolvida: alimenta o card, mas fica fora da média');
  assert.strictEqual(termometroTratativas({}).pontos, null);
  const r = calcularRisco({ financeiro: { pontos: 60, detalhe: ['f'] }, atendimento: { pontos: 20, detalhe: ['a'] }, operacional: { pontos: 10, detalhe: ['o'] }, tratativas: { pontos: null, detalhe: ['nada'] } });
  assert.strictEqual(r.parcial, false);
  assert.deepStrictEqual(r.sem_dado, []);
  assert.strictEqual(r.pontos, 30);          // (60+20+10)/3: a Tratativa sem pendência não dilui
  const r2 = calcularRisco({ financeiro: { pontos: 60, detalhe: ['f'] }, atendimento: { pontos: 20, detalhe: ['a'] }, operacional: { pontos: 10, detalhe: ['o'] }, tratativas: so });
  assert.strictEqual(r2.pontos, 30, 'a resolvida (que aparece no card) não dilui a média');
  assert.strictEqual(r2.parcial, false);
});

teste('tratativas: com pendência entra na média, aparece nos motivos e um termômetro muito alto dá alerta', () => {
  const t = termometroTratativas({ qualidade: [{ tipo: 'Multa', status: 'aberto', dias: 2, vencida: true }] });   // 75
  const r = calcularRisco({ financeiro: { pontos: 0, detalhe: ['f'] }, atendimento: { pontos: 0, detalhe: ['a'] }, operacional: { pontos: 0, detalhe: ['o'] }, tratativas: t });
  assert.strictEqual(t.pontos, 75);
  assert.strictEqual(r.pontos, 19);          // 75/4
  assert.strictEqual(r.alerta, true);
  assert.strictEqual(r.nivel, 'Médio');
  assert.ok(r.motivos[0].includes('ocorrência de qualidade registrada nos últimos 90 dias'));
});

teste('atendimento: abandono de atendimento não conta mais (decisão de 16/10/2026)', () => {
  assert.strictEqual(termometroAtendimento({ abandonos: 1 }).pontos, 0);
  assert.strictEqual(termometroAtendimento({ abandonos: 5 }).pontos, 0);
  assert.ok(!termometroAtendimento({ abandonos: 2 }).detalhe.join(' ').includes('abandono'));
});

teste('operacional: sem entregas = sem dado; 50% de problema = 100', () => {
  assert.strictEqual(termometroOperacional({ temDado: false }).pontos, null);
  assert.strictEqual(termometroOperacional({ temDado: true, total: 0 }).pontos, null);
  assert.strictEqual(termometroOperacional({ temDado: true, total: 20, atrasadasEntregues: 0, vencidasPendentes: 0 }).pontos, 0);
  assert.strictEqual(termometroOperacional({ temDado: true, total: 20, atrasadasEntregues: 1, vencidasPendentes: 1 }).pontos, 20);
  assert.strictEqual(termometroOperacional({ temDado: true, total: 10, atrasadasEntregues: 3, vencidasPendentes: 2 }).pontos, 100);
});

teste('risco: média ponderada dos termômetros com dado (pesos iguais) e níveis', () => {
  const t = (f, a, o) => ({ financeiro: { pontos: f, detalhe: ['f'] }, atendimento: { pontos: a, detalhe: ['a'] }, operacional: { pontos: o, detalhe: ['o'] } });
  assert.strictEqual(calcularRisco(t(0, 0, 0)).nivel, 'Baixo');
  const medio = calcularRisco(t(40, 40, 40)); assert.deepStrictEqual([medio.pontos, medio.nivel], [40, 'Médio']);
  const alto = calcularRisco(t(70, 70, 70)); assert.deepStrictEqual([alto.pontos, alto.nivel], [70, 'Alto']);
});

teste('risco: termômetro sem dado fica de fora (não vira zero) e o risco é parcial', () => {
  const r = calcularRisco({ financeiro: { pontos: 60, detalhe: ['f'] }, atendimento: { pontos: 20, detalhe: ['a'] }, operacional: { pontos: null, detalhe: ['sem dado'] } });
  assert.strictEqual(r.pontos, 40);      // (60+20)/2, não (60+20+0)/3
  assert.strictEqual(r.parcial, true);
  assert.deepStrictEqual(r.sem_dado, ['operacional']);
});

teste('risco: um termômetro muito alto sozinho dá alerta e sobe pra Médio', () => {
  const r = calcularRisco({ financeiro: { pontos: 90, detalhe: ['f'] }, atendimento: { pontos: 0, detalhe: ['a'] }, operacional: { pontos: 0, detalhe: ['o'] } });
  assert.strictEqual(r.pontos, 30);      // 90/3 = 30 -> já seria Médio
  assert.strictEqual(r.alerta, true);
  const r2 = calcularRisco({ financeiro: { pontos: 80, detalhe: ['f'] }, atendimento: { pontos: 0, detalhe: ['a'] }, operacional: { pontos: 0, detalhe: ['o'] }, }, { financeiro: 1, atendimento: 1, operacional: 5 });
  assert.strictEqual(r2.pontos, 11);     // pesos mudam a conta: 80/7
  assert.strictEqual(r2.nivel, 'Médio'); // mas o alerta impede de ficar Baixo
});

teste('risco: sem nenhum dado = Incompleto', () => {
  const r = calcularRisco({ financeiro: { pontos: null }, atendimento: { pontos: null }, operacional: { pontos: null } });
  assert.deepStrictEqual([r.nivel, r.pontos], ['Incompleto', null]);
});

teste('risco: motivos vêm dos termômetros que pesam, do maior pro menor', () => {
  const r = calcularRisco({ financeiro: { pontos: 25, detalhe: ['fin'] }, atendimento: { pontos: 60, detalhe: ['atend1', 'atend2'] }, operacional: { pontos: 0, detalhe: ['oper ok'] } });
  assert.deepStrictEqual(r.motivos, ['atend1', 'atend2', 'fin']);
});

teste('entregas: usa o Status do Acessórias (PzTéc não é atraso; dispensada não conta; Atrasada! e pendente vencida são problema)', () => {
  const { classificarEntregas } = require('./risco');
  const g = { nome: 'DAS - MENSAL', multa: true }; // entrega que chega ao cliente
  const lista = [
    { ...g, status: 'Ent. antecipada', prazo: '2026-07-10', atraso: '2026-07-15', entrega: '2026-07-09' },
    { ...g, status: 'Ent. PzTéc', prazo: '2026-08-09', atraso: '2026-08-14', entrega: '2026-08-11' },
    { ...g, status: 'Ent. atrasada', prazo: '2026-08-09', atraso: '2026-08-14', entrega: '2026-08-20' },
    { ...g, status: 'Atrasada!', prazo: '2026-07-26', atraso: '2026-07-31', entrega: null },
    { ...g, status: 'Dispensada', prazo: '2026-08-07', atraso: '2026-08-14', entrega: null },
    { ...g, status: 'Pendente', prazo: '2026-09-01', atraso: '2026-09-05', entrega: null },
    { ...g, status: 'Pendente', prazo: '2026-10-20', atraso: '2026-10-25', entrega: null },
    { nome: 'BALANCETE', multa: false, status: 'Atrasada!', prazo: '2026-07-26', atraso: '2026-07-31', entrega: null }, // interna: não conta
  ];
  assert.deepStrictEqual(classificarEntregas(lista, HOJE), { total: 6, atrasadasEntregues: 1, vencidasPendentes: 2 });
  assert.deepStrictEqual(classificarEntregas([], HOJE), { total: 0, atrasadasEntregues: 0, vencidasPendentes: 0 });
});

teste('entregas: a lista da ficha traz só as com problema (vencidas primeiro), ignora dispensada e tarefa interna, e bate com a contagem', () => {
  const { classificarEntregas, detalharEntregas } = require('./risco');
  const g = { multa: true };
  const lista = [
    { ...g, nome: 'DAS - MENSAL', competencia: '09/2026', status: 'Atrasada!', prazo: '2026-10-05', atraso: '2026-10-10', entrega: null },
    { ...g, nome: 'FGTS', competencia: '08/2026', status: 'Ent. atrasada', prazo: '2026-09-05', atraso: '2026-09-07', entrega: '2026-09-20' },
    { ...g, nome: 'DCTFWEB', competencia: '07/2026', status: 'Pendente', prazo: '2026-08-10', atraso: '2026-08-15', entrega: null },
    { ...g, nome: 'PGDAS', status: 'Ent. antecipada', prazo: '2026-10-01', atraso: '2026-10-05', entrega: '2026-09-30' },
    { ...g, nome: 'IRPF', status: 'Dispensada', prazo: '2026-04-01', atraso: '2026-04-05', entrega: null },
    { multa: false, nome: 'BALANCETE MENSAL', status: 'Atrasada!', prazo: '2026-07-01', atraso: '2026-07-05', entrega: null },
  ];
  const d = detalharEntregas(lista, '2026-10-17');
  assert.deepStrictEqual(d.map((i) => i.nome + ':' + i.situacao), ['DCTFWEB:vencida', 'DAS - MENSAL:vencida', 'FGTS:atrasada']);   // vencidas primeiro, a mais antiga antes
  assert.strictEqual(d[0].competencia, '07/2026');
  const c = classificarEntregas(lista, '2026-10-17');
  assert.deepStrictEqual([c.total, c.atrasadasEntregues, c.vencidasPendentes], [4, 1, 2]);
  assert.strictEqual(d.length, c.atrasadasEntregues + c.vencidasPendentes);
  assert.deepStrictEqual(detalharEntregas([], '2026-10-17'), []);
});

teste('entregas: só as que chegam ao cliente (nomes reais do Acessórias)', () => {
  const { entregaChegaAoCliente: chega } = require('./risco');
  // contam: guias e declarações (multa), folha, FGTS, DCTFWeb, "para o e-mail do cliente"
  [['ISS RETIDO', true], ['DAS - MENSAL', true], ['DARF MIT PIS E COFINS', true], ['FGTS DIGITAL', false], ['ADIANTAMENTO DE SALARIO', false],
    ['RELAÇÃO LIQUIDO DA FOLHA MENSAL', false], ['RECIBO DE ENTREGA DCTFWEB', false], ['ENVIO DE PROVISÃO DE IRPJ E CSLL PARA O E-MAIL DO CLIENTE', false],
    ['RE - RELATORIO DE EMPREGADOS - FGTS DIGITAL', false], ['DEMONSTRATIVO CÁLCULO INSS', false]]
    .forEach(([nome, multa]) => assert.strictEqual(chega({ nome, multa }), true, nome));
  // não contam: tarefas internas
  [['BALANCETE', false], ['NIVER SOCIO FULANO 12/08/1972', false], ['RENOVAR CERTIFICADO - A3', false], ['CADASTRO GOB', false],
    ['RELATORIO FÉRIAS VENCIDAS E A VENCER', false], ['RELATORIO EMPRESTIMO CONSIGNADO DO TRABALHADOR', false],
    ['ENVIAR RELATÓRIO DCTFWEB -DEPTO PESSOAL AO FISCAL', true], ['RENOVAR ALVARÁ DE FUNCIONAMENTO - CMC: 1', false]]
    .forEach(([nome, multa]) => assert.strictEqual(chega({ nome, multa }), false, nome));
});

teste('operacional: amostra mínima de 5 entregas ("1 de 2" não vira 100)', () => {
  const o2 = termometroOperacional({ temDado: true, total: 2, atrasadasEntregues: 0, vencidasPendentes: 1 });
  assert.strictEqual(o2.pontos, null);
  assert.ok(o2.detalhe[0].includes('Só 2 entregas') && o2.detalhe[0].includes('mínimo 5'), o2.detalhe[0]);
  assert.ok(termometroOperacional({ temDado: true, total: 1, atrasadasEntregues: 1, vencidasPendentes: 0 }).detalhe[0].includes('Só 1 entrega '));
  assert.strictEqual(termometroOperacional({ temDado: true, total: 4, atrasadasEntregues: 0, vencidasPendentes: 4 }).pontos, null);
  assert.strictEqual(termometroOperacional({ temDado: true, total: 5, atrasadasEntregues: 0, vencidasPendentes: 3 }).pontos, 100); // 5 já conta
});

teste('operacional: empresa com contrato suspenso no Omie fica sem dado (não conta duas vezes) e o risco usa só os outros termômetros', () => {
  const o = termometroOperacional({ temDado: true, total: 28, atrasadasEntregues: 0, vencidasPendentes: 25, suspenso: true });
  assert.strictEqual(o.pontos, null);
  assert.ok(o.detalhe[0].includes('suspenso no Omie'), o.detalhe[0]);
  // Financeiro 100 + Atendimento 0 + Operacional suspenso: (100 + 0) / 2 = 50 (Médio), antes dava 67 (Alto)
  const r = calcularRisco({ financeiro: { pontos: 100, detalhe: ['f'] }, atendimento: { pontos: 0, detalhe: ['a'] }, operacional: o });
  assert.deepStrictEqual([r.pontos, r.nivel, r.parcial], [50, 'Médio', true]);
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
