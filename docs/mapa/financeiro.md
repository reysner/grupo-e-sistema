# /financeiro — Inadimplência, suspensos, cobranças e carteira de honorários

Cobre a página `/financeiro` (`public/financeiro.html` + `public/js/financeiro.js`, `?v=7`), a API `/api/financeiro/*` (`server/financeiro/rotas.js`, 405 linhas) e as regras puras (`server/financeiro/calculo.js`), a entrada de dados vinda do Omie (rotas `POST /api/data/financeiro/importar` e `POST /api/data/gestao/honorarios-omie` em `server/routes/data.js:14–228`, mais `POST /api/financeiro/titulos` e `POST /api/cs/risco/suspensos-omie`), a rotina do Omie (`server/omie/`) e a tela antiga de ticket médio no SPA `/` (`Financeiro` em `app.js:6478`, rota `GET /api/data/financeiro`).

Níveis de certeza: [CONFIRMADO] · [INFERIDO] · [DÚVIDA].

## 1. Objetivo

Mostrar, para a reunião semanal, quem está **inadimplente** (honorário vencido e não pago) e há quanto tempo, quantas vezes cada competência foi **cobrada** pelo Bruno no Zappy, quais contratos estão **suspensos** no Omie e como a carteira se comporta ao longo das semanas, com o **próximo passo** sugerido para cada cliente. É só leitura para quem acessa: os dados entram por rotinas.

## 2. Quem acessa e o que vê

`podeEntrar` / `veValores` (`rotas.js:29–30`), sempre decididos no servidor:

| Perfil | Entra? | Valores em R$ |
| --- | --- | --- |
| `administrador` | sim | sim (e o botão **👁 Ocultar valores** para apresentações, que é só visual) |
| qualquer perfil com `acesso_financeiro` (inclusive `colaborador`/`contabil`) | sim | sim |
| `usuario`, `acesso_cs` ou `acesso_financeiro_sv` (sem `acesso_financeiro`) | sim | **não**: o servidor devolve os valores `null` |
| `contabil`/`colaborador` sem nenhuma dessas marcas | não (403) | — |

`server/auth.js:88` libera o prefixo `/api/financeiro` para `contabil`/`colaborador` que tenham uma das três marcas; o resto do sistema continua bloqueado para eles. Teste: `server/financeiro/testes_acesso_colaborador.js` (colaborador com `acesso_financeiro` alcança só a página). O `acesso_financeiro_sv` abre o /financeiro mas **não** o /cs.

## 3. Modelo de dados

| Tabela | Colunas e regras | Quem grava |
| --- | --- | --- |
| `financeiro_clientes` | PK (`unidade`, `cnpj`): `nome`, `honorario_atual NUMERIC(14,2) NOT NULL`, `vigencia DATE` | `POST /financeiro/importar` (snapshot da unidade) |
| `financeiro_aberto` | PK (`unidade`, `cnpj`): `nome`, `qtd`, `valor_aberto`, `valor_atrasado`, `qtd_atrasados`, `mais_antigo DATE` | idem |
| `financeiro_importacoes` | `id SERIAL`, `unidade`, `fonte`, `importado_em`, `total_clientes`, `total_abertos` | idem |
| `financeiro_titulos` | PK (`unidade`, `rec`): `cnpj`, `nome`, `vencimento DATE`, `valor_aberto`, `valor_doc`, `situacao` (`A` atrasado, `P` parcial, `V` a vencer), `atualizado_em`; índice por `cnpj`; RLS ligado | `POST /api/financeiro/titulos` |
| `financeiro_pontualidade` | PK (`unidade`, `cnpj`): `pagos`, `media_dias NUMERIC(8,1)`, `max_dias`; RLS ligado | idem |
| `financeiro_historico` | PK `semana DATE` (segunda-feira): `clientes_ativos`, `clientes_com_honorario`, `honorario_mensal`, `inadimplentes`, `pct_inadimplentes`, `valor_atrasado`, `titulos_atrasados`, `mais_90_dias`, `nunca_cobrados`, `cobrados_3_ou_mais`, `suspensos`, `suspensos_com_debito`, `honorario_suspenso`, `cobrancas_30_dias`, `aging JSONB`; RLS ligado; começou em 14/10/2026 | `gravarRetrato()` |
| `omie_contratos_suspensos` | `doc TEXT PK`, `contrato`, `nome`, `atualizado_em` | `POST /api/cs/risco/suspensos-omie` (arquivo 04) |
| `clientes`, `honorarios`, `eventos_clientes`, `gestao_clientes` | origem do cadastro, do honorário em vigor e do histórico de reajuste | também **escritas** pela importação (seção 4.5) |
| `cs_mensagens`, `cs_tickets`, `cs_vinculos` | mensagens do Zappy lidas para contar cobranças | só leitura |

