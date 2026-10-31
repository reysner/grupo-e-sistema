# /cs — Pontuação por ticket e abandono de atendimento (motor da Gamificação)

Cobre `server/cs/pontuacao.js` e `server/cs/abandono.js`. A **nota mensal** de cada colaborador e o ranking (que consomem estas tabelas) estão no arquivo da Gamificação (`docs/mapa/gamificacao.md`, lote seguinte). Aqui está tudo que acontece **por ticket**.

Níveis de certeza: [CONFIRMADO] · [INFERIDO] · [DÚVIDA].

## 1. Objetivo

Transformar cada atendimento avaliado pelo cliente em linhas de pontuação por colaborador (`gam_tickets_pontos`) e detectar dias em que um cliente ficou sem resposta (`gam_abandono_incidentes`). As duas coisas viram médias mensais (bônus e descontos) na nota final.

## 2. Modelo de dados

### 2.1 `gam_tickets_pontos`
| Coluna | Tipo | Nulo | Default | Descrição |
| --- | --- | --- | --- | --- |
| `id` | UUID PK | não | `gen_random_uuid()` | |
| `ticket_id` | UUID FK → `cs_tickets` `ON DELETE CASCADE` | não | — | |
| `papel` | TEXT CHECK | não | — | `transferiu`, `recebeu` ou `unico` |
| `analista`, `analista_id` | TEXT | sim | — | nome e id do usuário no Zappy |
| `mes` | VARCHAR(7) | não | — | `AAAA-MM` do encerramento (ou abertura) em **UTC** (`toISOString().slice(0,7)`) |
| `nota_cliente` | SMALLINT | não | — | 1 a 5 |
| `ajuste_velocidade` | NUMERIC(3,1) | sim | 0 | 0 ou −1 |
| `ajuste_finalizar` | NUMERIC(3,1) | sim | 0 | 0 ou −1 |
| `ajuste_reabertura` | NUMERIC(3,1) | sim | 0 | sempre 0 hoje (compatibilidade) |
| `ajuste_aceite` | NUMERIC(3,1) | sim | — | 0, −1 ou NULL (não se aplica ao papel) |
| `nota_final` | NUMERIC(3,2) | não | — | ver RN-PON-004 |
| `calculado_em` | TIMESTAMPTZ | sim | `NOW()` | |
`UNIQUE (ticket_id, papel)`; índice `(mes, analista_id)`. Um ticket gera até **2 linhas** (`transferiu` e `recebeu`) ou 1 (`unico`).

### 2.2 `gam_abandono_incidentes`
`id UUID PK`, `ticket_id UUID NOT NULL → cs_tickets CASCADE`, `data DATE NOT NULL`, `mes VARCHAR(7) NOT NULL`, `analista`, `analista_id`, `ultima_mensagem_cliente TIMESTAMPTZ`, `ultima_mensagem_texto TEXT`, `status TEXT NOT NULL DEFAULT 'pendente' CHECK IN ('pendente','devida','indevida')`, `revisado_por`, `revisado_em`, `detectado_em DEFAULT NOW()`, `override_analista_id TEXT` (reatribuição), `UNIQUE (ticket_id, data)`, índice `(mes, analista_id)`. Mais a coluna `cs_tickets.abandono_calculado_em`.

### 2.3 Colunas de revisão em `cs_tickets`
`revisao_nota_status` (`pendente`, `devida`, `indevida`; default `'pendente'`), `revisao_nota_por`, `revisao_nota_em`, `revisao_nota_override_analista_id`. Detalhe da revisão no arquivo da Gamificação.

## 3. Regras de pontuação (RN-PON)

Origem: `pontuacao.js → calcularPontosTicket` (função pura) e `persistirPontosTicket`.

