# SPA `/` — o sistema principal (clientes, atendimentos, gestão, tickets, administração)

Cobre `public/index.html` (1.500 linhas), `public/js/app.js` (11.030 linhas), `public/css/app.css`, o Portal Contábil (`public/contabil.html`), a pesquisa pública (`public/pesquisa.html`), `public/reset-password.html` e a API `/api/data/*` do arquivo `server/routes/data.js` que **não** é Gamificação, Legalização nem Financeiro (essas têm documento próprio: [gamificacao.md](gamificacao.md), [legalizacao.md](legalizacao.md), [financeiro.md](financeiro.md)). Login, perfis, backups e rotinas: [nucleo.md](nucleo.md).

Níveis de certeza: [CONFIRMADO] (lido no código) · [INFERIDO] · [DÚVIDA].

> **Profundidade desta parte.** Li por completo as rotas, as regras de servidor, os formulários e o menu. O `app.js` tem 11 mil linhas de interface montada por texto; descrevi cada módulo pelo que ele envia, calcula e mostra (campos, listas, filtros, botões), **sem reproduzir cada rótulo e cada estilo**. Qualquer tela nova ou alterada entra na próxima atualização do documento.

## 1. Estrutura da aplicação

Página única (`index.html`) com `section.page` por módulo, trocadas por `Nav.go(página)`; sem framework nem etapa de build. Módulos do `app.js`: `App` (sessão, `API`, `Util`, `Toast`, `Modal`, `Nav`, `Forms`), `Dashboard`, `Perfil`, `Notificacoes` (sino), `Relatorio`, `BuscaGlobal`, `Log`, `DarkMode`, `UserMenu`, `Pesquisas`/`PesquisasGrid`, `Carteira`, `Atendimento`, `Gestao`, `Recuperacao`, `Insatisfacao`, `Sensiveis`, `CAC`, `Legalizacao` (administração), `Financeiro` (tela antiga), `Gamificacao` (administração), `Tickets`. Bibliotecas externas: Chart.js (cdnjs) e SheetJS `xlsx 0.18.5` (cdnjs) para importar planilha; `pptxgenjs` só na apresentação da Gamificação.

- **Sessão:** tokens em `localStorage` (`ge_token`, `ge_refresh`, `ge_user`); a camada `API.request` renova o token quando o servidor responde `token_expired` e deslogga se a renovação falha. Ao entrar, `contabil` é levado a `/contabil` e `colaborador` a `/minha-nota` (que redireciona para o /cs).
- **Quem vê o quê:** a classe `admin-only` esconde as telas de Carteira, CAC, Legalização, Financeiro, Gamificação, Tickets, Sucesso do Cliente, Análise Inteligente e Log para quem não é administrador. **Isso é só visual**: quem decide é cada rota do servidor, e várias delas aceitam qualquer usuário logado (seção 8).
- **Modo escuro** (`DarkMode`), menu do usuário, **busca global** (mínimo 2 caracteres; até 5 resultados por módulo em atendimentos, gestão, insatisfações, sensíveis, recuperações e carteira) e **Relatório Executivo** (administrador).

## 2. Menu e módulos

| Menu | Quem vê na tela | Para quê |
| --- | --- | --- |
| Dashboard | todos | indicadores gerais com filtro de período e de analista procurado; botão do Relatório Executivo |
| Atendimento | todos | registrar e consultar atendimentos |
| Gestão de Clientes | todos | solicitações de entrada, saída e baixa; indicadores de retenção |
| Insatisfação · Clientes Sensíveis · Recuperação de Experiência | todos | registro de ocorrências de relacionamento |
| Pesquisas | todos | respostas de satisfação (NPS, CSAT, CES) |
| Carteira · CAC | administrador | clientes, honorários, MRR, investimentos e CAC |
| Legalização · Financeiro · Gamificação | administrador | telas de administração (a Gamificação é a principal; Legalização e Financeiro têm páginas próprias `/legalizacao` e `/financeiro`) |
| Tickets | administrador | tickets de baixa e saída entregues ao time contábil |
| Sucesso do Cliente | administrador | radar de SLA, histórico de atendimentos do Zappy e fila de vínculos pendentes |
| Análise Inteligente | administrador | churn por palavras-chave, sentimento, afastamento, motivos de abertura |
| Log de Atividades | administrador | histórico de ações |
| Administração | administrador (o item de menu é `admin-only`; a seção da página não tem a marca, mas todas as rotas exigem administrador) | usuários e backups |
| Meu Perfil | todos | nome, e-mail e senha |

