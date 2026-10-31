# /cs — Cargas do Questor e do Omie, Análise Anual e Honorário sugerido

Cobre `server/cs/questorDados.js`, `server/cs/anualQuestor.js`, `server/cs/omieHonorarios.js` e `server/cs/honorarioSugerido.js`. Alimentam a **Análise Inteligente** e a **Análise Anual** da página `/cs`. Regras de exibição e destaque (cores, filtros) estão no arquivo da tela (`cs-painel.js`, lote seguinte).

Níveis de certeza: [CONFIRMADO] · [INFERIDO] · [DÚVIDA].

## 1. Padrão comum das cargas ("job local → servidor")

O Questor só é alcançável de dentro da VPN do escritório; o Render não chega nele. Por isso o servidor **não busca**: rotinas **locais** (`server/questor/extrair.js`, `extrairAnual.js`, e a carga do Omie) leem e fazem `POST` para o servidor.

- **Autenticação do POST:** header `X-Sync-Token` comparado com `LEGALIZACAO_SYNC_TOKEN` (ou, na falta, `CERTISEGURO_SYNC_TOKEN`). Sem variável: 503 "Sincronização não configurada no servidor."; token errado: 401 "Token de sincronização inválido." (o **mesmo token** serve para todas as cargas: Legalização, Questor, Omie, e-mail, suspensos). [CONFIRMADO]
- **Substitui tudo:** cada POST faz `BEGIN → DELETE FROM <tabela> → INSERT … SELECT unnest(arrays) → COMMIT`. Cliente que sai da carga perde o dado. Se der erro, `ROLLBACK` e a carga anterior permanece.
- **Documento válido:** 11 dígitos (CPF), 12 (CNO) ou 14 (CNPJ/CAEPF). A carga do Omie ainda descarta documento só de zeros.
- **Tabelas novas** nascem com `ROW LEVEL SECURITY` ligado e **sem policy**: só o servidor (usuário do banco) lê. Regra do projeto. [CONFIRMADO]
- Limites: Questor anual 60.000 linhas; Omie 20.000 linhas (413 "Carga grande demais.").

## 2. Faturamento 12 meses e funcionários (`questorDados.js`)

| Item | Valor |
| --- | --- |
| Rota | `POST /api/cs/questor` (token) |
| Corpo | `{ periodo: { ini:'AAAA-MM', fim:'AAAA-MM' }, itens: [{ cnpj, faturamento?, funcionarios?, aviso? }] }` |
| Validação | `ini` e `fim` no formato `AAAA-MM` com `ini <= fim`; ao menos um item; `faturamento` finito; `funcionarios` inteiro ≥ 0; `aviso` até 400 caracteres. Mensagens: "Informe periodo…", "Informe itens…", "Valor inválido para o CNPJ …", "Nenhum documento válido (CPF, CNO, CNPJ ou CAEPF) na carga." |
| Tabela | `questor_cliente_dados (doc TEXT PK, faturamento_12m NUMERIC(16,2), funcionarios INT, atualizado_em TIMESTAMPTZ DEFAULT NOW(), aviso TEXT)` |
| Período | `cs_config` chave `questor_periodo` (JSON `{ini, fim}`); a data de leitura sai do `updated_at` em `America/Sao_Paulo` |
| Leitura | `carregar()` devolve `{ dados: Map(doc → {faturamento, funcionarios, aviso}), periodo, lido_em }`; **tolerante**: se a tabela não existir devolve vazio e só avisa no log |

- **RN-QUE-001** (decisão de 09/10/2026) cliente sem funcionário no Questor = **0**; só clientes ativos entram no painel; o faturamento em R$ é visível **só ao administrador** (o servidor entrega `null` ao perfil Usuário — arquivo 06).
- `aviso`: texto do Questor indicando que o faturamento pode estar **incompleto** (ex.: lançamentos fiscais faltando); a tela o mostra ao lado do valor. [INFERIDO]
- Desempenho: a carga original usava ~600 `INSERT` um a um (~108 s pelo pooler); passou a uma instrução com `unnest` (poucos segundos). [CONFIRMADO] (comentário no código).

