# /legalizacao — Alvarás, certificados digitais e procurações

Cobre a página `/legalizacao` (`public/legalizacao-publica.html` + `public/js/legalizacao.js`, `?v=10`), as rotas `/api/data/legalizacao/*` (em `server/routes/data.js`: máquinas nas linhas 14–807, painel e telas nas linhas 5450–6717), os módulos de apoio em `server/legalizacao/`, a lógica do retrato semanal (`server/legalizacaoRetrato.js`), as rotinas do servidor (`server/index.js:296–372`), os scripts da estação do escritório e os três scripts de navegador (`public/tools/*.user.js`). O guia público para a equipe é `/legalizacao/regras`. As telas de aprovação do administrador ficam no SPA `/` (`Legalizacao` em `app.js`, linhas ~5800–5990).

Níveis de certeza: [CONFIRMADO] · [INFERIDO] · [DÚVIDA].

## 1. Objetivo

Uma lista só de clientes ativos, com uma coluna por documento que o escritório precisa manter em dia: **alvará de funcionamento**, **alvará sanitário**, **certificado digital (PJ e PF)**, **procuração e-CAC** e **procuração FGTS Digital**. Mostra a situação de cada um (Vencido, Vencendo, Solicitação, Em dia, Sem data, Dispensado, Não possui), avisa pelo sino quando um documento entra na janela de vencimento e guarda um retrato por semana para ver a evolução.

## 2. Quem acessa e o que pode

| Perfil | Entra na página? | O que alcança (servidor) |
| --- | --- | --- |
| `administrador` | sim | tudo; exclusivos: desativar/reativar/excluir, editar certificado, procurações manuais, conferência por OCR, saúde das rotinas, aprovar/rejeitar pedidos, "Atualizar CertiSeguro agora", ver desativados |
| `colaborador` ou `contabil` com `acesso_legalizacao` | sim | **só leitura** (`GET`), mais: `POST /solicitar-inativacao`, `POST /notificacoes/lidas`, `PATCH /clientes/:id/municipio` e `…/inscricao-municipal` |
| `usuario` (equipe interna) | **não** pela tela (`podeEntrar` exige administrador ou a flag) | pela API passa por `requireAuth` e alcança as rotas sem `requireAdmin` (editar alvará, protocolo, certificado PJ, consultar prefeitura, pedidos) |
| qualquer pessoa sem login | não | as rotas de máquina aceitam o `X-Sync-Token` |

A regra dos perfis restritos está em `server/auth.js:105–135` (`isLegalizacaoRoute`); o **servidor** decide, a tela só esconde. Mesma sessão do /cs e do /financeiro no navegador (`cs_token`).

## 3. Modelo de dados

Criado de forma preguiçosa por `ensureLegalizacaoSchema()` (`CREATE TABLE IF NOT EXISTS` / `ALTER … ADD COLUMN IF NOT EXISTS` a cada rota). `cliente_id` é **TEXT** (id do cliente como texto), sem chave estrangeira.

