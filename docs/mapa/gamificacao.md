# Gamificação — Liga do Atendimento (nota mensal, ranking, consolidado e revisões)

Cobre a parte da Gamificação que mora em `server/routes/data.js` (≈ 45 rotas `/gam/*` mais a rota pública `/gamificacao`, linhas 3037–4950), o job que a alimenta (`server/index.js:251–320`), as telas (`public/gamificacao.html` pública, a área de administração em `public/index.html` + `Gamificacao` em `public/js/app.js`, e "Minha área" no /cs). A pontuação **por ticket** e o abandono estão em [cs/02-pontuacao-abandono.md](cs/02-pontuacao-abandono.md); aqui está tudo que **agrega** esses dados em nota mensal, ranking e consolidado.

Níveis de certeza: [CONFIRMADO] · [INFERIDO] · [DÚVIDA].

## 1. Objetivo

Ranking mensal de atendimento entre os analistas (a "Liga do Atendimento"), com pódio, premiação e um **Consolidado Geral** da temporada. A nota de cada pessoa vem da avaliação dos clientes no Zappy, ajustada por velocidade, aceite, encerramento (/finalizar) e abandono, e passa por revisão humana antes de contar.

## 2. Quem faz o quê

| Quem | O que alcança | Como o servidor decide |
| --- | --- | --- |
| Qualquer pessoa, sem login | `GET /api/public/gamificacao[?mes=]`: ranking do mês, consolidado (se ligado), lista de meses; páginas `/gamificacao/ranking` e `/gamificacao/regras` | rota do `publicRouter`, sem `requireAuth` |
| `administrador` | todas as rotas `/api/data/gam/*` de configuração, notas, revisões, travas, férias, meses fechados, logins | `requireAdmin` em cada rota |
| Colaborador (`acesso_minha_nota`) | `GET /gam/minha-composicao` e `GET /gam/meus-tickets` (e as rotas pessoais de Minha área) | resolve a pessoa **pelo login** (`gam_colaboradores.user_id = req.user.id`), nunca aceita `colaborador_id` do cliente |

`router.use(requireAuth)` (data.js:809) protege tudo que não é o `publicRouter`. O papel `colaborador` só chega às rotas `/gam/minha-*` e `/gam/meus-*` (`server/auth.js:105`); o `contabil` só com a flag `acesso_minha_nota`.

## 3. Modelo de dados

Criação "preguiçosa": `ensureGamTables()` roda `CREATE TABLE IF NOT EXISTS` / `ALTER … ADD COLUMN IF NOT EXISTS` no início de quase toda rota (cerca de 28 chamadas), e a rota pública repete a criação de 4 tabelas.

| Tabela | Colunas e regras |
| --- | --- |
| `gam_colaboradores` | `id UUID PK`, `nome TEXT NOT NULL`, `ativo BOOLEAN DEFAULT true`, `created_at`, **`zappy_user_id TEXT`** (liga ao usuário do Zappy; sem ele o colaborador **fica fora** do cálculo automático), **`aplica_regra_aceite BOOLEAN DEFAULT false`**, **`user_id TEXT → users(id) ON DELETE SET NULL`** (login da pessoa) |
| `gam_notas` | `id`, `colaborador_id → gam_colaboradores ON DELETE CASCADE`, `mes VARCHAR(7)`, `media_individual NUMERIC(4,2)`, `avaliacoes INT DEFAULT 0`, `lancado_por`, `updated_at`; **UNIQUE (colaborador_id, mes)** |
| `gam_config` | `chave TEXT PK`, `valor NUMERIC(6,2)`: `peso_minimo` (10), `mostrar_consolidado` (1), `permitir_filtro_meses` (1) |
| `gam_nota_final_override` | trava do pódio: `colaborador_id`, `mes`, `nota_final NUMERIC(4,2)`, `motivo`, `criado_por`, `criado_em`; UNIQUE (colaborador_id, mes) |
| `gam_ferias` | PK (`colaborador_id`, `mes`), `motivo`, `criado_por`, `criado_em` |
| `gam_meses_fechados` | `mes PK`, `fechado_por`, `fechado_em` |
| `gam_qualificacao_mapa` | `chave TEXT PK` (rótulo de qualificação do Zappy), `nota NUMERIC(3,2)` (NULL = ignorado) |
| `gam_velocidade_revisoes` · `gam_aceite_revisoes` · `gam_finalizar_revisoes` | `id`, `ticket_id → cs_tickets ON DELETE CASCADE`, `papel` (checks: velocidade `transferiu/recebeu/unico`; aceite `transferiu/unico`; finalizar `recebeu/unico`), `status pendente/devida/indevida`, `revisado_por/em`, `override_analista_id TEXT`; UNIQUE (ticket_id, papel) |
| `gam_tickets_pontos`, `gam_abandono_incidentes` | por ticket e por dia: ver arquivo 02 |
| `cs_tickets.revisao_nota_*` | revisão da **nota do cliente** (`status`, `por`, `em`, `override_analista_id`) |