## 3. Análise Anual (`anualQuestor.js`)

### 3.1 Tabela `questor_cliente_anual`

`doc TEXT`, `ano INT`, `faturamento NUMERIC(16,2)` (aceita NULL = "não lido para este ano"), `meses INT NOT NULL DEFAULT 12`, `meses_com_valor INT NOT NULL DEFAULT 12`, `atualizado_em TIMESTAMPTZ DEFAULT NOW()`, **PK `(doc, ano)`**; colunas acrescentadas depois por `ALTER … ADD COLUMN IF NOT EXISTS`: `funcionarios INT`, `funcionarios_media NUMERIC(8,1)`, `regime TEXT`, `regime_fonte TEXT`, `aviso TEXT`. Configuração em `cs_painel_config (chave TEXT PK, valor JSONB NOT NULL, atualizado_em, atualizado_por TEXT)` — chaves `anual_leitura` (`{ate, ano_inicial}`) e `analise_anual` (`{percentual, reajuste_min}`).

### 3.2 Endpoints

| Método e rota | Acesso | O que faz |
| --- | --- | --- |
| `POST /api/cs/questor/anual` | token de sincronização | carga `{ ate:'AAAA-MM', ano_inicial, itens:[{ cnpj, anos:[{ ano, faturamento, meses, meses_com_valor, funcionarios?, funcionarios_media?, regime?, regime_fonte?, aviso? }] }] }` |
| `GET /api/cs/painel/anual` | login: `administrador`, `usuario` ou `acessoCs` (senão 403) | última carga **só de clientes ativos**; **só o administrador recebe valores** |
| `PUT /api/cs/painel/anual` | administrador | `{ percentual?, reajuste_min? }`; cada um > 0 e ≤ 1000 (1 casa decimal); devolve a configuração inteira |

- **RN-ANU-001 Perfil Usuário** (e `acessoCs`) recebe `{ valores_ocultos: true, ate, ano_inicial, config, itens: [] }` — a lista vem **vazia**, não apenas mascarada.
- **RN-ANU-002 Só ativos:** `WHERE EXISTS (SELECT 1 FROM clientes c WHERE c.status = 'ativo' AND regexp_replace(c.cnpj,'\D','','g') = a.doc)`; quem foi inativado no Acessórias some, mesmo com histórico.
- **RN-ANU-003 Honorário cobrado por ano:** cada item recebe `honorarios` (`omieHonorarios.lerPorDocs`); se a leitura falhar, vem `[]` e a tela só não mostra a evolução.
- **RN-ANU-004 Configuração:** `percentual` (padrão **30**) = variação anual de faturamento que destaca o cliente; `reajuste_min` (padrão **5**) = % que o honorário do Omie precisa ter subido para **não** contar como "sem reajuste".
- Validação da carga: `ate` = `AAAA-MM`; `ano_inicial` entre 1990 e 2100; ano entre 1990 e 2100; `meses` 0 a 12; `meses_com_valor` limitado a `[0, meses]` (se ausente = `meses`); `funcionarios` 0 a 100.000; duplicados `(doc, ano)` ignorados (vale o primeiro); `faturamento` arredondado a centavos, `funcionarios_media` a 1 casa; `regime` até 40, `regime_fonte` até 80, `aviso` até 300 caracteres.
- Regras de **fonte e destaque** definidas pelo Reysner (memória do projeto): faturamento fiel ao Questor (**sem piso**), regime só da Receita (**Simples / Presumido / Real**), CPF/CNO/CAEPF com regime em branco, e "sem folha" decide o faturamento; leitura automática dia 26 às 08:00. A aplicação dessas regras é do job local e da tela. [CONFIRMADO] pela memória; [INFERIDO] quanto à divisão de responsabilidade.

## 4. Honorário cobrado — Omie (`omieHonorarios.js`)

