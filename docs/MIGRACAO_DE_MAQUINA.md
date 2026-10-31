# Guia de migração — trocar de máquina sem perder o sistema

Este guia diz o que existe fora do código e como refazer tudo em outra máquina (ou em outro servidor). **Não traz nenhum valor de senha, token ou chave**: só os nomes das variáveis e onde cada uma é usada. Os valores ficam no painel do Render, em um gerenciador de senhas e nos arquivos `.env` da máquina atual.

Escrito em 31/10/2026 a partir do código. O que não pôde ser conferido (agendamentos reais do Windows, onde o banco está hospedado) está marcado com **[CONFERIR]**.

## 1. O mapa em uma tabela

| O que | Onde está hoje | Está no GitHub? | Como levar |
| --- | --- | --- | --- |
| Código do sistema | repositório `reysner/grupo-e-sistema` (branch `main`) | sim (exceto o item abaixo) | `git clone` |
| Alterações ainda não commitadas | esta máquina (`server/arquivoMorto/*`, `docs/`, alguns arquivos soltos) | **não** | commitar ou copiar |
| Dados (clientes, notas, ocorrências etc.) | PostgreSQL hospedado, apontado por `DATABASE_URL` **[CONFERIR]** o provedor no Render | não | `pg_dump` / backup do provedor |
| Variáveis do servidor | painel do Render (Environment) | **não** | anotar nomes e guardar valores num cofre |
| Variáveis das rotinas locais | `server/legalizacao/.env`, `server/arquivoMorto/.env` | **não** (git-ignorados) | copiar com segurança; há `.env.example` |
| Chave do Gmail (conta de serviço) | arquivo JSON fora do projeto, no caminho de `GMAIL_CHAVE_JSON` (padrão `C:\Users\Grupo e\Segredos\…`) | não | copiar com segurança |
| Tarefas agendadas | Agendador de Tarefas do Windows desta máquina | **não** | recriar (seção 5) |
| Scripts de navegador | extensão Tampermonkey (os arquivos vêm do próprio site em `/tools/`) | sim (`public/tools/`) | reinstalar e digitar o token de novo |
| Caches e estados locais | `server/emailSinais/aprendidos.json`, `server/emailSinais/cache/`, `server/arquivoMorto/estado/`, `server/legalizacao/estado-alvaras-pasta.json`, `server/omie/tmp/`, `*/logs/` | não (git-ignorados) | copiar se quiser manter o histórico (seção 6) |
| Tarefa do Claude da leitura do Omie | `omie-financeiro-11h` no aplicativo Claude desta máquina | não | recriar (seção 5.2) |

**Importante:** o sistema em produção roda no Render e **continua funcionando mesmo que esta máquina seja desligada**. A troca de máquina afeta (a) quem edita o código e (b) as rotinas que rodam no escritório (seção 5), que são as que deixam de atualizar os dados.

## 2. Antes de desligar a máquina antiga

1. **Guardar o código:** `git status`; commitar e dar push do que for para ficar (confira antes o que está em `server/arquivoMorto/`). Arquivos como `teste.txt`, o PDF de laudo e o `.pptx` do ranking na raiz são soltos e não fazem parte do sistema.
2. **Cópia do banco** (seção 3.3): faça um `pg_dump` completo e guarde fora da máquina.
3. **Cofre de segredos:** copie para o gerenciador de senhas, no mínimo: tudo da seção 4 (painel do Render e os dois `.env`) e o JSON do Gmail. Sem eles a rotina local não volta a falar com o sistema.
4. **Inventário das tarefas agendadas:** em um PowerShell, `Get-ScheduledTask | Where-Object { $_.TaskName -like 'GrupoE*' } | Get-ScheduledTaskInfo` e anote nome, horário e caminho de cada uma **[CONFERIR]**: só três delas têm o agendamento registrado em script no repositório.
5. **Copiar os dados locais** da seção 6 que você quiser manter.
6. **Anotar os acessos de rede**: VPN do Questor, servidor de arquivos da Legalização e IPs liberados na CertiSeguro (seção 5.3).

## 3. O servidor (Render) e o banco de dados

### 3.1 Se o serviço do Render continua existindo
Nada a fazer no servidor. Na máquina nova só é preciso o código e, para quem for editar, uma cópia local do `.env` apontando para um banco de testes.

