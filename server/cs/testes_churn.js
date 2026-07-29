'use strict';
/**
 * Testes do detector de sinais de churn nas conversas do Zappy (ver
 * FRASES_CHURN / detectarSinalChurn em slaEngine.js). Frase-chave composta
 * (não palavra solta) pra não disparar em mensagem de rotina tipo "deu erro
 * no boleto". Calibrado com o exemplo real da Thais.
 * Rodar: node testes_churn.js
 */
const { detectarSinalChurn } = require('./slaEngine');

let ok = 0, falhou = 0;
function checa(nome, obtido, esperado) {
  const passou = obtido === esperado;
  console.log(`${passou ? '✅' : '❌'} ${nome}`);
  if (!passou) console.log(`     esperado: ${JSON.stringify(esperado)}\n     obtido:   ${JSON.stringify(obtido)}`);
  passou ? ok++ : falhou++;
}
function bateu(nome, texto) {
  checa(nome, detectarSinalChurn(texto) !== null, true);
}
function naoBateu(nome, texto) {
  checa(nome, detectarSinalChurn(texto), null);
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(' CHURN — detecção de sinais nas mensagens do cliente (Zappy)');
console.log('═══════════════════════════════════════════════════════════════\n');

// ── Exemplo real da Thais ────────────────────────────────────────────────
bateu(
  'Exemplo da Thais: "já não aguento tanto erros, vou procurar outra contabilidade, vocês erram demais"',
  'Já não aguento tanto erros, vou procurar outra contabilidade, vocês erram demais.'
);

// ── Casos que DEVEM bater ────────────────────────────────────────────────
bateu('"Vou trocar de contador" bate', 'Vou trocar de contador, cansei.');
bateu('"quero cancelar" bate', 'Quero cancelar meu contrato com vocês.');
bateu('"pessimo atendimento" bate (sem acento)', 'Isso é um pessimo atendimento.');
bateu('"nao aguento mais" bate', 'Não aguento mais esperar resposta.');
bateu('Acentuação não atrapalha (NFD)', 'Vou procurar outra contabilidade, é sério.');

// ── Caso real testado pela Thais numa conversa do Zappy (ticket #46125) ──
bateu(
  'Caso real (ticket Zappy #46125): "Estou cansado dos erros de vocês"',
  'Estou cansado dos erros de vocês'
);
bateu('"cansada dos erros" (variação feminina) bate', 'Estou cansada dos erros, viu?');

// ── Caso real testado pela Thais (ticket #46128): frustração crônica ────
bateu(
  'Caso real (ticket Zappy #46128): "Todo mês tenho que pedir a mesma coisa"',
  'Todo mês tenho que pedir a mesma coisa'
);

// ── Ampliação: intenção de trocar (variações mais suaves) ───────────────
bateu('"pensando em trocar de contador" bate', 'Estou pensando em trocar de contador, viu.');
bateu('"não pretendo renovar" bate', 'Não pretendo renovar o contrato esse ano.');
bateu('"quero falar com o responsável" bate', 'Quero falar com o responsável sobre isso.');
bateu('"vou reclamar no reclame aqui" bate', 'Se não resolver, vou reclamar no reclame aqui.');

// ── Ampliação: frustração crônica / "sempre a mesma coisa" ──────────────
bateu('"sempre a mesma coisa" bate', 'É sempre a mesma coisa com vocês.');
bateu('"nunca está pronto" bate', 'Nunca está pronto no prazo combinado.');
bateu('"de saco cheio" bate', 'Já estou de saco cheio disso.');
bateu('"toda vez tenho que cobrar" bate', 'Toda vez tenho que cobrar pra terem uma resposta.');

// ── Casos reais testados pela Thais (mensagens que passaram batido) ─────
bateu(
  'Caso real: "Como sempre vocês errando denovo"',
  'Como sempre vocês errando dinovo'
);
bateu(
  'Caso real (ticket Zappy #46449): culpar o escritório por multa em guia',
  'Recebi algumas guias de competência anteriores e estão me cobrando multas, não é possível! Isso são erros de vocês, quem vão pagar essas multas?'
);

// ── Casos que NÃO devem bater (evitar falso positivo em mensagem de rotina) ──
naoBateu('"deu erro no boleto" NÃO bate (erro sozinho não conta)', 'Deu erro no boleto, pode verificar?');
naoBateu('"ruim" sozinho NÃO bate', 'O sistema tá meio ruim hoje.');
naoBateu('Mensagem neutra NÃO bate', 'Bom dia, poderia me enviar o boleto de julho?');
naoBateu('Mensagem de elogio NÃO bate', 'Muito obrigada, adorei o atendimento de vocês!');
naoBateu('Pedido de rotina (mensal) NÃO bate', 'Preciso do boleto desse mês, por favor.');
naoBateu('Pergunta sobre prazo NÃO bate', 'Vocês sabem me dizer quando fica pronto?');
naoBateu('Elogio ao responsável NÃO bate', 'Parabéns pelo profissionalismo da equipe.');
naoBateu('Texto vazio NÃO bate', '');
naoBateu('Texto nulo NÃO bate', null);

console.log(`\n${ok} passaram, ${falhou} falharam.\n`);
process.exit(falhou ? 1 : 0);