Cada módulo de registro (Atendimento, Gestão, Insatisfação, Sensíveis, Recuperação, Pesquisas) tem **formulário no alto, filtro por ano, mês e (quando existe) status, exportação CSV/PDF e "Limpar Registros" (administrador)**.

## 3. Regras de negócio por módulo

### 3.1 Atendimento (`atendimentos`)
Campos: Analista Responsável, Nome do Cliente, CNPJ, Empresa, **Departamento Solicitado** (Comercial, Contábil, Financeiro, Fiscal, Legalização, Pessoal, Sucesso), **Analista Procurado** (lista canônica `analistas`), **Demanda do Cliente** (lista fixa de demandas com o departamento entre parênteses, ex.: "13º Salário (Folha de pagamento)", mais "Outra"), Resumo da Demanda. `POST /atendimentos` exige analista, cliente, CNPJ, empresa, departamento, procurado e demanda. `GET` devolve todos os registros, filtrados por período. O Dashboard agrupa por empresa, departamento, analista procurado e demanda.

### 3.2 Gestão de Clientes (`gestao_clientes`, `clientes`)
Solicitações: **Baixa de empresa**, **Cliente vindo de outro contador**, **Constituição de empresa**, **Saída de empresa**, **Transformação de empresa**, **Outro**. São de **entrada** (`SOLICITACOES_ENTRADA`): Constituição de empresa, Cliente vindo de outro contador e Transformação de empresa; de **saída**: Saída de empresa e Baixa de empresa. Campos: Analista, Solicitação, CNPJ, Empresa, Código do cliente, Grupo de Empresas e Unidade (listas canônicas), Data da Solicitação e Fim da Competência (**não obrigatórios nas entradas**), Canal da Solicitação, Regime Tributário; para entrada, **Honorário Inicial**, **Origem do Cliente** e **Data de Entrada**; para saída/baixa, **Data de Encerramento** e **Motivo do Churn** (lista de motivos).
- **RN-SPA-001 Criação manual — a regra mora no navegador, em chamadas encadeadas e sem transação:** (1) se a solicitação é de **entrada** e há honorário inicial, o formulário chama `POST /clientes` (CAC do mês calculado por `GET /cac/dashboard`, tipo de entrada = a solicitação); (2) se é **Baixa ou Saída**, busca o cliente ativo pelo CNPJ e chama `PATCH /clientes/:id/encerrar` com a data de encerramento e o **Motivo do Churn** (ou o nome da solicitação) como `motivo_saida`; (3) só então `POST /gestao` grava a linha de Gestão (analista, solicitação, CNPJ, empresa, datas, canal, regime, código); (4) para Baixa ou Saída, o **administrador** é perguntado se quer abrir um **ticket** (seção 3.7). Motivo do Churn é obrigatório só em "Saída de empresa"; Data de Entrada é obrigatória nas entradas. Para quem **não é administrador** o passo (2) responde 403 e o formulário não avisa: a linha de Gestão é gravada, mas o cliente continua ativo. O passo (1) funciona para qualquer usuário. Se uma chamada falha no meio, as anteriores ficam gravadas. [CONFIRMADO]
- **RN-SPA-002 Importar planilha** (`POST /gestao/importar`, só administrador; arquivo `.xlsx/.xls/.csv` lido no navegador com SheetJS, modelo em `/modelos/modelo_importacao_gestao_clientes.xlsx`): exige Analista, Solicitação, CNPJ, Empresa, Data, Competência, Canal e Regime. **Entrada** sem cliente ativo com o CNPJ → cria o cliente (calcula o CAC do mês: investimento do mês ÷ clientes que entraram no mês), grava honorário inicial e evento `entrada`; exige honorário inicial e data de entrada. **Qualquer** solicitação com CNPJ de cliente ativo → atualiza grupo, unidade, marca de inadimplente crônico e, se veio valor novo, **insere novo honorário** + evento `reajuste` (nunca duplica). **Saída/Baixa** → encerra o cliente ativo com aquele CNPJ (`status = encerrado`, `data_saida`, `motivo_saida`, evento `saida`). Linha inválida vai para `erros` sem travar as outras; a resposta traz `processados`, `avisos`, `erros`.
- **RN-SPA-003 Importar do Acessórias** (botão, `POST /clientes/importar-acessorias`) e a rotina diária chamam a mesma `sincronizarAcessorias` (seção 3.9).
- A lista mostra **faixa de ticket** (acima, na média, abaixo, com banda fixa de R$ 50 sobre o ticket médio dos ativos), filtros por grupo, unidade, faixa, situação (ativas, inativas, todas) e solicitação, e o **ticket médio por unidade**.

