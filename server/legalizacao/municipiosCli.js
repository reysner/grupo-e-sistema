'use strict';

/**
 * Municípios (código IBGE de 7 dígitos) cujo alvará de FUNCIONAMENTO é lido do CLI — Certificado de Licenciamento Integrado
 * do VRE|Redesim SP (JUCESP) — salvo em PDF na pasta da Legalização ou baixado à mão da Consulta Pública (que tem reCAPTCHA).
 * EXCEÇÃO "até segunda ordem" do Reysner (20/09/2026): normalmente o funcionamento só vem da prefeitura/Redesim, nunca da pasta.
 * Todas estas cidades constam como `municipioConveniado: true` na API oficial do VRE (vredigital.jucesp.sp.gov.br/modulo-adm-api/municipio-conveniado).
 * Pra reverter: esvazie a lista.
 *
 * Atenção: a "DATA DE VALIDADE" do CLI é a MENOR validade entre os órgãos que o compõem (Prefeitura, Bombeiros, Vigilância…);
 * pode coincidir com a do AVCB/CLCB dos Bombeiros, e não com a do alvará municipal.
 */
const IBGES_CLI = new Set([
  '3550308', // São Paulo
  '3505708', // Barueri
  '3506102', // Bebedouro
  '3509502', // Campinas
  '3518701', // Guarujá
  '3543402', // Ribeirão Preto
  '3548807', // São Caetano do Sul
  '3530607', // Mogi das Cruzes
]);

// Outras cidades em que, por decisão do Reysner, o funcionamento também é lido da PASTA da Legalização (sem CLI):
//   Paracatu/MG (20/09/2026) — o portal de lá só tem login de contribuinte e o alvará é presencial; leitura em toda rodada.
//   Gouvelândia/GO (20/09/2026) — o portal Centi só mostra taxas pagas (hCaptcha), não a validade; funcionamento lido da pasta em toda rodada.
//   Araguari/MG (20/09/2026) — o portal do cidadão não tem consulta pública de alvará; acompanhado pela pasta em toda rodada.
const IBGES_PASTA_SEM_CLI = new Set(['3147006', '5209150', '3103504', '3118601']); // Paracatu/MG, Gouvelândia/GO, Araguari/MG, Contagem/MG

/** Cidades em que lerAlvarasPasta.js lê o funcionamento da pasta (CLI + as de IBGES_PASTA_SEM_CLI). */
const IBGES_FUNCIONAMENTO_PELA_PASTA = new Set([...IBGES_CLI, ...IBGES_PASTA_SEM_CLI]);

module.exports = { IBGES_CLI, IBGES_PASTA_SEM_CLI, IBGES_FUNCIONAMENTO_PELA_PASTA };
