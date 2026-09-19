@echo off
REM Atalho pro job "Consultar alvaras na Prefeitura (1 empresa a cada 20s, a partir do escritorio)".
REM O IP do Render e bloqueado pela Prefeitura, por isso roda numa estacao do escritorio.
REM Agendador (1x/dia, de madrugada): Programa/script = caminho completo deste .bat (sem argumentos)
setlocal
cd /d "%~dp0..\.."
node "%~dp0consultarAlvarasLocal.js" %*
exit /b %ERRORLEVEL%