### 3.3 Insatisfação (`insatisfacoes`) · Sensíveis (`clientes_sensiveis`) · Recuperação (`recuperacoes`)
- **Insatisfação:** gravidade em 5 níveis (Muito Alta, Alta, Média, Baixa, Muito Baixa), **Área** (Comunicação, Qualidade do Serviço, Prazo, Atendimento, Financeiro, Fiscal/Tributário, Tecnologia/Acesso, Outro) e **Tipo** que depende da área (lista em cascata; "Outro" abre texto livre), analista reclamado e descrição. **Ciclo de vida:** `aberta` → `em_andamento` → `resolvida` (`PATCH /insatisfacoes/:id/status`, qualquer usuário logado). Gravidade **Alta ou Muito Alta** dispara no navegador uma notificação do sino ("Insatisfação X registrada").
- **Sensíveis:** "O que o cliente demonstrou" (Irritabilidade, Cobranças Recorrentes, Problemas Financeiros, Reclamações Repetidas, Outro), gravidade e detalhe.
- **Recuperação:** gravidade, o que o cliente demonstrou após a solução e vínculo opcional com a insatisfação que está sendo resolvida (`insatisfacao_id`, ligação lógica sem chave estrangeira).
Esses três alimentam o Risco do /cs (arquivo 04 do /cs) e o churn legado (seção 3.8).

### 3.4 Pesquisas (`pesquisas`)
Três perguntas: **NPS** (0 a 10), **CSAT** (1 a 5, "Muito insatisfeito" a "Muito satisfeito") e **CES** (1 a 5, "Muito difícil" a "Muito fácil"), mais comentário livre (`pontos`). Entrada: (a) o analista registra pela tela; (b) o **cliente responde sem login** em `/pesquisa` (`POST /api/public/pesquisa`, valida intervalos, grava com o primeiro administrador como dono e `analista = 'Pesquisa Pública'`, `cnpj` vazio). Na lista, o administrador marca **Tratada** (`PATCH /pesquisas/:id/tratado`, que o servidor aceita de qualquer usuário logado).

### 3.5 Carteira (`clientes`, `honorarios`, `eventos_clientes`)
- **Honorário vigente** = linha de `honorarios` com a maior `data_vigencia`; o histórico nunca é sobrescrito (reajuste = nova linha + evento).
- **Receita acumulada** = soma, para cada linha de honorário, de (meses entre a vigência e a próxima vigência, ou a saída, ou hoje) × valor; **meses sem reajuste** = meses desde a última vigência.
- Ações do administrador: editar cadastro (`PATCH /clientes/:id`: nome, CNPJ, código, regime, origem, grupo, unidade, data de entrada), **atualizar honorário** (`POST /clientes/:id/honorario`), **encerrar** (`PATCH …/encerrar`, sem validação além de administrador), **completar entrada** de cliente vindo do Acessórias (tipo de entrada, honorário inicial, origem, data; troca a solicitação genérica pela real em Gestão e marca o aviso como lido), **Reajuste em Massa** (`POST /clientes/reajuste-em-massa`: percentual ≠ 0 e data de vigência; aplica a **todos os ativos com honorário > 0**, arredondando a centavos, uma linha de honorário e um evento `reajuste` por cliente; a tela tem prévia), excluir um cliente e **excluir a Carteira inteira** (exige digitar `EXCLUIR TODOS OS CLIENTES`).
- Colunas da tabela: código, empresa, CNPJ, regime, honorário, receita acumulada, tempo, **categoria** (`GET /api/cs/categorias`), **risco** (`GET /api/cs/risco`) e status; botões **🏅 Categorias**, **⚠️ Risco** e **Ver saídas e regra** (churn por saídas, `GET /api/cs/churn`).
- **Dashboard da Carteira** (`GET /carteira/dashboard`): MRR (soma dos honorários vigentes dos ativos), ARR (MRR × 12), ativos, encerrados, ticket médio, **retenção média** em meses (média de `data_saida − data_entrada` dos encerrados; 48 se não houver) e **LTV projetado** = ticket médio × retenção, mais a data da última leitura do Omie por unidade.

