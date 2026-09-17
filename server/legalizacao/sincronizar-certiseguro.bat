@echo off
REM Atalho pro job "Sincronizar vencimentos de certificado digital (CertiSeguro)".
REM Funciona de qualquer diretorio — entra sozinho na raiz do repo.
REM
REM Uso interativo:   server\legalizacao\sincronizar-certiseguro.bat
REM Agendador (1x/dia): Programa/script = caminho completo deste .bat (sem argumentos)
setlocal
cd /d "%~dp0..\.."
node "%~dp0certiseguroSync.js" %*
exit /b %ERRORLEVEL%
