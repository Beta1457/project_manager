<#
.SYNOPSIS
  Allows other devices on the LOCAL network (only) to reach the Project Manager.
  Run from an elevated PowerShell:  .\scripts\open-firewall.ps1

.DESCRIPTION
  Creates one inbound Windows Firewall rule for the Project Manager's port (read from .env, or -Port),
  limited to devices on the same subnet; anything from the internet stays blocked. Re-run it after
  changing the port: the old rules are replaced.

.PARAMETER VpnSubnet
  Also allow devices connected through a VPN that ends on this computer, e.g. a WireGuard tunnel
  (see docs\REMOTE-ACCESS.md):  .\scripts\open-firewall.ps1 -VpnSubnet 10.47.0.0/24
  Those devices can then reach the Project Manager and nothing else on this computer: two more rules
  block every other port for that subnet, whatever other rules allow. Run the script again without
  -VpnSubnet to remove the VPN rules.
#>
param(
  [int]$Port = 0,
  [string]$VpnSubnet
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($Port -eq 0) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  # A shell opened before Node was installed has a stale PATH; try the default install folder.
  if (-not $node -and (Test-Path (Join-Path $env:ProgramFiles 'nodejs\node.exe'))) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
  if (-not $node) { throw 'Node.js not found, so the port could not be read from .env. Pass it with -Port 8080.' }
  Push-Location $root
  try {
    $Port = & $node --input-type=module -e "import { loadConfig } from './server/config.ts'; console.log(loadConfig().port)"
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the port from .env. Pass it with -Port 8080.' }
  } finally {
    Pop-Location
  }
}
if ($Port -lt 1 -or $Port -gt 65535) { throw "-Port must be from 1 to 65535 (got $Port)." }
$remote = @('LocalSubnet')
if ($VpnSubnet) {
  if ($VpnSubnet -notmatch '^\d{1,3}(\.\d{1,3}){3}/\d{1,2}$') { throw "-VpnSubnet must look like 10.47.0.0/24 (got '$VpnSubnet')." }
  $remote += $VpnSubnet
}

# Replace any earlier rules, including ones for a previous port or VPN subnet.
Get-NetFirewallRule -DisplayName 'Project Manager (LAN only, TCP *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName 'Project Manager (VPN clients: *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule

$name = "Project Manager (LAN only, TCP $Port)"
# RemoteAddress LocalSubnet = only devices on the same subnet; internet traffic is still blocked.
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
  -RemoteAddress $remote -Profile Any | Out-Null
Write-Host "Firewall rule '$name' created (allowed from: $($remote -join ', '))."

if ($VpnSubnet) {
  # Block rules win over allow rules, so VPN devices reach this one port and nothing else here, even where
  # other rules (Remote Desktop, file sharing, game servers...) would let them in.
  $otherPorts = @()
  if ($Port -gt 1) { $otherPorts += "1-$($Port - 1)" }
  if ($Port -lt 65535) { $otherPorts += "$($Port + 1)-65535" }
  New-NetFirewallRule -DisplayName 'Project Manager (VPN clients: block other TCP ports)' -Direction Inbound -Action Block `
    -Protocol TCP -LocalPort $otherPorts -RemoteAddress $VpnSubnet -Profile Any | Out-Null
  New-NetFirewallRule -DisplayName 'Project Manager (VPN clients: block UDP)' -Direction Inbound -Action Block `
    -Protocol UDP -RemoteAddress $VpnSubnet -Profile Any | Out-Null
  Write-Host "Devices on $VpnSubnet can reach TCP port $Port only; every other port on this computer is blocked for them."
}