| Tabela | Colunas principais |
| --- | --- |
| `legalizacao_alvaras` | `id UUID PK`, `cliente_id`, `tipo` (`funcionamento`/`sanitario`), `orgao`, `link`, `numero`, `data_vencimento DATE`, `observacoes`, `fonte` (padrão `manual`), `criado_por/em`, `atualizado_em`; consulta: `ultima_consulta_status/resumo/data_solicitacao/em`; dispensa: `dispensado_motivo/em/fonte`; aviso: `notificado_vencimento_em`; `desativado_em`; protocolo: `protocolo_numero/em/por/venc_ref (DATE)/info`; OCR: `lido_por_ocr BOOL`, `origem_arquivo`, `trecho_lido`, `conferido_em/por`. **UNIQUE (cliente_id, tipo)** |
| `legalizacao_certificados` | `id`, `cliente_id` (nulo para PF avulso), `tipo` (`pj`/`pf`), `titular_nome`, `titular_documento`, `data_vencimento`, `observacoes`, `fonte` (`manual`/`certiseguro`), `notificado_vencimento_em`, `desativado_em`. Índice único parcial: **um PJ por cliente** |
| `legalizacao_procuracoes` | `id`, `cliente_id`, `tipo` (`ecac`/`fgts`), `data_vencimento`, `observacoes`, `fonte`, `notificado_vencimento_em`; UNIQUE (cliente_id, tipo) |
| `legalizacao_redesim` | `cliente_id PK`, `consultado_em`, `dados JSONB`, `sem_licenciamento`, `nao_encontrado` |
| `legalizacao_protocolos` | `protocolo PK`, `cnpj`, `nome`, `modelo`, `data_solicitacao`, `situacao_cod`, `situacao`, `descricao`, `pagamento`, `ultima_alteracao`, `lido_em` (RLS ligado); **retrato completo substituído a cada leitura** |
| `legalizacao_rotinas` | `id SERIAL`, `rotina`, `inicio`, `fim`, `total`, `ok`, `falhas`, `resumo JSONB`, `por_cidade JSONB`; índice `(rotina, fim DESC)` |
| `legalizacao_historico` | `semana DATE PK`, `atualizado_em`, `clientes`, `vencidos`, `vencendo`, `solicitacao`, `em_dia`, `sem_data`, `dispensado`, `nao_possui`, `por_tipo JSONB` (RLS ligado) |
| `legalizacao_notif_visto` | `user_id PK`, `visto_em` (o "lido" do sino é **por usuário**) |
| `legalizacao_solicitacoes_inativacao` | `id`, `cliente_id`, `nome_empresa`, `motivo`, `observacao NOT NULL`, `status` (`pendente/aprovada/rejeitada`), `solicitado_por/em`, `decidido_por/em`, `decisao_observacao` |
| `legalizacao_solicitacoes_desativacao` | `id`, `cliente_id`, `cert_id`, `nome_empresa`, `tipo_cert`, `observacao`, `status`, `solicitado_*`, `decidido_*` (RLS ligado) |
| `clientes` (colunas da Legalização) | `municipio`, `uf`, `municipio_ibge`, `municipio_verificado_em`, `cnaes JSONB`, `inscricao_municipal` (criadas por `garantirColunasMunicipio`) |
| `notificacoes` | tipos `legalizacao_vencimento`, `legalizacao_rotina_falha`, `legalizacao_rotina_atrasada`, `legalizacao_inativacao_solicitada`, `legalizacao_desativacao_solicitada` |

Documentos **desativados** (`desativado_em`) saem da lista, dos KPIs, do sino e da cobrança, mas não são apagados e a consulta automática **não os reativa**.

## 4. Regras de negócio (RN-LEG)

### 4.1 Linhas do painel
- **RN-LEG-001** A lista traz **todo cliente ativo** (`clientes.status = 'ativo'`) com `LEFT JOIN` nos documentos: quem ainda não tem registro aparece como linha "virtual" (Sem data). O primeiro `PUT`/consulta cria o registro real (upsert).
- **RN-LEG-002** Entram também linhas "sem cadastro no Acessórias": certificados **PF** e certificados PJ cujo cliente não existe em `clientes` (vindos da CertiSeguro). Cliente **inativo** no Acessórias não entra.
- **RN-LEG-003** O **sanitário** só aparece para quem tem registro (nem toda empresa precisa); ele nasce de consulta, de leitura de PDF, de protocolo, da Redesim, da dispensa ou da **avaliação por CNAE** (ver 4.6).
- **RN-LEG-004** O painel inteiro volta numa chamada (`GET /legalizacao/painel`); o navegador filtra e pagina localmente (50 por página).

### 4.2 Situação de cada documento
`_legalStatusSql(coluna, dias, prioridade)`. Hoje = data de Brasília do banco (`CURRENT_DATE`).

| Documento | Janela de "vencendo" | Prioridade antes da data |
| --- | --- | --- |
| Alvará de funcionamento | **30 dias** | 1) protocolo informado e (sem data **ou** `vencimento <= protocolo_venc_ref`) → `solicitacao`; 2) `ultima_consulta_status = 'solicitacao_andamento'` → `solicitacao`; 3) `dispensado_motivo` e sem data → `dispensado` |
| Alvará sanitário | **120 dias** | as mesmas três |
| Certificado digital | **30 dias** (antes 10; mudou em 19/10/2026) | nenhuma |
| Procuração e-CAC / FGTS | **30 dias** | nenhuma |

Depois das prioridades: sem data → `sem_data`; data < hoje → `vencido`; data ≤ hoje + janela → `vencendo`; senão `ok`. Item desativado → `desativado`.