As revisões de velocidade, aceite e finalizar ficam em tabelas **separadas** de `gam_tickets_pontos` de propósito: aquela tabela é reescrita a cada recálculo e uma decisão humana não pode se perder. [CONFIRMADO] (comentário no código).

## 4. Regras de negócio (RN-GAM)

### 4.1 Nota mensal individual
`executarAutoPreencher(mes, { dryRun, lancadoPor })` é o núcleo, usado pelo job, pelos botões de admin e (em prévia) pelas telas de composição. Para cada colaborador **ativo e vinculado ao Zappy**:

- **RN-GAM-001 Fonte 1 (preferida): tickets pontuados.** Linhas de `gam_tickets_pontos` do mês com papel `recebeu`/`unico`, cujo dono efetivo é `COALESCE(revisão da nota .override, p.analista_id) = zappy_user_id` e cuja revisão de nota **não** é `indevida`.
  ```text
  mediaBase       = média(nota_final)                                   // = nota real do cliente
  bonusTransf.    = média( ajuste_velocidade de: seus transferiu (não indevidos e não reatribuídos a outro)
                           + seus recebeu/unico (não indevidos, não reatribuídos)
                           + velocidades reatribuídas a você e 'devida' )
  bonusAceite     = (só se aplica_regra_aceite) média(ajuste_aceite) de transferiu/unico, sem os 'indevida', dono = COALESCE(override, original)
  bonusFinalizar  = média(ajuste_finalizar) dos seus + reatribuídos a você 'devida', sem 'indevida'
  bonusAbandono   = −(incidentes não indevidos do mês, dono = COALESCE(override, original)) ÷ (nº de avaliações)
  media_individual = arredonda2( limita(0, 5, mediaBase + bonusTransf. + bonusAceite + bonusFinalizar + bonusAbandono) )
  avaliacoes       = nº de linhas recebeu/unico consideradas
  ```
  Tudo é **média, não soma**, para o volume não distorcer a nota. **Só quem tem nota real** (pelo menos 1 linha `recebeu/unico`) recebe nota; quem apenas transferiu acumula ajuste "em banco" mas fica **sem avaliação**.
- **RN-GAM-002 Fonte 2 (reforço): qualificação agregada do Zappy**, só quando o colaborador **não** tem ticket pontuado no mês. `buscarTicketsPorQualificacao` devolve contagens por rótulo; cada rótulo é traduzido por `gam_qualificacao_mapa`. Rótulo novo é cadastrado com `nota = NULL` (aparece na tela "Mapa de Qualificação" e é **ignorado** do cálculo). `media = Σ(nota × total) ÷ Σ(total)` dos rótulos mapeados.
- **RN-GAM-003 Trava anti-zero.** Se não vier nada (nem ticket, nem qualificação), grava 0/0 **apenas se não havia nada antes**; se já havia `avaliacoes > 0`, **preserva** o valor antigo e devolve um aviso. Criada em 04/09/2026 depois que rodar um mês antigo apagou Maio e Junho de 20 pessoas (a API de qualificação não devolve meses velhos).
- **RN-GAM-004 Mês fechado.** `isMesFechado(mes)` faz a função devolver `{ fechado: true, aviso }` **antes** de qualquer consulta ou gravação — vale também para a prévia. Maio, Junho e Julho/2026 nascem fechados ("Sistema (protegido por padrão)") na primeira execução; depois disso o administrador pode reabri-los. Fechar não recalcula nada; só impede escritas dali em diante.
- **RN-GAM-005 `dryRun`** (padrão `true`) só calcula e devolve; o job e "Sincronizar Notas Agora" usam `false`. `lancado_por` distingue manual de automático.

