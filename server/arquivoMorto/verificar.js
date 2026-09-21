'use strict';
/**
 * Verificação PÓS-cópia — NÃO apaga nada, só confirma.
 *
 * Pra cada empresa com status 'ok' no estado local, refaz o mesmo match de
 * origem (nome normalizado) que o pipeline usou, e confere ARQUIVO POR
 * ARQUIVO (mesmo caminho relativo) que tudo que existe na origem também
 * existe em CADA um dos 3 destinos (servidor local, Drive por faixa, Desktop
 * por faixa). Reporta contagem de arquivos, soma de bytes e o que
 * eventualmente faltar em algum destino.
 *
 * Isso é o que dá segurança pra decidir excluir da origem depois — só depois
 * de rodar isto e ver "0 faltando" nos 3 destinos é que uma empresa deveria
 * ser considerada "fielmente copiada".
 *
 * Quando acha algum arquivo faltando em algum destino, por padrão TENTA
 * CORRIGIR na hora: reroda copiarConteudo() (a mesma cópia incremental e
 * não-destrutiva do pipeline — só copia o que falta, nunca sobrescreve, nunca
 * apaga) só pro(s) destino(s) com pendência daquele bloco, e reconfirma
 * arquivo a arquivo que a lacuna fechou. Use --sem-copiar pra só relatar,
 * sem escrever nada.
 *
 * Uso:
 *   node server/arquivoMorto/verificar.js
 *   node server/arquivoMorto/verificar.js --empresa="ACADEMIA VIDATIVA LTDA"
 *   node server/arquivoMorto/verificar.js --csv=meu_relatorio.csv
 *   node server/arquivoMorto/verificar.js --sem-copiar
 */

const fs = require('fs/promises');
const path = require('path');
const { carregarConfig } = require('./config');
const { normalizar, faixaDeLetra } = require('./nomes');
const { localizarEmVarias, limparCache } = require('./localizador');
const { existe, longPath, copiarConteudo } = require('./copiador');
const { nomePastaSeguro } = require('./pipeline');

const SO_CERTIFICADO = rel => /\.(pfx|p12)$/i.test(rel);
const TIMEOUT_BLOCO_MS = 8 * 60 * 1000;

function comTimeout(promessa, ms, rotulo) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout de ${Math.round(ms / 1000)}s verificando "${rotulo}"`)), ms);
  });
  return Promise.race([promessa, timeout]).finally(() => clearTimeout(t));
}

/**
 * Anda recursivamente por `origemDir` e, pra cada arquivo (fora desktop.ini),
 * confere se existe em CADA destino de `destinos` (mesmo caminho relativo).
 * Conta arquivos e soma bytes de TODOS (existindo ou não no destino) —
 * assertivo: não usa só contagem agregada, confere caminho a caminho.
 */
async function verificarConteudo(origemDir, destinos, filtroArquivo) {
  const res = { arquivos: 0, bytes: 0, faltando: destinos.map(() => []) };

  async function andar(relDir) {
    const dirOrig = relDir ? path.win32.join(origemDir, relDir) : origemDir;
    let ents;
    try { ents = await fs.readdir(longPath(dirOrig), { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }

    for (const ent of ents) {
      const rel = relDir ? path.win32.join(relDir, ent.name) : ent.name;
      if (ent.isDirectory()) { await andar(rel); continue; }
      if (!ent.isFile()) continue;
      if (ent.name.toLowerCase() === 'desktop.ini') continue;
      if (filtroArquivo && !filtroArquivo(rel)) continue;

      res.arquivos++;
      try {
        const st = await fs.stat(longPath(path.win32.join(dirOrig, ent.name)));
        res.bytes += st.size;
      } catch { /* segue sem tamanho */ }

      for (let i = 0; i < destinos.length; i++) {
        const alvo = path.win32.join(destinos[i], rel);
        if (!(await existe(alvo))) res.faltando[i].push(rel);
      }
    }
  }

  await andar('');
  return res;
}

function parseFlags(argv) {
  const o = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith('--empresa=')) o.empresaFiltro = a.slice(10).replace(/^["']|["']$/g, '');
    else if (a.startsWith('--csv=')) o.csvPath = a.slice(6);
    else if (a === '--sem-copiar') o.semCopiar = true;
  }
  return o;
}

function csvEscape(v) { return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`; }

