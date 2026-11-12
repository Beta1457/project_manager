<#
.SYNOPSIS
  Installs (or updates) the Project Manager as a Windows service that starts on boot.
  Run from an elevated PowerShell:  .\scripts\install-service.ps1

.DESCRIPTION
  Uses NSSM (installed via winget if missing) to run `node server\index.ts` as the
  "ProjectManager" service with automatic restart on failure and rotating logs in data\logs.
  The port and other settings come from .env (run `npm run setup` to change them).
  Safe to re-run after pulling updates or changing settings: it rebuilds the web UI and reinstalls the service.
#>
param(
  [string]$ServiceName = 'ProjectManager'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated (Administrator) PowerShell.'
}

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

# $ErrorActionPreference does not cover native programs (npm, nssm, sc.exe): check their exit codes.
function Invoke-Native([string]$What, [scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)." }
}

# Kills a process and all of its children (NSSM wrapper -> node.exe), so the port is freed.
function Stop-ProcessTree([int]$ProcessId) {
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-ProcessTree $_.ProcessId }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  # A shell opened before Node was installed has a stale PATH; use the default install folder if present.
  $defaultNode = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $defaultNode) {
    $env:Path = (Split-Path $defaultNode) + ';' + $env:Path
    $node = $defaultNode
  }
}
if (-not $node) { throw 'Node.js not found. Install it first: winget install OpenJS.NodeJS.LTS' }

function Find-NssmSource {
  $cmd = Get-Command nssm -ErrorAction SilentlyContinue
  if ($cmd) {
    $item = Get-Item $cmd.Source
    if ($item.LinkType -and $item.Target) { return [string]($item.Target | Select-Object -First 1) }
    return $cmd.Source
  }
  $found = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter nssm.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'win64' } | Select-Object -First 1
  if ($found) { return $found.FullName }
  return $null
}

# The service binary must live somewhere stable and machine-wide (not a per-user winget link).
$nssm = Join-Path $env:ProgramFiles 'nssm\nssm.exe'
if (-not (Test-Path $nssm)) {
  $src = Find-NssmSource
  if (-not $src) {
    Write-Host 'Installing NSSM via winget...'
    winget install --id NSSM.NSSM -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
    Refresh-Path
    $src = Find-NssmSource
  }
  if (-not $src) { throw 'NSSM install failed. Install it manually and re-run.' }
  New-Item -ItemType Directory -Force (Split-Path $nssm) | Out-Null
  Copy-Item $src $nssm -Force
  Write-Host "NSSM copied to $nssm"
}

# Always rebuild so the service serves the current UI (e.g. after a git pull); quick when nothing changed.
Push-Location $root
try {
  if (-not (Test-Path 'node_modules')) { Invoke-Native 'npm install' { npm install --no-fund --no-audit | Out-Host } }
  if (-not (Test-Path 'web\node_modules')) { Invoke-Native 'npm install (web)' { npm --prefix web install --no-fund --no-audit | Out-Host } }
  Write-Host 'Building web UI...'
  Invoke-Native 'Web UI build' { npm run build | Out-Host }
  # The same settings the server will use (.env, then environment variables), so the health check below
  # looks at the right port.
  $Port = & $node --input-type=module -e "import { loadConfig } from './server/config.ts'; console.log(loadConfig().port)"
  if ($LASTEXITCODE -ne 0 -or "$Port" -notmatch '^\d+$') { throw 'Could not read the settings in .env. Run npm run setup.' }
  $Port = [int]$Port
} finally {
  Pop-Location
}

$logs = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force $logs | Out-Null

$existing = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Re-installing existing service $ServiceName"
  Stop-Service $ServiceName -Force -NoWait -ErrorAction SilentlyContinue  # -NoWait: a stuck wrapper would block forever
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Service $ServiceName).Status -ne 'Stopped' -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if ((Get-Service $ServiceName).Status -ne 'Stopped' -and $existing.ProcessId) {
    # Last resort: the wrapper is stuck in STOP_PENDING. Kill it and its node.exe child.
    Write-Warning 'Service did not stop in time; killing its processes.'
    Stop-ProcessTree $existing.ProcessId
  }
  Invoke-Native 'Removing the old service' { sc.exe delete $ServiceName | Out-Null }
  # Deletion only completes once nothing holds the service open (e.g. a Services console window).
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Service $ServiceName -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    throw "Service $ServiceName is still marked for deletion. Close any Services (services.msc) windows and re-run."
  }
}

Invoke-Native 'nssm install' { & $nssm install $ServiceName $node | Out-Null }
$settings = @(
  @('Application', $node),
  @('AppParameters', 'server\index.ts'),
  @('AppDirectory', $root),
  # Port and other settings are read from .env by the server itself, so changing them never needs NSSM.
  @('AppEnvironmentExtra', 'NODE_ENV=production'),
  @('DisplayName', 'Project Manager'),
  @('Description', "Self-hosted project manager (Kanban, epochs, files, diagrams) - http://localhost:$Port"),
  @('Start', 'SERVICE_AUTO_START'),
  @('AppExit', 'Default', 'Restart'),
  @('AppRestartDelay', '5000'),
  @('AppStdout', (Join-Path $logs 'service.log')),
  @('AppStderr', (Join-Path $logs 'service.log')),
  # Rotate logs when the service (re)starts. Online rotation is avoided: it can leave NSSM stuck in STOP_PENDING.
  @('AppRotateFiles', '1'),
  @('AppRotateOnline', '0'),
  @('AppRotateBytes', '10485760'),
  # Give Node time to shut down gracefully on Ctrl+C before NSSM escalates.
  @('AppStopMethodConsole', '6000')
)
foreach ($setting in $settings) {
  $name = $setting[0]
  $values = @($setting[1..($setting.Count - 1)])
  Invoke-Native "nssm set $name" { & $nssm set $ServiceName $name @values | Out-Null }
}

# Not exit-code checked: nssm can report "start pending" while Node boots; the health check below decides.
& $nssm start $ServiceName | Out-Host
$healthy = $false
$deadline = (Get-Date).AddSeconds(20)
while (-not $healthy -and (Get-Date) -lt $deadline) {
  try { $healthy = [bool](Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 2).ok } catch { Start-Sleep -Milliseconds 500 }
}
if ($healthy) { Write-Host "Service is running: http://localhost:$Port" -ForegroundColor Green }
else { Write-Warning "Service did not answer on port $Port. Check $logs\service.log" }
Write-Host 'If phones/other PCs cannot connect, run .\scripts\open-firewall.ps1 (as Administrator).'