- **Origem:** Omie, categoria "SERVIÇOS HONORÁRIOS CONTÁBEIS", títulos a receber por **data de emissão**, os dois ambientes consolidados (ESCRITORIAL e ESCRITORIAL SOLUÇÕES). O Omie só guarda a partir de **set/2023** e o ano corrente é parcial; a tela avisa.
- **Rota:** `POST /api/cs/omie/honorarios` (token), corpo `{ ate:'AAAA-MM', itens:[{ cnpj, anos:[{ ano, total, meses, mensal }] }] }`. `total` = soma cobrada no ano; `meses` = meses com cobrança (0 a 12); `mensal` = **mediana** dos meses cobrados (≥ 0).
- **Tabela:** `omie_honorario_anual (doc TEXT, ano INT, total NUMERIC(16,2), meses INT, mensal NUMERIC(14,2), atualizado_em, PK (doc, ano))`; data da leitura em `cs_painel_config` chave `omie_honorarios_leitura` (`{ate}`).
- Leitura interna: `lerPorDocs(docs)` → `{ doc: [{ano,total,meses,mensal}] }` ordenado por ano (usada só pelo `GET /painel/anual`).

## 5. Honorário sugerido (`honorarioSugerido.js`)

```text
honorario_sugerido_mensal = percentual × (faturamento_12m ÷ 12)
verde    : cobrado >= sugerido
amarelo  : cobrado entre limite_amarelo% e 100% do sugerido
vermelho : cobrado abaixo de limite_amarelo% do sugerido
```
Exemplo: percentual 1,5%, faturamento 12 meses R$ 600.000 → médio R$ 50.000 → sugerido R$ 750,00; com `limite_amarelo` 80, cobrar R$ 700 é amarelo (93%) e R$ 550 é vermelho (73%).

- **Configuração única para a equipe** (`cs_painel_config`, chave `honorario_sugerido`): `percentual` (padrão **null** = recurso desligado) e `limite_amarelo` (padrão **80**).
- `GET /api/cs/painel/honorario-sugerido` (administrador, usuário ou `acessoCs`) devolve também `atualizado_em`, `atualizado_por`, `pode_editar`.
- `PUT` (só administrador): `percentual` > 0 e ≤ 100 (3 casas) — mensagem "Informe um percentual maior que 0 e até 100."; `limite_amarelo` entre 1 e 99 (1 casa) — "O limite do amarelo deve ficar entre 1 e 99% do sugerido."; enviar `percentual` vazio **apaga** o percentual (desliga).
- O cálculo e as cores acontecem **na tela** (`cs-painel.js`); o servidor só guarda os dois números. [INFERIDO]

## 6. Pontos de atenção

1. **Mesmo token para todas as cargas**: se vazar, qualquer uma pode **substituir** as tabelas de Legalização, Questor, Omie, e-mail e suspensos. Considerar tokens separados na portabilidade. [CONFIRMADO]
2. `anualQuestor.router` está montado em **dois** prefixos (`/api/cs/questor/anual` e `/api/cs/painel/anual`): o `POST` por token também existe em `/api/cs/painel/anual` (passa pelo filtro `restringir` antes). Em ambos o `POST` só funciona com o token. [CONFIRMADO]
3. `GET /painel/anual` do perfil Usuário devolve `itens: []`; a tela precisa tratar "valores ocultos" para não parecer que a carga está vazia. [INFERIDO]
4. `cs_painel_config` é criada em **quatro** módulos diferentes (`anualQuestor`, `omieHonorarios`, `honorarioSugerido`, `motivos-churn`), todas com o mesmo `CREATE TABLE IF NOT EXISTS` — na portabilidade vira uma única migração. A versão de `motivos-churn.js` não liga RLS. [CONFIRMADO]
5. As cargas são "tudo ou nada" por transação, mas **sem histórico**: não há como ver o que a carga anterior continha depois de substituída (o backup do banco é a única rede). [CONFIRMADO]
