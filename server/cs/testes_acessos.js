'use strict';
// Rodar: node server/cs/testes_acessos.js  (Acessos do painel /cs: módulos por pessoa)
const assert = require('assert');
const A = require('./acessos');

let ok = 0;
const teste = (nome, fn) => { fn(); ok++; console.log('  ok -', nome); };

teste('administrador vê tudo (e é o único com "acessos"), mesmo que exista configuração', () => {
  const todos = A.CODIGOS.concat(['acessos']);
  assert.deepStrictEqual(A.modulosEfetivos({ admin: true }, null), todos);
  assert.deepStrictEqual(A.modulosEfetivos({ admin: true }, ['visao']), todos);
  assert.ok(!A.modulosEfetivos({ equipe: true }, null).includes('acessos'));
  assert.ok(!A.modulosEfetivos({ equipe: true }, A.CODIGOS).includes('acessos'), 'não dá para configurar "acessos"');
});

teste('sem configuração segue o perfil de sempre: equipe vê indicadores, Qualidade e Sucesso do Cliente; gestor e analista só o que o perfil dá', () => {
  const eq = A.modulosPadrao({ equipe: true });
  assert.ok(A.DADOS.every((c) => eq.includes(c)) && eq.includes('qualidade') && eq.includes('sucesso'));
  assert.ok(!eq.includes('gestor') && !eq.includes('analista'), 'portais do gestor e do analista dependem do perfil');
  assert.deepStrictEqual(A.modulosPadrao({ gestor: true }), ['qualidade', 'gestor']);
  assert.deepStrictEqual(A.modulosPadrao({ analista: true }), ['qualidade', 'analista']);
  assert.deepStrictEqual(A.modulosPadrao({ gestor: true, sucesso: true }), ['qualidade', 'gestor', 'sucesso']);
  assert.deepStrictEqual(A.modulosPadrao({ equipe: true, gestor: true, analista: true }).filter((c) => ['gestor', 'analista'].includes(c)), ['gestor', 'analista']);
});

teste('com configuração vê exatamente os módulos marcados (códigos inválidos e repetidos saem)', () => {
  assert.deepStrictEqual(A.modulosEfetivos({ equipe: true }, ['churn', 'visao']), ['visao', 'churn']);
  assert.deepStrictEqual(A.limparModulos(['churn', 'churn', 'xpto', 'acessos', 'visao']), ['visao', 'churn']);
  assert.strictEqual(A.limparModulos(null), null, 'null volta ao padrão');
  assert.strictEqual(A.limparModulos('visao'), undefined, 'formato inválido');
  assert.deepStrictEqual(A.limparModulos([]), [], 'lista vazia é uma configuração (sem acesso a nada)');
  assert.deepStrictEqual(A.modulosEfetivos({ equipe: true }, []), [], 'configuração vazia não cai no padrão');
});

teste('rotas: cada módulo só libera as próprias; dados da carteira exigem algum módulo de indicadores', () => {
  const pode = (rota, mods) => A.rotaPermitida(rota, mods);
  assert.strictEqual(pode('/anual', ['anual']), true);
  assert.strictEqual(pode('/anual', ['churn']), false);
  assert.strictEqual(pode('/atendimentos', ['atendimento']), true);
  assert.strictEqual(pode('/atendimento/123', ['atendimento']), true);
  assert.strictEqual(pode('/atendimentos', ['visao']), false);
  assert.strictEqual(pode('/churn', ['churn']), true);
  assert.strictEqual(pode('/churn-motivos/fechamento', ['visao']), true, 'o fechamento do mês aparece na Visão Geral');
  assert.strictEqual(pode('/churn-motivos', ['anual']), false);
  assert.strictEqual(pode('/honorario-sugerido', ['anual']), true);
  assert.strictEqual(pode('/categorias', ['categorias']), true);
  assert.strictEqual(pode('/dados', ['categorias']), true);
  assert.strictEqual(pode('/dados', ['gestor', 'qualidade']), false, 'só portais: sem os dados da carteira');
  assert.strictEqual(pode('/cliente/9/acessorias', ['qualidade_dados']), true);
  assert.strictEqual(pode('/qualidade/eu', []), true, 'Qualidade tem controle próprio');
  assert.strictEqual(pode('/acessos', []), true, 'Acessos confere o administrador por conta própria');
  assert.strictEqual(pode('/anual?x=1', []), false, 'a query não muda a rota');
});

teste('marcas do login: indicadores dão acesso ao painel como equipe; Qualidade/portais dão a marca de gestor', () => {
  assert.strictEqual(A.temModuloDeDados(['visao']), true);
  assert.strictEqual(A.temModuloDeDados(['gestor', 'analista', 'qualidade']), false);
  assert.strictEqual(A.temModuloDePortal(['sucesso']), true);
  assert.strictEqual(A.temModuloDePortal(['churn']), false);
  assert.strictEqual(A.temModuloDePortal([]), false);
});

teste('barreira: administrador e quem não tem configuração passam; configurado barra o que não tem (403), sem token segue', async () => {
  // a barreira usa o cache/consulta de lerConfig; aqui só o comportamento sem banco: sem token e administrador seguem direto
  const passou = [];
  const mw = A.restringir(() => null);
  await mw({ path: '/anual' }, { status() { throw new Error('não devia barrar'); } }, () => passou.push('sem-token'));
  const mwAdm = A.restringir(() => ({ sub: '1', role: 'administrador' }));
  await mwAdm({ path: '/anual' }, { status() { throw new Error('não devia barrar'); } }, () => passou.push('admin'));
  assert.deepStrictEqual(passou, ['sem-token', 'admin']);
});

console.log(`\n${ok} testes passaram.`);
setTimeout(() => process.exit(0), 50);
