'use strict';
// Rodar: node server/cs/testes_qualidade.js  (validação dos registros de Qualidade; sem banco)
const assert = require('assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
const { TIPO_PLANO, idsResponsaveis, validarTipo, validarRegistro, validarMudanca, situacao, semAcento, TIPOS, DEPARTAMENTOS, mesmoNome, montarPrioridades, segundaDe } = require('./qualidade');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };
const HOJE = '2026-10-16';
const base = { cliente_id: '123', tipo: 'Erro', departamentos: ['Fiscal'], detalhe: 'Guia enviada com valor errado ao cliente.', analista_id: '7', prazo: '2026-10-20' };

teste('aceita um registro completo e limpa os espaços', () => {
  const v = validarRegistro(Object.assign({}, base, { detalhe: '  Guia   enviada com valor errado  ' }), HOJE);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.valores.detalhe, 'Guia enviada com valor errado');
  assert.deepStrictEqual(v.valores.departamentos, ['Fiscal']);
});
teste('tipos aceitos são os sete combinados; qualquer outro é recusado', () => {
  assert.deepStrictEqual(TIPOS, ['Multa', 'Erro', 'Reclamação', 'Atraso', 'Falha de atendimento', 'Falha técnica', 'Outros']);
  TIPOS.forEach((t) => assert.strictEqual(validarRegistro(Object.assign({}, base, { tipo: t }), HOJE).ok, true, t));
  assert.strictEqual(validarRegistro(Object.assign({}, base, { tipo: 'Elogio' }), HOJE).ok, false);
});
teste('"Todos" vira todos os departamentos; departamento desconhecido é ignorado; vazio é recusado', () => {
  assert.deepStrictEqual(validarRegistro(Object.assign({}, base, { departamentos: ['Todos'] }), HOJE).valores.departamentos, DEPARTAMENTOS);
  assert.deepStrictEqual(validarRegistro(Object.assign({}, base, { departamentos: ['Fiscal', 'Marte', 'Contábil'] }), HOJE).valores.departamentos, ['Contábil', 'Fiscal']);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { departamentos: ['Marte'] }), HOJE).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { departamentos: [] }), HOJE).ok, false);
});
teste('descrição: mínimo de 5 e máximo de 600 caracteres', () => {
  assert.strictEqual(validarRegistro(Object.assign({}, base, { detalhe: 'oi' }), HOJE).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { detalhe: 'a'.repeat(600) }), HOJE).ok, true);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { detalhe: 'a'.repeat(601) }), HOJE).ok, false);
});
teste('prazo: hoje vale, ontem não, além de um ano não; cliente e analista são obrigatórios', () => {
  assert.strictEqual(validarRegistro(Object.assign({}, base, { prazo: '2026-10-16' }), HOJE).ok, true);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { prazo: '2026-10-15' }), HOJE).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { prazo: '2027-10-17' }), HOJE).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { prazo: '16/10/2026' }), HOJE).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { cliente_id: '' }), HOJE).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { analista_id: '' }), HOJE).ok, false);
});
teste('mudança: status válido; resolver exige a tratativa; prazo no passado é recusado', () => {
  assert.strictEqual(validarMudanca({ status: 'em_tratamento' }, HOJE).ok, true);
  assert.strictEqual(validarMudanca({ status: 'resolvido' }, HOJE).ok, false);
  assert.strictEqual(validarMudanca({ status: 'resolvido', tratativa: 'Guia reenviada e cliente avisado' }, HOJE).ok, true);
  assert.strictEqual(validarMudanca({ status: 'sumiu' }, HOJE).ok, false);
  assert.strictEqual(validarMudanca({ prazo: '2026-10-01' }, HOJE).ok, false);
  assert.strictEqual(validarMudanca({}, HOJE).ok, false);
});
teste('situação: aberto ou em tratamento com prazo vencido vira "vencido"; resolvido nunca', () => {
  assert.strictEqual(situacao('aberto', '2026-10-15', HOJE), 'vencido');
  assert.strictEqual(situacao('em_tratamento', '2026-10-16', HOJE), 'em_tratamento');
  assert.strictEqual(situacao('resolvido', '2026-10-01', HOJE), 'resolvido');
});
teste('o nome do login casa com o analista sem acento nem caixa', () => {
  assert.strictEqual(semAcento('  Denísa  XAVIER '), 'denisa xavier');
});
teste('tipos: aceita um tipo novo na lista permitida; nome e peso são validados', () => {
  assert.strictEqual(validarRegistro(Object.assign({}, base, { tipo: 'Retrabalho' }), HOJE, ['Retrabalho', 'Erro']).ok, true);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { tipo: 'Multa' }), HOJE, ['Retrabalho', 'Erro']).ok, false);
  assert.strictEqual(validarTipo({ nome: 'Retrabalho', peso: '12' }).valores.peso, 12);
  assert.strictEqual(validarTipo({ nome: 'R' }).ok, false);
  assert.strictEqual(validarTipo({ nome: 'x'.repeat(41) }).ok, false);
  assert.strictEqual(validarTipo({ peso: 51 }).ok, false);
  assert.strictEqual(validarTipo({ peso: 0 }).ok, true);
});

