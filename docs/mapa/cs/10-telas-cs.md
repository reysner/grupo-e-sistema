# /cs — Telas e experiência de uso (`public/cs-painel.html` + `public/js/cs-painel.js`)

Aplicação de página única, sem framework: `cs-painel.html` (162 linhas, `?v=` de cache nos scripts) e `cs-painel.js` (4.303 linhas, `?v=195`). Gráficos com Chart.js 4.4.1 (cdnjs); fontes DM Sans e DM Mono (Google Fonts); `exportar.js`, `menu-usuario.js` e `avisos.js` são auxiliares compartilhados. **Todo o controle de acesso é do servidor**; a tela só esconde o que a pessoa não pode usar (comentário na primeira linha do arquivo).

Níveis de certeza: [CONFIRMADO] · [INFERIDO] · [DÚVIDA].

> **Cobertura desta passada.** Li por completo: estrutura da página, sessão, perfis, polling, Visão Geral, Gestão da Permanência, Churn, Categorias, Atendimento, regras da Análise Anual e do Honorário sugerido, Qualidade dos Dados e a ficha do cliente. As telas dos portais (Gestor, Analista, Sucesso do Cliente), "Minha área", Acessos e os formulários de Qualidade (linhas ~1500–3950) estão descritas pelo que fazem e pelas rotas que chamam (arquivo 03 traz as regras e o fluxo); os **textos de cada botão e o layout dessas telas ficam como lacuna** e entram na revisão final de cobertura.

## 1. Casca da página

- **Login** (`#login-screen`): e-mail e senha do sistema Grupo-E → `POST /api/auth/login`. Só entra quem tem papel `administrador`/`usuario` **ou** uma das flags `acesso_cs`, `acesso_gestor`, `acesso_qualidade`, `acesso_minha_nota`; os demais veem "Este painel é da equipe do Sucesso do Cliente. Peça acesso à administração." Tokens em `localStorage` (`cs_token`, `cs_refresh`, `cs_user`). Renovação por `POST /api/auth/refresh`, **uma de cada vez** (várias renovações simultâneas invalidariam o refresh rotativo).
- **Sessão expirada:** `401` após tentar renovar → `sair(true)` e a mensagem "Sua sessão expirou. Entre de novo.". `limparEstadoDaSessao()` apaga dados, filtros, janelas e selos para que a pessoa seguinte na mesma aba não veja nada da anterior.
- **Layout:** barra lateral (menu + selos numéricos), cabeçalho com título/subtítulo da seção, link "📋 Como funciona" (só nos módulos do guia), controle de avisos, menu do usuário e barra de ferramentas: **Período** (só em Visão Geral e Churn: mês atual, mês anterior, últimos 12 meses [padrão], ano corrente, datas livres), indicador "Ao vivo", "Atualizado em", **👁 Ocultar valores**, **⬇ CSV**, **⬇ PDF**, **↻ Atualizar**.
- Deep link: `/cs?aba=<secao>` abre uma seção (também usado pelos avisos push).

## 2. Menu, módulos e perfis

19 seções. Cada uma pertence a um **módulo** (`SEC_MODULO`); o servidor devolve em `GET /api/cs/painel/qualidade/eu` a lista de módulos liberados (Acessos). Sem configuração, vale o padrão do perfil.

| Seção (menu) | Módulo | Fonte de dados principal | Exporta |
| --- | --- | --- | --- |
| 🏠 Visão Geral | `visao` | `GET /painel/dados` | sim |
| 🧠 Análise Inteligente | `inteligente` | `/painel/dados` + `/painel/honorario-sugerido` | sim |
| 📅 Análise Anual | `anual` | `GET /painel/anual` | sim |
| 🎧 Atendimento | `atendimento` | `GET /painel/atendimentos` | sim |
| 🧑‍💼 Portal do Analista | `analista` | `/painel/qualidade/analista/...` | sim |
| ✅ Qualidade | `qualidade` | `/painel/qualidade/...` | não |
| 🚨 Prioridades | `minhas_prioridades` | rotas pessoais de Qualidade/e-mail/SLA | não |
| 🧭 Portal do Gestor | `gestor` | `/painel/qualidade/gestor/...` | sim |
| 🤝 Portal do Sucesso do Cliente | `sucesso` | `/painel/qualidade/sucesso/...` | sim |
| **Minha área:** 🏆 Minha nota · 🎧 Meus atendimentos · 📧 Meus e-mails · 📈 Evolução semanal · 🏅 Gamificação | `minha_nota`, `meus_atendimentos`, `meus_emails`, `minha_evolucao`, `gamificacao` | rotas "minha-*" da Gamificação e do SLA (sempre da **própria** pessoa, resolvida no servidor pelo login) | não |
| 🎯 Gestão da Permanência | `permanencia` | `/painel/dados` | sim |
| 📉 Churn | `churn` | `/painel/dados` (+ `/painel/churn?ini&fim` para datas livres) | sim |
| 🏅 Categorias | `categorias` | `/painel/dados` | sim |
| 🔐 Acessos | `acessos` | `/painel/acessos`, `/painel/admin/logs`, `/painel/admin/backup` | não |
| 🔎 Qualidade dos Dados | `qualidade_dados` | `/painel/dados` | não |