### 3.6 CAC e investimentos (`investimentos`)
Administrador lança **investimento por mês e canal** (valor, descrição, recorrente; ao editar guarda o `valor_original`). `GET /cac/dashboard?mes=`: total investido, melhor canal, **clientes adquiridos = clientes ATIVOS cuja entrada foi naquele mês** (quem já saiu não conta), **CAC = investimento ÷ clientes adquiridos** e **LTV = honorário médio × 48 meses**, **LTV/CAC** com 1 casa. Atenção: este LTV (48 meses fixos) **difere** do LTV da Carteira (retenção média real).

### 3.7 Tickets contábeis (`tickets`, `ticket_interacoes`, `ticket_mencoes`)
Ticket de **Baixa de empresa** ou **Saída de empresa** com **checklist por regime**: Baixa: Simples = Balanço, DRE, DEFIS, REINF; Presumido/Real = Balanço, DRE, ECD Baixa, ECF Baixa, DEFIS, REINF. Saída: Simples = Balanço, DRE, REINF; Presumido/Real = Balanço, DRE, ECD, REINF.
- **Criação:** manual (`POST /tickets`, administrador, depois de gravar Baixa/Saída em Gestão) ou **automática** quando o Acessórias inativa uma empresa (arquivo da sincronização, seção 3.9). Mencionados: todos os **administradores ativos** + os `contabil` ativos que atendem o **regime** da empresa (`regimes_atendidos`); sem ninguém marcado, **todos** os contábeis ativos.
- **Estados:** `nova` → `resolvendo` (primeira interação ou item marcado) → `encerrada`. Marcar item: administrador ou mencionado; alterna ok/pendente e grava quem e quando. **Finalizar** só com o checklist 100% completo; administrador também encerra/reabre (`PATCH …/status`) sem exigir checklist.
- **Visibilidade:** administrador vê todos; contábil, só os em que foi mencionado (`GET /tickets`). Interação, checklist, finalizar e `GET /tickets/:id` exigem apenas estar logado — **este último não confere se a pessoa é mencionada**. `GET /tickets-usuarios` lista os contábeis ativos para mencionar.
- **Portal Contábil** (`/contabil`, login próprio): lista os tickets da pessoa, permite abrir, comentar, marcar o checklist e finalizar.

### 3.8 Análise Inteligente (legada, `app.js` + `/api/data/churn`, `/sentimento`, `/api/cs/*`)
Painéis do administrador: **Risco de Cancelamento (Churn)** por pontos (`GET /api/data/churn`), **Sentimento dos Comentários** (palavras-chave positivas e negativas, sem IA paga; classifica `positivo`, `negativo`, `neutro`, `sem_comentario`), **Possíveis Churns** e **Insatisfação nas Conversas** (frases nas mensagens do Zappy), **Afastamento**, **Motivos de Abertura por Cliente** e **Histórico de Tratamentos** (arquivo 09 do /cs).
- **Churn legado por pontos** (por cliente ativo): última pesquisa com NPS ≤ 6 = +30 (7 a 8 = +10); CSAT ≤ 2 = +15; comentários recentes mais negativos que positivos = +15; insatisfações dos últimos 90 dias = +15 (+25 se alguma de gravidade alta); cliente sensível em 90 dias = +20; recuperação em 180 dias = +15; sem reajuste há 24 meses ou mais = +10. Teto 100; **vermelho ≥ 60, amarelo ≥ 30, verde abaixo**. É **independente** do Risco de perda do /cs (4 termômetros, arquivo 04): são dois modelos diferentes para a mesma pergunta.

