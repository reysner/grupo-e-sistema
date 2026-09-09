@echo off
REM Atalho pro job "Arquivar empresas inativas" (Modelo 01).
REM Funciona de qualquer diretorio — entra sozinho na raiz do repo.
REM
REM Uso interativo:   server\arquivoMorto\arquivar-morto.bat --dry-run
REM Agendador 20:00:  Programa/script = caminho completo deste .bat (sem argumentos)
setlocal
cd /d "%~dp0..\.."
node "%~dp0run.js" %*
exit /b %ERRORLEVEL%
