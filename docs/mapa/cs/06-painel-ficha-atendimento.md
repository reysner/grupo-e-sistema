# /cs — Painel (base de clientes), ficha do cliente e módulo Atendimento

Cobre `server/cs/painel.js` (357 linhas), montado em `/api/cs/painel` (`server/index.js:85`, por último, depois de todos os sub-roteadores `/api/cs/painel/...`). É o **agregador**: junta Risco (arquivo 04), Categorias e Churn (arquivo 05), Questor, regime tributário, reclamações e e-mails, e entrega tudo já calculado à tela `public/cs-painel.html` + `public/js/cs-painel.js`.

Níveis de certeza: [CONFIRMADO] · [INFERIDO] · [DÚVIDA].

## 1. Acesso e mascaramento de valores

- **Camada 1 (módulos):** `app.use('/api/cs/painel', acessos.restringir(lerPayload))` (index.js:68): quem tem módulos definidos em **Acessos** só passa nas rotas dos módulos dele (arquivo `00-base-acesso.md`).
- **Camada 2 (`soEquipe`)**: passa `administrador`, `usuario` **ou** quem tem a flag `acessoCs`. Contábil e colaborador sem flag recebem 403: "Acesso restrito à equipe do Sucesso do Cliente." O comentário do cabeçalho diz "administrador e usuário", mas o código também aceita `acessoCs`. [CONFIRMADO]
- **RN-PAI-001 Perfil `usuario` não vê R$** (decisão de 08/10/2026): o **servidor** zera `honorario`, `questor.faturamento`, valores de títulos (`valor_aberto`, `valor_atrasado`, `valor_doc`) e troca por `R$ ••••` os trechos `honorário R$ …` / `empresas: R$ …` do texto da categoria. Só `administrador` recebe valores (`veValores(role) = role === 'administrador'`); o administrador pode ocultá-los na tela para apresentações (isso é só visual). Quem tem apenas `acessoCs` também cai no modo mascarado. [CONFIRMADO]
- Os detalhes de risco (`risco.detalhes`) **não carregam R$** (o valor em atraso é só entrada do cálculo), então a máscara não precisa cobri-los. [CONFIRMADO] (grep em `riscoCalculo.js`).

## 2. Base de clientes (`montarBase` / `calcularBase`)

Construída **uma vez** e reutilizada:

| Item | Fonte | Detalhe |
| --- | --- | --- |
| clientes ativos | `clientes WHERE status = 'ativo'` (`id, nome_empresa, cnpj, grupo_empresas, unidade, data_entrada`) | |
| risco | `risco.calcularTodos({ detalhes: true })` | arquivo 04 |
| categoria | `categorias.calcularCategorias()` | arquivo 05 |
| reclamações 30 d | `insatisfacoes` (por CNPJ só dígitos, `created_at` ≥ 30 d) **+** `cs_tickets` de vínculo `cliente` com `nota_avaliacao <= 2` e revisão ≠ `indevida` | se a coluna de revisão não existir, repete a consulta sem ela |
| contratos suspensos | `MAX(omie_contratos_suspensos.atualizado_em)` em `America/Sao_Paulo` | só para mostrar "lido em" |
| Questor | `questorDados.carregar()` | faturamento 12 meses e funcionários |
| regime tributário | `gestao_clientes.regime_tributario` mais recente por CNPJ (`DISTINCT ON`, `created_at DESC`) | vazio se a coluna não existir |

- **RN-PAI-002 Só CNPJ na lista principal.** Cliente cujo documento não é CNPJ (`ehPessoaJuridica`) é pulado; os **outros** (CPF, CAEPF, CNO; sem documento fica de fora) vão para `clientes_outros`, **sem termômetros de risco**, usados só na **Análise Inteligente** (pedido de 09/10/2026, com filtro por tipo de documento). Cada item recebe `tipo_doc`.
- **RN-PAI-003 Ordenação:** risco em pontos, do maior para o menor; sem pontos (`null`) vão **primeiro** (peso −1); desempate por nome (`localeCompare`).
- **RN-PAI-004 Totais:** `clientes`, `desconsiderados_nao_cnpj`, `sem_reclamacao_30d`, resumo de risco por nível (`Alto, Médio, Baixo, Incompleto, Suspenso`), `suspensos`, `suspensos_lidos_em`, `questor_periodo`, `questor_lido_em`, `categorias` (+ `sem_categoria`), `operacional_lido`, e por termômetro (`financeiro, atendimento, operacional, tratativas`): `com_dado`, `sem_dado`, `em_alerta` (≥ corte Alto) e `medio_ou_mais` (≥ corte Médio). **Suspensos ficam fora** das estatísticas de termômetro.
- **Cache:** 60 s (`TTL_MS`) na memória do processo; chamadas simultâneas **dividem o mesmo cálculo** (`_emAndamento`). A ficha e o módulo Atendimento aceitam base de até **10 min** (`TTL_FICHA_MS`) para não recalcular a carteira só para abrir um cliente. `invalidarCache()` (usado quando uma ocorrência de Qualidade é excluída, cancelada, reaberta ou encerrada) zera o cache e incrementa `_geracao`; um cálculo que terminou **depois** da invalidação não grava o resultado velho. [CONFIRMADO] **Limite:** o cache é por processo; com mais de uma instância no Render cada uma teria o seu. [INFERIDO]