### 3.9 Sincronização com o Acessórias (`sincronizarAcessorias`)
Roda ao subir, a cada 24 h e pelo botão. Traz os clientes **ativos**: casa por `acessorias_id` ou CNPJ; **nunca mexe em honorário**. Cliente novo → cria em `clientes` (sem honorário), cria linha em Gestão ("Cliente vindo de outro contador", canal "Outro", motivo "Importado automaticamente do Sistema Acessórias") e **avisa no sino** para classificar a entrada. Cliente existente → atualiza nome, regime, código, `acessorias_id` e UF (se não há município confirmado) e zera o alerta de baixa. Cliente **encerrado aqui e ativo lá** = **retorno**: reativa a mesma linha (honorários e histórico continuam), troca o código, grava evento e avisa. Cliente **ativo aqui e ausente da lista de ativos lá** → **encerra sozinho** (`encerrarClientePorAcessorias`): data de saída do Acessórias, tipo pelo motivo (Transferida… = **Saída**, que conta como churn; Baixada = **Baixa**; sem motivo, pela situação do CNPJ na Receita; sem nada = Baixa), evento `saida`, linha em Gestão assinada por "Automático (Acessórias)" e **ticket contábil** automático. **Trava de segurança:** se a lista do Acessórias vier com menos de **70%** dos ativos que já temos, nenhum encerramento automático é feito (evita encerrar em massa por falha de paginação). Depois, completa município/CNAE em segundo plano.

### 3.10 Administração, Log e Perfil
- **Usuários:** criar, editar perfil e marcas, trocar senha, ativar/desativar, excluir (ver a seção 5 do núcleo).
- **Backups automáticos:** lista (data e totais) e download por registro; **Baixar backup** manual.
- **Log:** filtros por módulo e usuário; exportar CSV; **Limpar Log** (apaga tudo).
- **Perfil:** altera nome, e-mail e senha do próprio usuário (exige a senha atual).

### 3.11 Sucesso do Cliente (aba legada)
Radar "Agora" (tickets do Zappy fora do SLA), bloco **Hoje** (e-mails sem resposta), **Histórico de Atendimentos** (filtros por departamento, analista, status e etapa do SLA, 500 linhas), **Vínculos Pendentes de Confirmação** (confirmar empresa e tipo, "Recalcular sugestões") e botões de manutenção (testar conexão com o Zappy, atualizar agora, recalcular SLA, carregar 90 dias, atualizar notas pendentes). Regras no arquivo 09 do /cs.

## 4. Dados do SPA

