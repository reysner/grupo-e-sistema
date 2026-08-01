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
 */
const PALAVRAS_INSATISFACAO = [
  // ── Insatisfação / decepção genérica ────────────────────────────────────
  'insatisfeito', 'insatisfeita', 'descontente', 'desagradado', 'desagradada',
  'decepcionado', 'decepcionada', 'frustrado', 'frustrada', 'revoltado', 'revoltada',
  'indignado', 'indignada', 'irritado', 'irritada', 'chateado', 'chateada',
  'magoado', 'magoada', 'incomodado', 'incomodada',
  // ── Desespero ────────────────────────────────────────────────────────────
  'desesperado', 'desesperada', 'desespero', 'em panico', 'desesperador',
  'nao aguento', 'socorro', 'situacao critica', 'desesperante',
  // ── Desrespeito / maus-tratos ────────────────────────────────────────────
  'desrespeito', 'desrespeitado', 'desrespeitada', 'falta de respeito',
  'mal educado', 'mal educada', 'grosseiro', 'grosseira', 'humilhado', 'humilhada',
  'me tratou mal', 'fui mal tratado', 'fui mal tratada', 'sem educacao',
  // ── Erros (reclamação, não frase composta) ──────────────────────────────
  'erro grave', 'erro gravissimo', 'muitos erros', 'cheio de erros', 'errado de novo',
  'errado outra vez', 'errado mais uma vez', 'sempre errado', 'calculado errado',
  'guias erradas', 'guia errada', 'calculo errado', 'valor errado',
  // ── Juros / multa (prejuízo financeiro por erro do escritório) ─────────
  'juros e multa', 'juros por causa', 'multa por causa', 'multa por erro',
  'juros por erro', 'paguei multa', 'tive que pagar multa', 'gerou multa',
  'gerou juros', 'me cobraram multa', 'quem vai pagar', 'quem vai arcar',
  'vou ter que pagar', 'prejuizo financeiro', 'tive prejuizo', 'multa indevida',
  // ── Absurdo / inaceitável / descaso ─────────────────────────────────────
  'absurdo', 'inaceitavel', 'inadmissivel', 'descaso', 'incompetencia', 'incompetente',
  'vergonha', 'lamentavel', 'decepcao total',
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
 * dores dos clientes, por quais motivos somos acionados". Primeira versão
 * (rascunho meu, baseado no que é comum em escritório de contabilidade) —
 * é pra AJUSTAR com exemplos reais do Zappy, mesmo processo usado nas
 * listas de Churn e Insatisfação. Ordem importa: primeira categoria cuja
 * palavra bater é a escolhida (categorias mais específicas primeiro).
 */
const MOTIVOS_ATENDIMENTO = [
  {
    // Checado primeiro: padrão bem específico (baixo risco de falso
    // positivo) e não diz o ASSUNTO — o cliente já tem alguém de
    // confiança e prefere falar direto com essa pessoa. Casos reais
    // levantados pela Thais: "Quero falar com o Guilherme" / "...a Ivone"
    // / "...a Lilian" / "...a Thais". Ver extrairNomeSolicitado abaixo,
    // que tenta pegar QUEM foi pedido — dá pra ver quem os clientes mais
    // procuram por nome.
    chave: 'atendimento_especifico', label: 'Quer Falar com Alguém Específico',
    palavras: [
      'quero falar com', 'gostaria de falar com', 'poderia falar com',
      'preciso falar com', 'preciso conversar com', 'quero conversar com',
      'gostaria de conversar com', 'pode me passar com', 'me passa com',
      'falar com o', 'falar com a', 'passar para o', 'passar para a',
    ],
  },
  {
    chave: 'duvida_fiscal_tributaria', label: 'Dúvida Fiscal/Tributária',
    palavras: [
      'duvida sobre imposto', 'duvida tributaria', 'como funciona o imposto',
      'posso deduzir', 'enquadramento tributario', 'regime tributario',
      'qual imposto', 'tem que pagar imposto', 'duvida contabil',
    ],
  },
  {
    chave: 'guias_impostos', label: 'Guias e Impostos',
    palavras: [
      'guia de das', 'guia do simples', 'guia errada', 'guia atrasada', 'darf',
      'das vencido', 'das venceu', 'calculo do imposto', 'valor do imposto',
      'irpj', 'csll', 'icms', 'iss retido', 'pis cofins',
      'inss guia', 'gps', 'fgts guia', 'guia de recolhimento', '2 via da guia',
      'segunda via da guia', 'guia nao chegou', 'nao recebi a guia',
      'imposto errado', 'valor do das', 'das errado', 'guia do das',
      'imposto atrasado', 'imposto vencido', 'guia do imposto de renda',
      'guia veio errada', 'guia veio com valor errado', 'erro na guia',
      'a guia esta errada', 'guia chegou errada', 'guia com erro',
      'guia veio com o valor errado',
    ],
  },
  {
    chave: 'boletos_financeiro', label: 'Boletos e Financeiro',
    palavras: [
      'boleto', '2 via do boleto', 'segunda via do boleto', 'nota de honorario',
      'honorario atrasado', 'honorario em atraso', 'fatura', 'cobranca indevida',
      'pagamento nao caiu', 'comprovante de pagamento', 'valor cobrado',
      'desconto no boleto', 'parcelamento do honorario', 'atraso no pagamento',
      'boleto nao chegou', 'nao recebi o boleto',
    ],
  },
  {
    chave: 'folha_dp', label: 'Folha de Pagamento / DP',
    palavras: [
      'admissao', 'admitir', 'contratacao de funcionario', 'contratar funcionario',
      'novo funcionario', 'rescisao', 'demissao', 'ferias',
      'decimo terceiro', '13 salario', 'holerite', 'contracheque',
      'afastamento do funcionario', 'atestado medico', 'esocial',
      'fgts do funcionario', 'exame admissional', 'exame demissional',
      'folha de pagamento', 'vale transporte', 'vale alimentacao',
    ],
  },
  {
    chave: 'abertura_alteracao_empresa', label: 'Abertura/Alteração de Empresa',
    palavras: [
      'abertura de empresa', 'abrir empresa', 'alteracao contratual',
      'mudanca de endereco da empresa', 'mudar razao social', 'incluir socio',
      'retirar socio', 'alterar capital social', 'encerramento de empresa',
      'baixar empresa', 'baixa da empresa', 'mudanca de regime tributario',
      'enquadramento', 'abrir cnpj', 'segunda empresa', 'nova empresa',
    ],
  },
  {
    chave: 'certificado_digital', label: 'Certificado Digital',
    palavras: [
      'certificado digital', 'certificado vencido', 'certificado venceu',
      'renovar certificado', 'token vencido', 'e-cnpj', 'e-cpf', 'ecnpj', 'ecpf',
    ],
  },
  {
    chave: 'documentos_notas', label: 'Documentos e Notas Fiscais',
    palavras: [
      'nota fiscal', 'emitir nota', 'cancelar nota', 'nfse', 'nfe', 'xml da nota',
      'declaracao de imposto de renda', 'balanco', 'balancete',
      'relatorio contabil', 'extrato', 'contrato social', 'nao consigo emitir',
    ],
  },
  {
    chave: 'duvida_fiscal_tributaria', label: 'Dúvida Fiscal/Tributária',
    palavras: [
      'duvida sobre imposto', 'duvida tributaria', 'como funciona o imposto',
      'posso deduzir', 'enquadramento tributario', 'regime tributario',
      'qual imposto', 'tem que pagar imposto', 'duvida contabil',
    ],
  },
  {
    chave: 'prazos_obrigacoes', label: 'Prazos e Obrigações Acessórias',
    palavras: [
      'prazo de entrega', 'obrigacao acessoria', 'sped', 'dctf', 'dirf', 'rais',
      'caged', 'declaracao vencendo', 'vencimento da declaracao', 'qual o prazo',
    ],
  },
  {
    chave: 'erros_reclamacoes', label: 'Erros e Reclamações',
    palavras: [
      'calculado errado', 'valor errado', 'guia errada de novo', 'erro no calculo',
      'errado de novo', 'multa por erro', 'reclamacao', 'problema recorrente',
      'sempre errado', 'de novo errado',
    ],
  },
];

/**
 * Classifica a mensagem em um motivo de atendimento. Casamento por
 * substring (mesmo estilo de detectarInsatisfacao) — primeira categoria
 * que bater vence. Sem correspondência = {chave:'outros', ...} (não é
 * erro, só significa que essa mensagem não caiu em nenhuma categoria
 * ainda — sinal de que a lista precisa crescer).
 */
function classificarMotivo(texto) {
  const t = normalizarTexto(texto);
  if (!t) return { chave: 'outros', label: 'Outros / Não identificado' };
  for (const cat of MOTIVOS_ATENDIMENTO) {
    if (cat.palavras.some(p => t.includes(p))) {
      return { chave: cat.chave, label: cat.label };
    }
  }
  return { chave: 'outros', label: 'Outros / Não identificado' };
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
 * Classifica o MOTIVO DE ABERTURA olhando uma JANELA de mensagens do
 * cliente no início do ticket (não só a primeira) — descarta as que são
 * saudação pura antes de concatenar e classificar (a não ser que sobre só
 * saudação na janela toda, aí usa tudo mesmo, pra não ficar sem texto).
 * `textos` = array de strings, já na ordem cronológica (mais antiga primeiro).
 */
function classificarMotivoConversa(textos) {
  const lista = (textos || []).filter(t => t && String(t).trim());
  const substanciais = lista.filter(t => !ehSaudacaoPura(t));
  const usar = substanciais.length ? substanciais : lista;
  const combinado = usar.join(' ').slice(0, 800);
  return { ...classificarMotivo(combinado), trecho: combinado, pessoaSolicitada: extrairNomeSolicitado(combinado) };
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
  classificarMotivoConversa, ehSaudacaoPura, SAUDACOES_PURAS, extrairNomeSolicitado,
};
