'use strict';
// Rodar: node server/cs/testes_qualidade.js  (validação dos registros de Qualidade; sem banco)
const assert = require('assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
const { TIPO_PLANO, rotaAbertaGestorAnalista, escopoDoUsuario, ocorrenciaNoEscopo, validarTratativaGestor, ETAPA_STATUS, deveAvisar, validarGestor, destinoDaOcorrencia, textoDestino, podeAlterarPrazo, ETAPAS, validarOcorrencia, PRIORIDADES, idsResponsaveis, validarTipo, validarRegistro, validarMudanca, situacao, semAcento, TIPOS, DEPARTAMENTOS, mesmoNome, montarPrioridades, segundaDe } = require('./qualidade');

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
teste('descrição: mínimo de 5 e máximo de 2000 caracteres', () => {
  assert.strictEqual(validarRegistro(Object.assign({}, base, { detalhe: 'oi' }), HOJE).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { detalhe: 'a'.repeat(2000) }), HOJE).ok, true);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { detalhe: 'a'.repeat(2001) }), HOJE).ok, false);
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

const PRAZO_OC = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);   // daqui a uma semana
const oc = { cliente_id: '123', assunto: 'Guia enviada com valor errado', tipo: 'Erro', prioridade: 'Média', departamento: 'Fiscal', prazo: PRAZO_OC, detalhe: 'O cliente pagou a diferença e pediu retificação.' };
teste('ocorrência: aceita o formulário completo; prioridades e departamentos são os combinados', () => {
  const v = validarOcorrencia(oc, ['Erro', 'Multa']);
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(PRIORIDADES, ['Muito Alta', 'Alta', 'Média', 'Baixa']);
  PRIORIDADES.forEach((p) => assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { prioridade: p }), ['Erro']).ok, true, p));
  ['Comercial', 'Contábil', 'Financeiro', 'Fiscal', 'Legalização', 'Pessoal', 'Sucesso'].forEach((d) => assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { departamento: d }), ['Erro']).ok, true, d));
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { prioridade: 'Urgente' }), ['Erro']).ok, false);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { departamento: 'Marte' }), ['Erro']).ok, false);
});
teste('gestores: pessoa, departamento da lista e papel (gestor ou diretor; gestor por padrão)', () => {
  assert.deepStrictEqual(validarGestor({ user_id: 'u1', departamento: 'Fiscal' }), { ok: true, valores: { user_id: 'u1', departamento: 'Fiscal', papel: 'gestor' } });
  assert.strictEqual(validarGestor({ user_id: 'u1', departamento: 'Fiscal', papel: 'diretor' }).valores.papel, 'diretor');
  assert.strictEqual(validarGestor({ user_id: '', departamento: 'Fiscal' }).ok, false);
  assert.strictEqual(validarGestor({ user_id: 'u1', departamento: 'Marte' }).ok, false);
  assert.strictEqual(validarGestor({ user_id: 'u1', departamento: 'Sucesso', papel: 'chefe' }).ok, false);
});
teste('encaminhamento: vai ao gestor do departamento escolhido; sem gestor, ao Sucesso do Cliente; diretor não recebe a fila', () => {
  const um = destinoDaOcorrencia('Fiscal', [{ papel: 'gestor', name: 'Eduardo' }, { papel: 'diretor', name: 'Diretor' }, { papel: 'gestor', name: 'Denisa' }]);
  assert.deepStrictEqual(um, { fila: 'gestor', gestores: ['Eduardo', 'Denisa'] });
  assert.deepStrictEqual(destinoDaOcorrencia('Pessoal', []), { fila: 'sucesso', gestores: [] });
  assert.strictEqual(destinoDaOcorrencia('Pessoal', [{ papel: 'diretor', name: 'Só diretor' }]).fila, 'sucesso');
  assert.strictEqual(textoDestino('Fiscal', um), 'Encaminhada ao gestor de Fiscal: Eduardo, Denisa.');
  assert.strictEqual(textoDestino('Sucesso', { fila: 'sucesso', gestores: [] }), 'Sucesso do Cliente ainda não tem gestor cadastrado: encaminhada ao Sucesso do Cliente.');
});
teste('prazo da ocorrência: administrador ou gestor/diretor do departamento; ninguém mais', () => {
  assert.strictEqual(podeAlterarPrazo({ role: 'administrador' }, ['Fiscal'], []), true);
  assert.strictEqual(podeAlterarPrazo({ role: 'usuario' }, ['Fiscal'], ['Fiscal', 'Pessoal']), true);
  assert.strictEqual(podeAlterarPrazo({ role: 'usuario' }, ['Fiscal'], ['Pessoal']), false);
  assert.strictEqual(podeAlterarPrazo({ role: 'usuario' }, ['Fiscal'], []), false);
  assert.strictEqual(podeAlterarPrazo(null, ['Fiscal'], ['Fiscal']), true, 'quem é gestor do departamento altera mesmo sem outro papel');
});
teste('aviso de ocorrência nova: administração (menos quem registrou); gestor só do departamento; Sucesso do Cliente quando não há gestor', () => {
  const adm = { id: 'a1', role: 'administrador' }, ges = { id: 'g1', role: 'colaborador' };
  const r = (extra) => Object.assign({ criado_por_id: 'x9', fila: 'gestor', departamentos: ['Fiscal'] }, extra);
  assert.strictEqual(deveAvisar(adm, r(), []), true);
  assert.strictEqual(deveAvisar(adm, r({ criado_por_id: 'a1' }), []), false, 'quem registrou não é avisado');
  assert.strictEqual(deveAvisar(ges, r(), ['Fiscal']), true);
  assert.strictEqual(deveAvisar(ges, r(), ['Pessoal']), false, 'gestor de outro departamento não recebe');
  assert.strictEqual(deveAvisar(ges, r(), []), false);
  assert.strictEqual(deveAvisar(ges, r({ fila: 'sucesso', departamentos: ['Pessoal'] }), ['Sucesso']), true, 'sem gestor no departamento: vai para o Sucesso do Cliente');
  assert.strictEqual(deveAvisar(ges, r({ fila: 'sucesso', departamentos: ['Pessoal'] }), ['Fiscal']), false);
  assert.strictEqual(deveAvisar(null, r(), []), false);
});
teste('lista branca do gestor/analista: registrar, ver as próprias, perfil, gestores e Portal do Gestor; o resto do módulo não', () => {
  const ok = (m, c) => assert.strictEqual(rotaAbertaGestorAnalista(m, c), true, m + ' ' + c);
  const no = (m, c) => assert.strictEqual(rotaAbertaGestorAnalista(m, c), false, m + ' ' + c);
  ['/opcoes', '/empresas', '/avisos', '/gestores', '/eu', '/analistas', '/ocorrencias/minhas', '/gestor/ocorrencias', '/anexo/abc'].forEach((c) => ok('GET', c));
  ok('GET', '/empresas?q=ab'); ok('POST', '/ocorrencias'); ok('POST', '/ocorrencias/uuid-1/anexo'); ok('POST', '/gestor/ocorrencias/uuid-1/abrir'); ok('PUT', '/gestor/ocorrencias/uuid-1/tratativa');
  ['/resumo', '/recentes', '/tipos', '/ocorrencias', '/cliente/123', '/analista/7', '/vinculo/1'].forEach((c) => no('GET', c));
  no('POST', '/'); no('POST', '/gestores'); no('POST', '/tipos'); no('PATCH', '/abc'); no('DELETE', '/abc'); no('DELETE', '/gestores/1'); no('PUT', '/vinculo/1'); no('PUT', '/gestor/ocorrencias/x'); no('POST', '/gestor/ocorrencias/x/tratar');
});
teste('escopo do Portal do Gestor: administração vê tudo; gestor vê os departamentos dele; gestor do Sucesso também vê o que ficou sem gestor', () => {
  const adm = escopoDoUsuario({ role: 'administrador' }, []);
  const ges = escopoDoUsuario({ role: 'colaborador' }, ['Fiscal', 'Fiscal', 'Pessoal']);
  const suc = escopoDoUsuario({ role: 'colaborador' }, ['Sucesso']);
  const reg = (d, fila) => ({ departamentos: [d], fila });
  assert.strictEqual(ocorrenciaNoEscopo(adm, reg('Fiscal', 'gestor')), true);
  assert.deepStrictEqual(ges.deptos, ['Fiscal', 'Pessoal']);
  assert.strictEqual(ocorrenciaNoEscopo(ges, reg('Fiscal', 'gestor')), true);
  assert.strictEqual(ocorrenciaNoEscopo(ges, reg('Contábil', 'gestor')), false);
  assert.strictEqual(ocorrenciaNoEscopo(ges, reg('Contábil', 'sucesso')), false, 'sem ser do Sucesso, a fila do Sucesso não é dele');
  assert.strictEqual(ocorrenciaNoEscopo(suc, reg('Contábil', 'sucesso')), true);
  assert.strictEqual(ocorrenciaNoEscopo(suc, reg('Contábil', 'gestor')), false);
  assert.strictEqual(ocorrenciaNoEscopo(escopoDoUsuario({ role: 'colaborador' }, []), reg('Fiscal', 'gestor')), false);
});
teste('tratativa do gestor: plano, responsável, departamento (o da ocorrência por padrão), prazo (SLA editável) e observação', () => {
  const b = { plano: 'Retificar a guia e avisar o cliente hoje.', analista_id: '7', prazo: '2026-10-20' };
  const v = validarTratativaGestor(b, 'Fiscal', '2026-10-17');
  assert.deepStrictEqual(v, { ok: true, valores: { plano: 'Retificar a guia e avisar o cliente hoje.', analista_id: '7', departamento: 'Fiscal', prazo: '2026-10-20', obs: null } });
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { departamento: 'Contábil', obs: ' ok ' }), 'Fiscal', '2026-10-17').valores.departamento, 'Contábil');
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { obs: ' ok ' }), 'Fiscal', '2026-10-17').valores.obs, 'ok');
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { plano: 'oi' }), 'Fiscal', '2026-10-17').ok, false);
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { analista_id: '' }), 'Fiscal', '2026-10-17').ok, false);
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { departamento: 'Marte' }), 'Fiscal', '2026-10-17').ok, false);
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { prazo: '' }), 'Fiscal', '2026-10-17').ok, false);
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { prazo: '2026-10-16' }), 'Fiscal', '2026-10-17').ok, false, 'prazo passado');
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { prazo: '2026-10-17' }), 'Fiscal', '2026-10-17').ok, true, 'hoje vale');
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { plano: 'a'.repeat(2001) }), 'Fiscal', '2026-10-17').ok, false);
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { obs: 'a'.repeat(601) }), 'Fiscal', '2026-10-17').ok, false);
});
teste('etapa → status do risco: aberta até a tratativa; em tratamento com o analista; finalizada na validação e na devolutiva; resolvida ao encerrar', () => {
  assert.deepStrictEqual(ETAPA_STATUS, { registrada: 'aberto', tratativa_definida: 'aberto', com_analista: 'em_tratamento', validacao_gestor: 'finalizada', devolutiva_cliente: 'finalizada', encerrada: 'resolvido' });
});
teste('gestores: o papel "final" (quem encerra no Sucesso do Cliente) é aceito', () => {
  assert.strictEqual(validarGestor({ user_id: 'u1', departamento: 'Sucesso', papel: 'final' }).valores.papel, 'final');
});
teste('users.active é inteiro (1/0): nenhuma consulta do módulo compara com true (isso daria erro no banco)', () => {
  const fonte = require('fs').readFileSync(require('path').join(__dirname, 'qualidade.js'), 'utf8');
  assert.ok(!/(^|[^a-z_])active = (true|false)/i.test(fonte), 'use active = 1');
});
teste('etapas do fluxo na ordem combinada', () => {
  assert.deepStrictEqual(ETAPAS, ['registrada', 'tratativa_definida', 'com_analista', 'validacao_gestor', 'devolutiva_cliente', 'encerrada']);
});