- **RN-TEL-001 Perfil (`perfilDe`)**: `completo` = administrador, usuário **ou** `acesso_cs`; `gestor` = administrador ou `acesso_gestor`; `analista` = administrador ou `acesso_qualidade`. Quando o servidor devolve a lista de módulos, ela **manda**: `completo` vira "tem algum dos módulos de indicadores".
- **RN-TEL-002 Visibilidade dos botões** (`aplicarPerfilCs`): "Minha área" só aparece com módulo liberado; sem lista de módulos, "Acessos" é só do administrador; quem não é `completo` só enxerga Qualidade, os portais a que tem direito e o Portal do Sucesso do Cliente (`eu.sucesso`).
- **RN-TEL-003 Carga:** `completo` busca em paralelo `/painel/dados`, `/painel/honorario-sugerido`, motivos de churn, `/painel/atendimentos` e `/painel/anual` (só a carteira é obrigatória; as demais falham para `null` e a seção avisa). Gestor/analista sem módulo de carteira usam `iniciarLimitado()`: **não carregam a carteira**.
- Quem é só analista vê o título "Portal do Analista" no topo do menu.

## 3. Atualização automática e avisos

| Mecanismo | Intervalo | O que faz |
| --- | --- | --- |
| `sondarMudancas` | **10 s** (e ao voltar à aba) | `GET /painel/qualidade/versao`; se mudou, redesenha a seção aberta e os selos. **Não atropela quem digita**: com formulário preenchido, campo em foco (`oc-`, `ao-`, `gt-`, `so-`, `qa-`) ou janela aberta, mostra "Há novidades no painel… Atualizar agora" |
| `sondarPendencias` | 60 s | `GET /painel/qualidade/pendencias` → selos do Portal do Gestor e do Sucesso do Cliente |
| `sondarAvisos` | 60 s | `GET /painel/qualidade/avisos?desde=` → notificação do navegador + som, só se a pessoa ligou os avisos neste navegador; clique abre a aba certa sem recarregar |
| Selos | na carga | Gestão da Permanência = nº em Alto risco; Churn = saídas que contam; demais pelas rotas acima |

## 4. Telas de indicadores (carteira)

### 4.1 Visão Geral
Seis KPIs: **Clientes ativos** (CNPJ), **Saídas no período**, **Taxa de churn** (mostra "teto de X%" se há saídas a confirmar), **Saíram em até 90 dias**, **Sem reclamação no mês** (últimos 30 dias, com %), **Em Alto risco** (e quantos em Médio). Cartão **Risco de perda** com três blocos clicáveis (Alto ≥ corte alto; Médio entre os cortes; Baixo abaixo) mostrando % e quantidade sobre os clientes avaliados, mais o aviso "⚠ N alerta(s)" para termômetro muito alto em cliente de Médio. **Quatro termômetros** (Financeiro, Atendimento, Operacional, Ocorrências), cada um com a pergunta de negócio, % em risco Médio ou Alto, barra Alto/Médio/Baixo, quantos sem dado e a régua da fonte. Bloco **Fechamento do mês** (arquivo 05, parte B), gráficos "Churn mês a mês" (barras de saídas + linha da taxa, eixo duplo) e "Clientes por categoria" (rosca), e a lista **Pontos para a reunião** (frases geradas por regra: quantos em Alto risco, termômetro dominante entre os em risco, Operacional sem dado, suspensos no Omie e data da lista, saídas a confirmar/presumidas, % sem reclamação). Pesos atuais dos termômetros exibidos em texto.

### 4.2 Gestão da Permanência
Legenda expansível com as regras (resumo do arquivo 04). Filtros: **Buscar** (nome ou CNPJ), **Risco** (Alto e Médio [padrão], só Alto, só Médio, Baixo, Suspensos, Todos), **Categoria**, **Pesa mais** (termômetro dominante) e "só com sinal de Atendimento". Tabela alfabética: Cliente (link para a ficha), Categoria, Risco, e os quatro termômetros; **150 linhas** por vez com "Mostrar todos".

