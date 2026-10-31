# /cs — Rotas do radar de SLA, dashboards e Análise Inteligente (`server/cs/routes.js`)

Arquivo de 1.438 linhas montado em `/api/cs` (`server/index.js:86`, o **último** dos roteadores `/api/cs/*`). É a API "histórica" do módulo Sucesso do Cliente: radar de tickets, histórico, dashboards, comandos de manutenção da ingestão, os três painéis da **Análise Inteligente** (possíveis churns, insatisfação nas conversas, afastamento), motivos de abertura e a fila de **vínculos**. A engine (SLA, classificadores, ingestão) está nos arquivos 01 e 02; aqui estão as **rotas** e suas regras de negócio.

Níveis de certeza: [CONFIRMADO] · [INFERIDO] · [DÚVIDA].

## 1. Acesso

- `requireAuth` (JWT) em todas as rotas. Para os perfis `contabil` e `colaborador` o próprio `requireAuth` **bloqueia** qualquer rota que não esteja na lista de exceções (tickets, Minha Nota, Legalização, `/api/cs/painel…`, Financeiro, Qualidade, push): eles recebem 403 em `/api/cs/agora`, `/historico`, `/dashboard…`, `/vinculos…`. Ficam com acesso `administrador` e `usuario`. [CONFIRMADO] (`server/auth.js:119–135`).
- `requireAdmin` (só `administrador`) em tudo que dispara ingestão, recálculo ou muda dados das análises. **Sem** `requireAdmin` (basta ser `usuario`): `GET /agora`, `/historico`, `/filtros`, `/dashboard`, `/dashboard/etapas`, `/dashboard/motivos`, `GET /vinculos/pendentes` e `POST /vinculos/:id/confirmar`. Ou seja, o perfil `usuario` pode **confirmar vínculos** (empresa e tipo de um telefone), o que muda quem recebe pontuação na Gamificação. [CONFIRMADO]
- **Rede de proteção perigosa:** se `require('../auth')` falhar, o arquivo troca `requireAuth/requireAdmin` por funções que **deixam passar tudo** (aviso no log). Em produção `auth.js` existe, mas qualquer erro de importação deixaria as rotas abertas em vez de fechar. [CONFIRMADO] (linhas 50–57). Na portabilidade deve falhar fechado.

## 2. Mapa das rotas (27)

