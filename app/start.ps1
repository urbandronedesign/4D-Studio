# Start the 4D app and open it in the browser.
#   .\start.ps1            # http://127.0.0.1:7870/
#   .\start.ps1 -Lan       # also reachable from other devices on the local network
# Ctrl+C stops the server. A job that is running is stopped too; it restarts (keeping finished steps) next time.
param([int]$Port = 7870, [switch]$Lan)
$bind = if ($Lan) { "0.0.0.0" } else { "127.0.0.1" }
Start-Job { Start-Sleep 1; Start-Process "http://127.0.0.1:$using:Port/" } | Out-Null
node "$PSScriptRoot\server.mjs" $Port $bind
