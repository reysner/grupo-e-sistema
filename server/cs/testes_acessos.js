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

const aud = require('./auditoria');
teste('começar do zero: só vale digitando LIMPAR; apaga só as ocorrências do módulo, o sino da Qualidade e os logs do /cs, depois de guardar uma cópia, e numa transação', async () => {
  assert.strictEqual(aud.confirmacaoValida('LIMPAR'), true);
  assert.strictEqual(aud.confirmacaoValida('  LIMPAR '), true);
  assert.strictEqual(aud.confirmacaoValida('limpar'), false, 'tem de ser exatamente LIMPAR');
  assert.strictEqual(aud.confirmacaoValida(''), false);
  assert.strictEqual(aud.confirmacaoValida(undefined), false);
  const sqls = [];
  const cliente = { query: async (sql) => { sqls.push(String(sql)); return { rows: /to_regclass/.test(sql) ? [{ ok: true }] : /COUNT/.test(sql) ? [{ n: 3 }] : [] }; }, release() { sqls.push('RELEASE'); } };
  const pool = { connect: async () => cliente, query: cliente.query };
  const antes = await aud.executarLimpeza(pool, { name: 'Reysner' });
  assert.deepStrictEqual(antes, { ocorrencias: 3, historico: 3, responsaveis: 3, anexos: 3, avisos_de_prazo: 3, sino: 3, logs: 3 });
  assert.ok(sqls.indexOf('BEGIN') > 0 && sqls.slice(0, sqls.indexOf('BEGIN')).every((s) => /to_regclass/.test(s)), 'a conferência das tabelas vem antes da transação'); assert.ok(sqls.includes('COMMIT') && sqls[sqls.length - 1] === 'RELEASE', 'transação aberta, confirmada e liberada');
  const iCopia = sqls.findIndex((s) => /INSERT INTO cs_limpezas/.test(s)), iApaga = sqls.findIndex((s) => /^DELETE/.test(s));
  assert.ok(iCopia > 0 && iApaga > iCopia, 'a cópia de segurança é gravada antes de qualquer DELETE');
  const apagados = sqls.filter((s) => /^DELETE/.test(s));
  assert.strictEqual(apagados.length, 4, 'quatro apagamentos: anexos, ocorrências, sino da Qualidade e logs do /cs');
  assert.ok(apagados.some((s) => /FROM cs_qualidade_registros WHERE origem IN \('modulo', 'filha'\)$/.test(s)), 'só as ocorrências do módulo (a ficha das empresas fica)');
  assert.ok(apagados.some((s) => s.includes("FROM notificacoes WHERE tipo LIKE 'qualidade%'")) && apagados.some((s) => s.includes("FROM log_atividades WHERE modulo LIKE 'cs-%'")));
  assert.ok(!apagados.some((s) => /analistas|cs_qualidade_gestores|cs_qualidade_tipos|cs_acessos|cs_painel_config|users|clientes/.test(s)), 'não toca em analistas, gestores, tipos, acessos, configurações nem clientes');
  // falha no meio: desfaz tudo
  const ruim = { query: async (sql) => { if (/^DELETE FROM log_atividades/.test(String(sql))) throw new Error('falhou'); return { rows: /to_regclass/.test(sql) ? [{ ok: true }] : /COUNT/.test(sql) ? [{ n: 1 }] : [] }; }, release() {} };
  const registro = []; const p2 = { connect: async () => ({ query: async (s, a) => { registro.push(String(s)); return ruim.query(s, a); }, release() {} }), query: ruim.query };
  await assert.rejects(() => aud.executarLimpeza(p2, { name: 'X' }), /falhou/);
  assert.ok(registro.includes('ROLLBACK') && !registro.includes('COMMIT'), 'se algo falhar, nada é apagado');
  // tabela que ainda não existe (ex.: avisos de prazo) não pode derrubar a limpeza
  const poucas = []; const c3 = { query: async (sql, p) => { poucas.push(String(sql)); if (/to_regclass/.test(sql)) return { rows: [{ ok: p[0] !== 'cs_qualidade_alertas' }] }; if (/cs_qualidade_alertas/.test(sql)) throw new Error('relation does not exist'); return { rows: /COUNT/.test(sql) ? [{ n: 2 }] : [] }; }, release() {} };
  const r3 = await aud.executarLimpeza({ connect: async () => c3, query: c3.query }, { name: 'Y' });
  assert.strictEqual(r3.avisos_de_prazo, 0, 'sem a tabela, conta zero');
  assert.ok(poucas.includes('COMMIT') && !poucas.some((s) => /FROM cs_qualidade_alertas/.test(s)), 'e nem chega a consultá-la');
});

