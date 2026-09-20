@echo off
REM Le os alvaras SANITARIOS (PDF) das pastas do servidor, com OCR nos escaneados, e manda pro Grupo-E.
REM So le arquivos; nao altera nada no servidor. Agendador (1x/dia): Programa/script = caminho completo deste .bat
setlocal
cd /d "%~dp0..\.."
node "%~dp0lerAlvarasPasta.js" %*
exit /b %ERRORLEVEL%