Exemplo (hoje 30/10/2026): funcionamento com vencimento 10/12/2026 → **Em dia** (a janela vai até 29/11); sanitário com a mesma data → **Vencendo** (a janela vai até 28/02/2027); funcionamento vencido em 01/10/2026 com protocolo informado em 05/10/2026 quando a data era 01/10 → **Solicitação** (some das Prioridades). Quando chega a data nova (consulta, PDF ou edição), `vencimento > protocolo_venc_ref` e o protocolo deixa de valer sozinho.

### 4.3 Ajustes depois do cálculo (`montarPainelLegalizacao`)
- **RN-LEG-005 Não se aplica** (`limparSemDataSeNaoCnpj`): cliente cujo documento não é CNPJ válido (CPF, CNO, CAEPF, produtor rural, cadastros internos 9997–9999) **não mostra "Sem data"** em alvarás, procurações nem certificado PJ (o item vira `null`). Só some o que está sem data; com data ou solicitação continua.
- **RN-LEG-006 Não possui** (`marcarNaoPossui`): se a lista **completa** de certificados (CertiSeguro), de procurações e-CAC ou FGTS foi lida há **≤ 15 dias sem falha**, quem não consta nela passa de "Sem data" a **"Não possui"** (certificado PJ só se não tem registro).
- **RN-LEG-007 Certificado PF avulso** é movido para a linha do cliente de mesmo **CPF** ou de mesma **raiz de 9 dígitos de CAEPF**, se esse cliente não tem certificado útil (`casarCertificadosPF`); a linha avulsa some. Prefere o cadastro do Acessórias (com código).
- **RN-LEG-008 Cidade:** `automacao` = `automatica` (Uberlândia, Uberaba ou Belo Horizonte), `pasta` (cidade sem consulta), `sem_municipio` ou `pessoa_fisica`. Cidade sem consulta recebe o atalho do portal da prefeitura (`portaisPrefeituras.js`).
- **RN-LEG-009 A conferir:** alvará com `lido_por_ocr` e sem `conferido_em` mostra "a conferir".
- Desativados só aparecem para o administrador com `?desativados=1`.

### 4.3.1 "Sem data" subdividido
Na tela, "Sem data" se separa em **consultado, nada localizado** (há `consulta_em`: a consulta ou a pasta já olhou) e **ainda não consultado**.

### 4.4 Entrada dos dados (quem alimenta o quê)

| Documento | Fonte automática | Regra de gravação |
| --- | --- | --- |
| Funcionamento | consulta à prefeitura (Uberlândia/Ciclo7, Uberaba, BH); Redesim/JUCEMG (nº e validade futura); PDF das pastas só em exceções | consulta com data vence por data nova; "nada encontrado" só atualiza `ultima_consulta_*`; Redesim **nunca rebaixa** uma data já preenchida |
| Sanitário | PDF da pasta do servidor (OCR nos escaneados), Redesim (Vigilância, com validade), Protocolo Online (andamento), dispensa, avaliação por CNAE | PDF só grava se a data é **maior** que a atual ou não há data; Redesim grava a data da Vigilância |
| Certificado | **CertiSeguro** (2×/dia no servidor; estação como reserva) | vale a validade **mais recente** por documento; só reseta o aviso quando a data muda |
| Procurações | scripts de navegador no e-CAC e no SPE do FGTS Digital | só **Ativa** (vence na validade) e **Expirada** (vira "Vencido"); Cancelada, Rejeitada e Em Análise são ignoradas; entre várias do mesmo CNPJ vale a Ativa de maior validade; só clientes ativos |
| Município e CNAE | BrasilAPI → Minha Receita, por CNPJ | 3 s entre consultas, até 700 por rodada, para após 5 falhas seguidas; reavalia o sanitário no fim |

