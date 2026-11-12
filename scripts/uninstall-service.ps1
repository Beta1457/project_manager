<#
.SYNOPSIS
  Stops and removes the Project Manager Windows service (data is NOT deleted).
  Run from an elevated PowerShell:  .\scripts\uninstall-service.ps1
#>
param([string]$ServiceName = 'ProjectManager')
$ErrorActionPreference = 'Stop'

$svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
if (-not $svc) { Write-Host "Service $ServiceName is not installed."; return }

Stop-Service $ServiceName -Force -NoWait -ErrorAction SilentlyContinue  # -NoWait: a stuck wrapper would block forever
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Service $ServiceName).Status -ne 'Stopped' -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
if ((Get-Service $ServiceName).Status -ne 'Stopped' -and $svc.ProcessId) {
  # Stuck in STOP_PENDING: kill the NSSM wrapper and its node.exe child so the port is freed.
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$($svc.ProcessId)" -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $svc.ProcessId -Force -ErrorAction SilentlyContinue
  Start-Sleep 2
}
sc.exe delete $ServiceName | Out-Host
if ($LASTEXITCODE -ne 0) { throw "sc.exe delete failed (exit code $LASTEXITCODE)." }
Write-Host "Service $ServiceName removed. Your data in data\ is untouched."
