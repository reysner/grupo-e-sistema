'use strict';
/**
 * Módulo Sucesso do Cliente — Máquina dos 5 Relógios (motor de SLA)
 * ------------------------------------------------------------------
 * Recebe a timeline de um ticket (eventos + mensagens) e calcula os 5 relógios,
 * usando SEMPRE tempo útil (tempoUtil.js). Zero IA.
 *
 * Formato de entrada (genérico — independente do Zappy):
 * {
 *   id, telefone, empresa_texto, departamento, analista, status,
 *   eventos:   [ { tipo, hora }, ... ]  // tipo: 'abertura'|'aceite'|'transferencia'|'encerramento'|'reabertura'
 *   mensagens: [ { hora, remetente, texto }, ... ]  // remetente: 'cliente' | 'escritorio'
 * }
 * (horas em ISO string ou Date)
 *
 * Quando o JSON real do Zappy chegar, escreve-se apenas um "tradutor"
 * (adaptador) que converte o formato deles neste formato genérico.
 */
const T = require('./tempoUtil');

const ROTULOS = {
  aceite: 'Aceite da recepção',
  transferencia: 'Transferência',
  departamento: 'Início no departamento',
  promessa: 'Promessa de transferência não cumprida',
  promessa_resolucao: 'Resolvendo direto (sem transferir)',
  vez_cliente: 'Cliente aguardando resposta',
};

/**
 * Frases (normalizadas, sem acento) que indicam que quem respondeu está
 * avisando que VAI TRANSFERIR o atendimento — em vez de resolver a demanda
 * diretamente. Lista calibrada com exemplos reais de como o time escreve
 * (ver conversa com a Thais). Casamento é por trecho (substring), então
 * pequenas variações de frase ainda batem.
 */
const FRASES_TRANSFERENCIA = [
  'vou te transferir',
  'vou transferir',
  'vou te direcionar',
  'vou direcionar',
  'vou te enviar',
  'vou enviar voce',
  'vou encaminhar',
  'vou conectar',
  'so um momento',
  'so um instante',
  'um momento, por gentileza',
  'analista responsavel dara continuidade',
  'responsavel por essa demanda',
  'dara continuidade ao seu atendimento',
  'especialista dara sequencia',
  'equipe responsavel assumira',
  'enquanto realizo a transferencia',
  'enquanto direciono',
  'em instantes voce sera atendido',
  'sera atendido pelo analista',
  'setor responsavel',
];

/**
 * Frases (normalizadas) que indicam que o escritório pediu algo AO CLIENTE
 * (documento, comprovante, confirmação, pagamento) e agora depende da
 * resposta/ação dele pra seguir — diferente de "vou analisar e te retorno",
 * onde quem deve a próxima ação ainda é o próprio analista. Essa distinção
 * importa pro relógio 'promessa_resolucao': ticket #46223 (Thais) mostrou
 * que contar o tempo de espera pelo cliente contra o prazo do analista é
 * injusto — ele não tem como resolver sem o cliente se posicionar.
 */
const FRASES_AGUARDANDO_CLIENTE = [
  'me encaminhe', 'me envie', 'me mande', 'nos envie', 'nos encaminhe', 'nos mande',
  'poderia enviar', 'poderia me enviar', 'poderia nos enviar', 'poderia encaminhar',
  'peco que', 'pedimos que', 'solicito que', 'solicitamos que',
  'poderia confirmar', 'poderia me confirmar', 'pode me confirmar', 'pode confirmar',
  'aguardo o comprovante', 'aguardo seu retorno', 'aguardo retorno',
  'aguardamos o retorno', 'aguardamos seu retorno', 'aguardamos a confirmacao',
  'fico no aguardo', 'ficamos no aguardo', 'ficamos no aguardo do',
  'apos o pagamento', 'apos o envio', 'apos a confirmacao',
  'precisamos que voce', 'preciso que voce', 'necessario que envie',
  'por gentileza, envie', 'por gentileza envie', 'favor enviar', 'favor confirmar', 'favor encaminhar',
  'assim que possivel, envie', 'assim que efetuar o pagamento',
];

