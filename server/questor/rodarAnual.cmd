@echo off
rem Leitura mensal do Questor para a Analise Anual do painel /cs: faturamento por ano, funcionarios por ano e regime por ano.
rem Precisa da VPN conectada e do nWeb aberto no servidor da Voecloud. Cria sozinha o ano novo quando o ano vira.
rem Roda do dia 26 de cada mes (o faturamento do mes anterior ja esta lancado). Saida em server\questor\logs\anual.log.
cd /d "%~dp0..\.."
if not exist "%~dp0logs" mkdir "%~dp0logs"
echo ===== %DATE% %TIME% ===== >> "%~dp0logs\anual.log"
node server\questor\extrairAnual.js >> "%~dp0logs\anual.log" 2>&1
echo exit=%ERRORLEVEL% >> "%~dp0logs\anual.log"
