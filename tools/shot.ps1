# Headless screenshot of the dashboard (or any URL) using Edge + SwiftShader WebGL.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\shot.ps1 -Url "http://localhost:7421/?demo" -Out C:\path\shot.png
#
# -Budget is Chrome "virtual time" in ms: how long the page runs (animations included) before capture.
# Runs are serialized machine-wide, CPU-capped and cleaned up automatically (see headless.ps1). Use this
# instead of launching msedge/chrome yourself.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Width = 1280,
  [int]$Height = 720,
  [int]$Budget = 6000,
  [int]$TimeoutSec = 180
)
. (Join-Path $PSScriptRoot 'headless.ps1')
$outFull = [System.IO.Path]::GetFullPath($Out)
if (Test-Path $outFull) { Remove-Item $outFull -Force }
Invoke-CncHeadless -Kind shot -Width $Width -Height $Height -TimeoutSec $TimeoutSec `
  -EdgeArgs @("--virtual-time-budget=$Budget", "--screenshot=$outFull", $Url) | Out-Null
if (Test-Path $outFull) { "saved $outFull" } else { Write-Error 'no screenshot produced'; exit 1 }