function normalizarTexto(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** true se o texto parece avisar que a pessoa VAI TRANSFERIR (em vez de resolver direto). */
function pareceIntencaoTransferir(texto) {
  const t = normalizarTexto(texto);
  if (!t) return false;
  return FRASES_TRANSFERENCIA.some(frase => t.includes(frase));
}

/** true se o texto parece estar pedindo algo do CLIENTE (documento/pagamento/confirmação). */
function pareceAguardandoCliente(texto) {
  const t = normalizarTexto(texto);
  if (!t) return false;
  return FRASES_AGUARDANDO_CLIENTE.some(frase => t.includes(frase));
}

/**
 * Frases (normalizadas, sem acento) que indicam que o CLIENTE está
 * sinalizando risco de cancelamento OU má experiência forte — intenção
 * explícita de trocar de contabilidade, frustração crônica ("sempre a
 * mesma coisa"), ameaça de reclamar em outro lugar, etc. São frases de
 * várias palavras (não palavras soltas tipo "erro" ou "ruim") de
 * propósito: mensagem de chat do dia a dia é muito mais barulhenta que
 * comentário de pesquisa (ex.: "deu erro no boleto" é rotina, não é
 * sinal de churn) — casar só frase composta reduz falso positivo. Lista
 * grande de propósito (mais variações = menos chance de passar batido),
 * e o botão "Tratar" no painel cobre os falsos positivos que passarem.
 * Calibrada com exemplos reais da Thais testados em conversas do Zappy:
 * "já não aguento tanto erros, vou procurar outra contabilidade, vocês
 * erram demais", "Estou cansado dos erros de vocês", "Todo mês tenho
 * que pedir a mesma coisa", "Como sempre vocês errando denovo" (ticket
 * onde o Reysner reclamou de erro recorrente) e "Isso são erros de
 * vocês, quem vão pagar essas multas?" (ticket #46449 — cliente culpando
 * o escritório por multa em guia de competência anterior).
 */
const FRASES_CHURN = [
  // ── Intenção explícita de trocar/cancelar/sair ──────────────────────────
  'vou procurar outra contabilidade',
  'vou procurar outro contador',
  'vou procurar outra empresa de contabilidade',
  'vou procurar outro escritorio',
  'procurar outra contabilidade',
  'procurar outro contador',
  'procurando outro contador',
  'procurando outra contabilidade',
  'pesquisando outras contabilidades',
  'pesquisando outros contadores',
  'vou trocar de contabilidade',
  'vou trocar de contador',
  'quero trocar de contador',
  'quero trocar de contabilidade',
  'pensando em trocar de contador',
  'pensando em trocar de contabilidade',
  'avaliando trocar de contador',
  'avaliando trocar de contabilidade',
  'trocar de contabilidade',
  'trocar de contador',
  'quero cancelar',
  'vou cancelar',
  'quero encerrar o contrato',
  'vou encerrar o contrato',
  'quero encerrar a parceria',
  'vou encerrar a parceria',
  'quero finalizar o contrato',
  'vou finalizar o contrato',
  'quero rescindir',
  'vou rescindir',
  'quero me desligar',
  'quero desligar',
  'quero sair dessa contabilidade',
  'vou sair dessa contabilidade',
  'quero sair da contabilidade de voces',
  'nao quero mais ser cliente',
  'nao quero mais continuar com voces',
  'nao quero mais trabalhar com voces',
  'nao vou continuar com voces',
  'nao pretendo renovar',
  'nao vou renovar o contrato',
  'nao vou renovar com voces',
  'outro contador vai fazer melhor',
  'outra contabilidade faz melhor',
  'outros escritorios fazem melhor',
  'outras contabilidades sao melhores',
  // ── Frustração crônica / "sempre a mesma coisa" (padrão repetitivo) ─────
  'nao aguento mais',
  'ja nao aguento',
  'ja nao aguento mais isso',
  'erram demais',
  'erram muito',
  'tanto erro',
  'muito erro',
  'cansei de erro',
  'cansado de tanto erro',
  'cansada de tanto erro',
  'cansado dos erros',
  'cansada dos erros',
  'cansado com os erros',
  'cansada com os erros',
  'cansado de tantos erros',
  'cansada de tantos erros',
  'estou cansado de voces',
  'estou cansada de voces',
  'cansei disso',
  'cansada disso',
  'cansado disso',
  'cansei de pedir',
  'cansada de pedir',
  'cansado de pedir',
  'cansei de cobrar',
  'cansada de cobrar',
  'cansado de cobrar',
  'de saco cheio',
  'chega de erro',
  'chega desses erros',
  'basta de erro',
  'sempre um problema',
  'sempre o mesmo problema',
  'sempre a mesma coisa',
  'sempre a mesma reclamacao',
  'toda hora um erro',
  'toda hora um problema',
  'todo mes a mesma coisa',
  'todo mes tenho que pedir',
  'toda vez tenho que pedir',
  'sempre tenho que pedir',
  'sempre tenho que cobrar',
  'toda vez tenho que cobrar',
  'toda vez preciso cobrar',
  'sempre preciso cobrar',
  'todo mes e a mesma coisa',
  'todo mes da problema',
  'toda vez da problema',
  'de novo a mesma coisa',
  'de novo essa mesma coisa',
  'outra vez a mesma coisa',
  'mais uma vez a mesma coisa',
  'nunca esta pronto',
  'nunca fica pronto',
  'nunca resolvem',
  'nunca vem certo',
  'sempre vem errado',
  'sempre sai errado',
  'vira e mexe da erro',
  'vira e mexe tem problema',
  'isso se repete toda hora',
  'isso se repete sempre',
  'descaso total',
  'descaso completo',
  'falta de profissionalismo',
  'pouco profissionalismo',
  // ── "Sempre... errando" / culpar a contabilidade pelo erro (ticket #46449 e
  // conversa "Como sempre vocês errando denovo") ──────────────────────────
  'sempre voces errando',
  'voces sempre errando',
  'sempre vcs errando',
  'vcs sempre errando',
  'errando de novo',
  'errando denovo',
  'errando dinovo',
  'erram de novo',
  'voces erram sempre',
  'isso sao erros de voces',
  'isso e erro de voces',
  'erro de voces',
  'erros de voces',
  'a culpa e de voces',
  'culpa de voces',
  'quem vai pagar essa multa',
  'quem vai pagar essas multas',
  'quem vao pagar essa multa',
  'quem vao pagar essas multas',
  'sempre errado',
  'calculado errado',
  'calculadas erradas',
  'guias erradas',
  // ── Insatisfação forte / recomendação negativa ──────────────────────────
  'pessimo atendimento',
  'atendimento pessimo',
  'nunca mais indico',
  'nao recomendo',
  'nao indico',
  'muito insatisfeito',
  'muito insatisfeita',
  'extremamente insatisfeito',
  'extremamente insatisfeita',
  'estou insatisfeito',
  'estou insatisfeita',
  'insatisfeito com essa situacao',
  'insatisfeita com essa situacao',
  'isso e um absurdo',
  'um absurdo isso',
  'e inaceitavel isso',
  'isso e inadmissivel',
  'estou decepcionado com voces',
  'estou decepcionada com voces',
  'me decepcionei com voces',
  'perdi a confianca',
  'nao confio mais',
  'nao tenho mais confianca',
  'perdi a paciencia',
  'estou perdendo a paciencia',
  // ── Ameaça de escalar / reclamar em outro lugar ─────────────────────────
  'vou reclamar no reclame aqui',
  'vou fazer uma reclamacao no procon',
  'vou no procon',
  'vou ao procon',
  'vou registrar uma reclamacao',
  'vou abrir uma reclamacao',
  'quero falar com o responsavel',
  'quero falar com o dono',
  'quero falar com o proprietario',
  'preciso falar com um superior',
  'vai parar no procon',
];

/**
 * Se o texto tiver algum sinal de churn, devolve a frase que bateu (útil
 * pra mostrar o motivo na tela); senão, devolve null. Casamento por
 * substring, então pequenas variações da frase ainda batem.
 */
function detectarSinalChurn(texto) {
  const t = normalizarTexto(texto);
  if (!t) return null;
  return FRASES_CHURN.find(frase => t.includes(frase)) || null;
}

/**
 * Palavras/expressões que sinalizam INSATISFAÇÃO, desespero, desrespeito,
 * reclamação de erro ou de juros/multa causados por erro do escritório —
 * mais ABRANGENTE de propósito que FRASES_CHURN. FRASES_CHURN é calibrada
 * pra pegar só quem sinaliza risco real de CANCELAMENTO (por isso usa
 * frases compostas, pra evitar alarme falso); aqui o objetivo é bem
 * diferente — pegar QUALQUER mensagem que cheire a cliente descontente,
 * mesmo sem intenção nenhuma de sair, pra alguém do time revisar (pedido da
 * Thais: "toda e qualquer mensagem de insatisfação, desespero, desrespeito,
 * erros, juros por multa, e similares acusem nele"). Por isso aceita
 * palavras soltas também, não só frases de várias palavras.
 *
 * Ampliada (pedido do Reysner: "infinitas possibilidades de captação de
 * erros e insatisfação") com mais categorias: demora/atraso explícito,
 * ameaça de ação legal/exposição pública, comparação negativa com
 * contador/contabilidade anterior, além de mais sinônimos nas categorias
 * que já existiam. Mesmo espírito de sempre: lista calibrada com
 * português real de reclamação de cliente, sem IA — o painel "Palavras
 * mais frequentes" do motor de motivo mostra o caminho de como continuar
 * calibrando com exemplo real em vez de adivinhar.
 */
const PALAVRAS_INSATISFACAO = [
  // ── Insatisfação / decepção genérica ────────────────────────────────────
  'insatisfeito', 'insatisfeita', 'descontente', 'desagradado', 'desagradada',
  'decepcionado', 'decepcionada', 'frustrado', 'frustrada', 'revoltado', 'revoltada',
  'indignado', 'indignada', 'irritado', 'irritada', 'chateado', 'chateada',
  'magoado', 'magoada', 'incomodado', 'incomodada',
  // variações e formas coloquiais de dizer a mesma coisa
  'nao satisfeito', 'nao satisfeita', 'nao estou satisfeito', 'nao estou satisfeita',
  'pouco satisfeito', 'pouco satisfeita', 'muito chateado', 'muito chateada',
  'super chateado', 'super chateada', 'bravo com isso', 'brava com isso',
  'de saco cheio disso', 'enchendo o saco', 'no limite da paciencia',
  'ate quando isso', 'quando isso vai parar', 'isso nao pode continuar assim',
  'cansei desse tipo de coisa', 'to decepcionado', 'to decepcionada',
  'to muito chateado', 'to muito chateada', 'nao da mais pra confiar',
  // ── Desespero ────────────────────────────────────────────────────────────
  'desesperado', 'desesperada', 'desespero', 'em panico', 'desesperador',
  'nao aguento', 'socorro', 'situacao critica', 'desesperante',
  'urgente urgente', 'muito urgente', 'extremamente urgente',
  'nao sei mais o que fazer', 'ja nao sei o que fazer', 'to desesperado',
  'to desesperada', 'aflito', 'aflita', 'apavorado', 'apavorada',
  // ── Desrespeito / maus-tratos ────────────────────────────────────────────
  'desrespeito', 'desrespeitado', 'desrespeitada', 'falta de respeito',
  'mal educado', 'mal educada', 'grosseiro', 'grosseira', 'humilhado', 'humilhada',
  'me tratou mal', 'fui mal tratado', 'fui mal tratada', 'sem educacao',
  'fui ignorado', 'fui ignorada', 'me ignoraram', 'ninguem me responde',
  'ninguem me da atencao', 'tratamento ruim', 'mal atendido', 'mal atendida',
  'atendida com grosseria', 'atendido com grosseria', 'sem consideracao',
  'falta de consideracao', 'falta de atencao', 'zero de atencao',
  // ── Erros (reclamação, não frase composta) ──────────────────────────────
  'erro grave', 'erro gravissimo', 'muitos erros', 'cheio de erros', 'errado de novo',
  'errado outra vez', 'errado mais uma vez', 'sempre errado', 'calculado errado',
  'guias erradas', 'guia errada', 'calculo errado', 'valor errado',
  'erro feio', 'outro erro', 'mais um erro', 'esse erro de novo',
  'toda vez um erro', 'nunca acertam', 'nao acertam nunca', 'sempre tem algo errado',
  'algo sempre errado', 'nunca fazem certo', 'nao fazem certo nunca',
  // ── Demora / atraso (reclamação recorrente, não frase de churn) ─────────
  'demora demais', 'demora muito', 'demora um absurdo', 'demora exagerada',
  'sempre atrasado', 'sempre atrasa', 'atraso constante', 'atraso de novo',
  'atrasado de novo', 'sempre em atraso', 'muito tempo esperando',
  'esperando ha dias', 'esperando ha semanas', 'nao aguento esperar mais',
  'demorou demais', 'demorou muito tempo',
  // ── Juros / multa (prejuízo financeiro por erro do escritório) ─────────
  'juros e multa', 'juros por causa', 'multa por causa', 'multa por erro',
  'juros por erro', 'paguei multa', 'tive que pagar multa', 'gerou multa',
  'gerou juros', 'me cobraram multa', 'quem vai pagar', 'quem vai arcar',
  'vou ter que pagar', 'prejuizo financeiro', 'tive prejuizo', 'multa indevida',
  'me prejudicou', 'me prejudicaram', 'causou prejuizo', 'causaram prejuizo',
  'perdi dinheiro por causa', 'perdi dinheiro com isso', 'vou ter que arcar',
  'vou ter que pagar por erro', 'nao e justo eu pagar', 'nao vou pagar por erro de voces',
  'quem se responsabiliza', 'quem assume esse prejuizo', 'quem arca com o prejuizo',
  // ── Absurdo / inaceitável / descaso ─────────────────────────────────────
  'absurdo', 'inaceitavel', 'inadmissivel', 'descaso', 'incompetencia', 'incompetente',
  'vergonha', 'lamentavel', 'decepcao total', 'uma falta de respeito isso',
  // ── Ameaça de ação legal / exposição pública ─────────────────────────────
  'vou processar', 'vou entrar com processo', 'vou na justica', 'meu advogado vai',
  'vou acionar meu advogado', 'vou denunciar', 'vou expor isso', 'vou postar isso',
  'vou avisar todo mundo', 'vou fazer todo mundo saber', 'vou avisar outros clientes',
  // ── Comparação negativa (contador/contabilidade anterior era melhor) ────
  'meu contador antigo era melhor', 'a contabilidade anterior era melhor',
  'nunca tive esse problema antes', 'com o contador anterior nao acontecia isso',
  'com a contabilidade anterior nao tinha isso',
];

/**
 * Se o texto tiver alguma palavra/expressão de insatisfação, devolve a que
 * bateu; senão, devolve null. Casamento por substring (palavra solta conta),
 * de propósito mais permissivo que detectarSinalChurn (ver comentário da
 * lista PALAVRAS_INSATISFACAO acima).
 */
function detectarInsatisfacao(texto) {
  const t = normalizarTexto(texto);
  if (!t) return null;
  return PALAVRAS_INSATISFACAO.find(p => t.includes(p)) || null;
}

/**
 * Taxonomia de MOTIVO DE ABERTURA — por que o cliente entrou em contato,
 * não confundir com `departamento` (fila do Zappy: Fiscal/Financeiro/DP...),
 * que é routing, não motivo. Pedido da Thais: "quais são as principais
 * dores dos clientes, por quais motivos somos acionados".
 *
 * Duas camadas, mesmo espírito de FRASES_CHURN/PALAVRAS_INSATISFACAO (listas
 * grandes, calibradas, zero IA):
 *   - MOTIVO (categoria ampla, ex.: "Guias e Impostos") — o que já existia.
 *   - SUBMOTIVO (a solicitação específica dentro da categoria, ex.:
 *     "Recálculo/Correção de Guia") — pedido da Thais: "sempre há um pedido,
 *     uma solicitação... o que de fato foi a solicitação do cliente? Tente
 *     agrupar as mesmas solicitações... cliente quer recálculo de guias,
 *     cada um pede de um jeito". O submotivo é exatamente isso: N jeitos
 *     diferentes de pedir a MESMA coisa (recalcular, refazer, corrigir,
 *     "valor errado", "podem refazer?") caem todos no mesmo rótulo, então
 *     dá pra ver "43 pedidos de recálculo de guia" em vez de 43 linhas soltas
 *     de "Guias e Impostos" sem saber o que, de fato, cada uma queria.
 *
 * Ordem importa DUAS VEZES: entre categorias (primeira que bater vence) e
 * dentro de cada categoria, entre submotivos (idem). "Quer Falar com Alguém
 * Específico" fica de propósito por ÚLTIMO, logo antes do fallback "outros"
 * — pedido pela Thais ao ver o painel: "sobre qual motivo foi estes
 * contatos?" — ou seja, "quero falar com o Guilherme" sozinho não diz nada
 * sobre o ASSUNTO; mas "quero falar com o Guilherme sobre minha guia que
 * veio errada" tem assunto (Guias e Impostos) E pessoa — como a janela
 * inteira (até 20 mensagens) é concatenada antes de classificar, colocando
 * as categorias de ASSUNTO primeiro, o texto cai no assunto real sempre que
 * ele aparecer em algum ponto da conversa; "Quer Falar com Alguém
 * Específico" só vence quando NENHUM assunto foi mencionado na janela.
 *
 * Calibrada com o que é comum em escritório de contabilidade brasileiro —
 * segue sendo um ponto de partida, não lista fechada: o painel "palavras
 * não classificadas" (ver palavrasFrequentes abaixo) mostra o que ainda cai
 * em Outros, pra continuar calibrando com exemplo real, sem precisar ler
 * ticket a ticket.
 */
const MOTIVOS_ATENDIMENTO = [
  {
    chave: 'guias_impostos', label: 'Guias e Impostos',
    submotivos: [
      {
        chave: 'guia_recalculo', label: 'Recálculo/Correção de Guia',
        palavras: [
          'recalcular a guia', 'recalculo da guia', 'recalculo de guia', 'refazer a guia',
          'refazer minha guia', 'corrigir a guia', 'correcao da guia', 'correcao na guia',
          'guia precisa ser refeita', 'preciso que refacam a guia', 'podem refazer a guia',
          'pode refazer a guia', 'gerar a guia novamente', 'gerar guia de novo',
          'gerar guia novamente', 'emitir a guia novamente', 'reemitir a guia',
          'guia com valor errado', 'guia veio com valor errado', 'guia veio errada',
          'a guia esta errada', 'guia chegou errada', 'guia com erro', 'erro na guia',
          'valor da guia esta errado', 'valor incorreto na guia', 'guia calculada errado',
          'calculo da guia errado', 'guia veio com o valor errado', 'valor da das errado',
          'das veio errado', 'das calculado errado', 'guia diferente do combinado',
          'guia com valor diferente', 'esse valor da guia nao confere',
          'esse valor nao esta certo na guia', 'a guia ta errada', 'guia ta com erro',
          'valor da guia ta errado', 'pode corrigir a guia', 'preciso corrigir a guia',
          'guia saiu com valor errado', 'refizeram a guia errado', 'guia bugada',
          'sistema gerou a guia errada', 'guia duplicada', 'guia com valor a maior',
          'guia com valor a menor', 'valor menor do que devia', 'valor maior do que devia',
          'guia que veio errada', 'guia que veio com valor errado', 'guia que chegou errada',
          'essa guia veio errada', 'sua guia veio errada', 'guia esta com valor errado',
          'guia esta com o valor errado', 'recalculem a guia', 'recalculem minha guia',
          'podem recalcular', 'preciso recalcular', 'gostaria de recalcular',
          'recalcular minha guia', 'novo calculo da guia', 'solicito novo calculo da guia',
          'solicito recalculo', 'solicito o recalculo',
        ],
      },
      {
        chave: 'guia_2via', label: '2ª Via / Reemissão de Guia',
        palavras: [
          '2 via da guia', 'segunda via da guia', 'guia nao chegou', 'nao recebi a guia',
          'nao chegou minha guia', 'nao chegou a guia', 'perdi a guia', 'nao encontro a guia',
          'cade a guia', 'onde esta a guia', 'me manda a guia', 'me envia a guia',
          'preciso da guia', 'preciso da segunda via', 'reenviar a guia', 'reenviem a guia',
          'mandar a guia de novo', 'nao localizo a guia', 'nao achei a guia', 'sumiu a guia',
          'nao tenho a guia', 'pode me mandar a guia', 'poderia me enviar a guia',
          'me manda a segunda via', 'preciso de uma copia da guia', 'perdi o boleto da guia',
          // variação real vista em "Outros" — cliente no aguardo da guia
          // atualizada/reemitida, sem citar qual imposto.
          'atualizacao da guia', 'aguardo da guia',
        ],
      },
      {
        chave: 'guia_vencimento', label: 'Vencimento / Atraso de Guia',
        palavras: [
          'guia vencida', 'guia atrasada', 'das vencido', 'das venceu', 'guia venceu',
          'imposto atrasado', 'imposto vencido', 'perdi o prazo da guia',
          'venceu o prazo da guia', 'venceu ontem', 'venceu hoje a guia', 'vence hoje a guia',
          'vence amanha a guia', 'qual o vencimento da guia', 'quando vence a guia',
          'data de vencimento da guia', 'multa por atraso na guia', 'juros por atraso na guia',
          'paguei a guia atrasado', 'guia ja passou do prazo', 'nao paguei a guia a tempo',
          'atrasei o pagamento da guia',
        ],
      },
      {
        chave: 'guia_tributos_fiscais', label: 'Guia de Tributos (DAS/DARF/ICMS)',
        palavras: [
          'guia de das', 'guia do simples', 'darf', 'guia do darf', 'irpj', 'csll', 'icms',
          'iss retido', 'pis cofins', 'guia do icms', 'guia do iss', 'guia de irpj',
          'guia de csll', 'calculo do imposto', 'valor do imposto', 'valor do das',
          'das errado', 'guia do das', 'guia do imposto de renda', 'imposto errado',
          'quanto vou pagar de imposto', 'quanto e o imposto desse mes', 'imposto do mes',
          'guia do simples nacional', 'imposto do simples', 'darf do irpj', 'darf do csll',
        ],
      },
      {
        chave: 'guia_encargos_dp', label: 'Guia de Encargos (INSS/GPS/FGTS)',
        palavras: [
          'inss guia', 'guia do inss', 'gps', 'guia gps', 'fgts guia', 'guia do fgts',
          'guia de recolhimento', 'guia da folha', 'inss da folha', 'fgts da folha',
          'encargo da folha', 'guia de encargos', 'pagamento do inss', 'pagamento do fgts',
          'guia do fgts do funcionario', 'guia previdenciaria',
          // variações reais vistas em "Outros / Não identificado" (achado
          // calibrando com o Reysner): "guia de fgts" e "guia fgts" sem o
          // "do" que as frases acima exigiam.
          'guia de fgts', 'guia fgts',
        ],
      },
      {
        chave: 'guia_parcelamento', label: 'Parcelamento de Imposto/Guia',
        palavras: [
          'parcelar o imposto', 'parcelar a guia', 'parcelamento do imposto',
          'parcelamento do das', 'dividir o imposto', 'dividir a guia', 'parcelar debito',
          'parcelamento de debito fiscal', 'reparcelamento', 'quero parcelar o imposto',
          'da pra parcelar o imposto', 'como faco pra parcelar', 'parcelar em quantas vezes',
        ],
      },
      {
        chave: 'guia_duvida', label: 'Dúvida sobre Guia',
        palavras: [
          'duvida sobre a guia', 'como funciona a guia', 'pra que serve essa guia',
          'essa guia e de que', 'essa guia e referente a que', 'nao entendi a guia',
          'o que e essa guia', 'porque veio essa guia', 'por que gerou essa guia',
          'essa guia e sobre o que',
        ],
      },
    ],
  },
  {
    chave: 'boletos_honorarios', label: 'Boletos e Honorários',
    submotivos: [
      {
        chave: 'boleto_2via', label: '2ª Via de Boleto',
        palavras: [
          '2 via do boleto', 'segunda via do boleto', 'boleto nao chegou',
          'nao recebi o boleto', 'cade o boleto', 'onde esta o boleto', 'perdi o boleto',
          'nao encontro o boleto', 'me manda o boleto', 'me envia o boleto',
          'reenviar o boleto', 'mandar o boleto de novo', 'preciso do boleto',
          'nao achei o boleto', 'poderia me enviar o boleto', 'pode me mandar o boleto',
          'me manda a segunda via do boleto',
        ],
      },
      {
        // Não existia equivalente pra boleto do que já existia pra guia
        // (guia_vencimento, acima) — achado calibrando com o Reysner:
        // cliente real avisando que o boleto venceu, sem estar pedindo
        // 2ª via nem contestando valor.
        chave: 'boleto_vencimento', label: 'Vencimento / Boleto Atrasado',
        palavras: [
          'boleto venceu', 'meu boleto venceu', 'o boleto venceu', 'boleto vencido',
          'boleto ja venceu', 'vence hoje o boleto', 'vence amanha o boleto',
          'qual o vencimento do boleto', 'quando vence o boleto',
          'data de vencimento do boleto', 'boleto passou do prazo',
        ],
      },
      {
        chave: 'boleto_valor', label: 'Valor do Boleto / Cobrança Indevida',
        palavras: [
          'valor cobrado', 'cobranca indevida', 'valor do boleto errado',
          'boleto com valor errado', 'boleto veio errado', 'cobraram errado',
          'esse valor esta errado', 'nao reconheco essa cobranca',
          'nao e esse o valor combinado', 'valor diferente do combinado',
          'porque esse valor', 'de onde veio esse valor', 'esse valor no boleto',
          'boleto veio com valor diferente', 'cobranca a mais', 'me cobraram a mais',
          'boleto que veio errado', 'boleto que veio com valor errado',
        ],
      },
      {
        chave: 'boleto_pagamento', label: 'Pagamento Não Reconhecido / Comprovante',
        palavras: [
          'pagamento nao caiu', 'ja paguei e nao baixou', 'comprovante de pagamento',
          'ja fiz o pagamento', 'pagamento nao foi identificado',
          'nao esta constando o pagamento', 'ja paguei esse boleto', 'segue o comprovante',
          'anexei o comprovante', 'ja quitei esse boleto', 'pagamento nao compensou',
          'boleto ja foi pago', 'consta em aberto mas ja paguei',
        ],
      },
      {
        chave: 'honorario_atraso', label: 'Honorário em Atraso',
        palavras: [
          'honorario atrasado', 'honorario em atraso', 'atraso no pagamento do honorario',
          'estou em atraso com o honorario', 'fatura em atraso', 'nota de honorario',
          'fatura do mes', 'esqueci de pagar o honorario', 'vou atrasar o pagamento',
          'honorario vencido', 'nao paguei o honorario ainda',
        ],
      },
      {
        chave: 'honorario_negociacao', label: 'Negociação / Desconto de Honorário',
        palavras: [
          'desconto no boleto', 'desconto no honorario', 'negociar o honorario',
          'renegociar honorario', 'consigo um desconto', 'da pra dar um desconto',
          'valor do honorario esta alto', 'revisar o valor do honorario',
          'reajuste do honorario', 'aumento do honorario', 'esta muito caro o honorario',
          'reduzir o valor do honorario',
        ],
      },
      {
        chave: 'honorario_parcelamento', label: 'Parcelamento de Honorário',
        palavras: [
          'parcelamento do honorario', 'parcelar o honorario', 'parcelar a fatura',
          'dividir o honorario', 'quero parcelar o honorario', 'parcelar a mensalidade',
        ],
      },
      {
        chave: 'boleto_cancelamento', label: 'Cancelamento de Cobrança',
        palavras: [
          'cancelar o boleto', 'cancelar a cobranca', 'estornar o boleto',
          'boleto duplicado', 'cobraram duas vezes', 'cobranca duplicada',
          'gerou boleto errado', 'cancelar essa fatura', 'estorno da cobranca',
        ],
      },
    ],
  },
  {
    chave: 'folha_dp', label: 'Folha de Pagamento / DP',
    submotivos: [
      {
        chave: 'dp_admissao', label: 'Admissão de Funcionário',
        palavras: [
          'admissao', 'admitir', 'contratacao de funcionario', 'contratar funcionario',
          'novo funcionario', 'vou contratar', 'preciso admitir', 'documentos para admissao',
          'exame admissional', 'registro de funcionario', 'carteira assinada',
          'assinar carteira', 'contratando um funcionario', 'vou admitir alguem',
          'preciso registrar um funcionario',
        ],
      },
      {
        chave: 'dp_rescisao', label: 'Rescisão / Demissão',
        palavras: [
          'rescisao', 'demissao', 'demitir', 'vou demitir', 'desligamento de funcionario',
          'desligar funcionario', 'exame demissional', 'calculo da rescisao',
          'aviso previo', 'termo de rescisao', 'homologacao', 'quero demitir',
          'preciso desligar um funcionario', 'vou fazer uma rescisao',
        ],
      },
      {
        chave: 'dp_ferias', label: 'Férias',
        palavras: [
          'ferias', 'agendar ferias', 'marcar ferias', 'ferias do funcionario',
          'aviso de ferias', 'recibo de ferias', 'calculo de ferias', 'ferias vencidas',
          'programar ferias', 'colocar ferias', 'preciso tirar ferias',
        ],
      },
      {
        chave: 'dp_13', label: '13º Salário',
        palavras: [
          'decimo terceiro', '13 salario', 'calculo do decimo terceiro',
          'adiantamento do decimo terceiro', 'primeira parcela do 13',
          'segunda parcela do 13', 'quando cai o decimo terceiro',
        ],
      },
      {
        chave: 'dp_holerite', label: 'Holerite / Contracheque',
        palavras: [
          'holerite', 'contracheque', 'recibo de pagamento', 'demonstrativo de pagamento',
          'nao recebi o holerite', 'preciso do holerite', 'preciso do contracheque',
          'me envia o holerite', 'me manda o contracheque',
        ],
      },
      {
        chave: 'dp_afastamento', label: 'Afastamento / Atestado',
        palavras: [
          'afastamento do funcionario', 'atestado medico', 'funcionario afastado',
          'auxilio doenca', 'licenca medica', 'enviar atestado', 'atestado do funcionario',
          'afastamento por doenca', 'funcionario de atestado', 'funcionario doente',
        ],
      },
      {
        chave: 'dp_beneficios', label: 'Benefícios (VT/VA/VR)',
        palavras: [
          'vale transporte', 'vale alimentacao', 'vale refeicao', 'beneficio do funcionario',
          'cartao alimentacao', 'plano de saude do funcionario', 'cadastrar vale transporte',
        ],
      },
      {
        chave: 'dp_esocial', label: 'eSocial / Obrigações Trabalhistas',
        palavras: [
          'esocial', 'fgts do funcionario', 'ponto eletronico', 'cartao ponto',
          'banco de horas', 'hora extra do funcionario', 'folha de pagamento',
          'evento no esocial',
        ],
      },
    ],
  },
  {
    chave: 'notas_fiscais', label: 'Notas Fiscais',
    submotivos: [
      {
        chave: 'nf_emissao', label: 'Emissão de Nota Fiscal',
        palavras: [
          'emitir nota', 'emitir nota fiscal', 'nao consigo emitir', 'nao esta emitindo',
          'preciso emitir uma nota', 'emitir uma nota', 'como emito a nota', 'emissao de nfse',
          'emissao de nfe', 'gerar nota fiscal', 'preciso de uma nota fiscal',
          'emitir a nota para o cliente',
        ],
      },
      {
        chave: 'nf_cancelamento', label: 'Cancelamento de Nota',
        palavras: [
          'cancelar nota', 'cancelar a nota fiscal', 'cancelamento de nfse',
          'nota emitida errada', 'preciso cancelar essa nota', 'nota com erro',
          'cancelamento de nota fiscal',
        ],
      },
      {
        chave: 'nf_erro', label: 'Erro / Rejeição de Nota',
        palavras: [
          'nota rejeitada', 'erro na nota fiscal', 'nota fiscal com erro',
          'nota nao autorizada', 'xml da nota', 'nota fiscal errada',
          'nota com valor errado', 'nota emitida com erro', 'nota nao foi aceita',
          'nota deu erro', 'nota que veio errada', 'nota que veio com erro',
        ],
      },
      {
        chave: 'nf_naolocalizada', label: 'Nota Fiscal Não Localizada',
        palavras: [
          'nao encontro a nota', 'nao achei a nota fiscal', 'nfse', 'nfe',
          'cade a nota fiscal', 'preciso da nota fiscal', 'me envia a nota fiscal',
          'nao localizo a nota',
          // variações reais vistas em "Outros" — "de" no lugar de "da", e
          // plural. 'nota fiscal' sozinho fica por último de propósito: só
          // pega o que nenhuma frase mais específica das outras 3
          // submotivos acima (emissão/cancelamento/erro) já capturou.
          'preciso de nota fiscal', 'preciso de notas fiscais', 'nota fiscal',
        ],
      },
    ],
  },
  {
    chave: 'documentos_declaracoes', label: 'Documentos e Declarações',
    submotivos: [
      {
        chave: 'doc_irpf', label: 'Declaração de Imposto de Renda',
        palavras: [
          'declaracao de imposto de renda', 'declaracao do imposto de renda',
          'ir pessoa fisica', 'irpf', 'declarar imposto de renda',
          'restituicao do imposto de renda', 'ajuste anual', 'informe de rendimentos',
          'declaracao do ir',
        ],
      },
      {
        chave: 'doc_contabeis', label: 'Documentos Contábeis (Balanço/Extrato)',
        palavras: [
          'balanco', 'balancete', 'relatorio contabil', 'extrato', 'demonstrativo contabil',
          'dre', 'demonstrativo de resultado', 'preciso do balanco', 'preciso do balancete',
          'me envia o balanco',
        ],
      },
      {
        chave: 'doc_societarios', label: 'Documentos Societários',
        palavras: [
          'contrato social', 'preciso do contrato social', 'copia do contrato social',
          'documento da empresa', 'cartao cnpj', 'comprovante de inscricao',
          'ficha cadastral', 'me envia o contrato social',
        ],
      },
      {
        chave: 'doc_banco', label: 'Documento para Banco/Financiamento',
        palavras: [
          'documento para o banco', 'documento para financiamento',
          'declaracao de faturamento', 'certidao negativa', 'documento para credito',
          'documento para emprestimo', 'preciso de um documento para o banco',
          'documento para o cartorio',
        ],
      },
    ],
  },
  {
    chave: 'abertura_alteracao_empresa', label: 'Abertura/Alteração/Baixa de Empresa',
    submotivos: [
      {
        chave: 'emp_abertura', label: 'Abertura de Empresa',
        palavras: [
          'abertura de empresa', 'abrir empresa', 'abrir cnpj', 'segunda empresa',
          'nova empresa', 'quero abrir uma empresa', 'como abro uma empresa',
          'abrir uma nova empresa', 'abrir um mei', 'abertura de mei',
        ],
      },
      {
        chave: 'emp_alteracao', label: 'Alteração Contratual / Sócio',
        palavras: [
          'alteracao contratual', 'alterar contrato social', 'mudar razao social',
          'incluir socio', 'retirar socio', 'alterar capital social',
          'alteracao de socio', 'entrada de socio', 'saida de socio', 'mudanca de socio',
        ],
      },
      {
        chave: 'emp_endereco', label: 'Mudança de Endereço',
        palavras: [
          'mudanca de endereco da empresa', 'mudar endereco da empresa',
          'alterar endereco da empresa', 'transferir endereco', 'mudanca de sede',
        ],
      },
      {
        chave: 'emp_regime', label: 'Mudança de Regime Tributário / Enquadramento',
        palavras: [
          'mudanca de regime tributario', 'enquadramento', 'mudar de regime',
          'trocar de regime tributario', 'mudar para lucro presumido',
          'mudar para simples nacional', 'desenquadramento',
        ],
      },
      {
        chave: 'emp_baixa', label: 'Baixa / Encerramento de Empresa',
        palavras: [
          'encerramento de empresa', 'baixar empresa', 'baixa da empresa',
          'fechar a empresa', 'quero fechar a empresa', 'distrato', 'encerrar o cnpj',
          'baixa de cnpj',
        ],
      },
    ],
  },
  {
    chave: 'certificado_digital', label: 'Certificado Digital',
    submotivos: [
      {
        chave: 'cert_vencimento', label: 'Certificado Vencido / Renovação',
        palavras: [
          'certificado digital', 'certificado vencido', 'certificado venceu',
          'renovar certificado', 'token vencido', 'certificado vai vencer',
          'preciso renovar o certificado',
        ],
      },
      {
        chave: 'cert_emissao', label: 'Emissão / Instalação',
        palavras: [
          'e-cnpj', 'e-cpf', 'ecnpj', 'ecpf', 'emitir certificado', 'instalar certificado',
          'nao consigo instalar o certificado', 'como instalo o certificado',
          'preciso do certificado digital',
        ],
      },
      {
        chave: 'cert_procuracao', label: 'Procuração Eletrônica',
        palavras: [
          'procuracao eletronica', 'procuracao digital', 'preciso de uma procuracao',
        ],
      },
    ],
  },
  {
    chave: 'prazos_obrigacoes', label: 'Prazos e Obrigações Acessórias',
    submotivos: [
      {
        chave: 'prazo_sped', label: 'SPED / ECD / ECF',
        palavras: [
          'sped', 'ecd', 'ecf', 'sped fiscal', 'sped contribuicoes', 'entrega do sped',
        ],
      },
      {
        chave: 'prazo_dctf', label: 'DCTF / DIRF',
        palavras: [
          'dctf', 'dirf', 'entrega da dctf', 'entrega da dirf',
        ],
      },
      {
        chave: 'prazo_trabalhista', label: 'RAIS / CAGED',
        palavras: [
          'rais', 'caged', 'entrega da rais', 'entrega do caged',
        ],
      },
      {
        chave: 'prazo_defis', label: 'DEFIS / DAS-MEI',
        palavras: [
          'defis', 'das mei', 'declaracao do mei', 'declaracao anual do simples',
        ],
      },
      {
        chave: 'prazo_geral', label: 'Prazo de Entrega (Geral)',
        palavras: [
          'prazo de entrega', 'obrigacao acessoria', 'qual o prazo', 'quando e o prazo',
          'vencimento da declaracao', 'declaracao vencendo', 'ate quando posso entregar',
          'perdi o prazo', 'qual o prazo pra entregar',
        ],
      },
    ],
  },
  {
    chave: 'duvida_fiscal_tributaria', label: 'Dúvida Fiscal/Tributária',
    submotivos: [
      {
        chave: 'duvida_enquadramento', label: 'Enquadramento / Regime Tributário',
        palavras: [
          'enquadramento tributario', 'regime tributario', 'qual regime e melhor',
          'simples nacional ou lucro presumido', 'melhor regime para minha empresa',
        ],
      },
      {
        chave: 'duvida_aliquota', label: 'Alíquota / Cálculo de Imposto',
        palavras: [
          'qual a aliquota', 'quanto vou pagar de imposto', 'como e calculado o imposto',
          'como funciona o imposto', 'duvida sobre imposto', 'duvida tributaria',
          'qual imposto', 'tem que pagar imposto',
          // variações reais vistas em "Outros" (4ª rodada de calibração):
          // "aliquota" sozinho é específico o bastante pra não precisar de
          // frase inteira antes.
          'aliquota',
        ],
      },
      {
        chave: 'duvida_deducao', label: 'Dedução / Benefício Fiscal',
        palavras: [
          'posso deduzir', 'da pra deduzir', 'quais gastos posso deduzir',
          'beneficio fiscal', 'incentivo fiscal',
        ],
      },
      {
        chave: 'duvida_geral', label: 'Dúvida Contábil Geral',
        palavras: [
          'duvida contabil', 'tenho uma duvida', 'gostaria de entender',
          'pode me explicar', 'tenho uma pergunta',
        ],
      },
    ],
  },
  {
    chave: 'erros_reclamacoes', label: 'Erros e Reclamações Operacionais',
    submotivos: [
      {
        chave: 'erro_calculo', label: 'Erro em Cálculo / Guia',
        palavras: [
          'calculado errado', 'valor errado', 'guia errada de novo', 'erro no calculo',
          'errado de novo', 'sempre errado', 'de novo errado', 'calculo errado',
        ],
      },
      {
        chave: 'erro_multa', label: 'Multa/Juros por Erro do Escritório',
        palavras: [
          'multa por erro', 'juros por erro', 'paguei multa por causa', 'gerou multa',
          'multa indevida', 'quem vai pagar essa multa',
        ],
      },
      {
        chave: 'erro_atraso_escritorio', label: 'Atraso / Falta de Retorno do Escritório',
        palavras: [
          'nao recebi retorno', 'sem retorno', 'ainda nao me responderam',
          'demorou pra responder', 'nao fui atendido', 'ninguem me respondeu',
          'problema recorrente', 'reclamacao',
        ],
      },
    ],
  },
  {
    // Checado por ÚLTIMO de propósito (ver comentário acima do array):
    // não diz o ASSUNTO sozinho, só que o cliente quer falar com alguém
    // específico. Casos reais levantados pela Thais: "Quero falar com o
    // Guilherme" / "...a Ivone" / "...a Lilian" / "...a Thais". Ver
    // extrairNomeSolicitado abaixo, que tenta pegar QUEM foi pedido.
    chave: 'atendimento_especifico', label: 'Quer Falar com Alguém Específico',
    submotivos: [
      {
        chave: 'pessoa_especifica', label: 'Pedido de Contato Específico',
        palavras: [
          'quero falar com', 'gostaria de falar com', 'poderia falar com',
          'preciso falar com', 'preciso conversar com', 'quero conversar com',
          'gostaria de conversar com', 'pode me passar com', 'me passa com',
          'falar com o', 'falar com a', 'passar para o', 'passar para a',
          // variação real vista em "Outros" — pergunta em vez de pedido
          // ("com quem falo sobre X?"), e "falar com [Nome]" sem artigo
          // antes do nome (as duas frases acima exigiam "com o"/"com a").
          'com quem falo', 'falar com',
        ],
      },
    ],
  },
];

/**
 * Classifica a mensagem em um motivo (categoria) + submotivo (solicitação
 * específica) de atendimento. Casamento por substring (mesmo estilo de
 * detectarInsatisfacao) — primeira categoria/submotivo que bater vence
 * (ver comentário acima do array sobre a ordem). Sem correspondência =
 * {chave:'outros', ...} (não é erro, só significa que essa mensagem não
 * caiu em nenhuma categoria ainda — sinal de que a lista precisa crescer).
 */
function classificarMotivo(texto) {
  const t = normalizarTexto(texto);
  if (!t) {
    return { chave: 'outros', label: 'Outros / Não identificado', submotivoChave: null, submotivoLabel: null };
  }
  for (const cat of MOTIVOS_ATENDIMENTO) {
    for (const sub of cat.submotivos) {
      if (sub.palavras.some(p => t.includes(p))) {
        return { chave: cat.chave, label: cat.label, submotivoChave: sub.chave, submotivoLabel: sub.label };
      }
    }
  }
  return { chave: 'outros', label: 'Outros / Não identificado', submotivoChave: null, submotivoLabel: null };
}

/**
 * Saudações "puras" — mensagens que são SÓ cumprimento, sem nenhum
 * conteúdo próprio (ex.: "Bom dia", "Oi, tudo bem?"). Em chat é muito
 * comum a pessoa mandar isso numa mensagem separada e só na próxima (ou
 * depois) explicar o que precisa — se `classificarMotivo` olhasse só a
 * 1ª mensagem, ia classificar esses casos como "outros" por engano
 * (percebido pela Thais: "a primeira mensagem pode ser bom dia").
 */
const SAUDACOES_PURAS = [
  'bom dia', 'boa tarde', 'boa noite', 'ola', 'oi', 'oii', 'oie', 'opa',
  'eae', 'e ai', 'tudo bem', 'tudo bom', 'ola tudo bem', 'ola tudo bom',
];

/** true se o texto, tirando pontuação, não passa de uma saudação — sem pedido/assunto nenhum. */
function ehSaudacaoPura(texto) {
  let t = normalizarTexto(texto).replace(/[!?.,;]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return true;
  for (const s of SAUDACOES_PURAS) {
    if (t === s) return true;
    if (t.startsWith(s + ' ')) t = t.slice(s.length).trim();
  }
  return t.length === 0;
}

/**
 * Ruído que aparece dentro de `texto` mas não é o cliente falando nada —
 * achado inspecionando `trecho` de tickets reais em "Outros / Não
 * identificado" com o Reysner, em duas rodadas de calibração:
 *
 * 1. Nome de arquivo de anexo sem legenda — quando o cliente manda só
 *    foto/áudio/vídeo/documento sem escrever nada junto, o texto da
 *    mensagem vira o NOME DO ARQUIVO. 1ª rodada só cobria o padrão gerado
 *    pelo Zappy ("image_1784114637691.jpeg", "audio_1784114563564.ogg");
 *    2ª rodada generalizou pra qualquer nome de arquivo com extensão de
 *    documento/mídia, porque recibo de banco tem nome próprio
 *    ("Comprovante_08-07-2026_163403.pdf", "Pagamento_06_2025_Final.xlsx")
 *    — sozinho já pegava quase o dobro de tickets que o padrão específico.
 * 2. Cartão de contato (vCard) compartilhado — vira um bloco
 *    "BEGIN:VCARD ... END:VCARD" no texto, não é o cliente dizendo nada.
 * 3. Resposta automática de fora do expediente — chega marcada como vindo
 *    do cliente (autorresponder do WhatsApp Business dele reagindo à nossa
 *    mensagem). A abertura muda por empresa ("Agradecemos sua mensagem...",
 *    "A RT agradece a sua mensagem..."), então em vez de string fixa
 *    completa, casa pelos dois pedaços fixos que se repetem entre empresas
 *    diferentes: a abertura ("[algo] agradece[mos] ... sua mensagem") e o
 *    miolo ("não estamos disponíveis..."). 4ª rodada de calibração achou
 *    que a 3ª só cortava o miolo — "Agradecemos sua mensagem." sozinho
 *    sobrava no texto e ainda aparecia nas Palavras mais frequentes.
 * 4. Bot de atendimento (chatbot da própria empresa do cliente, não é a
 *    pessoa falando) — mensagens de encerrar por inatividade e de
 *    boas-vindas pedindo CNPJ/CPF pra iniciar.
 */
const RUIDO_ANEXO = /[\w-]+[_-]?\d{2,}[\w-]*\.(pdf|docx?|xlsx?|jpe?g|png|gif|webp|heic|ogg|mp3|mp4|mov)\b/gi;
const RUIDO_VCARD = /BEGIN:VCARD[\s\S]*?END:VCARD/gi;
const RUIDO_AUTORRESPOSTA = /n[ãa]o estamos dispon[íi]veis no momento,?\s*mas responderemos assim que poss[íi]vel\.?/gi;
const RUIDO_AUTORRESPOSTA_ABERTURA = /\w*\s*agradece(mos)?\s*(a\s+)?sua mensagem\.?/gi;
const RUIDO_BOT = /(seja bem[- ]vindo ao atendimento[^.!?]*[.!?]|portanto encerrarei nosso atendimento[^.!?]*[.!?])/gi;

/** Tira o ruído (anexo sem legenda, vCard, autorresposta, bot) de um texto, mantendo o resto. */
function limparRuido(texto) {
  return String(texto || '')
    .replace(RUIDO_VCARD, ' ')
    .replace(RUIDO_AUTORRESPOSTA, ' ')
    .replace(RUIDO_AUTORRESPOSTA_ABERTURA, ' ')
    .replace(RUIDO_BOT, ' ')
    .replace(RUIDO_ANEXO, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** true se, tirando o ruído acima, não sobra nenhum conteúdo real na mensagem. */
function ehMensagemSemConteudo(texto) {
  return limparRuido(texto).length === 0;
}

/**
 * Classifica o MOTIVO DE ABERTURA olhando uma JANELA de mensagens do
 * cliente no início do ticket (não só a primeira) — descarta as que são
 * saudação pura ou não têm conteúdo real (só anexo sem legenda e/ou
 * autorresposta) antes de concatenar e classificar, e tira esse ruído do
 * que sobra (a não ser que sobre só isso na janela toda, aí usa tudo mesmo,
 * pra não ficar sem texto — nesse caso "Outros / Não identificado" é
 * honesto: o cliente só mandou foto/áudio, não dá pra saber o motivo sem
 * abrir o anexo). `textos` = array de strings, já na ordem cronológica
 * (mais antiga primeiro).
 */
function classificarMotivoConversa(textos) {
  const lista = (textos || []).filter(t => t && String(t).trim());
  const substanciais = lista.filter(t => !ehSaudacaoPura(t) && !ehMensagemSemConteudo(t));
  const usar = (substanciais.length ? substanciais : lista).map(limparRuido);
  const combinado = usar.join(' ').slice(0, 800);
  return { ...classificarMotivo(combinado), trecho: combinado, pessoaSolicitada: extrairNomeSolicitado(combinado) };
}

/**
 * Palavras muito comuns em português (+ jargão de atendimento tipo "bom
 * dia"/"gostaria"/"poderia") que não ajudam a identificar assunto nenhum —
 * fora da lista pra `palavrasFrequentes` (abaixo) não virar uma nuvem de
 * "de", "para", "que".
 */
const STOPWORDS_PT = new Set([
  'de', 'da', 'do', 'das', 'dos', 'o', 'os', 'as', 'um', 'uma', 'uns', 'umas',
  'e', 'ou', 'que', 'para', 'por', 'com', 'sem', 'em', 'no', 'na', 'nos', 'nas',
  'ao', 'aos', 'se', 'sua', 'seu', 'suas', 'seus', 'minha', 'meu', 'minhas',
  'meus', 'voce', 'voces', 'esta', 'esse', 'essa', 'isso', 'isto', 'aquele',
  'aquela', 'tem', 'tenho', 'temos', 'ja', 'ainda', 'mais', 'muito', 'muita',
  'muitos', 'muitas', 'bom', 'boa', 'dia', 'tarde', 'noite', 'ola', 'oi',
  'obrigado', 'obrigada', 'favor', 'gentileza', 'pode', 'poderia', 'gostaria',
  'preciso', 'precisava', 'qual', 'quando', 'onde', 'como', 'porque', 'pois',
  'mas', 'tambem', 'so', 'ate', 'entao', 'nao', 'sim', 'vou', 'vamos', 'vai',
  'vao', 'vez', 'pra', 'sobre', 'desde', 'apos', 'antes', 'depois', 'me', 'te',
  'lhe', 'nos', 'eu', 'ele', 'ela', 'eles', 'elas', 'tudo', 'nada', 'algo',
  'alguma', 'algum', 'tao', 'bem', 'ser', 'estar', 'ter', 'ai', 'la', 'ca',
  'aqui', 'ali', 'ok', 'blz', 'certo', 'oii', 'oie', 'opa', 'tudo bem', 'bom dia',
]);

/**
 * Conta as palavras que mais aparecem numa lista de textos, ignorando
 * stopwords — pra usar nos tickets caídos em "Outros / Não identificado" e
 * enxergar rápido o que a taxonomia ainda não cobre, sem precisar ler
 * ticket a ticket. Conta no máximo 1x por texto (não por repetição dentro
 * do mesmo texto), pra uma pessoa insistente não inflar o número sozinha.
 */
function palavrasFrequentes(textos, { topN = 20, minLen = 4 } = {}) {
  const contagem = new Map();
  for (const texto of textos || []) {
    // Tira nome de arquivo de anexo e autorresposta antes de contar — sem
    // isso, "image"/"jpeg"/"audio" dominavam essa lista e escondiam
    // palavras de verdade como "fiscal", "pagamento", "contato",
    // "comprovante". Ver limparRuido/ehMensagemSemConteudo.
    if (ehMensagemSemConteudo(texto)) continue;
    const t = normalizarTexto(limparRuido(texto)).replace(/[^a-z0-9\s]/g, ' ');
    const vistas = new Set();
    for (const palavra of t.split(/\s+/)) {
      if (palavra.length < minLen || STOPWORDS_PT.has(palavra) || vistas.has(palavra)) continue;
      vistas.add(palavra);
      contagem.set(palavra, (contagem.get(palavra) || 0) + 1);
    }
  }
  return [...contagem.entries()]
    .map(([palavra, n]) => ({ palavra, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, topN);
}

/**
 * Tenta extrair o NOME de quem o cliente pediu pra falar (ex.: "quero
 * falar com o Guilherme" -> "Guilherme"). Não decide a categoria sozinho
 * (fica disponível à parte, mesmo quando o motivo real é outro — ex.:
 * "minha guia veio errada, pode chamar o Guilherme?" continua caindo em
 * Guias e Impostos, só que agora com o nome anexado) — serve pra ver
 * quem os clientes mais procuram por nome, sinal de relação de confiança.
 */
function extrairNomeSolicitado(texto) {
  const t = normalizarTexto(texto);
  const m = t.match(/(?:falar|conversar|passar)\s+(?:com|para)\s+(?:o|a)?\s*([a-z]{2,})/);
  if (!m) return null;
  const nome = m[1];
  const IGNORAR = ['favor', 'gentileza', 'voces', 'vc', 'vcs', 'ele', 'ela', 'alguem',
    'responsavel', 'setor', 'financeiro', 'fiscal', 'suporte', 'atendente', 'equipe', 'time'];
  if (IGNORAR.includes(nome)) return null;
  return nome.charAt(0).toUpperCase() + nome.slice(1);
}

/** Ordena por hora (ascendente), tolerando Date ou ISO string */
function ordenarPorHora(arr) {
  return [...arr].sort((a, b) => new Date(a.hora) - new Date(b.hora));
}

function primeiroEvento(eventos, tipo) {
  const e = ordenarPorHora(eventos.filter(x => x.tipo === tipo))[0];
  return e ? new Date(e.hora) : null;
}

function primeiraMsg(mensagens, remetente, apos = null, inclusivo = false) {
  const passa = (h) => !apos || (inclusivo ? new Date(h) >= apos : new Date(h) > apos);
  const lista = ordenarPorHora(
    mensagens.filter(m => m.remetente === remetente && passa(m.hora))
  );
  return lista.length ? new Date(lista[0].hora) : null;
}

/** Igual a primeiraMsg, mas devolve a mensagem inteira (pra ler o texto), não só a hora. */
function primeiraMsgObjeto(mensagens, remetente, apos = null, inclusivo = false) {
  const passa = (h) => !apos || (inclusivo ? new Date(h) >= apos : new Date(h) > apos);
  const lista = ordenarPorHora(
    mensagens.filter(m => m.remetente === remetente && passa(m.hora))
  );
  return lista.length ? lista[0] : null;
}

/**
 * Calcula todos os relógios de um ticket.
 * @param {object} ticket  no formato genérico
 * @param {Date}   agora   instante de referência (default: new Date()) — para relógios ainda correndo
 * @returns {object} { relogios: [...], radar: {...}|null }
 */
function calcularSLA(ticket, agora = new Date()) {
  const eventos = ticket.eventos || [];
  const mensagens = ticket.mensagens || [];

  const tAbertura      = primeiroEvento(eventos, 'abertura');
  const tAceite        = primeiroEvento(eventos, 'aceite');
  const tTransferencia = primeiroEvento(eventos, 'transferencia');
  const tEncerramento  = primeiroEvento(eventos, 'encerramento');

  const primeiraMsgCliente = primeiraMsg(mensagens, 'cliente');
  const primeiraMsgEscritorio = primeiraMsg(mensagens, 'escritorio');
  // Ticket ABERTO PELO ESCRITÓRIO (contato proativo, ex.: cobrança de pendência
  // financeira) quando a primeira mensagem da conversa é do escritório e não
  // existe nenhuma mensagem do cliente antes dela (ou não existe nenhuma
  // mensagem do cliente). Ticket #46296 (Diessica) mostrou o problema: o
  // Bruno chamou a cliente primeiro, ela nunca "esperou ser aceita" — mas o
  // relógio de Aceite tava contando desde a abertura do ticket até agora
  // (sem tAceite, o "fim" cai em `agora` e o tempo só cresce), gerando um
  // falso vermelho gigante numa etapa que nem se aplica a esse caso.
  const iniciadoPeloEscritorio = !!primeiraMsgEscritorio &&
    (!primeiraMsgCliente || primeiraMsgEscritorio < primeiraMsgCliente);

  // marco inicial: a 1ª mensagem do cliente, ou a abertura se não houver mensagem
  const inicio = primeiraMsgCliente || tAbertura;

  const relogios = [];

  // ── Relógio 1 — ACEITE ──────────────────────────────────────────────────────
  // Só faz sentido medir "tempo até aceitar" quando foi o CLIENTE quem chamou
  // primeiro. Se o escritório é quem abriu a conversa (contato proativo), não
  // existe cliente esperando aceite — pula esse relógio pro ticket inteiro.
  if (inicio && !iniciadoPeloEscritorio) {
    // Nem todo ticket do Zappy tem um evento formal de 'aceite' registrado
    // (ex.: tickets #46251 e #45963, reportados pela Thais — encerrados há
    // dias, sem nenhum evento de aceite, mas o "fim" caía em `agora`, ou
    // seja, na hora real em que o Dashboard é calculado. Resultado: um
    // ticket fechado há uma semana continuava parecendo uma violação enorme
    // e CRESCENDO a cada dia que passava, só porque ninguém nunca clicou
    // formalmente em "aceitar" no Zappy). Sem o evento formal, usa como
    // "aceite implícito" a primeira resposta do escritório (responder já é,
    // na prática, ter pego o ticket) ou, se nunca respondeu, o encerramento
    // do ticket. Só cai em `agora` (e fica em_curso=true) se o ticket
    // realmente ainda está aberto e ninguém nunca respondeu nada.
    const fim = tAceite || primeiraMsgEscritorio || tEncerramento || agora;
    const aindaSemResposta = !tAceite && !primeiraMsgEscritorio && !tEncerramento;
    const min = T.minutosUteis(inicio, fim);
    relogios.push(montar('aceite', inicio, fim, min, aindaSemResposta));
  }

  // ── Relógio 2 — TRANSFERÊNCIA ───────────────────────────────────────────────
  // Corre do aceite até a transferência. MAS: se o escritório já respondeu algo
  // após o aceite (fez uma promessa), o trecho parado vira PROMESSA, não transferência.
  const respAposAceiteObj = tAceite ? primeiraMsgObjeto(mensagens, 'escritorio', tAceite, true) : null;
  const respAposAceite = respAposAceiteObj ? new Date(respAposAceiteObj.hora) : null;
  if (tAceite) {
    if (tTransferencia) {
      // transferiu: mede aceite -> transferência (sempre vale)
      const min = T.minutosUteis(tAceite, tTransferencia);
      relogios.push(montar('transferencia', tAceite, tTransferencia, min, false));
    } else if (!tEncerramento && !respAposAceite) {
      // aberto, aceito, ninguém respondeu ainda e não transferiu -> transferência em curso
      const min = T.minutosUteis(tAceite, agora);
      relogios.push(montar('transferencia', tAceite, agora, min, true));
    }
    // se respAposAceite existe e não transferiu, o relógio que vale é o de PROMESSA (abaixo)
  }

  // ── Relógio 3 — DEPARTAMENTO ────────────────────────────────────────────────
  // Da transferência até a 1ª mensagem do escritório APÓS a transferência.
  if (tTransferencia) {
    const respDepto = primeiraMsg(mensagens, 'escritorio', tTransferencia);
    const fim = respDepto || (tEncerramento || agora);
    const emCurso = !respDepto && !tEncerramento;
    const min = T.minutosUteis(tTransferencia, fim);
    relogios.push(montar('departamento', tTransferencia, fim, min, emCurso));
  }

  // ── Relógio 5 — PROMESSA ────────────────────────────────────────────────────
  // Escritório respondeu ANTES de transferir e o ticket ficou parado (sem transferir
  // nem encerrar). Duas situações bem diferentes, separadas pelo TEXTO da resposta:
  //   - Avisou que VAI TRANSFERIR (ex.: "vou te direcionar") e não transferiu ainda
  //     -> tipo 'promessa', prazo curto (15min, mesmo padrão da transferência real).
  //   - Não falou em transferir (interpretado como "vou resolver isso eu mesma(o)")
  //     -> tipo 'promessa_resolucao', prazo maior (2h de silêncio é aceitável).
  //     MAS: mesmo dentro das 2h, se o cliente mandou mensagem nesse meio tempo e a
  //     resposta a ELA especificamente passou de 30min, já conta negativo — não dá
  //     pra esconder uma demora pontual atrás do prazo geral mais folgado.
  if (tAceite && !tTransferencia && respAposAceite) {
    const fim = tEncerramento || agora;
    const emCurso = !tEncerramento;
    const min = T.minutosUteis(respAposAceite, fim);
    if (pareceIntencaoTransferir(respAposAceiteObj.texto)) {
      relogios.push(montar('promessa', respAposAceite, fim, min, emCurso));
    } else {
      const mensagensDepoisDaResposta = mensagens.filter(m => new Date(m.hora) >= respAposAceite);
      const trocasNaJanela = calcularTrocas(mensagensDepoisDaResposta, agora);
      const teveTrocaLenta = trocasNaJanela.some(t => t.status !== 'verde');

      // "Silêncio geral" (>120min desde a promessa) só é culpa do ANALISTA se a bola
      // estiver com ele. Se a ÚLTIMA mensagem é do escritório E o texto dela pede
      // algo do cliente (comprovante, confirmação, pagamento...), o analista já fez
      // a parte dele e está travado esperando o cliente se posicionar — não tem como
      // "resolver" nesse meio tempo (caso real: ticket #46223, Bruno pediu comprovante
      // de pagamento). Já se a última msg for algo como "vou analisar e te retorno"
      // (sem pedir nada ao cliente), a responsabilidade continua com o analista e o
      // silêncio deve seguir contando normalmente. `calcularTrocas` já exclui o trecho
      // de espera-pelo-cliente de teveTrocaLenta (só conta turnos que COMEÇAM com
      // mensagem do cliente), então aqui só falta não deixar o limite geral (min > 120)
      // estourar sozinho nesse cenário específico.
      const ultimaMsg = mensagens.length ? ordenarPorHora(mensagens)[mensagens.length - 1] : null;
      const aguardandoCliente = !tEncerramento && !!ultimaMsg && ultimaMsg.remetente === 'escritorio'
        && pareceAguardandoCliente(ultimaMsg.texto);

      const estourouSilencio = !aguardandoCliente && min > T.LIMITES.promessa_resolucao;
      const status = (estourouSilencio || teveTrocaLenta) ? 'vermelho' : 'verde';
      relogios.push(montar('promessa_resolucao', respAposAceite, fim, min, emCurso, status, aguardandoCliente));
    }
  }

  // ── Relógio 4 — VEZ DO CLIENTE (ball in court) ──────────────────────────────
  // "De quem é a vez" no momento presente: se a última mensagem for do cliente
  // e o ticket não estiver encerrado, o cliente está aguardando -> relógio vivo.
  let vezCliente = null;
  if (!tEncerramento && mensagens.length) {
    const ult = ordenarPorHora(mensagens)[mensagens.length - 1];
    if (ult.remetente === 'cliente') {
      const min = T.minutosUteis(new Date(ult.hora), agora);
      vezCliente = montar('vez_cliente', new Date(ult.hora), agora, min, true);
    }
  }

  // ── Radar "Agora": o pior relógio que está EM CURSO ─────────────────────────
  const emCurso = relogios.filter(r => r.em_curso);
  if (vezCliente) emCurso.push(vezCliente);
  const radar = piorRelogio(emCurso);

  return {
    ticket_id: ticket.id,
    empresa: ticket.empresa_texto || null,
    relogios: vezCliente ? [...relogios, vezCliente] : relogios,
    radar, // o que está pegando fogo agora (ou null se tudo em ordem/encerrado)
  };
}

function montar(tipo, inicio, fim, minutos, emCurso, statusForcado = null, aguardandoCliente = false) {
  const limite = T.LIMITES[tipo] || null;
  const status = statusForcado || (limite ? T.statusSLA(minutos, limite) : 'neutro');
  return {
    tipo,
    rotulo: ROTULOS[tipo],
    inicio: new Date(inicio).toISOString(),
    fim: new Date(fim).toISOString(),
    minutos_uteis: minutos,
    limite,
    status,      // verde | amarelo | vermelho | neutro
    em_curso: !!emCurso,
    aguardando_cliente: !!aguardandoCliente, // true = escritório já respondeu, esperando o cliente se posicionar
  };
}

/** Escolhe o relógio mais grave (vermelho > amarelo > verde) e, no empate, o de maior tempo */
function piorRelogio(lista) {
  if (!lista.length) return null;
  const peso = { vermelho: 3, amarelo: 2, verde: 1, neutro: 0 };
  return [...lista].sort((a, b) => {
    const d = (peso[b.status] || 0) - (peso[a.status] || 0);
    if (d !== 0) return d;
    return b.minutos_uteis - a.minutos_uteis;
  })[0];
}

/**
 * "Trocas" — tempo de resposta do escritório em CADA turno do cliente ao
 * longo da conversa inteira, não só na primeira vez. Complementa os 5
 * relógios (que só olham a PRIMEIRA resposta de cada trecho — aceite e
 * departamento) com uma visão de "toda vez que a bola volta pro escritório,
 * quanto demora pra responder de novo".
 *
 * Regras:
 *  - Ignora mensagens 'sistema' (bot) — não contam como turno nem como resposta.
 *  - Um "turno do cliente" é o INÍCIO de uma sequência de 1+ mensagens dele
 *    (se manda 2 mensagens seguidas, conta só 1 turno, não 2).
 *  - Mede do início do turno até a próxima mensagem 'escritorio'. Se não
 *    respondeu ainda, em_curso=true e mede até `agora`.
 *  - Mesmo limite do relógio "departamento" (30 min úteis) — é o mesmo tipo
 *    de expectativa (analista responder), só que repetido a cada troca.
 * @param {Array} mensagens  [{ hora, remetente: 'cliente'|'escritorio'|'sistema' }]
 * @param {Date}  agora
 * @returns {Array} [{ inicio, fim, minutos_uteis, status, em_curso }]
 */
const LIMITE_TROCA = 30;

function calcularTrocas(mensagens, agora = new Date()) {
  const ordenadas = ordenarPorHora((mensagens || []).filter(m => m.remetente !== 'sistema'));
  const trocas = [];
  for (let i = 0; i < ordenadas.length; i++) {
    const m = ordenadas[i];
    if (m.remetente !== 'cliente') continue;
    if (i > 0 && ordenadas[i - 1].remetente === 'cliente') continue; // não é início de turno

    const prox = ordenadas.slice(i + 1).find(x => x.remetente === 'escritorio');
    const inicio = new Date(m.hora);
    const emCurso = !prox;
    const fim = prox ? new Date(prox.hora) : agora;
    const minutos = T.minutosUteis(inicio, fim);
    const status = T.statusSLA(minutos, LIMITE_TROCA);
    trocas.push({
      inicio: inicio.toISOString(),
      fim: fim.toISOString(),
      minutos_uteis: minutos,
      status,
      em_curso: emCurso,
    });
  }
  return trocas;
}

module.exports = {
  calcularSLA, calcularTrocas, ROTULOS, LIMITE_TROCA,
  pareceIntencaoTransferir, FRASES_TRANSFERENCIA,
  pareceAguardandoCliente, FRASES_AGUARDANDO_CLIENTE,
  detectarSinalChurn, FRASES_CHURN,
  detectarInsatisfacao, PALAVRAS_INSATISFACAO,
  classificarMotivo, MOTIVOS_ATENDIMENTO,
  classificarMotivoConversa, ehSaudacaoPura, ehMensagemSemConteudo, limparRuido, SAUDACOES_PURAS, extrairNomeSolicitado,
  palavrasFrequentes, STOPWORDS_PT,
};
