# Open a web player for a run.
#   .\play.ps1 -Run full48b              # 4D model player (<data>\web\full48b, from make_4d.ps1), port 8081
#   .\play.ps1 -Run full48b -Sog         # per-frame SOG sequence player (<data>\lichtfeld\sequence\full48b), port 8080
#   .\play.ps1 -Run full48b -Lan         # also reachable from other devices on the local network
#   .\play.ps1 -Dir D:\some\folder -Port 8090
# Ctrl+C stops the server. URL options: 4D ?q=sh3|sh1|sh0 ; SOG ?q=sh0|sh1&ahead=40&start=12
param([string]$Run = "full48b", [string]$Dir = "", [int]$Port = 0, [switch]$Sog, [switch]$Lan)
. "$PSScriptRoot\..\docker\config.ps1"
if (-not $Dir) { $Dir = if ($Sog) { "$FdaData\lichtfeld\sequence\$Run" } else { "$FdaData\web\$Run" } }
if (-not $Port) { $Port = if ($Sog) { 8080 } else { 8081 } }
if (-not (Test-Path $Dir)) { throw "No folder: $Dir" }
$bind = if ($Lan) { "0.0.0.0" } else { "127.0.0.1" }
if ($Lan) {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -in 'Dhcp','Manual' -and $_.IPAddress -notmatch '^(127|169\.254|172\.(1[6-9]|2\d|3[01]))\.' } | Select-Object -First 1).IPAddress
    Write-Host "LAN URL: http://${ip}:$Port/  (Windows may ask to allow Node through the firewall)" -ForegroundColor Cyan
}
Start-Job { Start-Sleep 1; Start-Process "http://127.0.0.1:$using:Port/" } | Out-Null
$env:QUIET = "1"
node "$PSScriptRoot\serve.mjs" $Dir $Port $bind
