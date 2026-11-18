# Live, readable view of a LichtFeld training log.
#   .\watch_log.ps1                                   # newest run under <data>\lichtfeld\output
#   .\watch_log.ps1 -Log D:\...\train.log
param([string]$Log)
. "$PSScriptRoot\..\docker\config.ps1"
if (-not $Log) {
    $Log = Get-ChildItem $FdaData\lichtfeld\output\*\train.log | Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
$host.UI.RawUI.WindowTitle = "LichtFeld log - $(Split-Path (Split-Path $Log) -Leaf)"
Write-Host "Following $Log  (Ctrl+C to stop)`n" -ForegroundColor Cyan

Get-Content -LiteralPath $Log -Wait -Tail 2000 | ForEach-Object {
    $line = $_
    if ($line -match '\[(warn|error|critical)\]') {
        Write-Host $line -ForegroundColor Red
    } elseif ($line -match '\[info\]' -and $line -notmatch '\[PERF\]') {
        Write-Host ($line -replace '^\[\d{4}-\d\d-\d\d (\d\d:\d\d:\d\d)\.\d+\] \[info\] \S+ ', '$1  ')
    } elseif ($line -match '^\[\d{4}-\d\d-\d\d (\d\d:\d\d:\d\d).*MRNF: (split|soft-pruned) .* at iter (\d+) \(.*active: (\d+)') {
        Write-Host ("{0}  iter {1,6}  {2,-11} splats active: {3:N0}" -f $Matches[1], $Matches[3], $Matches[2], [int64]$Matches[4]) -ForegroundColor Green
    }
}
