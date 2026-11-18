# Build a static LichtFeld/COLMAP dataset from one frame of a 4DGS run (runs inside the 4danyone container).
# Also slices the 4DGS model at that frame into init_4dgs.ply (used by train.ps1 as the starting splat).
#   .\make_dataset.ps1                                         # best48, frame 000000
#   .\make_dataset.ps1 -Run full48 -Frame 000060
#   .\make_dataset.ps1 -Run full48 -Exclude 7,10,12 -Name full48_f000000_clean
param(
    [string]$Run = "best48",
    [string]$Frame = "000000",
    [string]$Name = "",
    [int[]]$Exclude = @(),
    [switch]$NoAlpha,
    [switch]$No4dgsInit
)
. "$PSScriptRoot\..\docker\config.ps1"
$ErrorActionPreference = "Continue"   # docker logs progress on stderr; rely on exit codes
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')

if (-not $Name) { $Name = "${Run}_f$Frame" + $(if ($NoAlpha) { "_rgb" }) }
$prep = @("--run", "data/4dgs/$Run", "--out", "data/lichtfeld/$Name", "--frame", $Frame)
if ($NoAlpha) { $prep += "--no-alpha" }
if ($Exclude.Count) { $prep += @("--exclude", ($Exclude -join ",")) }

$script = "python /app/lichtfeld/prepare_frame.py $($prep -join ' ')"
if (-not $No4dgsInit) {
    $script += " && python /app/lichtfeld/fourdgs_to_ply.py --npz data/4dgs/$Run/checkpoints/latest.npz" +
               " --out data/lichtfeld/$Name/init_4dgs.ply --frame $([int]$Frame)"
}

Push-Location "$PSScriptRoot\..\docker"
try {
    docker compose run --rm -T -v "${PSScriptRoot}:/app/lichtfeld:ro" fdanyone bash -c $script 2>&1 |
        ForEach-Object { "$_" } | Where-Object { $_ -notmatch 'NVIDIA|license|Copyright|CUDA Version|^=+$|^\s*$|NGC|Container docker' }
    if ($LASTEXITCODE -ne 0) { throw "dataset build failed ($LASTEXITCODE)" }
} finally { Pop-Location }

Write-Host "Dataset ready: $FdaData\lichtfeld\$Name"
