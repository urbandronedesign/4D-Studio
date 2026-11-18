# Per-frame pipeline: 4DGS frame -> LichtFeld SOG splat, with removal of inconsistent views.
#   1. build the dataset for the frame (+ init_4dgs.ply: the 4DGS model sliced at that frame)
#   2. quick pass, score every view inside the person mask; views far below the others are excluded
#      (skipped with -Exclude <ids> -SkipPass, e.g. when the list was already found on another frame)
#   3. rebuild the dataset without them and train the final splat, score it
#   4. with -Collect <dir>: copy frame_<id>.sog + frame_<id>.json there; with -Cleanup: delete everything else
#   .\run_frame.ps1 -Run full48 -Frame 000000 -Open
#   .\run_frame.ps1 -Run full48 -Frame 000042 -Exclude 7,10 -SkipPass -Collect <data>\lichtfeld\sequence\full48 -Cleanup
param(
    [string]$Run = "full48",
    [string]$Frame = "000000",
    [int]$FinalIter = 20000,
    [int]$FinalCap = 200000,
    [int]$PassIter = 10000,
    [int]$PassCap = 200000,
    [int[]]$Exclude = @(),
    [switch]$SkipPass,
    [double]$OutlierDb = 3.0,     # an excluded view must be at least this many dB below the median
    [double]$OutlierZ = 2.5,      # ... and this many robust standard deviations below it
    [int]$MaxExclude = 6,         # never drop more than this many views
    [string]$Collect = "",
    [switch]$Cleanup,
    [switch]$Open                 # open the final splat in LichtFeld when done
)
. "$PSScriptRoot\..\docker\config.ps1"
$ErrorActionPreference = "Stop"
$L = $PSScriptRoot
$root = "$FdaData\lichtfeld"
$base = "${Run}_f$Frame"
$t0 = Get-Date
function Step($msg) { Write-Host ("[{0:HH:mm:ss}] {1} {2}" -f (Get-Date), $base, $msg) -ForegroundColor Cyan }
$pass = $null
$excluded = @($Exclude)

if (-not $SkipPass) {
    Step "dataset (all views)"
    & "$L\make_dataset.ps1" -Run $Run -Frame $Frame | Out-Null
    Step "quick pass ($PassIter iters, cap $PassCap)"
    & "$L\train.ps1" -Dataset $base -Iter $PassIter -MaxCap $PassCap -Tag pass1 *> $null
    $pass = & "$L\evaluate.ps1" -Output "${base}_mrnf_${PassIter}_pass1" -Run $Run

    $ps = $pass.views_table | ForEach-Object { $_.psnr } | Sort-Object
    $med = $ps[[int][math]::Floor($ps.Count / 2)]
    $dev = $ps | ForEach-Object { [math]::Abs($_ - $med) } | Sort-Object
    $mad = [math]::Max(1.4826 * $dev[[int][math]::Floor($dev.Count / 2)], 0.1)
    $outliers = $pass.views_table |
        Where-Object { ($med - $_.psnr) -ge $OutlierDb -and (($med - $_.psnr) / $mad) -ge $OutlierZ } |
        Sort-Object psnr | Select-Object -First $MaxExclude
    $excluded = @($excluded + @($outliers | ForEach-Object { $_.cam }) | Sort-Object -Unique)
    Write-Host ("    pass1 PSNR {0}, median {1:N2}, robust sd {2:N2} -> exclude: {3}" -f $pass.psnr, $med, $mad,
        $(if ($excluded.Count) { $excluded -join "," } else { "none" }))
}

$dataset = if ($excluded.Count) { "${base}_clean" } else { $base }
Step "dataset ($(48 - $excluded.Count) views)"
& "$L\make_dataset.ps1" -Run $Run -Frame $Frame -Name $dataset -Exclude $excluded | Out-Null

Step "final ($FinalIter iters, cap $FinalCap)"
& "$L\train.ps1" -Dataset $dataset -Iter $FinalIter -MaxCap $FinalCap -Export sog *> $null
$outName = "${dataset}_mrnf_$FinalIter"
$outDir = "$root\output\$outName"
$sog = Get-ChildItem "$outDir\splat_*.sog" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $sog) { throw "$base : training produced no SOG (see $outDir\train.log)" }
$final = & "$L\evaluate.ps1" -Output $outName -Run $Run

$summary = [ordered]@{
    run = $Run; frame = $Frame; iterations = $FinalIter; max_splats = $FinalCap
    minutes = [math]::Round(((Get-Date) - $t0).TotalMinutes, 2)
    excluded_views = $excluded
    pass1 = if ($pass) { $pass | Select-Object psnr, lpips, worst3, psnr_pitch_* } else { $null }
    final = $final | Select-Object views, psnr, lpips, worst3, psnr_pitch_*
    sog_mb = [math]::Round($sog.Length / 1MB, 2)
}

$result = $sog.FullName
if ($Collect) {
    New-Item -ItemType Directory -Force $Collect | Out-Null
    $result = Join-Path $Collect "frame_$Frame.sog"
    Copy-Item $sog.FullName $result -Force
    $summary.sog = $result
    $summary | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $Collect "frame_$Frame.json")
} else {
    $summary.sog = $result
    $summary | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 "$outDir\run_summary.json"
}

if ($Cleanup) {
    if (-not $Collect) { throw "-Cleanup requires -Collect (otherwise the SOG would be deleted)" }
    $junk = @("$root\$base", "$root\${base}_evalmasks", "$root\${base}_clean", "$root\${base}_clean_evalmasks",
              "$root\output\${base}_mrnf_${PassIter}_pass1", "$root\inspect\${base}_mrnf_${PassIter}_pass1",
              $outDir, "$root\inspect\$outName")
    foreach ($p in $junk) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
}

Step ("done in {0} min: PSNR {1}, {2} MB -> {3}" -f $summary.minutes, $final.psnr, $summary.sog_mb, $result)
[pscustomobject]$summary
if ($Open) { Start-Process "$LichtfeldExe" -ArgumentList '-v', $result }
