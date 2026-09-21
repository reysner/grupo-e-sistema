'use strict';
/**
 * Orquestração do Modelo 01 — arquivar empresas inativas.
 *
 *   1. pega no Acessórias as empresas INATIVAS com "Cliente até" >= data de corte
 *      (reaproveita listarEmpresasInativasDesde de ../acessoriasClient.js)
 *   2. pula as que o estado local já marca como 'ok'
 *   3. pra cada empresa, localiza a pasta dela em cada origem e COPIA o conteúdo
 *      (incremental, nunca sobrescreve) montando a árvore-alvo nos 3 destinos
 *      (servidor local + Drive por faixa + backup no Desktop por faixa):
 *        <RAZÃO>/2024  /2025  /2026  /Legalização[/Certificado Digital]  /Sucesso do Cliente
 *   4. grava o estado e devolve o relatório pro e-mail de resumo
 */

const path = require('path');
const acessoriasClient = require('../acessoriasClient');
const { normalizar, faixaDeLetra } = require('./nomes');
const { localizarEmVarias, limparCache } = require('./localizador');
const { copiarConteudo, somar } = require('./copiador');
const estado = require('./estado');

/** Tira caracteres proibidos em nome de pasta no Windows. */
function nomePastaSeguro(nome) {
  return String(nome)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
}

const SO_CERTIFICADO = rel => /\.(pfx|p12)$/i.test(rel);

