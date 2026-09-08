'use strict';
/**
 * Diagnóstico: mostra, pra cada pasta-origem/destino do config,
 *   - se o caminho existe e dá pra listar
 *   - quantas subpastas tem
 *   - (com --empresa="...") os nomes de subpasta mais parecidos com o alvo
 *
 *   node server/arquivoMorto/diag.js --empresa="RAZAO SOCIAL"
 */

const fsp = require('fs/promises');
const { carregarConfig } = require('./config');
const { normalizar, faixaDeLetra } = require('./nomes');
const { longPath } = require('./copiador');

const arg = process.argv.slice(2).find(a => a.startsWith('--empresa='));
const empresa = arg ? arg.slice(10).replace(/^["']|["']$/g, '') : null;
const alvo = empresa ? normalizar(empresa) : null;
const tokensAlvo = alvo ? alvo.split(' ').filter(t => t.length >= 2) : [];

async function inspecionar(rotulo, dir) {
  let nomes;
  try {
    const ents = await fsp.readdir(longPath(dir), { withFileTypes: true });
    nomes = ents.filter(e => e.isDirectory()).map(e => e.name);
  } catch (e) {
    console.log(`\n[${rotulo}]\n  ${dir}\n  ❌ ${e.code || ''} ${e.message}`);
    return;
  }
  console.log(`\n[${rotulo}]\n  ${dir}\n  ✅ ${nomes.length} subpasta(s)`);
  if (alvo) {
    const exato = nomes.filter(n => normalizar(n) === alvo);
    if (exato.length) { console.log(`  🎯 match exato: ${exato.join(' | ')}`); return; }
    const parecidos = nomes
      .map(n => ({ n, nn: normalizar(n) }))
      .filter(x => tokensAlvo.some(t => x.nn.includes(t)))
      .slice(0, 12);
    if (parecidos.length) {
      console.log('  ~ parecidos:');
      for (const p of parecidos) console.log(`      "${p.n}"`);
    } else {
      console.log('  (nenhuma subpasta parecida)');
    }
  } else {
    for (const n of nomes.slice(0, 5)) console.log(`      ex.: "${n}"`);
  }
}

(async () => {
  const c = carregarConfig();
  if (empresa) console.log(`Alvo: "${empresa}"  ->  normalizado: "${alvo}"  ->  faixa: "${faixaDeLetra(alvo)}"`);

  console.log('\n==================== ORIGENS ====================');
  for (let i = 0; i < c.origens.ano2024.length; i++) await inspecionar(`2024 [${i}]`, c.origens.ano2024[i]);
  for (const d of c.origens.ano2025) await inspecionar('2025', d);
  for (const d of c.origens.ano2026) await inspecionar('2026', d);
  await inspecionar('LEGALIZACAO', c.origens.legalizacao);
  await inspecionar('CERTIFICADOS PJ', c.origens.certificadosPj);
  await inspecionar('SUCESSO DO CLIENTE', c.origens.sucessoDoCliente);

  console.log('\n==================== DESTINOS ====================');
  await inspecionar('Destino local', c.destinos.localBase);
  for (const [faixa, dir] of Object.entries(c.destinos.driveBasePorFaixa)) await inspecionar(`Destino Drive ${faixa}`, dir);
})().catch(e => { console.error(e); process.exit(1); });