- **RN-LEG-010 Edição manual apaga a marca de OCR:** `PUT /alvaras/:clienteId/:tipo` grava `numero` e `observacoes` **mesmo nulos** (substituição, não merge), zera `lido_por_ocr`/`conferido_*`, limpa o status de consulta se há data e reseta o aviso se a data mudou.
- **RN-LEG-011 Município e inscrição:** `inscricao_municipal` vinda de PDF/consulta só grava se estiver **vazia** (`guardarInscricaoSeVazia`; 3–30 caracteres, só letras, números e `. - / `). O município digitado à mão busca o código no IBGE pelo nome (sem acento) e grava município, UF e IBGE.
- **RN-LEG-012 Protocolo Online (Uberlândia):** só alvarás sanitários com situação em andamento (`T` Tramitando, `L` Parecer disponível, `E` Retorno, `I` Pendência), modelo "Alvará Sanitário" (exceto dispensa/prorrogação/desarquivamento), e **movimentados nos últimos 180 dias** (parado há mais é "processo esquecido" e não esconde o vencimento). O mais recente por CNPJ vira protocolo automático (`protocolo_por = 'Protocolo Online (automático)'`) **só se** o sanitário está sem data ou dentro de 120 dias do vencimento. Protocolo automático que não está mais em andamento é removido; o informado à mão só sai quando chega data nova ou alguém remove. A lista vazia **não altera nada** (400).
- **RN-LEG-013 Dispensa:** `POST /alvaras-dispensa` (até 500 itens) marca `Dispensado` (ex.: Res. SES/MG 8.765/2023) e só vale enquanto o alvará não tem data; `desfazer` limpa.

### 4.5 Notificações (sino)
`verificarNotificacoesLegalizacao` roda **uma vez por dia às 08:00 de Brasília** (e o retrato semanal junto): cria uma notificação para cada alvará (janela de cada tipo, não desativado, não coberto por protocolo), certificado (não desativado, cliente ativo) e procuração (cliente ativo) que **entrou na janela ou já venceu** e ainda não foi avisado **para aquela data** (`notificado_vencimento_em`). Trocar a data zera o aviso. O sino mostra os últimos 60 avisos (vencimento, falha e atraso de rotina) de clientes ativos; a primeira abertura conta como novos só os dos últimos 7 dias.

### 4.6 Sanitário "exige, não localizado"
`atualizarObservacaoSanitaria` (diária e após cada lote): pelo **CNAE** do cartão CNPJ (`sanitario.js`, 28 prefixos: alimentos, bebidas, farmácia, saúde, estética, hospedagem, veterinária, dedetização…), quem **exige** e não tem data ganha uma linha de sanitário "sem data" com a observação "Exige alvará sanitário (CNAE …) — não localizado." (CNAE principal) ou "Pode exigir… (CNAE secundário…)". Só observações **automáticas** são reescritas ou limpas; texto de pessoa nunca é tocado. Quando a data aparece, a observação some; se deixou de exigir e o registro foi criado pela avaliação sem consulta, o registro é apagado. É **estimativa**, quem decide é a Vigilância do município.

### 4.7 Pedidos ao administrador
- **Inativação de cliente** (`POST /solicitar-inativacao`): motivo opcional (lista de motivos de churn ativos), **observação obrigatória**; um pedido pendente por cliente (409); notifica o administrador. **Aprovar** (`PATCH …/aprovar`, só administrador) encerra o cliente de verdade: `status = 'encerrado'`, `data_saida = hoje`, `motivo_saida = motivo ou 'Inativação solicitada'`, grava o evento `saida`. **Rejeitar** não mexe no cliente.
- **Certificado que o cliente não vai renovar** (`POST /solicitar-desativacao-certificado`): observação obrigatória (até 600 caracteres), um pedido pendente por certificado (409), notifica o administrador. Aprovar **desativa** o certificado (cria a linha se não existir) e fecha pedidos pendentes dele; o administrador também desativa direto.

### 4.8 Retrato semanal
`gravarRetratoLegalizacao`: conta documentos por tipo (`func, sanit, cert_pf, cert_pj, ecac, fgts`) e situação (`vencido, vencendo, solicitacao, ok, sem_data, dispensado, nao_possui`) a partir do painel; semana = **segunda a domingo**, a última leitura da semana vale (upsert por `semana`). Gravado no job das 08:00 e, se a semana atual ainda não tem retrato, na primeira abertura de `GET /legalizacao/historico` (últimos 60). Um cliente pode ter vários documentos, então os totais contam documentos, não empresas.

### 4.9 Saúde das rotinas
Cada rotina registra a rodada em `legalizacao_rotinas`. `situacaoRotinas` classifica a última: **atrasada** (mais horas que `horasMax`), **com_falhas** (falhas > 20% do total), **ok**, **sem_registro**. A cada hora o servidor avisa no sino (uma vez por rodada ou a cada 20 h): "Rotina da Legalização falhou" (com o motivo: `resumo.erro`, `resumo.interrompida` ou nº de falhas) e "…não rodou" (se atrasada; `sem_registro` não alarma).