As três primeiras são criadas por `ensureFinanceiroSchema()` em `data.js` (sem RLS) e as demais por `garantirSchema()` em `rotas.js`.

## 4. Regras de negócio (RN-FIN)

### 4.1 Montagem da carteira (`compor`, função pura)
- **RN-FIN-001** A lista é de **clientes ativos** no Acessórias (`clientes.status = 'ativo'`), CNPJ ou CPF. Cliente encerrado lá sai daqui, mesmo que o Omie ainda traga título dele.
- **RN-FIN-002 Honorário:** soma de `financeiro_clientes.honorario_atual` por documento (cliente nas duas unidades do Omie tem os valores somados). Quem tem entrada ali "fatura no Omie" (`fatura_no_omie`).
- **RN-FIN-003 Situação** (precedência): `inadimplente` (tem título vencido) > `suspenso` (contrato suspenso no Omie) > `em_dia` (fatura no Omie) > `sem_honorario`. Um suspenso inadimplente aparece como inadimplente, com o selo ⏸ ao lado.
- **RN-FIN-004 Atraso:** com o detalhe título a título, `vencido = vencimento < hoje` (data de Brasília), `dias_atraso` = dias do título vencido **mais antigo** até hoje, `valor_atrasado` = soma dos vencidos, `qtd_atrasados` = quantidade. Sem detalhe, usa o agregado de `financeiro_aberto`. O honorário de um mês vence no mês seguinte (o de junho vence em 10/07), por isso a **competência** exibida é o mês anterior ao vencimento.
- **RN-FIN-005 Faixas de atraso** (`FAIXAS`): 1–15, 16–30, 31–60, 61–90, mais de 90 dias. O **aging** conta, por faixa, os clientes e o valor **de cada título** (um cliente pode aparecer em várias faixas); sem detalhe, o valor entra na faixa do atraso mais antigo.
- **RN-FIN-006 Pontualidade** (`financeiro_pontualidade`): média ponderada por pagos entre as unidades; "mau pagador" = **3 ou mais pagos** e média de **10 dias ou mais** de atraso (pagar antes do vencimento conta 0). Janela lida: honorários pagos nos últimos 7 meses.
- **RN-FIN-007 KPIs** (todos calculados em `compor`): clientes ativos e com honorário; `honorario_mensal` (soma de quem fatura); `inadimplentes`; `pct_inadimplentes = inadimplentes ÷ clientes com honorário` (1 casa); `valor_atrasado`; `titulos_atrasados`; `cronicos` (marca da Carteira); `mais_90_dias`; `suspensos`, `suspensos_com_debito`, `honorario_suspenso`; `nunca_cobrados` (inadimplentes sem cobrança); `cobrados_3_ou_mais`; `cobrancas_30_dias`; `a_vencer_7_dias` (títulos e valor); `vencendo_no_mes`; `maus_pagadores`; e a **qualidade** (sem honorário no Omie, inadimplentes sem detalhe, datas de leitura).