async function main() {
  const config = carregarConfig();
  const flags = parseFlags(process.argv);
  const csvPath = flags.csvPath || path.join(__dirname, 'verificacao.csv');

  const estadoPath = path.join(config.estadoDir, 'processadas.json');
  const estado = JSON.parse(await fs.readFile(estadoPath, 'utf8'));
  let alvos = Object.entries(estado).filter(([, v]) => v.status === 'ok');
  if (flags.empresaFiltro) {
    const alvoNorm = normalizar(flags.empresaFiltro);
    alvos = alvos.filter(([, v]) => normalizar(v.nome) === alvoNorm);
  }

  console.log(`[verificar] início ${new Date().toISOString()}`);
  console.log(`[verificar] ${alvos.length} empresa(s) com status 'ok' pra verificar`);
  limparCache();

  const linhas = [];
  const resumoEmpresa = [];
  let i = 0;
  for (const [, v] of alvos) {
    i++;
    const nome = v.nome;
    const nomeNorm = normalizar(nome);
    const faixa = faixaDeLetra(nomeNorm);
    const pastaEmpresa = nomePastaSeguro(nome);
    console.log(`[verificar] (${i}/${alvos.length}) ${nome}`);

    const driveBase = config.destinos.driveBasePorFaixa[faixa];
    const backupBase = config.destinos.backupDesktopBasePorFaixa[faixa];
    const destinosEmpresa = [
      path.win32.join(config.destinos.localBase, pastaEmpresa),
      path.win32.join(driveBase, pastaEmpresa),
      path.win32.join(backupBase, pastaEmpresa),
    ];

    const S = config.subpastas;
    const blocos = [
      { rotulo: '2024', origens: config.origens.ano2024, seg: [S.ano2024] },
      { rotulo: '2025', origens: config.origens.ano2025, seg: [S.ano2025] },
      { rotulo: '2026', origens: config.origens.ano2026, seg: [S.ano2026] },
      { rotulo: 'Legalização', origens: [config.origens.legalizacao], seg: [S.legalizacao] },
      { rotulo: 'Certificado Digital', origens: [config.origens.certificadosPj], seg: [S.legalizacao, S.certificadoDigital], filtro: SO_CERTIFICADO },
      { rotulo: 'Sucesso do Cliente', origens: [config.origens.sucessoDoCliente], seg: [S.sucessoDoCliente] },
    ];

    let empresaOk = true;
    let empresaTeveErro = false;

    for (const bloco of blocos) {
      let caminhos = [], ambiguas = [];
      try {
        ({ caminhos, ambiguas } = await comTimeout(localizarEmVarias(bloco.origens, nomeNorm), TIMEOUT_BLOCO_MS, `${nome} / ${bloco.rotulo} (localizar)`));
      } catch (e) {
        console.log(`   [${bloco.rotulo}] ERRO ao localizar: ${e.message}`);
        empresaOk = false; empresaTeveErro = true;
        linhas.push({ Empresa: nome, Faixa: faixa, Bloco: bloco.rotulo, Origem: '', Arquivos: '', Bytes: '', FaltamLocal: '', FaltamDrive: '', FaltamBackup: '', OK: false, Erro: e.message });
        continue;
      }
      if (ambiguas.length) { empresaOk = false; console.log(`   [${bloco.rotulo}] AMBIGUO — pulando`); continue; }
      if (!caminhos.length) continue; // nada dessa empresa nessa origem — nao e' pendencia

      const destinosBloco = destinosEmpresa.map(d => bloco.seg.length ? path.win32.join(d, ...bloco.seg) : d);
      for (const origemPath of caminhos) {
        let r;
        try {
          r = await comTimeout(verificarConteudo(origemPath, destinosBloco, bloco.filtro), TIMEOUT_BLOCO_MS, `${nome} / ${bloco.rotulo} (verificar)`);
        } catch (e) {
          console.log(`   [${bloco.rotulo}] ERRO ao verificar: ${e.message}`);
          empresaOk = false; empresaTeveErro = true;
          linhas.push({ Empresa: nome, Faixa: faixa, Bloco: bloco.rotulo, Origem: origemPath, Arquivos: '', Bytes: '', FaltamLocal: '', FaltamDrive: '', FaltamBackup: '', OK: false, Erro: e.message });
          continue;
        }
        // Achou lacuna? Por padrão corrige na hora: reroda a MESMA cópia
        // incremental/não-destrutiva do pipeline só pro(s) destino(s) que
        // falta(m) nesse bloco (nunca sobrescreve o que já existe), e depois
        // reconfirma arquivo a arquivo que fechou. --sem-copiar pula isso.
        const corrigidos = [0, 0, 0];
        const errosCorrecao = [];
        if (!flags.semCopiar) {
          for (let di = 0; di < destinosBloco.length; di++) {
            const antes = r.faltando[di];
            if (!antes.length) continue;
            let rCopia;
            try {
              rCopia = await comTimeout(copiarConteudo(origemPath, destinosBloco[di], { filtroArquivo: bloco.filtro }), TIMEOUT_BLOCO_MS, `${nome} / ${bloco.rotulo} (corrigir)`);
            } catch (e) {
              errosCorrecao.push(`${e.message}`);
              continue;
            }
            // copiarConteudo NÃO lança em erro de arquivo individual — só
            // acumula em res.erros e segue. Sem checar isso aqui, uma cópia
            // que falhou silenciosamente (nome não suportado no destino,
            // caminho longo, etc.) passava batido sem motivo nenhum no log.
            for (const e of rCopia.erros) errosCorrecao.push(`${e.arquivo}: ${e.motivo}`);
            const aindaFaltando = [];
            for (const rel of antes) {
              if (!(await existe(path.win32.join(destinosBloco[di], rel)))) aindaFaltando.push(rel);
            }
            corrigidos[di] = antes.length - aindaFaltando.length;
            r.faltando[di] = aindaFaltando;
          }
        }

        const faltamLocal = r.faltando[0].length, faltamDrive = r.faltando[1].length, faltamBackup = r.faltando[2].length;
        const ok = faltamLocal === 0 && faltamDrive === 0 && faltamBackup === 0;
        if (!ok) empresaOk = false;
        if (errosCorrecao.length) empresaTeveErro = true;
        const totalCorrigido = corrigidos[0] + corrigidos[1] + corrigidos[2];
        if (totalCorrigido) console.log(`   [${bloco.rotulo}] corrigido: ${totalCorrigido} arquivo(s) copiado(s) (local=${corrigidos[0]} drive=${corrigidos[1]} backup=${corrigidos[2]})`);
        if (errosCorrecao.length) console.log(`   [${bloco.rotulo}] erro ao corrigir: ${errosCorrecao.join('; ')}`);
        console.log(`   [${bloco.rotulo}] ${r.arquivos} arq / ${(r.bytes / 1024 / 1024).toFixed(1)}MB` +
          ` -> faltam: local=${faltamLocal} drive=${faltamDrive} backup=${faltamBackup}` +
          (ok ? '  OK' : '  <<< INCOMPLETO'));
        linhas.push({
          Empresa: nome, Faixa: faixa, Bloco: bloco.rotulo, Origem: origemPath,
          Arquivos: r.arquivos, Bytes: r.bytes,
          FaltamLocal: faltamLocal, FaltamDrive: faltamDrive, FaltamBackup: faltamBackup,
          Corrigidos: totalCorrigido,
          OK: ok, Erro: errosCorrecao.join('; '),
        });
      }
    }
    console.log(`   => ${empresaTeveErro ? 'ERRO NA VERIFICACAO (retry depois)' : empresaOk ? 'FIELMENTE COPIADA' : 'COM PENDENCIA'}`);
    resumoEmpresa.push({ Empresa: nome, Faixa: faixa, FielmenteCopiada: empresaOk && !empresaTeveErro, TeveErro: empresaTeveErro });
  }

  const header = ['Empresa', 'Faixa', 'Bloco', 'Origem', 'Arquivos', 'Bytes', 'FaltamLocal', 'FaltamDrive', 'FaltamBackup', 'Corrigidos', 'OK', 'Erro'];
  const csv = [header.join(','), ...linhas.map(l => header.map(h => csvEscape(l[h])).join(','))].join('\n');
  await fs.writeFile(csvPath, csv, 'utf8');

  const resumoPath = csvPath.replace(/\.csv$/i, '') + '_resumo.csv';
  const header2 = ['Empresa', 'Faixa', 'FielmenteCopiada', 'TeveErro'];
  const csv2 = [header2.join(','), ...resumoEmpresa.map(l => header2.map(h => csvEscape(l[h])).join(','))].join('\n');
  await fs.writeFile(resumoPath, csv2, 'utf8');

  console.log(`\n[verificar] CSV detalhado: ${csvPath}`);
  console.log(`[verificar] CSV resumo por empresa: ${resumoPath}`);
  const fielCount = resumoEmpresa.filter(r => r.FielmenteCopiada).length;
  const erroCount = resumoEmpresa.filter(r => r.TeveErro).length;
  console.log(`[verificar] empresas: ${resumoEmpresa.length} | fielmente copiadas: ${fielCount} | com pendência: ${resumoEmpresa.length - fielCount - erroCount} | com erro (retry): ${erroCount}`);
}

main().catch(e => { console.error('[verificar] ERRO FATAL:', e && e.stack || e); process.exit(2); });
