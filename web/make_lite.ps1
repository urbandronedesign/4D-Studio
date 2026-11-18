# Make lighter copies of a SOG sequence by dropping spherical-harmonic bands (PlayCanvas splat-transform).
#   .\make_lite.ps1 -Run full48b              # writes <seq>\sh0 and <seq>\sh1
#   .\make_lite.ps1 -Run full48b -Bands 0
# The originals are not touched. The player picks a version with ?q=sh0 / ?q=sh1 (default: original).
param([string]$Run = "full48b", [string]$Dir = "", [int[]]$Bands = @(0, 1))
. "$PSScriptRoot\..\docker\config.ps1"
$ErrorActionPreference = "Continue"
if (-not $Dir) { $Dir = "$FdaData\lichtfeld\sequence\$Run" }
$tool = "$PSScriptRoot\tools\node_modules\.bin\splat-transform.cmd"
$frames = Get-ChildItem $Dir -Filter "frame_*.sog" | Sort-Object Name
foreach ($b in $Bands) {
    $out = Join-Path $Dir "sh$b"
    New-Item -ItemType Directory -Force $out | Out-Null
    $start = Get-Date; $n = 0
    foreach ($f in $frames) {
        $n++
        $dst = Join-Path $out $f.Name
        if (Test-Path $dst) { continue }
        & $tool -q -w $f.FullName -H $b --sog-version 2 $dst 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $dst)) { Write-Host "sh$b $($f.Name) FAILED" -ForegroundColor Red }
        if ($n % 20 -eq 0) { Write-Host ("sh{0}: {1}/{2}  ({3:N1} min)" -f $b, $n, $frames.Count, ((Get-Date) - $start).TotalMinutes) }
    }
    $mb = (Get-ChildItem $out -Filter "frame_*.sog" | Measure-Object Length -Sum).Sum / 1MB
    Write-Host ("sh{0} done: {1} frames, {2:N0} MB, {3:N1} min" -f $b, (Get-ChildItem $out -Filter "frame_*.sog").Count, $mb, ((Get-Date) - $start).TotalMinutes) -ForegroundColor Green
}