### 4.2 Contagem de cobranças (Zappy)
- **RN-FIN-008 Quem é o cobrador:** só conta mensagem do escritório cujo texto começa com `*Bruno Xavier:*` (o Zappy não grava o autor em campo próprio). A consulta já filtra as mensagens por palavras (`honor, boleto, aberto, vencid, atras, pendent, suspens, paralis, inadimpl, baixa, pagamento`) desde **01/05/2026** (`COBRANCAS_DESDE`; antes o Zappy não era lido). O cliente vem do vínculo do telefone com a Carteira.
- **RN-FIN-009 Classificação** (`classificarMensagem`, regex): `baixa` ("realizei a baixa", "pagamento identificado/confirmado/recebido"…, **não conta**) → `suspensao` (fala em suspender/interromper/paralisar **e** em honorário/pagamento/aberto/inadimplência, **conta**) → `cobranca` ("honorários … em aberto/pendente/atrasados/vencidos", "falta de pagamento", "consta(m) em nosso sistema"…, **conta**) → `boleto` (boleto do honorário do mês, **não conta**). Extrai as datas `dd/mm/aaaa` ou `dd/mm/aa` citadas.
- **RN-FIN-010 Um dia, um evento:** várias mensagens do mesmo cliente no mesmo dia viram **uma** cobrança (tipo principal: suspensão > cobrança > boleto > baixa).
- **RN-FIN-011 "Vezes cobrado" de um título** (`contarCobrancas`): cada evento que conta cobra o título se ele **já estava vencido no dia** (`vencimento < dia`), **ainda não estava pago** e, **se a mensagem cita datas, o vencimento do título está entre elas**; sem datas citadas, vale para todos os vencidos naquele dia.
  Exemplo: título vence 10/09. Mensagem de 20/09 cita "10/09" e mensagem de 28/09 não cita datas: **2 cobranças**. Um título que vence 10/10 não é cobrado por essas duas mensagens (ainda não tinha vencido).
- **RN-FIN-012 Cobranças do atraso atual** do cliente: eventos que contam e ocorrem **depois** do vencimento mais antigo em aberto; `ultima_cobranca` e `dias_desde_cobranca` saem daí.
- Cobrança por ligação, e-mail ou outro canal **não aparece**.

### 4.3 Próximo passo (`proximoPasso`, primeira regra que bater)
| # | Condição | Código | Gravidade |
| --- | --- | --- | --- |
| 1 | suspenso e com título vencido | `suspenso_com_debito` ("só reativar depois de regularizar"; acima de 60 dias, levar à reunião: acordo ou encerramento) | alta |
| 2 | suspenso | `suspenso` | média |
| 3 | sem título vencido | `em_dia` | ok |
| 4 | atraso > 90 dias | `avaliar_suspensao` | alta |
| 5 | nunca cobrado | `cobrar_agora` | alta se atraso > 30 dias, senão média |
| 6 | última cobrança há ≤ 7 dias | `aguardar` | baixa |
| 7 | 3 ou mais cobranças **ou** atraso > 60 dias | `ligar` | alta |
| 8 | demais | `cobrar_de_novo` | média |

O campo `cronico` entra na chamada mas **nenhuma regra o usa**; ele só vira o selo "crônico" na tela. [CONFIRMADO]

### 4.4 Retrato semanal
`gravarRetrato()` guarda os 14 números do dia + o aging, com chave na **segunda-feira** da semana (a última leitura da semana vale). É gravado logo depois de cada `POST /titulos` (em segundo plano) e, se a semana atual ainda não tem retrato, na primeira abertura de `GET /historico` (últimas 200 semanas). Quem não vê valores recebe o histórico com `honorario_mensal`, `valor_atrasado`, `honorario_suspenso` e os valores do aging `null`.

### 4.5 Entrada dos dados (rotina do Omie) e efeitos colaterais
Duas empresas no Omie (**Soluções Escritorial** e **Escritorial**, cada uma é uma "unidade"). Fluxo descrito em `server/omie/LEIA-ME.md`:
1. Às **11:00** (e o Reysner presente), ele entra no Omie e abre as duas abas do ERP no navegador integrado do Claude. **Nenhuma senha é digitada pelo assistente.** A tarefa agendada `omie-financeiro-11h` lê **Finanças → Contas a Receber** (só leitura) com `paginaContasReceber.js` e grava arquivos compactos em `server/omie/tmp/` (ignorada pelo Git).
2. `importarOmie.js --unidade=… --hon=… --aberto=… [--nomes=…] [--titulos=… --pontual=…] [--diferentes]` envia: (a) `POST /api/data/gestao/honorarios-omie`, (b) `POST /api/data/financeiro/importar`, (c) `POST /api/financeiro/titulos`. Recusa lista com menos de 5 clientes e título vazio quando há clientes em aberto ("leitura suspeita"); se há cliente sem cadastro e sem nome, não grava nada e imprime `NOMES_NECESSARIOS` (saída 3).
3. **Toda segunda**, na mesma rodada: `paginaContratos.js` (Serviços → Contratos de Serviço, situação "Susp") nas **duas** empresas e `enviarSuspensos.js`, que só envia se as duas leituras passaram (mínimos 250 e 120 contratos) e **substitui a lista inteira**.
4. Regras do honorário (definidas em 21/09/2026): só a categoria **SERVIÇOS HONORÁRIOS CONTÁBEIS** (título misto conta a fração dela); honorário atual = último valor que se repete em **≥ 2 meses seguidos** nos últimos 7 meses (mês com valor a mais é serviço extra e é ignorado); cliente ativo no Omie = tem honorário nos últimos 3 meses; inadimplente = honorário em aberto com vencimento passado.