### 4.2 Nota final e ranking do mês (rota pública)
```text
mediaGeral(mês) = média simples de media_individual dos colaboradores ATIVOS com avaliacoes > 0
notaFinal       = (media_individual × avaliacoes + mediaGeral × peso_minimo) ÷ (avaliacoes + peso_minimo)     // peso_minimo padrão 10
trava de pódio  = se existe gam_nota_final_override do mês, substitui notaFinal
quem tem 0 avaliações recebe a MENOR notaFinal do mês (depois das travas)
ordem: maior notaFinal (4 casas; diferença < 0,00005 = empate real)
       desempates: mais avaliações → maior media_individual (2 casas) → ordem alfabética (pt-BR)
```
Exemplo (peso 10, média geral 4,50): A tem média 5,0 em 20 avaliações → (100 + 45) ÷ 30 = **4,8333**; B tem 4,0 em 2 avaliações → (8 + 45) ÷ 12 = **4,4167**; C tem 0 avaliações → recebe o menor valor do mês (**4,4167**). O peso mínimo puxa quem tem pouco volume para a média geral.

### 4.3 Consolidado Geral da temporada
`calcularConsolidadoGamificacao(peso)`:
- Para **cada mês** com nota lançada, recalcula a nota final **do zero a partir de `gam_notas`** (as travas de pódio **não** entram) e dá a **todo colaborador ativo** a nota do mês — quem não tem avaliação (ou nem existia ainda) recebe a **menor nota final do mês**.
- **Mês sem nenhuma avaliação de ninguém fica de fora** (decisão de 01/10/2026: o primeiro dia de um mês novo zerava todo mundo).
- `media_geral` = média simples das notas finais mensais (4 casas; desempate só em empate exato). Sem peso por tempo de casa.
- **Férias/afastamento:** os meses marcados em `gam_ferias` saem da média **da própria pessoa** (equivale a trocar a nota do mês pela média dos outros). Se **todos** os meses dela estão marcados, usa todos. O ranking e o pódio **mensais não mudam**. Retorna `meses_ferias`, `ferias_meses`, `media_sem_ajuste`, `meses_avaliados`.
- O card pode ser ocultado na página pública (`mostrar_consolidado`); nesse caso a rota pública **nem calcula** (economiza N consultas por mês) e o admin usa `GET /gam/consolidado`, que sempre calcula.

### 4.4 Revisões (5 filas)
Toda linha começa `pendente`; o admin marca **devida** (conta) ou **indevida** (sai do cálculo) e pode **reatribuir** a outro colaborador (`novo_colaborador_id`, que precisa ter `zappy_user_id`). Reabrir (`pendente`) limpa a decisão **e** a reatribuição.

| Fila | Chave | Pergunta | Efeito de "indevida" | Efeito da reatribuição |
| --- | --- | --- | --- | --- |
| Nota baixa (`tickets-revisao`) | ticket | A nota do cliente vale? (todo ticket com nota < 5, **mais** nota 5 cujo contato parece ser alguém da equipe, para pegar avaliação em causa própria) | o ticket sai da média de quem encerrou, do Risco e do Painel | a **linha inteira** (nota + velocidade + finalizar) passa para outra pessoa; só com `devida` |
| Velocidade | ticket + papel | O desconto de velocidade reflete a realidade? (ex.: analista esperando o cliente mandar um documento) | remove só o `ajuste_velocidade` (em `transferiu` a linha inteira sai da média) | o desconto vira um item a mais na média de outra pessoa |
| Aceite | ticket + papel | Esse contato devia contar na métrica? (bot, marketing, currículo) | sai da amostra do aceite | move o aceite inteiro |
| Finalizar | ticket + papel | A reabertura reflete encerramento mal feito? | sai de `bonusFinalizar` | move só o desconto |
| Abandono | ticket **+ dia** | O cliente ficou mesmo sem resposta nesse dia? | sai de `bonusAbandono` | move o incidente inteiro |

`GET /gam/ticket-busca` acha um ticket por número para usar nas cinco telas sem depender de ele estar na lista de pendentes (pedido de 28/08/2026).

### 4.5 Travas e correções de pódio
- **Trava de nota final** (`gam_nota_final_override`): fixa a nota de alguém **só no pódio do mês** já anunciado, sem mexer em `gam_notas` nem no Consolidado. Criada em 04/09/2026 para Julho; `DELETE /gam/nota-final-override` apaga todas ("sistema rodando sem travas a partir de Janeiro").
- **Recalcular pontos** (`POST /gam/recalcular-pontos`): refaz `gam_tickets_pontos` **e** o abandono do mês (forçado) quando a fórmula muda; uma trava local impede dois ao mesmo tempo (409).