| Tabela | Colunas principais |
| --- | --- |
| `atendimentos` | `id TEXT PK`, `user_id → users`, `analista`, `cliente`, `cnpj`, `empresa`, `departamento`, `procurado`, `demanda`, `resumo`, `created_at` |
| `gestao_clientes` | `id`, `user_id`, `analista`, `solicitacao`, `cnpj`, `empresa`, `data_sol` (nulável), `competencia` (nulável), `canal`, `motivo`, `codigo`, `regime_tributario`, `created_at` |
| `insatisfacoes` | `id`, `user_id`, `analista`, `cliente`, `cnpj`, `empresa`, `reclamado`, `reclamacao`, `gravidade`, `area`, `tipo`, `status` (padrão `aberta`), `created_at` |
| `clientes_sensiveis` | `id`, `user_id`, `analista`, `cliente`, `cnpj`, `empresa`, `demonstrou`, `gravidade`, `detalhe`, `created_at` |
| `pesquisas` | `id`, `user_id`, `analista`, `cliente`, `cnpj`, `empresa`, `nps`, `csat`, `ces`, `pontos`, `tratado BOOLEAN`, `created_at` |
| `recuperacoes` | `id`, `user_id`, `analista`, `cliente`, `cnpj`, `empresa`, `demonstrou`, `gravidade`, `insatisfacao_id UUID`, `created_at` |
| `clientes` (**sem `CREATE` no repositório**) | `id`, `user_id` (nulável), `cnpj`, `nome_empresa`, `regime_tributario`, `data_entrada`, `honorario_inicial`, `origem`, `cac`, `obs`, `status` (`ativo`/`encerrado`), `data_saida`, `motivo_saida`, `codigo`, `grupo_empresas`, `unidade`, `tipo_entrada`, `inadimplente_cronico`, `acessorias_id` (índice único parcial), `uf`, `municipio`, `municipio_ibge`, `municipio_verificado_em`, `cnaes JSONB`, `inscricao_municipal`, `alerta_baixa_notificado_em`, `motivo_cancelamento_acessorias`, `situacao_receita*`, `classificacao_manual`, `motivo_churn`, `created_at` (inferido pelo uso) |
| `honorarios` (**sem `CREATE`**) | `cliente_id`, `valor`, `data_vigencia`, `obs`, `created_at` |
| `eventos_clientes` (**sem `CREATE`**) | `cliente_id`, `tipo` (`entrada`, `saida`, `reajuste`), `descricao`, `valor_anterior`, `valor_novo`, `data_evento`, `created_at` |
| `investimentos` (**sem `CREATE`**) | `id`, `user_id`, `mes` (`AAAA-MM`), `canal`, `valor`, `descricao`, `recorrente`, `valor_original`, `created_at` |
| `tickets` | `id UUID`, `gestao_id`, `empresa`, `cnpj`, `regime`, `tipo_movimentacao`, `checklist JSONB` (`[{item, ok, por, em}]`), `status` (`nova/resolvendo/encerrada`), `observacoes`, `criado_por`, `dados_gestao JSONB`, `created_at`, `updated_at` |
| `ticket_interacoes` | `ticket_id → tickets ON DELETE CASCADE`, `autor_id`, `autor_nome`, `comentario`, `is_automatica`, `created_at` |
| `ticket_mencoes` | `ticket_id → tickets CASCADE`, `usuario_id`, UNIQUE (ticket, usuário) |

## 5. Rotas do SPA (`/api/data/…`, todas atrás de `requireAuth`, salvo `/api/public/pesquisa`)

| Grupo | Rotas | Quem o servidor deixa |
| --- | --- | --- |
| Registros | `GET/POST /atendimentos`, `/gestao`, `/insatisfacoes`, `/sensiveis`, `/pesquisas`, `/recuperacoes`; `PATCH /insatisfacoes/:id/status`, `/pesquisas/:id/tratado` | qualquer usuário logado |
| Exclusão | `DELETE …/:id` e `…/clear` de cada registro; `DELETE /clear?period=` (6 tabelas de uma vez) | administrador |
| Importação | `POST /gestao/importar`, `/clientes/importar-acessorias`, `/gestao/honorarios-omie` (token) | administrador / máquina |
| Carteira (leitura) | `GET /clientes`, `GET /clientes/:id`, `GET /carteira/dashboard` | administrador (desde 31/10/2026; antes qualquer logado) |
| Carteira (criar) | `POST /clientes` | qualquer usuário logado, de propósito: o formulário de Gestão grava a entrada na Carteira; para quem não é administrador o CAC é calculado no servidor (`cacDoMes`) |
| Carteira (escrita) | `PATCH /clientes/:id`, `…/encerrar`, `…/completar-entrada`, `POST …/honorario`, `POST /clientes/reajuste-em-massa`, `DELETE /clientes/:id`, `DELETE /clientes/clear` | administrador |
| CAC | `GET /investimentos`, `GET /cac/dashboard` | administrador (desde 31/10/2026; antes qualquer logado) |
| CAC (escrita) | `POST/PATCH/DELETE /investimentos…` | administrador |
| Painéis | `GET /dashboard`, `GET /busca-global`, `GET /notificacoes`, `PATCH /notificacoes/…/lida`, `POST /notificacoes`, `PATCH /perfil` | qualquer logado |
| Administração | `GET /relatorio-executivo`, `GET/DELETE /log-atividades`, `GET /backup`, `GET /backups-automaticos`, `…/:id/download`, `GET /sentimento`, `GET /churn`, `GET /financeiro` (tela antiga) | administrador |
| Tickets | `GET /tickets`, `GET /tickets/:id`, `POST …/interacoes`, `PATCH …/checklist`, `PATCH …/finalizar`, `GET /tickets-usuarios` | logado (com regra de mencionado em parte) |
| Tickets (administração) | `POST /tickets`, `PATCH …/status`, `DELETE /tickets/:id`, `DELETE /tickets/clear` | administrador |
| Pública | `POST /api/public/pesquisa` | sem login |

