'use strict';
const D = require('./depara');

let ok = 0, falhou = 0;
function checa(nome, obtido, esperado) {
  const passou = JSON.stringify(obtido) === JSON.stringify(esperado);
  console.log(`${passou ? '✅' : '❌'} ${nome}`);
  if (!passou) console.log(`     esperado: ${JSON.stringify(esperado)}  |  obtido: ${JSON.stringify(obtido)}`);
  passou ? ok++ : falhou++;
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log(' TELEFONE');
console.log('═══════════════════════════════════════════════════════════');
checa('55+DDD já ok', D.normalizarTelefone('5534999936413'), '5534999936413');
checa('com máscara', D.normalizarTelefone('(34) 99993-6413'), '5534999936413');
checa('sem DDI (11 díg)', D.normalizarTelefone('34999936413'), '5534999936413');
checa('sem DDI (10 díg)', D.normalizarTelefone('3433006835'), '553433006835');
checa('vazio', D.normalizarTelefone(''), null);

console.log('\n═══════════════════════════════════════════════════════════');
console.log(' EXTRAÇÃO DE EMPRESA DO NOME');
console.log('═══════════════════════════════════════════════════════════');
checa('pós-hífen', D.candidatosEmpresa('Jose Ricardo - Emporio Siqueira'),
  ['Emporio Siqueira', 'Jose Ricardo', 'Jose Ricardo - Emporio Siqueira']);
checa('sem hífen', D.candidatosEmpresa('8M Administracao de Imoveis Ltda'),
  ['8M Administracao de Imoveis Ltda']);

console.log('\n═══════════════════════════════════════════════════════════');
console.log(' SIMILARIDADE (0-100)');
console.log('═══════════════════════════════════════════════════════════');
console.log('  "Emporio Siqueira" x "EMPORIO SIQUEIRA LTDA":', D.similaridade('Emporio Siqueira','EMPORIO SIQUEIRA LTDA'));
console.log('  "Comercial Samsara" x "SAMSARA COMERCIO DE ROUPAS":', D.similaridade('Comercial Samsara','SAMSARA COMERCIO DE ROUPAS'));
console.log('  "MARANHÃO LANCHES" x "MARANHAO LANCHES EIRELI":', D.similaridade('MARANHÃO LANCHES','MARANHAO LANCHES EIRELI'));
console.log('  "8M Administracao" x "8M ADMINISTRACAO DE IMOVEIS":', D.similaridade('8M Administracao de Imoveis','8M ADMINISTRACAO DE IMOVEIS LTDA'));
console.log('  "Emporio Siqueira" x "PADARIA CENTRAL" (deve ser baixo):', D.similaridade('Emporio Siqueira','PADARIA CENTRAL'));

console.log('\n═══════════════════════════════════════════════════════════');
console.log(' MATCHER COMPLETO (caso real)');
console.log('═══════════════════════════════════════════════════════════\n');

// Carteira simulada (na vida real vem da tabela clientes)
const carteira = [
  { id: 'C1', nome_empresa: 'EMPORIO SIQUEIRA LTDA', cnpj: '11.111.111/0001-11' },
  { id: 'C2', nome_empresa: 'MARANHAO LANCHES EIRELI', cnpj: '22.222.222/0001-22' },
  { id: 'C3', nome_empresa: '8M ADMINISTRACAO DE IMOVEIS LTDA', cnpj: '33.333.333/0001-33' },
  { id: 'C4', nome_empresa: 'PADARIA CENTRAL DE UBERLANDIA', cnpj: '44.444.444/0001-44' },
];

// Contato real 1: "Jose Ricardo - Emporio Siqueira", tag Escritorial
const r1 = D.sugerirVinculo(
  { nome: ' Jose Ricardo - Emporio Siqueira ', telefone: '5534999963989', tags: 'Escritorial, Hands' },
  carteira
);
console.log('Contato: "Jose Ricardo - Emporio Siqueira"');
console.log('  telefone normalizado:', r1.telefone);
console.log('  is_escritorial:', r1.is_escritorial);
console.log('  sugestões:', r1.sugestoes.map(s => `${s.nome_empresa} (${s.confianca}%)`).join(' · ') || '(nenhuma)');
console.log('');
checa('Casou com EMPORIO SIQUEIRA', r1.sugestoes[0]?.cliente_id, 'C1');
checa('É candidato a cliente (tag Escritorial)', r1.is_escritorial, true);

// Contato real 2: "MARLISON - MARANHÃO LANCHES"
const r2 = D.sugerirVinculo(
  { nome: ' MARLISON - MARANHÃO LANCHES', telefone: '5534988270146', tags: 'Escritorial, Hands' },
  carteira
);
console.log('Contato: "MARLISON - MARANHÃO LANCHES"');
console.log('  sugestões:', r2.sugestoes.map(s => `${s.nome_empresa} (${s.confianca}%)`).join(' · ') || '(nenhuma)');
console.log('');
checa('Casou com MARANHAO LANCHES (apesar do acento)', r2.sugestoes[0]?.cliente_id, 'C2');

// Contato real 3: "8M Administracao de Imoveis Ltda" (empresa é o nome todo)
const r3 = D.sugerirVinculo(
  { nome: '8M Administracao de Imoveis Ltda', telefone: '5534999428630', tags: 'Escritorial' },
  carteira
);
console.log('Contato: "8M Administracao de Imoveis Ltda"');
console.log('  sugestões:', r3.sugestoes.map(s => `${s.nome_empresa} (${s.confianca}%)`).join(' · ') || '(nenhuma)');
console.log('');
checa('Casou com 8M ADMINISTRACAO', r3.sugestoes[0]?.cliente_id, 'C3');

// Contato 4: pessoa física sem empresa clara, sem match bom
const r4 = D.sugerirVinculo(
  { nome: 'Adelmar Ferreira', telefone: '5534996680245', tags: 'Escritorial' },
  carteira
);
console.log('Contato: "Adelmar Ferreira" (pessoa física, sem empresa na carteira)');
console.log('  sugestões:', r4.sugestoes.map(s => `${s.nome_empresa} (${s.confianca}%)`).join(' · ') || '(nenhuma)');
console.log('');
checa('Sem sugestão forte (fica pra confirmação manual)', r4.sugestoes.length, 0);

console.log('═══════════════════════════════════════════════════════════');
console.log(` RESULTADO: ${ok} passaram · ${falhou} falharam`);
console.log('═══════════════════════════════════════════════════════════\n');
process.exit(falhou > 0 ? 1 : 0);
