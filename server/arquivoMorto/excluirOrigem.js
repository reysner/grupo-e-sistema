'use strict';
/**
 * Exclusão da ORIGEM — só depois de `verificar.js` confirmar "0 faltando" nos
 * 3 destinos. NUNCA mexe em destino, só na origem, e só no sub-caminho exato
 * que foi verificado (nunca a pasta da empresa inteira).
 *
 * Reconfirma CADA arquivo (arquivo por arquivo, de novo, agora, na hora H) nos
 * 3 destinos antes de apagar — se alguma coisa mudou desde a verificação
 * anterior, PULA essa origem em vez de apagar às cegas.
 *
 * Bloco "Certificado Digital" tem filtro (só .pfx/.p12) na CONFERÊNCIA — mas
 * por decisão do Reysner (2026-09-13), a pasta inteira da empresa em
 * CERTIFICADOS PJ pode ser apagada junto com o certificado (não só o
 * arquivo solto). Loga como aviso se achar algum arquivo que não bate o
 * filtro nessa pasta (nunca foi conferido contra destino nenhum).
 *
 * `--ignorar-destino=local,drive,backup` (decisão pontual do Reysner,
 * 2026-09-14): pra quando um destino específico NUNCA vai fechar por um
 * motivo conhecido e aceito (ex.: Google Drive rejeita arquivo sem extensão)
 * — a reconferência continua checando os 3, mas só EXIGE completo nos que não
 * foram ignorados. Sempre loga o que faltou no destino ignorado, pro registro.
 *
 * Uso:
 *   node server/arquivoMorto/excluirOrigem.js --csv=verificacao.csv --exceto="EMPRESA 1,EMPRESA 2"
 *   (sem --real, só simula e mostra o que faria)
 *   node server/arquivoMorto/excluirOrigem.js --csv=verificacao.csv --exceto="..." --real
 *   node server/arquivoMorto/excluirOrigem.js --csv=pendentes.csv --ignorar-destino=drive --real
 */

const fs = require('fs/promises');
const path = require('path');
const { carregarConfig } = require('./config');
const { normalizar } = require('./nomes');
const { existe, longPath } = require('./copiador');
const { nomePastaSeguro } = require('./pipeline');

const SO_CERTIFICADO = rel => /\.(pfx|p12)$/i.test(rel);

const DESTINO_IDX = { local: 0, drive: 1, backup: 2 };

function parseFlags(argv) {
  const o = { exceto: [], ignorarDestino: [] };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--csv=')) o.csvPath = a.slice(6);
    else if (a.startsWith('--exceto=')) o.exceto = a.slice(9).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a.startsWith('--ignorar-destino=')) o.ignorarDestino = a.slice(18).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    else if (a === '--real') o.real = true;
  }
  return o;
}

function parseCsvLine(l) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (inQ) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else { if (c === '"') inQ = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
  }
  out.push(cur);
  return out;
}

async function carregarCsv(csvPath) {
  const txt = await fs.readFile(csvPath, 'utf8');
  const linhas = txt.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(linhas[0]);
  return linhas.slice(1).map(parseCsvLine).map(cols => Object.fromEntries(header.map((h, i) => [h, cols[i]])));
}

/** Reconfere AGORA (na hora de apagar) que todo arquivo de `origemDir` existe
 * em todos os `destinos` — arquivo por arquivo. Retorna a lista de arquivos
 * relativos encontrados (pra apagar seletivamente quando houver filtro). */
async function reconferir(origemDir, destinos, filtroArquivo, ignorarIdx = []) {
  const arquivos = [];
  const foraDoFiltro = []; // arquivos que existem na origem mas NUNCA foram conferidos contra destino nenhum
  const faltandoIgnorado = []; // {rel, destinoIdx} — faltou só num destino ignorado, não bloqueia
  let completo = true;

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
      if (filtroArquivo && !filtroArquivo(rel)) { foraDoFiltro.push(rel); continue; }
      arquivos.push(rel);
      for (let i = 0; i < destinos.length; i++) {
        if (!(await existe(path.win32.join(destinos[i], rel)))) {
          if (ignorarIdx.includes(i)) faltandoIgnorado.push({ rel, destinoIdx: i });
          else completo = false;
        }
      }
    }
  }
  await andar('');
  return { completo, arquivos, foraDoFiltro, faltandoIgnorado };
}

