# Run a page headlessly for -Budget ms of (virtual) time, then save its final DOM to -Out.
# Handy for motion/behavior checks: have the page write JSON into an element, then parse the dump.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\dom.ps1 -Url "http://localhost:7421/?demo&track=1" -Out C:\path\dom.html -Budget 20000
#
# Runs are serialized machine-wide, CPU-capped and cleaned up automatically (see headless.ps1). Use this
# instead of launching msedge/chrome yourself.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Width = 1280,
  [int]$Height = 720,
  [int]$Budget = 15000,
  [int]$TimeoutSec = 240
)
. (Join-Path $PSScriptRoot 'headless.ps1')
$outFull = [System.IO.Path]::GetFullPath($Out)
$dom = Invoke-CncHeadless -Kind dom -Width $Width -Height $Height -TimeoutSec $TimeoutSec -CaptureStdout `
  -EdgeArgs @("--virtual-time-budget=$Budget", '--dump-dom', $Url)
if ($dom) { [System.IO.File]::WriteAllText($outFull, $dom); "saved $outFull" } else { Write-Error 'no DOM produced'; exit 1 }
