# Train a static splat in LichtFeld Studio from a dataset made by make_dataset.ps1.
#   .\train.ps1                                  # headless, best48_f000000, 10k iters, <=500k splats, pose-opt, 4DGS init, SOG
#   .\train.ps1 -Gui                             # open LichtFeld with the dataset and start training in the window
#   .\train.ps1 -Dataset full48_f000000 -Iter 30000 -MaxCap 4000000
#   .\train.ps1 -Init4dgs $false                 # start from the carved points instead of the 4DGS slice
param(
    [string]$Dataset = "best48_f000000",
    [int]$Iter = 10000,
    [int]$MaxCap = 500000,        # max gaussians per frame
    [ValidateSet("mrnf", "mcmc", "igs+")] [string]$Strategy = "mrnf",
    [ValidateSet("none", "segment", "ignore", "segment_and_ignore", "alpha_consistent")] [string]$MaskMode = "segment",
    [string]$Export = "sog",      # comma list: sog, ply, spz, ...
    [bool]$PoseOpt = $true,       # refine camera poses during training (+1 dB measured on best48 f0)
    [bool]$Init4dgs = $true,      # start from init_4dgs.ply (the 4DGS model sliced at this frame) when present
    [string]$Tag = "",            # suffix for the output folder (to keep experiments apart)
    [switch]$Gui
)
. "$PSScriptRoot\..\docker\config.ps1"
$ErrorActionPreference = "Continue"   # LichtFeld logs on stderr; rely on exit code
$exe  = "$LichtfeldExe"
$data = "$FdaData\lichtfeld\$Dataset"
$out  = "$FdaData\lichtfeld\output\${Dataset}_${Strategy}_$Iter$(if ($Tag) { "_$Tag" })"
if (-not (Test-Path "$data\sparse\0\cameras.bin")) { throw "Dataset not found: $data (run make_dataset.ps1 first)" }
New-Item -ItemType Directory -Force $out | Out-Null

$lfsArgs = @(
    "-d", $data, "-o", $out,
    "--iter", $Iter, "--strategy", $Strategy, "--max-cap", $MaxCap,
    "-r", "1",                    # full 704x1280 resolution
    "--min-track-length", "0",    # synthetic points carry no COLMAP tracks
    "--mask-mode", $MaskMode,     # RGBA alpha = person mask
    "--export", $Export,
    "--log-file", "$out\train.log"
)
$init = "$data\init_4dgs.ply"
if ($Init4dgs -and (Test-Path $init)) { $lfsArgs += @("--init", $init) }
if ($PoseOpt) { $lfsArgs += "--pose-opt" }
if ($Gui) { $lfsArgs += "--train" } else { $lfsArgs += "--headless" }

Write-Host "LichtFeld-Studio $($lfsArgs -join ' ')"
$t = Get-Date
& $exe @lfsArgs
$code = $LASTEXITCODE
Write-Host ("exit {0} after {1:N1} min -> {2}" -f $code, ((Get-Date) - $t).TotalMinutes, $out)
Get-ChildItem $out -File | Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }
