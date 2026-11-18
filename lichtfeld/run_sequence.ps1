# Turn every frame of a 4DGS run into a LichtFeld SOG splat. Keeps only frame_<id>.sog + frame_<id>.json per frame.
#   1. reference frame(s): full run_frame with the quick pass -> list of inconsistent views (saved in sequence.json)
#   2. every other frame: same excluded views, no quick pass, 4DGS-sliced init, pose-opt, SOG export, cleanup
# Resumable: frames that already have .sog + .json are skipped, so just run it again after an interruption.
#   .\run_sequence.ps1 -Run full48
#   .\run_sequence.ps1 -Run full48 -Start 0 -End 20            # a sub-range
#   .\run_sequence.ps1 -Run full48 -RefFrames 0,60,120          # find bad views on several frames (union)
param(
    [string]$Run = "full48",
    [int]$Start = 0,
    [int]$End = -1,               # inclusive; -1 = last frame
    [int]$Iter = 20000,
    [int]$Cap = 200000,
    [int[]]$RefFrames = @(0),
    [string]$Out = ""
)
. "$PSScriptRoot\..\docker\config.ps1"
$ErrorActionPreference = "Stop"
$L = $PSScriptRoot
if (-not $Out) { $Out = "$FdaData\lichtfeld\sequence\$Run" }
New-Item -ItemType Directory -Force $Out | Out-Null
$frames = (Get-Content "$FdaData\4dgs\$Run\data\metadata.json" -Raw | ConvertFrom-Json).frames
if ($End -lt 0 -or $End -ge $frames.Count) { $End = $frames.Count - 1 }
$log = Join-Path $Out "sequence.log"
function Log($msg) { $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $msg; Write-Host $line; Add-Content -Path $log -Value $line }
function Done($f) { (Test-Path (Join-Path $Out "frame_$f.sog")) -and (Test-Path (Join-Path $Out "frame_$f.json")) }

# 1. views to exclude for the whole sequence
$seqFile = Join-Path $Out "sequence.json"
if (Test-Path $seqFile) {
    $seq = Get-Content $seqFile -Raw | ConvertFrom-Json
    $excluded = @($seq.excluded_views)
    Log "reusing excluded views from sequence.json: $(if ($excluded.Count) { $excluded -join ',' } else { 'none' })"
} else {
    $excluded = @()
    foreach ($r in $RefFrames) {
        $f = $frames[$r]
        Log "reference frame $f : quick pass to find inconsistent views"
        Remove-Item -Force (Join-Path $Out "frame_$f.sog"), (Join-Path $Out "frame_$f.json") -ErrorAction SilentlyContinue
        $null = & "$L\run_frame.ps1" -Run $Run -Frame $f -FinalIter $Iter -FinalCap $Cap -Collect $Out -Cleanup
        $s = Get-Content (Join-Path $Out "frame_$f.json") -Raw | ConvertFrom-Json
        $excluded = @($excluded + @($s.excluded_views) | Sort-Object -Unique)
    }
    [ordered]@{ run = $Run; excluded_views = $excluded; reference_frames = @($RefFrames | ForEach-Object { $frames[$_] })
                iterations = $Iter; max_splats = $Cap; created = (Get-Date).ToString("s") } |
        ConvertTo-Json | Set-Content -Encoding utf8 $seqFile
    Log "excluded views for the sequence: $(if ($excluded.Count) { $excluded -join ',' } else { 'none' })"
}

# 2. all frames
$todo = @($Start..$End | ForEach-Object { $frames[$_] } | Where-Object { -not (Done $_) })
Log "$($todo.Count) frame(s) to do in $($frames[$Start])..$($frames[$End]) ($Iter iters, cap $Cap)"
$t0 = Get-Date; $n = 0; $failed = @()
foreach ($f in $todo) {
    $n++
    try {
        $null = & "$L\run_frame.ps1" -Run $Run -Frame $f -FinalIter $Iter -FinalCap $Cap -Exclude $excluded -SkipPass -Collect $Out -Cleanup
        $s = Get-Content (Join-Path $Out "frame_$f.json") -Raw | ConvertFrom-Json
        $eta = [math]::Round(((Get-Date) - $t0).TotalMinutes / $n * ($todo.Count - $n))
        $msg = "frame $f ok  PSNR $($s.final.psnr)  $($s.sog_mb) MB  ($n/$($todo.Count), ETA $eta min)"
        Log $msg
    } catch {
        $failed += $f
        Log "frame $f FAILED: $($_.Exception.Message)"
    }
}

$sogs = Get-ChildItem $Out -Filter "frame_*.sog"
Log ("finished: {0} SOG files, {1:N1} MB total, {2} failed{3}" -f $sogs.Count, (($sogs | Measure-Object Length -Sum).Sum / 1MB),
    $failed.Count, $(if ($failed.Count) { ": " + ($failed -join ",") + " (run again to retry)" }))
