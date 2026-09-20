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

/** @returns {Promise<{municipio: string, uf: string, ibge: string|null, cnaes: {codigo: string, descricao: string, principal: boolean}[]}>} — lança erro se nenhuma fonte responder. */
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
      // CNAEs do cartão CNPJ (principal + secundários) — base pra saber se a atividade exige alvará sanitário (sanitario.js).
      const cod = (c) => String(c).padStart(7, '0');
      const cnaes = [];
      if (j.cnae_fiscal) cnaes.push({ codigo: cod(j.cnae_fiscal), descricao: String(j.cnae_fiscal_descricao || ''), principal: true });
      (j.cnaes_secundarios || []).forEach((c) => { if (c && c.codigo) cnaes.push({ codigo: cod(c.codigo), descricao: String(c.descricao || ''), principal: false }); });
      return { municipio: municipio.toUpperCase(), uf: String(j.uf || '').trim().toUpperCase() || null, ibge, cnaes };
    } catch (e) { ultimoErro = e; }
  }
  throw ultimoErro || new Error('nenhuma fonte respondeu');
}

module.exports = { consultarMunicipioCnpj };
