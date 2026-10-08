'use strict';
// Rodar: node server/cs/testes_categorias.js  (lógica pura, não precisa de banco nem de rede)
const assert = require('assert');
// A lógica pura não toca no banco; os requires abaixo só precisam existir.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
const { categorizar, categoriaPorValor, montarEntradas, CORTES_PADRAO } = require('./categorias');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };

teste('limites das faixas (cenário A)', () => {
  const c = CORTES_PADRAO;
  assert.strictEqual(categoriaPorValor(0, c), null);
  assert.strictEqual(categoriaPorValor(null, c), null);
  assert.strictEqual(categoriaPorValor(249.99, c), 'Bronze');
  assert.strictEqual(categoriaPorValor(250, c), 'Prata');
  assert.strictEqual(categoriaPorValor(499.99, c), 'Prata');
  assert.strictEqual(categoriaPorValor(500, c), 'Ouro');
  assert.strictEqual(categoriaPorValor(999.99, c), 'Ouro');
  assert.strictEqual(categoriaPorValor(1000, c), 'Diamante');
});

teste('honorário individual traz o motivo por escrito', () => {
  const r = categorizar({ honorario: 1250, grupos: [], tagsPiso: [] });
  assert.strictEqual(r.categoria, 'Diamante');
  assert.ok(r.motivo.includes('honorário R$') && r.motivo.includes('1.250,00'), r.motivo);
});

teste('TAG Hands dá piso Ouro mesmo sem honorário', () => {
  const r = categorizar({ honorario: null, grupos: [], tagsPiso: ['Hands'] });
  assert.strictEqual(r.categoria, 'Ouro');
  assert.ok(r.motivo.includes('TAG "Hands"') && r.motivo.includes('piso Ouro'), r.motivo);
});

teste('piso Ouro não rebaixa: honorário maior vence', () => {
  const r = categorizar({ honorario: 1500, grupos: [], tagsPiso: ['Devia'] });
  assert.strictEqual(r.categoria, 'Diamante');
  assert.ok(r.motivo.startsWith('honorário'), r.motivo);
});

teste('soma do grupo sobe a categoria e explica o motivo', () => {
  const r = categorizar({ honorario: 300, grupos: [{ nome: 'Grupo Capanema', origem: 'grupo', soma: 1100, qtd: 3 }], tagsPiso: [] });
  assert.strictEqual(r.categoria, 'Diamante');
  assert.ok(r.motivo.includes('grupo "Grupo Capanema"') && r.motivo.includes('3 empresas'), r.motivo);
  assert.strictEqual(r.soma_grupo, 1100);
});

teste('grupo de uma empresa só é ignorado', () => {
  const r = categorizar({ honorario: 300, grupos: [{ nome: 'X', origem: 'grupo', soma: 300, qtd: 1 }], tagsPiso: [] });
  assert.strictEqual(r.categoria, 'Prata');
  assert.ok(r.motivo.startsWith('honorário'));
});

teste('sem honorário, grupo ou TAG: sem categoria, com motivo', () => {
  const r = categorizar({ honorario: 0, grupos: [], tagsPiso: [] });
  assert.strictEqual(r.categoria, null);
  assert.ok(r.motivo.includes('Sem honorário'));
});

teste('montarEntradas: grupo de Gestão de Clientes (sem diferenciar maiúsculas) soma os honorários', () => {
  const clientes = [
    { id: 'a', cnpj: '11.111.111/0001-11', grupo_empresas: 'Grupo Silva', honorario: 400 },
    { id: 'b', cnpj: '22.222.222/0001-22', grupo_empresas: 'grupo silva', honorario: 350 },
    { id: 'c', cnpj: '33.333.333/0001-33', grupo_empresas: null, honorario: 100 },
  ];
  const e = montarEntradas(clientes, []);
  assert.strictEqual(e[0].entrada.grupos[0].soma, 750);
  assert.strictEqual(e[0].entrada.grupos[0].qtd, 2);
  assert.strictEqual(categorizar(e[0].entrada).categoria, 'Ouro');
  assert.strictEqual(categorizar(e[2].entrada).categoria, 'Bronze');
});

