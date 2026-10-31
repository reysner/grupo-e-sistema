# /cs — Sinais de e-mail, Logs/Backup/Limpeza e rotinas únicas de manutenção

Cobre `server/cs/emailSinais.js` (rotas), `server/emailSinais/` (job local: `coletar.js`, `calculo.js`, `agendar.ps1`, `LEIA-ME.md`, testes), `server/cs/auditoria.js` (logs, backup, limpeza), `server/cs/analistasNomes.js` e `server/cs/limpezaTeste.js` (ajustes únicos).

Níveis de certeza: [CONFIRMADO] · [INFERIDO] · [DÚVIDA].

---

## Parte A — Sinais de e-mail por cliente

### A.1 Objetivo e privacidade

Saber, por cliente, **quantos pedidos por e-mail estão esperando resposta** (bloco **Hoje** do /cs) e o **histórico de 180 dias** de e-mails recebidos e sem resposta por destinatário interno (módulo **Atendimento**). Princípio de projeto: **só metadados**. O job lê De, Para, Cc, data, marcas de automático, rótulos, tipo e tamanho (`format=metadata`); **assunto e corpo nunca são pedidos**. O servidor recebe só **contagens** e nunca endereço de cliente. [CONFIRMADO]

### A.2 Job local (`server/emailSinais/coletar.js`) — roda na máquina do Reysner, não no Render

| Item | Detalhe |
| --- | --- |
| Agendamento | Agendador do Windows, tarefa `GrupoE-Sinais-de-email-segunda-0830`: **segunda-feira 08:30** (roda ao ligar se estava desligada). Criada por `agendar.ps1`. Log em `server/emailSinais/logs/coleta.log`. O bloco Hoje mostra "desatualizada" se a última leitura passa de **8 dias** |
| Execução | `node server/emailSinais/coletar.js` (prévia, não envia) · `--enviar` (todas as caixas) · `--caixas="regex"` (teste, nunca envia) · `--dias=14` · `--historico=180` · `--reenviar=arquivo.json` · `--usar-cache` / `--guardar-cache` / `--sem-gravar` |
| Acesso ao Gmail | **conta de serviço** do Google Workspace com delegação de domínio; chave em `GMAIL_CHAVE_JSON` (padrão `C:\Users\Grupo e\Segredos\grupo-e-laudos-atendimento-….json`), administrador `GMAIL_ADMIN` (padrão `reysner@escritorial.com.br`). Escopos: `gmail.readonly` por caixa e `admin.directory.user.readonly` para listar usuários (ativos, não suspensos/arquivados). O JWT RS256 é assinado localmente |
| Mapa e-mail → CNPJ | contatos dos clientes ativos lidos da API do Acessórias (`/companies/{cnpj}/?registrationData&contacts`, campo `ContatosNaEmpresa[].E-mail`), **um por vez**, 450 ms entre chamadas, até 4 tentativas; cache de **7 dias** em `%TEMP%\mapa_emails_clientes.json` (~5 min para refazer) |
| Cache de mensagens | `server/emailSinais/cache/<caixa>.json`, **fora do Git** (contém endereços); a 1ª rodada lê tudo (30–60 min), as seguintes só mensagens novas; o que sai da janela deixa o cache |
| Banco | o job abre conexão **direta ao banco de produção** (`DATABASE_URL` em `server/legalizacao/.env`) para ler `clientes` (mapa) e `cs_mensagens/cs_tickets/cs_vinculos` (cruzar com o Zappy). Só `SELECT` |
| Envio | `POST {APP_URL}/api/cs/email-sinais` e `/atendimento` com `X-Sync-Token`. **Não envia** se alguma caixa falhou, nem se `--caixas` foi usado (leitura incompleta nunca substitui a anterior) |

### A.3 Regras de cálculo (`calculo.js`, funções puras com testes)