### 4.3 Churn
KPIs (base no início do período, saídas que contam, taxa, saíram em até 90 dias, fora do churn). Nota explicando que contam as saídas cujo motivo no Acessórias começa com os padrões configurados. **Abas**: Transferidas (contam) · A confirmar (só se houver) · Baixas · Outras saídas. Tabela: cliente/CNPJ, entrada, saída, tipo, **Motivo do churn** (seleção da lista; "Outro" abre um campo para criar motivo novo; não aparece em Baixas) e, **só para o administrador** e saídas de origem `presumida`, os botões **Confirmar transferência** / **É baixa** (pede confirmação com `window.confirm`, chama `PUT /api/cs/churn/saidas/:id/classificacao` e recarrega tudo). Botão **Gerenciar lista** (administrador): incluir, renomear, desativar, excluir motivos. Gráfico dos 12 meses.

### 4.4 Categorias
Cinco KPIs clicáveis (Diamante 💎, Ouro 🥇, Prata 🥈, Bronze 🥉, Sem categoria) que filtram a tabela (300 linhas): Cliente, Categoria, Honorário, **Motivo da categoria** (texto com valor, mascarado ao Usuário), Risco. Nota da regra: maior entre honorário próprio, soma do grupo e piso Ouro das TAGs.

### 4.5 Atendimento
KPIs: clientes ativos, atendimentos (180 dias), e-mails recebidos, e-mails sem resposta (e quantos clientes). Se a leitura de e-mails ainda não existe, mostra "—" e "aguardando a primeira leitura". Busca por empresa/CNPJ e filtro "só com e-mail sem resposta". Tabela paginada (colunas: Razão social, Categoria, Atendimentos, SLA vermelho, Notas baixas, Último atendimento, E-mails recebidos, Sem resposta); passar o mouse nos números de e-mail abre o resumo por destinatário; clicar na empresa abre a ficha de atendimento (`GET /painel/atendimento/:id`: tabela data/setor/atendente/nota/SLA e e-mails por destinatário).

### 4.6 Análise Inteligente
Uma linha por **entidade**: um **grupo de empresas** (campo `grupo_empresas`) ou **matriz + filiais** (mesma raiz de 8 dígitos do CNPJ; a matriz `/0001-` vem primeiro) vira uma linha consolidada, com a lupa para abrir cada empresa; empresa sem grupo nem filial é linha única. Colunas: Razão social, Documento/Tipo (CNPJ, CPF, CAEPF, CNO), Categoria, Regime tributário, Funcionários, Honorários, **Faturamento 12 meses** (Questor), **Honorário sugerido** e **Análise**. Filtros: busca, tipo de documento, "só grupos e matriz com filiais". Ordem: faturamento do maior para o menor. Paginação.
- **Faturamento:** `0` aparece como "sem faturamento" (não R$ 0,00); empresa fora do Questor = "sem dado"; ⚠ quando o Questor avisou que há natureza com movimentação sem configuração (valor possivelmente incompleto). Perfil Usuário e "Ocultar valores" veem sempre a máscara, que não revela nem se é zero.
- **Honorário sugerido** = `percentual × (faturamento ÷ 12)`, arredondado a centavos (`Math.round(fat/12 × p)/100`); sem percentual, sem faturamento ou faturamento ≤ 0 → vazio. **Análise:** `cobrado ÷ sugerido ≥ 1` = ✔ (no valor ou acima); `≥ limite_amarelo` (padrão 80%) = ▲ (tomando distância); abaixo = ✖ (muito abaixo). O botão **%** na coluna abre um popover (só o administrador edita) que grava em `PUT /painel/honorario-sugerido`. Exportação CSV/PDF repete as colunas, com a coluna "Aviso do Questor".

