# Modelo 01 — Arquivar empresas inativas

Job noturno que varre o Sistema Acessórias (via API) atrás de empresas
**inativadas** e consolida os arquivos delas num **Arquivo Morto**, **copiando
sempre** (nunca mover/apagar) de várias origens para três destinos.

## O que faz

1. Busca no Acessórias as empresas inativas com `Cliente até >= ARQUIVO_MORTO_DESDE`.
2. Pula as que já arquivou com sucesso (estado local em `estado/processadas.json`).
3. Para cada empresa, acha a pasta dela (por nome normalizado) em cada origem e
   copia o conteúdo montando esta árvore **nos três destinos**:

   ```
   <RAZÃO SOCIAL>/
   ├── 2024/                     ← pasta da empresa em EMPRESAS\2024 + 5 Drives "ANOS ANTERIORES 2024"
   ├── 2025/                     ← pasta da empresa em EMPRESAS\2025
   ├── 2026/                     ← pasta da empresa em EMPRESAS\2026
   ├── Legalização/              ← subpastas da empresa em EMPRESAS\LEGALIZACAO
   │   └── Certificado Digital/  ← .pfx / .p12 da empresa em DEPARTAMENTO LEGALIZACAO\CERTIFICADOS PJ
   └── Sucesso do Cliente/       ← conteúdo da pasta da empresa em EMPRESAS - SUCESSO DO CLIENTE
   ```

4. Manda um e-mail de resumo pro `ARQUIVO_MORTO_EMAIL_TO`.

**Destinos:**

| Destino | Caminho |
|---|---|
| Local — servidor (sem faixa) | `{UNC}\EMPRESAS\EMPRESAS - ARQUIVO MORTO\<RAZÃO>\...` |
| Drive Compartilhado (por faixa) | `{DRV}\EMPRESAS - ARQUIVO MORTO <faixa>\EMPRESAS - ARQUIVO MORTO <faixa>\<RAZÃO>\...` |
| Backup local no Desktop (por faixa) | `{BKP}\EMPRESAS - ARQUIVO MORTO <faixa>\EMPRESAS - ARQUIVO MORTO <faixa>\<RAZÃO>\...` |

Faixas: `A a D` (inclui nomes que começam com 0–9), `E a L`, `M a R`, `S a T`, `U a Z`.
`{BKP}` = `ARQUIVO_MORTO_BACKUP_DESKTOP` (padrão `C:\Users\Grupo e\Desktop\BACKUP ARQUIVO MORTO`).
O Drive e o backup no Desktop têm a pasta da faixa **duplamente aninhada** (a de
fora é artefato da migração rclone; a de dentro tem o conteúdo).

## Regras

- **Só copia** — nunca move, nunca apaga, nunca toca na origem.
- **Incremental** — arquivo que já existe no destino **nunca** é sobrescrito.
- **Match de nome** — normaliza os dois lados (MAIÚSCULAS, sem acento, `&`→` E `,
  espaços colapsados) e exige igualdade. 0 candidatos numa origem → ignora aquela
  origem; 2+ → não copia e sinaliza no e-mail.

## Instalação (estação Windows da rede)

Pré-requisitos da máquina:

- **Node.js 18+** instalado (`node -v`).
- **Google Drive para Desktop** logado, com os Drives Compartilhados montados
  em `H:` (ou ajuste `ARQUIVO_MORTO_DRIVE_MOUNT`).
- Acesso ao compartilhamento `\\192.168.251.13\escritorial$` (usa caminho UNC —
  não precisa mapear `Z:`).

Passos:

```bat
cd C:\caminho\do\repo
npm install
copy server\arquivoMorto\.env.example server\arquivoMorto\.env
notepad server\arquivoMorto\.env      REM preencher token + GMAIL_*
```

## Uso

```bat
node server\arquivoMorto\run.js                 REM execução normal
node server\arquivoMorto\run.js --dry-run       REM não escreve nada, não manda e-mail
node server\arquivoMorto\run.js --dry-run --empresa="ACADEMIA VIDATIVA LTDA"
node server\arquivoMorto\run.js --cnpj=00.000.000/0001-00
node server\arquivoMorto\run.js --desde=2026-09-01 --sem-email
```

Exit code: `0` ok / nada a fazer · `1` houve erro ou ambiguidade a resolver ·
`2` erro fatal.

## Agendador de Tarefas (20:00 diário)

- **Disparador:** diariamente às 20:00.
- **Ação:** Programa `node` (ou o caminho completo, ex.:
  `C:\Program Files\nodejs\node.exe`), argumentos
  `server\arquivoMorto\run.js`, iniciar em `C:\caminho\do\repo`.
- **Segurança:** marcar **"Executar somente quando o usuário estiver conectado"** —
  o `H:` do Google Drive para Desktop só existe na sessão interativa do usuário.
  Usar uma estação que fica logada.
- Não marcar "Executar com privilégios mais altos" (não precisa).

## Estado e reprocessamento

`estado/processadas.json` guarda, por `acessorias_id`, o status da última
execução. Empresas com `status: "ok"` são puladas nas execuções seguintes.
Para forçar o reprocessamento de uma, use `--empresa=` / `--cnpj=` (ignora o
estado) ou apague a entrada dela do JSON.

## Teste

```bat
node --test server\arquivoMorto\nomes.test.js
```

Para um teste ponta-a-ponta offline: aponte `ARQUIVO_MORTO_UNC_ROOT` e
`ARQUIVO_MORTO_DRIVE_MOUNT` para pastas locais de mentira com a estrutura das
origens e rode com `--dry-run --empresa="..."`.
