# /cs — Risco de perda do cliente (Gestão da Permanência)

Cobre `server/cs/riscoCalculo.js` (regras puras, com testes em `testes_risco.js`) e `server/cs/risco.js` (leitura dos dados, rotas, sincronização das entregas, foto diária). Prefixo `/api/cs/risco`. Tela: seção **Gestão da Permanência** (`risco`, módulo `permanencia`) e o selo de risco da ficha do cliente.

Níveis de certeza: [CONFIRMADO] · [INFERIDO] · [DÚVIDA].

## 1. Objetivo

Dar a cada cliente ativo **pessoa jurídica (CNPJ)** uma pontuação de 0 a 100 (quanto maior, pior) e um nível **Baixo, Médio ou Alto**, a partir de quatro termômetros. Alinhamento Reysner × Larissa em 05/10/2026.

## 2. Entradas e tabelas

| Fonte | Tabela / origem | Janela | Quem alimenta |
| --- | --- | --- | --- |
| Financeiro | `financeiro_aberto` (títulos em atraso por CNPJ: `qtd_atrasados`, `valor_atrasado`, `mais_antigo`), `financeiro_clientes` (quem está na leitura do Omie) e `clientes.inadimplente_cronico` | atual | carga do Omie (módulo Financeiro) |
| Atendimento | `insatisfacoes` (180 d), `clientes_sensiveis` (90 d), `pesquisas` com `nps <= 6` (180 d), `cs_tickets` ligados a `cs_vinculos.tipo = 'cliente'` (90 d) | 90 a 180 d | páginas `/` e Zappy |
| Operacional | `cliente_entregas_resumo` | 90 d | Acessórias |
| Tratativas | `cs_qualidade_registros` com `origem = 'modulo'` e `plano_cs = false` (90 d) + peso em `cs_qualidade_tipos` | 90 d | módulo Qualidade |
| Suspensos | `omie_contratos_suspensos (doc TEXT PK, contrato, nome, atualizado_em)` | atual | carga do Omie por token |
| Configuração | `cs_config` chave `risco_config` (JSON `{pesos, cortes}`) | | administrador |
| Foto | `cs_config` chaves `risco_foto_ultima` e `risco_foto_AAAA-MM-DD` | 120 dias | job diário |

`cliente_entregas_resumo (doc TEXT PK, total INT, atrasadas_entregues INT, vencidas_pendentes INT, janela_ini DATE, janela_fim DATE, atualizado_em TIMESTAMPTZ, versao INT DEFAULT 1)`.

## 3. Os termômetros (RN-RIS)

Cada um devolve `{ pontos (0 a 100 ou null), detalhe[] }`. `limitar(v) = max(0, min(100, round(v)))`.

**RN-RIS-001 Financeiro.** Sem dado (CNPJ fora da leitura do Omie e sem título em atraso): `null`. Com título em atraso (`qtd > 0`): `dias` = dias entre o título mais antigo e hoje; `pontos = 90 (> 90 dias) | 75 (> 60) | 60 (> 30) | 40 (> 15) | 25 (demais)`; `+10` se `qtd >= 3`. Em dia: 0. **Inadimplente crônico** (`clientes.inadimplente_cronico`): `pontos = max(pontos, 70)`.

**RN-RIS-002 Atendimento** (sempre tem dado; ausência = 0). Soma, limitada a 100:
- Insatisfações (até 180 dias): peso por gravidade `muito alta 40, alta 30, média 20, baixa 10, muito baixa 5` (outra: 15), **×1 até 90 dias, ×0,5 de 91 a 180**.
- Clientes sensíveis (até 90 dias): `muito alta 30, alta 22, média 15, baixa 8, muito baixa 4` (outra: 12).
- Notas baixas (`nota_avaliacao <= 2`, 90 d): **20 por nota**.
- SLA vermelho (`pior_status = 'vermelho'`, 90 d): `min(20, 5 por ticket)`.
- Detratores (pesquisa NPS ≤ 6, 180 d): `min(30, 15 por pesquisa)`.
- Notas baixas e SLA vermelho chegam **depois da revisão da Gamificação**: nota marcada `indevida` e SLA cuja revisão de velocidade foi só `indevida` saem (pedido de 06/10/2026). Abandono de atendimento **não** entra (decisão de 16/10/2026).

**RN-RIS-003 Operacional.** `suspenso` → sem dado (o atraso já está no Financeiro). Sem dado ou `total = 0` → sem dado. `total < 5` (`MIN_ENTREGAS_OPERACIONAL`) → sem dado ("poucas para avaliar"). Senão `problema = atrasadasEntregues + vencidasPendentes`; `pontos = limitar((problema ÷ total) × 200)` (50% de problema = 100 pontos).

**RN-RIS-004 Tratativas.** Entra só ocorrência lançada **no módulo Qualidade** (`origem = 'modulo'`), não cancelada, sem `plano_cs`, até 90 dias. Cada ocorrência: `peso × 2 × fator × (dias > 45 ? 0,5 : 1)`, em que `peso` vem de `cs_qualidade_tipos.peso` (se nulo: multa 25, reclamação 20, falha de atendimento 20, erro 15, atraso 10, falha técnica 10, outros 5) e `fator` = 1,5 se aberta/em tratamento **com prazo vencido**; 1 aberta ou em tratamento; 0,5 finalizada (aguardando validação); 0,25 resolvida. Soma limitada a 100. **Só há dado enquanto existir tratativa pendente** (aberta, em tratamento ou finalizada); com só ocorrências resolvidas devolve `min(25, pontos)` marcado `foraDaMedia` (aparece no card e vira "sinal de atenção", mas não entra na média); sem nenhuma, `null` ("Nenhuma ocorrência em aberto").