### 3.2 Se for recriar o serviço (outra conta, outro provedor)
1. Criar um Web Service Node a partir do repositório (`render.yaml` na raiz: build `npm install`, start `node server/index.js`, health check `/health`, porta 3000). Node 18 ou superior (`engines` do `package.json`); recomendado 22.
2. Criar o PostgreSQL e **restaurar o dump** (3.3). Isso não é opcional: o sistema cria sozinho a maior parte das tabelas ao subir (`CREATE TABLE IF NOT EXISTS`), mas **cinco tabelas não têm `CREATE` no código** (`clientes`, `honorarios`, `eventos_clientes`, `analistas`, `investimentos`) e só existem no banco atual. Subir contra um banco vazio faz várias telas falharem.
3. Configurar as variáveis da seção 4.1.
4. Na primeira subida o administrador só é criado se `ADMIN_PASS` estiver definida (o e-mail padrão é `admin@grupoe.com.br`, ou o de `ADMIN_EMAIL`). **Não existe senha padrão no código.** Com o banco restaurado, os usuários já vêm do dump.
5. Atualizar `APP_URL` e `ALLOWED_ORIGINS` para o endereço novo e **reapontar `APP_URL`** nos `.env` locais e nos scripts do Tampermonkey. O `render.yaml` ainda traz um endereço antigo (`grupo-e-sistema.onrender.com`); o de produção citado na documentação é outro **[CONFERIR]**.
6. Dados que moram no banco e importam para a migração: as **chaves de notificação push** (geradas uma vez e guardadas na tabela `cs_painel_config`, chave `webpush_vapid`; sem elas, os aparelhos já cadastrados precisam se inscrever de novo) e todas as configurações em `cs_config` e `cs_painel_config`.
7. Trocar `JWT_SECRET` ou `JWT_REFRESH_SECRET` desloga todo mundo; sem elas o sistema sobe com valores aleatórios e desloga todos a cada reinício.

### 3.3 Backup e restauração do banco
Em uma máquina com as ferramentas do PostgreSQL (versão igual ou superior à do banco):

```bash
# backup completo (dados + estrutura)
pg_dump --format=custom --no-owner --no-acl "<DATABASE_URL>" -f grupoe.dump

# só a estrutura (útil para documentar as colunas das tabelas sem CREATE)
pg_dump --schema-only --no-owner --no-acl "<DATABASE_URL>" -f grupoe-estrutura.sql

# restaurar em um banco novo e vazio
pg_restore --no-owner --no-acl --dbname "<NOVA_DATABASE_URL>" grupoe.dump
```

O botão **Backup** do /cs baixa só um JSON do módulo Qualidade; não substitui o `pg_dump`.

## 4. Variáveis de ambiente (só os nomes)

### 4.1 No servidor (Render → Environment)