| Método e rota | Acesso | Regra / o que devolve |
| --- | --- | --- |
| `GET /agora` | login | radar: tickets com `em_risco = TRUE` e vínculo `tipo = 'cliente'`, ordem: `vermelho` > `amarelo` > outros, depois `updated_at DESC`. Colunas: `id, zappy_id, empresa_texto, empresa_nome, departamento, analista, status, pior_status, sla, abertura, updated_at` |
| `GET /historico?departamento&analista&status&etapa` | login | até **500** tickets mais recentes (`abertura DESC`). `status` filtra `pior_status`; com `etapa` (aceite, transferencia, departamento, promessa, `resposta_continua`) filtra o status **daquela etapa** (só relógios concluídos, `em_curso = false`) e devolve `etapa_status` por ticket |
| `GET /filtros` | login | departamentos e analistas distintos já vistos nos tickets |
| `GET /dashboard?period|ano&mes&analista` | login | `totalTickets`, `emRiscoAgora`, `porStatus` (sem problema em curso = **verde**, `COALESCE`), `porDepartamento` e `porAnalista` (top 15), `desempenhoAnalistas` (% verde, **mínimo 3 tickets**, pior primeiro, top 15), `anos` |
| `GET /dashboard/etapas` | login | por etapa: total, média de minutos úteis, verdes/amarelos/vermelhos, `pct`; só relógios concluídos e fora `neutro`; inclui `resposta_continua` (turnos do cliente após a transferência, `sla->'trocasPosTransferencia'`) e rankings por analista (`>= 3`) |
| `GET /dashboard/motivos` | login | motivo e **submotivo** de abertura por ticket (classifica até as **20 primeiras** mensagens do cliente, sem limite de tempo); `semExemploSuficiente` se há menos de 20 tickets |
| `POST /ingerir` | admin | dispara a ingestão agora (síncrono) |
| `GET /diagnostico?ticketId[&mensagens=1]` | admin | testa o Zappy com `GET /tickets/:id` (e mensagens ao vivo) |
| `POST /backfill?dias=90` | admin | carga retroativa (1 a 365 dias) em segundo plano; trava `backfillEmAndamento` (409) |
| `POST /reingerir` | admin | reingere por `zappy_ids[]` **ou** `analista_id + mes (AAAA-MM)` (inclui quem transferiu); progresso em memória |
| `GET /reingerir/status` | admin | `{ emAndamento, progresso }` |
| `POST /atualizar-notas?dias=5` | admin | rebusca a nota de tickets fechados nos últimos `dias` (1 a 60) ainda sem avaliação; roda sozinho todo dia (D-1) via `rodarAtualizacaoNotasCS` (index.js) |
| `POST /recalcular-sla` | admin | recalcula os relógios de **todos** os tickets salvos (ou de um `mes`) sem chamar o Zappy; necessário depois de mudar a fórmula; pode levar mais de 1 h |
| `GET /recalcular-sla/status` | admin | somente leitura (existe porque chamar o POST de novo disparava outro recálculo sem querer) |
| `GET /churn-conversas?dias=180` | admin | **possíveis churns nas conversas** (seção 4.1; antes se chamava `/churn` e era inalcançável, corrigido em 30/10/2026, commit `4299be9`) |
| `POST /churn/:ticketId/tratar` | admin | marca o ticket como revisado |
| `GET /insatisfacao-conversas?dias=180` | admin | uma linha por mensagem com sinal de insatisfação |
| `POST /insatisfacao-conversas/:mensagemId/tratar` | admin | marca a mensagem como revisada |
| `GET /motivos?dias=180` | admin | motivos de abertura **por empresa** + resumo e palavras mais frequentes de "Outros" |
| `GET /afastamento` | admin | clientes ativos sem mensagem recente |
| `POST /afastamento/:clienteId/tratar` | admin | acompanha o cliente por até 30 dias |
| `GET /tratados?dias=365` | admin | histórico do que já foi tratado nos três painéis |
| `GET /vinculos/buscar?q=` | admin | busca vínculos por nome (qualquer status), máx. 50; 400 sem `q` |
| `GET /vinculos/pendentes` | login | fila de de-para aguardando confirmação (`listarPendentes`) |
| `POST /vinculos/recalcular` | admin | recalcula a sugestão de todo vínculo pendente com a carteira atual (não confirma nada) |
| `POST /vinculos/:id/confirmar` | login | confirma `{ clienteId, empresaNome, cnpj, tipo }`; 404 se não existe; 400 com a mensagem de validação |
| `GET /vinculos/analise-pendentes` | admin | **temporária** (comentário: "remover depois de usar"): classifica pendentes por troca real de mensagens |

Filtros de data comuns (`/dashboard*`): `period = hoje | semana | mes` (hoje desde 00:00 do **servidor**; semana = últimos 7 dias; mês = desde o dia 1) **ou** `ano` + `mes` numéricos; `todos` ou valor desconhecido = sem filtro. Sempre pela data de **abertura**. `intervaloPorPeriod` usa a hora do servidor (UTC no Render), não Brasília: "hoje" começa às 21h do dia anterior em Brasília. [INFERIDO]

## 3. Trabalhos em segundo plano e travas

Cinco travas em **memória do processo** (`backfillEmAndamento`, `reingestaoEmAndamento`, `recalculoSlaEmAndamento`, `atualizacaoNotasEmAndamento`, mais o progresso): evitam duplo clique, mas não protegem se houver mais de uma instância nem após reinício (o trabalho morre com o processo). O progresso exibido por `/status` também some no reinício. [CONFIRMADO]