- **RN-PON-001 — Só ticket de cliente e avaliado.** Pontua apenas tickets cujo vínculo (`cs_vinculos.tipo`) é `cliente` **e** com `nota_avaliacao` preenchida. Se o vínculo deixou de ser `cliente` depois, as linhas já gravadas são **apagadas** (`DELETE FROM gam_tickets_pontos WHERE ticket_id`). Contato `pendente` não pontua.
- **RN-PON-002 — Dono da nota.** A nota do cliente vai só para quem **encerrou** o atendimento: papel `unico` (ninguém transferiu) ou `recebeu` (recebeu uma transferência). `foiTransferido = transferencia IS NOT NULL E analista_anterior IS NOT NULL`.
- **RN-PON-003 — Quem só transferiu** recebe uma linha `transferiu` com apenas o ajuste de velocidade (`notaFinal = ajusteVelocidade`, sem nota do cliente).
- **RN-PON-004 — Valor de `nota_final`.** Papel `unico`/`recebeu`: `nota_final = nota do cliente` (sem descontos embutidos; desde 17/09/2026 os ajustes viram médias mensais separadas). Papel `transferiu`: `nota_final = ajuste_velocidade`.
- **RN-PON-005 — Velocidade (métrica 1)** `tierVelocidade(min)`: `min <= 30` → 0; `> 30` → −1; sem relógio → `null` (gravado como 0). Sem bônus positivo (27/08/2026). Qual relógio: `transferiu` → relógio `transferencia`; `recebeu` → `departamento`; `unico` → `aceite`.
- **RN-PON-006 — Aceite (métrica extra)** `tierAceite(min)`: `min <= 15` → 0; `> 15` → −1. Gravado em todo ticket para quem fez o aceite original (`transferiu` e `unico`; `NULL` em `recebeu`), mas só **aplicado** na nota mensal de colaboradores com `gam_colaboradores.aplica_regra_aceite = true` (hoje só a recepção).
- **RN-PON-007 — Finalizar + reabertura (regra combinada, 28/08/2026)**:
  ```text
  ultima = última mensagem do escritório do ticket
  avisouCorretamente = ultima contém alguma de 19 frases de encerramento
        ("estou finalizando o atendimento", "fico à disposição para qualquer dúvida", "até a próxima", "tenha um ótimo dia"...)
  clienteReabriu = existe mensagem do CLIENTE depois do encerramento, dentro de 30 min ÚTEIS (T.minutosUteis), que NÃO seja só um número de 1 a 5
  ajusteFinalizar = (NÃO avisouCorretamente E clienteReabriu) ? -1 : 0
  ```
  Avisou certo → sempre 0, mesmo que o cliente volte. Não avisou e o cliente não volta → 0.
- **RN-PON-008 — Mês do ticket** = mês de `encerramento` (ou `abertura`, ou agora) convertido por `toISOString()` (**UTC**). [INFERIDO] um ticket encerrado nas últimas 3 horas do último dia do mês (Brasília) cai no mês seguinte; já `recalcularPontosDoMes` e as consultas usam `TO_CHAR(COALESCE(encerramento, abertura),'YYYY-MM')` do banco (também UTC em servidor UTC). [DÚVIDA] a conferir se o fuso do servidor é UTC.
- **RN-PON-009 — Quando recalcula.** `recalcularPontosPendentes(limite)` pega tickets com nota que **não têm linha** ou cujo `updated_at > calculado_em`, mais recentes primeiro (100 por ciclo de 5 min). `recalcularPontosDoMes(mes)` refaz **todos** os tickets avaliados do mês (botão "Recalcular Pontos"); necessário quando a fórmula muda. A revisão humana (`revisao_nota_*`) fica em `cs_tickets` e **não** é apagada pelo recálculo.

Exemplo numérico (papel `unico`): cliente dá nota 5; aceite em 20 min úteis (−1 de aceite gravado); resposta em 10 min; encerra sem frase de encerramento e o cliente volta em 12 min com pergunta nova. Linha: `nota_final = 5`, `ajuste_velocidade = 0`, `ajuste_aceite = −1`, `ajuste_finalizar = −1`.

## 4. Regras de abandono (RN-ABA)

Origem: `abandono.js → detectarIncidentesAbandono`, `persistirAbandonoTicket`.

