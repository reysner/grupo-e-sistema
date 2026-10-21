'use strict';
// Rodar: node server/financeiro/testes_exportacao.js
// Roda o JavaScript das páginas /financeiro e /cs e do exportador (CSV/PDF) num DOM de mentira, com dados de exemplo, e confere:
// colunas x linhas, nenhum "undefined"/NaN, valores em R$ ocultos e o formato do CSV (Excel pt-BR).
process.env.LEGALIZACAO_SYNC_TOKEN = 'x';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fin = require('./rotas');

let ok = 0;
const teste = async (nome, fn) => { await fn(); ok++; console.log('  ok -', nome); };
const PUB = path.join(__dirname, '..', '..', 'public', 'js');

function elemento() {
  const e = new Proxy(function () {}, {
    get: (t, k) => { if (k === 'style' || k === 'classList' || k === 'dataset') return k === 'classList' ? { add() {}, remove() {}, toggle() {} } : {}; if (k === Symbol.toPrimitive) return () => ''; if (k === 'then') return undefined; if (k === 'value' || k === 'textContent' || k === 'innerHTML' || k === 'innerText') return ''; if (k === 'checked') return false; return typeof t[k] === 'function' || t[k] === undefined ? () => e : t[k]; },
    set: () => true, apply: () => e,
  });
  return e;
}
function carregar(arquivo, ganchos) {
  const fonte = fs.readFileSync(path.join(PUB, arquivo), 'utf8');
  const i = fonte.lastIndexOf('})(');
  assert.ok(i > 0, 'fim do IIFE não encontrado em ' + arquivo);
  const codigo = fonte.slice(0, i) + ';globalThis.__t = ' + ganchos + ';\n' + fonte.slice(i);
  const win = {};
  const documento = { getElementById: () => elemento(), querySelectorAll: () => [], querySelector: () => elemento(), addEventListener() {}, createElement: () => elemento(), body: elemento(), head: elemento() };
  const ctx = { window: win, document: documento, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, alert: (m) => { throw new Error('alert: ' + m); }, console, setTimeout, Promise, Date, Math, JSON, Array, Object, String, Number, Intl, RegExp, parseInt, parseFloat, isFinite, fetch: () => Promise.reject(new Error('sem rede')), URL, Blob };
  ctx.globalThis = ctx; win.document = documento;
  vm.createContext(ctx);
  vm.runInContext(codigo, ctx, { filename: arquivo });
  return { t: ctx.__t, win, ctx };
}
const semLixo = (e, nome) => {
  assert.ok(e.linhas.every((l) => l.length === e.colunas.length), nome + ': linha com número de colunas diferente do cabeçalho');
  assert.ok(e.alinhar.length === e.colunas.length, nome + ': alinhar diferente de colunas');
  const txt = JSON.stringify(e.linhas);
  assert.ok(!/undefined|NaN|\[object/.test(txt), nome + ': valor inválido na exportação: ' + (txt.match(/.{0,30}(undefined|NaN|\[object).{0,30}/) || [''])[0]);
};

(async () => {
  // ── /financeiro ──
  const B = (t) => '*Bruno Xavier:* ' + t;
  const dados = fin.compor({
    hoje: '2026-10-13',
    clientes: [
      { id: 'a', nome: 'ALFA LTDA', cnpj: '11.222.333/0001-81', grupo: 'Grupo A', cronico: false },
      { id: 'b', nome: 'BETA; "ASPAS" LTDA', cnpj: '44.555.666/0001-22', grupo: null, cronico: true },
      { id: 'c', nome: 'GAMA LTDA', cnpj: '77.888.999/0001-33', grupo: null, cronico: false },
    ],
    categorias: { a: { categoria: 'Ouro' } },
    honorarios: new Map([['11222333000181', 800], ['44555666000122', 350]]),
    abertoAgg: new Map([['11222333000181', { qtd: 3, aberto: 2400, atrasado: 1600, qtd_atrasados: 2, mais_antigo: '2026-07-10' }], ['77888999000133', { qtd: 1, aberto: 123, atrasado: 123, qtd_atrasados: 1, mais_antigo: '2026-06-10' }]]),
    titulos: [
      { doc: '11222333000181', rec: '1', venc: '2026-07-10', aberto: 800, doc_valor: 800, sit: 'A' },
      { doc: '11222333000181', rec: '2', venc: '2026-08-10', aberto: 800, doc_valor: 800, sit: 'A' },
      { doc: '11222333000181', rec: '3', venc: '2026-10-20', aberto: 800, doc_valor: 800, sit: 'V' },
    ],
    pontual: new Map([['44555666000122', { pagos: 6, media_dias: 2.8, max_dias: 9 }]]),
    suspensos: new Map([['77888999000133', { contrato: '1' }]]),
    mensagens: [{ doc: '11222333000181', dia: '2026-09-15', texto: B('Identificamos honorários em aberto da empresa.'), ticket: '900' }],
  });
  const F = carregar('financeiro.js', '{ estado: estado, dadosExport: dadosExport, linhasPorTitulo: linhasPorTitulo, COLUNAS_TITULO: COLUNAS_TITULO, abrirCompetencia: abrirCompetencia, desenharEvolucao: desenharEvolucao, desenharOportunidades: desenharOportunidades, irParaOportunidade: irParaOportunidade, listaOportunidades: listaOportunidades }');
  F.t.estado.dados = { kpis: dados.kpis, clientes: dados.clientes, valores_ocultos: false, usuario: { ve_valores: true } };
  const r1 = fin.retratoDeKpis(dados.kpis);
  F.t.estado.historico = [Object.assign({}, r1, { semana: '2026-10-05', atualizado_em: '2026-10-05 09:10', valor_atrasado: 1900, inadimplentes: 3, nunca_cobrados: 2 }), Object.assign({}, r1, { atualizado_em: '2026-10-13 17:23' })];

  await teste('financeiro: todas as seções geram colunas e linhas coerentes', () => {
    for (const sec of ['visao', 'oportunidades', 'evolucao', 'inadimplentes', 'suspensos', 'carteira', 'cobrancas', 'qualidade']) {
      const e = F.t.dadosExport(sec);
      assert.ok(e && e.colunas.length && e.linhas.length, sec + ' vazio');
      semLixo(e, 'financeiro/' + sec);
    }
  });
  await teste('financeiro: inadimplentes traz meses, valor e cobranças; CSV por título tem uma linha por honorário em aberto', () => {
    const e = F.t.dadosExport('inadimplentes');
    const alfa = e.linhas.find((l) => l[0] === 'ALFA LTDA');
    assert.deepStrictEqual([alfa[5], alfa[6], alfa[7], alfa[8], alfa[9], alfa[11]], [2, 'jun/26', 'jul/26', 2, 1600, 1]);
    const t = F.t.linhasPorTitulo(e.porTitulo);
    assert.strictEqual(t.filter((l) => l[0] === 'ALFA LTDA').length, 3);
    assert.ok(t.every((l) => l.length === F.t.COLUNAS_TITULO.length));
    assert.deepStrictEqual([...t.find((l) => l[5] === 'set/26').slice(8, 11)], ['a vencer', 0, '']);
  });
  await teste('financeiro: oportunidades (cartões, atalho para a lista filtrada) e detalhe da competência rodam sem erro', () => {
    const ops = F.t.listaOportunidades();
    assert.ok(ops.length > 0 && ops.every((o) => o.titulo && o.acao && o.qtd > 0), 'sem oportunidades');
    F.t.desenharOportunidades();
    const h0 = F.t.estado.historico;
    F.t.desenharEvolucao();                            // duas semanas: cartões com variação, gráficos e tabela
    F.t.estado.historico = [h0[1]];                    // uma semana só: sem variação, sem erro
    F.t.desenharEvolucao();
    F.t.estado.historico = [];
    F.t.desenharEvolucao();
    F.t.estado.historico = h0;
    for (const o of ops.filter((x) => x.ir)) F.t.irParaOportunidade(o.chave);
    assert.strictEqual(F.t.estado.f.inad.pag, 1);
    F.t.abrirCompetencia('2026-07');
  });
  await teste('financeiro: com "Ocultar valores" nenhum valor em R$ vai para a exportação', () => {
    F.t.estado.ocultar = true;
    for (const sec of ['visao', 'oportunidades', 'evolucao', 'inadimplentes', 'suspensos', 'carteira', 'cobrancas']) {
      const e = F.t.dadosExport(sec);
      const txt = JSON.stringify(e.linhas);
      assert.ok(!/\b(800|1600|1723|2400|350|123)\b/.test(txt), sec + ' vazou valor: ' + txt.slice(0, 200));
    }
    assert.ok(F.t.linhasPorTitulo(F.t.dadosExport('inadimplentes').porTitulo).every((l) => l[7] === 'oculto'));
    F.t.estado.ocultar = false;
  });

  // ── /cs ──
  const risco = (nivel, pontos, term, extra) => Object.assign({ nivel, pontos, alerta: false, suspenso: false, termometros: term, motivos: [] }, extra || {});
  const C = carregar('cs-painel.js', '{ estado: estado, dadosExport: dadosExport, honSugerido: honSugerido, honAnalise: honAnalise, celSugerido: celSugerido, celAnalise: celAnalise, linhasAnual: linhasAnual, filtroAnual: filtroAnual, destaqueAnual: destaqueAnual, varPct: varPct, anosAnual: anosAnual, desenharAnual: desenharAnual, destaqueLinha: destaqueLinha, reajusteLinha: reajusteLinha, desenharAtendimento: desenharAtendimento, motivoDaSaida: motivoDaSaida, selectMotivoChurn: selectMotivoChurn, cartaoMotivosChurn: cartaoMotivosChurn, dicaEmails: dicaEmails, linhasAtend: linhasAtend, abrirFichaAnual: abrirFichaAnual, abrirFichaGrupo: abrirFichaGrupo, motivosRever: motivosRever, mapaHonAnual: mapaHonAnual, regimeMudou: regimeMudou, semDadoFat: semDadoFat, secaoFicha: secaoFicha, listaOcorrenciasQ: listaOcorrenciasQ, tabelaAcessorias: tabelaAcessorias, listaRegistrosQ: listaRegistrosQ, formularioQ: formularioQ, formularioQAntigo: formularioQAntigo, listaRegistrosQAntigo: listaRegistrosQAntigo, celTerm: celTerm, cartaoOcorrenciaQ: cartaoOcorrenciaQ, tabelaOcorrenciasMod: tabelaOcorrenciasMod, filtrarPortal: filtrarPortal, htmlAnalista: htmlAnalista, htmlOcorrenciaAnalista: htmlOcorrenciaAnalista, htmlSucesso: htmlSucesso, htmlOcorrenciaSucesso: htmlOcorrenciaSucesso, htmlRetornos: htmlRetornos, alternarModuloAc: alternarModuloAc, filtrarAc: filtrarAc, iniciaisAc: iniciaisAc, htmlMatrizAc: htmlMatrizAc, htmlResumoAc: htmlResumoAc, htmlAcessos: htmlAcessos, secaoLiberada: secaoLiberada, secaoInicialCs: secaoInicialCs, resumoCalculoQ: resumoCalculoQ, listaAnalistasFiltro: listaAnalistasFiltro, casaAnalista: casaAnalista, opcoesDeptoAn: opcoesDeptoAn, opcoesRespOc: opcoesRespOc, avisoRespOc: avisoRespOc, opcoesAnalistasAg: opcoesAnalistasAg, nomesResp: nomesResp, htmlVinculos: htmlVinculos, htmlChipsResp: htmlChipsResp, analistasPorDepto: analistasPorDepto, htmlFilhaGestor: htmlFilhaGestor, marcaFilha: marcaFilha, dataHora: dataHora, htmlBackupAuto: htmlBackupAuto, htmlAbasAdm: htmlAbasAdm, htmlLogs: htmlLogs, htmlBackup: htmlBackup, htmlAcoesOcorrencia: htmlAcoesOcorrencia, rotuloPrazo: rotuloPrazo, celPrazo: celPrazo, fmtDuracao: fmtDuracao, htmlTempos: htmlTempos, htmlTemposBox: htmlTemposBox, linhaOcorrenciaExp: linhaOcorrenciaExp, situacaoPrazoExp: situacaoPrazoExp, htmlPreviaLimpeza: htmlPreviaLimpeza, noPeriodoQ: noPeriodoQ, htmlFiltrosPortalQ: htmlFiltrosPortalQ, htmlApontadoQ: htmlApontadoQ, aguardaRespostaQ: aguardaRespostaQ, badgeSucessoQ: badgeSucessoQ, badgeGestorQ: badgeGestorQ, htmlDialogoSucessoQ: htmlDialogoSucessoQ, limparEstadoDaSessao: limparEstadoDaSessao, rotuloGestor: rotuloGestor, responsavelAtualQ: responsavelAtualQ, destinoCurto: destinoCurto, casaEtapaAnalistaQ: casaEtapaAnalistaQ, diasAtePrazoQ: diasAtePrazoQ, filtrosAtivosQ: filtrosAtivosQ, htmlLimpeza: htmlLimpeza, botaoValoresVisivel: botaoValoresVisivel, perfilDe: perfilDe, filtrarGestor: filtrarGestor, contagemEtapasGestor: contagemEtapasGestor, htmlGestor: htmlGestor, htmlTratativaGestor: htmlTratativaGestor, htmlMinhasOcorrencias: htmlMinhasOcorrencias, htmlGestoresQ: htmlGestoresQ, opcoesTiposOc: opcoesTiposOc, formularioOcorrenciaQ: formularioOcorrenciaQ, seloPlanoCS, htmlPrioridadesPessoal, htmlAtendPessoal, htmlEmailsPessoal, htmlEvolucaoPessoal, SEC_PESSOAIS, usuarioDigitando, comoPesaTratativa: comoPesaTratativa, abrirNovoMotivoChurn: abrirNovoMotivoChurn }');
  C.t.estado.dados = {
    clientes: [
      { id: '1', nome: 'ALFA LTDA', cnpj: '11.222.333/0001-81', grupo: 'Grupo A', tipo_doc: 'CNPJ', categoria: 'Ouro', categoria_motivo: 'honorário R$ 800,00 (faixa R$ 500 a 999)', honorario: 800, regime: 'Lucro Presumido', questor: { faturamento: 120000.5, funcionarios: 3, aviso: null }, risco: risco('Alto', 70, { financeiro: 90, atendimento: 10, operacional: null, tratativas: 75 }, { motivos: ['Inadimplente: 3 títulos', 'Nota baixa'] }) },
      { id: '2', nome: 'ALFA FILIAL LTDA', cnpj: '11.222.333/0002-62', grupo: 'Grupo A', tipo_doc: 'CNPJ', categoria: 'Ouro', categoria_motivo: 'soma do grupo "Grupo A", 2 empresas: R$ 1.300,00 (faixa R$ 1.000 a 1.999)', honorario: 500, regime: null, questor: { faturamento: 0, funcionarios: 0, aviso: 'Natureza sem configuração' }, risco: risco('Baixo', 5, { financeiro: 0, atendimento: 0, operacional: null, tratativas: null }) },
      { id: '3', nome: 'GAMA LTDA', cnpj: '77.888.999/0001-33', grupo: null, tipo_doc: 'CNPJ', categoria: null, categoria_motivo: null, honorario: null, regime: 'Simples Nacional', questor: null, risco: risco('Suspenso', null, { financeiro: null, atendimento: null, operacional: null }, { suspenso: true }) },
    ],
    clientes_outros: [{ id: '9', nome: 'JOAO DA SILVA', cnpj: '123.456.789-09', tipo_doc: 'CPF', grupo: null, categoria: null, honorario: 100, regime: null, questor: null }],
    totais: { clientes: 3, risco: { Alto: 1, 'Médio': 0, Baixo: 1, Suspenso: 1, Incompleto: 0 }, suspensos: 1, sem_reclamacao_30d: 3, categorias: { Diamante: 0, Ouro: 2, Prata: 0, Bronze: 0, sem_categoria: 1 },
      termometros: { financeiro: { com_dado: 2, em_alerta: 1, medio_ou_mais: 1 }, atendimento: { com_dado: 2, em_alerta: 0, medio_ou_mais: 0 }, operacional: { com_dado: 0, em_alerta: 0, medio_ou_mais: 0 }, tratativas: { com_dado: 1, sem_dado: 1, em_alerta: 1, medio_ou_mais: 1 } } },
    churn: { periodos: { ultimos_12_meses: { ini: '2025-10-01', fim: '2026-10-13', base: 10, saidas_contadas: 1, taxa: 10, taxa_teto: 12, menos_de_90_dias: 0, fora_do_churn: { a_confirmar: 0, baixas: 0, outras_saidas: 0 },
      saidas: [{ nome: 'SAIU LTDA', cnpj: '10.000.000/0001-00', data_entrada: '2024-01-01', data_saida: '2026-05-01', tipo: 'transferida', origem: 'acessorias', na_base: true }, { nome: 'NOVA LTDA', cnpj: '20.000.000/0001-00', data_entrada: '2026-02-01', data_saida: '2026-04-01', tipo: 'baixa', origem: 'receita', na_base: false }] } }, padroes: [], evolucao: [] },
    config: { cortes: { medio: 30, alto: 60 }, pesos: { financeiro: 1, atendimento: 1, operacional: 1, tratativas: 1 } }, usuario: { papel: 'administrador' },
  };
  await teste('cs: todas as seções geram colunas e linhas coerentes', () => {
    C.t.estado.filtroRisco.nivel = 'todos';
    for (const sec of ['visao', 'analise', 'risco', 'churn', 'categorias']) {
      const e = C.t.dadosExport(sec);
      assert.ok(e && e.colunas.length && e.linhas.length, sec + ' vazio');
      semLixo(e, 'cs/' + sec);
    }
    assert.strictEqual(C.t.dadosExport('qualidade'), null);
  });
  await teste('cs: risco e visão geral exportam o 4º critério (Ocorrências); sem pendência fica em branco', () => {
    C.t.estado.filtroRisco.nivel = 'todos';
    const r = C.t.dadosExport('risco');
    assert.ok(r.colunas.includes('Ocorrências'));
    const i = r.colunas.indexOf('Ocorrências');
    assert.strictEqual(r.linhas.find((l) => l[0] === 'ALFA LTDA')[i], 75);
    assert.strictEqual(r.linhas.find((l) => l[0] === 'ALFA FILIAL LTDA')[i], '');
    assert.ok(C.t.dadosExport('visao').linhas.some((l) => String(l[0]).includes('Termômetro Ocorrências')));
    assert.ok(C.t.celTerm(C.t.estado.dados.clientes[1], 'tratativas').includes('—'), 'sem pendência não vira "sem dado"');
  });
  await teste('cs: ficha — plano de ação mostra só o mais recente (anteriores recolhidos), com "Responsável", e ignora o que veio do módulo', () => {
    const reg = (id, em, origem, detalhe) => ({ id, origem, tipo: 'Erro', departamentos: ['Fiscal'], detalhe, analista_nome: 'Josiane', criado_em: em, criado_por: 'Larissa', prazo: '2026-10-20', situacao: 'aberto', status: 'aberto', notas: [] });
    const h = C.t.listaRegistrosQ([reg('a', '2026-10-10T12:00:00Z', 'ficha', 'plano antigo'), reg('b', '2026-10-16T12:00:00Z', 'ficha', 'plano novo'), reg('c', '2026-10-17T12:00:00Z', 'modulo', 'ocorrência do módulo')]);
    assert.ok(h.includes('plano novo') && h.includes('<details class="qa-mais">') && h.includes('1 registro anterior') && h.includes('plano antigo'));
    assert.ok(h.indexOf('plano novo') < h.indexOf('<details'), 'o mais recente fica fora da seta');
    assert.ok(h.indexOf('plano antigo') > h.indexOf('<details'), 'o anterior fica dentro da seta');
    assert.ok(!h.includes('ocorrência do módulo'), 'o que veio do módulo Qualidade não é plano de ação');
    assert.ok(h.includes('Responsável:') && !h.includes('Analista:'));
    assert.ok(!C.t.listaRegistrosQ([reg('d', '2026-10-17T12:00:00Z', 'ficha', 'só um')]).includes('<details'), 'com um só registro não há seta');
    assert.ok(C.t.listaRegistrosQ([]).includes('Nenhum plano de ação'));
    assert.ok(C.t.listaRegistrosQAntigo([reg('a', '2026-10-10T12:00:00Z', 'ficha', 'x')]).includes('Analista:'), 'o layout antigo continua guardado');
  });
  await teste('cs: ficha — formulário novo (Descreva a tratativa + Responsável + Prazo) e Sinais de atenção com resumo da ocorrência', () => {
    const o = { tipos: ['Erro', 'Multa'], departamentos: ['Fiscal', 'Contábil'], max_detalhe: 600 };
    C.t.estado.qAnalistas = [{ id: '1', nome: 'Ana Souza' }, { id: '2', nome: 'Bruno Lima' }];
    const f = C.t.formularioQ(o);
    assert.strictEqual((f.match(/class="qa-resp-ck"/g) || []).length, 2, 'cada analista ativo vira uma caixa de marcar (vários responsáveis)');
    assert.ok(f.includes('Responsável(is)') && f.includes('id="qa-resp"') && !f.includes('<select id="qa-analista"'));
    assert.strictEqual((f.match(/class="qa-dep-ck"/g) || []).length, 2, 'vários departamentos continuam valendo');
    assert.ok(f.includes('Descreva a tratativa:') && f.includes('Responsável') && !f.includes('Descreva a ocorrência') && !f.includes('>Analista'));
    assert.ok(f.includes('class="qa-grade"') && f.indexOf('id="qa-detalhe"') < f.indexOf('id="qa-resp"') && f.indexOf('id="qa-resp"') < f.indexOf('id="qa-prazo"'));
    assert.ok(f.indexOf('Departamentos envolvidos') < f.indexOf('Descreva a tratativa:'));
    assert.ok(f.includes('não entra no card Tratativa nem no risco'));
    assert.ok(!f.includes('Tipo de registro') && !f.includes('id="qa-tipo"') && !f.includes('qa-editar-tipos'), 'a ficha não pede mais o tipo de registro');
    assert.ok(f.includes('Departamentos envolvidos'));
    assert.ok(C.t.formularioQAntigo(o).includes('Descreva a ocorrência'), 'o layout antigo continua guardado');
  });
  await teste('cs: ficha — Considerações Sucesso do Cliente / Time Operacional usa o MESMO formulário da Qualidade (abre ocorrência para o gestor), só com o título novo', () => {
    const o = { tipos: ['Erro', 'Multa'], prioridades: ['Muito Alta', 'Alta', 'Média', 'Baixa'], max_detalhe: 1500, max_anexo: 10485760, max_anexos: 5 };
    const titulo = 'Considerações Sucesso do Cliente / Time Operacional (Plano de ação)';
    const f = C.t.formularioOcorrenciaQ(o, true, titulo);
    assert.ok(f.includes('>' + titulo + '</strong>'), 'o título novo no lugar de "Registrar ocorrência"');
    assert.ok(!f.includes('>Registrar ocorrência</strong>'));
    ['oc-assunto', 'oc-resp', 'oc-anexo', 'oc-prior', 'oc-prazo', 'oc-emp', 'oc-tipo', 'oc-dep', 'oc-det', 'oc-ok'].forEach((id) => assert.ok(f.includes('id="' + id + '"'), 'campo ' + id));
    assert.ok(f.includes('OK - Registrar') && f.includes('Limpar'));
    assert.ok(C.t.formularioOcorrenciaQ(o, true).includes('>Registrar ocorrência</strong>'), 'sem título, continua "Registrar ocorrência" (tela Qualidade)');
    assert.ok(C.t.formularioOcorrenciaQ(o, true).includes('Usar só para fatos fora do padrão'), 'na tela Qualidade o aviso continua');
    assert.ok(!C.t.formularioOcorrenciaQ(o, true, titulo, true).includes('Usar só para fatos fora do padrão'), 'na ficha (Gestão da Permanência) o aviso não aparece');
  });
  await teste('cs: atualização automática — rota /versao no servidor e não atropela quem está escrevendo', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'cs', 'qualidade.js'), 'utf8');
    assert.ok(fonte.includes("router.get('/versao'") && fonte.includes("'/pendencias', '/versao'"), 'rota leve e liberada a gestor/analista');
    const js = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'cs-painel.js'), 'utf8');
    assert.ok(js.includes('MUDANCAS_MS = 10 * 1000') && js.includes('document.hidden'), 'a cada 10 s e pausa com a aba escondida');
    assert.ok(js.includes('/^(oc|ao|gt|so|qa)-/') && js.includes(".qa-overlay"), 'não atropela formulário preenchido, campo em foco nem janela aberta');
    assert.strictEqual(typeof C.t.usuarioDigitando, 'function');
  });
  await teste('cs: Minha área do analista — cinco itens no menu (como o modelo do painel), cada um com a sua tela e o seu módulo de acesso', () => {
    assert.deepStrictEqual(Array.from(C.t.SEC_PESSOAIS), ['minhanota', 'meusatend', 'meusemails', 'minhaevolucao', 'minhasprior']);
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'cs-painel.html'), 'utf8');
    ['minhanota', 'meusatend', 'meusemails', 'minhaevolucao', 'minhasprior'].forEach((s) => assert.ok(html.includes('data-sec="' + s + '"') && html.includes('id="sec-' + s + '"'), 'menu e seção de ' + s));
    assert.ok(html.includes('data-div="minha">Minha área'));
    const pri = C.t.htmlPrioridadesPessoal({ prioridades: [{ nivel: 'alta', titulo: 'Tratativa vencida: Erro', detalhe: 'ACME · prazo 2026-10-01' }], atendimentos: { vinculado: true, total: 12, janela_dias: 180 }, emails: { lido_em: '2026-10-20T10:00:00Z', sem_resposta: 2, recebidos: 9 } });
    assert.ok(pri.includes('Tratativa vencida: Erro') && pri.includes('Para agir primeiro') && !/undefined|NaN/.test(pri));
    assert.ok(C.t.htmlPrioridadesPessoal({ prioridades: [], atendimentos: {}, emails: {} }).includes('Nada urgente agora'));
    assert.ok(C.t.htmlAtendPessoal({ atendimentos: { vinculado: false } }).includes('Gamificação'), 'sem vínculo com o Zappy orienta a liderança');
    const at = C.t.htmlAtendPessoal({ atendimentos: { vinculado: true, total: 1, janela_dias: 180, sla_vermelho: 0, notas_baixas: 0, media_nota: 4.5, lista: [{ abertura: '2026-10-10T12:00:00Z', cliente_nome: 'ACME', departamento: 'Fiscal', nota_avaliacao: 5, pior_status: 'verde' }] } });
    assert.ok(at.includes('ACME') && at.includes('4,5') && !/undefined|NaN/.test(at));
    assert.ok(C.t.htmlEmailsPessoal({ emails: { lido_em: null } }).includes('ainda não foi carregada'));
    const ev = C.t.htmlEvolucaoPessoal({ evolucao: [{ semana: '2026-10-05', atendimentos: 3, lancadas: 1, resolvidas: 2 }, { semana: '2026-10-12', atendimentos: 5, lancadas: 2, resolvidas: 0 }] });
    assert.ok(ev.includes('Ocorrências recebidas') && ev.includes('Ocorrências concluídas') && !/undefined|NaN/.test(ev));
  });
  await teste('cs: ocorrência aberta pela ficha leva o selo "CS - Plano de Ação"; a da Qualidade não', () => {
    assert.ok(C.t.seloPlanoCS({ plano_cs: true }).includes('CS - Plano de Ação'));
    assert.strictEqual(C.t.seloPlanoCS({ plano_cs: false }), '');
    assert.strictEqual(C.t.seloPlanoCS({}), '');
    assert.strictEqual(C.t.seloPlanoCS(null), '');
  });
  await teste('cs: ficha — Financeiro, Acessórias, Qualidade e Atendimentos são seções que recolhem (começam recolhidas, só nome e setinha)', () => {
    const h = C.t.secaoFicha('financeiro', 'Financeiro', '<p>corpo da seção</p>');
    assert.ok(h.startsWith('<details class="ficha-det" data-sec="financeiro"><summary class="ficha-sec">') && !h.includes(' open'), 'recolhida por padrão');
    assert.ok(h.includes('Financeiro</summary><p>corpo da seção</p></details>'));
  });
  await teste('cs: ficha — seção Qualidade lista só o que foi lançado no módulo (a mais recente à vista, as anteriores recolhidas); seção Acessórias lista as obrigações', () => {
    const reg = (id, em, origem, detalhe, status) => ({ id, origem, tipo: 'Erro', departamentos: ['Fiscal'], detalhe, analista_nome: 'Josiane', criado_em: em, criado_por: 'Larissa', prazo: '2026-10-20', situacao: 'aberto', status: status || 'aberto', notas: [] });
    const h = C.t.listaOcorrenciasQ([reg('a', '2026-10-10T12:00:00Z', 'modulo', 'apuração do ISS errada'), reg('b', '2026-10-16T12:00:00Z', 'modulo', 'guia com valor divergente'), reg('c', '2026-10-17T12:00:00Z', 'ficha', 'plano de ação da ficha'), reg('d', '2026-10-17T13:00:00Z', 'modulo', 'cancelada', 'cancelado')]);
    assert.ok(h.includes('guia com valor divergente') && h.includes('<details class="qa-mais">') && h.includes('1 registro anterior') && h.includes('apuração do ISS errada'));
    assert.ok(h.indexOf('guia com valor divergente') < h.indexOf('<details') && h.indexOf('apuração do ISS errada') > h.indexOf('<details'));
    assert.ok(!h.includes('plano de ação da ficha') && !h.includes('>cancelada<'), 'plano da ficha e cancelada não entram');
    assert.ok(C.t.listaOcorrenciasQ([]).includes('Nenhuma ocorrência lançada no módulo Qualidade'));
    assert.ok(C.t.listaOcorrenciasQ([reg('c', '2026-10-17T12:00:00Z', 'ficha', 'só plano')]).includes('Nenhuma ocorrência'));
    const t = C.t.tabelaAcessorias([{ nome: 'DAS - MENSAL', competencia: '09/2026', prazo: '2026-10-05', atraso: '2026-10-10', entrega: null, situacao: 'vencida' }, { nome: 'FGTS', competencia: '08/2026', prazo: '2026-09-05', atraso: null, entrega: '2026-09-20', situacao: 'atrasada' }]);
    assert.ok(t.includes('DAS - MENSAL') && t.includes('Vencida sem entrega') && t.includes('Entregue com atraso em') && t.includes('09/2026'));
    assert.ok(C.t.tabelaAcessorias([]).includes('Nenhuma obrigação em aberto'));
  });
  await teste('cs: "Outro" no motivo do churn abre a janela para escrever o motivo sem quebrar', () => {
    C.t.abrirNovoMotivoChurn('x1', () => {}, () => {});
  });
  await teste('cs: quadro "Como a Tratativa pesa" mostra o peso de cada tipo (dobro) e o que não conta', () => {
    const h = C.t.comoPesaTratativa([{ id: 1, nome: 'Multa', peso: 25 }, { id: 2, nome: 'Erro', peso: 15 }]);
    assert.ok(h.includes('só administradores') && h.includes('Como a Tratativa pesa'));
    assert.ok(h.includes('value="25" data-tid="1"') && h.includes('<strong>50</strong>') && h.includes('value="15" data-tid="2"') && h.includes('<strong>30</strong>'), 'o peso de cada tipo é editável e mostra o dobro');
    assert.ok(h.includes('id="qpn-nome"') && h.includes('id="qpn-add"'), 'dá para incluir tipo novo');
    assert.ok(!h.includes('id="q-peso-box" open') && C.t.comoPesaTratativa([], true).includes('id="q-peso-box" open'), 'lembra se estava aberto');
    assert.ok(h.includes('1,5') && h.includes('0,25') && h.includes('não conta') && h.includes('mais de 45 dias'));
    assert.ok(C.t.comoPesaTratativa([]).includes('id="qpn-add"'), 'sem tipos ainda dá para incluir o primeiro');
  });
  await teste('cs: Registrar ocorrência — campos pedidos, prioridades e departamentos da lista, descrição até 1500, tipos cadastrados', () => {
    const f = C.t.formularioOcorrenciaQ({ tipos: ['Erro', 'Retrabalho'], prioridades: ['Muito Alta', 'Alta', 'Média', 'Baixa'], max_detalhe: 1500, max_anexo: 10485760, max_anexos: 5 });
    ['Registrar ocorrência', 'Assunto da ocorrência', 'Qual o assunto da ocorrência?', 'Arquivo anexo', 'Prioridade', 'Empresa', 'Tipo de ocorrência', 'Departamento', 'Descrição / Detalhes da ocorrência', 'OK - Registrar', 'Cancelar'].forEach((t) => assert.ok(f.includes(t), 'falta: ' + t));
    assert.ok(!f.includes('Solicitação interna') && !f.includes('interna'), 'sem a caixa de solicitação interna');
    assert.ok(f.includes('0/1500') && f.includes('maxlength="1500"'));
    assert.ok(f.indexOf('>Muito Alta<') < f.indexOf('>Alta<') && f.indexOf('>Alta<') < f.indexOf('>Média<') && f.indexOf('>Média<') < f.indexOf('>Baixa<'), 'ordem das prioridades');
    assert.ok(f.includes('<option selected>Média</option>'), 'Média vem marcada');
    ['Comercial', 'Contábil', 'Financeiro', 'Fiscal', 'Legalização', 'Pessoal', 'Sucesso do Cliente'].forEach((d) => assert.ok(f.includes('>' + d + '</option>'), 'departamento ' + d));
    assert.ok(f.includes('<option>Retrabalho</option>'), 'tipo novo cadastrado aparece no formulário');
    assert.ok(f.includes('id="oc-editar-tipos"'), 'o administrador edita a lista de tipos sem sair do formulário');
    const papel = C.t.estado.dados.usuario; C.t.estado.dados.usuario = { papel: 'usuario' };
    assert.ok(!C.t.formularioOcorrenciaQ({ tipos: ['Erro'] }).includes('oc-editar-tipos'), 'só o administrador vê o atalho');
    C.t.estado.dados.usuario = papel;
    const op = C.t.opcoesTiposOc(['Erro', 'Tipo <novo>']);
    assert.ok(op.startsWith('<option value="">Selecione o tipo…</option><option>Erro</option>') && op.includes('Tipo &lt;novo&gt;'), 'a lista vem dos tipos cadastrados, com texto escapado');
    assert.ok(f.includes('Até 5 arquivos de 10 MB cada'));
    assert.ok(f.includes('Prazo para execução') && f.includes('id="oc-prazo"') && f.includes('type="date"'), 'prazo para execução no formulário');
    assert.ok(f.includes('Usar só para fatos fora do padrão (reclamação, insatisfação, multa, caso grave), não para o atendimento do dia a dia.'), 'observação de uso');
    assert.ok(f.includes('Registrando como') && f.includes('Quem registra, a data e o horário ficam gravados na ocorrência.'), 'mostra quem registra e a data');
  });
  await teste('cs: lista de ocorrências do módulo — ações da liderança, excluir só do administrador, anexos e cartão da ficha', () => {
    const r = (id, status) => ({ id, status, situacao: status, tipo: 'Erro', prioridade: 'Alta', departamentos: ['Sucesso'], assunto: 'Guia errada', detalhe: 'Linha 1\nlinha 2', cliente_nome: 'ALFA LTDA', criado_em: '2026-10-17T12:00:00Z', criado_por: 'Larissa', anexos: [{ id: 'a1', nome: 'guia.pdf', tamanho: 2048 }], notas: [] });
    const adm = C.t.tabelaOcorrenciasMod([r('x1', 'aberto'), r('x2', 'resolvido')]);
    assert.ok(adm.includes('data-oc-res="x1"') && adm.includes('data-oc-can="x1"') && !adm.includes('data-oc-res="x2"'), 'resolver e cancelar só nas abertas');
    assert.ok(adm.includes('data-oc-del="x1"') && adm.includes('data-oc-del="x2"'), 'administrador exclui');
    assert.ok(adm.includes('Sucesso do Cliente') && adm.includes('Guia errada') && adm.includes('data-anexo="a1"') && adm.includes('2 KB'));
    const papel = C.t.estado.dados.usuario; C.t.estado.dados.usuario = { papel: 'usuario' };
    assert.ok(!C.t.tabelaOcorrenciasMod([r('x1', 'aberto')]).includes('data-oc-del'), 'usuário não exclui');
    C.t.estado.dados.usuario = papel;
    assert.ok(C.t.tabelaOcorrenciasMod([]).includes('Nenhuma ocorrência registrada ainda'));
    const c = C.t.cartaoOcorrenciaQ(r('x1', 'aberto'));
    assert.ok(c.includes('<strong>Erro</strong>') && c.includes('Alta') && c.includes('Guia errada') && c.includes('Linha 1\nlinha 2') && c.includes('guia.pdf') && c.includes('Sucesso do Cliente'));
    assert.ok(c.includes('data-oc-res="x1"') && c.includes('data-oc-can="x1"') && c.includes('data-oc-del="x1"'), 'na ficha a liderança resolve, cancela e (administrador) exclui');
    assert.ok(!C.t.cartaoOcorrenciaQ(r('x2', 'resolvido')).includes('data-oc-res'), 'resolvida não tem mais Resolver');
    assert.ok(C.t.cartaoOcorrenciaQ(Object.assign(r('x3', 'aberto'), { prazo: '2026-10-25' })).includes('prazo 25/10/2026'), 'mostra o prazo');
    assert.ok(C.t.cartaoOcorrenciaQ(r('x1', 'aberto')).includes('data-oc-prazo="x1"'), 'a administração altera o prazo');
    const papel2 = C.t.estado.dados.usuario; C.t.estado.dados.usuario = { papel: 'usuario' };
    assert.ok(!C.t.cartaoOcorrenciaQ(r('x1', 'aberto')).includes('data-oc-prazo'), 'usuário comum não altera o prazo');
    C.t.estado.dados.usuario = papel2;
    const g1 = C.t.cartaoOcorrenciaQ(Object.assign(r('x4', 'aberto'), { etapa: 'registrada', fila: 'gestor', departamentos: ['Fiscal'] }));
    assert.ok(g1.includes('Etapa: <strong>registrada, aguardando análise</strong>') && g1.includes('encaminhada a Gestor(a) Fiscal'), 'etapa e encaminhamento');
    assert.ok(C.t.cartaoOcorrenciaQ(Object.assign(r('x5', 'aberto'), { etapa: 'registrada', fila: 'sucesso', departamentos: ['Pessoal'] })).includes('encaminhada a Gestor(a) Pessoal (sem gestor cadastrado: o Sucesso do Cliente faz esta etapa)'));
    assert.ok(C.t.cartaoOcorrenciaQ(r('x1', 'aberto')).includes('Registrada em') && C.t.cartaoOcorrenciaQ(r('x1', 'aberto')).includes('por Larissa'), 'quem registrou e quando');
  });
  await teste('cs: o botão "Ocultar valores" aparece só para o administrador e some nos portais (Gestor, Analista e Sucesso do Cliente)', () => {
    ['visao', 'analise', 'anual', 'atendimento', 'consideracoes', 'risco', 'churn', 'categorias', 'qualidade'].forEach((s) => assert.strictEqual(C.t.botaoValoresVisivel(true, s), true, s));
    ['sucesso', 'acessos'].forEach((s) => assert.strictEqual(C.t.botaoValoresVisivel(true, s), true, 'aparece em: ' + s));
    ['gestor', 'analista'].forEach((s) => assert.strictEqual(C.t.botaoValoresVisivel(true, s), false, 'some em: ' + s));
    assert.strictEqual(C.t.botaoValoresVisivel(false, 'visao'), false);
    assert.strictEqual(C.t.botaoValoresVisivel(undefined, 'visao'), false);
  });
  await teste('cs: Portal do Analista — dashboard só dele, tratar com nota e observação, encerrar envia ao gestor; administrador age em nome do analista', () => {
    const r = (id, extra) => Object.assign({ id, etapa: 'com_analista', situacao: 'em_tratamento', tipo: 'Erro', prioridade: 'Alta', departamentos: ['Fiscal'], assunto: 'Guia errada ' + id, detalhe: 'Detalhe', cliente_nome: 'ALFA LTDA', criado_em: '2026-10-17T12:00:00Z', liberada_em: '2026-10-18T09:00:00Z', analista_id: '7', analista_nome: 'Josiane', prazo: '2026-10-25', plano_acao: 'Retificar a guia', tratativa_depto: 'Fiscal', tratativa_definida_por: 'Eduardo', anexos: [], notas: [] }, extra || {});
    const regs = [r('a'), r('b', { etapa: 'validacao_gestor', analista_nota: 'Guia retificada', analista_obs: 'cliente avisado', analista_por: 'Josiane', analista_em: '2026-10-19T10:00:00Z' }), r('c', { etapa: 'encerrada' })];
    const F = (f) => Object.assign({ depto: '', analista: '', etapa: '', busca: '' }, f);
    const h = C.t.htmlAnalista({ analista: { id: '7', nome: 'Josiane' }, todos: false, registros: regs }, F({}));
    assert.ok(h.includes('Sua tratativa será validada pelo seu gestor') && h.includes('Sucesso do Cliente') && h.includes('analista: Josiane'));
    assert.ok(h.includes('>Tratar<') && h.includes('>Ver<') && !h.includes('id="a-analista"'), 'analista comum não escolhe analista');
    const adm = C.t.htmlAnalista({ analista: null, todos: true, admin: true, registros: regs, analistas: [{ id: '7', nome: 'Josiane' }] }, F({}));
    assert.ok(adm.includes('id="a-analista"') && adm.includes('age em nome do analista') && adm.includes('<th>Analista</th>'));
    // administrador que escolheu um analista: a lista de analistas continua na tela (antes sumia)
    const admFiltrado = C.t.htmlAnalista({ analista: { id: '7', nome: 'Josiane' }, todos: false, admin: true, registros: regs, analistas: [{ id: '7', nome: 'Josiane' }, { id: '8', nome: 'Outra' }] }, F({ analista: '7' }));
    assert.ok(admFiltrado.includes('id="a-analista"') && admFiltrado.includes('<option value="7" selected>Josiane</option>') && admFiltrado.includes('visão do analista: Josiane'), 'o filtro de analista não some depois de escolher');
    const tratar = C.t.htmlOcorrenciaAnalista(regs[0], '');
    assert.ok(tratar.includes('Plano de ação do gestor') && tratar.includes('Retificar a guia') && tratar.includes('Observação') && tratar.includes('id="ao-enviar"') && tratar.includes('name="ao-modo" value="obs" checked') && tratar.includes('name="ao-modo" value="fin"') && !tratar.includes('Sua tratativa</div>'), 'mesmo modelo do Portal do Gestor: Observação ou Finalizar');
    assert.ok(tratar.includes('vai para a validação do seu gestor'), 'avisa o caminho depois de encerrar');
    assert.ok(C.t.htmlOcorrenciaAnalista(regs[0], 'Josiane').includes('agindo em nome de <strong>Josiane</strong>'));
    const lida = C.t.htmlOcorrenciaAnalista(regs[1], '');
    assert.ok(!lida.includes('id="ao-enviar"') && lida.includes('Guia retificada') && lida.includes('cliente avisado') && lida.includes('Analista (Josiane)'), 'depois de encerrada só leitura, com a nota e a observação');
  });
  await teste('cs: Portal do Sucesso do Cliente — dashboard de todos, devolutiva primeiro; só o gestor final vê o botão de encerrar', () => {
    const r = (id, etapa) => ({ id, etapa, situacao: 'aberto', tipo: 'Erro', prioridade: 'Alta', departamentos: ['Fiscal'], assunto: 'Guia ' + id, detalhe: 'Det', cliente_nome: 'ALFA LTDA', criado_em: '2026-10-17T12:00:00Z', criado_por: 'Larissa', analista_nome: 'Josiane', prazo: '2026-10-25', plano_acao: 'Plano', tratativa_depto: 'Fiscal', analista_nota: 'Feito', validacao_nota: 'Tudo ok', validacao_por: 'Eduardo', validacao_em: '2026-10-20T10:00:00Z', anexos: [], notas: [] });
    const regs = [r('a', 'devolutiva_cliente'), r('b', 'com_analista'), r('c', 'encerrada')];
    const F = { depto: '', analista: '', etapa: '', busca: '' };
    const final = C.t.htmlSucesso({ final: true, registros: regs }, F), nao = C.t.htmlSucesso({ final: false, registros: regs }, F);
    assert.ok(final.includes('Você é o <strong>gestor final</strong>') && final.includes('Devolutiva e encerrar'));
    assert.ok(nao.includes('Só o <strong>gestor final</strong> encerra') && nao.includes('Ver devolutiva') && !nao.includes('Devolutiva e encerrar'));
    assert.ok(final.includes('id="s-analista"') && final.includes('Todos os analistas'), 'filtro por analista no Sucesso do Cliente');
    assert.ok(final.includes('Todos os departamentos') && final.includes('id="s-depto"') && final.includes('as da devolutiva ao cliente vêm primeiro'));
    assert.ok(C.t.htmlOcorrenciaSucesso(regs[0], true).includes('id="so-encerrar"') && C.t.htmlOcorrenciaSucesso(regs[0], true).includes('Tudo ok'), 'o gestor final vê a validação do gestor e encerra');
    const semFinal = C.t.htmlOcorrenciaSucesso(regs[0], false);
    assert.ok(!semFinal.includes('id="so-encerrar"') && semFinal.includes('só o gestor final encerra o processo'), 'quem não é gestor final não encerra');
    assert.ok(!C.t.htmlOcorrenciaSucesso(regs[1], true).includes('id="so-encerrar"') && !C.t.htmlOcorrenciaSucesso(regs[2], true).includes('id="so-encerrar"'), 'só encerra o que está na devolutiva ao cliente');
    assert.ok(C.t.htmlRetornos(regs[2]).includes('Gestor validou (Eduardo)'));
    assert.strictEqual(C.t.filtrarPortal(regs, Object.assign({}, F, { etapa: 'devolutiva_cliente' })).length, 1);
  });
  await teste('cs: Portal do Gestor — validação do que o analista tratou: nota, validar (segue ao Sucesso do Cliente) ou devolver', () => {
    const base = { id: 'v', etapa: 'validacao_gestor', situacao: 'finalizada', tipo: 'Erro', prioridade: 'Alta', departamentos: ['Fiscal'], assunto: 'Guia', detalhe: 'Det', cliente_nome: 'ALFA', criado_em: '2026-10-17T12:00:00Z', analista_id: '7', analista_nome: 'Josiane', prazo: '2026-10-25', plano_acao: 'Plano', tratativa_depto: 'Fiscal', analista_nota: 'Guia retificada', analista_obs: 'cliente avisado', analista_por: 'Josiane', analista_em: '2026-10-19T10:00:00Z', anexos: [], notas: [] };
    const h = C.t.htmlTratativaGestor(base, []);
    assert.ok(h.includes('Validar a tratativa') && h.includes('Nota da validação') && h.includes('id="gv-validar"') && h.includes('id="gv-devolver"'));
    assert.ok(h.includes('Guia retificada') && h.includes('cliente avisado'), 'o gestor vê a nota e a observação do analista');
    assert.ok(h.includes('Sucesso do Cliente') && !h.includes('id="gt-salvar"'));
    const depois = C.t.htmlTratativaGestor(Object.assign({}, base, { etapa: 'devolutiva_cliente', validacao_nota: 'Tudo ok', validacao_por: 'Eduardo', validacao_em: '2026-10-20T10:00:00Z' }), []);
    assert.ok(!depois.includes('id="gv-validar"') && depois.includes('Tudo ok') && depois.includes('Guia retificada'), 'depois de validada só leitura');
  });
  await teste('cs: Acessos — matriz pessoa × módulo: administrador travado, bolinhas com estado, etiqueta Personalizado/Padrão, filtros e busca', () => {
    const cat = [{ codigo: 'visao', rotulo: 'Visão Geral', grupo: 'Indicadores da carteira' }, { codigo: 'churn', rotulo: 'Churn', grupo: 'Indicadores da carteira' }, { codigo: 'gestor', rotulo: 'Portal do Gestor', grupo: 'Qualidade e portais' }];
    const U = (id, nome, extra) => Object.assign({ id, nome, email: nome.toLowerCase() + '@x.com', papel: 'usuario', admin: false, definido: false, modulos: ['visao', 'churn'], padrao: ['visao', 'churn'], entra_padrao: true, entra_no_painel: true }, extra || {});
    const d = { catalogo: cat, usuarios: [U('1', 'Reysner Silva', { admin: true, papel: 'administrador', modulos: ['visao', 'churn', 'gestor', 'acessos'] }), U('2', 'Maria Souza', { definido: true, modulos: ['churn'] }), U('3', 'João Ágil'), U('4', 'Zé Vazio', { definido: true, modulos: [], entra_no_painel: true }), U('5', 'Sem Painel', { modulos: ['qualidade'], entra_padrao: false, entra_no_painel: false })] };
    const h = C.t.htmlMatrizAc(d, { busca: '', filtro: 'todos' });
    assert.ok(h.includes('Indicadores da carteira') && h.includes('Qualidade e portais') && h.includes('colspan="2"') && h.includes('data-col="gestor"'));
    assert.ok(h.includes('class="ac-sw on trava"'), 'administrador: bolinhas travadas');
    assert.ok(!h.includes('data-ac-sw="1|'), 'administrador não tem bolinha clicável');
    assert.ok(h.includes('data-ac-sw="2|churn"') && h.includes('aria-pressed="true"') && h.includes('aria-pressed="false"'), 'bolinhas clicáveis com estado');
    assert.ok(h.includes('aria-label="Maria Souza — Churn: vê"') && h.includes('aria-label="Maria Souza — Visão Geral: não vê"'));
    assert.ok(h.includes('ac-tag-per">Personalizado') && h.includes('ac-tag">Padrão do perfil') && h.includes('ac-tag-adm">Administrador'));
    assert.ok(h.includes('data-ac-padrao="2"') && !h.includes('data-ac-padrao="3"'), '"voltar ao padrão" só para quem foi personalizado');
    assert.ok(h.includes('Sem acesso a nada') && h.includes('Não entra no painel'));
    assert.ok(h.includes('data-ac-perfil="3"') && h.includes('Equipe completa') && h.includes('Só Qualidade e portais'));
    assert.ok(h.includes('>RS<') && h.includes('>MS<') && h.includes('>JÁ<'), 'iniciais no avatar');
    const so = (f) => C.t.filtrarAc(d.usuarios, Object.assign({ busca: '', filtro: 'todos' }, f)).map((u) => u.id);
    assert.deepStrictEqual(so({}), ['1', '2', '3', '4', '5']);
    assert.deepStrictEqual(so({ filtro: 'personalizados' }), ['2', '4']);
    assert.deepStrictEqual(so({ filtro: 'padrao' }), ['3', '5']);
    assert.deepStrictEqual(so({ filtro: 'sem' }), ['4', '5']);
    assert.deepStrictEqual(so({ busca: 'joao' }), ['3'], 'busca sem acento');
    assert.deepStrictEqual(so({ busca: 'souza@x' }), ['2'], 'busca por e-mail');
    assert.ok(C.t.htmlMatrizAc(d, { busca: 'zzz', filtro: 'todos' }).includes('Ninguém neste filtro'));
    const r = C.t.htmlResumoAc(d);
    assert.ok(r.includes('Pessoas ativas') && r.includes('Personalizados') && r.includes('Padrão do perfil') && r.includes('Sem acesso'));
    const tela = C.t.htmlAcessos(d, { busca: '', filtro: 'todos' });
    assert.ok(tela.includes('Cadastros da Qualidade') && tela.includes('data-ac-cad="analistas"') && tela.includes('data-ac-cad="tipos"') && tela.includes('data-ac-cad="gestores"') && tela.includes('Quem vê o quê'));
    assert.ok(tela.includes('id="ac-busca"') && tela.includes('data-ac-filtro="sem"') && tela.includes('class="active" data-ac-filtro="todos"'));
  });
  await teste('cs: Acessos — alternar módulo mantém a ordem do catálogo; módulos liberados mandam nas seções; seção inicial é a primeira liberada', () => {
    const cat = [{ codigo: 'visao' }, { codigo: 'churn' }, { codigo: 'gestor' }];
    assert.deepStrictEqual(C.t.alternarModuloAc(['churn'], 'visao', cat), ['visao', 'churn']);
    assert.deepStrictEqual(C.t.alternarModuloAc(['visao', 'churn'], 'visao', cat), ['churn']);
    assert.deepStrictEqual(C.t.alternarModuloAc([], 'gestor', cat), ['gestor']);
    assert.strictEqual(C.t.iniciaisAc('Maria Souza'), 'MS');
    assert.strictEqual(C.t.iniciaisAc('Josiane Alves de Oliveira Cezario'), 'JC');
    assert.strictEqual(C.t.iniciaisAc(''), '?');
    const antes = C.t.estado.eu;
    try {
      C.t.estado.eu = null;
      assert.strictEqual(C.t.secaoLiberada('churn'), null, 'sem dados dos módulos: regras de sempre');
      C.t.estado.eu = { modulos: ['churn', 'qualidade', 'sucesso'] };
      assert.strictEqual(C.t.secaoLiberada('churn'), true);
      assert.strictEqual(C.t.secaoLiberada('consideracoes'), true, 'a seção Qualidade é o módulo qualidade');
      assert.strictEqual(C.t.secaoLiberada('risco'), false);
      assert.strictEqual(C.t.secaoLiberada('acessos'), false);
      assert.strictEqual(C.t.secaoInicialCs(), 'consideracoes');
      C.t.estado.eu = { modulos: ['categorias', 'acessos'] };
      assert.strictEqual(C.t.secaoInicialCs(), 'categorias');
    } finally { C.t.estado.eu = antes; }
  });
  await teste('cs: Registrar ocorrência direto na tela — sem botão de fechar e com "Limpar"; na janela continua com ✕ e "Cancelar"', () => {
    const o = { tipos: ['Erro'], prioridades: ['Alta', 'Média'], max_anexos: 5, max_anexo: 10485760, max_detalhe: 1500 };
    const tela = C.t.formularioOcorrenciaQ(o, true), janela = C.t.formularioOcorrenciaQ(o);
    assert.ok(!tela.includes('id="oc-fechar"') && tela.includes('↩ Limpar') && !tela.includes('↩ Cancelar'));
    assert.ok(janela.includes('id="oc-fechar"') && janela.includes('↩ Cancelar'));
    for (const h of [tela, janela]) assert.ok(h.includes('id="oc-assunto"') && h.includes('id="oc-emp"') && h.includes('id="oc-tipo"') && h.includes('id="oc-dep"') && h.includes('id="oc-prazo"') && h.includes('id="oc-det"') && h.includes('id="oc-ok"') && h.includes('Usar só para fatos fora do padrão'));
  });
  await teste('cs: resumo do cálculo do risco fica na janela de Tipos de registro (e o texto é um só)', () => {
    const r = C.t.resumoCalculoQ();
    assert.ok(r.includes('Quem alimenta') && r.includes('Como cada ocorrência pesa') && r.includes('Quando entra na média') && r.includes('dobro do peso') && r.includes('limitada a 100'));
    assert.ok(C.t.comoPesaTratativa([]).includes('Como cada ocorrência pesa'), 'o bloco antigo usa o mesmo texto');
  });
  await teste('cs: Registrar ocorrência — Responsável (opcional) com os analistas pelo nome completo, ao lado do assunto', () => {
    const o = { tipos: ['Erro'], prioridades: ['Alta', 'Média'], max_anexos: 5, max_anexo: 10485760, max_detalhe: 1500, analistas: [{ id: '7', nome: 'Josiane Alves de Oliveira Cezario' }, { id: '9', nome: 'Eduardo de Queiroz Cançado Junior' }] };
    const f = C.t.formularioOcorrenciaQ(o, true);
    assert.ok(f.includes('id="oc-resp"') && f.includes('>Josiane Alves de Oliveira Cezario<') && f.includes('value="9"') && f.includes('Quem é o responsável?'));
    assert.ok(f.indexOf('id="oc-assunto"') < f.indexOf('id="oc-resp"') && f.indexOf('id="oc-resp"') < f.indexOf('id="oc-anexo"'), 'ordem da primeira linha: assunto, responsável, anexo');
    assert.ok(C.t.opcoesRespOc([]).includes('Quem é o responsável?') && !C.t.opcoesRespOc([]).includes('value="7"'));
    assert.ok(C.t.formularioOcorrenciaQ(Object.assign({}, o, { analistas: undefined }), true).includes('id="oc-resp"'), 'sem lista ainda mostra o campo');
  });
  await teste('cs: responsável × departamento — os do departamento primeiro, todos continuam disponíveis; aviso (sem bloquear) quando não é do departamento', () => {
    const an = [{ id: '1', nome: 'Bruno Cesar Xavier', departamentos: ['Financeiro', 'Legalização'] }, { id: '2', nome: 'João Victor', departamentos: ['Fiscal'] }, { id: '3', nome: 'Sem Depto', departamentos: [] }];
    const sem = C.t.opcoesRespOc(an, '', '');
    assert.ok(!sem.includes('optgroup') && sem.includes('>João Victor<') && sem.includes('Quem é o responsável?'), 'sem departamento escolhido: lista simples');
    const fis = C.t.opcoesRespOc(an, 'Fiscal', '2');
    assert.ok(fis.includes('<option value="2" selected>João Victor</option>') && !fis.includes('Bruno Cesar Xavier') && !fis.includes('Sem Depto') && !fis.includes('optgroup'), 'com departamento escolhido: só os analistas dele');
    const leg = C.t.opcoesRespOc(an, 'Legalização', '');
    assert.ok(leg.includes('<option value="1">Bruno Cesar Xavier</option>') && !leg.includes('João Victor'), 'Bruno atende dois departamentos');
    assert.ok(C.t.opcoesRespOc(an, 'Financeiro', '').includes('Bruno Cesar Xavier') && !C.t.opcoesRespOc(an, 'Financeiro', '').includes('João Victor'));
    const pes = C.t.opcoesRespOc(an, 'Pessoal', '');
    assert.ok(pes.includes('João Victor') && pes.includes('Bruno Cesar Xavier') && pes.includes('Sem Depto'), 'ninguém do departamento: a lista inteira, para não travar');
    assert.ok(C.t.opcoesAnalistasAg(an, 'Fiscal', '', 'Escolha o analista…').includes('Escolha o analista…'));
    assert.strictEqual(C.t.avisoRespOc(an[0], 'Legalização'), '');
    assert.strictEqual(C.t.avisoRespOc(an[1], 'Contábil'), 'João Victor não é do departamento Contábil (atende Fiscal).');
    assert.ok(C.t.avisoRespOc(an[2], 'Fiscal').includes('ainda não tem departamento'));
    assert.strictEqual(C.t.avisoRespOc(null, 'Fiscal'), '');
    assert.strictEqual(C.t.avisoRespOc(an[1], ''), '', 'um departamento só e nada escolhido: o formulário preenche, sem aviso');
    assert.strictEqual(C.t.avisoRespOc({ nome: 'Bruno', departamentos: ['Financeiro', 'Legalização'] }, ''), 'Bruno atende Financeiro e Legalização: escolha o departamento.', 'vários departamentos: pede para escolher');
    const dp = C.t.opcoesDeptoAn({ departamentos: ['Financeiro', 'Legalização'] }, '');
    assert.ok(dp.includes('<option value="Financeiro">Financeiro</option>') && dp.includes('<option value="Legalização">Legalização</option>') && !dp.includes('Comercial') && !dp.includes('Fiscal') && !dp.includes('Pessoal') && !dp.includes('optgroup'), 'só os dois departamentos do Bruno');
    const um = C.t.opcoesDeptoAn({ departamentos: ['Fiscal'] }, '');
    assert.ok(um.includes('value="Fiscal"') && !um.includes('value="Contábil"'), 'quem tem um departamento só vê só ele');
    assert.ok(C.t.opcoesDeptoAn(null, '').includes('value="Comercial"') && C.t.opcoesDeptoAn({ departamentos: [] }, '').includes('value="Pessoal"'), 'sem analista ou sem departamento cadastrado: todos');
    assert.ok(C.t.opcoesDeptoAn({ departamentos: ['Fiscal'] }, 'Fiscal').includes('<option value="Fiscal" selected>Fiscal</option>'));
    assert.ok(!C.t.opcoesDeptoAn({ departamentos: [] }, '').includes('optgroup') && !C.t.opcoesDeptoAn(null, '').includes('optgroup'), 'sem departamento cadastrado: lista simples');
    assert.ok(C.t.formularioOcorrenciaQ({ tipos: ['Erro'], analistas: an }, true).includes('id="oc-resp-aviso"'));
  });
  await teste('cs: ocorrência com vários responsáveis e filhas — matriz só de comunicação; formulário antigo nas já definidas, o indicado fixo, devolutiva por analista, filha sem apontar a origem', () => {
    const an = [{ id: '1', nome: 'Bruno Cesar Xavier', departamentos: ['Financeiro'] }, { id: '2', nome: 'João Victor', departamentos: ['Fiscal'] }, { id: '3', nome: 'Ana Souza', departamentos: [] }];
    const base = { id: 'p', etapa: 'registrada', situacao: 'aberto', tipo: 'Erro', prioridade: 'Alta', departamentos: ['Fiscal'], assunto: 'Guia', detalhe: 'Det', cliente_nome: 'ALFA', criado_em: '2026-10-17T12:00:00Z', prazo: '2026-10-25', analista_origem_id: '3', analista_origem_nome: 'Ana Souza', responsaveis: [], filhas: [], anexos: [], notas: [] };
    const h = C.t.htmlTratativaGestor(base, an);
    assert.ok(h.includes('Analista indicado no registro: <strong>Ana Souza</strong>') && h.includes('Isso fica só com você'), 'o gestor vê quem foi indicado');
    assert.ok(!h.includes('id="gt-resp"') && !h.includes('id="gt-plano"') && h.includes('Resposta final ao Sucesso do Cliente'), 'a matriz nova não tem o formulário da tratativa: só a resposta final e as vinculadas');
    assert.ok(!h.includes('type="checkbox"') && !h.includes('gt-resp-ck'), 'sem a lista de caixas de analistas');
    const ant = C.t.estado.qAnalistas; C.t.estado.qAnalistas = an;
    try { assert.deepStrictEqual(JSON.parse(JSON.stringify(C.t.analistasPorDepto('Fiscal').map((x) => x.nome))), ['João Victor', 'Ana Souza', 'Bruno Cesar Xavier'], 'no @, os do departamento vêm primeiro'); } finally { C.t.estado.qAnalistas = ant; }
    assert.ok(h.includes('id="gt-filha"') && h.includes('Abrir ocorrência vinculada') && !h.includes('id="gt-analista"'));
    const dois = C.t.htmlTratativaGestor(Object.assign({}, base, { etapa: 'tratativa_definida', responsaveis: [{ analista_id: '1', nome: 'Bruno Cesar Xavier' }, { analista_id: '2', nome: 'João Victor' }] }), an);
    assert.ok(!dois.includes('id="gt-resp"') && !dois.includes('id="gt-plano"') && !dois.includes('id="gt-salvar"') && dois.includes('Resposta final ao Sucesso do Cliente'), 'não existe mais o formulário de tratativa na matriz (a conversa com os analistas é nas vinculadas)');
    const aberta = C.t.htmlTratativaGestor(Object.assign({}, base, { etapa: 'com_analista', plano_acao: 'Plano', tratativa_depto: 'Fiscal', responsaveis: [{ analista_id: '1', nome: 'Bruno Cesar Xavier' }, { analista_id: '2', nome: 'João Victor' }], filhas: [{ id: 'f', assunto: 'Alinhar com o Bruno', etapa: 'com_analista', departamentos: ['Financeiro'], analista_nome: 'Bruno Cesar Xavier', prazo: '2026-10-28' }] }), an);
    assert.ok(aberta.includes('Responsáveis: <strong>Bruno Cesar Xavier, João Victor</strong>') && aberta.includes('Ocorrências vinculadas') && aberta.includes('Alinhar com o Bruno') && aberta.includes('id="gt-filha"'), 'aberta: mostra os responsáveis, as filhas e ainda deixa vincular outra');
    const filha = C.t.htmlTratativaGestor(Object.assign({}, base, { id: 'f', origem: 'filha', etapa: 'validacao_gestor', analista_origem_nome: null, pai: null, plano_acao: 'P', tratativa_depto: 'Financeiro', responsaveis: [{ analista_id: '1', nome: 'Bruno Cesar Xavier', nota: 'Feito', encerrado_em: '2026-10-20T10:00:00Z' }] }), an);
    assert.ok(filha.includes('encerra esta ocorrência vinculada') && filha.includes('Validar: encerrar esta ocorrência') && !filha.includes('enviar ao Sucesso do Cliente'), 'a filha validada encerra, sem devolutiva ao cliente');
    assert.ok(C.t.htmlVinculos({ pai: { assunto: 'Original X' }, filhas: [] }).includes('vinculada a: <strong>Original X</strong>') && C.t.htmlVinculos({ pai: null, filhas: [] }) === '', 'sem pai e sem filhas, nada aparece');
    assert.ok(C.t.marcaFilha({ origem: 'filha' }).includes('vinculada') && C.t.marcaFilha({ origem: 'modulo' }) === '');
    const ret = C.t.htmlRetornos({ responsaveis: [{ nome: 'Bruno', nota: 'Conferi', encerrado_em: '2026-10-20T10:00:00Z' }, { nome: 'João', nota: 'Falta ajustar', encerrado_em: null }] });
    assert.ok(ret.includes('Analista (Bruno)') && ret.includes('Analista (João)') && ret.includes('ainda não encerrou') && ret.includes('Conferi'), 'uma devolutiva por responsável');
    const f = C.t.htmlFilhaGestor({ id: 'p', assunto: 'Guia', cliente_nome: 'ALFA', departamentos: ['Fiscal'] }, an);
    assert.ok(f.includes('id="gf-assunto" maxlength="100" value="Guia"'), 'o assunto da vinculada já vem com o nome da original (editável)');
    assert.ok(f.includes('id="gf-empresa-x"') && f.includes('<span>ALFA</span>') && f.includes('id="gf-empresa-volta"'), 'a empresa aparece fixa, com ✕ para tirar (e opção de mostrar de novo)');
    assert.ok(C.t.marcaFilha({ origem: 'filha', ocultar_empresa: true, cliente_nome: 'ALFA' }).includes('empresa oculta ao analista') && !C.t.marcaFilha({ origem: 'filha', ocultar_empresa: true, cliente_nome: null }).includes('empresa oculta'), 'a liderança vê o aviso; o analista (empresa já tirada) não');
    assert.ok(f.includes('Abrir ocorrência vinculada') && f.includes('id="gf-assunto"') && f.includes('id="gf-plano"') && f.includes('id="gf-resp"') && f.includes('id="gf-depto"') && f.includes('id="gf-prazo"') && f.includes('id="gf-ok"'));
    assert.ok(f.includes('Digite @ para chamar um analista') && f.includes('<option value="Fiscal" selected>Fiscal</option>') && !f.includes('id="gf-mostrar" checked'), 'por padrão não mostra a origem');
    assert.ok(f.includes('Mostrar a origem e o analista do registro') && f.includes('fica só com você'));
    assert.ok(f.includes('id="gf-obs"') && f.includes('maxlength="1500"') && f.includes('0/1500') && f.includes('Digite @ para chamar um analista'), 'observação da vinculada: textarea larga, até 1500, com @');
    assert.ok(f.includes('data-vazio="1"') && f.includes('digite @ no plano de ação'), 'a ocorrência vinculada começa sem ninguém e chama com @');
    assert.ok(C.t.htmlChipsResp([{ id: '5', nome: 'Kelen Garcia da Silva' }]).includes('data-chip="5"') && C.t.htmlChipsResp([{ id: '5', nome: 'Kelen' }]).includes('data-chip-x="5"'), 'cada etiqueta tem o ✕ para retirar');
    assert.ok(C.t.htmlChipsResp([]).includes('Ninguém ainda'));
  });
  await teste('cs: Portal do Analista — vários responsáveis (já encerrei / aguardando), em nome de, e sem o quadro "Ocorrências sobre mim"', () => {
    const r = (extra) => Object.assign({ id: 'a', etapa: 'com_analista', situacao: 'em_tratamento', tipo: 'Erro', prioridade: 'Alta', departamentos: ['Fiscal'], assunto: 'Guia', detalhe: 'Det', cliente_nome: 'ALFA', criado_em: '2026-10-17T12:00:00Z', prazo: '2026-10-25', plano_acao: 'Plano', tratativa_depto: 'Fiscal', responsaveis: [{ analista_id: '7', nome: 'Josiane', encerrado_em: '2026-10-19T10:00:00Z', nota: 'Feito' }, { analista_id: '9', nome: 'Bruno', encerrado_em: null }], filhas: [], anexos: [], notas: [] }, extra || {});
    const euJa = C.t.htmlOcorrenciaAnalista(r(), '', '7', false);
    assert.ok(!euJa.includes('id="ao-enviar"') && euJa.includes('Você já encerrou a sua parte') && euJa.includes('Aguardando: <strong>Bruno</strong>'), 'quem já encerrou só espera');
    const euFalta = C.t.htmlOcorrenciaAnalista(r(), '', '9', false);
    assert.ok(euFalta.includes('id="ao-enviar"') && euFalta.includes('quando todos os responsáveis tiverem finalizado') && !euFalta.includes('id="ao-quem"'));
    const adm = C.t.htmlOcorrenciaAnalista(r({ responsaveis: [{ analista_id: '7', nome: 'Josiane', encerrado_em: null }, { analista_id: '9', nome: 'Bruno', encerrado_em: null }] }), 'Josiane, Bruno', null, false);
    assert.ok(adm.includes('id="ao-quem"') && adm.includes('Encerrar em nome de') && adm.includes('value="9"'), 'o administrador escolhe em nome de quem encerra');
    const espera = C.t.htmlOcorrenciaAnalista(r({ responsaveis: [{ analista_id: '7', nome: 'Josiane', encerrado_em: '2026-10-19T10:00:00Z' }], filhas: [{ id: 'f', assunto: 'Alinhar', etapa: 'com_analista', departamentos: ['Pessoal'], analista_nome: 'Ana', prazo: '2026-10-28' }] }), '', '7', false);
    assert.ok(espera.includes('Aguardando as ocorrências vinculadas') && espera.includes('Alinhar'), 'todos encerraram, mas falta uma filha');
    assert.ok(!C.t.htmlOcorrenciaAnalista(r(), '', '9', true).includes('id="ao-enviar"'), 'sobre mim: só leitura');
    const tela = C.t.htmlAnalista({ analista: { id: '7', nome: 'Josiane' }, todos: false, registros: [r()], sobre_mim: [r({ id: 's', etapa: 'registrada' })] }, { depto: '', analista: '', etapa: '', busca: '' });
    assert.ok(!tela.includes('Ocorrências sobre mim') && tela.includes('>Ver<') && !tela.includes('>Tratar<'), 'sem o quadro "sobre mim"; já encerrei: o botão vira Ver');
  });
  await teste('cs: filha encerra sem outra validação; original pode ser conduzida só pelas filhas (sem responsável)', () => {
    const f = C.t.htmlOcorrenciaAnalista({ id: 'f', origem: 'filha', etapa: 'com_analista', situacao: 'em_tratamento', tipo: 'Erro', prioridade: 'Alta', departamentos: ['Financeiro'], assunto: 'Alinhar', detalhe: 'Plano', cliente_nome: 'ALFA', criado_em: '2026-10-17T12:00:00Z', prazo: '2026-10-25', plano_acao: 'Plano', tratativa_depto: 'Financeiro', responsaveis: [{ analista_id: '1', nome: 'Bruno', encerrado_em: null }], filhas: [], anexos: [], notas: [] }, '', '1', false);
    assert.ok(f.includes('esta ocorrência vinculada é concluída') && f.includes('libera a original') === false && f.includes('ajuda a liberar a original') && !f.includes('Sucesso do Cliente fazer a devolutiva'), 'a filha não vai para o Sucesso do Cliente');
    const so = C.t.htmlTratativaGestor({ id: 'p', etapa: 'com_analista', situacao: 'em_tratamento', tipo: 'Erro', prioridade: 'Alta', departamentos: ['Fiscal'], assunto: 'Guia', detalhe: 'Det', cliente_nome: 'ALFA', criado_em: '2026-10-17T12:00:00Z', prazo: '2026-10-25', plano_acao: 'Plano', tratativa_depto: 'Fiscal', responsaveis: [], filhas: [{ id: 'f', assunto: 'Alinhar', etapa: 'com_analista', departamentos: ['Financeiro'], analista_nome: 'Bruno', prazo: '2026-10-28' }], anexos: [], notas: [] }, []);
    assert.ok(so.includes('Converse com os analistas pelas vinculadas') && !so.includes('Tratativa</div>'), 'sem responsável próprio: a matriz é só comunicação e a conversa com os analistas é nas vinculadas');
  });
  await teste('cs: filtro Analista dos portais usa a lista oficial (nome completo) e, com departamento, mostra os dele; acha o analista como um dos responsáveis', () => {
    const an = [{ id: '1', nome: 'Bruno Cesar Xavier', departamentos: ['Financeiro', 'Legalização'], ativo: true }, { id: '2', nome: 'João Victor', departamentos: ['Fiscal'], ativo: true }, { id: '3', nome: 'Ana Souza', departamentos: [], ativo: true }, { id: '4', nome: 'Antigo', departamentos: ['Fiscal'], ativo: false }];
    const nomes = (l) => JSON.parse(JSON.stringify(l.map((a) => a.nome)));
    assert.deepStrictEqual(nomes(C.t.listaAnalistasFiltro({ analistas: an }, [], '')), ['Ana Souza', 'Bruno Cesar Xavier', 'João Victor'], 'sem departamento: todos os ativos, mesmo sem ocorrência');
    assert.deepStrictEqual(nomes(C.t.listaAnalistasFiltro({ analistas: an }, [], 'Fiscal')), ['João Victor'], 'com departamento: só os dele');
    assert.deepStrictEqual(nomes(C.t.listaAnalistasFiltro({ analistas: an }, [], 'Legalização')), ['Bruno Cesar Xavier'], 'atende dois departamentos');
    assert.deepStrictEqual(nomes(C.t.listaAnalistasFiltro({ analistas: an }, [], 'Pessoal')), ['Ana Souza', 'Bruno Cesar Xavier', 'João Victor'], 'departamento sem ninguém cadastrado: não deixa a lista vazia');
    assert.deepStrictEqual(nomes(C.t.listaAnalistasFiltro({}, [{ analista_id: '9', analista_nome: 'Zé' }], '')), ['Zé'], 'sem a lista oficial: os das ocorrências');
    const reg = { analista_id: '1', analista_origem_id: '3', responsaveis: [{ analista_id: '1' }, { analista_id: '2' }] };
    assert.ok(C.t.casaAnalista(reg, '2') && C.t.casaAnalista(reg, '1') && C.t.casaAnalista(reg, '3') && !C.t.casaAnalista(reg, '9'), 'responsável, principal ou indicado');
    const h = C.t.htmlSucesso({ final: true, analistas: an, registros: [] }, { depto: 'Fiscal', analista: '', etapa: '', busca: '' });
    assert.ok(h.includes('<option value="2">João Victor</option>') && !h.includes('Bruno Cesar Xavier'), 'o Sucesso do Cliente lista os analistas do departamento mesmo sem ocorrências');
    const g = C.t.htmlGestor({ escopo: { todos: true, deptos: [] }, analistas: an, registros: [] }, { depto: '', analista: '', etapa: '', busca: '' });
    assert.ok(g.includes('<option value="1">Bruno Cesar Xavier</option>') && g.includes('<option value="3">Ana Souza</option>'), 'o Portal do Gestor também');
  });
  await teste('cs: data e horário no horário de Brasília (e só a data quando o valor não traz hora)', () => {
    assert.strictEqual(C.t.dataHora('2026-10-17T20:54:00.000Z'), '17/10/2026 às 17:54');
    assert.strictEqual(C.t.dataHora('2026-10-18T02:30:00Z'), '17/10/2026 às 23:30', 'vira o dia no fuso de Brasília');
    assert.strictEqual(C.t.dataHora('2026-10-25'), '25/10/2026', 'prazo é só data');
    assert.strictEqual(C.t.dataHora(null), '—');
    assert.strictEqual(C.t.dataHora('lixo'), 'lixo'.slice(8, 10) + '/' + 'lixo'.slice(5, 7) + '/' + 'lixo'.slice(0, 4), 'valor estranho não quebra a tela');
    const f = C.t.formularioOcorrenciaQ({ tipos: ['Erro'], analistas: [] }, true);
    assert.ok(/em <strong>\d{2}\/\d{2}\/\d{4}<\/strong>\./.test(f) && !/às \d{2}:\d{2}/.test(f), 'o formulário mostra só a data (o horário real é gravado ao registrar)');
  });
  await teste('cs: Acessos tem as abas Logs de atividades e Backup; logs com filtros e tabela; backup com os dois downloads e o aviso de guardar o arquivo', () => {
    const abas = C.t.htmlAbasAdm('logs');
    assert.ok(abas.includes('data-adm-aba="acessos"') && abas.includes('Logs de atividades') && abas.includes('>Backup<') && abas.includes('data-adm-aba="logs" class="active"') && abas.includes('data-adm-aba="backup" class=""'));
    const d = { limite: 300, modulos: [{ modulo: 'cs-qualidade', n: 12 }, { modulo: 'cs-acessos', n: 3 }], usuarios: ['Reysner', 'Eduardo'], acoes: ['criar', 'editar'], logs: [{ created_at: '2026-10-17T20:54:00Z', user_name: 'Reysner', modulo: 'cs-acessos', acao: 'editar', descricao: 'Definiu os módulos de acesso: visao — Maira', ip: '1.2.3.4' }, { created_at: '2026-10-17T21:10:00Z', user_name: 'Eduardo', modulo: 'cs-qualidade', acao: 'criar', descricao: 'Registrou uma ocorrência: <b>x</b>', ip: null }] };
    const h = C.t.htmlLogs(d, { modulo: 'cs', user: 'todos', acao: 'todas', busca: '', de: '', ate: '' });
    assert.ok(h.includes('17/10/2026 às 17:54') && h.includes('Definiu os módulos de acesso') && h.includes('Acessos') && h.includes('Qualidade') && h.includes('2 registro(s)'));
    assert.ok(h.includes('id="lg-modulo"') && h.includes('id="lg-user"') && h.includes('id="lg-acao"') && h.includes('id="lg-de"') && h.includes('id="lg-ate"') && h.includes('id="lg-busca"') && h.includes('Qualidade (12)'));
    assert.ok(h.includes('&lt;b&gt;x&lt;/b&gt;') && !h.includes('<b>x</b>'), 'o texto do log não injeta HTML');
    assert.ok(C.t.htmlLogs({ logs: [], limite: 300 }, { modulo: 'cs', user: 'todos', acao: 'todas' }).includes('Nenhuma atividade neste filtro ainda'));
    assert.ok(C.t.htmlLogs({ logs: new Array(300).fill({ created_at: '2026-10-17T20:54:00Z', user_name: 'A', modulo: 'cs-acessos', acao: 'editar' }), limite: 300 }, { modulo: 'cs', user: 'todos', acao: 'todas' }).includes('mostrando os 300 mais recentes'));
    const b = C.t.htmlBackup({ totais: { analistas: 28, cs_qualidade_registros: 4 }, ultimos: [{ created_at: '2026-10-17T20:54:00Z', user_name: 'Reysner', descricao: 'Baixou o backup' }] });
    assert.ok(b.includes('data-bk="qualidade"') && b.includes('data-bk="completo"') && b.includes('Baixar backup completo') && b.includes('analistas') && b.includes('>28<') && b.includes('Reysner'));
    assert.ok(b.includes('O servidor não guarda cópias') && b.includes('A restauração não é feita por esta tela'));
    assert.ok(C.t.htmlBackup({}).includes('Nenhum backup baixado ainda'));
    const auto = [{ id: 'a1', gerado_em: '2026-10-18T06:03:00Z', totais: { clientes: 631, atendimentos: 90, cs_tickets: 5 } }, { id: 'a2', gerado_em: '2026-10-17T06:03:00Z', totais: {} }];
    const ha = C.t.htmlBackupAuto(auto);
    assert.ok(ha.includes('Backup automático') && ha.includes('ligado') && ha.includes('30 mais recentes') && ha.includes('Qualidade, ocorrências, analistas, gestores e acessos'));
    assert.ok(ha.includes('18/10/2026 às 03:03') && ha.includes('631 clientes · 90 atendimentos · 5 tickets') && ha.includes('data-bka="a1"') && ha.includes('data-bka="a2"') && ha.includes('2 guardada(s)'));
    assert.ok(ha.includes('não substituem uma cópia guardada fora'), 'avisa que está no mesmo banco');
    assert.ok(C.t.htmlBackupAuto([]).includes('Nenhuma cópia automática guardada ainda') && !C.t.htmlBackupAuto([]).includes('data-bka'));
    assert.ok(C.t.htmlBackup({ totais: {} }, auto).includes('Backup automático') && C.t.htmlBackup({ totais: {} }, auto).includes('Backup manual completo do sistema'));
  });
  await teste('cs: cancelar e reabrir ocorrência — botões certos para cada etapa, etapa Cancelada com cor e rótulo, e também no Sucesso do Cliente (só gestor final e administração)', () => {
    const a = (etapa) => C.t.htmlAcoesOcorrencia({ etapa });
    ['registrada', 'tratativa_definida', 'com_analista', 'validacao_gestor', 'devolutiva_cliente'].forEach((e) => assert.ok(a(e).includes('id="gt-cancelar-oc"') && !a(e).includes('id="gt-reabrir-oc"'), 'cancelável em ' + e));
    assert.ok(a('cancelada').includes('id="gt-reabrir-oc"') && a('cancelada').includes('volta para a etapa em que estava') === false && a('cancelada').includes('Volta para a etapa em que estava'));
    assert.ok(a('encerrada').includes('id="gt-reabrir-oc"') && a('encerrada').includes('só o gestor final e a administração'));
    assert.strictEqual(a('cancelada').includes('gt-cancelar-oc'), false);
    const base = { id: 'x', etapa: 'encerrada', situacao: 'resolvido', tipo: 'Erro', prioridade: 'Alta', departamentos: ['Fiscal'], assunto: 'Guia', detalhe: 'Det', cliente_nome: 'ALFA', criado_em: '2026-10-17T12:00:00Z', responsaveis: [], filhas: [], anexos: [], notas: [] };
    assert.ok(C.t.htmlTratativaGestor(base, []).includes('id="gt-reabrir-oc"'), 'o gestor vê Reabrir numa encerrada');
    assert.ok(C.t.htmlTratativaGestor(Object.assign({}, base, { etapa: 'com_analista' }), []).includes('id="gt-cancelar-oc"'), 'e Cancelar numa em tratamento');
    assert.ok(C.t.htmlOcorrenciaSucesso(Object.assign({}, base, { etapa: 'devolutiva_cliente' }), true).includes('id="gt-cancelar-oc"'), 'o gestor final cancela pelo Sucesso do Cliente');
    assert.ok(!C.t.htmlOcorrenciaSucesso(Object.assign({}, base, { etapa: 'devolutiva_cliente' }), false).includes('id="gt-cancelar-oc"'), 'quem não é gestor final nem administrador não vê');
    assert.ok(C.t.htmlOcorrenciaSucesso(base, true).includes('id="gt-reabrir-oc"'));
    // excluir de vez: só no Portal do Sucesso do Cliente (gestor final/administração), em qualquer etapa; o Portal do Gestor não oferece
    ['registrada', 'com_analista', 'encerrada', 'cancelada'].forEach((et) => assert.ok(C.t.htmlOcorrenciaSucesso(Object.assign({}, base, { etapa: et }), true).includes('id="gt-excluir-oc"'), 'excluir em ' + et));
    assert.ok(!C.t.htmlTratativaGestor(Object.assign({}, base, { etapa: 'com_analista' }), []).includes('gt-excluir-oc'), 'o Portal do Gestor não exclui');
    assert.ok(!C.t.htmlOcorrenciaSucesso(base, false).includes('gt-excluir-oc'), 'quem não é gestor final nem administrador não vê o Excluir');
    const p = C.t.htmlGestor({ escopo: { todos: true, deptos: [] }, registros: [Object.assign({}, base, { etapa: 'cancelada', status: 'cancelado' })] }, { depto: '', analista: '', etapa: '', busca: '' });
    assert.ok(p.includes('Cancelada') && p.includes('value="cancelada"'), 'a lista do gestor mostra a etapa Cancelada e deixa filtrar por ela');
  });
  await teste('cs: prazo perto ou vencido aparece na tabela ("vence amanhã", "vence hoje", "vencida há N dias") só enquanto a ocorrência está em andamento', () => {
    const rp = (prazo, etapa) => C.t.rotuloPrazo(prazo, etapa, '2026-10-18');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rp('2026-10-19', 'com_analista'))), { txt: 'vence amanhã', cor: '#b45309' });
    assert.strictEqual(rp('2026-10-18', 'registrada').txt, 'vence hoje');
    assert.strictEqual(rp('2026-10-17', 'validacao_gestor').txt, 'vencida há 1 dia');
    assert.strictEqual(rp('2026-10-10', 'devolutiva_cliente').txt, 'vencida há 8 dias');
    assert.strictEqual(rp('2026-10-25', 'com_analista'), null, 'longe do prazo: sem aviso');
    assert.strictEqual(rp('2026-10-10', 'encerrada'), null, 'encerrada não tem prazo correndo');
    assert.strictEqual(rp('2026-10-10', 'cancelada'), null);
    assert.strictEqual(rp(null, 'com_analista'), null);
    const c = C.t.celPrazo({ prazo: '2026-10-17', etapa: 'com_analista' }, '2026-10-18');
    assert.ok(c.startsWith('17/10/2026') && c.includes('vencida há 1 dia') && c.includes('#b91c1c'));
    assert.strictEqual(C.t.celPrazo({ prazo: '2026-10-25', etapa: 'com_analista' }, '2026-10-18'), '25/10/2026');
  });
  await teste('cs: tempo médio por etapa — formato da duração, tabela por etapa e por departamento, e a caixa nos portais do Gestor e do Sucesso do Cliente', () => {
    assert.strictEqual(C.t.fmtDuracao(null), '—');
    assert.strictEqual(C.t.fmtDuracao(0.2), '12 min');
    assert.strictEqual(C.t.fmtDuracao(0.001), '1 min');
    assert.strictEqual(C.t.fmtDuracao(7.54), '7,5 h');
    assert.strictEqual(C.t.fmtDuracao(47), '47 h');
    assert.strictEqual(C.t.fmtDuracao(48), '2 dias');
    assert.strictEqual(C.t.fmtDuracao(80), '3,3 dias');
    const d = { ocorrencias: 4, etapas: [{ chave: 'gestor', rotulo: 'Com o gestor (análise até abrir para o analista)', n: 3, media_h: 5, mediana_h: 4, max_h: 9 }, { chave: 'total', rotulo: 'Do registro ao encerramento', n: 2, media_h: 100, mediana_h: 100, max_h: 120 }], por_departamento: [{ departamento: 'Fiscal', encerradas: 2, gestor_media_h: 5, analista_media_h: 50, total_media_h: 100 }, { departamento: 'Sucesso', encerradas: 0, gestor_media_h: null, analista_media_h: null, total_media_h: null }] };
    const h = C.t.htmlTempos(d, { de: '', ate: '', depto: '' });
    assert.ok(h.includes('4 ocorrência(s) no filtro') && h.includes('Com o gestor') && h.includes('>5 h<') && h.includes('4,2 dias') && h.includes('Por departamento') && h.includes('>Fiscal<'));
    assert.ok(!h.includes('Sucesso do Cliente</td><td class="c">0'), 'departamento sem nada não polui a tabela');
    assert.ok(h.includes('id="tp-de"') && h.includes('id="tp-ate"') && h.includes('id="tp-depto"') && h.includes('id="tp-atualizar"'));
    assert.ok(C.t.htmlTemposBox().includes('Tempo médio por etapa') && C.t.htmlTemposBox().includes('id="tp-corpo"'));
    const reg = { escopo: { todos: true, deptos: [] }, registros: [] };
    assert.ok(C.t.htmlGestor(reg, { depto: '', analista: '', etapa: '', busca: '' }).includes('id="tp-box"'), 'Portal do Gestor');
    assert.ok(C.t.htmlSucesso({ final: false, registros: [] }, { depto: '', analista: '', etapa: '', busca: '' }).includes('id="tp-box"'), 'Portal do Sucesso do Cliente');
  });
  await teste('cs: exportar (CSV e PDF) o que está filtrado nos portais do Gestor, do Analista e do Sucesso do Cliente — com data e hora, responsáveis, etapa e situação do prazo', () => {
    const regs = [
      { id: '1', etapa: 'com_analista', situacao: 'em_tratamento', tipo: 'Erro', prioridade: 'Alta', departamentos: ['Fiscal'], assunto: 'Guia errada', cliente_nome: 'ALFA LTDA', criado_em: '2026-10-17T20:54:00Z', criado_por: 'Reysner', prazo: '2099-12-31', plano_acao: 'Retificar a guia', analista_origem_nome: 'Ana Souza', responsaveis: [{ nome: 'Bruno' }, { nome: 'João' }], analista_id: '1', filhas: [], anexos: [], notas: [] },
      { id: '2', etapa: 'encerrada', situacao: 'resolvido', tipo: 'Multa', prioridade: 'Baixa', departamentos: ['Pessoal'], assunto: 'Multa X', cliente_nome: 'BETA', criado_em: '2026-10-10T12:00:00Z', criado_por: 'Larissa', prazo: '2026-10-12', origem: 'filha', pai: { assunto: 'Original Y' }, responsaveis: [], analista_id: null, filhas: [], anexos: [], notas: [] },
    ];
    const antes = [C.t.estado.g, C.t.estado.s, C.t.estado.a];
    try {
      C.t.estado.g = { dados: { registros: regs }, f: { depto: '', analista: '', etapa: '', busca: '' } };
      const g = C.t.dadosExport('gestor');
      assert.strictEqual(g.arquivo, 'cs-portal-gestor');
      assert.strictEqual(g.linhas.length, 2);
      assert.ok(g.colunas.includes('Analista indicado') && g.colunas.includes('Situação do prazo') && g.colunas.includes('Registrada em'));
      assert.strictEqual(g.colunas.length, g.linhas[0].length, 'cada linha tem uma célula por coluna');
      assert.strictEqual(g.alinhar.length, g.colunas.length);
      const l1 = JSON.parse(JSON.stringify(g.linhas[0]));
      assert.strictEqual(l1[0], '17/10/2026 às 17:54');
      assert.deepStrictEqual([l1[2], l1[8], l1[7], l1[9]], ['ALFA LTDA', 'Ana Souza', 'Bruno, João', 'Em andamento'], 'empresa, indicado, responsáveis e etapa');
      assert.strictEqual(l1[11], 'No prazo');
      const l2 = JSON.parse(JSON.stringify(g.linhas[1]));
      assert.strictEqual(l2[9], 'Encerrada');
      assert.strictEqual(l2[11], '—', 'encerrada não tem prazo correndo');
      assert.strictEqual(l2[12], 'Original Y', 'a vinculada diz a qual ocorrência pertence');
      // filtro vale para a exportação
      C.t.estado.g.f.etapa = 'encerrada';
      const gf = C.t.dadosExport('gestor');
      assert.strictEqual(gf.linhas.length, 1);
      assert.ok(gf.filtros[0].includes('1 ocorrência(s)') && gf.filtros[0].includes('Etapa: Encerrada'));
      // Sucesso do Cliente e Analista
      C.t.estado.s = { dados: { registros: regs }, f: { depto: 'Fiscal', analista: '', etapa: '', busca: '' } };
      const s = C.t.dadosExport('sucesso');
      assert.strictEqual(s.arquivo, 'cs-portal-sucesso-do-cliente');
      assert.strictEqual(s.linhas.length, 1);
      assert.ok(s.filtros[0].includes('Departamento: Fiscal'));
      C.t.estado.a = { dados: { registros: regs }, f: { analista: '', etapa: '', busca: '' } };
      const a = C.t.dadosExport('analista');
      assert.ok(!a.colunas.includes('Analista indicado'), 'o analista não recebe o indicado no registro (sigilo)');
      assert.strictEqual(a.colunas.length, a.linhas[0].length);
      C.t.estado.a = null;
      assert.strictEqual(C.t.dadosExport('analista'), null, 'sem carregar o portal, nada para exportar');
    } finally { C.t.estado.g = antes[0]; C.t.estado.s = antes[1]; C.t.estado.a = antes[2]; }
    assert.ok(C.t.situacaoPrazoExp({ prazo: '2000-01-01', etapa: 'com_analista' }).startsWith('vencida há'));
  });
  await teste('cs: começar do zero — na aba Backup, mostra o que será apagado e só libera o botão com a confirmação; avisa o que não é apagado', () => {
    const l = C.t.htmlLimpeza();
    assert.ok(l.includes('Começar do zero') && l.includes('id="lt-ver"') && l.includes('Não mexe') && l.includes('analistas, gestores, tipos de registro, acessos'));
    assert.ok(C.t.htmlBackup({ totais: {} }, []).includes('id="lt-ver"'), 'o cartão está na aba Backup');
    const p = C.t.htmlPreviaLimpeza({ ocorrencias: 12, historico: 80, responsaveis: 20, anexos: 2, avisos_de_prazo: 5, sino: 9, logs: 300 });
    assert.ok(p.includes('>12<') && p.includes('>300<') && p.includes('Ocorrências (com as vinculadas)') && p.includes('Registros dos Logs de atividades'));
    assert.ok(p.includes('id="lt-conf"') && p.includes('id="lt-apagar" disabled'), 'botão começa desligado');
    assert.ok(p.includes('Não dá para desfazer pela tela') && p.includes('perdem o conteúdo'), 'avisa que não desfaz e o que se perde nos anexos');
    assert.ok(C.t.htmlPreviaLimpeza(null).includes('>0<'), 'sem números não quebra');
  });
  await teste('cs: perfil no /cs — administrador vê tudo; gestor só Qualidade e Portal do Gestor; analista só Qualidade e Portal do Analista; equipe de sempre não ganha os portais', () => {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(C.t.perfilDe({ role: 'administrador' }))), { completo: true, admin: true, gestor: true, analista: true });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(C.t.perfilDe({ role: 'colaborador', acesso_gestor: true }))), { completo: false, admin: false, gestor: true, analista: false });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(C.t.perfilDe({ role: 'colaborador', acesso_qualidade: true }))), { completo: false, admin: false, gestor: false, analista: true });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(C.t.perfilDe({ role: 'colaborador', acesso_gestor: true, acesso_qualidade: true }))), { completo: false, admin: false, gestor: true, analista: true });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(C.t.perfilDe({ role: 'usuario' }))), { completo: true, admin: false, gestor: false, analista: false });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(C.t.perfilDe({ role: 'colaborador', acesso_cs: true }))), { completo: true, admin: false, gestor: false, analista: false });
    assert.strictEqual(C.t.perfilDe(null).completo, false);
  });
  await teste('cs: filtros dos portais por período, tipo, prioridade e quem registrou (mesma função nos três portais)', () => {
  const rg = (id, extra) => Object.assign({ id, etapa: 'com_analista', tipo: 'Erro', prioridade: 'Alta', criado_por: 'Ana', cliente_nome: 'X', assunto: 'A' + id, departamentos: ['Fiscal'], criado_em: '2026-10-10T15:00:00Z' }, extra || {});
  const regs = [rg('a'), rg('b', { criado_em: '2026-10-01T15:00:00Z', tipo: 'Multa', prioridade: 'Baixa', criado_por: 'Beto' }), rg('c', { criado_em: '2026-07-01T15:00:00Z' })];
  const F = (x) => Object.assign({ depto: '', analista: '', etapa: '', busca: '' }, x);
  const ids = (l) => l.map((x) => x.id).join('');
  const agora = Date.parse('2026-10-17T12:00:00Z');
  const per = (p) => ids(regs.filter((r) => C.t.noPeriodoQ(r, { periodo: p }, agora)));
  assert.strictEqual(per(''), 'abc'); assert.strictEqual(per('7'), 'a'); assert.strictEqual(per('15'), 'a'); assert.strictEqual(per('30'), 'ab'); assert.strictEqual(per('90'), 'ab');
  assert.strictEqual(ids(C.t.filtrarPortal(regs, F({ periodo: 'livre', de: '2026-10-09', ate: '2026-10-10' }))), 'a', 'datas livres (de/até)');
  assert.strictEqual(ids(C.t.filtrarPortal(regs, F({ periodo: 'livre', de: '2026-10-02' }))), 'a', 'só a data inicial');
  assert.strictEqual(ids(C.t.filtrarPortal(regs, F({ periodo: 'livre', ate: '2026-10-01' }))), 'bc', 'só a data final (o dia 01 conta)');
  assert.strictEqual(ids(C.t.filtrarPortal(regs, F({ periodo: 'livre' }))), 'abc', 'datas livres sem datas não filtra');
  assert.strictEqual(ids(C.t.filtrarPortal(regs, F({ tipo: 'Multa' }))), 'b'); assert.strictEqual(ids(C.t.filtrarPortal(regs, F({ prioridade: 'Baixa' }))), 'b');
  assert.strictEqual(ids(C.t.filtrarPortal(regs, F({ por: 'Beto' }))), 'b'); assert.strictEqual(ids(C.t.filtrarPortal(regs, F({ por: 'Ana', tipo: 'Erro' }))), 'ac', 'filtros se combinam');
  assert.strictEqual(ids(C.t.filtrarGestor(regs, F({ tipo: 'Multa' }))), 'b', 'o Gestor usa a mesma função');
  const barra = C.t.htmlFiltrosPortalQ('s', F({ periodo: 'livre', de: '2026-10-01', tipo: 'Erro' }), regs, { optD: '', optA: '', optE: '', comPor: true });
  assert.ok(barra.includes('id="s-busca"') && barra.includes('id="s-etapa"') && barra.includes('id="s-periodo"') && barra.includes('Últimos 15 dias') && barra.includes('id="s-de"') && barra.includes('id="s-ate"') && barra.includes('id="s-tipo"') && barra.includes('id="s-prio"') && barra.includes('id="s-por"') && barra.includes('id="s-limpar"') && barra.includes('id="s-depto"') && barra.includes('id="s-analista"'));
  // poucos filtros à vista: o que é secundário fica em "Mais filtros" (fechado), com a etiqueta do filtro ativo
  assert.ok(barra.includes('id="s-mais"') && barra.includes('Mais filtros (1)') && barra.includes('id="s-mais-box"') && /id="s-mais-box"[^>]*display:none/.test(barra), 'Mais filtros começa fechado e conta os filtros ativos');
  assert.ok(barra.includes('data-limpar-filtro="tipo"') && barra.includes('Tipo: Erro'), 'filtro ativo vira etiqueta que dá para tirar');
  const aberta = C.t.htmlFiltrosPortalQ('s', F({ maisAberto: true, tipo: 'Erro' }), regs, { optD: '', optA: '', optE: '', comPor: true });
  assert.ok(aberta.includes('▴ Menos filtros') && !/id="s-mais-box"[^>]*display:none/.test(aberta) && !aberta.includes('data-limpar-filtro'), 'aberta: mostra os campos e sem etiquetas');
  assert.ok(barra.includes('<option value="Multa">Multa</option>') && barra.includes('<option value="Erro" selected>Erro</option>') && barra.includes('<option value="Beto">Beto</option>'), 'tipos e quem registrou vêm das próprias ocorrências');
  const semPor = C.t.htmlFiltrosPortalQ('a', F({ tipo: 'Erro' }), regs, { optA: null, optE: '', comPor: false, enxuto: true });
  assert.ok(semPor.includes('id="a-busca"') && semPor.includes('id="a-etapa"') && semPor.includes('id="a-periodo"') && !semPor.includes('id="a-tipo"') && !semPor.includes('id="a-prio"') && !semPor.includes('id="a-mais"'), 'Portal do Analista: só busca, etapa e tempo');
  assert.ok(!semPor.includes('id="a-por"') && !semPor.includes('id="a-de"') && !semPor.includes('id="a-limpar"') && !semPor.includes('id="a-depto"') && !semPor.includes('id="a-analista"'), 'o Analista não filtra por quem registrou, nem por departamento; sem filtro ativo não há Limpar');
  assert.ok(C.t.htmlAnalista({ analista: { id: '7', nome: 'J' }, todos: false, registros: regs }, F({})).includes('id="a-periodo"'), 'Portal do Analista tem o período');
  assert.ok(C.t.htmlSucesso({ registros: regs, analistas: [], final: true }, F({})).includes('id="s-periodo"'), 'Portal do Sucesso do Cliente tem o período');
  assert.ok(C.t.htmlGestor({ registros: regs, escopo: { todos: true }, analistas: [] }, F({})).includes('id="g-por"'), 'Portal do Gestor tem os filtros');
  // Portal do Analista: etapas Novas / A vencer / Vencidas
  const ra = (id, e) => Object.assign({ id, etapa: 'com_analista', tipo: 'Erro', criado_por: 'Ana', cliente_nome: 'X', assunto: 'A' + id, departamentos: ['Fiscal'], criado_em: '2026-10-01T10:00:00Z' }, e);
  const regsA = [ra('x', { liberada_em: '2026-10-17T10:00:00Z', prazo: '2026-10-25' }), ra('y', { liberada_em: '2026-10-05T10:00:00Z', prazo: '2026-10-19' }), ra('z', { liberada_em: '2026-10-01T10:00:00Z', prazo: '2026-10-10', situacao: 'vencido' }), ra('w', { etapa: 'validacao_gestor', liberada_em: '2026-10-17T10:00:00Z', prazo: '2026-10-18' })];
  const T = { agora: Date.parse('2026-10-18T12:00:00Z'), hoje: '2026-10-18' };
  assert.strictEqual(ids(C.t.filtrarPortal(regsA, F(Object.assign({ etapa: 'novas' }, T)))), 'x', 'novas: abertas para ele nos últimos 3 dias (só em tratamento)');
  assert.strictEqual(ids(C.t.filtrarPortal(regsA, F(Object.assign({ etapa: 'a_vencer' }, T)))), 'y', 'a vencer: prazo em até 3 dias (a de prazo longe e a já vencida ficam fora)');
  assert.strictEqual(ids(C.t.filtrarPortal(regsA, F(Object.assign({ etapa: 'vencidas' }, T)))), 'z');
  assert.strictEqual(C.t.diasAtePrazoQ('2026-10-18', '2026-10-18'), 0); assert.strictEqual(C.t.diasAtePrazoQ('2026-10-15', '2026-10-18'), -3); assert.strictEqual(C.t.diasAtePrazoQ(null, '2026-10-18'), null);
  const telaA = C.t.htmlAnalista({ analista: { id: '7', nome: 'J' }, todos: false, registros: regsA }, F({}));
  const iE = telaA.indexOf('id="a-etapa"'), selE = telaA.slice(iE, telaA.indexOf('</select>', iE));
  assert.ok(selE.includes('>Novas (abertas nos últimos 3 dias)<') && selE.includes('>A vencer (prazo em até 3 dias)<') && selE.includes('>Vencidas<') && !selE.includes('Em validação') && !selE.includes('Devolutiva'), 'Portal do Analista: etapas só Novas, A vencer e Vencidas');
  assert.ok(C.t.htmlSucesso({ registros: regs, analistas: [], final: true }, F({})).includes('Devolutiva ao cliente') && C.t.htmlGestor({ registros: regs, escopo: { todos: true }, analistas: [] }, F({})).includes('Em validação'), 'Sucesso e Gestor mantêm as etapas de sempre');
  assert.strictEqual(C.t.filtrosAtivosQ(F({})), false); assert.strictEqual(C.t.filtrosAtivosQ(F({ periodo: '7' })), true);
});
  await teste('cs: trocar de usuário na mesma aba não deixa dados da pessoa anterior (Portal do Analista, perfil, listas)', () => {
    const e = C.t.estado, salvo = {};
    ['a', 'g', 's', 'eu', 'qAnalistas', 'qResumo', 'ac', 'ficha', 'dados', 'churnLivre'].forEach((k) => { salvo[k] = e[k]; });   // o estado é compartilhado com os outros testes: devolve no fim
    e.a = { dados: { analista: { id: 'joao' }, registros: [{ id: 'r1' }] }, f: {} }; e.g = { dados: {} }; e.s = { dados: {} }; e.eu = { sucesso: true }; e.qAnalistas = [{ id: 'joao' }]; e.qResumo = {}; e.ac = { info: {} }; e.dados = { usuario: 'joao' }; e.ficha = {};
    C.t.limparEstadoDaSessao();
    ['a', 'g', 's', 'eu', 'qAnalistas', 'qResumo', 'ac', 'ficha'].forEach((k) => assert.strictEqual(e[k], undefined, 'zerou ' + k));
    assert.strictEqual(e.dados, null, 'zerou a carteira');
    Object.keys(salvo).forEach((k) => { if (salvo[k] === undefined) delete e[k]; else e[k] = salvo[k]; });
  });
  await teste('cs: vinculadas ficam sob a matriz, recolhidas e abertas por uma setinha (Gestor e Sucesso do Cliente)', () => {
    const e = C.t.estado, salvo = e.fhAbertos; delete e.fhAbertos;
    const reg = (id, x) => Object.assign({ id, origem: 'modulo', etapa: 'com_analista', situacao: 'em_tratamento', tipo: 'Atraso', prioridade: 'Média', departamentos: ['Pessoal'], assunto: 'A' + id, detalhe: 'D', cliente_nome: 'X', criado_em: '2026-10-18T10:00:00Z', prazo: '2026-10-21', analista_nome: null, responsaveis: [], filhas: [], anexos: [], notas: [] }, x || {});
    const regs = [reg('f1', { origem: 'filha', pai_id: 'm' }), reg('m', { filhas: [{ id: 'f1' }, { id: 'f2' }] }), reg('f2', { origem: 'filha', pai_id: 'm' }), reg('sozinha', { origem: 'filha', pai_id: 'fora' })];
    const g = C.t.htmlGestor({ registros: regs, escopo: { todos: true }, analistas: [] }, { depto: '', analista: '', etapa: '', busca: '' });
    assert.ok(g.includes('data-fh="m"') && g.includes('▸ 2 vinculadas'), 'a matriz mostra a setinha com a quantidade');
    assert.strictEqual((g.match(/class="fh-filha" data-pai="m" hidden/g) || []).length, 2, 'as duas vinculadas ficam recolhidas sob a matriz');
    assert.ok(g.indexOf('data-fh="m"') < g.indexOf('class="fh-filha"'), 'a matriz vem antes das vinculadas');
    assert.ok(!g.includes('data-pai="fora"') && g.includes('Asozinha'), 'a vinculada sem a matriz na lista aparece sozinha');
    e.fhAbertos = { m: true };
    const aberto = C.t.htmlGestor({ registros: regs, escopo: { todos: true }, analistas: [] }, { depto: '', analista: '', etapa: '', busca: '' });
    assert.ok(aberto.includes('▾ 2 vinculadas') && !/data-pai="m" hidden/.test(aberto), 'aberta pela setinha: mostra as vinculadas');
    e.fhAbertos = {};
    const s = C.t.htmlSucesso({ registros: regs, analistas: [], final: true }, { depto: '', analista: '', etapa: '', busca: '' });
    assert.ok(s.includes('data-fh="m"') && /class="fh-filha" data-pai="m" hidden/.test(s), 'o Portal do Sucesso do Cliente também agrupa');
    if (salvo === undefined) delete e.fhAbertos; else e.fhAbertos = salvo;
  });
  await teste('cs: matriz conduzida pelas vinculadas — Gestor(a) no responsável e aviso de resposta final aberta', () => {
    const m = { id: 'm', origem: 'modulo', etapa: 'com_analista', assunto: 'Atraso', cliente_nome: 'X', departamentos: ['Pessoal'], tipo: 'Atraso', prioridade: 'Média', criado_em: '2026-10-18T10:00:00Z', prazo: '2026-10-21', plano_acao: 'Conduzida pelas ocorrências vinculadas', responsaveis: [], filhas: [{ id: 'f1', assunto: 'A', etapa: 'encerrada', departamentos: ['Pessoal'], prazo: '2026-10-20', analista_nome: 'P' }, { id: 'f2', assunto: 'B', etapa: 'com_analista', departamentos: ['Pessoal'], prazo: '2026-10-20', analista_nome: 'J' }] };
    assert.strictEqual(C.t.responsavelAtualQ(m), 'Gestor(a) Pessoal', 'a matriz em andamento sem analista está com o(a) gestor(a)');
    assert.strictEqual(C.t.responsavelAtualQ(Object.assign({}, m, { etapa: 'validacao_gestor' })), 'Gestor(a) Pessoal');
    assert.ok(C.t.responsavelAtualQ(Object.assign({}, m, { origem: 'filha' })).includes('—'), 'a vinculada sem analista não vira Gestor(a)');
    const j = C.t.htmlTratativaGestor(m, []);
    assert.ok(j.includes('comunicação direta') && j.includes('1 de 2 encerradas') && j.includes('Gestor CS') && j.includes('leva ao Gestor CS sem finalizar') && j.includes('id="gt-filha"'), 'a matriz é a comunicação com o Gestor final e ainda recebe vinculadas');
    assert.ok(!C.t.htmlTratativaGestor(Object.assign({}, m, { responsaveis: [{ analista_id: '1', nome: 'Ana' }] }), []).includes('comunicação direta'), 'com analista na matriz, o aviso não aparece');
  });
  await teste('cs: gestor interage enquanto aguarda e responde a matriz (apanhado) que vai ao gestor final', () => {
    const m = { id: 'm', origem: 'modulo', etapa: 'com_analista', assunto: 'Atraso', cliente_nome: 'X', departamentos: ['Pessoal'], tipo: 'Atraso', prioridade: 'Média', criado_em: '2026-10-18T10:00:00Z', prazo: '2026-10-21', plano_acao: 'Conduzida pelas ocorrências vinculadas', responsaveis: [], filhas: [{ id: 'f', assunto: 'A', etapa: 'encerrada', departamentos: ['Pessoal'], prazo: '2026-10-20', analista_nome: 'P', respostas: [{ nome: 'P', nota: 'Resolvido com o cliente' }] }] };
    assert.ok(!C.t.htmlTratativaGestor(m, []).includes('id="gt-vf-enviar"'), 'a matriz só das vinculadas não tem analista: a conversa com os analistas é nas vinculadas');
    assert.ok(C.t.htmlTratativaGestor(Object.assign({}, m, { origem: 'filha', pai_id: 'm', filhas: [], responsaveis: [{ analista_id: '1', nome: 'Ana' }] }), []).includes('id="gt-vf-enviar"'), 'o gestor deixa observação ao analista na vinculada');
    const vinc = C.t.htmlTratativaGestor(Object.assign({}, m, { origem: 'filha', pai_id: 'm', filhas: [], responsaveis: [{ analista_id: '1', nome: 'Ana' }] }), []);
    assert.ok(vinc.includes('Observação e finalizar') && vinc.includes('name="gt-vf-modo" value="obs" checked') && vinc.includes('name="gt-vf-modo" value="fin"') && vinc.includes('encerra este vínculo') && !vinc.includes('Mensagem para quem está tratando'), 'vínculo aberto: o mesmo modelo Observação / Finalizar no lugar da mensagem');
    assert.ok(!C.t.htmlTratativaGestor(Object.assign({}, m, { origem: 'filha', pai_id: 'm', etapa: 'encerrada', filhas: [], responsaveis: [{ analista_id: '1', nome: 'Ana' }] }), []).includes('gt-vf-enviar'), 'vínculo encerrado não tem a caixa');
    assert.ok(!C.t.htmlTratativaGestor(Object.assign({}, m, { filhas: [], responsaveis: [{ analista_id: '1', nome: 'Ana' }] }), []).includes('id="gt-vf-enviar"'), 'na matriz não há mensagem ao analista');
    assert.ok(!C.t.htmlTratativaGestor(Object.assign({}, m, { etapa: 'encerrada' }), []).includes('gt-vf-enviar'), 'depois de encerrada não há mensagem');
    const v = C.t.htmlTratativaGestor(Object.assign({}, m, { etapa: 'validacao_gestor', filhas: [{ id: 'f1', assunto: 'A', etapa: 'encerrada', departamentos: ['Pessoal'], prazo: '2026-10-20', analista_nome: 'P', respostas: [{ nome: 'P', nota: 'Resolvido com o cliente' }] }] }), []);
    assert.ok(v.includes('Resposta final ao Sucesso do Cliente') && v.includes('value="obs" checked') && v.includes('value="fin"') && !/value="fin" disabled/.test(v) && v.includes('Resolvido com o cliente') && !v.includes('id="gv-validar"'), 'matriz só das vinculadas, já respondida: resposta final com Observação ou Finalizar, com o apanhado embaixo');
    const comAnalista = C.t.htmlTratativaGestor(Object.assign({}, m, { etapa: 'validacao_gestor', responsaveis: [{ analista_id: '1', nome: 'Ana' }] }), []);
    assert.ok(comAnalista.includes('Nota da validação') && comAnalista.includes('Validar: enviar ao Sucesso do Cliente') && !comAnalista.includes('display:none'), 'com analista na matriz, segue a validação de sempre');
  });
  await teste('cs: janela do analista não repete o plano; andamento das vinculadas aparece na matriz e no Sucesso do Cliente', () => {
    const plano = 'Plano de ação para @Polyanna';
    const f = { id: 'f', origem: 'filha', etapa: 'com_analista', tipo: 'Atraso', prioridade: 'Média', departamentos: ['Pessoal'], assunto: 'Cobrança', detalhe: plano, plano_acao: plano, cliente_nome: 'X', criado_em: '2026-10-18T11:15:00Z', prazo: '2026-10-20', responsaveis: [{ analista_id: '9', nome: 'Polyanna' }], filhas: [] };
    const j = C.t.htmlOcorrenciaAnalista(f, '', '9', false);
    assert.strictEqual((j.match(/Plano de ação para @Polyanna/g) || []).length, 1, 'o plano aparece uma vez só (no Plano de ação do gestor)');
    assert.ok(j.includes('Plano de ação do gestor'));
    const original = { id: 'o', origem: 'modulo', etapa: 'com_analista', tipo: 'Atraso', prioridade: 'Média', departamentos: ['Pessoal'], assunto: 'A', detalhe: 'Cliente relata atraso', plano_acao: 'Outro texto', cliente_nome: 'X', criado_em: '2026-10-18T10:00:00Z', prazo: '2026-10-21', responsaveis: [], filhas: [] };
    assert.ok(C.t.cartaoOcorrenciaQ(original, true).includes('Cliente relata atraso'), 'o detalhe diferente do plano continua aparecendo');
    const m = Object.assign({}, original, { filhas: [{ id: 'f', assunto: 'Cobrança', etapa: 'com_analista', departamentos: ['Pessoal'], prazo: '2026-10-20', analista_nome: 'Polyanna', respostas: [], anotacoes: [{ em: '2026-10-18T12:00:00Z', por: 'Polyanna', texto: 'Liguei para o cliente' }] }] });
    assert.ok(C.t.htmlVinculos(m).includes('Polyanna: Liguei para o cliente'), 'o andamento da vinculada aparece na matriz');
    assert.ok(C.t.htmlOcorrenciaSucesso(m, true).includes('Liguei para o cliente'), 'e o gestor final do Sucesso do Cliente vê no Portal dele');
  });
  await teste('cs: matriz com duas conversas — observação com o analista (no vínculo aberto) e observação com o Sucesso do Cliente, mais Finalizar', () => {
    const f = (id, etapa, nome) => ({ id, assunto: 'Vínculo ' + id, etapa, departamentos: ['Pessoal'], prazo: '2026-10-20', analista_nome: nome, anotacoes: [{ em: '2026-10-18T12:00:00Z', por: nome, texto: 'Liguei e aguardo o retorno' }] });
    const base = { id: 'm', origem: 'modulo', etapa: 'com_analista', assunto: 'A', cliente_nome: 'X', departamentos: ['Pessoal'], tipo: 'Atraso', prioridade: 'Média', criado_em: '2026-10-18T10:00:00Z', prazo: '2026-10-21', plano_acao: 'Conduzida pelas ocorrências vinculadas', responsaveis: [], dialogo: [], filhas: [f('f1', 'com_analista', 'Polyanna'), f('f2', 'encerrada', 'João')] };
    const g = C.t.htmlTratativaGestor(base, []);
    assert.ok(g.includes('Observação com o analista') && g.includes('id="gt-oa-para"') && g.includes('id="gt-oa-enviar"') && g.includes('Polyanna — Vínculo f1') && !g.includes('João — Vínculo f2'), 'só os vínculos abertos recebem observação do gestor');
    assert.ok(g.includes('Polyanna: Liguei e aguardo o retorno'), 'as observações do analista aparecem no andamento do vínculo, dentro da matriz');
    assert.ok(g.includes('Resposta final ao Sucesso do Cliente') && g.includes('com o Sucesso do Cliente, sem finalizar') && g.includes('name="gt-rf-modo" value="fin"'), 'a conversa com o Sucesso do Cliente e o Finalizar continuam na mesma matriz');
    const semVinc = C.t.htmlTratativaGestor(Object.assign({}, base, { etapa: 'registrada', filhas: [] }), []);
    assert.ok(semVinc.includes('Observação com o analista') && semVinc.includes('Abra uma ocorrência vinculada para conversar com o analista') && !semVinc.includes('id="gt-oa-enviar"'), 'sem vínculo: explica como falar com o analista');
    const fechados = C.t.htmlTratativaGestor(Object.assign({}, base, { filhas: [f('f2', 'encerrada', 'João')] }), []);
    assert.ok(fechados.includes('Todas as vinculadas estão encerradas') && !fechados.includes('id="gt-oa-enviar"'), 'vínculos fechados podem ficar fechados: sem caixa');
    assert.ok(!C.t.htmlTratativaGestor(Object.assign({}, base, { etapa: 'encerrada' }), []).includes('Observação com o analista'), 'depois de encerrada não aparece');
    const an = C.t.htmlOcorrenciaAnalista({ id: 'f', origem: 'filha', etapa: 'com_analista', situacao: 'em_tratamento', tipo: 'Erro', prioridade: 'Alta', departamentos: ['Pessoal'], assunto: 'V', detalhe: 'D', cliente_nome: null, criado_em: '2026-10-17T12:00:00Z', prazo: '2026-10-25', plano_acao: 'P', responsaveis: [{ analista_id: '1', nome: 'Ana', encerrado_em: null }], filhas: [], anexos: [], notas: [] }, '', '1', false);
    assert.ok(an.includes('Observação e finalizar') && an.includes('name="ao-modo" value="obs" checked') && an.includes('Enviar observação ao gestor(a)') && an.includes('id="ao-enviar"') && !an.includes('Anotação no meio do caminho') && !an.includes('Sua tratativa</div>'), 'o analista deixa observação para o gestor antes de finalizar (mesmo modelo do Portal do Gestor)');
  });
  await teste('cs: observação nova deixa sinal no painel — selo do menu e etiqueta na lista (Sucesso do Cliente e Gestor)', () => {
    const m = (id, extra) => Object.assign({ id, origem: 'modulo', etapa: 'registrada', situacao: 'aberto', assunto: 'A' + id, detalhe: 'D', cliente_nome: 'X', departamentos: ['Pessoal'], tipo: 'Atraso', prioridade: 'Média', criado_em: '2026-10-18T12:00:00Z', prazo: '2026-10-21', responsaveis: [], filhas: [], anexos: [], notas: [], dialogo: [] }, extra || {});
    const dg = { em: '2026-10-18T12:00:00Z', por: 'Denisa', lado: 'gestor', texto: 'Teste' }, df = { em: '2026-10-18T13:00:00Z', por: 'Reysner', lado: 'final', texto: 'Ok' };
    assert.strictEqual(C.t.aguardaRespostaQ(m('a', { dialogo: [dg] }), 'gestor'), true, 'a última fala foi do gestor(a): o Sucesso do Cliente precisa responder');
    assert.strictEqual(C.t.aguardaRespostaQ(m('b', { dialogo: [dg, df] }), 'gestor'), false, 'o Sucesso já respondeu');
    assert.strictEqual(C.t.aguardaRespostaQ(m('b', { dialogo: [dg, df] }), 'final'), true, 'agora o gestor(a) é quem precisa ler/responder');
    assert.strictEqual(C.t.aguardaRespostaQ(m('c', { etapa: 'encerrada', dialogo: [dg] }), 'gestor'), false, 'encerrada não aguarda');
    assert.strictEqual(C.t.aguardaRespostaQ(m('d', { origem: 'filha', dialogo: [dg] }), 'gestor'), false, 'só a matriz');
    const regs = [m('a', { dialogo: [dg] }), m('b', { etapa: 'devolutiva_cliente' }), m('c', { etapa: 'devolutiva_cliente', dialogo: [dg] }), m('d', { dialogo: [dg, df] }), m('e')];
    assert.strictEqual(C.t.badgeSucessoQ(regs), 3, 'selo do Sucesso: devolutivas (b, c) + observação sem resposta (a), sem contar duas vezes');
    assert.strictEqual(C.t.badgeGestorQ(regs), 3, 'selo do Gestor: aguardando análise (a, d, e) — com resposta do Sucesso em d');
    const so = C.t.htmlSucesso({ registros: [m('a', { dialogo: [dg] })], analistas: [], final: true }, { depto: '', analista: '', etapa: '', busca: '' });
    assert.ok(so.includes('Observação nova do gestor(a)'), 'etiqueta na linha do Portal do Sucesso do Cliente');
    const ge = C.t.htmlGestor({ registros: [m('d', { dialogo: [dg, df] })], escopo: { todos: true }, analistas: [] }, { depto: '', analista: '', etapa: '', busca: '' });
    assert.ok(ge.includes('Resposta do Gestor(a) CS') && !so.includes('Resposta do Gestor(a) CS'), 'etiqueta na linha do Portal do Gestor quando o Sucesso respondeu');
  });
  await teste('cs: ficha da empresa — a lista de planos não mostra a ocorrência do módulo nem os vínculos', () => {
    const r = (id, x) => Object.assign({ id, origem: 'modulo', etapa: 'encerrada', status: 'resolvido', situacao: 'resolvido', tipo: 'Atraso', departamentos: ['Pessoal'], assunto: 'A' + id, detalhe: 'D', criado_em: '2026-10-18T12:00:00Z', anexos: [], notas: [] }, x || {});
    const regs = [r('m', { final_nota: 'Ciente das tratativas realizadas' }), r('f', { origem: 'filha', plano_acao: 'Plano do vínculo', tratativa: 'Parecer do João' }), { id: 'p', origem: 'ficha', status: 'aberto', tipo: 'Plano de ação', detalhe: 'Plano da ficha', criado_em: '2026-10-17T12:00:00Z', anexos: [], notas: [] }];
    const h = C.t.listaRegistrosQ(regs);
    assert.ok(!h.includes('Parecer do João') && !h.includes('Plano do vínculo') && !h.includes('Ciente das tratativas realizadas'), 'nem o vínculo nem a ocorrência do módulo aparecem aqui (ficam na seção Qualidade)');
    assert.ok(h.includes('Plano da ficha'), 'o plano de ação lançado na ficha continua');
    assert.ok(C.t.listaOcorrenciasQ(regs).includes('Ciente das tratativas realizadas') || C.t.listaOcorrenciasQ(regs).includes('Atraso'), 'a seção Qualidade continua mostrando a ocorrência');
  });
  await teste('cs: reabrir vínculo encerrado na matriz e nota de encerramento sem repetir', () => {
    const mat = { id: 'm', origem: 'modulo', etapa: 'validacao_gestor', assunto: 'A', cliente_nome: 'X', departamentos: ['Pessoal'], tipo: 'Atraso', prioridade: 'Média', criado_em: '2026-10-18T10:00:00Z', prazo: '2026-10-21', responsaveis: [], dialogo: [], filhas: [{ id: 'f1', assunto: 'V1', etapa: 'encerrada', departamentos: ['Pessoal'], prazo: '2026-10-20', analista_nome: 'João', respostas: [{ nome: 'João', nota: 'Resolvido' }] }, { id: 'f2', assunto: 'V2', etapa: 'com_analista', departamentos: ['Pessoal'], prazo: '2026-10-20', analista_nome: 'Ana', respostas: [] }] };
    const v = C.t.htmlVinculos(mat, true);
    assert.ok(v.includes('data-reabrir-filha="f1"') && !v.includes('data-reabrir-filha="f2"'), 'só o vínculo encerrado tem Reabrir');
    assert.ok(!C.t.htmlVinculos(mat).includes('data-reabrir-filha'), 'só na janela do gestor');
    assert.ok(!C.t.htmlVinculos(Object.assign({}, mat, { etapa: 'devolutiva_cliente' }), true).includes('data-reabrir-filha'), 'com o Sucesso do Cliente não reabre');
    assert.ok(C.t.htmlAcoesOcorrencia({ id: 'f', origem: 'filha', etapa: 'encerrada' }).includes('não concordar com o parecer final'), 'a janela do vínculo encerrado explica o Reabrir');
    const enc = { id: 'f', origem: 'filha', etapa: 'encerrada', tipo: 'Atraso', prioridade: 'Média', departamentos: ['Fiscal'], assunto: 'V', detalhe: 'D', cliente_nome: 'X', criado_em: '2026-10-18T13:17:00Z', prazo: '2026-10-20', tratativa: 'Parecer final do analista', analista_nota: 'Parecer final do analista', analista_por: 'João', analista_em: '2026-10-18T13:28:00Z', plano_acao: 'Plano', responsaveis: [{ analista_id: '1', nome: 'João', nota: 'Parecer final do analista', encerrado_em: '2026-10-18T13:28:00Z' }], filhas: [], anexos: [], notas: [{ em: '2026-10-18T13:28:00Z', por: 'João', acao: 'analista_encerrou', texto: 'Parecer final do analista' }, { em: '2026-10-18T13:28:00Z', por: 'Sistema', acao: 'nota', texto: 'Todos os responsáveis encerraram' }] };
    const h = C.t.htmlTratativaGestor(enc, []);
    assert.strictEqual((h.match(/Parecer final do analista/g) || []).length, 1, 'a nota de encerramento aparece uma vez só (em Devolutivas)');
    assert.ok(h.includes('Analista encerrou a tratativa') && h.includes('Todos os responsáveis encerraram') && h.includes('id="gt-reabrir-oc"'), 'o histórico guarda o fato e o gestor pode reabrir');
  });
  await teste('cs: resposta final ao Sucesso do Cliente — Observação ou Finalizar, conversa com o Gestor final no Portal dele', () => {
    const base = { id: 'm', origem: 'modulo', etapa: 'com_analista', assunto: 'A', cliente_nome: 'X', departamentos: ['Pessoal'], tipo: 'Atraso', prioridade: 'Média', criado_em: '2026-10-18T10:00:00Z', prazo: '2026-10-21', plano_acao: 'Conduzida pelas ocorrências vinculadas', responsaveis: [], dialogo: [], filhas: [{ id: 'f', assunto: 'B', etapa: 'com_analista', departamentos: ['Pessoal'], prazo: '2026-10-20', analista_nome: 'P' }] };
    const emAndamento = C.t.htmlTratativaGestor(base, []);
    assert.ok(emAndamento.includes('Resposta final ao Sucesso do Cliente') && emAndamento.includes('name="gt-rf-modo" value="obs" checked') && emAndamento.includes('Observação') && emAndamento.includes('Finalizar') && emAndamento.includes('id="gt-rf-enviar"'), 'escolha entre Observação e Finalizar');
    assert.ok(/value="fin" disabled/.test(emAndamento) && emAndamento.includes('quando as vinculadas forem encerradas'), 'com vinculada aberta, Finalizar fica desligado e explica');
    const pronta = C.t.htmlTratativaGestor(Object.assign({}, base, { filhas: [{ id: 'f', assunto: 'B', etapa: 'encerrada', departamentos: ['Pessoal'], prazo: '2026-10-20', analista_nome: 'P' }] }), []);
    assert.ok(!/value="fin" disabled/.test(pronta) && pronta.includes('nota final: segue para o Sucesso do Cliente'), 'sem vinculada aberta nem analista tratando, Finalizar liberado');
    const antes = C.t.htmlTratativaGestor(Object.assign({}, base, { etapa: 'registrada', filhas: [] }), []);
    assert.ok(antes.includes('Resposta final ao Sucesso do Cliente') && !antes.includes('id="gt-plano"') && !/value="fin" disabled/.test(antes), 'antes de tudo: o gestor(a) pode finalizar sozinho, sem formulário de tratativa');
    const conv = C.t.htmlTratativaGestor(Object.assign({}, base, { dialogo: [{ em: '2026-10-18T12:00:00Z', por: 'Denisa', lado: 'gestor', texto: 'Precisa de apoio' }, { em: '2026-10-18T13:00:00Z', por: 'Reysner', lado: 'final', texto: 'Pode seguir' }] }), []);
    assert.ok(conv.includes('Gestor(a) (Denisa)') && conv.includes('Precisa de apoio') && conv.includes('Gestor(a) CS (Reysner)') && conv.includes('Pode seguir'), 'a conversa aparece na matriz');
    assert.ok(!C.t.htmlTratativaGestor(Object.assign({}, base, { origem: 'filha', pai_id: 'm' }), []).includes('gt-rf-enviar') && !C.t.htmlTratativaGestor(Object.assign({}, base, { etapa: 'encerrada' }), []).includes('gt-rf-enviar'), 'só na matriz e só enquanto aberta');
    const so = C.t.htmlOcorrenciaSucesso(Object.assign({}, base, { dialogo: [{ em: '2026-10-18T12:00:00Z', por: 'Denisa', lado: 'gestor', texto: 'Precisa de apoio' }] }), true);
    assert.ok(so.includes('Conversa entre o Gestor(a) do departamento e o Sucesso do Cliente') && so.includes('Precisa de apoio') && so.includes('id="so-resp-enviar"') && so.includes('a resposta volta para a ocorrência no Portal do Gestor'), 'o Gestor final vê e responde');
    assert.ok(!C.t.htmlOcorrenciaSucesso(Object.assign({}, base, { dialogo: [] }), false).includes('Conversa entre o Gestor(a)'), 'sem conversa e sem poder escrever, nada aparece');
    assert.ok(!C.t.htmlOcorrenciaSucesso(Object.assign({}, base, { dialogo: [{ em: '2026-10-18T12:00:00Z', lado: 'gestor', texto: 'x' }] }), false).includes('so-resp-enviar'), 'quem não é gestor(a) nem administrador só lê a conversa');
    assert.ok(C.t.htmlDialogoSucessoQ(base, false, true).includes('Deixar uma observação para o Sucesso do Cliente') && C.t.htmlDialogoSucessoQ(base, false, true).includes('id="so-resp-enviar"') && C.t.htmlDialogoSucessoQ(base, false, true).includes('aberta até finalizar'), 'o gestor(a) escreve na conversa também pelo Portal do Sucesso do Cliente, sempre aberta até finalizar');
    assert.ok(!C.t.htmlDialogoSucessoQ(Object.assign({}, base, { etapa: 'encerrada' }), true, true).includes('so-resp-enviar'), 'depois de encerrada não se escreve mais');
  });
  await teste('cs: matriz e vínculos — Em andamento, resposta dos vínculos na matriz e analista apontado corrigido pelo gestor final', () => {
    {   // aviso quando ninguém está apontado
      const e0 = C.t.estado, s0 = e0.qAnalistas; e0.qAnalistas = [{ id: '9', nome: 'Polyanna' }];
      const sem = { id: 'm', origem: 'modulo', etapa: 'devolutiva_cliente', assunto: 'A', cliente_nome: 'X', departamentos: ['Pessoal'], tipo: 'Atraso', prioridade: 'Média', criado_em: '2026-10-18T10:00:00Z', prazo: '2026-10-21', analista_origem_id: null, analista_apontado_id: null, apontamentos: [], responsaveis: [], filhas: [] };
      assert.ok(C.t.htmlOcorrenciaSucesso(sem, true).includes('Nenhum analista está apontado nesta ocorrência'), 'avisa o Gestor final quando ninguém está apontado');
      assert.ok(!C.t.htmlOcorrenciaSucesso(Object.assign({}, sem, { analista_origem_id: '9', analista_origem_nome: 'Polyanna' }), true).includes('Nenhum analista está apontado'), 'com analista apontado, sem o aviso');
      if (s0 === undefined) delete e0.qAnalistas; else e0.qAnalistas = s0;
    }
    const e = C.t.estado, salvo = e.qAnalistas; e.qAnalistas = [{ id: '9', nome: 'Polyanna' }, { id: '4', nome: 'João' }];
    const base = { id: 'm', origem: 'modulo', etapa: 'com_analista', assunto: 'Atraso', cliente_nome: 'X', departamentos: ['Pessoal'], tipo: 'Atraso', prioridade: 'Média', criado_em: '2026-10-18T10:00:00Z', prazo: '2026-10-21', analista_origem_id: '9', analista_origem_nome: 'Polyanna', analista_apontado_id: null, analista_apontado_nome: null, apontamentos: [], responsaveis: [], filhas: [] };
    const gf = C.t.htmlOcorrenciaSucesso(base, true);
    assert.ok(gf.includes('id="so-apontar"') && gf.includes('apontam para: <strong>Polyanna</strong>') && gf.includes('<option value="4">João</option>') && !gf.includes('<option value="9">Polyanna</option>') && gf.includes('value="__nenhum"') && !gf.includes('__volta'), 'o gestor final vê o apontado de hoje e escolhe outro');
    const corrigida = C.t.htmlOcorrenciaSucesso(Object.assign({}, base, { analista_apontado_id: '4', analista_apontado_nome: 'João', apontamentos: [{ em: '2026-10-18T12:00:00Z', por: 'Reysner', texto: 'Apontado: Polyanna → corrigido para João por Reysner' }] }), true);
    assert.ok(corrigida.includes('apontam para: <strong>João</strong>') && corrigida.includes('apontado no registro: Polyanna') && corrigida.includes('value="__volta"') && corrigida.includes('corrigido para João por Reysner'), 'mostra a correção e o histórico');
    assert.ok(!C.t.htmlOcorrenciaSucesso(base, false).includes('so-apontar') && !C.t.htmlOcorrenciaSucesso(Object.assign({}, base, { origem: 'filha' }), true).includes('so-apontar'), 'só o gestor final e só na ocorrência original');
    const v = C.t.htmlVinculos(Object.assign({}, base, { filhas: [{ id: 'f', assunto: 'Cobrança', etapa: 'validacao_gestor', departamentos: ['Pessoal'], prazo: '2026-10-20', analista_nome: 'Polyanna', respostas: [{ nome: 'Polyanna', nota: 'Cliente enviou os dados', obs: 'ok' }], validacao_nota: null }] }));
    assert.ok(v.includes('Cliente enviou os dados') && v.includes('Observação:'), 'a resposta de cada vinculada aparece na matriz');
    if (salvo === undefined) delete e.qAnalistas; else e.qAnalistas = salvo;
  });
  await teste('cs: rótulos Gestor(a) <departamento> e janela da original que continua aberta ao abrir vinculadas', () => {
    ['Pessoal', 'Contábil', 'Fiscal', 'Legalização', 'Financeiro', 'Comercial'].forEach((d) => assert.strictEqual(C.t.rotuloGestor(d), 'Gestor(a) ' + d));
    assert.strictEqual(C.t.rotuloGestor('Sucesso'), 'Gestor(a) Sucesso do Cliente');
    assert.strictEqual(C.t.responsavelAtualQ({ etapa: 'registrada', departamentos: ['Pessoal'] }), 'Gestor(a) Pessoal', 'sem analista ainda: o(a) gestor(a) do departamento');
    assert.strictEqual(C.t.responsavelAtualQ({ etapa: 'tratativa_definida', departamentos: ['Fiscal'], analista_nome: 'Ana' }), 'Ana', 'com analista: o analista');
    assert.ok(C.t.responsavelAtualQ({ etapa: 'encerrada', departamentos: ['Fiscal'] }).includes('—'), 'sem analista e já passou do gestor: traço');
    assert.strictEqual(C.t.destinoCurto({ fila: 'gestor', departamentos: ['Pessoal'] }), 'Gestor(a) Pessoal');
    assert.ok(C.t.destinoCurto({ fila: 'sucesso', departamentos: ['Pessoal'] }).startsWith('Gestor(a) Pessoal (sem gestor cadastrado'));
    assert.strictEqual(C.t.destinoCurto({ fila: 'sucesso', departamentos: ['Sucesso'] }), 'Sucesso do Cliente');
    const base = { id: 'p', etapa: 'registrada', assunto: 'A', cliente_nome: 'X', departamentos: ['Pessoal'], tipo: 'Atraso', prioridade: 'Média', criado_em: '2026-10-18T10:00:00Z', prazo: '2026-10-21', plano_acao: '', analistas: [], responsaveis: [], filhas: [] };
    const tela = C.t.htmlTratativaGestor(base, []);
    assert.ok(tela.includes('id="gt-filha"') && tela.includes('id="gt-filhas-novas"'), 'a janela da original tem onde mostrar as vinculadas recém-abertas');
  });
  await teste('cs: Portal do Gestor — filtros por departamento, analista, etapa e busca; contagem por etapa; tabela e janela da tratativa', () => {
    const r = (id, extra) => Object.assign({ id, etapa: 'registrada', situacao: 'aberto', status: 'aberto', tipo: 'Erro', prioridade: 'Alta', departamentos: ['Fiscal'], assunto: 'Guia errada ' + id, detalhe: 'Detalhe', cliente_nome: 'ALFA LTDA', criado_em: '2026-10-17T12:00:00Z', criado_por: 'Larissa', analista_id: null, analista_nome: null, prazo: '2026-10-25', anexos: [], notas: [] }, extra || {});
    const regs = [r('a'), r('b', { departamentos: ['Pessoal'], etapa: 'com_analista', analista_id: '7', analista_nome: 'Josiane', situacao: 'vencido' }), r('c', { etapa: 'tratativa_definida', analista_id: '7', analista_nome: 'Josiane', cliente_nome: 'BETA ME' }), r('d', { etapa: 'validacao_gestor', analista_id: '9', analista_nome: 'Bruno' })];
    const F = (f) => Object.assign({ depto: '', analista: '', etapa: '', busca: '' }, f);
    assert.strictEqual(C.t.filtrarGestor(regs, F({})).length, 4);
    assert.deepStrictEqual(C.t.filtrarGestor(regs, F({ depto: 'Pessoal' })).map((x) => x.id), ['b']);
    assert.deepStrictEqual(C.t.filtrarGestor(regs, F({ analista: '7' })).map((x) => x.id), ['b', 'c']);
    assert.deepStrictEqual(C.t.filtrarGestor(regs, F({ etapa: 'vencidas' })).map((x) => x.id), ['b']);
    assert.deepStrictEqual(C.t.filtrarGestor(regs, F({ etapa: 'validacao_gestor' })).map((x) => x.id), ['d']);
    assert.deepStrictEqual(C.t.filtrarGestor(regs, F({ busca: 'beta' })).map((x) => x.id), ['c']);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(C.t.contagemEtapasGestor(regs))), { vencidas: 1, registrada: 1, tratativa_definida: 1, com_analista: 1, validacao_gestor: 1, devolutiva_cliente: 0, encerrada: 0, cancelada: 0 });
    const h = C.t.htmlGestor({ escopo: { todos: false, deptos: ['Fiscal', 'Pessoal'] }, registros: regs }, F({}));
    assert.ok(h.includes('Trâmite') && h.includes('Sucesso do Cliente') && h.includes('Aguardando análise') && h.includes('Em validação'));
    assert.ok(h.includes('seus departamentos: Fiscal, Pessoal') && h.includes('<option value="7">Josiane</option>') && h.includes('<option value="9">Bruno</option>') && h.includes('value="vencidas"'));
    assert.ok(h.includes('>Analisar<') && !h.includes('Editar / abrir para o analista') && h.includes('>Ver<'));
    assert.ok(C.t.htmlGestor({ escopo: { todos: true, deptos: [] }, registros: [] }, F({})).includes('todos os departamentos'));
    const nova = C.t.htmlTratativaGestor(r('a'), [{ id: '7', nome: 'Josiane' }, { id: '9', nome: 'Bruno' }]);
    assert.ok(nova.includes('Resposta final ao Sucesso do Cliente') && nova.includes('id="gt-filha"') && !nova.includes('id="gt-salvar"') && !nova.includes('id="gt-plano"'), 'a matriz nova: resposta final + abrir vinculadas, sem formulário de tratativa');
    const lida = C.t.htmlTratativaGestor(r('b', { etapa: 'com_analista', plano_acao: 'Plano X', tratativa_depto: 'Pessoal', gestor_obs: 'Obs Y', tratativa_definida_por: 'Eduardo', liberada_em: '2026-10-18T10:00:00Z' }), []);
    assert.ok(lida.includes('Plano X') && lida.includes('Obs Y') && lida.includes('definida por Eduardo') && lida.includes('aberta ao analista em 18/10/2026') && !lida.includes('id="gt-salvar"'), 'depois de aberta só leitura');
  });
  await teste('cs: Qualidade de quem só registra — minhas ocorrências com etapa e para onde foram', () => {
    const h = C.t.htmlMinhasOcorrencias([{ id: 'x', tipo: 'Erro', prioridade: 'Alta', departamentos: ['Fiscal'], fila: 'gestor', etapa: 'registrada', assunto: 'Guia errada', cliente_nome: 'ALFA LTDA', criado_em: '2026-10-17T12:00:00Z', prazo: '2026-10-25', anexos: [] }, { id: 'y', tipo: 'Multa', prioridade: 'Baixa', departamentos: ['Pessoal'], fila: 'sucesso', etapa: 'com_analista', assunto: 'Multa X', cliente_nome: 'BETA', criado_em: '2026-10-16T12:00:00Z', prazo: null, anexos: [] }]);
    assert.ok(h.includes('Minhas ocorrências') && h.includes('Gestor(a) Fiscal') && h.includes('Sucesso do Cliente') && h.includes('Aguardando análise') && h.includes('Em andamento'));
    assert.ok(C.t.htmlMinhasOcorrencias([]).includes('Você ainda não registrou nenhuma ocorrência.'));
  });
  await teste('cs: Gerenciar gestores — um bloco por departamento, vários gestores, papel e aviso de departamento sem gestor', () => {
    const j = { departamentos: [{ codigo: 'Fiscal', rotulo: 'Fiscal', gestores: [{ id: 1, user_id: 'u1', nome: 'Eduardo', papel: 'gestor' }, { id: 2, user_id: 'u2', nome: 'Denisa', papel: 'diretor' }] }, { codigo: 'Sucesso', rotulo: 'Sucesso do Cliente', gestores: [] }], usuarios: [{ id: 'u1', name: 'Eduardo' }, { id: 'u3', name: 'Thais <T>' }] };
    const h = C.t.htmlGestoresQ(j);
    assert.ok(h.includes('Gerenciar gestores por departamento') && h.includes('>Fiscal<') && h.includes('>Sucesso do Cliente<'));
    assert.ok(h.includes('Eduardo <small>gestor(a)</small>') && h.includes('Denisa <small>diretor(a)</small>') && h.includes('data-gdel="1"') && h.includes('data-gdel="2"'));
    assert.ok(h.includes('sem gestor: as ocorrências vão para o Sucesso do Cliente'));
    assert.ok(h.includes('data-gadd="Fiscal"') && h.includes('data-gadd="Sucesso"') && h.includes('<option value="u3">Thais &lt;T&gt;</option>'));
  });
  await teste('cs: análise traz o grupo consolidado e cada empresa; zero vira "sem faturamento"; CPF aparece', () => {
    const e = C.t.dadosExport('analise');
    const nomes = e.linhas.map((l) => l[1].trim());
    assert.ok(nomes.includes('GRUPO GRUPO A') && nomes.includes('ALFA LTDA') && nomes.includes('ALFA FILIAL LTDA') && nomes.includes('JOAO DA SILVA'));
    const grupo = e.linhas.find((l) => l[0] === 'Grupo');
    assert.deepStrictEqual([grupo[6], grupo[7], grupo[8]], [3, 1300, 120000.5]);
    assert.strictEqual(grupo[4], 'Ouro');                                                  // a linha do grupo traz a categoria das empresas
    assert.strictEqual(e.linhas.find((l) => l[1].trim() === 'ALFA FILIAL LTDA')[8], 'sem faturamento');
    assert.strictEqual(e.linhas.find((l) => l[1].trim() === 'ALFA FILIAL LTDA')[11], 'Natureza sem configuração de faturamento no Questor');
    assert.strictEqual(e.linhas.find((l) => l[1] === 'JOAO DA SILVA')[3], 'CPF');
  });
  await teste('cs: honorário sugerido = percentual × faturamento médio mensal; análise verde, amarela e vermelha', () => {
    C.t.estado.honorario = { percentual: 0.5, limite_amarelo: 80, pode_editar: true };
    assert.strictEqual(C.t.honSugerido(120000), 50);            // 120.000 ÷ 12 = 10.000 × 0,5% = 50
    assert.strictEqual(C.t.honSugerido(null), null);
    assert.strictEqual(C.t.honSugerido(0), null);
    assert.strictEqual(C.t.honAnalise(50, 50), 'ok');
    assert.strictEqual(C.t.honAnalise(80, 50), 'ok');
    assert.strictEqual(C.t.honAnalise(45, 50), 'medio');         // 90% do sugerido
    assert.strictEqual(C.t.honAnalise(40, 50), 'medio');         // exatamente 80%
    assert.strictEqual(C.t.honAnalise(39, 50), 'baixo');
    assert.strictEqual(C.t.honAnalise(0, 50), 'baixo');
    assert.strictEqual(C.t.honAnalise(null, 50), null);
    C.t.estado.honorario = { percentual: null, limite_amarelo: 80 };
    assert.strictEqual(C.t.honSugerido(120000), null);          // sem percentual definido
    C.t.estado.honorario = { percentual: 0.5, limite_amarelo: 80, pode_editar: true };
    const cel = C.t.celSugerido(12000000, 800);                  // 1.000.000 × 0,5% = 5.000
    const celTxt = cel.split(String.fromCharCode(160)).join(' ');
    assert.ok(celTxt.includes('R$ 5.000,00') && celTxt.includes('diferença −R$ 4.200,00'), 'tooltip com a diferença: ' + cel);
    assert.ok(C.t.celAnalise(12000000, 800).includes('an-baixo'));
    assert.ok(C.t.celAnalise(12000000, 5000).includes('an-ok'));
    C.t.estado.ocultar = true;
    assert.ok(!/5[.]000|4[.]200/.test(C.t.celSugerido(12000000, 800)), 'valores ocultos vazaram na coluna nova');
    assert.ok(!C.t.celAnalise(12000000, 800).includes('an-'), 'o símbolo revelaria a relação com os valores ocultos');
    C.t.estado.ocultar = false;
    C.t.estado.honorario = null;
  });
  await teste('cs: análise anual — faturamento e funcionários, regra "ambos", regime por ano, só ativos e exportação', () => {
    const E = C.t.estado;
    const a = (ano, fat, fun, regime) => ({ ano, faturamento: fat, meses: 12, funcionarios: fun, regime });
    E.anual = {
      valores_ocultos: false, ate: '2026-08', ano_inicial: 2023, config: { percentual: 30, pode_editar: true },
      itens: [
        { cnpj: '11222333000181', anos: [a(2023, 1000, 10, 'Simples Nacional'), a(2024, 1000, 10, 'Simples Nacional'), a(2025, 1400, 14, 'Lucro Presumido'), { ano: 2026, faturamento: 900, meses: 8, funcionarios: 15 }] },   // +40% fat, +40% func, mudou de regime
        { cnpj: '11222333000262', anos: [a(2024, 1000, 10, 'Simples Nacional'), a(2025, 1250, 13, 'Simples Nacional')] },                                                                                              // +25% (abaixo do limite)
        { cnpj: '77888999000133', anos: [a(2024, 1000, null, null), a(2025, 1500, null, null)] },                                                                                                                   // +50% fat, sem folha
        { cnpj: '99999999000199', anos: [a(2024, 100, 1, null), a(2025, 900, 9, null)] },                                                                                                                           // não está na lista de ativos
      ],
    };
    E.filtroAnual = { busca: '', ano: null, soDestaque: false, regra: 'ambos', ordem: 'alta', pag: 1 };
    // fontes diferentes não geram mudança falsa: 'Lucro (Presumido/Real)' (sem detalhe) contra um regime específico não conta
    assert.strictEqual(C.t.regimeMudou('Lucro Presumido', 'Lucro (Presumido/Real)'), false);
    assert.strictEqual(C.t.regimeMudou('Lucro (Presumido/Real)', 'Lucro Presumido'), false);
    assert.strictEqual(C.t.regimeMudou('Simples Nacional', 'Lucro (Presumido/Real)'), true);
    assert.strictEqual(C.t.regimeMudou('Simples Nacional', 'Lucro Presumido'), true);
    assert.strictEqual(C.t.regimeMudou('Lucro Presumido', 'Lucro Real'), true);
    assert.strictEqual(C.t.regimeMudou('Lucro Real', 'Lucro Real'), false);
    assert.strictEqual(C.t.regimeMudou(null, 'Lucro Real'), false);
    assert.deepStrictEqual([...C.t.anosAnual().completos], [2024, 2025]);                  // 2026 é parcial (8 meses) e fica de fora
    // cliente sem faturamento usado: "sem dado" com o aviso ao passar o mouse (total do relatório não fecha com a soma dos meses)
    const semAviso = C.t.semDadoFat({ 2025: { faturamento: null } }, 2025);
    const comAviso = C.t.semDadoFat({ 2025: { faturamento: null, aviso: 'Faturamento não usado: o total do relatório do Questor (R$ 1,00) não fecha com a soma dos meses (R$ 2,00)' } }, 2025);
    assert.ok(!/title=/.test(semAviso) && /sem dado/.test(semAviso));
    assert.ok(/title="[^"]*não fecha com a soma dos meses/.test(comAviso));
    assert.strictEqual(C.t.varPct(1000, 1400), 40);
    assert.strictEqual(C.t.varPct(0, 500), null);
    const r = C.t.linhasAnual();
    assert.strictEqual(r.ano, 2025);
    assert.strictEqual(r.linhas.length, 4);                                                // 3 CNPJ + 1 CPF da lista; o 99999999000199 não aparece
    assert.strictEqual(r.linhas[0].c.nome, 'GAMA LTDA');                                   // maior alta de faturamento primeiro (+50%)
    assert.strictEqual(r.subiram, 2);                                                      // "ambos": ALFA (fat +40% e func +40%) e GAMA (+50%, sem folha: decide o faturamento)
    assert.strictEqual(r.mudaram, 1);
    const alfa = r.linhas.find((l) => l.c.nome === 'ALFA LTDA');
    assert.deepStrictEqual([alfa.fp, alfa.fc, alfa.vf, alfa.rp, alfa.rc, alfa.mudouRegime], [10, 14, 40, 'Simples Nacional', 'Lucro Presumido', true]);
    // honorário por ano vindo do Omie fica à parte do faturamento
    E.anual.itens[0].honorarios = [{ ano: 2024, total: 4000, meses: 12, mensal: 330 }, { ano: 2025, total: 5000, meses: 12, mensal: 420 }];
    assert.strictEqual(C.t.mapaHonAnual()['11222333000181'][2025].mensal, 420);
    assert.deepStrictEqual({ ...C.t.mapaHonAnual()['11222333000262'] }, {});
    // cruzamento com o honorário do Omie: ALFA (+40% fat, +40% func) cobrava 330 em 2024 e 420 em 2025 (+27%): reajustado
    const alfaH = C.t.linhasAnual().linhas.find((l) => l.c.nome === 'ALFA LTDA');
    assert.deepStrictEqual([alfaH.hp, alfaH.hc, alfaH.hcAno, Math.round(alfaH.vh)], [330, 420, 2025, 27]);
    assert.strictEqual(C.t.reajusteLinha(alfaH), 'sim');
    assert.strictEqual(C.t.reajusteLinha({ ...alfaH, hc: 335, vh: 1.5 }), 'nao');                  // destaque, mas o honorário quase não mexeu
    assert.strictEqual(C.t.reajusteLinha({ ...alfaH, hp: null, vh: null }), 'sem-dado');            // sem os dois valores no Omie
    assert.strictEqual(C.t.reajusteLinha({ v: 5, vf: 0, mudouRegime: false, vh: 1 }), null);        // não é destaque: sem situação
    assert.doesNotThrow(() => C.t.abrirFichaAnual('11222333000181'));                              // ficha com o bloco do honorário do Omie
    assert.doesNotThrow(() => C.t.abrirFichaAnual('77888999000133'));                              // sem honorário no Omie
    // corte do "sem reajuste" editável: com 30%, +27% passa a contar como sem reajuste; sem valor salvo vale o padrão de 5%
    E.anual.config.reajuste_min = 30;
    assert.strictEqual(C.t.reajusteLinha(C.t.linhasAnual().linhas.find((l) => l.c.nome === 'ALFA LTDA')), 'nao');
    delete E.anual.config.reajuste_min;
    assert.strictEqual(C.t.reajusteLinha(C.t.linhasAnual().linhas.find((l) => l.c.nome === 'ALFA LTDA')), 'sim');
    // mudança de regime dispara 'Rever honorário' mesmo sem alta de faturamento/funcionários, em qualquer regra
    const semAlta = { v: 5, vf: 0, rp: 'Simples Nacional', rc: 'Lucro Presumido', mudouRegime: true };
    ['ambos', 'fat', 'func', 'ou'].forEach((rg) => assert.strictEqual(C.t.destaqueLinha(semAlta, rg), true, rg));
    assert.strictEqual(C.t.destaqueLinha({ v: 5, vf: 0, mudouRegime: false }, 'ou'), false);
    assert.deepStrictEqual([...C.t.motivosRever(semAlta)], ['mudou de regime (Simples Nacional → Lucro Presumido)']);
    assert.deepStrictEqual([...C.t.motivosRever(alfa)], ['faturamento +40%', 'funcionários +40%', 'mudou de regime (Simples Nacional → Lucro Presumido)']);
    E.filtroAnual.regra = 'fat';
    assert.strictEqual(C.t.linhasAnual().subiram, 2);                                      // ALFA e GAMA
    E.filtroAnual.tipo = 'CPF';
    assert.deepStrictEqual(C.t.linhasAnual().linhas.map((l) => l.c.nome), ['JOAO DA SILVA']);   // filtro Documento
    assert.deepStrictEqual({ ...C.t.linhasAnual().contTipo }, { CNPJ: 3, CPF: 1, CAEPF: 0, CNO: 0 });
    E.filtroAnual.tipo = '';
    E.filtroAnual.regra = 'ou';
    assert.strictEqual(C.t.linhasAnual().subiram, 3);                                      // ALFA, ALFA FILIAL (func +30%) e GAMA (fat +50%)
    E.filtroAnual.regra = 'func';
    assert.strictEqual(C.t.linhasAnual().subiram, 2);                                      // ALFA (+40%) e ALFA FILIAL (+30%, exatamente no limite)
    E.filtroAnual.regra = 'ambos';
    E.filtroAnual.soDestaque = true;
    assert.deepStrictEqual(C.t.linhasAnual().linhas.map((l) => l.c.nome), ['GAMA LTDA', 'ALFA LTDA']);
    E.filtroAnual.soDestaque = false;
    E.filtroAnual.ordem = 'alfa';                                                          // ordem alfabética (padrão da tela)
    assert.deepStrictEqual(C.t.linhasAnual().linhas.map((l) => l.c.nome), ['ALFA FILIAL LTDA', 'ALFA LTDA', 'GAMA LTDA', 'JOAO DA SILVA']);
    E.filtroAnual.ordem = 'alta';
    const x = C.t.dadosExport('anual');
    semLixo(x, 'cs/anual');
    const lin = x.linhas.find((l) => l[0] === 'ALFA LTDA');
    assert.deepStrictEqual([lin[3], lin[4], lin[5], lin[6], lin[7], lin[8], lin[9], lin[10], lin[11]], ['Simples Nacional', 'Lucro Presumido', 1000, 1400, 40, 10, 14, 40, 'Sim']);
    assert.strictEqual(x.linhas.find((l) => l[0] === 'GAMA LTDA')[11], 'Sim');             // sem folha: decide o faturamento (+50%)
    assert.strictEqual(x.linhas.find((l) => l[0] === 'ALFA FILIAL LTDA')[11], '');         // fat +25%: abaixo do limite
    E.ocultar = true;
    assert.ok(C.t.dadosExport('anual').linhas.every((l) => l[5] === 'oculto' || l[5] === 'sem dado'), 'valores ocultos vazaram na análise anual');
    E.ocultar = false;
    E.anual = null;
  });
  await teste('cs: módulo Atendimento — lista, dica de e-mails por destinatário, filtro e exportação', () => {
    const E = C.t.estado;
    E.atend = { janela_dias: 180, email_lido_em: '2026-10-12T11:00:00Z', email_janela_dias: 180, clientes: [
      { id: '2', nome: 'BETA LTDA', cnpj: '22.333.444/0001-55', categoria: 'Prata', atendimentos: 4, sla_vermelho: 1, notas_baixas: 0, ultimo: '2026-10-10',
        email: { recebidos: 9, sem_resposta: 2, destinatarios: [{ nome: 'dptofiscal@escritorial.com.br', grupo: true, recebidos: 5, sem: 2 }, { nome: 'Guilherme', grupo: false, recebidos: 4, sem: 0 }] } },
      { id: '1', nome: 'ALFA LTDA', cnpj: '11.222.333/0001-81', categoria: 'Ouro', atendimentos: 12, sla_vermelho: 0, notas_baixas: 1, ultimo: '2026-10-14', email: null },
    ] };
    E.filtroAtend = { busca: '', soSem: false, pag: 1 };
    assert.deepStrictEqual(C.t.linhasAtend().map((l) => l.nome), ['ALFA LTDA', 'BETA LTDA']);               // ordem alfabética
    E.filtroAtend.soSem = true;
    assert.deepStrictEqual(C.t.linhasAtend().map((l) => l.nome), ['BETA LTDA']);                              // só com e-mail sem resposta
    E.filtroAtend.soSem = false;
    const dica = C.t.dicaEmails(E.atend.clientes[0].email);
    assert.ok(dica.includes('• dptofiscal@escritorial.com.br (grupo): 5') && dica.includes('• Guilherme: 4'), dica);
    assert.ok(dica.includes('Sem resposta:\n• dptofiscal@escritorial.com.br: 2 (grupo do escritório: pode ter sido respondido por outro e-mail)'), dica);
    assert.ok(!/Guilherme: 0/.test(dica));
    assert.ok(/sem resposta/i.test(C.t.dicaEmails(null)) || /Sem e-mails/.test(C.t.dicaEmails(null)));
    assert.doesNotThrow(() => C.t.desenharAtendimento());
    const x = C.t.dadosExport('atendimento');
    semLixo(x, 'cs/atendimento');
    assert.deepStrictEqual(x.linhas.map((l) => [l[0], l[3], l[7], l[8]]), [['ALFA LTDA', 12, '', ''], ['BETA LTDA', 4, 9, 2]]);
    assert.strictEqual(x.linhas[1][9], 'dptofiscal@escritorial.com.br: 2');
  });
  await teste('cs: churn por motivo — motivo efetivo, seleção e cartão com sem motivo', () => {
    const E = C.t.estado;
    E.motivosChurn = [{ id: '1', nome: 'Churn por experiência técnica' }, { id: '2', nome: 'Churn motivado por decisão pessoal' }];
    E.dados.usuario = { nome: 'Teste', papel: 'administrador' };
    assert.strictEqual(C.t.motivoDaSaida({ motivo_churn: 'Churn por experiência técnica' }), 'Churn por experiência técnica');
    assert.strictEqual(C.t.motivoDaSaida({ motivo_saida: 'churn motivado por decisao pessoal' }), 'Churn motivado por decisão pessoal');
    assert.strictEqual(C.t.motivoDaSaida({ motivo_saida: 'Baixa de empresa' }), null);
    assert.ok(/<select class="gp-select q-motivo" data-id="x1"/.test(C.t.selectMotivoChurn({ id: 'x1', motivo_churn: null })));
    const html = C.t.cartaoMotivosChurn([
      { id: 'a', tipo: 'transferida', na_base: true, motivo_churn: 'Churn por experiência técnica' },
      { id: 'b', tipo: 'transferida', na_base: true, motivo_churn: null },
      { id: 'c', tipo: 'baixa', na_base: true, motivo_churn: 'Churn por experiência técnica' },     // baixa não conta
    ]);
    assert.ok(html.includes('2 saída(s) que contam') && html.includes('1 sem motivo classificado'), html.slice(0, 400));
    E.dados.usuario = { nome: 'Teste', papel: 'colaborador' };
    assert.ok(!/<select/.test(C.t.selectMotivoChurn({ id: 'x1', motivo_churn: 'Churn por experiência técnica' })));   // sem permissão: só texto
  });
  await teste('cs: risco e churn trazem os campos certos', () => {
    const r = C.t.dadosExport('risco');
    const alfa = r.linhas.find((l) => l[0] === 'ALFA LTDA');
    assert.deepStrictEqual([alfa[3], alfa[4], alfa[5], alfa[7], alfa[8], alfa[11]], ['Alto', 70, 90, 'sem dado', 75, 'Inadimplente: 3 títulos | Nota baixa']);
    assert.strictEqual(r.linhas.find((l) => l[0] === 'GAMA LTDA')[9], 'Sim');
    const c = C.t.dadosExport('churn');
    assert.strictEqual(c.linhas.length, 2);
    assert.deepStrictEqual([...c.linhas[0].slice(2, 6)], ['01/01/2024', '01/05/2026', 'Transferida', 'Sim']);
  });
  await teste('cs: valores ocultos (perfil Usuário ou botão) não vazam honorário, faturamento nem motivo da categoria', () => {
    C.t.estado.ocultar = true;
    for (const sec of ['analise', 'risco', 'categorias']) {
      const txt = JSON.stringify(C.t.dadosExport(sec).linhas);
      assert.ok(!/\b(800|1300|1\.300|120000)/.test(txt), sec + ' vazou: ' + txt.slice(0, 200));   // 500 e 999 são limites de faixa, não valores do cliente
    }
    C.t.estado.ocultar = false;
    C.t.estado.dados.valores_ocultos = true;                       // perfil Usuário: o servidor já mascarou
    assert.ok(C.t.dadosExport('analise').linhas.every((l) => l[7] === 'oculto' || l[7] === ''));
    assert.ok(C.t.dadosExport('analise').linhas.every((l) => l[9] === 'oculto' || l[9] === ''), 'honorário sugerido vazou');
    C.t.estado.dados.valores_ocultos = false;
  });

  // ── exportador (CSV) ──
  let ultimo = null;
  const E = carregar('exportar.js', '{ Exportar: window.Exportar }');
  E.ctx.document.createElement = () => ({ click() { ultimo.clicou = true; }, set href(v) {}, set download(v) { ultimo.nome = v; }, style: {} });
  E.ctx.document.body = { appendChild() {}, removeChild() {} };
  E.ctx.URL = { createObjectURL: (b) => { ultimo = { blob: b }; return 'blob:x'; }, revokeObjectURL() {} };
  await teste('csv: BOM, separador ";", vírgula decimal, aspas e proteção contra fórmula', async () => {
    E.win.Exportar.csv('teste', ['Nome', 'Valor', 'Obs'], [['BETA; "ASPAS" LTDA', 1234.5, '=SOMA(A1)'], ['Linha\ncom quebra', null, 'ok']]);
    assert.ok(/^teste-\d{4}-\d{2}-\d{2}\.csv$/.test(ultimo.nome), ultimo.nome);
    const txt = Buffer.from(await ultimo.blob.arrayBuffer()).toString('utf8');
    assert.strictEqual(txt.charCodeAt(0), 0xfeff);
    const linhas = txt.slice(1).split('\r\n');
    assert.strictEqual(linhas[0], 'Nome;Valor;Obs');
    assert.strictEqual(linhas[1], '"BETA; ""ASPAS"" LTDA";1234,5;\'=SOMA(A1)');
    assert.strictEqual(linhas[2], 'Linha com quebra;;ok');
  });

  console.log(`\n${ok} testes passaram.`);
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