## 4. Análise Inteligente — os três painéis

Todos ficam em **Análise Inteligente** (`public/js/app.js`, objeto `AnaliseInteligente`), nas páginas `/`.

### 4.1 Possíveis churns nas conversas (`GET /churn-conversas`)

Varre as mensagens do **cliente** dos últimos `dias` (1 a 365, padrão 180; `LIMIT 100000` mensagens), exclui tickets já tratados (`cs_churn_tratamentos`), e aplica `detectarSinalChurn` (frases como "vou procurar outra contabilidade", lista `FRASES_CHURN` do `slaEngine.js`, sem IA). Agrupa por empresa (nome do vínculo > nome do contato > telefone), guarda a ocorrência mais recente e até **20** `detalhes` por empresa; ordena pela mais recente. Tratar (`POST /churn/:ticketId/tratar`) grava `cs_churn_tratamentos (ticket_id UNIQUE, motivo, tratado_por, tratado_em)` e tira o **ticket** da lista para sempre.

> **Bug histórico, CORRIGIDO em 30/10/2026 (commit `4299be9`).** Desde o commit `03d024d` ("Churn por saídas…"), `server/index.js:75` monta `app.use('/api/cs/churn', churnSaidas.router)` **antes** de `/api/cs`. O `GET /` do roteador de saídas respondia a `GET /api/cs/churn?dias=180` e nunca chamava `next()`, então a antiga rota `GET /churn` deste arquivo **nunca executava**: a tela recebia `{ padroes, periodos, … }`, lia `const { data } = …` → `undefined` e mostrava sempre "Nenhum sinal de churn encontrado nas conversas dos últimos 180 dias". Correção: a rota virou `GET /api/cs/churn-conversas` e a chamada em `app.js` (agora `?v=2026103003`) foi ajustada. O `POST /churn/:ticketId/tratar` nunca foi afetado (churnSaidas não tem essa rota; a requisição cai neste arquivo) e manteve o endereço. Verificado por carga do módulo (as duas rotas não colidem) e checagem de sintaxe; **não testado na tela em produção**, e não há teste automatizado da rota. Depois de meses sem funcionar, a primeira abertura pode listar muitos sinais de uma vez.

### 4.2 Insatisfação nas conversas (`GET /insatisfacao-conversas`)

Cobre **todas** as mensagens do cliente (não só pesquisas): `detectarInsatisfacao` (lista `PALAVRAS_INSATISFACAO`: insatisfação, desespero, desrespeito, erro, juros/multa). **Uma linha por mensagem**, não por empresa, até **500** linhas. Tratar é por **mensagem** (`cs_insatisfacao_tratamentos (mensagem_id UNIQUE)`), porque um ticket pode ter várias insatisfações em momentos diferentes. Histórico: o `LIMIT` de 5.000 mensagens cobria só 8–9 dias; subiu para 100.000 para realmente cobrir 180 dias (achado do Reysner).

### 4.3 Afastamento (`GET /afastamento`)

Para cada cliente **ativo**: dias desde a última mensagem **que ele** mandou no Zappy (via vínculo `tipo = 'cliente'`); `sem_historico` se nunca houve mensagem (pode ser cliente de antes do Zappy); `dias_desde_entrada`. **Tratado** (`cs_afastamento_tratamentos (cliente_id UNIQUE → clientes(id))`) some da lista por **até 30 dias** ou até o cliente voltar a escrever (o que vier primeiro). Ordem: alfabética por empresa (pedido do Reysner; antes era do mais afastado). Colunas devolvidas incluem regime tributário, grupo e unidade.

### 4.4 Motivos de abertura (`GET /motivos`, `/dashboard/motivos`)

