# Registra (ou atualiza) no Agendador de Tarefas do Windows a leitura semanal dos sinais de e-mail:
# (nome e descricao em ASCII de proposito: o Agendador recusou acentos e parenteses com HRESULT 0x80070057)
# toda segunda-feira às 08:30, nesta máquina, com a conta do usuário atual (sem guardar senha).
# Uso:  powershell -ExecutionPolicy Bypass -File server\emailSinais\agendar.ps1
# Remover:  Unregister-ScheduledTask -TaskName 'GrupoE-Sinais-de-email-segunda-0830' -Confirm:$false
$ErrorActionPreference = 'Stop'

$nome   = 'GrupoE-Sinais-de-email-segunda-0830'
$raiz   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$node   = (Get-Command node.exe).Source
$script = Join-Path $raiz 'server\emailSinais\coletar.js'
$logs   = Join-Path $raiz 'server\emailSinais\logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$log    = Join-Path $logs 'coleta.log'

# cmd /c para registrar a saída em arquivo; cada execução começa com a data
$comando = "/c echo ===== %DATE% %TIME% ===== >> `"$log`" & `"$node`" `"$script`" --dias=14 --enviar >> `"$log`" 2>&1"
$acao    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $comando -WorkingDirectory $raiz
$gatilho = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '08:30'
$config  = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
           -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
$usuario = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

Register-ScheduledTask -TaskName $nome -Action $acao -Trigger $gatilho -Settings $config `
  -Description 'Le so cabecalhos das caixas do dominio e envia ao Grupo-E as contagens de pedidos por e-mail sem resposta (bloco Hoje do Sucesso do Cliente).' `
  -Force | Out-Null

$t = Get-ScheduledTask -TaskName $nome
$info = Get-ScheduledTaskInfo -TaskName $nome
Write-Output ("Tarefa: " + $t.TaskName)
Write-Output ("Estado: " + $t.State)
Write-Output ("Próxima execução: " + $info.NextRunTime)
Write-Output ("Conta: " + $usuario)