### 4.6 Quando roda sozinho
- `rodarIngestaoCS` a cada 5 min (ingestão do Zappy, arquivo 01).
- `checarAgendaDiaria` a cada 5 min dispara `rodarAtualizacaoNotasCS` nos horários **08:00, 11:00 e 15:00 de Brasília** (um disparo por hora do dia, controlado por um `Set` em memória): (1) `atualizarNotasPendentes` rebusca a nota de tickets fechados nos últimos **5 dias** ainda sem avaliação; (2) `executarAutoPreencher(mêsAtual, { dryRun: false, lancadoPor: 'job diário' })`. Só mexe no **mês corrente** (calculado em Brasília) e autocorrige sozinho no dia seguinte se alguém revisar uma nota. Meses fechados são ignorados.
- Só roda se `ZAPPY_BASE_URL` e `ZAPPY_TOKEN` existem.

## 5. Rotas (`/api/data/…`)

| Grupo | Rotas | Acesso |
| --- | --- | --- |
| Pública | `GET /api/public/gamificacao[?mes=]` | sem login |
| Configuração | `GET/PATCH /gam/config` (`peso_minimo` ≥ 0, `mostrar_consolidado`, `permitir_filtro_meses`) | admin |
| Colaboradores | `GET/POST /gam/colaboradores`, `PATCH …/:id/toggle`, `…/:id/aceite`, `…/:id/login`, `…/:id/zappy`, `DELETE …/:id` (apaga também as notas, por cascata), `POST …/criar-logins-em-lote`, `GET /gam/usuarios-zappy` | admin |
| Notas | `GET/POST /gam/notas` (média 0–5), `DELETE /gam/notas/:id`, `POST /gam/notas/auto-preencher`, `GET/PATCH /gam/qualificacao-mapa` | admin |
| Consolidado e férias | `GET /gam/consolidado`, `POST/DELETE /gam/ferias` | admin |
| Meses | `GET /gam/meses-fechados`, `POST /gam/mes/:mes/fechar` e `/reabrir` | admin |
| Travas | `GET/POST/DELETE /gam/nota-final-override`, `DELETE …/:id` | admin |
| Transparência | `GET /gam/composicao-nota` (qualquer colaborador), `GET /gam/relatorio-descontos` | admin |
| Self-service | `GET /gam/minha-composicao?mes=`, `GET /gam/meus-tickets?mes=` | login (a própria pessoa) |
| Revisões | `GET/PATCH /gam/tickets-revisao`, `…-velocidade`, `…-aceite`, `…-finalizar`, `…-abandono` (PATCH em `/:id` ou `/:ticketId/:papel`) | admin |
| Manutenção | `POST /gam/recalcular-pontos`, `GET /gam/diagnostico-analista` e `/diagnostico-vinculos` (**temporárias**) | admin |

`criar-logins-em-lote` (admin): para cada colaborador ativo sem login monta `nome@escritorial.com.br` (minúsculas, sem acento/espaço); se o usuário existe só **vincula** e liga `acesso_minha_nota` (revoga os tokens dele); senão **cria** um login `colaborador` com a senha informada (mínimo 6). `dryRun = true` por padrão, para o clique de criação ser deliberado.

## 6. Telas

- **Página pública** (`/gamificacao/ranking`, `public/gamificacao.html`): título "🏆 Gamificação", média geral do mês, **seletor de mês** (some se `permitir_filtro_meses = 0`), **Premiação Mensal**, **pódio** (1º ao centro, ouro/prata/bronze), **Ranking Completo** e o card **📊 Consolidado Geral** (some se `mostrar_consolidado = false`). É embutida no /cs (aba Gamificação) por `iframe`. `/gamificacao/regras` explica as regras (inclui a das férias desde 30/10/2026).
- **Administração** (`public/index.html`, objeto `Gamificacao` em `app.js`): botões **Ver página pública**, **Peso Mínimo**, **Consolidado Geral** (liga/desliga), **Férias**, **Filtrar Meses Anteriores** (liga/desliga), **Gerenciar Colaboradores**; bloco **Lançar Notas do Mês** (mês de referência, carregar colaboradores, **Auto-preencher (Zappy)** com prévia, **Sincronizar Notas Agora**, **Mapa de Qualificação**, as cinco revisões, **Relatório de Descontos**, **Relatório da Temporada**, **Baixar apresentação**, **Limpar travas de pódio**, **Recalcular Pontos**, **Fechar/Reabrir Mês**); tabelas **Resultado do Mês** (Pos., Colaborador, Média Individual, Avaliações, Nota Final) e **Consolidado Geral da Temporada** (Pos., Colaborador, Meses, Média Geral).
- **Relatório da Temporada** (`abrirRelatorioTemporada`): confirma, **sincroniza só o mês de referência** (não os anteriores; mês fechado não é sincronizado), lê o ranking público de cada mês, usa o consolidado do último mês (ou `GET /gam/consolidado` se o card está oculto), monta o relatório em uma nova aba (evolução por colaborador com † nos meses de férias, perfis do pódio) e gera a **apresentação PowerPoint** no navegador com `pptxgenjs@3.12.0` (carregado de jsDelivr ou unpkg): capa, prêmios, campeões de cada mês, do 10º ao 4º e o pódio de trás para frente (3º Alexa, 2º Air Fryer, 1º Smart TV, com slide de suspense). A falha do PowerPoint não derruba o relatório.
- **Minha área (/cs)**: **Minha nota** (`/gam/minha-composicao`: nota base + os quatro bônus, por mês), **Meus atendimentos**, **Meus e-mails**, **Evolução semanal** e **Prioridades** (todos de `GET /api/cs/painel/qualidade/analista/meu-painel`, que resolve o analista pelo login; admin/usuário podem pedir outro com `?analista=`). Prioridades: tratativa vencida (alta) ou com prazo em até 3 dias (média), e-mails sem resposta (≥ 3 = alta), SLA vermelho dos últimos 30 dias (média).