- **RN-EML-001 Mensagem automática** (não conta como pedido): remetente **externo** com `List-Unsubscribe`, `Precedence` bulk/list/junk, `Auto-Submitted` ≠ `no`, rótulo `CATEGORY_(PROMOTIONS|UPDATES|FORUMS|SOCIAL)`, ou endereço casando `no-reply, noreply, nao-responda, mailer-daemon, postmaster, notificação, newsletter, marketing, alerta, aviso, boleto, cobranca, faturamento, sac, suporte, atendimento, contato, comunicado, robo, bot, system, sistema`. Mensagem **interna** nunca é "automática".
- **RN-EML-002 Unidade = contato** (endereço), com **todas as caixas juntas**: o mesmo e-mail copiado em várias caixas (horas de entrega a menos de **10 min**) conta uma vez; a resposta de qualquer colega a esse contato encerra a espera para todos.
- **RN-EML-003 Aguardando** (`sinaisPorContato`): a última mensagem humana do contato é **mais nova** do que qualquer envio do escritório endereçado a ele (Para ou Cc). Só entra se `horas >= 4`.
- **RN-EML-004 Provável encerramento** ("obrigado"): o escritório já tinha respondido antes, a última mensagem tem **≤ 12.000 bytes** (`LIMITE_CURTA`) e **sem anexo** (`multipart/mixed`). Fica fora da espera e conta em `provaveis_encerramentos`.
- **RN-EML-005 Resolvido pelo Zappy:** se o escritório falou com o cliente por ticket do Zappy depois do e-mail (`cs_mensagens.remetente = 'escritorio'` posterior), conta em `resolvidos_zappy` e não como espera (`cruzarZappy`, só para quem aguarda ≥ 4 h e tem CNPJ).
- **RN-EML-006 Ligação ao cliente:** 1) endereço no cadastro do Acessórias; 2) **aprendizado**; 3) **domínio corporativo** (não e-mail livre, não interno) de algum contato do cliente (`porDominio`). Domínios livres (gmail, hotmail, outlook, yahoo, icloud, uol, bol, live, terra, msn, globo, ig, oi, r7, zipmail) nunca ligam por domínio.
- **RN-EML-007 Aprendizado** (`aprenderContatos`): endereço ainda não cadastrado, que aparece **na mesma conversa** (mesma caixa e thread) de contatos cadastrados de **uma única empresa**, passa a valer como contato dela. Uma empresa só → confiança `alta`; várias, mas uma domina (≥ 2 conversas e ≥ o dobro da segunda) → `media`; senão **ambíguo**, não aprende. Interno, automático ou já cadastrado nunca é aprendido. Fica em `aprendidos.json` (só nesta máquina); `mesclarAprendidos` troca de empresa só se o novo tiver **mais** conversas. O cadastro do Acessórias sempre vence.
- **RN-EML-008 Domínios ignorados:** `ignorar_dominios.txt` (`dominio.com` casa o domínio e subdomínios; `.gov.br` casa qualquer final; `#` comentário). **Domínio de cliente nunca é ignorado.**
- **RN-EML-009 Faixas de espera** (`consolidar`, corte `minHoras = 4`): contato ligado a **uma** empresa → `aguardando_4h`, e também `_24h` (≥ 24), `_48h` (≥ 48), `_7d` (≥ 168 h). Contato ligado a **várias** empresas = **um pedido só**: soma em `aguardando_compartilhado` de cada empresa e uma vez nos totais. `mais_antigo_h` = maior espera da empresa. Totais: `contatos, identificados, nao_identificados, aguardando, aguardando_exclusivos, aguardando_compartilhados, aguardando_nao_identificados, provaveis_encerramentos, resolvidos_zappy`.
- **RN-EML-010 Não identificados** (`naoIdentificados`): quem escreveu sem ligação com cliente, agrupado por **domínio** (e-mail pessoal vira a linha `(e-mail pessoal)`), até 300 domínios, para a liderança decidir se é fornecedor, lead ou cadastro incompleto.
- **RN-EML-011 Histórico 180 dias — "sem resposta"** (`atendimentoPorContato`; regra ajustada em outubro/2026): um e-mail está **sem resposta** quando o escritório **não escreveu depois dele para aquele contato em nenhuma caixa**. Para contato ligado a **uma empresa só**, escrever depois para **qualquer outro endereço da mesma empresa** (sócio, outro funcionário) também encerra a espera; para contato ligado a **várias** empresas vale só o endereço exato (para não dar a resposta de uma empresa a outra). Ficam de fora: e-mail com menos de 4 h e o último e-mail curto, sem anexo, de quem já recebera resposta. Só contatos **ligados a empresa** entram.
- **RN-EML-012 Destinatário interno e por dia:** cada e-mail é atribuído aos endereços internos em Para/Cc; por destinatário guarda `recebidos`, `sem` e `dias {AAAA-MM-DD: [recebidos, sem]}` (dia em Brasília) para o filtro de período da "Minha área". Contato compartilhado vai para os campos `compartilhados_*`; os "sem resposta" resolvidos pelo Zappy saem.
- **Nomes:** endereços internos viram o **nome da pessoa** pelo diretório do Google; os 12 endereços de **grupos** conhecidos (`dptofiscal@`, `dptocontabil@`, `contabil.fiscal@`, `escritorial@`, `gestao@`, `pralegal@`, `hands@`, `legalizacao@` nos dois domínios, `deptopessoal@`, `dctfweb@`, `cs@`) ficam como endereço.

