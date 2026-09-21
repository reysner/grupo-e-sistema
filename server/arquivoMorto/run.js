'use strict';
/**
 * Entrypoint do job "Arquivar empresas inativas" (Modelo 01).
 *
 *   node server/arquivoMorto/run.js [flags]
 *
 * Flags:
 *   --dry-run              não escreve nada, não manda e-mail (só mostra o que faria)
 *   --desde=AAAA-MM-DD     sobrescreve a data de corte do .env
 *   --empresa="RAZÃO"      processa só essa empresa e ignora o estado
 *   --empresas="RAZÃO 1,RAZÃO 2"   idem, mas várias de uma vez (separadas por vírgula)
 *   --cnpj=00.000.000/0001-00   idem, por CNPJ
 *   --sem-email            roda normal mas não envia o resumo
 *
 * Agendador de Tarefas do Windows: rodar 20:00, "somente quando o usuário
 * estiver conectado" (o H: do Google Drive para Desktop só existe na sessão
 * interativa). Ver README.md.
 */

const { carregarConfig } = require('./config');
const pipeline = require('./pipeline');
const relatorio = require('./relatorio');

function parseFlags(argv) {
  const o = { dryRun: false, semEmail: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--sem-email') o.semEmail = true;
    else if (a.startsWith('--desde=')) o.desde = a.slice(8).trim();
    else if (a.startsWith('--empresa=')) o.empresaFiltro = a.slice(10).replace(/^["']|["']$/g, '');
    else if (a.startsWith('--empresas=')) o.empresasFiltro = a.slice(11).replace(/^["']|["']$/g, '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--cnpj=')) o.cnpjFiltro = a.slice(7).trim();
    else console.warn(`[arquivoMorto] flag ignorada: ${a}`);
  }
  return o;
}

async function main() {
  const flags = parseFlags(process.argv);
  const config = carregarConfig();

  const t0 = Date.now();
  console.log(`[arquivoMorto] início ${new Date().toISOString()}${flags.dryRun ? ' (DRY-RUN)' : ''}`);
  console.log(`[arquivoMorto] corte: Cliente até >= ${flags.desde || config.desde}`);

  const rel = await pipeline.rodar(config, flags);

  console.log(`[arquivoMorto] ${rel.total} inativa(s) · ${rel.puladas} já ok · ${rel.processadas.length} processada(s) · ${Math.round((Date.now() - t0) / 1000)}s`);
  for (const p of rel.processadas) {
    console.log(`  - ${p.nome} [${p.status}] faixa ${p.faixa} · ${p.totais.copiados} copiado(s), ${p.totais.jaExistiam} já existia(m)`);
  }
  if (rel.naoLocalizadas.length) console.log(`[arquivoMorto] não localizadas: ${rel.naoLocalizadas.map(n => n.nome).join(', ')}`);
  if (rel.comAmbiguidade.length) console.log(`[arquivoMorto] ambíguas: ${rel.comAmbiguidade.map(n => n.nome).join(', ')}`);
  if (rel.erros.length) console.log(`[arquivoMorto] com erro: ${rel.erros.map(n => n.nome).join(', ')}`);

  if (!flags.dryRun && !flags.semEmail) {
    try {
      const ok = await relatorio.enviarResumo(rel, config.email);
      console.log(`[arquivoMorto] resumo por e-mail: ${ok ? 'enviado a ' + config.email.to : 'não enviado'}`);
    } catch (e) {
      console.error(`[arquivoMorto] falha ao enviar resumo: ${e.message}`);
    }
  }

  // exit code: 0 se tudo ok/nada a fazer; 1 se houve erro ou ambiguidade a resolver
  const problema = rel.erros.length > 0 || rel.comAmbiguidade.length > 0;
  process.exit(problema ? 1 : 0);
}

main().catch(e => {
  console.error('[arquivoMorto] ERRO FATAL:', e && e.stack || e);
  // `fetch failed` esconde o motivo real no .cause — mostra (ex.: ENOTFOUND,
  // ECONNRESET, timeout na API do Acessórias, proxy corporativo bloqueando).
  for (let c = e && e.cause; c; c = c.cause) {
    console.error('  causa:', c && (c.stack || c.message || c));
  }
  process.exit(2);
});
