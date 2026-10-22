#Requires -Version 5.1
<#
  Registers (or updates) the MEMO scheduled task for the current user. No admin rights needed.
  The task runs `node bin/memo.js cycle` every -IntervalMinutes and once at logon.

  Hidden launch: by default the action is wscript.exe run-hidden.vbs, which starts node with no
  console window at all. -HiddenMethod direct runs node.exe itself (a window may flash).
  docs/PHASE0_FINDINGS.md section 5 records which one was verified on this machine.
#>
param(
  [Parameter(Mandatory = $true)][string]$NodeExe,
  [Parameter(Mandatory = $true)][string]$MemoJs,
  [string]$TaskName = 'MEMO Background Processor',
  [int]$IntervalMinutes = 15,
  [ValidateSet('vbs', 'direct')][string]$HiddenMethod = 'vbs',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

function Remove-MemoTask {
  param([string]$Name)
  $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    Write-Host "[ok] removed scheduled task '$Name'"
  } else {
    Write-Host "[skip] no scheduled task '$Name'"
  }
}

if ($Remove) {
  Remove-MemoTask -Name $TaskName
  $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'MEMO cycle.lnk'
  if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "[ok] removed startup shortcut" }
  exit 0
}

if (-not (Test-Path $NodeExe)) { throw "node not found at $NodeExe" }
if (-not (Test-Path $MemoJs)) { throw "memo.js not found at $MemoJs" }

$vbs = Join-Path $PSScriptRoot 'run-hidden.vbs'
if ($HiddenMethod -eq 'vbs' -and -not (Test-Path $vbs)) { throw "run-hidden.vbs missing next to this script" }

if ($HiddenMethod -eq 'vbs') {
  $exe = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $arguments = '//B //Nologo "{0}" "{1}" "{2}" cycle' -f $vbs, $NodeExe, $MemoJs
} else {
  $exe = $NodeExe
  $arguments = '"{0}" cycle' -f $MemoJs
}

$action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory (Split-Path $MemoJs -Parent)

$everyN = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration ([TimeSpan]::MaxValue)
$triggers = @($everyN)
try {
  $triggers += New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
} catch {
  Write-Host "[warn] logon trigger not allowed: $($_.Exception.Message)"
}

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Set-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings | Out-Null
  Write-Host "[ok] updated scheduled task '$TaskName' (every $IntervalMinutes min, $HiddenMethod launch)"
} else {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
    -Principal $principal -Description 'MEMO: captures and summarises AI coding sessions into .memory/' | Out-Null
  Write-Host "[ok] registered scheduled task '$TaskName' (every $IntervalMinutes min, $HiddenMethod launch)"
}

if (-not ($triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })) {
  $startup = [Environment]::GetFolderPath('Startup')
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'MEMO cycle.lnk'))
  $shortcut.TargetPath = $exe
  $shortcut.Arguments = $arguments
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'Run one MEMO cycle at logon'
  $shortcut.Save()
  Write-Host "[ok] startup shortcut written (logon trigger was unavailable)"
}
