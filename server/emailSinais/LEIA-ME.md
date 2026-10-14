# Sinais de e-mail por cliente (piloto do Sucesso do Cliente)

Job **local** (roda na máquina do Reysner, não no Render). Lê só **cabeçalhos** das caixas do domínio, liga cada conversa a um
cliente pelos contatos do Acessórias e envia ao sistema **somente contagens por cliente** (toda segunda-feira de manhã): quantos pedidos por e-mail estão
esperando resposta, há quanto tempo e em qual caixa. Assunto e corpo nunca são lidos; endereços de e-mail nunca saem desta máquina.

## O que entra na conta
- Unidade = o **contato** do cliente, com todas as caixas juntas: o mesmo e-mail copiado em várias caixas conta uma vez, e a
  resposta de um colega encerra a espera para todos.
- "Aguardando" = ninguém do escritório escreveu para esse contato depois da última mensagem dele (≥ 4 h).
- Sai da conta: mensagem automática; domínios de `ignorar_dominios.txt`; quem o escritório já atendeu pelo **Zappy** depois do
  e-mail; "provável obrigado" (mensagem curta, sem anexo, depois de uma resposta nossa).
- Contato ligado a **várias empresas** é um pedido só ("compartilhado").
- **Aprendizado:** um endereço que aparece na mesma conversa de contatos de **uma** empresa passa a valer como contato dela.
  Fica em `aprendidos.json` (só nesta máquina, fora do Git). Apague a entrada para "desaprender" um endereço.

## Rodar
```
node server/emailSinais/coletar.js                       # prévia: grava arquivo local e imprime resumo (não envia nada)
node server/emailSinais/coletar.js --enviar              # lê TODAS as caixas e envia as contagens ao sistema
node server/emailSinais/coletar.js --caixas="bruno"      # teste em poucas caixas (nunca envia)
```
Leva uns 12 a 20 minutos. Se alguma caixa falhar, **não envia** (leitura incompleta não substitui a anterior).

## Agendamento (leitura semanal)
Tarefa do Agendador do Windows **GrupoE-Sinais-de-email-segunda-0830**: toda **segunda-feira às 08:30**, nesta máquina, com o usuário atual.
Se a máquina estiver desligada na hora, roda assim que ligar (`StartWhenAvailable`). Saída em `server/emailSinais/logs/coleta.log`.
```
powershell -ExecutionPolicy Bypass -File server\emailSinais\agendar.ps1     # cria ou atualiza a tarefa
Unregister-ScheduledTask -TaskName GrupoE-Sinais-de-email-segunda-0830 -Confirm:$false   # remove
```
O bloco **Hoje** avisa "desatualizada" quando a última leitura passa de 8 dias.

## Configuração
- Chave da conta de serviço do Gmail: `GMAIL_CHAVE_JSON` (padrão `C:\Users\Grupo e\Segredos\...json`). Só nesta máquina.
- `server/legalizacao/.env`: `APP_URL`, `DATABASE_URL` (leitura do cadastro e do Zappy), `ACESSORIAS_API_TOKEN`,
  `CERTISEGURO_SYNC_TOKEN` (ou `LEGALIZACAO_SYNC_TOKEN`) para o envio.
- Mapa e-mail → cliente: cache de 7 dias em `%TEMP%\mapa_emails_clientes.json` (refeito sozinho; ~5 min, sequencial).

## No sistema
- `POST /api/cs/email-sinais` (token de sincronização) grava a leitura; `GET /api/cs/painel/email-sinais` lê.
- Tabelas `cs_email_sinais` e `cs_email_sinais_leitura` (RLS ligado).
- Tela: bloco **Hoje** no topo de Sucesso do Cliente (`public/js/cs.js`).

## Testes
```
node server/emailSinais/testes_email_sinais.js    # lógica pura
node server/cs/testes_email_sinais_rota.js        # validação do corpo recebido
```