teste('montarEntradas: TAG "grupo" soma e TAG "piso_ouro" vira piso', () => {
  const clientes = [
    { id: 'a', cnpj: '11111111000111', grupo_empresas: null, honorario: 300 },
    { id: 'b', cnpj: '22222222000122', grupo_empresas: null, honorario: 300 },
    { id: 'c', cnpj: '33333333000133', grupo_empresas: null, honorario: 50 },
  ];
  const vinculos = [
    { cnpj: '11111111000111', tag_id: '7', tag_nome: 'Familia Souza', tratamento: 'grupo' },
    { cnpj: '22222222000122', tag_id: '7', tag_nome: 'Familia Souza', tratamento: 'grupo' },
    { cnpj: '33333333000133', tag_id: '9', tag_nome: 'Talentos', tratamento: 'piso_ouro' },
  ];
  const e = montarEntradas(clientes, vinculos);
  const a = categorizar(e[0].entrada);
  assert.strictEqual(a.categoria, 'Ouro');
  assert.ok(a.motivo.includes('TAG "Familia Souza"'), a.motivo);
  const c = categorizar(e[2].entrada);
  assert.strictEqual(c.categoria, 'Ouro');
  assert.ok(c.motivo.includes('TAG "Talentos"'), c.motivo);
});

teste('montarEntradas: matriz e filiais (mesma raiz de CNPJ) somam o honorário; filial sem honorário herda a faixa da soma', () => {
  const clientes = [
    { id: 'm', cnpj: '19.111.937/0001-11', grupo_empresas: null, honorario: 400 },
    { id: 'f1', cnpj: '19.111.937/0004-05', grupo_empresas: null, honorario: null },
    { id: 'f2', cnpj: '19.111.937/0006-77', grupo_empresas: null, honorario: 200 },
    { id: 'x', cnpj: '19.111.938/0001-00', grupo_empresas: null, honorario: 900 },   // raiz diferente: não entra
    { id: 'cpf', cnpj: '069.695.846-58', grupo_empresas: null, honorario: 100 },       // CPF: nunca agrupa por raiz
  ];
  const e = montarEntradas(clientes, []);
  const f1 = categorizar(e[1].entrada);
  assert.strictEqual(f1.categoria, 'Ouro');                       // 400 + 0 + 200 = 600
  assert.ok(f1.motivo.includes('matriz e filiais (CNPJ 19.111.937)') && f1.motivo.includes('3 empresas') && f1.motivo.includes('600,00'), f1.motivo);
  assert.strictEqual(categorizar(e[3].entrada).categoria, 'Ouro'); // honorário próprio de 900; sem grupo com outras
  assert.ok(categorizar(e[3].entrada).motivo.startsWith('honorário'));
  assert.strictEqual(categorizar(e[4].entrada).categoria, 'Bronze');
  assert.strictEqual(e[4].entrada.grupos.length, 0);
});

teste('montarEntradas: filial sozinha (matriz fora da base) continua sem categoria', () => {
  const e = montarEntradas([{ id: 'f', cnpj: '19.111.937/0004-05', grupo_empresas: null, honorario: null }], []);
  assert.strictEqual(categorizar(e[0].entrada).categoria, null);
});

teste('rotas de admin passam por requireAuth ANTES de requireAdmin (requireAdmin sozinho sempre dá 403)', () => {
  const { router } = require('./categorias');
  const { requireAuth, requireAdmin } = require('../auth');
  for (const camada of router.stack.filter((l) => l.route)) {
    const nomes = camada.route.stack.map((s) => s.handle);
    const iAdmin = nomes.indexOf(requireAdmin);
    if (iAdmin === -1) continue;
    assert.ok(nomes.indexOf(requireAuth) !== -1 && nomes.indexOf(requireAuth) < iAdmin, `rota ${camada.route.path} usa requireAdmin sem requireAuth antes`);
  }
});

teste('TAG do Acessórias: lê as empresas de dentro de [ { companies:[...] } ]; 204 e lista vazia = nenhuma', () => {
  const { extrairEmpresasDaTag } = require('../acessoriasClient');
  const resposta = [{ id: '89', nome: 'SUSPENSÃO', status: 'Ativo', companies: [{ id: '1', nome: 'A', cnpj: '11.111.111/0001-11' }, { id: '2', nome: 'B', cnpj: '22.222.222/0001-22' }] }];
  assert.deepStrictEqual(extrairEmpresasDaTag(resposta), ['11.111.111/0001-11', '22.222.222/0001-22']);
  assert.deepStrictEqual(extrairEmpresasDaTag(resposta[0]), ['11.111.111/0001-11', '22.222.222/0001-22']);
  assert.deepStrictEqual(extrairEmpresasDaTag(null), []);
  assert.deepStrictEqual(extrairEmpresasDaTag([]), []);
  assert.deepStrictEqual(extrairEmpresasDaTag([{ id: '5', nome: 'MEI', companies: [] }]), []);
});

console.log(`\n${ok} testes passaram.`);
process.exit(0);