### A.4 Rotas e tabelas (`server/cs/emailSinais.js`)

Montadas em **dois** prefixos (`/api/cs/email-sinais` para o job e `/api/cs/painel/email-sinais` para a tela).

| Método e rota | Acesso | O que faz |
| --- | --- | --- |
| `POST /` | token | grava a leitura de pedidos esperando (substitui a anterior) |
| `POST /atendimento` | token | grava o histórico de 180 dias (substitui) |
| `GET /` | login: `administrador`, `usuario` ou `acessoCs` (403 "Acesso restrito à equipe autorizada.") | última leitura: totais, domínios, clientes (com `nome` quando o cliente está ativo), ordenada por `aguardando_4h + aguardando_compartilhado` e `mais_antigo_h` |

Validações do corpo: `clientes` é lista (400 "Informe a lista de clientes."), máximo 5.000 (413 "Lista grande demais."); **`caixas_com_erro > 0` → 422** "Leitura incompleta: há caixas com erro. Nada foi gravado."; CNPJ/CPF de 11 ou 14 dígitos (CNO de 12 **não** passa, ao contrário das cargas do Questor/Omie); contagens limitadas a 100.000; `caixas` com `@` descartadas; domínio com `@` descartado; **endereço de fora do escritório é recusado** em destinatários (aceitos só os domínios `escritorial.com.br` e `escritorialcontabil.com.br`); até 60 destinatários por cliente e 400 dias por destinatário.

| Tabela | Colunas |
| --- | --- |
| `cs_email_sinais` | `cnpj TEXT PK`, `contatos_ativos`, `mensagens_recebidas`, `aguardando_4h/24h/48h/7d`, `aguardando_compartilhado`, `mais_antigo_h`, `provaveis_encerramentos`, `resolvidos_zappy` (INT, default 0), `caixas TEXT[] DEFAULT '{}'` |
| `cs_email_sinais_leitura` | `id INT PK DEFAULT 1 CHECK (id = 1)`, `lido_em`, `janela_dias DEFAULT 14`, `caixas_lidas`, `caixas_com_erro`, `totais JSONB`, `dominios JSONB` |
| `cs_email_atendimento` | `cnpj TEXT PK`, `recebidos`, `sem_resposta`, `destinatarios JSONB`, `comp_recebidos`, `comp_sem`, `comp_destinatarios JSONB` |
| `cs_email_atendimento_leitura` | `id INT PK = 1`, `lido_em`, `janela_dias DEFAULT 180`, `caixas_lidas` |