`classificarMotivoConversa(textos)` (em `slaEngine.js`) olha até **20** mensagens do cliente no início do ticket, ignora saudações puras e devolve `motivo` + `submotivo` (ex.: motivo "Guias e Impostos" / submotivo "Recálculo de Guia") + `pessoaSolicitada` quando o cliente pede alguém. A categoria "Quer falar com alguém específico" só vence se nenhum motivo concreto aparecer na janela. `GET /motivos` agrupa por empresa (até 30 tickets de detalhe), com `motivoPrincipal`, e devolve `percentOutros` e as 20 `palavrasNaoClassificadas` para calibrar a lista. [CONFIRMADO]

### 4.5 Relatório de tratados (`GET /tratados`)

Une as três tabelas de tratamento (churn, insatisfação, afastamento) com o contexto original (ticket, mensagem, cliente), até 1.000 por tipo, na janela `dias` (1 a 3650, padrão 365), mais recente primeiro. Cada item traz `tipo` ∈ `churn | insatisfacao | afastamento`, `motivo`, `tratado_por`, `tratado_em`.

### 4.6 Tabelas criadas "na hora"

`cs_churn_tratamentos`, `cs_insatisfacao_tratamentos` e `cs_afastamento_tratamentos` nascem com `CREATE TABLE IF NOT EXISTS` **dentro dos handlers** a cada requisição (erro silenciado com `.catch(() => {})`). Sem `ROW LEVEL SECURITY` (ao contrário das tabelas novas das cargas, arquivos 07 e 08). `cs_afastamento_tratamentos.cliente_id UUID REFERENCES clientes(id)` confirma que `clientes.id` é UUID, enquanto `cs_vinculos.cliente_id` guarda o id como **texto** (`cli.id::text = v.cliente_id`). [CONFIRMADO]

## 5. Vínculos (fila de de-para) — rotas

Lógica de similaridade e confirmação no arquivo 01 (`vinculos.js`, `depara.js`). Rotas: `pendentes` (qualquer logado), `buscar` (admin: corrigir uma classificação já confirmada, ex.: fornecedor marcado como cliente), `recalcular` (admin: a fila de 874 pendentes tinha vindo sem sugestão porque foi criada com a carteira vazia), `confirmar`. `analise-pendentes` classifica cada telefone pendente: `sem_ticket` (órfão), `provavel_cliente_real` (houve mensagem do cliente **e** do escritório), `provavel_bot_marketing` (escritório nunca respondeu) ou `indefinido`. O campo `cs_mensagens.autor` **nunca é preenchido** na ingestão atual, por isso só se distingue `remetente` (`cliente`, `escritorio`, `sistema`). [CONFIRMADO]

## 6. Pontos de atenção

1. ~~Rota de churn por conversas morta~~ — corrigida (seção 4.1). Lição para a portabilidade: dois roteadores no mesmo prefixo (`/api/cs/churn`) sem erro nem aviso; vale um teste que liste as rotas montadas e acuse colisão.
2. **Autorização:** `usuario` confirma vínculos; confirmar um telefone como `cliente` faz seus tickets passarem a pontuar na Gamificação (arquivo 02). Convém registrar essa ação no log de atividades (hoje só Qualidade, Acessos e Analistas são registrados).
3. **Falha aberta** do `require('../auth')` (seção 1).
4. **Fuso:** `period=hoje` e `mes` usam o relógio do servidor (UTC), enquanto os demais módulos usam `America/Sao_Paulo`.
5. Consultas pesadas sem índice documentado: `LIMIT 100000` mensagens por chamada de churn/insatisfação, janelas `ROW_NUMBER()` de 20 mensagens por ticket em `/motivos`. [INFERIDO] custo cresce com o volume do Zappy.
6. Rota **temporária** `vinculos/analise-pendentes` continua exposta (admin).
7. As travas de trabalho em segundo plano são locais ao processo (seção 3).
