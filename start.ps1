# devin-byok 网关启动器（.env 由 hybrid-server 自加载）
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
Write-Host "[devin-byok] starting gateway..." -ForegroundColor Cyan
node src/hybrid-server.js