**Efeitos colaterais** (a importação escreve na Carteira, não só no Financeiro):
- `POST /financeiro/importar` troca o snapshot da unidade em **transação** e, para cada cliente **ativo** com honorário diferente do atual, insere uma linha em `honorarios` (vigência = mês do Omie, ou o mês corrente) e um evento `reajuste` em `eventos_clientes`. Cliente encerrado na Carteira não é reativado, só listado em `encerradosFaturando`.
- `POST /gestao/honorarios-omie` (simula por padrão, `aplicar: true` grava): preenche honorário que falta; honorário **diferente** só é trocado com `aplicarDiferentes`; cliente do Omie sem cadastro é **criado** em `clientes` (`origem = 'Omie (sem Acessórias)'`, observação "Não há cadastro no Acessórias") com uma linha em `gestao_clientes` (solicitação "Cliente vindo de outro contador").

## 5. API (`/api/financeiro`)

| Método e rota | Acesso | O que faz |
| --- | --- | --- |
| `GET /dados[?forcar=1]` | login + `soFinanceiro` | `{ kpis, clientes[], valores_ocultos, usuario {nome, papel, ve_valores} }`; cache de 60 s em memória, invalidado pelo `POST /titulos` |
| `GET /historico` | idem | até 200 semanas do retrato (cria o da semana atual se faltar) |
| `GET /ficha/:doc` | idem | um cliente ativo (11 ou 14 dígitos): títulos em aberto com "vezes cobrado" e a **linha do tempo** das cobranças; **o texto das mensagens nunca sai**, só dia, tipo, se conta, tickets e datas citadas |
| `POST /titulos` | `X-Sync-Token` | `{ unidade, titulos[{rec,cnpj,venc,aberto,doc,sit}], pontualidade[{cnpj,pagos,media,max}] }`; máximo 30.000 títulos e 5.000 pontualidades (413); ignora título de `sit` fora de `A/P/V`, CNPJ/CPF inválido, `rec` repetido e data inválida; em transação troca os da unidade |

Rotas relacionadas fora do prefixo: `POST /api/data/financeiro/importar` e `POST /api/data/gestao/honorarios-omie` (token), `GET /api/data/financeiro?unidade=` (**administrador**, tela antiga do SPA: ticket médio, faixas "acima/na média/abaixo" com banda fixa de **R$ 50**, e opção `__todas`) e `POST /api/cs/risco/suspensos-omie` (token).

## 6. Telas (`/financeiro`)

Menu: **Visão Geral** · **Oportunidades** (selo = nº de prioridades altas) · *Carteira:* **Inadimplentes** (selo), **Suspensos**, **Todos os clientes** · *Acompanhamento:* **Evolução**, **Cobranças**, **Qualidade dos Dados**. Barra: **👁 Ocultar valores**, **⬇ CSV**, **⬇ CSV por título** (uma linha por honorário em aberto), **⬇ PDF**, **↻ Atualizar**. Mesma sessão do /cs (`cs_token`).