async function main() {
  const flags = parseFlags(process.argv);
  if (!flags.csvPath) throw new Error('uso: --csv=verificacao.csv [--exceto="EMPRESA 1,EMPRESA 2"] [--real]');

  const config = carregarConfig();
  const linhas = await carregarCsv(flags.csvPath);
  const excetoSet = new Set(flags.exceto.map(normalizar));

  const alvos = linhas.filter(l => l.OK === 'true' && !excetoSet.has(normalizar(l.Empresa)));
  const ignorarIdx = flags.ignorarDestino.map(n => DESTINO_IDX[n]).filter(i => i !== undefined);
  console.log(`[excluir] modo: ${flags.real ? 'REAL (vai apagar)' : 'SIMULAÇÃO (--real pra executar de verdade)'}`);
  console.log(`[excluir] ${alvos.length} sub-pasta(s) de origem candidatas (${linhas.filter(l => l.OK === 'true').length} confirmadas no total, ${flags.exceto.length} empresa(s) excetuada(s))`);
  if (ignorarIdx.length) console.log(`[excluir] destino(s) ignorado(s) na conferência (decisão pontual, aceita lacuna conhecida): ${flags.ignorarDestino.join(', ')}`);

  let totalApagados = 0, totalPulados = 0, totalErros = 0;
  const log = [];

  for (const l of alvos) {
    const nome = l.Empresa, bloco = l.Bloco, origem = l.Origem;
    const pastaEmpresa = nomePastaSeguro(nome);
    const driveBase = config.destinos.driveBasePorFaixa[l.Faixa];
    const backupBase = config.destinos.backupDesktopBasePorFaixa[l.Faixa];
    const destinosEmpresa = [
      path.win32.join(config.destinos.localBase, pastaEmpresa),
      path.win32.join(driveBase, pastaEmpresa),
      path.win32.join(backupBase, pastaEmpresa),
    ];
    const S = config.subpastas;
    const segPorBloco = {
      '2024': [S.ano2024], '2025': [S.ano2025], '2026': [S.ano2026],
      'Legalização': [S.legalizacao],
      'Certificado Digital': [S.legalizacao, S.certificadoDigital],
      'Sucesso do Cliente': [S.sucessoDoCliente],
    };
    const seg = segPorBloco[bloco];
    const filtro = bloco === 'Certificado Digital' ? SO_CERTIFICADO : null;
    const destinosBloco = destinosEmpresa.map(d => seg.length ? path.win32.join(d, ...seg) : d);

    try {
      const { completo, arquivos, foraDoFiltro, faltandoIgnorado } = await reconferir(origem, destinosBloco, filtro, ignorarIdx);
      if (!completo) {
        console.log(`[PULADO — mudou desde a verificação] ${nome} / ${bloco} — ${origem}`);
        totalPulados++;
        log.push({ nome, bloco, origem, acao: 'pulado', motivo: 'reconferência falhou agora' });
        continue;
      }
      if (!arquivos.length) {
        console.log(`[PULADO — vazio] ${nome} / ${bloco} — ${origem}`);
        totalPulados++;
        log.push({ nome, bloco, origem, acao: 'pulado', motivo: 'sem arquivos pra apagar' });
        continue;
      }
      if (foraDoFiltro.length) {
        console.log(`   [aviso] ${foraDoFiltro.length} arquivo(s) fora do filtro nessa pasta, nunca conferido(s), vai junto: ${foraDoFiltro.join('; ')}`);
      }
      if (faltandoIgnorado.length) {
        console.log(`   [aviso] lacuna conhecida e aceita em destino ignorado: ${faltandoIgnorado.map(f => `${f.rel} (${Object.keys(DESTINO_IDX)[f.destinoIdx]})`).join('; ')}`);
      }

      // Decisão do Reysner (2026-09-13): apaga a pasta INTEIRA da empresa
      // nesse bloco — inclusive Certificado Digital, junto com o .pfx/.p12.
      if (flags.real) {
        await fs.rm(longPath(origem), { recursive: true, force: false });
        console.log(`[APAGADO] ${nome} / ${bloco} — ${arquivos.length} arquivo(s) confirmado(s)${foraDoFiltro.length ? ` + ${foraDoFiltro.length} fora do filtro` : ''} — ${origem}`);
        log.push({ nome, bloco, origem, acao: 'apagado', arquivos: arquivos.length, foraDoFiltro: foraDoFiltro.length, faltandoIgnorado });
      } else {
        console.log(`[apagaria pasta inteira] ${nome} / ${bloco} — ${arquivos.length} arquivo(s) confirmado(s)${foraDoFiltro.length ? ` + ${foraDoFiltro.length} fora do filtro` : ''} — ${origem}`);
        log.push({ nome, bloco, origem, acao: 'simulado', arquivos: arquivos.length, foraDoFiltro: foraDoFiltro.length, faltandoIgnorado });
      }
      totalApagados++;
    } catch (e) {
      console.log(`[ERRO] ${nome} / ${bloco} — ${e.message}`);
      totalErros++;
      log.push({ nome, bloco, origem, acao: 'erro', motivo: e.message });
    }
  }

  console.log(`\n[excluir] ${flags.real ? 'apagadas' : 'simuladas'}: ${totalApagados} | pulados: ${totalPulados} | erros: ${totalErros}`);
  const logPath = (flags.csvPath.replace(/\.csv$/i, '')) + (flags.real ? '_apagados.json' : '_simulacao.json');
  await fs.writeFile(logPath, JSON.stringify(log, null, 2), 'utf8');
  console.log(`[excluir] log: ${logPath}`);
}

main().catch(e => { console.error('[excluir] ERRO FATAL:', e && e.stack || e); process.exit(2); });