- **RN-ABA-001 — Condição.** Para cada dia em que o ticket (já **aceito**) teve mensagens, existe incidente se há uma mensagem do **cliente** até o **corte do cliente** que parece pedido (não é fechamento) e **nenhuma** mensagem do escritório entre ela e o **corte de resposta** do mesmo dia.
- **RN-ABA-002 — Cortes** (`CORTES_POR_DIA`): segunda a quinta: cliente até **16:50**, resposta até **17:30**; sexta: cliente até **16:20**, resposta até **17:00**. Sábado, domingo e feriados do `tempoUtil.FERIADOS` não contam.
- **RN-ABA-003 — Só depois do fim do expediente.** Se `agora < corteResposta` do dia, o dia não é avaliado (nunca crava o dia corrente antes de terminar).
- **RN-ABA-004 — Respaldo.** Qualquer mensagem do **escritório** depois do pedido e até o corte de resposta (mesmo "vou ver") impede o incidente. Mensagens `sistema` (bot, pesquisa) **não** respaldam.
- **RN-ABA-005 — Fechamento.** `pareceMensagemDeFechamento` é verdadeira se o texto é vazio, é só `1` a `5` (a nota da pesquisa), ou, depois de tirar pontuação das pontas, tem **até 40 caracteres** e é igual ou começa com uma das 73 frases (`ok`, `obrigado`, `entendido`, `bom dia`, `figurinha`, emojis `👍 🙏 ✅`…) seguida de espaço, vírgula ou `!`.
- **RN-ABA-006 — Um incidente por (ticket, dia).** Cada dia é revisável separadamente (Devida ou Indevida).
- **RN-ABA-007 — Dono do incidente.** Quem estava com o ticket na hora: se a última mensagem do cliente é **anterior** à `transferencia`, vale `analista_anterior`; senão `analista`. Só cobre uma transferência. `override_analista_id` (reatribuição na revisão) tem precedência na nota mensal.
- **RN-ABA-008 — Ciclo.** `recalcularAbandonoPendentes(30)` roda a cada ingestão em tickets aceitos nunca checados ou alterados depois da última checagem; cada ticket com timeout de 20 s (`Promise.race`) para um travamento não derrubar o lote. `recalcularAbandonoDoMes(mes)` força todos os tickets aceitos do mês (usado após mudar a regra). Incidentes que deixam de bater são apagados; o status de revisão dos que continuam é preservado.
- **RN-ABA-009 — Efeito na nota mensal.** `bonusAbandono = −(incidentes não indevidos do colaborador no mês) ÷ (número de atendimentos avaliados dele no mês)`. Exemplo do pedido original: 3 incidentes ÷ 20 atendimentos = −0,15. Detalhe em `gamificacao.md`.
- **RN-ABA-010 — Só ticket de cliente.** Se o vínculo não é `cliente`, os incidentes do ticket são apagados.

## 5. Efeito dos ajustes na nota mensal (resumo; fórmulas completas na Gamificação)

Para cada colaborador e mês, sobre as linhas `recebeu` e `unico` não `indevida` da revisão de nota:
```text
mediaBase       = média de nota_final (= nota real do cliente)
bonusVelocidade = média dos ajuste_velocidade (próprios + transferências + reatribuídos)    // 0 ou negativo
bonusAceite     = média dos ajuste_aceite (só se aplica_regra_aceite)
bonusFinalizar  = média dos ajuste_finalizar
bonusAbandono   = -(incidentes / atendimentos avaliados)
media_individual = clamp(mediaBase + bonusVelocidade + bonusAceite + bonusFinalizar + bonusAbandono, 0, 5)   // arredonda em 2 casas
```
Todos são **médias, não somas**, para o volume não distorcer a nota (decisão registrada no código).

## 6. Pendências e inconsistências

1. `ajuste_reabertura` está morto (sempre 0), mantido só por compatibilidade.
2. O mês do ticket em UTC pode divergir do mês de Brasília perto da virada (RN-PON-008).
3. Só uma transferência é rastreada (`cs_tickets` guarda o par atual e anterior): em cadeias A→B→C o crédito do meio se perde.
4. A lista de frases de encerramento (19) e de fechamento (73) é calibrada à mão; mudanças exigem "Recalcular Pontos" e recálculo de abandono do mês.
