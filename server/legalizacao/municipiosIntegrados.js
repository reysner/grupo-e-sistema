'use strict';

/**
 * Municípios com consulta AUTOMÁTICA de alvará (chave = código IBGE, o mesmo de clientes.municipio_ibge).
 * Cada consulta devolve o formato de ciclo7Uberlandia.js (funcionamento/sanitario/vencimentoEncontrado/erros).
 * Cidade nova: crie o módulo, registre aqui e ela entra sozinha na fila do consultarAlvarasLocal.js.
 */
const MUNICIPIOS_INTEGRADOS = {
  '3170206': { nome: 'Uberlândia/MG', consultar: (cnpj) => require('./ciclo7Uberlandia').consultarAlvaraUberlandia(cnpj) },
  '3170107': { nome: 'Uberaba/MG', consultar: (cnpj) => require('./uberaba').consultarAlvaraUberaba(cnpj) },
  '3106200': { nome: 'Belo Horizonte/MG', consultar: (cnpj) => require('./belohorizonte').consultarAlvaraBeloHorizonte(cnpj) },
};

module.exports = { MUNICIPIOS_INTEGRADOS, IBGES_INTEGRADOS: Object.keys(MUNICIPIOS_INTEGRADOS) };