O **Relatório Executivo** (`GET /relatorio-executivo?mes=AAAA-MM`, administrador) junta, para o mês: totais por módulo, insatisfações por gravidade, área e empresa, atendimentos por departamento e analista procurado, solicitações de Gestão por tipo, médias de NPS e CSAT, carteira (ativos, MRR), CAC do mês e novos clientes.

## 6. Pontos de atenção

1. ~~Qualquer conta de perfil `usuario` lê a Carteira com honorários~~ — **leituras corrigidas em 31/10/2026** (código; vale após o deploy); a criação (`POST /clientes`) segue aberta de propósito. Efeito colateral aceito: o KPI "Clientes ativos" do Dashboard fica "—" para quem não é administrador. Texto do problema antigo: **Qualquer conta de perfil `usuario` lê a Carteira com honorários e cria clientes** (o cadastro público que permitia criar essas contas foi desligado em 31/10/2026), porque `GET /clientes`, `POST /clientes`, `GET /carteira/dashboard`, `GET /investimentos` e `GET /cac/dashboard` só pedem estar logado. As telas "admin-only" são escondidas no navegador, não protegidas na API. Ver [nucleo.md](nucleo.md), item 1 dos pontos de atenção. [CONFIRMADO]
2. **`DELETE /api/data/clear` apaga seis tabelas de uma vez sem pedir confirmação:** com `period` ausente ou `todos`, o filtro vira `WHERE 1=1`. Só administrador, mas um clique ou chamada errada zera atendimentos, gestão, insatisfações, sensíveis, pesquisas e recuperações. A exclusão da Carteira, ao contrário, exige a frase de confirmação. [CONFIRMADO]
3. **Duas definições de LTV** (seção 3.5 e 3.6) e **dois modelos de churn** (3.8 e o Risco do /cs): números diferentes para a mesma pergunta. [CONFIRMADO]
4. **Avisos de ticket possivelmente não gravados** (colunas inexistentes no desenho de `notificacoes` no código; erro silenciado). Conferir com o esquema real. [DÚVIDA] (núcleo, item 5)
5. **`GET /tickets/:id`, interação, checklist e finalizar:** a leitura do ticket não confere se o usuário foi mencionado; os demais conferem para quem não é administrador. [CONFIRMADO]
6. **`PATCH /clientes/:id/encerrar` não valida datas nem registra no log**, e `DELETE /clientes/:id` apaga em cascata (honorários e eventos) sem log. [CONFIRMADO]
7. **Pesquisa pública sem proteção contra abuso:** só o limite global (300 requisições por minuto por IP); qualquer pessoa pode inserir respostas que entram nos indicadores. [CONFIRMADO]
8. **Colunas e tabelas criadas "na hora"** (`ALTER TABLE … IF NOT EXISTS` dentro de handlers) e cinco tabelas sem `CREATE`: o esquema real só se confirma com o `pg_dump`. [CONFIRMADO]
9. **Arquivos grandes:** `data.js` (6,7 mil linhas, 172 rotas) e `app.js` (11 mil linhas) misturam módulos que hoje têm páginas próprias; mudanças pedem cuidado. [CONFIRMADO]
10. **Saída registrada à mão pode não contar como churn.** O formulário grava no cliente o **Motivo do Churn da lista** (por exemplo "Preço") como `motivo_saida`; a classificação de saídas do /cs só reconhece como transferência os textos que começam por "Transferida por…" (arquivo 05 do /cs). Sem o motivo do Acessórias para prevalecer, a saída vira "outra saída" e fica fora da taxa. Mesma consequência quando a Legalização aprova uma inativação. [INFERIDO; conferir com um caso real]
