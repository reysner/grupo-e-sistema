'use strict';

/**
 * Certificado PF (e-CPF) que veio da CertiSeguro mas não está ligado a nenhum cliente aparece como linha avulsa "sem cadastro".
 * Muitas vezes é a MESMA pessoa de um cliente cadastrado com o documento em outro formato: o CPF (11 dígitos) ou o CAEPF do produtor rural
 * (CPF + sufixo, 14 dígitos que não são um CNPJ válido — ex.: CPF 062.787.636-64 e CAEPF 062.787.636/001-19). Pedido do Reysner (20/10/2026).
 * Aqui o certificado PF é movido para a linha do cliente de mesmo CPF (ou mesma raiz de CPF), e a linha avulsa some.
 * Função pura, testada em server/testes_saude_rotinas.js.
 */

const soDigitos = (s) => String(s || '').replace(/\D/g, '');

function cnpjValido(d) {
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const dv = (n) => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += +d[i] * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === +d[12] && dv(13) === +d[13];
}

/** Chaves de CPF pelas quais um cliente pode ser achado: o CPF inteiro (11 dígitos) ou a raiz de 9 dígitos de um CAEPF (14 dígitos, DV de CNPJ inválido). */
function chaveCpf(doc) {
  const d = soDigitos(doc);
  if (d.length === 11) return { tipo: 'cpf', chave: d };
  if (d.length === 14 && !cnpjValido(d)) return { tipo: 'caepf', chave: d.slice(0, 9) };
  return null;
}

/** @param {object[]} linhas linhas do painel (legalPainelLinha + cnpj/codigo). @returns {object[]} as mesmas linhas, com PF casados e sem as avulsas casadas. */
function casarCertificadosPF(linhas) {
  const lista = Array.isArray(linhas) ? linhas : [];
  const porCpf = new Map(), porRaiz = new Map();
  const guardar = (mapa, k, l) => { if (!mapa.has(k)) mapa.set(k, []); mapa.get(k).push(l); };
  lista.forEach((l) => {
    if (l.sem_cadastro_acessorias) return;
    const k = chaveCpf(l.cnpj);
    if (!k) return;
    guardar(k.tipo === 'cpf' ? porCpf : porRaiz, k.chave, l);
    if (k.tipo === 'cpf') guardar(porRaiz, k.chave.slice(0, 9), l);   // o CPF também responde pela raiz (um CAEPF do mesmo produtor pode ter o certificado)
  });
  const semCertUtil = (l) => !l.cert || l.cert.status === 'sem_data';   // não pisa em certificado que já tem data
  const remover = new Set();
  lista.forEach((o) => {
    if (!o.sem_cadastro_acessorias || !o.cert || o.cert.tipo !== 'pf') return;
    const cpf = soDigitos(o.cnpj);
    if (cpf.length !== 11) return;
    const candidatos = [...(porCpf.get(cpf) || []), ...(porRaiz.get(cpf.slice(0, 9)) || [])].filter((l, i, a) => a.indexOf(l) === i && semCertUtil(l));
    if (!candidatos.length) return;
    // prefere o cadastro do Acessórias (tem código); depois o que tem CAEPF/CPF mais "oficial"
    candidatos.sort((a, b) => (b.codigo ? 1 : 0) - (a.codigo ? 1 : 0));
    const alvo = candidatos[0];
    alvo.cert = Object.assign({}, o.cert, { casado_por_cpf: true });
    remover.add(o);
  });
  return lista.filter((l) => !remover.has(l));
}

module.exports = { casarCertificadosPF, cnpjValido, chaveCpf };