teste('logs: cada ação que muda algo vira uma frase clara (e consulta nunca vira ação)', () => {
  const d = (m, u, b) => aud.descreverAcao(m, u, b);
  assert.strictEqual(d('GET', '/api/cs/painel/qualidade/ocorrencias/minhas'), null, 'leitura não é registrada');
  assert.deepStrictEqual(d('POST', '/api/cs/painel/qualidade/ocorrencias', { assunto: 'Guia errada', tipo: 'Erro', departamento: 'Fiscal' }), { acao: 'criar', modulo: 'cs-qualidade', texto: 'Registrou uma ocorrência: Guia errada (Erro · Fiscal)' });
  assert.strictEqual(d('PUT', '/api/cs/painel/qualidade/gestor/ocorrencias/abc/tratativa', {}).registroId, 'abc');
  assert.strictEqual(d('POST', '/api/cs/painel/qualidade/gestor/ocorrencias/abc/abrir').acao, 'abrir');
  assert.strictEqual(d('POST', '/api/cs/painel/qualidade/gestor/ocorrencias/abc/mensagem', { texto: 'Pode priorizar?' }).texto, 'Deixou uma mensagem para quem está tratando: Pode priorizar?');
  assert.strictEqual(d('POST', '/api/cs/painel/qualidade/gestor/ocorrencias/abc/resposta-final', { acao: 'observacao', texto: 'x' }).texto, 'Deixou uma observação: x');
  assert.deepStrictEqual([d('POST', '/api/cs/painel/qualidade/gestor/ocorrencias/abc/resposta-final', { acao: 'finalizar', texto: 'Tudo certo' }).acao, d('POST', '/api/cs/painel/qualidade/sucesso/ocorrencias/abc/responder', { texto: 'ok' }).texto], ['encerrar', 'Respondeu à observação do gestor (Gestor final)']);
  const ap = d('POST', '/api/cs/painel/qualidade/sucesso/ocorrencias/abc/apontar', { analista_id: '7' });
  assert.deepStrictEqual([ap.acao, ap.registroId, ap.analistaId, ap.texto], ['editar', 'abc', '7', 'Corrigiu o analista apontado para'], 'a correção do analista apontado vai para os logs');
  assert.strictEqual(d('POST', '/api/cs/painel/qualidade/sucesso/ocorrencias/abc/apontar', { analista_id: '__nenhum' }).texto, 'Tirou o analista apontado (ninguém)');
  assert.strictEqual(d('POST', '/api/cs/painel/qualidade/gestor/ocorrencias/abc/filha', { assunto: 'Alinhar com o Bruno' }).texto, 'Abriu uma ocorrência vinculada: Alinhar com o Bruno');
  assert.strictEqual(d('POST', '/api/cs/painel/qualidade/gestor/ocorrencias/abc/validar').acao, 'validar');
  assert.strictEqual(d('POST', '/api/cs/painel/qualidade/gestor/ocorrencias/abc/devolver').acao, 'devolver');
  assert.strictEqual(d('POST', '/api/cs/painel/qualidade/gestor/ocorrencias/abc/cancelar', { motivo: 'Duplicada' }).texto, 'Cancelou a ocorrência: Duplicada');
  assert.strictEqual(d('POST', '/api/cs/painel/qualidade/gestor/ocorrencias/abc/reabrir', { motivo: 'Cliente voltou' }).acao, 'reabrir');
  assert.strictEqual(d('POST', '/api/cs/painel/qualidade/analista/ocorrencias/abc/encerrar').texto, 'Encerrou a sua parte da tratativa');
  assert.strictEqual(d('POST', '/api/cs/painel/qualidade/analista/ocorrencias/abc/nota').acao, 'editar');
  assert.strictEqual(d('POST', '/api/cs/painel/qualidade/sucesso/ocorrencias/abc/encerrar').texto, 'Encerrou o processo (gestor final)');
  assert.strictEqual(d('POST', '/api/cs/painel/qualidade/gestores', { departamento: 'Fiscal', papel: 'gestor', user_id: '7' }).usuarioId, '7');
  assert.strictEqual(d('DELETE', '/api/cs/painel/qualidade/gestores/5').acao, 'excluir');
  assert.strictEqual(d('PUT', '/api/cs/painel/qualidade/analistas/9/departamentos', { departamentos: ['Fiscal', 'Pessoal'] }).texto, 'Definiu os departamentos do analista: Fiscal, Pessoal');
  assert.strictEqual(d('PUT', '/api/cs/painel/qualidade/vinculo/9', { user_id: null }).texto, 'Desligou o login do analista');
  assert.strictEqual(d('POST', '/api/cs/painel/qualidade/tipos', { nome: 'Retrabalho', peso: 10 }).texto, 'Incluiu o tipo de registro "Retrabalho" (peso 10)');
  assert.strictEqual(d('PATCH', '/api/cs/painel/qualidade/tipos/3', { peso: 20 }).acao, 'editar');
  assert.strictEqual(d('PATCH', '/api/cs/painel/qualidade/xyz', { status: 'resolvido' }).registroId, 'xyz');
  assert.strictEqual(d('DELETE', '/api/cs/painel/qualidade/xyz').acao, 'excluir');
  assert.strictEqual(d('PUT', '/api/cs/painel/acessos/12', { modulos: ['visao', 'churn'] }).texto, 'Definiu os módulos de acesso: visao, churn');
  assert.strictEqual(d('PUT', '/api/cs/painel/acessos/12', { modulos: null }).texto, 'Voltou os módulos ao padrão do perfil');
  assert.strictEqual(d('POST', '/api/analistas', { nome: 'Maira Soares' }).texto, 'Incluiu o analista "Maira Soares"');
  assert.strictEqual(d('PATCH', '/api/analistas/4', { nome: 'Maira Soares', ativo: false }).texto, 'Alterou o analista (nome para "Maira Soares", desativou)');
  assert.strictEqual(d('DELETE', '/api/analistas/4').analistaId, '4');
  assert.strictEqual(d('POST', '/api/outra/coisa'), null, 'o que não é do painel não entra');
});
teste('logs: a consulta filtra por módulo (cs por padrão), pessoa, ação, texto e datas, com limite seguro', () => {
  const c = (f) => aud.montarConsulta(f);
  const padrao = c({});
  assert.ok(padrao.sql.includes("modulo LIKE 'cs-%'") && padrao.sql.endsWith('ORDER BY created_at DESC LIMIT 300') && padrao.valores.length === 0);
  assert.ok(!c({ modulo: 'todos' }).sql.includes('WHERE'), 'todos os módulos: sem filtro');
  const q = c({ modulo: 'cs-acessos', user: 'Reysner', acao: 'editar', busca: 'Bruno', de: '2026-10-01', ate: '2026-10-18', limite: '50' });
  assert.deepStrictEqual(q.valores, ['cs-acessos', 'Reysner', 'editar', '%Bruno%', '2026-10-01', '2026-10-18']);
  assert.ok(q.sql.includes('modulo = $1') && q.sql.includes('user_name = $2') && q.sql.includes('acao = $3') && q.sql.includes('descricao ILIKE $4 OR user_name ILIKE $4') && q.sql.includes('>= $5::date') && q.sql.includes('<= $6::date') && q.sql.endsWith('LIMIT 50'));
  assert.strictEqual(c({ limite: '999999' }).limite, 1000, 'limite máximo');
  assert.strictEqual(c({ limite: '-5' }).limite, 300, 'limite inválido volta ao padrão');
  assert.deepStrictEqual(c({ de: '01/10/2026; DROP TABLE x' }).valores, [], 'data em formato estranho é ignorada');
  assert.ok(c({ user: 'todos', acao: 'todas' }).valores.length === 0, '"todos" e "todas" não filtram');
});
teste('backup: leva Qualidade, analistas, gestores, acessos e logs; fica de fora chave privada, aparelhos e bytes dos anexos', () => {
  const nomes = aud.TABELAS_BACKUP.map((t) => t[0]).join(' | ');
  ['analistas', 'cs_acessos', 'cs_qualidade_registros', 'cs_qualidade_resp', 'cs_qualidade_historico', 'cs_qualidade_tipos', 'cs_qualidade_gestores', 'cs_painel_config', 'log_atividades'].forEach((t) => assert.ok(nomes.includes(t), 'falta ' + t));
  assert.ok(!nomes.includes('push_assinaturas'), 'aparelhos de aviso são dados pessoais: ficam de fora');
  const anexos = aud.TABELAS_BACKUP.find((t) => t[0].startsWith('cs_qualidade_anexos'))[1];
  assert.ok(!/\bdados\b/.test(anexos.replace('registro_id', '')) && anexos.includes('tamanho'), 'anexos só com nome e tamanho (sem os bytes)');
  const cfg = aud.TABELAS_BACKUP.find((t) => t[0] === 'cs_painel_config')[1];
  assert.ok(cfg.includes('vapid') && cfg.includes('secret') && cfg.includes('private'), 'chaves privadas ficam de fora');
});

console.log(`\n${ok} testes passaram.`);
setTimeout(() => process.exit(0), 50);