| Variável | Para quê |
| --- | --- |
| `NODE_ENV` | `production` liga o SSL do banco e o cookie seguro |
| `PORT` | porta (o Render define; padrão 3000) |
| `DATABASE_URL` | conexão com o PostgreSQL |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | assinatura dos logins (valores longos e diferentes entre si) |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASS` | criação do administrador na primeira subida |
| `APP_URL`, `ALLOWED_ORIGINS` | endereço público e origens aceitas (CORS) |
| `ACESSORIAS_API_TOKEN` | sincronização de clientes, TAGs, motivos e entregas |
| `ZAPPY_BASE_URL`, `ZAPPY_TOKEN` | ingestão de atendimentos (sem elas, o /cs não atualiza) |
| `LEGALIZACAO_SYNC_TOKEN` e/ou `CERTISEGURO_SYNC_TOKEN` | token das rotinas máquina-a-máquina (Legalização, Questor, Omie, e-mail, suspensos); precisa ser **igual** ao dos `.env` locais |
| `CERTISEGURO_URL`, `CERTISEGURO_TOKEN`, `CERTISEGURO_CNPJ` | o servidor busca os certificados digitais 2× ao dia |
| `GMAIL_USER`, `GMAIL_APP_PASS` | envio de e-mails do sistema (recuperação de senha) |
| `LEGALIZACAO_CONSULTA_NO_SERVIDOR` | opcional; `1` liga a consulta noturna às prefeituras no servidor (desligada por padrão: a prefeitura bloqueia o IP do Render) |

### 4.2 Nas rotinas locais (`server/legalizacao/.env`)
Este arquivo é lido por quase todas as rotinas do escritório (CertiSeguro, consulta às prefeituras, leitura de pastas, Omie, Questor, sinais de e-mail). Use `server/legalizacao/.env.example` como modelo. Nomes: `APP_URL`; `CERTISEGURO_URL`, `CERTISEGURO_TOKEN`, `CERTISEGURO_CNPJ`; `CERTISEGURO_SYNC_TOKEN` ou `LEGALIZACAO_SYNC_TOKEN`; `DATABASE_URL` (as rotinas de e-mail e do Questor leem o banco direto); `ACESSORIAS_API_TOKEN`; `GMAIL_CHAVE_JSON`, `GMAIL_ADMIN`; `QUESTOR_NWEB`, `QUESTOR_TOKEN_API`; `LEGALIZACAO_PASTA`; `PDFTOPPM_PATH`.

### 4.3 Arquivo Morto (`server/arquivoMorto/.env`)
Modelo em `server/arquivoMorto/.env.example`. Nomes: `ACESSORIAS_API_TOKEN`, `GMAIL_USER`, `GMAIL_APP_PASS`, `ARQUIVO_MORTO_EMAIL_TO`, `ARQUIVO_MORTO_DESDE`, `ARQUIVO_MORTO_BACKUP_DESKTOP`, `ARQUIVO_MORTO_UNC_ROOT`, `ARQUIVO_MORTO_DRIVE_MOUNT`.

## 5. A estação do escritório (Windows)

### 5.1 Pré-requisitos na máquina nova
- Node.js 18 ou superior e Git; `git clone` do repositório e `npm install` na raiz.
- **OCR dos alvarás escaneados:** `cd server\legalizacao\ocr` e `npm install` (tesseract + idioma português) e o programa `pdftoppm` (Poppler), com o caminho em `PDFTOPPM_PATH` se não estiver no padrão. Sem isso a leitura de PDFs escaneados é pulada.
- **Acesso de rede:** VPN conectada para o Questor (servidor nWeb do fornecedor); acesso ao compartilhamento de arquivos da Legalização (`LEGALIZACAO_PASTA`); para o Arquivo Morto, o Google Drive montado e o compartilhamento do servidor.
- **IP liberado na CertiSeguro** ("IPs Remotos Permitidos"): o IP da estação **muda** e precisa ser cadastrado de novo na troca. O servidor do Render usa IPs próprios, também cadastrados lá.
- **Gmail:** a conta de serviço lê as caixas do domínio por delegação (Google Workspace); a chave JSON precisa estar no caminho de `GMAIL_CHAVE_JSON`.
- Os `.env` das seções 4.2 e 4.3.

### 5.2 Tarefas agendadas

| Rotina | Quando | Como recriar |
| --- | --- | --- |
| Sinais de e-mail | segunda 08:30 | `powershell -ExecutionPolicy Bypass -File server\emailSinais\agendar.ps1` (tarefa `GrupoE-Sinais-de-email-segunda-0830`) |
| Questor mensal + Análise Anual | dispara todo dia 09:00 e o script só roda no 1º dia útil a partir do dia 25 | `server\questor\agendarMensal.ps1` (tarefa `GrupoE-Questor-Mensal-dia25`). `agendarAnual.ps1` está **obsoleto**. Precisa de VPN e do nWeb aberto |
| Arquivo Morto | diário 20:00 | `server\arquivoMorto\arquivar-morto.bat` (ver a seção "Agendador de Tarefas" do README da pasta) |
| Consulta às prefeituras | semanal (descrita como segunda 08:30) **[CONFERIR]** | `server\legalizacao\consultar-alvaras.bat` |
| Leitura das pastas de alvará | semanal (descrita como segunda 08:30) **[CONFERIR]** | `server\legalizacao\ler-alvaras-pasta.bat` |
| CertiSeguro (reserva da rodada do servidor) | segunda 09:00 **[CONFERIR]** | `server\legalizacao\sincronizar-certiseguro.bat` |
| Leitura do Omie | diária 11:00; contratos suspensos toda segunda | tarefa `omie-financeiro-11h` do aplicativo **Claude** (não é do Windows): lê o Omie com o login feito por uma pessoa e roda `server\omie\importarOmie.js` e `enviarSuspensos.js`. Detalhes em `server\omie\LEIA-ME.md` |

Cuidados ao recriar as tarefas do Windows:
- A pasta do usuário tem espaço (`C:\Users\Grupo e\…`): o `schtasks /TR` corta o caminho nesse espaço. Use `Register-ScheduledTask` ou `Set-ScheduledTask`, como já fazem os scripts `agendar*.ps1`.
- Nomes e descrições das tarefas em ASCII (o Agendador recusa acentos e parênteses em alguns casos).
- Marque "executar assim que possível se perder o horário" (`StartWhenAvailable`) e proíba duas instâncias ao mesmo tempo.
- Rode as rotinas uma vez à mão (a maioria aceita `--simular`) antes de agendar.

### 5.3 Scripts de navegador (Tampermonkey)
Três scripts, servidos pelo próprio sistema em `/tools/`: `sincronizar-procuracoes.user.js` (e-CAC e FGTS Digital, login com certificado), `sincronizar-protocolo-online.user.js` (Protocolo Online de Uberlândia, login da Josiane) e `sincronizar-redesim.user.js` (Redesim/JUCEMG, gov.br). Instale a extensão no navegador novo, abra o endereço do script e confirme a instalação. O token de sincronização **não está dentro dos arquivos**: o script pede na primeira execução e guarda só no navegador. Se o endereço do sistema mudou, edite o `@connect` e as URLs.

## 6. Dados que só existem na máquina antiga

| Arquivo ou pasta | O que é | Se perder |
| --- | --- | --- |
| `server/emailSinais/aprendidos.json` | endereços de e-mail associados a empresas pelo aprendizado | o aprendizado recomeça (as contagens ficam menos precisas por algumas semanas) |
| `server/emailSinais/cache/` | cache das caixas lidas | a primeira leitura demora 30 a 60 min |
| `server/arquivoMorto/estado/processadas.json` | empresas já arquivadas | o job tenta arquivar de novo as que já copiou |
| `server/legalizacao/estado-alvaras-pasta.json` | cache do OCR dos PDFs | o OCR é refeito |
| `server/omie/tmp/` | arquivos temporários da leitura do Omie | nada (são regerados) |
| `*/logs/` | registros das rotinas | só perde o histórico |

Esses itens estão no `.gitignore` de propósito (contêm endereços de e-mail e dados de clientes): copie por pen drive ou rede interna, nunca pelo GitHub.

## 7. Conferência na máquina nova

1. `git log -1` mostra o commit esperado e `npm install` termina sem erro.
2. Testes que não precisam de banco: `node server/testes_gam_ferias.js`, `node server/financeiro/testes_financeiro.js`, `node server/emailSinais/testes_email_sinais.js`, `node server/cs/testes_acessos.js`.
3. Servidor: abrir `/health` e fazer login; entrar em `/cs`, `/legalizacao` e `/financeiro`.
4. Rotinas: rodar uma vez cada script com `--simular` quando existir; depois da primeira rodada real, conferir no sistema a data de leitura (no /cs, **Qualidade dos Dados**; na Legalização, **🩺 Saúde das consultas**; no /financeiro, **Qualidade dos Dados**).
5. Só então apagar as tarefas da máquina antiga, para não haver duas máquinas gravando as mesmas cargas.

## 8. O que ainda não está resolvido

- Parte dos agendamentos do Windows não está versionada; este guia lista o que o código descreve, e a lista real precisa ser tirada da máquina antiga (passo 4 da seção 2).
- O mesmo token de sincronização atende várias rotinas: ao trocar de máquina, aproveite para gerar um novo e atualizar o Render e os `.env` juntos.
- A senha do administrador deve ter sido trocada depois da primeira subida; se a conta original do README ainda existir com a senha antiga, troque-a.
- Falta um `pg_dump --schema-only` guardado no repositório (ou em outro lugar seguro) para documentar as cinco tabelas sem `CREATE`.
