'use strict';

/**
 * Descobre o MUNICÍPIO e a UF de um CNPJ (dado cadastral público da Receita). O Acessórias só traz
 * o estado, não a cidade — e a cidade é o que decide em QUAL prefeitura buscar o alvará de
 * funcionamento/sanitário (hoje só Uberlândia-MG tem consulta automática; ver ciclo7Uberlandia.js).
 *
 * Fontes abertas, na ordem: BrasilAPI e, se falhar, Minha Receita. Cada estabelecimento (matriz ou
 * filial) tem o seu CNPJ e pode estar em cidade diferente — por isso a consulta é por CNPJ completo.
 */

const FONTES = [
  (d) => `https://brasilapi.com.br/api/cnpj/v1/${d}`,
  (d) => `https://minhareceita.org/${d}`,
];

/** @returns {Promise<{municipio: string, uf: string, ibge: string|null}>} — lança erro se nenhuma fonte responder. */
async function consultarMunicipioCnpj(cnpj) {
  const d = String(cnpj || '').replace(/\D/g, '');
  if (d.length !== 14) throw new Error('CNPJ inválido — preciso dos 14 dígitos.');
  let ultimoErro = null;
  for (const url of FONTES) {
    try {
      const res = await fetch(url(d), { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
      if (!res.ok) { ultimoErro = new Error(`${res.status} em ${new URL(url(d)).hostname}`); continue; }
      const j = await res.json();
      const municipio = String(j.municipio || '').trim();
      if (!municipio) { ultimoErro = new Error('resposta sem município'); continue; }
      const ibge = j.codigo_municipio_ibge != null ? String(j.codigo_municipio_ibge) : null;
      return { municipio: municipio.toUpperCase(), uf: String(j.uf || '').trim().toUpperCase() || null, ibge };
    } catch (e) { ultimoErro = e; }
  }
  throw ultimoErro || new Error('nenhuma fonte respondeu');
}

module.exports = { consultarMunicipioCnpj };
