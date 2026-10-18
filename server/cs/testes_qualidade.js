'use strict';
// Rodar: node server/cs/testes_qualidade.js  (validação dos registros de Qualidade; sem banco)
const assert = require('assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
const { TIPO_PLANO, validarMotivo, destinoDaReabertura, mascararParaAnalista, validarFilha, prontoParaValidacao, validarDepartamentosAnalista, avisoResponsavel, nomeCompletoDoLogin, pessoasParaGestor, transicao, validarEncerramento, TRANSICOES, rotaAbertaGestorAnalista, escopoDoUsuario, ocorrenciaNoEscopo, validarTratativaGestor, ETAPA_STATUS, deveAvisar, validarGestor, destinoDaOcorrencia, textoDestino, podeAlterarPrazo, ETAPAS, validarOcorrencia, PRIORIDADES, idsResponsaveis, validarTipo, validarRegistro, validarMudanca, situacao, semAcento, TIPOS, DEPARTAMENTOS, mesmoNome, montarPrioridades, segundaDe } = require('./qualidade');

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
teste('descrição: mínimo de 5 e máximo de 1500 caracteres', () => {
  assert.strictEqual(validarRegistro(Object.assign({}, base, { detalhe: 'oi' }), HOJE).ok, false);
  assert.strictEqual(validarRegistro(Object.assign({}, base, { detalhe: 'a'.repeat(1500) }), HOJE).ok, true);
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
teste('encaminhamento: vai ao gestor e ao diretor do departamento escolhido; sem nenhum dos dois, ao Sucesso do Cliente', () => {
  const um = destinoDaOcorrencia('Fiscal', [{ papel: 'gestor', name: 'Eduardo' }, { papel: 'diretor', name: 'Diretor' }, { papel: 'gestor', name: 'Denisa' }]);
  assert.deepStrictEqual(um, { fila: 'gestor', gestores: ['Eduardo', 'Denisa', 'Diretor'] }, 'gestor e diretor recebem');
  assert.deepStrictEqual(destinoDaOcorrencia('Pessoal', []), { fila: 'sucesso', gestores: [] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(destinoDaOcorrencia('Pessoal', [{ papel: 'diretor', name: 'Denisa' }]))), { fila: 'gestor', gestores: ['Denisa'] }, 'só diretor(a): ele é o gestor do departamento');
  assert.strictEqual(destinoDaOcorrencia('Pessoal', [{ papel: 'final', name: 'Gestor final' }]).fila, 'sucesso', 'só o gestor final não é do departamento');
  assert.strictEqual(textoDestino('Pessoal', destinoDaOcorrencia('Pessoal', [{ papel: 'diretor', name: 'Denisa' }])), 'Encaminhada ao gestor de Pessoal: Denisa.');
  assert.strictEqual(textoDestino('Fiscal', um), 'Encaminhada ao gestor de Fiscal: Eduardo, Denisa, Diretor.');
  assert.strictEqual(textoDestino('Sucesso', { fila: 'sucesso', gestores: [] }), 'Sucesso do Cliente ainda não tem gestor cadastrado: encaminhada ao Sucesso do Cliente.');
  assert.strictEqual(textoDestino('Pessoal', { fila: 'sucesso', gestores: [] }), 'Encaminhada ao gestor de Pessoal. Como ainda não há gestor cadastrado, o Sucesso do Cliente faz esta etapa (e acompanha o caso até o fim).', 'sem gestor: o texto continua dizendo gestor do departamento');
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
  ['/resumo', '/tipos', '/ocorrencias', '/cliente/123', '/analista/7', '/vinculo/1'].forEach((c) => no('GET', c));
  ['/analista/ocorrencias', '/sucesso/ocorrencias'].forEach((c) => ok('GET', c));
  ['/analista/ocorrencias/u1/nota', '/analista/ocorrencias/u1/encerrar', '/gestor/ocorrencias/u1/validar', '/gestor/ocorrencias/u1/devolver', '/sucesso/ocorrencias/u1/encerrar'].forEach((c) => ok('POST', c));
  ok('POST', '/gestor/ocorrencias/u1/excluir'); no('GET', '/gestor/ocorrencias/u1/excluir'); no('DELETE', '/gestor/ocorrencias/u1');
  no('POST', '/sucesso/ocorrencias/u1/abrir'); no('POST', '/analista/ocorrencias/u1/validar'); no('POST', '/gestor/ocorrencias/u1/encerrar'); no('GET', '/analista/ocorrencias/u1'); no('PUT', '/sucesso/ocorrencias/u1/encerrar'); no('DELETE', '/analista/ocorrencias/u1');
  ok('POST', '/gestor/ocorrencias/u1/filha'); no('POST', '/analista/ocorrencias/u1/filha');
  ok('POST', '/gestor/ocorrencias/u1/cancelar'); ok('POST', '/gestor/ocorrencias/u1/reabrir'); no('POST', '/analista/ocorrencias/u1/cancelar'); no('DELETE', '/gestor/ocorrencias/u1/cancelar');
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
  assert.deepStrictEqual(v, { ok: true, valores: { plano: 'Retificar a guia e avisar o cliente hoje.', analista_id: '7', analistas_ids: ['7'], departamento: 'Fiscal', prazo: '2026-10-20', obs: null } });
  const varios = validarTratativaGestor(Object.assign({}, b, { analista_id: undefined, analistas_ids: ['7', '9', '7', ''] }), 'Fiscal', '2026-10-17');
  assert.deepStrictEqual([varios.valores.analista_id, varios.valores.analistas_ids], ['7', ['7', '9']], 'vários responsáveis: sem repetir, o primeiro é o principal');
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { departamento: 'Contábil', obs: ' ok ' }), 'Fiscal', '2026-10-17').valores.departamento, 'Contábil');
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { obs: ' ok ' }), 'Fiscal', '2026-10-17').valores.obs, 'ok');
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { plano: 'oi' }), 'Fiscal', '2026-10-17').ok, false);
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { analista_id: '' }), 'Fiscal', '2026-10-17').ok, false);
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { departamento: 'Marte' }), 'Fiscal', '2026-10-17').ok, false);
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { prazo: '' }), 'Fiscal', '2026-10-17').ok, false);
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { prazo: '2026-10-16' }), 'Fiscal', '2026-10-17').ok, false, 'prazo passado');
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { prazo: '2026-10-17' }), 'Fiscal', '2026-10-17').ok, true, 'hoje vale');
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { plano: 'a'.repeat(2001) }), 'Fiscal', '2026-10-17').ok, false);
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { obs: 'a'.repeat(1501) }), 'Fiscal', '2026-10-17').ok, false);
  assert.strictEqual(validarTratativaGestor(Object.assign({}, b, { obs: 'a'.repeat(1500) }), 'Fiscal', '2026-10-17').ok, true, 'observação até 1500');
});
teste('etapa → status do risco: aberta até a tratativa; em tratamento com o analista; finalizada na validação e na devolutiva; resolvida ao encerrar', () => {
  assert.deepStrictEqual(ETAPA_STATUS, { registrada: 'aberto', tratativa_definida: 'aberto', com_analista: 'em_tratamento', validacao_gestor: 'finalizada', devolutiva_cliente: 'finalizada', encerrada: 'resolvido', cancelada: 'cancelado' });
});
teste('gestores: o papel "final" (quem encerra no Sucesso do Cliente) é aceito', () => {
  assert.strictEqual(validarGestor({ user_id: 'u1', departamento: 'Sucesso', papel: 'final' }).valores.papel, 'final');
});
teste('users.active é inteiro (1/0): nenhuma consulta do módulo compara com true (isso daria erro no banco)', () => {
  const fonte = require('fs').readFileSync(require('path').join(__dirname, 'qualidade.js'), 'utf8');
  assert.ok(!/(^|[^a-z_])active = (true|false)/i.test(fonte), 'use active = 1');
});
teste('fluxo: cada passo só sai da etapa certa e leva à seguinte (e o status do risco acompanha)', () => {
  const v = (acao, etapa) => transicao(acao, etapa);
  assert.deepStrictEqual(v('abrir', 'tratativa_definida'), { ok: true, para: 'com_analista', status: 'em_tratamento' });
  assert.deepStrictEqual(v('analista_encerrar', 'com_analista'), { ok: true, para: 'validacao_gestor', status: 'finalizada' });
  assert.deepStrictEqual(v('gestor_devolver', 'validacao_gestor'), { ok: true, para: 'com_analista', status: 'em_tratamento' });
  assert.deepStrictEqual(v('gestor_validar', 'validacao_gestor'), { ok: true, para: 'devolutiva_cliente', status: 'finalizada' });
  assert.deepStrictEqual(v('final_encerrar', 'devolutiva_cliente'), { ok: true, para: 'encerrada', status: 'resolvido' });
  // pular etapa não pode: o gestor final não encerra o que ainda não foi validado; o analista não encerra o que não foi aberto
  assert.strictEqual(v('final_encerrar', 'validacao_gestor').ok, false);
  assert.strictEqual(v('final_encerrar', 'com_analista').ok, false);
  assert.strictEqual(v('analista_encerrar', 'tratativa_definida').ok, false);
  assert.strictEqual(v('analista_encerrar', 'validacao_gestor').ok, false, 'depois de devolvido ao gestor o analista não encerra de novo');
  assert.strictEqual(v('gestor_validar', 'com_analista').ok, false);
  assert.strictEqual(v('gestor_validar', 'devolutiva_cliente').ok, false, 'não valida duas vezes');
  assert.strictEqual(v('final_encerrar', 'encerrada').ok, false, 'não encerra duas vezes');
  assert.strictEqual(v('inventada', 'registrada').ok, false);
  assert.ok(v('final_encerrar', 'registrada').erro.includes('não foi validada'));
  assert.deepStrictEqual(Object.keys(TRANSICOES), ['abrir', 'analista_encerrar', 'gestor_devolver', 'gestor_validar', 'filha_validar', 'cancelar', 'reabrir_encerrada', 'final_encerrar']);
  assert.deepStrictEqual(v('cancelar', 'com_analista'), { ok: true, para: 'cancelada', status: 'cancelado' });
  assert.deepStrictEqual(v('cancelar', 'registrada'), { ok: true, para: 'cancelada', status: 'cancelado' });
  assert.strictEqual(v('cancelar', 'encerrada').ok, false, 'encerrada não se cancela: reabre');
  assert.strictEqual(v('cancelar', 'cancelada').ok, false, 'não cancela duas vezes');
  assert.deepStrictEqual(v('reabrir_encerrada', 'encerrada'), { ok: true, para: 'com_analista', status: 'em_tratamento' });
  assert.strictEqual(v('reabrir_encerrada', 'com_analista').ok, false);
  assert.deepStrictEqual(v('filha_validar', 'validacao_gestor'), { ok: true, para: 'encerrada', status: 'resolvido' }, 'a filha validada já está encerrada');
  assert.strictEqual(v('filha_validar', 'com_analista').ok, false);
});
teste('nota e observação de quem encerra, valida ou devolve: nota obrigatória (5 a 600), observação opcional (até 1000)', () => {
  assert.deepStrictEqual(validarEncerramento({ nota: ' Guia retificada e cliente avisado ' }), { ok: true, valores: { nota: 'Guia retificada e cliente avisado', obs: null } });
  assert.strictEqual(validarEncerramento({ nota: 'Tudo ok', obs: '  conferi os dois meses ' }).valores.obs, 'conferi os dois meses');
  assert.strictEqual(validarEncerramento({ nota: 'ok' }).ok, false);
  assert.strictEqual(validarEncerramento({}).ok, false);
  assert.strictEqual(validarEncerramento({ nota: 'a'.repeat(601) }).ok, false);
  assert.strictEqual(validarEncerramento({ nota: 'a'.repeat(600) }).ok, true);
  assert.strictEqual(validarEncerramento({ nota: 'Tudo ok', obs: 'a'.repeat(1001) }).ok, false);
  assert.strictEqual(validarEncerramento({ nota: 'linha 1\r\nlinha 2' }).valores.nota, 'linha 1\nlinha 2');
});
teste('nome completo no cadastro de gestores: usa o da lista de analistas (por vínculo, nome igual ou único que começa igual); sem par, fica o do login', () => {
  const an = [{ nome: 'Josiane Aparecida da Silva', user_id: null }, { nome: 'Eduardo de Queiroz Cançado Junior', user_id: '9' }, { nome: 'Eduardo Alves Souza', user_id: null }, { nome: 'Eduardo Pereira Lima', user_id: null }, { nome: 'Ivone Cardoso Rodrigues', user_id: null }, { nome: 'Ivone Cardoso Rodrigues', user_id: null }, { nome: 'Maira Souza', user_id: null }];
  const col = [{ nome: 'Guilherme de Barros Amaro', user_id: '5' }];
  const f = (id, name) => nomeCompletoDoLogin({ id, name }, an, col);
  assert.strictEqual(f('1', 'Josiane'), 'Josiane Aparecida da Silva', 'único que começa igual');
  assert.strictEqual(f('9', 'Eduardo'), 'Eduardo de Queiroz Cançado Junior', 'vínculo pelo login vence');
  assert.strictEqual(f('2', 'Eduardo'), 'Eduardo', 'dois Eduardos sem vínculo: não chuta');
  assert.strictEqual(f('5', 'Guilherme'), 'Guilherme de Barros Amaro', 'colaborador da Gamificação ligado ao login');
  assert.strictEqual(nomeCompletoDoLogin({ id: '8', name: 'Elma' }, [{ nome: 'Elma Aparecida Oliveira', user_id: null }], [{ nome: 'Elma', user_id: '8' }]), 'Elma Aparecida Oliveira', 'colaborador com nome curto não impede de achar o analista');
  assert.strictEqual(f('3', 'MAIRA'), 'Maira Souza', 'sem acento nem maiúsculas');
  assert.strictEqual(f('4', 'Escritorial CS'), 'Escritorial CS');
  assert.strictEqual(f('6', ''), '');
});
teste('rotas: GET /analista/ocorrencias (Portal do Analista) não é engolida por GET /analista/:id', () => {
  const { router } = require('./qualidade');
  const camadas = router.stack.filter((l) => l.route && l.route.methods.get && ['/analista/:id', '/analista/ocorrencias'].includes(l.route.path));
  const iEsp = camadas.findIndex((l) => l.route.path === '/analista/ocorrencias'), iGen = camadas.findIndex((l) => l.route.path === '/analista/:id');
  assert.ok(iEsp >= 0 && iGen >= 0, 'as duas rotas existem');
  // quando a genérica vem primeiro, ela tem de passar a vez (next) para "ocorrencias"; a específica respondendo antes também resolve
  if (iGen < iEsp) {
    let passou = false, respondeu = false;
    camadas[iGen].route.stack[0].handle({ params: { id: 'ocorrencias' } }, { status() { respondeu = true; return { json() { respondeu = true; } }; }, json() { respondeu = true; } }, () => { passou = true; });
    assert.ok(passou && !respondeu, 'a rota genérica passa a vez quando o id é "ocorrencias"');
  }
});
teste('menu do usuário e sino: o cabeçalho das páginas /cs, /financeiro e /legalizacao fica acima do conteúdo (senão o menu abre por baixo dos cartões)', () => {
  const fs = require('fs'), path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'css', 'cs-painel.css'), 'utf8');
  assert.ok(css.includes('.gp-header{position:relative;z-index:60;}'), 'regra do cabeçalho acima do conteúdo');
  const html = (n) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', n), 'utf8');
  ['cs-painel.html', 'financeiro.html', 'legalizacao-publica.html'].forEach((n) => assert.ok(/cs-painel\.css\?v=\d+/.test(html(n)), n + ' carrega o CSS com versão (para o navegador pegar a mudança)'));
});
teste('renomear analista: nenhum arquivo troca espaços por uma regex sem a barra invertida (isso apagava todos os "s" do nome: Maira Soares virava Maira Soare)', () => {
  const fs = require('fs'), path = require('path');
  const raiz = path.join(__dirname, '..', '..');
  const arquivos = ['server/routes/analistas.js', 'public/js/app.js', 'public/js/cs-painel.js', 'server/cs/qualidade.js'];
  const ruim = '/s' + '+/';   // a regex errada: "s" seguido de "+", sem a barra
  arquivos.forEach((a) => assert.ok(!fs.readFileSync(path.join(raiz, a), 'utf8').includes(ruim), a + ' tem a regex ' + ruim + ' (faltou a barra invertida)'));
  // e o jeito certo de limpar espaços preserva os "s"
  const limpa = (t) => String(t || '').split(/\s+/).join(' ').trim();
  assert.strictEqual(limpa('  Maira   Soares '), 'Maira Soares');
});
teste('cancelar e reabrir: motivo obrigatório; cancelada volta para a etapa em que estava; sem etapa conhecida volta ao começo', () => {
  assert.strictEqual(validarMotivo({ motivo: '  Duplicada  ' }).valores.motivo, 'Duplicada');
  assert.strictEqual(validarMotivo({ motivo: 'ok' }).ok, false);
  assert.strictEqual(validarMotivo({}).ok, false);
  assert.strictEqual(validarMotivo({ motivo: 'a'.repeat(601) }).ok, false);
  assert.deepStrictEqual(destinoDaReabertura('com_analista'), { para: 'com_analista', status: 'em_tratamento' });
  assert.deepStrictEqual(destinoDaReabertura('validacao_gestor'), { para: 'validacao_gestor', status: 'finalizada' });
  assert.deepStrictEqual(destinoDaReabertura('registrada'), { para: 'registrada', status: 'aberto' });
  assert.deepStrictEqual(destinoDaReabertura(null), { para: 'registrada', status: 'aberto' }, 'sem registro da etapa anterior');
  assert.deepStrictEqual(destinoDaReabertura('encerrada'), { para: 'registrada', status: 'aberto' }, 'encerrada não é destino de reabertura de cancelada');
});
teste('mudança de etapa: todo UPDATE que muda a etapa (ou define a tratativa) só vale se a ocorrência ainda estiver na etapa de onde sai (duplo clique ou duas pessoas ao mesmo tempo)', () => {
  const fonte = require('fs').readFileSync(require('path').join(__dirname, 'qualidade.js'), 'utf8');
  const partidas = ["SET etapa = 'encerrada'", 'SET etapa = $1', 'SET plano_acao = $1', "SET etapa = 'com_analista'"];   // (o cancelar tem a mesma trava, conferida logo abaixo)
  let achadas = 0;
  partidas.forEach((p) => {
    let i = fonte.indexOf('UPDATE cs_qualidade_registros ' + p);
    while (i >= 0) {
      achadas++;
      const w = fonte.indexOf('WHERE id = ', i);
      assert.ok(w > 0 && fonte.slice(w, w + 80).includes('AND etapa'), 'UPDATE sem a trava de etapa perto de: ' + fonte.slice(i, i + 90).split(String.fromCharCode(10)).join(' '));
      i = fonte.indexOf('UPDATE cs_qualidade_registros ' + p, i + 1);
    }
  });
  assert.ok(achadas >= 7, 'esperava achar as mudanças de etapa (achei ' + achadas + ')');
  assert.ok(fonte.includes('const JA_MUDOU'), 'a mensagem para quem chegou depois existe');
  assert.ok(fonte.includes("etapa = 'cancelada', status = 'cancelado', atualizado_em = NOW() WHERE id = $1 AND etapa = $2"), 'cancelar também só vale na etapa de origem');
});
teste('quem pode ser gestor: só os analistas ativos (nome completo, com login direto ou pelo nome); sem login fica desabilitado; administrador sem analista entra para diretor/gestor final', () => {
  const an = [{ nome: 'Josiane Alves de Oliveira Cezario', user_id: null, ativo: true }, { nome: 'Annaisa Alves de Oliveira', user_id: '7', ativo: true }, { nome: 'Fulano Sem Login', user_id: null, ativo: true }, { nome: 'Antigo Desativado', user_id: null, ativo: false }];
  const us = [{ id: '1', name: 'Josiane', role: 'usuario' }, { id: '7', name: 'Anna', role: 'usuario' }, { id: '2', name: 'Teste', role: 'usuario' }, { id: '3', name: 'Escritorial CS', role: 'usuario' }, { id: '4', name: 'Reysner', role: 'administrador' }];
  const l = pessoasParaGestor(an, us, []);
  assert.deepStrictEqual(l.map((p) => p.name), ['Annaisa Alves de Oliveira', 'Fulano Sem Login', 'Josiane Alves de Oliveira Cezario', 'Reysner']);
  const por = (n) => l.find((p) => p.name === n);
  assert.strictEqual(por('Annaisa Alves de Oliveira').id, '7', 'vínculo direto');
  assert.strictEqual(por('Josiane Alves de Oliveira Cezario').id, '1', 'pelo nome do login');
  assert.strictEqual(por('Fulano Sem Login').sem_login, true);
  assert.strictEqual(por('Reysner').admin, true);
  const oculto = pessoasParaGestor([{ nome: 'Escritorial CS', user_id: '3', ativo: true }], [{ id: '3', name: 'Escritorial CS', role: 'administrador' }, { id: '4', name: 'Reysner', role: 'administrador' }], []);
  assert.deepStrictEqual(oculto.map((p) => p.name), ['Reysner'], 'o login compartilhado Escritorial CS fica oculto, mesmo sendo administrador ou analista');
  assert.ok(!l.some((p) => p.name === 'Teste' || p.name === 'Escritorial CS' || p.name === 'Antigo Desativado'), 'quem não é analista (nem administrador) sai da lista');
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

teste('ocorrência filha: assunto, plano, responsáveis (um por situação ou vários), departamento (sem padrão) e prazo próprios', () => {
  const b = { assunto: 'Alinhar com o Bruno', plano: 'Conferir as guias do mês e avisar o cliente.', analistas_ids: ['3'], departamento: 'Financeiro', prazo: '2026-10-25' };
  const v = validarFilha(b, '2026-10-18');
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual([v.valores.assunto, v.valores.analistas_ids, v.valores.departamento, v.valores.prazo], ['Alinhar com o Bruno', ['3'], 'Financeiro', '2026-10-25']);
  assert.strictEqual(validarFilha(Object.assign({}, b, { departamento: undefined }), '2026-10-18').ok, false, 'a filha precisa de departamento');
  assert.strictEqual(validarFilha(Object.assign({}, b, { assunto: 'ok' }), '2026-10-18').ok, false);
  assert.strictEqual(validarFilha(Object.assign({}, b, { assunto: 'a'.repeat(101) }), '2026-10-18').ok, false);
  assert.strictEqual(validarFilha(Object.assign({}, b, { analistas_ids: [] }), '2026-10-18').ok, false, 'sem responsável');
  assert.strictEqual(validarFilha(Object.assign({}, b, { prazo: '2026-10-17' }), '2026-10-18').ok, false, 'prazo passado');
  assert.strictEqual(validarFilha(Object.assign({}, b, { analistas_ids: ['3', '4'] }), '2026-10-18').valores.analistas_ids.length, 2);
});
teste('original conduzida só por ocorrências vinculadas: pode ficar sem responsável próprio, mas só quando existem filhas', () => {
  const b = { plano: 'Alinhar com cada analista por ocorrência.', prazo: '2026-10-25' };
  assert.strictEqual(validarTratativaGestor(b, 'Fiscal', '2026-10-18').ok, false, 'sem filhas, precisa de responsável');
  const v = validarTratativaGestor(b, 'Fiscal', '2026-10-18', { permiteSemResponsavel: true });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual([v.valores.analistas_ids, v.valores.analista_id], [[], null]);
});
teste('Portal do Sucesso do Cliente acompanha TODOS os casos: a lista não filtra por departamento, fila nem etapa, e o Sucesso é avisado de toda ocorrência nova', () => {
  const fonte = require('fs').readFileSync(require('path').join(__dirname, 'qualidade.js'), 'utf8');
  const i = fonte.indexOf("router.get('/sucesso/ocorrencias'"), j = fonte.indexOf("router.post('/sucesso/ocorrencias/:id/encerrar'", i);
  const rota = fonte.slice(i, j);
  assert.ok(rota.includes("r.origem IN ('modulo', 'filha')") && !rota.includes("r.status <> 'cancelado'"), 'lista tudo, inclusive as canceladas (com a etapa Cancelada): ocorrências e filhas');
  const semOrdem = rota.split('ORDER BY')[0];
  assert.ok(!semOrdem.includes('departamentos') && !semOrdem.includes('r.fila') && !semOrdem.includes('etapa NOT IN') && !semOrdem.includes('criado_por_id'), 'sem filtro por departamento, fila, etapa ou quem abriu');
  const k = fonte.indexOf("router.post('/ocorrencias'"), l = fonte.indexOf('res.status(201)', k);
  const trecho = fonte.slice(k, l);
  assert.ok(trecho.includes('await idsSucesso()') && !trecho.includes(": await idsSucesso()),"), 'o Sucesso do Cliente é avisado sempre (não só quando não há gestor)');
});
teste('sigilo: a filha não aponta o analista do registro (o reclamado) nem a original, a não ser que o gestor queira', () => {
  const b = { assunto: 'Alinhar guias', plano: 'Conferir as guias do mês e avisar o cliente.', analistas_ids: ['3'], departamento: 'Fiscal', prazo: '2026-10-25' };
  assert.strictEqual(validarFilha(b, '2026-10-18').valores.mostrar_pai, false, 'por padrão não mostra');
  assert.strictEqual(validarFilha(Object.assign({}, b, { mostrar_pai: true }), '2026-10-18').valores.mostrar_pai, true);
  assert.strictEqual(validarFilha(Object.assign({}, b, { mostrar_pai: 'sim' }), '2026-10-18').valores.mostrar_pai, false, 'só true vale');
  const original = { id: 'o1', origem: 'modulo', analista_origem_id: '9', analista_origem_nome: 'Fulano Reclamado', mostrar_pai: false, pai: null };
  const filha = { id: 'f1', origem: 'filha', pai_id: 'o1', pai: { id: 'o1', assunto: 'Reclamação do cliente X' }, analista_origem_id: null, mostrar_pai: false };
  const m1 = mascararParaAnalista(original, '3', false);
  assert.deepStrictEqual([m1.analista_origem_id, m1.analista_origem_nome], [null, null], 'quem trata não vê o reclamado');
  assert.strictEqual(mascararParaAnalista(original, '9', false).analista_origem_nome, 'Fulano Reclamado', 'o próprio indicado vê o que é sobre ele');
  assert.strictEqual(mascararParaAnalista(original, '3', true).analista_origem_nome, 'Fulano Reclamado', 'liderança vê tudo');
  const m2 = mascararParaAnalista(filha, '3', false);
  assert.deepStrictEqual([m2.pai_id, m2.pai], [null, null], 'a filha não mostra de onde veio');
  const aberta = mascararParaAnalista(Object.assign({}, filha, { mostrar_pai: true, analista_origem_id: '9', analista_origem_nome: 'Fulano Reclamado' }), '3', false);
  assert.deepStrictEqual([aberta.pai.assunto, aberta.analista_origem_nome], ['Reclamação do cliente X', 'Fulano Reclamado'], 'se o gestor quis mostrar, mostra');
  assert.strictEqual(original.analista_origem_nome, 'Fulano Reclamado', 'não altera o original');
});
teste('sigilo: o gestor pode tirar a empresa da vinculada; o analista não a vê, a liderança continua vendo', () => {
  const b = { assunto: 'Atraso na folha', plano: 'Resolver', analistas_ids: ['3'], departamento: 'Pessoal', prazo: '2026-10-25' };
  assert.strictEqual(validarFilha(b, '2026-10-18').valores.ocultar_empresa, false, 'por padrão a empresa aparece');
  assert.strictEqual(validarFilha(Object.assign({}, b, { ocultar_empresa: true }), '2026-10-18').valores.ocultar_empresa, true);
  assert.strictEqual(validarFilha(Object.assign({}, b, { ocultar_empresa: 'sim' }), '2026-10-18').valores.ocultar_empresa, false, 'só true vale');
  const filha = { id: 'f1', origem: 'filha', cliente_id: '9', cnpj: '123', cliente_nome: 'ALFA LTDA', ocultar_empresa: true, mostrar_pai: true, pai_id: 'o1', pai: { id: 'o1', assunto: 'X', cliente_nome: 'ALFA LTDA' } };
  const vista = mascararParaAnalista(filha, '3', false);
  assert.deepStrictEqual([vista.cliente_nome, vista.cnpj, vista.cliente_id, vista.pai.cliente_nome], [null, null, null, null], 'o analista não vê a empresa (nem pela original)');
  assert.strictEqual(mascararParaAnalista(filha, '3', true).cliente_nome, 'ALFA LTDA', 'a liderança vê');
  assert.strictEqual(mascararParaAnalista(Object.assign({}, filha, { ocultar_empresa: false }), '3', false).cliente_nome, 'ALFA LTDA', 'sem a marca, a empresa aparece');
  assert.strictEqual(filha.cliente_nome, 'ALFA LTDA', 'não altera o original');
});
teste('original só vai à validação quando todos os responsáveis encerraram e as filhas estão encerradas', () => {
  const r = (id, ok) => ({ analista_id: id, encerrado_em: ok ? '2026-10-18' : null });
  assert.deepStrictEqual(prontoParaValidacao([r('1', true)], []), { pronto: true, pendentes: [], filhasPendentes: 0 });
  assert.deepStrictEqual(prontoParaValidacao([r('1', true), r('2', false)], []), { pronto: false, pendentes: ['2'], filhasPendentes: 0 }, 'falta um analista');
  assert.deepStrictEqual(prontoParaValidacao([r('1', true), r('2', true)], [{ etapa: 'com_analista' }, { etapa: 'encerrada' }]), { pronto: false, pendentes: [], filhasPendentes: 1 }, 'falta uma filha');
  assert.strictEqual(prontoParaValidacao([r('1', true), r('2', true)], [{ etapa: 'encerrada' }]).pronto, true);
  assert.strictEqual(prontoParaValidacao([], []).pronto, false, 'sem responsáveis nem filhas nada está pronto');
  assert.strictEqual(prontoParaValidacao([], [{ etapa: 'encerrada' }, { etapa: 'encerrada' }]).pronto, true, 'original conduzida só pelas filhas: pronta quando todas encerram');
  assert.deepStrictEqual(prontoParaValidacao([], [{ etapa: 'encerrada' }, { etapa: 'com_analista' }]), { pronto: false, pendentes: [], filhasPendentes: 1 });
  assert.strictEqual(prontoParaValidacao(null, null).pronto, false);
});
teste('departamentos do analista: vários (ex.: Financeiro e Legalização), só os da lista e sem repetir; o aviso não bloqueia', () => {
  assert.deepStrictEqual(validarDepartamentosAnalista({ departamentos: ['Legalização', 'Financeiro', 'Financeiro', 'Xpto'] }).valores.departamentos, ['Financeiro', 'Legalização']);
  assert.deepStrictEqual(validarDepartamentosAnalista({ departamentos: [] }).valores.departamentos, [], 'pode ficar sem departamento');
  assert.strictEqual(validarDepartamentosAnalista({ departamentos: 'Fiscal' }).ok, false);
  assert.strictEqual(validarDepartamentosAnalista({}).ok, false);
  const bruno = { nome: 'Bruno Cesar Xavier', departamentos: ['Financeiro', 'Legalização'] };
  assert.strictEqual(avisoResponsavel(bruno, 'Legalização'), '');
  assert.strictEqual(avisoResponsavel(bruno, 'Financeiro'), '');
  assert.strictEqual(avisoResponsavel(bruno, 'Contábil'), 'Bruno Cesar Xavier não é do departamento Contábil (atende Financeiro, Legalização).');
  assert.ok(avisoResponsavel({ nome: 'João', departamentos: [] }, 'Fiscal').includes('ainda não tem departamento'));
  assert.ok(avisoResponsavel({ nome: 'Ana', departamentos: ['Sucesso'] }, 'Fiscal').includes('atende Sucesso do Cliente'));
  assert.strictEqual(avisoResponsavel(null, 'Fiscal'), '', 'sem responsável não há o que avisar');
});
teste('ocorrência: responsável é opcional (vazio vira nulo) e vai junto quando informado', () => {
  const t = ['Erro'], base = { cliente_id: '1', assunto: 'Guia errada', tipo: 'Erro', prioridade: 'Alta', departamento: 'Fiscal', detalhe: 'Detalhe da ocorrência', prazo: '2026-12-01' };
  const v0 = validarOcorrencia(base, t, '2026-10-18');
  assert.strictEqual(v0.ok, true); assert.strictEqual(v0.valores.analista_id, null);
  assert.strictEqual(validarOcorrencia(Object.assign({}, base, { analista_id: '' }), t, '2026-10-18').valores.analista_id, null);
  assert.strictEqual(validarOcorrencia(Object.assign({}, base, { analista_id: ' 12 ' }), t, '2026-10-18').valores.analista_id, '12');
});
teste('ocorrência: empresa, assunto (3 a 100), tipo da lista e descrição (5 a 1500, mantém as quebras de linha)', () => {
  const t = ['Erro'];
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { cliente_id: '' }), t).ok, false);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { assunto: 'ab' }), t).ok, false);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { assunto: 'a'.repeat(101) }), t).ok, false);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { assunto: 'a'.repeat(100) }), t).ok, true);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { tipo: 'Multa' }), t).ok, false, 'tipo fora da lista ativa');
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { tipo: 'Retrabalho' }), ['Retrabalho']).ok, true, 'tipo novo cadastrado entra na lista');
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { detalhe: 'oi' }), t).ok, false);
  assert.strictEqual(validarOcorrencia(Object.assign({}, oc, { detalhe: 'a'.repeat(1500) }), t).ok, true);
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
