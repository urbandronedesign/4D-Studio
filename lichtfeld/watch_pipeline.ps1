# Live status of a full pipeline run: 4DAnyone views -> 4DGS fit -> LichtFeld SOG sequence.
#   .\watch_pipeline.ps1 -Run full48b
param([string]$Run = "full48b", [int]$Every = 10)
. "$PSScriptRoot\..\docker\config.ps1"
$host.UI.RawUI.WindowTitle = "Pipeline - $Run"
$pipeLog = "$FdaData\$Run.log"
$fitLog  = "$FdaData\4dgs\$Run\train.jsonl"
$seqLog  = "$FdaData\lichtfeld\sequence\$Run\sequence.log"
$seen = @{}; $last = ""
function Show($text, $color = "Gray") { Write-Host ("{0:HH:mm:ss}  {1}" -f (Get-Date), $text) -ForegroundColor $color }
Write-Host "Watching $Run (Ctrl+C to stop)`n" -ForegroundColor Cyan

while ($true) {
    $status = ""
    if (Test-Path $pipeLog) {
        $lines = Get-Content $pipeLog -ErrorAction SilentlyContinue
        foreach ($l in $lines | Where-Object { $_ -match '^\[\d\d:\d\d:\d\d\] \+\d+ min: |Adaptive framing|Traceback|Error' }) {
            if (-not $seen.ContainsKey($l)) { $seen[$l] = 1; Show ($l -replace '\x1b\[[0-9;]*m', '') $(if ($l -match 'Traceback|Error') { 'Red' } else { 'Yellow' }) }
        }
        $prog = ($lines -join "`r" -split "`r" | Where-Object { $_ -match 'Generate \d+ target views: +\d+%' } | Select-Object -Last 1)
        if ($prog -and -not ($lines -match 'DONE inference')) { $status = "views: " + (($prog -replace '\x1b\[[0-9;]*m', '') -replace '[^\x20-\x7E]', '').Trim() }
    }
    if ((Test-Path $fitLog) -and -not (Test-Path $seqLog)) {
        $j = Get-Content $fitLog -Tail 1 -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
        if ($j) {
            $eta = if ($j.step -gt 0) { ($j.seconds / $j.step) * (100000 - $j.step) / 60 } else { 0 }
            $status = "4DGS fit: step {0:N0}/100,000  loss {1:N4}  gaussians {2:N0}  ETA ~{3:N0} min" -f $j.step, $j.loss, $j.points, $eta
        }
    }
    if (Test-Path $seqLog) {
        foreach ($l in Get-Content $seqLog -ErrorAction SilentlyContinue) {
            if (-not $seen.ContainsKey($l)) { $seen[$l] = 1; Write-Host $l -ForegroundColor $(if ($l -match 'FAILED') { 'Red' } elseif ($l -match 'finished') { 'Green' } else { 'White' }) }
        }
    }
    if ($status -and $status -ne $last) { Show $status; $last = $status }
    Start-Sleep $Every
}