### 4.7 Análise Anual
Faturamento ano a ano de cada cliente ativo (CNPJ, CPF, CAEPF, CNO). Anos completos = do **segundo** ano da série até o último ano fechado; o ano em curso aparece como parcial. Colunas por ano escolhido: faturamento do ano anterior e do ano, **variação %**, funcionários (anterior, atual, variação), regime (anterior → atual) e honorário do Omie (anterior, mais recente, variação).
- **Destaque "Rever honorário"** (`destaqueLinha`): variação ≥ `percentual` (padrão **30%**) pela regra escolhida — `ou` (faturamento **ou** funcionários) [padrão], `ambos` (os dois; se não há folha nos dois anos decide só o faturamento), `fat` ou `func` — **ou** mudança de regime.
- **Mudança de regime** (`regimeMudou`): só conta passar de/para o Simples/MEI, ou trocar entre dois regimes **específicos** (Presumido ↔ Real…). "Fora do Simples" ou "Lucro (Presumido/Real)" genéricos de leituras antigas são tratados como "sem informação" para não gerar mudança falsa.
- **Sem reajuste:** entre os destacados, o honorário do Omie subiu menos que `reajuste_min` (padrão **5%**) → "não reajustou"; sem os dois valores no Omie → "sem dado". Filtros: busca, ano, tipo de documento, "só destaques", "só sem reajuste", ordem (alfabética ou maior alta). Botões de percentual e de reajuste mínimo editáveis só pelo administrador (`PUT /painel/anual`). Cliente com `valores_ocultos` (perfil Usuário) recebe a tela sem itens.
- Fichas: `abrirFichaAnual(doc)` (evolução do cliente) e `abrirFichaGrupo` (grupo somado).

### 4.8 Qualidade dos Dados
Tabela de cobertura (clientes CNPJ ativos; cadastros fora do painel; Financeiro, Atendimento, Operacional e Ocorrências com dado; sem categoria) e cartão **Fontes** (Omie, Zappy após revisão da Gamificação + insatisfações e pesquisas do Grupo-E, Acessórias, honorário do Grupo-E e TAGs, motivo de cancelamento do Acessórias e situação do CNPJ na Receita) com a hora do cálculo. Princípio declarado: indicador sem dado **não entra na média**; nunca se presume que o cliente está em dia.

## 5. Ficha do cliente (janela sobre qualquer tela)

Abre ao clicar no nome da empresa (`GET /painel/cliente/:id`, arquivo 06). Topo: nome (com selo ⏸ Suspenso), CNPJ, grupo, unidade, "cliente desde", e **Próximo passo**. Corpo: bloco **Risco de perda** e quatro termômetros (nível · pontos e a primeira razão do detalhe), blocos **Categoria** e **Honorário**, chips de **Sinais de atenção**, e seções recolhíveis (lembram, **neste navegador**, quais estavam abertas): **Qualidade** (ocorrências da empresa e o formulário "CS - Plano de Ação"), **Financeiro** (títulos em atraso por unidade e a tabela dos títulos), **Acessórias** (totais da última leitura + lista consultada **na hora**, `GET /painel/cliente/:id/acessorias`) e **Atendimentos** (só SLA vermelho e nota baixa dos últimos 90 dias, insatisfações de 180 dias, cliente sensível de 90 dias, pesquisas NPS/CSAT/CES). A seção de e-mails mostra "E-mails aguardando resposta" (14 dias), "recebidos" e "sem resposta" (180 dias).

## 6. Exportação (CSV e PDF)

`dadosExport(secao)` monta o arquivo com **todas** as linhas do filtro atual (não só a página). Os dados já chegaram do servidor com permissões e máscara aplicadas; com "Ocultar valores" ligado os valores saem como "oculto". Portais (Gestor, Analista, Sucesso) exportam suas ocorrências sem carregar a carteira. Colunas de cada exportação acompanham as da tela.

## 7. Pontos de atenção

1. **Máscara de R$ no navegador:** o botão "Ocultar valores" é só visual (o administrador já recebeu os valores no JSON); quem inspecionar a rede vê tudo. Para o perfil Usuário a máscara é do servidor. [CONFIRMADO]
2. `cs-painel.js` tem 4,3 mil linhas num único IIFE, HTML montado por concatenação de strings e `esc()` manual: risco de XSS se algum campo novo esquecer de escapar. Todos os campos lidos até aqui passam por `esc()`. [CONFIRMADO nas telas lidas]
3. A atualização de 10 s consulta `/qualidade/versao` mesmo com a aba aberta em seção de carteira; o custo é baixo (rota leve), mas é uma chamada por usuário a cada 10 s. [INFERIDO]
4. `VERSAO = 'V.1.0 · 07/10/2026'` está fixa no arquivo e já não reflete o `?v=195`. [CONFIRMADO]
5. A tela da **Visão Geral** ainda trata o tipo `a_confirmar` (aviso "N saída(s) ainda a confirmar"), embora a classificação atual nunca o produza (arquivo 05, RN-CHU-005). [CONFIRMADO]
6. Os rótulos de módulos e perfis ("Analista" para o papel `colaborador`) são traduzidos na tela (`MenuUsuario.rotulos`), mas o banco guarda `colaborador`. [CONFIRMADO]
