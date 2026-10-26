@echo off
rem Extracoes do Questor para o painel /cs, no 1o dia util a partir do dia 25 (25/12 Natal -> 28/12), as 09:00:
rem   1) MENSAL: faturamento dos ultimos 12 meses (ate o mes anterior) e funcionarios ativos por CNPJ   -> logs\mensal.log
rem   2) ANUAL (Analise Anual): faturamento/funcionarios/regime por ano, LOGO DEPOIS (nunca em paralelo: o nWeb nao aguenta) -> logs\anual.log
rem O Agendador dispara todo dia; fora do dia certo os dois scripts saem na hora, sem tocar no Questor.
rem Precisa da VPN conectada e do nWeb aberto no servidor da Voecloud.
cd /d "%~dp0..\.."
if not exist "%~dp0logs" mkdir "%~dp0logs"
echo ===== %DATE% %TIME% ===== >> "%~dp0logs\mensal.log"
node server\questor\extrair.js --so-dia-da-extracao >> "%~dp0logs\mensal.log" 2>&1
echo exit=%ERRORLEVEL% >> "%~dp0logs\mensal.log"
echo ===== %DATE% %TIME% ===== >> "%~dp0logs\anual.log"
node server\questor\extrairAnual.js --so-dia-da-extracao >> "%~dp0logs\anual.log" 2>&1
echo exit=%ERRORLEVEL% >> "%~dp0logs\anual.log"