| Rotina | Nome | Horário descrito | Máx. sem reportar |
| --- | --- | --- | --- |
| `consulta_prefeituras` | Consulta às prefeituras | toda segunda 08:30 | 200 h |
| `leitura_pastas` | Leitura das pastas | toda segunda 08:30 | 200 h |
| `certiseguro` | CertiSeguro | todo dia 07:00 e 13:00 (servidor) | **36 h** |
| `protocolo_online` | Protocolo Online | segunda, a partir de 09:30 (login da Josiane) | 200 h |
| `procuracoes_ecac` / `procuracoes_fgts` | Procurações | segunda, a partir de 09:30 (certificado) | 200 h |

## 5. Rotinas e integrações

| O que | Onde roda | Como |
| --- | --- | --- |
| Notificações + retrato + avaliação sanitária | servidor, 08:00 BRT | `checarAgendaDiaria` (a cada 5 min) |
| CertiSeguro | servidor, 07:00 e 13:00 BRT; botão "Atualizar CertiSeguro agora" (admin); estação como reserva (segunda 09:00) | `POST` à API da CertiSeguro (HTTPS, XML, `listcert`) com `CERTISEGURO_URL/TOKEN/CNPJ`; **só aceita IPs cadastrados**, por isso o servidor tem faixas do Render e a estação tem IP próprio; recusa grava falha na saúde das rotinas com o IP a cadastrar |
| Município/CNAE | servidor, a cada 6 h (700) e dentro da sincronização do Acessórias | BrasilAPI → Minha Receita |
| Saúde das rotinas | servidor, a cada hora | avisos no sino |
| Consulta às prefeituras | **estação do escritório** (`consultarAlvarasLocal.js`, 1 empresa a cada 20 s, para após 4 falhas seguidas) | a prefeitura bloqueia o IP do Render; as cidades integradas ficam em `municipiosIntegrados.js` (IBGE 3170206 Uberlândia, 3170107 Uberaba, 3106200 Belo Horizonte). Fila: sem data **ou** vencido, e (nunca consultado, ou consultado há mais de **20 h** se tem data/andamento, ou há mais de **6 dias**) |
| Consulta noturna no servidor | desligada por padrão (`LEGALIZACAO_CONSULTA_NO_SERVIDOR=1` liga), 02:00 BRT, 300/noite, 4 s entre consultas | mesma regra da fila acima |
| Leitura das pastas de PDF | estação (`lerAlvarasPasta.js`, `ler-alvaras-pasta.bat`) | pasta `…\EMPRESAS\LEGALIZACAO\<razão social>\Alvaras` do servidor de arquivos; extrai o vencimento do **texto** do PDF (OCR local nos escaneados), só aceita se o **CNPJ da empresa aparece no texto**; só lê, nunca altera arquivos; cidade sem consulta automática é acompanhada pela pasta |
| Procurações e-CAC / FGTS | script de navegador `sincronizar-procuracoes.user.js` (v1.5.0), login com certificado | e-CAC e SPE são sistemas **diferentes**, cada um grava só na própria coluna; e-CAC aceita uma sessão com certificado por vez |
| Protocolo Online | `sincronizar-protocolo-online.user.js`, login da Josiane (CPF) | só lê "Minhas Solicitações"; ~2 s entre aberturas (o portal erra se for rápido) |
| Redesim/JUCEMG | `sincronizar-redesim.user.js` no Chrome logado no gov.br | ~3 h para ~524 empresas mineiras; só ~4% têm órgão |
| Token de sincronização | `X-Sync-Token` = `LEGALIZACAO_SYNC_TOKEN` (ou `CERTISEGURO_SYNC_TOKEN`) | nos scripts de navegador fica só no navegador; `importar-certiseguro` aceita **apenas** `CERTISEGURO_SYNC_TOKEN` |

Os segredos da estação ficam em `server/legalizacao/.env` (**git-ignorado**); `.env.example` traz só os nomes.

## 6. Rotas (`/api/data/legalizacao/…`)