Todas com **RLS ligado e sem policy**. Escrita em transação (`DELETE` + `INSERT … unnest` + upsert da leitura).

### A.5 Pontos de atenção

1. O job é um **ponto único de falha**: depende de uma máquina Windows ligada às segundas, de uma chave de conta de serviço em disco e de acesso direto ao banco. Sem o job, os números ficam velhos (a tela avisa após 8 dias). [CONFIRMADO]
2. A conta de serviço lê **todas as caixas do domínio** (delegação ampla). É uma decisão de governança (LGPD) que precisa estar registrada fora do código. [CONFIRMADO]
3. A lista de 12 grupos e de domínios internos está **fixa no código**; um grupo novo aparece como endereço bruto até alguém editar `GRUPOS`. [CONFIRMADO]
4. A heurística "provável obrigado" usa **tamanho em bytes**, não conteúdo; é calibrada à mão (o job imprime as faixas de tamanho para ajuste). [CONFIRMADO]
5. CNO (12 dígitos) é aceito nas cargas do Questor/Omie mas descartado aqui. [CONFIRMADO]

---

## Parte B — Logs de atividades, Backup e Limpeza (`auditoria.js`)

Prefixo `/api/cs/painel/admin`. **Todas as rotas exigem `administrador`** (`403: "Só o administrador vê os logs e baixa o backup."`).

### B.1 Log de atividades

- **Tabela** `log_atividades (id UUID PK DEFAULT gen_random_uuid(), user_id TEXT NOT NULL, user_name TEXT NOT NULL, acao TEXT NOT NULL, modulo TEXT NOT NULL, descricao TEXT, ip TEXT, created_at TIMESTAMPTZ DEFAULT NOW())` + índice `idx_log_atividades_data (created_at DESC)`. É a **mesma tabela** do "Log de Atividades" do sistema principal; os registros do /cs usam módulo `cs-*`.
- **Registro automático:** `middleware()` é um filtro nas rotas de Qualidade, Acessos e Analistas: para toda chamada que **muda algo** (`POST/PUT/PATCH/DELETE`) e **terminou com sucesso** (status < 400, usuário logado), `descreverAcao` traduz método + URL + corpo em `{acao, modulo, texto}` e `enriquecer` acrescenta nome da empresa/assunto, do analista ou da pessoa (consultas por id). Se o log falhar, **nunca** derruba a operação (`catch` vazio).
- **IP:** primeiro valor de `x-forwarded-for`, ou `req.ip`. [CONFIRMADO] Atrás do proxy do Render isso depende de o cabeçalho ser confiável (qualquer cliente pode enviar `X-Forwarded-For`, mas o Render o acrescenta à direita; o código lê o **primeiro** valor, que pode ser forjado). [INFERIDO]
- **Ações/módulos reconhecidos** (`descreverAcao`): `cs-analistas` (criar/editar/excluir), `cs-acessos` (módulos, gestores, vínculos analista↔login, departamentos), `cs-qualidade` (criar ocorrência, anexar, tratativa, abrir, validar, devolver, ocorrência vinculada, cancelar, mensagem, resposta final/finalizar, reabrir, nota do analista, encerrar, encerrar como gestor final, responder, apontar analista, tipos de registro, plano de ação, editar/excluir registro). Ações de dado do /cs fora desses módulos (churn, honorário sugerido, config de risco) **não** passam pelo filtro de log. [CONFIRMADO]
- **Consulta** `GET /logs`: filtros `modulo` (padrão `cs` = `LIKE 'cs-%'`; `todos`; ou um módulo), `user`, `acao`, `busca` (descrição ou nome, `ILIKE`), `de`/`ate` (`AAAA-MM-DD` em Brasília) e `limite` (padrão 300, máximo 1000). Devolve também a lista de módulos (com contagem), usuários e ações para os filtros.