teste('ocorrência: prazo para execução é obrigatório, não pode ser passado nem passar de um ano', () => {
  const t = ['Erro'];
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { prazo: '' }), t).ok, false);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { prazo: '17/10/2026' }), t).ok, false);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { prazo: '2020-01-01' }), t).ok, false);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { prazo: '2999-01-01' }), t).ok, false);
  assert.strictEqual(validarOcorrencia(oc, t).valores.prazo, PRAZO_OC);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { prazo: '2026-10-16' }), t, '2026-10-16').ok, true, 'hoje vale');
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { prazo: '2026-10-15' }), t, '2026-10-16').ok, false, 'ontem não');
});

teste('ocorrência: empresa, assunto (3 a 100), tipo da lista e descrição (5 a 2000, mantém as quebras de linha)', () => {
  const t = ['Erro'];
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { cliente_id: '' }), t).ok, false);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { assunto: 'ab' }), t).ok, false);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { assunto: 'a'.repeat(101) }), t).ok, false);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { assunto: 'a'.repeat(100) }), t).ok, true);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { tipo: 'Multa' }), t).ok, false, 'tipo fora da lista ativa');
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { tipo: 'Retrabalho' }), ['Retrabalho']).ok, true, 'tipo novo cadastrado entra na lista');
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { detalhe: 'oi' }), t).ok, false);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { detalhe: 'a'.repeat(2000) }), t).ok, true);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { detalhe: 'a'.repeat(2001) }), t).ok, false);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { detalhe: 'linha 1\r\nlinha 2  \nlinha 3' }), t).valores.detalhe, 'linha 1\nlinha 2\nlinha 3');
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