| Grupo | Rotas | Acesso |
| --- | --- | --- |
| Máquina (token) | `GET alvaras-a-consultar`, `POST alvaras-consulta-local`, `POST inscricao-municipal-arquivo`, `GET clientes-ativos`, `POST alvaras-arquivo`, `POST cnaes-completar`, `POST sanitario-avaliar`, `GET redesim-a-consultar`, `GET redesim-resumo`, `POST redesim-resultado`, `POST redesim-reprocessar`, `POST certificados/importar-certiseguro`, `POST certificados/sincronizar-certiseguro`, `POST procuracoes/importar`, `POST protocolo-online`, `POST alvaras-dispensa`, `POST saude-rotina` | `X-Sync-Token` |
| Leitura | `GET painel`, `GET historico`, `GET notificacoes`, `GET motivos-inativacao` | login com acesso à Legalização |
| Edição (usuário/administrador) | `PUT alvaras/:clienteId/:tipo`, `POST alvaras/:clienteId/:tipo/protocolo`, `POST alvaras/:clienteId/:tipo/consultar-prefeitura`, `PUT certificados/:clienteId` | login (colaborador/contábil **não passam**, ver o item 1 dos pontos de atenção) |
| Cadastro | `PATCH clientes/:clienteId/municipio`, `PATCH clientes/:clienteId/inscricao-municipal`, `POST notificacoes/lidas`, `POST solicitar-inativacao` | login com acesso à Legalização |
| Pedidos | `POST solicitar-desativacao-certificado` | login (ver o item 1 dos pontos de atenção) |
| Administrador | `PUT procuracoes/:clienteId/:tipo`, `PATCH alvaras/:id/desativar|reativar`, `PATCH certificados/:id/desativar|reativar|(editar)`, `PATCH certificados-cliente/:clienteId/desativar`, `DELETE alvaras/:id`, `DELETE certificados/:id`, `POST certificados/atualizar-agora`, `POST protocolo-online-manual`, `POST procuracoes/importar-manual`, `GET conferencia`, `POST alvaras/:id/conferir`, `GET saude`, `GET/PATCH solicitacoes-inativacao`, `GET/PATCH solicitacoes-desativacao` | `requireAdmin` |

Cada alteração relevante grava no **log de atividades** do sistema (`registrarLog`, módulo `legalizacao`).

## 7. Telas

**Página `/legalizacao`** (menu): **Visão Geral** · **Prioridades** (selo = nº de vencidos) · *Documentos:* **Alvarás de funcionamento**, **Alvarás sanitários**, **Certificados digitais**, **Procurações** · *Carteira:* **Todos os clientes**, **Solicitações** (selo = nº em andamento) · *Acompanhamento:* **Evolução semanal**, **Qualidade dos dados**. Cabeçalho: link **📋 Como funciona** (`/legalizacao/regras`), **🔔** sino (marcar todas como lidas), menu do usuário, **⬇ CSV**, **⬇ PDF**, **↻ Atualizar**.

- **Visão Geral:** sete KPIs (Vencidos, Vencendo, Solicitação em andamento, Em dia, Dispensado, Não possui, Sem data), um cartão por documento com barra de situação e o "próximo a vencer", a tabela **Para agir primeiro** (8 mais urgentes) e **Atenção na base** (sem município, só pela pasta, sem data não consultado, consultado sem alvará, a conferir).
- **Listas** (Prioridades, Funcionamento, Sanitário, Certificados, Procurações, Todos os clientes, Solicitações, Qualidade): busca por empresa, CNPJ ou município; filtros de Documento, Situação, Consulta (automática, só pasta, sem município, pessoa física) e Pendência; 50 por página; botões por linha ("Informar protocolo", "Não vai renovar" para quem não é administrador e "Desativar" para o administrador).
- **Evolução semanal:** cinco cartões com a variação desde a semana anterior ("descer é bom" em vencidos, vencendo e sem data; "subir é bom" em dia), quatro gráficos de linha (SVG) e as tabelas **Semana a semana** e **Última semana, por documento**.
- **Qualidade dos dados:** seis cartões de pendência clicáveis (município não identificado, cidade sem consulta automática, sem data ainda não consultado, consultado nada localizado, data lida aguardando conferência, sem cadastro no Acessórias).
- **Ficha da empresa:** situação de cada documento (vencimento, prazo, nº, observações e andamento, selo "a conferir"), município e inscrição municipal, e ações: informar/corrigir município, informar inscrição municipal, informar protocolo, abrir o portal da prefeitura ou do sanitário (cidades sem consulta), **Solicitar inativação** (modal com observação obrigatória) e o botão do certificado.
- **No SPE (`/`, administrador):** cartão de pedidos de inativação (**✅ Validar e desativar** / **❌ Rejeitar**) e de desativação de certificado, **Conferir leituras por OCR** (confirma ou corrige a data) e **🩺 Saúde das consultas** (rotinas e cidades).

