# Integrações externas e automações — visão consolidada

Junta, em um só lugar, o que o inventário (Fase 1) e os arquivos de módulo descrevem em partes. Estado do código em 31/10/2026. Onde há diferença entre o que o inventário previa e o que os módulos confirmaram, vale o módulo.

## 1. Integrações externas

### 1.1 Lidas ou chamadas pelo servidor (Render)

| Serviço | Para quê | Direção | Credencial (nome da variável) | Módulo com o detalhe |
| --- | --- | --- | --- | --- |
| **Zappy** | tickets, mensagens, avaliação do cliente, usuários | servidor busca a cada 5 min | `ZAPPY_BASE_URL`, `ZAPPY_TOKEN` | [cs/01](cs/01-ingestao-vinculos-sla.md) |
| **Acessórias** | carteira, TAGs, motivos de cancelamento, entregas, solicitações | servidor busca a cada 24 h; a ficha do cliente chama a cada abertura | `ACESSORIAS_API_TOKEN` | [cs/05](cs/05-churn-categorias.md), [cs/06](cs/06-painel-ficha-atendimento.md) |
| **CertiSeguro** | lista de certificados digitais | servidor busca às 07h e 13h | `CERTISEGURO_URL`, `CERTISEGURO_TOKEN`, `CERTISEGURO_CNPJ`; **IP do Render precisa estar liberado lá** | [legalizacao](legalizacao.md) |
| **Receita (BrasilAPI, minhareceita.org)** | situação e município do CNPJ | sob demanda e em lote | — | [cs/05](cs/05-churn-categorias.md) |
| **IBGE** | código do município | sob demanda | — | [legalizacao](legalizacao.md) |
| **Gmail SMTP** | recuperação de senha e relatórios | envio | `GMAIL_USER`, `GMAIL_APP_PASS` | [nucleo](nucleo.md) |
| **Web Push** | aviso no navegador | envio | chaves VAPID **no banco** (`cs_painel_config`, chave `webpush_vapid`) | [nucleo](nucleo.md) seção 7 |
| **Render / GitHub** | hospedagem; deploy por `git push` (manual, após o push) | — | `render.yaml` | [README](../../README.md) |

### 1.2 Empurradas por máquina local para o servidor (cabeçalho `X-Sync-Token`)

| Origem | O que entrega | Onde roda | Módulo |
| --- | --- | --- | --- |
| **Questor** (nWeb, via VPN) | faturamento anual, 12 meses, funcionários | estação Windows com VPN | [cs/07](cs/07-questor-omie-analise-anual.md) |
| **Omie** | honorário por cliente/ano (carga manual) e inadimplência/suspensos do /financeiro | script no navegador e tarefa agendada do Claude (11h) | [cs/07](cs/07-questor-omie-analise-anual.md), [financeiro](financeiro.md) |
| **Gmail API / Admin SDK** | metadados de e-mail (só contagens, nunca o conteúdo) | job local, segunda 08:30 | [cs/08](cs/08-email-sinais-auditoria-manutencao.md) |
| **Prefeituras e Protocolo Online**, **REDESIM**, **e-CAC** | situação de alvarás, protocolos e procurações | consulta local e *userscripts* (Tampermonkey) | [legalizacao](legalizacao.md) |
| **Pastas de rede** | leitura de PDFs de alvará | estação Windows (05h) | [legalizacao](legalizacao.md) |
| **Arquivo Morto** | cópia de pastas de empresas inativadas | estação Windows (20h) | memória do projeto (job local, fora do Render) |

Um **único segredo de sincronização** (`LEGALIZACAO_SYNC_TOKEN`) atende quase todas essas entradas; só a CertiSeguro tem o seu (`CERTISEGURO_SYNC_TOKEN`). Ver [transversal-permissoes](transversal-permissoes.md) seção 6.

### 1.3 Variáveis de ambiente (apenas nomes)

`DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `NODE_ENV`, `PORT`, `APP_URL`, `ALLOWED_ORIGINS`, `ADMIN_EMAIL`, `ADMIN_PASS`, `ADMIN_NAME`, `CADASTRO_PUBLICO` (só para reabrir o cadastro, normalmente ausente), `ZAPPY_BASE_URL`, `ZAPPY_TOKEN`, `ACESSORIAS_API_TOKEN`, `GMAIL_USER`, `GMAIL_APP_PASS`, `GMAIL_CHAVE_JSON`, `GMAIL_ADMIN`, `LEGALIZACAO_SYNC_TOKEN`, `CERTISEGURO_SYNC_TOKEN`, `CERTISEGURO_URL`, `CERTISEGURO_TOKEN`, `CERTISEGURO_CNPJ`, `LEGALIZACAO_CONSULTA_NO_SERVIDOR`, `LEGALIZACAO_PASTA`, `QUESTOR_NWEB`, `QUESTOR_TOKEN_API`, `PDFTOPPM_PATH`, `ARQUIVO_MORTO_*`, `EMAIL_MAPA_CACHE`, `EMAIL_APRENDIDOS`, `EMAIL_CACHE_DIR`, `OMIE_*` (previstas para o /financeiro, ainda sem uso), `DEBUG_CICLO7`, `DBG`. Os valores **nunca** entram nesta documentação.

## 2. Automações e processos em segundo plano

### 2.1 No servidor (todas por `setInterval` no processo web)

| Quando | O que faz | Só roda se |
| --- | --- | --- |
| a cada 5 min | ingestão de tickets do Zappy | `ZAPPY_BASE_URL` **e** `ZAPPY_TOKEN` |
| 08h, 11h, 15h (Brasília) | atualiza notas pendentes e aplica o auto-preencher da Gamificação do mês corrente | bloco do Zappy |
| 07h e 13h | CertiSeguro | bloco do Zappy |
| 08h | vencimentos da Legalização e retrato semanal | bloco do Zappy |
| 02h | consulta de alvarás às prefeituras | **desligada**, salvo `LEGALIZACAO_CONSULTA_NO_SERVIDOR=1` |
| a cada hora | saúde das rotinas locais da Legalização | bloco do Zappy |
| 08h (conferência a cada 10 min) | alerta de prazo das ocorrências de Qualidade | sempre |
| a cada 10 min, grava 1×/dia entre 03h e 04h | **backup automático** em `backups_automaticos` (30 mais recentes) | sempre |
| a cada 24 h | limpeza de `refresh_tokens` vencidos | sempre |
| ao subir e a cada 24 h | sincroniza Acessórias e, em seguida, TAGs, motivos de cancelamento, classificação pela Receita, entregas (200 por rodada), foto diária do risco | `ACESSORIAS_API_TOKEN` |
| a cada 6 h | completa município/CNAE dos clientes (700 por rodada) | `ACESSORIAS_API_TOKEN` |
| a cada 14 min | auto-ping em `APP_URL/health` | `APP_URL` |
| ao tocar em qualquer rota `/gam` | `ensureGamTables()` cria tabelas/colunas; **desde 31/10/2026** a semente inicial (meses 05–07 fechados, regra de aceite da Elma) roda uma vez só | primeira execução marcada em `gam_config` |

Armadilha conhecida: a agenda da Legalização depende das variáveis do **Zappy** (mesmo bloco de código). Sem elas, CertiSeguro, vencimentos e retrato semanal **não rodam**, mesmo que a Legalização esteja configurada.

### 2.2 Fora do servidor (estação Windows, navegador, agente)

| Rotina | Frequência | Como é agendada | Onde está descrita |
| --- | --- | --- | --- |
| Sinais de e-mail | segunda 08:30 | Agendador do Windows (`emailSinais/agendar.ps1`) | [cs/08](cs/08-email-sinais-auditoria-manutencao.md) |
| Questor mensal e anual | mensal/anual | Agendador (`questor/agendar*.ps1`) | [cs/07](cs/07-questor-omie-analise-anual.md) |
| Omie do /financeiro | diária às 11h (suspensos: semanal) | tarefa agendada do Claude, com login feito pelo Reysner | [financeiro](financeiro.md) |
| Alvarás em pastas de rede | diária (05h) | Agendador | [legalizacao](legalizacao.md) |
| Consulta às prefeituras | semanal (segunda 08:30) | Agendador | [legalizacao](legalizacao.md) |
| Procurações, REDESIM, Protocolo Online | semanal | *userscripts* com sessão humana | [legalizacao](legalizacao.md) |
| Arquivo Morto | diária 20h | Agendador | memória do projeto |
| Lembrete de atualizar esta documentação | uma vez, 15/12/2026 09:00 | tarefa agendada do Claude (só roda com o app aberto) | [COMO_ATUALIZAR_A_DOCUMENTACAO](../COMO_ATUALIZAR_A_DOCUMENTACAO.md) |

Os horários reais ficam no Agendador da estação e **não são versionados**; os de comentários do código divergem entre si em alguns casos ([legalizacao](legalizacao.md), item 3 dos pontos de atenção). [DÚVIDA] até alguém conferir a lista de tarefas da máquina.

### 2.3 Riscos comuns às automações

1. Tudo no servidor roda dentro do processo web: reinício atrasa ou repete rotinas; as de horário fixo guardam "já rodei hoje" só em memória.
2. Várias rotinas dependem de uma pessoa, de uma estação ligada e de uma sessão (VPN, IP liberado, login do gov.br, CPF da Josiane, login do Omie).
3. Travas de concorrência são locais ao processo: uma segunda instância duplicaria o trabalho.
4. Erros de consulta são engolidos em vários pontos (`consultar()`, `.catch(()=>{})`), o que mantém a tela de pé mas esconde esquema quebrado.