- **Visão Geral:** seis KPIs (clientes ativos, honorário mensal, inadimplentes, valor em atraso, suspensos, cobranças em 30 dias), cartão **Idade da dívida** (aging), **Atenção agora** (mais de 90 dias, nunca cobrados, cobrados 3×+, suspensos com débito, vencem em 7 dias, maus pagadores, crônicos) e os dois rankings (**maiores valores** e **mais tempo em atraso**, 8 cada).
- **Oportunidades:** cartões calculados na hora, com prioridade (alta/atenção/acompanhar), quantidade, valor, "o que fazer" e botão "Ver a lista →" que abre a lista já filtrada: cobrar quem nunca foi cobrado, retomar cobranças paradas (≥ 15 dias), partir para contato direto (3×+), dívida com mais de 1 ano, suspensos que devem, suspensos sem débito, maus pagadores ainda em dia, vencem em 7 dias, ativos sem honorário no Omie, concentração da dívida (10 maiores = x% do total, só com valores visíveis), inadimplentes sem detalhe. Mais uma lista fixa de **ideias para evoluir o módulo**.
- **Inadimplentes** (inclui suspensos com débito): filtros de busca, faixa de atraso, categoria e cobrança (nunca, 3×+, parado ≥ 15 dias); colunas empresa, meses em aberto, valor, atraso, cobranças e próximo passo; ordem: maior atraso. **Suspensos:** KPIs e filtro com/sem débito. **Todos os clientes:** situação, categoria, honorário, em atraso, **atraso médio ao pagar**; ordem: maior honorário. 50 por página.
- **Cobranças:** KPIs, tabela **Competências em aberto** (clique abre o detalhe da competência com CSV próprio), **Nunca cobrados** e **Sem nova cobrança há 15 dias ou mais**.
- **Evolução:** variação semanal e gráficos a partir de `financeiro_historico` [INFERIDO pelo nome e pelos dados; a função `desenharEvolucao` não foi lida linha a linha]. **Qualidade dos Dados:** fontes e datas de leitura, ativos sem honorário e inadimplentes sem detalhe.
- **Ficha da empresa** (clique no nome): próximo passo, honorário, atraso, cobranças do atraso, pontualidade, tabela de honorários em aberto (competência, vencimento, valor, situação, atraso, cobrado, última cobrança) e **linha do tempo no Zappy**.

## 7. Pontos de atenção

1. **Texto desatualizado na tela de Oportunidades.** A lista de "Ideias para evoluir" ainda sugere "Evolução semana a semana" (já existe: `financeiro_historico`) e diz que a leitura do Omie "roda uma vez por semana", enquanto o resto do módulo e o `LEIA-ME` falam de rotina **diária às 11h**; só os suspensos são semanais. [CONFIRMADO]
2. **A atualização depende de uma pessoa e de um agente.** A leitura do Omie roda numa tarefa agendada no navegador integrado do Claude, com o login feito pelo Reysner às 11h. Sem isso os números envelhecem (a tela mostra "lido em"). A alternativa é a API do Omie com chaves por empresa (já prevista nas variáveis `OMIE_*`), ainda não implementada. [CONFIRMADO]
3. **Cobrador fixo no código:** só `*Bruno Xavier:*` conta. Se outra pessoa passar a cobrar (ou o formato do nome mudar), as cobranças somem e todos os inadimplentes viram "nunca cobrado". [CONFIRMADO]
4. **Cobrança por regex:** frases fora dos padrões não contam, e uma frase que case por engano conta. A classificação não é revista por pessoa. [CONFIRMADO]
5. **A importação altera a Carteira sem aprovação:** cria clientes, preenche e troca honorários e grava eventos de reajuste. A troca de valor diferente só ocorre com `--diferentes` na gestão, mas `POST /financeiro/importar` **sempre** atualiza o honorário de cliente ativo quando difere (insere nova linha em `honorarios`). [CONFIRMADO]
6. **Dois denominadores diferentes:** `pct_inadimplentes` divide por "clientes com honorário", mas o numerador conta todo inadimplente, inclusive quem tem título e ainda não tem honorário lido; em tese o percentual pode passar de 100%. [INFERIDO]
7. **Cliente nas duas unidades** tem os honorários somados e os atrasos agregados por documento; a tela antiga (`/api/data/financeiro`) usa outra lógica (por unidade, banda de R$ 50 e `__todas`), então os números das duas telas podem divergir. [CONFIRMADO]
8. **`financeiro_clientes`, `financeiro_aberto` e `financeiro_importacoes` não ligam RLS** (as demais tabelas do módulo ligam). [CONFIRMADO]
9. **Mesmo token de sincronização** para Omie, Legalização, Questor e e-mail; um vazamento permite substituir os snapshots (arquivo 07, item 6.1). Os arquivos `_omie_*` em `server/legalizacao/` têm dados de clientes e estão no `.gitignore`. [CONFIRMADO]
10. **Cobertura de teste:** boa para as regras puras e a exportação (`testes_financeiro.js`, `testes_exportacao.js`, `testes_acesso_colaborador.js`); **sem teste** das rotas de entrada (`/titulos`, `/financeiro/importar`) nem da conversão dos arquivos do Omie. [CONFIRMADO]