## 8. Pontos de atenção

1. **Analista (`colaborador`) não consegue usar dois botões que a tela mostra.** "📝 Não vai renovar" (`POST /solicitar-desativacao-certificado`) e "📨 Informar protocolo" (`POST …/protocolo`) não estão na lista de exceções de `server/auth.js:115–117` (só `GET`, `/solicitar-inativacao`, `/notificacoes/lidas` e os `PATCH` de município e inscrição). Para `colaborador` e `contabil` o servidor responde 403 ("Acesso restrito à sua nota da Gamificação."). O comentário do código diz "qualquer usuário da Legalização"; os testes só cobrem a tela (`testes_legalizacao_pagina.js`). [CONFIRMADO no código; falta conferir em produção com um login de analista]
2. **Aprovar inativação pode tirar a saída do churn.** A rota grava `clientes.motivo_saida` com o **motivo da lista de churn** (ex.: "Preço") ou "Inativação solicitada". Em `churnSaidas.classificarSaidaDetalhe` esse texto não casa com "transferida por" nem com "baixa" e vira `outra_saida` (arquivo 05, RN-CHU-003), ou seja, **não conta como churn** se o Acessórias não trouxer outro motivo. [INFERIDO; conferir com um caso real]
3. **Horários divergentes na documentação do próprio código.** Comentários dizem 03:00/05:00, o `.bat` diz "1×/dia de madrugada" e `ROTINAS_LEGALIZACAO` diz "toda segunda às 08:30". O agendamento real está no Agendador do Windows da estação e não é versionado. [DÚVIDA]
4. **Dependência de máquinas e logins pessoais:** consulta às prefeituras, leitura de pastas (caminho de rede com IP fixo no código), Protocolo Online (CPF da Josiane), Redesim (gov.br) e procurações (certificado) rodam fora do servidor, em horários de segunda e com sessão humana. Sem a pessoa/estação, os dados envelhecem (a saúde das rotinas avisa pelo sino, mas só após 200 h).
5. **IPs da CertiSeguro:** a API só aceita IPs cadastrados; o Render sai por faixas /24 e o campo da CertiSeguro não aceita faixa, então foram cadastrados IPs avulsos. Troca de IP do Render quebra a sincronização até alguém cadastrar o novo. [CONFIRMADO pelo histórico do projeto]
6. **Fonte dupla de verdade para o vencimento do sanitário/funcionamento** (consulta, PDF por OCR, Redesim, Protocolo, edição manual): cada uma tem regra própria de "não rebaixar" ou "só se maior"; uma data errada por OCR corrigida na fila de conferência pode ser trocada por outra fonte mais nova sem aviso. [INFERIDO]
7. `cliente_id` TEXT sem chave estrangeira: cliente excluído deixa linhas órfãs; os `JOIN` usam `id::text`. [CONFIRMADO]
8. `PUT alvaras/:clienteId/:tipo` substitui `numero` e `observacoes` por vazio se não vierem no corpo, e sobrescreve a data mesmo de uma leitura de OCR já conferida. [CONFIRMADO]
9. O painel carrega **todos** os clientes e documentos em uma chamada e consulta toda a tabela `clientes` (municípios) a cada abertura; escala bem com ~640 clientes, mas cresce linearmente. [INFERIDO]
10. Dois canais de token: `importar-certiseguro` exige `CERTISEGURO_SYNC_TOKEN`, os demais aceitam também `LEGALIZACAO_SYNC_TOKEN`; um mesmo segredo atende Legalização, Questor, Omie, e-mail e suspensos (arquivo 07, item 6.1).
11. Cobertura de teste: lógica pura testada (`testes_legalizacao_retrato.js`, `testes_legalizacao_pagina.js`, `testes_saude_rotinas.js`, que cobre ao menos o casamento de certificado PF e a saúde das rotinas); **sem teste** da regra de status em SQL, do Protocolo Online, da importação de procurações nem do controle de acesso por perfil. [CONFIRMADO]