**RN-RIS-005 Risco final** (`calcularRisco`):
```text
usados   = termômetros com pontos != null, não foraDaMedia e peso > 0
semDado  = termômetros-base (financeiro, atendimento, operacional) sem pontos
se usados vazio -> nível 'Incompleto'
pontos   = limitar( soma(pontos_t × peso_t) / soma(peso_t) )           // pesos iniciais todos 1
alerta   = algum usado com pontos >= 75
nível    = pontos >= alto ? 'Alto' : pontos >= medio ? 'Médio' : 'Baixo' // cortes padrão: médio 30, alto 60
se alerta e nível == 'Baixo' -> 'Médio'                                   // um termômetro alto sozinho puxa ao menos para Médio
parcial  = semDado não vazio                                              // Tratativas sem dado NÃO deixa o risco parcial
```
Motivos = detalhes dos termômetros usados, do mais pontuado para o menos, mais o sinal de ocorrência resolvida.
Exemplo: Financeiro 60 (título mais antigo há 45 dias), Atendimento 20, Operacional sem dado, Tratativas sem dado → `(60 + 20) ÷ 2 = 40` → **Médio**, `parcial = true`.

**RN-RIS-006 Suspenso** (Omie): cliente com contrato suspenso fica com nível **Suspenso**, sem pontos, **fora** de Alto/Médio/Baixo, das contagens e da foto dos laudos; os termômetros seguem calculados para a ficha. [CONFIRMADO] decisão de 09/10/2026; só o Omie vale (não a TAG do Acessórias).

**RN-RIS-007 Só CNPJ.** Clientes ativos cujo documento não é CNPJ (CPF, CAEPF, CNO, sem documento) ficam fora (`ehPessoaJuridica`, `desconsiderados_nao_cnpj`).

**RN-RIS-008 Configuração.** `PUT /config` (admin): pesos ≥ 0 (ao menos um > 0) e cortes `0 < médio < alto <= 100`; erros "Informe pesos de 0 em diante (ao menos um maior que zero)." e "Os cortes precisam estar em ordem: Médio < Alto, até 100."

## 4. Entregas do Acessórias (Operacional)

- **RN-RIS-009 Só o que chega ao cliente** (decisão de 07/10/2026): exclui por nome `BALANCETE|NIVER|RENOVAR|CADASTRO|DUPLICAR|COMUNICAR|ALVARA|AO FISCAL`; inclui entrega **com multa** cadastrada ou nome com `FGTS|FOLHA|SALÁRIO|DCTFWEB|INSS|EFD|PGDAS|DIRB|CLIENTE`.
- **RN-RIS-010 Situação** de cada entrega: `dispensada` não conta; `Ent. atrasada` = **atrasada** (entregue com atraso); `Atrasada!` = **vencida** (sem entrega); pendente com prazo/atraso já passado = vencida; **`Ent. PzTéc` (entregue depois do prazo técnico interno mas dentro do legal) não é atraso**; o resto = ok.
- **RN-RIS-011 Leitura:** janela dos últimos 90 dias; 200 empresas por rodada (as mais antigas ou nunca lidas primeiro; releitura após 6 dias ou se a `versao` for menor que a atual, 3); 700 ms entre empresas; só CNPJ formatado fora do padrão CPF; resumo gravado em `cs_config` (`risco_entregas_sync`). Dispara no ciclo diário do Acessórias e por `POST /sincronizar-entregas` (admin, em segundo plano, 409 se já rodando).
- **Foto diária** (`salvarFoto`, ciclo diário): guarda os clientes **Alto** e **Médio** (id, nome, CNPJ, nível, pontos, alerta, suspenso, termômetros, motivos) ordenados por pontos; mantém 120 dias; alimenta laudos mensais fora do sistema.

## 5. Endpoints (`/api/cs/risco`)

| Método e rota | Acesso | O que faz |
| --- | --- | --- |
| `GET /` | login | risco, termômetros e motivos de todos os clientes (`detalhes` opcional na página /cs); resumo por nível |
| `GET /config`, `PUT /config` | admin | pesos, cortes e estado da leitura de entregas |
| `POST /sincronizar-entregas` | admin | lê entregas em segundo plano |
| `POST /foto` | admin | grava a foto agora |
| `POST /suspensos-omie` | token de sincronização (`X-Sync-Token`) | **substitui a lista inteira** de contratos suspensos (só CNPJ de 14 dígitos; transação `BEGIN/COMMIT`) |

## 6. Pontos de atenção

1. Pesos iguais e cortes 30/60 são "provisórios" ("vamos fixar mais adiante"). [CONFIRMADO]
2. `GET /` calcula tudo a cada chamada (muitas consultas); há cache invalidável (`painel.invalidarCache`) em outras partes. [INFERIDO] custo alto com carteira grande.
3. Consultas opcionais falham em silêncio (`consultar()` devolve `null` e o termômetro segue sem a fonte), o que pode esconder erro de esquema. [CONFIRMADO]
4. Decisões de negócio fixas no código: janelas (90/180 dias), pesos de gravidade, regex de entregas e cortes de pontuação. Mudanças exigem alterar código (só pesos dos termômetros e cortes são configuráveis).
