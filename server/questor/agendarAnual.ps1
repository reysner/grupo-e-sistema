# OBSOLETO desde 26/10/2026: a Analise Anual roda junto da mensal (agendarMensal.ps1, rodarMensal.cmd). Mantido so como referencia.
# Registra no Agendador de Tarefas do Windows a leitura mensal do Questor para a Analise Anual (dia 26, 08:00, nesta maquina).
# Uso:  powershell -ExecutionPolicy Bypass -File server\questor\agendarAnual.ps1
# Remover:  Unregister-ScheduledTask -TaskName 'GrupoE-Questor-Analise-Anual-dia26' -Confirm:$false
# (nome e descricao em ASCII de proposito: o Agendador recusa acentos e parenteses com HRESULT 0x80070057)
$ErrorActionPreference = 'Stop'
$nome = 'GrupoE-Questor-Analise-Anual-dia26'
$cmd  = (Resolve-Path (Join-Path $PSScriptRoot 'rodarAnual.cmd')).Path

schtasks /Create /TN $nome /SC MONTHLY /D 26 /ST 08:00 /TR ('"' + $cmd + '"') /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'schtasks nao conseguiu criar a tarefa' }
# O schtasks cortava o caminho no espaco de "Grupo e" (Execute 'C:\Users\Grupo' -> falha 0x80070002 em 26/10/2026): regrava a acao inteira.
Set-ScheduledTask -TaskName $nome -Action (New-ScheduledTaskAction -Execute $cmd) | Out-Null

# se a maquina estiver desligada no horario, roda assim que ligar; limite de 3 horas; sem rodar duas vezes ao mesmo tempo
$cfg = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
Set-ScheduledTask -TaskName $nome -Settings $cfg | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $nome
Write-Output ('Tarefa: ' + $nome)
Write-Output ('Proxima execucao: ' + $info.NextRunTime)