teste('plano de ação da ficha: sem tipo vira "Plano de ação"; departamentos, descrição, responsável e prazo seguem obrigatórios', () => {
  const sem = Object.assign({}, base, { tipo: TIPO_PLANO });
  const v = validarRegistro(sem, HOJE, [TIPO_PLANO]);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.valores.tipo, 'Plano de ação');
  assert.strictEqual(validarRegistro(Object.assign({}, sem, { departamentos: [] }), HOJE, [TIPO_PLANO]).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, sem, { detalhe: 'oi' }), HOJE, [TIPO_PLANO]).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, sem, { analista_id: '' }), HOJE, [TIPO_PLANO]).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, sem, { prazo: '2026-10-01' }), HOJE, [TIPO_PLANO]).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { tipo: 'Multa' }), HOJE, [TIPO_PLANO]).ok, false, 'tipo comum não passa na lista só de plano');
});

teste('mais de um responsável: aceita lista ou um só, tira repetidos e vazios, limita a 20', () => {
  assert.deepStrictEqual(idsResponsaveis({ analistas_ids: ['7', '9', '7', '', ' 12 '] }), ['7', '9', '12']);
  assert.deepStrictEqual(idsResponsaveis({ analista_id: '7' }), ['7']);
  assert.deepStrictEqual(idsResponsaveis({ analistas_ids: [], analista_id: '7' }), []);   // lista informada manda, mesmo vazia
  assert.deepStrictEqual(idsResponsaveis({}), []);
  assert.deepStrictEqual(idsResponsaveis(null), []);
  assert.strictEqual(idsResponsaveis({ analistas_ids: Array.from({ length: 30 }, (_, i) => String(i + 1)) }).length, 20);
});

teste('fluxo: finalizar exige o que foi feito; a liderança encerra (resolvido) sem novo texto se a tratativa já existe', () => {
  assert.strictEqual(validarMudanca({ status: 'finalizada' }, HOJE).ok, false);
  assert.strictEqual(validarMudanca({ status: 'finalizada', tratativa: 'Retificação enviada ao cliente' }, HOJE).ok, true);
  assert.strictEqual(validarMudanca({ status: 'resolvido' }, HOJE).ok, false);
  assert.strictEqual(validarMudanca({ status: 'resolvido' }, HOJE, { jaTemTratativa: true }).ok, true);
  assert.strictEqual(situacao('finalizada', '2026-10-01', HOJE), 'finalizada');   // aguardando validação não vira "vencido"
});

teste('mesmo nome: igual sem acento, ou o primeiro nome contra o nome completo; nomes diferentes não casam', () => {
  assert.strictEqual(mesmoNome('Guilherme', 'Guilherme de Barros Amaro'), true);
  assert.strictEqual(mesmoNome('Nathânia Andrade Conceição', 'nathania andrade conceicao'), true);
  assert.strictEqual(mesmoNome('Bruno Xavier', 'Bruno Cesar Xavier'), false);
  assert.strictEqual(mesmoNome('Ivone', 'Ivonete Souza'), false);
  assert.strictEqual(mesmoNome('', 'Ivone'), false);
});

teste('prioridades: vencida e e-mails (3+) primeiro, depois prazo curto, e-mail e SLA; encerradas não entram', () => {
  const p = montarPrioridades({
    registros: [
      { id: 'a', status: 'aberto', prazo: '2026-10-10', tipo: 'Multa', cliente_nome: 'ALFA' },
      { id: 'b', status: 'em_tratamento', prazo: '2026-10-18', tipo: 'Erro', cliente_nome: 'BETA' },
      { id: 'c', status: 'resolvido', prazo: '2026-10-01', tipo: 'Atraso', cliente_nome: 'GAMA' },
      { id: 'd', status: 'aberto', prazo: '2026-12-01', tipo: 'Atraso', cliente_nome: 'DELTA' },
    ],
    emails: [{ cnpj: '1', nome: 'EMAIL-3', sem: 3 }, { cnpj: '2', nome: 'EMAIL-1', sem: 1 }, { cnpj: '3', nome: 'SEM', sem: 0 }],
    slaVermelho: [{ id: 't', cliente_nome: 'SLA-CLI', abertura: '2026-10-12T10:00:00Z' }],
  }, HOJE);
  assert.deepStrictEqual(p.map((x) => x.ref), ['a', '1', 'b', '2', 't']);
  assert.deepStrictEqual(p.map((x) => x.nivel), ['alta', 'alta', 'media', 'media', 'media']);
});

teste('segunda-feira da semana', () => {
  assert.strictEqual(segundaDe('2026-10-16'), '2026-10-12');   // sexta
  assert.strictEqual(segundaDe('2026-10-12'), '2026-10-12');
  assert.strictEqual(segundaDe('2026-10-18'), '2026-10-12');   // domingo
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
