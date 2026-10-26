# Registra no Agendador de Tarefas do Windows a extracao MENSAL do Questor (09:00 do 1o dia util a partir do dia 25, nesta maquina), seguida da Analise Anual.
# O Agendador nao sabe o que e "dia util": a tarefa dispara todo dia as 09:00 e o extrair.js (--so-dia-da-extracao) decide se roda.
# Uso:  powershell -ExecutionPolicy Bypass -File server\questor\agendarMensal.ps1
# Remover:  Unregister-ScheduledTask -TaskName 'GrupoE-Questor-Mensal-dia25' -Confirm:$false
# Register-ScheduledTask (e nao schtasks /TR) de proposito: o caminho tem espaco ("Grupo e") e o schtasks cortava ali (falha 0x80070002 de 26/10/2026).
$ErrorActionPreference = 'Stop'
$nome = 'GrupoE-Questor-Mensal-dia25'
$cmd  = (Resolve-Path (Join-Path $PSScriptRoot 'rodarMensal.cmd')).Path

$acao    = New-ScheduledTaskAction -Execute $cmd
$gatilho = New-ScheduledTaskTrigger -Daily -At '09:00'
# se a maquina estiver desligada as 09:00, roda assim que ligar; limite de 3 horas; sem rodar duas vezes ao mesmo tempo
$cfg = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $nome -Action $acao -Trigger $gatilho -Settings $cfg -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $nome
Write-Output ('Tarefa: ' + $nome)
Write-Output ('Proximo disparo: ' + $info.NextRunTime)