### B.2 Backup (`GET /backup`, `GET /backup/info`)

Baixa **um JSON** (`backup-qualidade-AAAA-MM-DD_HH-MM-SS.json`) com: `analistas`, `cs_acessos`, `cs_qualidade_registros`, `cs_qualidade_resp`, `cs_qualidade_historico`, `cs_qualidade_tipos`, `cs_qualidade_gestores`, `cs_qualidade_anexos` (**só nome, tipo e tamanho**), `cs_painel_config` (exceto chaves com `vapid`, `secret` ou `private`) e `log_atividades` do /cs. **Fora de propósito:** bytes dos anexos, chaves privadas de push e aparelhos cadastrados. `backup/info` mostra a contagem por tabela e os últimos 8 backups baixados (`cs-backup`). Cada download é registrado no log.
Limite: **não é backup do sistema** (não inclui clientes, tickets, Gamificação, Financeiro, Legalização); é uma cópia de segurança do módulo Qualidade. O backup real é o do banco no provedor. [CONFIRMADO]

### B.3 Limpeza de dados de teste (`GET /limpar-teste/previa`, `POST /limpar-teste`)

- `POST` exige `{ "confirmacao": "LIMPAR" }` (400 "Para apagar, digite LIMPAR na confirmação.").
- **Apaga**, numa transação (ou tudo ou nada): anexos, ocorrências do módulo (`origem IN ('modulo','filha')`, com histórico, responsáveis e avisos de prazo por cascata), notificações com `tipo LIKE 'qualidade%'` e **todos os logs `cs-%`**. **Não** mexe em analistas, gestores, tipos, acessos, configurações nem planos de ação da ficha das empresas.
- **Antes de apagar** grava cópia completa em `cs_limpezas (id UUID PK, feita_em, feita_por, contagens JSONB, dados JSONB)` (anexos só nomes). Depois da exclusão, registra a limpeza no log (módulo `cs-admin`; como é gravada **após** o `DELETE` dos logs, ela sobrevive) e invalida o cache do painel para o Risco parar de contar o apagado.
- **Risco [CONFIRMADO]:** a rota continua ativa **em produção**; qualquer administrador que digite `LIMPAR` apaga todas as ocorrências reais de Qualidade (restauráveis só a partir de `cs_limpezas` e do JSON de backup, por trabalho manual). Como o log do próprio evento é gravado **depois** da exclusão, ele sobrevive. Recomenda-se desativar a rota ao encerrar a fase de testes.

---

## Parte C — Rotinas únicas de manutenção

Padrão: roda uma vez, deixa uma **marca** em `cs_painel_config` e nunca mais.

| Arquivo | Chave da marca | O que faz |
| --- | --- | --- |
| `analistasNomes.js` | `analistas_nomes_planilha_2026_10_15` | Renomeia 27 analistas para o nome completo (planilha do Reysner, 15/10/2026), inclui "Annaisa Alves de Oliveira" e retira "Daniel" (exclui; **desativa** se já tem registro de Qualidade). Não duplica nome (compara sem acento/pontuação) e não desfaz edições manuais posteriores. Só marca como feito se a lista de analistas não estava vazia. |
| `limpezaTeste.js` | `limpeza_teste_josiane_2026_10_16`, `limpeza_teste_almeida_2026_10_17` | Apaga dois registros de teste de Qualidade da Josiane (empresas e dia fixos, texto específico) e os avisos do sino que geraram. Critério estreito (empresa + autor + tipo + dia + texto) para nunca tocar registro real. |

Pontos de atenção: os nomes de pessoas e empresas ficam **dentro do código** (dados de negócio no repositório); na portabilidade devem virar uma migração de dados ou ser descartados (as marcas já foram gravadas em produção). `analistasNomes.js` depende da tabela `analistas`, sem `CREATE` no repositório.
