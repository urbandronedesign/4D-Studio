# Score a trained LichtFeld project against its training views (inside the person mask) and summarise per camera ring.
#   .\evaluate.ps1 -Output best48_f000000_mrnf_10000           # folder name under <data>\lichtfeld\output
# Returns an object with psnr/lpips, per-ring PSNR, worst views and a per-view table in .views
param(
    [Parameter(Mandatory)] [string]$Output,
    [string]$Dataset = "",                                        # default: derived from the output folder name
    [string]$Run = "",                                            # 4DGS run for camera pitch/yaw; default: dataset prefix
    [switch]$SaveImages                                           # keep GT-vs-render comparison PNGs (large)
)
. "$PSScriptRoot\..\docker\config.ps1"
$ErrorActionPreference = "Continue"
$exe  = "$LichtfeldExe"
$proj = "$FdaData\lichtfeld\output\$Output\project.licht"
$dst  = "$FdaData\lichtfeld\inspect\$Output\eval"
if (-not (Test-Path $proj)) { throw "No project: $proj" }
if (-not $Dataset) { $Dataset = $Output -replace '_(mrnf|mcmc|igs\+)_\d+.*$', '' }
if (-not $Run) { $Run = $Dataset -replace '_f\d+.*$', '' }
$masks = "$FdaData\lichtfeld\${Dataset}_evalmasks"
if (-not (Test-Path $masks)) { throw "No eval masks: $masks" }

Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue
$evalArgs = @("eval", $proj, "-o", $dst, "--eval-all", "--eval-mask", "masks:$masks", "--log-file", "$dst.log")
if (-not $SaveImages) { $evalArgs += "--no-save-eval-images" }
& $exe @evalArgs *> $null
$j = Get-Content "$dst\per_image_metrics.json" -Raw | ConvertFrom-Json
$cams = (Get-Content "$FdaData\4dgs\$Run\data\cameras.json" -Raw | ConvertFrom-Json).cameras
$rows = foreach ($c in $cams) {
    $entry = $j.('cam_{0:D2}.png' -f [int]$c.camera_id)
    if (-not $entry) { continue }                                 # view excluded from this dataset
    $e = $entry.evaluations[0]
    [pscustomobject]@{ cam = [int]$c.camera_id; pitch = $c.pitch; yaw = $c.yaw; psnr = $e.psnr; lpips = $e.lpips; masked = $e.masked }
}
$avg = { param($g, $p) ($g | Measure-Object $p -Average).Average }
$summary = [ordered]@{
    output = $Output
    views  = $rows.Count
    masked = -not ($rows.masked -contains $false)
    psnr   = [math]::Round((& $avg $rows psnr), 2)
    lpips  = [math]::Round((& $avg $rows lpips), 4)
    worst3 = ($rows | Sort-Object psnr | Select-Object -First 3 | ForEach-Object { "cam{0}={1:N1}" -f $_.cam, $_.psnr }) -join " "
}
foreach ($g in $rows | Group-Object pitch) { $summary["psnr_pitch_$($g.Name)"] = [math]::Round((& $avg $g.Group psnr), 2) }
$summary["views_table"] = $rows
[pscustomobject]$summary