## 3. Endpoints (`/api/cs/painel`)

| Método e rota | O que devolve |
| --- | --- |
| `GET /dados[?forcar=1]` | base completa + `usuario {nome, papel}` + `churn { padroes, periodos (todos os presets), evolucao (12 meses: mes, base, saidas, taxa) }`. `forcar=1` ignora o cache. Aplica a máscara de valores se o papel não é administrador |
| `GET /churn?ini&fim` | churn de período livre; 400 se não for `AAAA-MM-DD` ou se `ini > fim`: "Informe ini e fim no formato AAAA-MM-DD, com ini <= fim." |
| `GET /atendimentos` | **módulo Atendimento**: uma linha por cliente (inclui `clientes_outros`) com `atendimentos`, `sla_vermelho`, `notas_baixas`, `ultimo` (180 dias, Zappy) e e-mails (`recebidos, sem_resposta, destinatarios` e o par `comp_*` = compartilhado) |
| `GET /atendimento/:id` | até 500 tickets de 180 dias do cliente (`abertura, departamento, analista, status, nota_avaliacao, pior_status`) + e-mails por destinatário; 404 se o cliente não está ativo |
| `GET /cliente/:id` | **ficha** (seção 4); 404 se não for CNPJ ativo |
| `GET /cliente/:id/acessorias` | obrigações em aberto/atrasadas, lidas **na hora** do Acessórias (janela 90 dias); 503 sem token; 502 se o Acessórias falhar |

## 4. Ficha do cliente (`GET /cliente/:id`)

Campos: `cliente` (a linha da base), `proximo_passo`, `financeiro` (`financeiro_aberto` por unidade), `titulos` (`financeiro_titulos` em aberto, um a um, por vencimento), `tickets` (90 d, até 30), `insatisfacoes` (180 d, até 20), `sensiveis` (`clientes_sensiveis`, 90 d, até 20), `pesquisas` (180 d, até 10: `nps, csat, ces, pontos`), `entregas` (`cliente_entregas_resumo`), `emails` (`{ sinais: cs_email_sinais, historico: cs_email_atendimento }`, ausente se nenhum job rodou).

- **RN-PAI-005 "Próximo passo"** (`proximoPasso`): nível `Baixo` ou `Incompleto` → "Sem ação por enquanto: acompanhar nas próximas semanas." `Suspenso` → texto de cobrança (regularizar com o financeiro e reativar o contrato no Omie). Senão o **termômetro com mais pontos** decide (empate: ordem financeiro, atendimento, operacional, tratativas):
  - financeiro: "Combinar a regularização com o financeiro: N título(s) em atraso. Reportar o retorno do cliente na reunião de segunda." (ou texto genérico se não há título);
  - atendimento: "Ligar para o cliente: houve falha de atendimento…";
  - tratativas: "Cobrar o responsável pela tratativa…";
  - operacional: "Conferir com a equipe responsável as entregas atrasadas ou vencidas no Acessórias…".
  A checagem de `Suspenso` vem **depois** do teste `Baixo`; como suspenso nunca tem nível Baixo/Incompleto, funciona, mas um suspenso sem pontos usa o texto de suspensão normalmente. [CONFIRMADO]
- **Fotos de e-mail:** `cs_email_sinais` (leitura semanal, 14 dias: `mensagens_recebidas, aguardando_4h/24h/48h/7d, aguardando_compartilhado, mais_antigo_h, provaveis_encerramentos`) e `cs_email_atendimento` (histórico de 180 dias). Detalhe no arquivo do módulo de e-mails.

## 5. Churn dentro do painel

- `enxuto()` reduz cada saída a `id, nome, cnpj, data_entrada, data_saida, tipo, origem, na_base, motivo_churn, motivo_saida` e soma `menos_de_90_dias` (saídas em que `data_entrada + 90 dias >= data_saida`).
- `ultimosMeses(hoje, 12)`: lista de 12 meses terminando no atual (o mês corrente vai só até hoje); para cada um o painel calcula base, saídas contadas e taxa — **12 chamadas a `calcularChurn` por abertura do painel**, sobre a lista completa de clientes. [CONFIRMADO]

## 6. Pontos de atenção

1. **`consultar()` engole erros**: tabela ou coluna ausente vira lista vazia e só deixa `console.warn`. Isso mantém a tela de pé, mas esconde esquema quebrado (ex.: se `gestao_clientes.regime_tributario` for renomeada, o regime some sem alarme). [CONFIRMADO]
2. `/dados` roda `risco.calcularTodos` + `categorias.calcularCategorias` + 12 cálculos de churn sem paginação; com carteira grande o primeiro acesso após o cache expirar é o mais lento. [INFERIDO]
3. `proximoPasso` é texto fixo em português dentro do código; mudar o roteiro exige deploy.
4. A ficha `GET /cliente/:id/acessorias` faz chamada externa a cada abertura (sem cache): custo e limite de taxa do Acessórias. [INFERIDO]
5. Documento cita "administrador e usuário" mas `soEquipe` também aceita `acessoCs`; a máscara de valores usa só `role` (não `acessoCs`). [CONFIRMADO]