// Operação de arquivo (readdir/copyFile) no compartilhamento de rede não tem
// timeout nenhum — se o link cair no meio, trava pra sempre (visto na prática:
// job travou >1h sem erro nem atividade de rede, numa empresa qualquer da
// lista). `comTimeout` não cancela a chamada pendurada (fs não dá pra
// abortar), só desiste de ESPERAR por ela e segue pra próxima empresa — o
// `process.exit()` no fim de run.js encerra o processo mesmo com isso pendente.
// Como a cópia é incremental, uma próxima execução retoma de onde travou.
const TIMEOUT_EMPRESA_MS = 8 * 60 * 1000;
function comTimeout(promessa, ms, rotulo) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout de ${Math.round(ms / 1000)}s processando "${rotulo}" (provável instabilidade do link de rede)`)), ms);
  });
  return Promise.race([promessa, timeout]).finally(() => clearTimeout(t));
}

/**
 * Arquiva UMA empresa nos 3 destinos.
 * @returns {{status:'ok'|'parcial'|'nao_localizada', faixa:string, blocos:object,
 *            totais:{copiados:number,jaExistiam:number,bytes:number},
 *            ambiguidades:Array, erros:Array}}
 */
async function arquivarEmpresa(emp, config, { dryRun }) {
  if (!emp.nome_empresa) throw new Error('empresa sem Razão Social na Acessórias — não dá pra casar pasta');

  const nomeNorm = normalizar(emp.nome_empresa);
  const faixa = faixaDeLetra(nomeNorm);
  const pastaEmpresa = nomePastaSeguro(emp.nome_empresa);

  const driveBase = config.destinos.driveBasePorFaixa[faixa];
  const backupBase = config.destinos.backupDesktopBasePorFaixa[faixa];
  const destinos = [
    path.win32.join(config.destinos.localBase, pastaEmpresa),
    path.win32.join(driveBase, pastaEmpresa),
    path.win32.join(backupBase, pastaEmpresa),
  ];

  const acc = {
    status: 'ok', faixa, blocos: {},
    totais: { copiados: 0, jaExistiam: 0, bytes: 0 },
    ambiguidades: [], erros: [],
  };

  async function bloco(rotulo, dirsOrigem, segmentosDestino, filtroArquivo) {
    const { caminhos, ambiguas } = await localizarEmVarias(dirsOrigem, nomeNorm);
    for (const cand of ambiguas) acc.ambiguidades.push({ bloco: rotulo, candidatos: cand });

    if (!caminhos.length) { acc.blocos[rotulo] = { encontrada: false, fontes: 0, copiados: 0, jaExistiam: 0 }; return; }

    let sub = { copiados: 0, jaExistiam: 0, bytes: 0, erros: [] };
    for (const origem of caminhos) {
      for (const destEmpresa of destinos) {
        const alvo = segmentosDestino.length ? path.win32.join(destEmpresa, ...segmentosDestino) : destEmpresa;
        sub = somar(sub, await copiarConteudo(origem, alvo, { dryRun, filtroArquivo }));
      }
    }
    acc.blocos[rotulo] = { encontrada: true, fontes: caminhos.length, copiados: sub.copiados, jaExistiam: sub.jaExistiam, bytes: sub.bytes };
    acc.totais.copiados += sub.copiados;
    acc.totais.jaExistiam += sub.jaExistiam;
    acc.totais.bytes += sub.bytes;
    for (const e of sub.erros) acc.erros.push({ bloco: rotulo, ...e });
  }

  const S = config.subpastas;
  await bloco('2024', config.origens.ano2024, [S.ano2024]);
  await bloco('2025', config.origens.ano2025, [S.ano2025]);
  await bloco('2026', config.origens.ano2026, [S.ano2026]);
  await bloco('Legalização', [config.origens.legalizacao], [S.legalizacao]);
  await bloco('Certificado Digital', [config.origens.certificadosPj], [S.legalizacao, S.certificadoDigital], SO_CERTIFICADO);
  await bloco('Sucesso do Cliente', [config.origens.sucessoDoCliente], [S.sucessoDoCliente]);

  const achouAlgo = Object.values(acc.blocos).some(b => b.encontrada);
  if (!achouAlgo && !acc.ambiguidades.length) acc.status = 'nao_localizada';
  else if (acc.erros.length || acc.ambiguidades.length) acc.status = 'parcial';
  else acc.status = 'ok';

  return acc;
}

/**
 * @param {object} config  saída de config.carregarConfig()
 * @param {object} opcoes   { dryRun, desde, empresaFiltro, cnpjFiltro }
 */
async function rodar(config, opcoes = {}) {
  const dryRun = !!opcoes.dryRun;
  const desde = opcoes.desde || config.desde;
  limparCache();

  // A API do Acessórias às vezes derruba a conexão no meio da paginação
  // (`fetch failed`). Num job noturno sem ninguém olhando, tenta de novo
  // algumas vezes antes de desistir (recomeça da página 1 — tudo bem).
  let inativas;
  for (let tentativa = 1; ; tentativa++) {
    try {
      inativas = await acessoriasClient.listarEmpresasInativasDesde({ token: config.acessoriasToken, desde });
      break;
    } catch (e) {
      if (tentativa >= 4) throw e;
      const espera = tentativa * 15000;
      console.warn(`[arquivoMorto] falha ao buscar inativas (tentativa ${tentativa}): ${e.message} — nova tentativa em ${espera / 1000}s`);
      await new Promise(r => setTimeout(r, espera));
    }
  }

  // filtro pontual (--empresa / --empresas / --cnpj): processa só essas e IGNORA o estado
  let ignorarEstado = false;
  if (opcoes.empresaFiltro) {
    const alvo = normalizar(opcoes.empresaFiltro);
    inativas = inativas.filter(e => normalizar(e.nome_empresa) === alvo);
    ignorarEstado = true;
  }
  if (opcoes.empresasFiltro && opcoes.empresasFiltro.length) {
    const alvos = new Set(opcoes.empresasFiltro.map(normalizar));
    inativas = inativas.filter(e => alvos.has(normalizar(e.nome_empresa)));
    ignorarEstado = true;
  }
  if (opcoes.cnpjFiltro) {
    const soDigitos = String(opcoes.cnpjFiltro).replace(/\D/g, '');
    inativas = inativas.filter(e => String(e.cnpj || '').replace(/\D/g, '') === soDigitos);
    ignorarEstado = true;
  }

  const estadoDados = estado.carregar(config.estadoDir);
  const rel = {
    desde, dryRun, inicio: new Date().toISOString(),
    total: inativas.length, puladas: 0,
    processadas: [], naoLocalizadas: [], comAmbiguidade: [], erros: [],
  };

  let i = 0;
  for (const emp of inativas) {
    i++;
    if (!ignorarEstado && estado.jaConcluida(estadoDados, emp.acessorias_id)) { rel.puladas++; continue; }
    console.log(`[arquivoMorto] (${i}/${inativas.length}) ${emp.nome_empresa}`);
    try {
      const t0Emp = Date.now();
      const r = await comTimeout(arquivarEmpresa(emp, config, { dryRun }), TIMEOUT_EMPRESA_MS, emp.nome_empresa);
      console.log(`  [${r.status}] faixa ${r.faixa} · ${r.totais.copiados} copiado(s), ${r.totais.jaExistiam} já existia(m) · ${Math.round((Date.now() - t0Emp) / 1000)}s`);
      rel.processadas.push({
        nome: emp.nome_empresa, cnpj: emp.cnpj, clienteAte: emp.clienteAte,
        status: r.status, faixa: r.faixa, blocos: r.blocos, totais: r.totais,
      });
      if (r.status === 'nao_localizada') rel.naoLocalizadas.push({ nome: emp.nome_empresa, cnpj: emp.cnpj, clienteAte: emp.clienteAte });
      if (r.ambiguidades.length) rel.comAmbiguidade.push({ nome: emp.nome_empresa, ambiguidades: r.ambiguidades });
      if (r.erros.length) rel.erros.push({ nome: emp.nome_empresa, itens: r.erros });

      if (!dryRun) {
        estado.registrar(estadoDados, emp.acessorias_id, {
          nome: emp.nome_empresa, cnpj: emp.cnpj, clienteAte: emp.clienteAte,
          status: r.status, faixa: r.faixa,
          copiadosUltimaExec: r.totais.copiados,
        });
      }
    } catch (e) {
      console.log(`  [erro] ${e.message}`);
      rel.erros.push({ nome: emp.nome_empresa, itens: [{ bloco: '-', motivo: e.message }] });
      if (!dryRun) {
        estado.registrar(estadoDados, emp.acessorias_id, {
          nome: emp.nome_empresa, cnpj: emp.cnpj, status: 'parcial', erro: e.message,
        });
      }
    }
  }

  if (!dryRun) estado.salvar(config.estadoDir, estadoDados);
  rel.fim = new Date().toISOString();
  return rel;
}

module.exports = { rodar, arquivarEmpresa, nomePastaSeguro };