## 7. Pontos de atenção

1. ~~"Reabrir" Maio, Junho e Julho/2026 não funciona~~ — **corrigido em 31/10/2026** (código; vale após o deploy): a gravação inicial desses três meses agora roda uma única vez, marcada em `gam_config` (`semente_inicial_v1`), e o reabrir passa a valer. Texto do problema antigo: `ensureGamTables()` reinsere os três meses em `gam_meses_fechados` (`INSERT … ON CONFLICT DO NOTHING`) a cada chamada, e quase toda rota de `/gam` a chama; o `POST /gam/mes/:mes/reabrir` apaga a linha, mas a próxima leitura (inclusive a que recarrega a tela) a recria. Para esses três meses o fechamento é permanente. [CONFIRMADO no código; não testado em produção]
2. ~~A regra de aceite da Elma volta sozinha~~ — **corrigido em 31/10/2026** (mesma semente única; o nome "Elma" continua fixo, mas só na primeira execução). Texto do problema antigo: A mesma função executa `UPDATE gam_colaboradores SET aplica_regra_aceite = true WHERE nome = 'Elma' AND aplica_regra_aceite = false`: desligar a flag pela tela (`…/aceite`) é desfeito na chamada seguinte, e o nome "Elma" está fixo no código. [CONFIRMADO]
3. **Custo da tela "Minha nota".** `minha-composicao` e `composicao-nota` rodam `executarAutoPreencher(mes, { dryRun: true })` **para todos os colaboradores** e escolhem uma linha; quem não tem ticket pontuado dispara ainda uma chamada à API de qualificação do Zappy. Cada acesso de um analista custa dezenas de consultas e possivelmente chamadas externas. [CONFIRMADO]
4. **Fuso:** o mês do ticket usa UTC (arquivo 02, RN-PON-008), enquanto o job diário usa Brasília para escolher o mês atual. [INFERIDO] pode divergir nas últimas 3 horas do mês.
5. **XSS de nome:** `gamificacao.html` monta o pódio com `${r.nome}` direto em `innerHTML`; hoje só administradores criam colaboradores, mas o ranking é público. [CONFIRMADO no trecho lido]
6. **Rotas temporárias** (`diagnostico-analista`, `diagnostico-vinculos`) continuam expostas ao admin.
7. **Código morto:** `server/routes/gamificacao.js` (187 linhas) usa tabelas `gamificacao_colaboradores/notas/premios` que não existem e **não é montado** em `index.js` (Fase 1). As tabelas reais são as `gam_*`.
8. Dados de negócio fixos no código: meses protegidos 05–07/2026, nome "Elma", horários 08/11/15 e prêmios (Alexa, Air Fryer, Smart TV) na apresentação; mudar exige deploy.
9. Cobertura de teste: só `server/testes_gam_ferias.js` (consolidado com férias, lendo o trecho do código-fonte com pool simulado). Não há teste da nota mensal, do ranking, do pódio com travas nem das revisões. [CONFIRMADO]
10. A nota por ticket exibida pode não coincidir com a contagem bruta do relatório nativo do Zappy: só contam tickets de vínculo `cliente` (arquivo 02, RN-PON-001); as rotas de diagnóstico existem para explicar essa diferença.
