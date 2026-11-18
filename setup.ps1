# One-time setup of 4D Studio on a Windows machine with an NVIDIA GPU, Docker Desktop (WSL2) and Node.js.
#   .\setup.ps1 -Data D:\4DStudio\data -Models D:\4DStudio\models
#   .\setup.ps1 -SmplxZip C:\Downloads\models_smplx_v1_1.zip      # install SMPL-X from the official zip
#   .\setup.ps1 -SkipExamples                                      # skip the example clips and models (~1.5 GB)
# Safe to re-run: every step skips what is already there.
param(
    [string]$Data = "",
    [string]$Models = "",
    [string]$SmplxZip = "",
    [switch]$SkipBuild,
    [switch]$SkipExamples
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$docker = Join-Path $root 'docker'
$envFile = Join-Path $docker '.env'
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Compose { $ErrorActionPreference = 'Continue'; Push-Location $docker; try { docker compose @args 2>&1 | ForEach-Object { "$_" }; if ($LASTEXITCODE) { throw "docker compose $($args -join ' ') failed ($LASTEXITCODE)" } } finally { Pop-Location } }

Step '1/6 Prerequisites'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop is not installed (https://docs.docker.com/desktop/setup/install/windows-install/). Use the WSL2 backend.' }
$ErrorActionPreference = 'Continue'; docker info --format '{{.ServerVersion}}' 2>$null | Out-Null; $ok = -not $LASTEXITCODE; $ErrorActionPreference = 'Stop'
if (-not $ok) { throw 'Docker is installed but not running: start Docker Desktop and try again.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 18 or newer is required (https://nodejs.org).' }
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) { throw "Node.js 18 or newer is required (found $(node --version))." }
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader }
else { Write-Warning 'nvidia-smi not found: an NVIDIA GPU with a recent driver is required.' }

Step '2/6 Folders (docker\.env)'
if (Test-Path $envFile) {
    Write-Host "Using existing $envFile"
} else {
    if (-not $Data)   { $Data   = Read-Host 'Data folder (videos, captures, models for the web; use a fast SSD, e.g. D:\4DStudio\data)' }
    if (-not $Models) { $Models = Read-Host 'Models folder (~25 GB of weights, e.g. D:\4DStudio\models)' }
    if (-not $Data -or -not $Models) { throw 'Both folders are required.' }
    "FDA_MODELS=$($Models -replace '\\','/')`nFDA_DATA=$($Data -replace '\\','/')`n" | Set-Content -Encoding ascii $envFile
    Write-Host "Wrote $envFile"
}
. (Join-Path $docker 'config.ps1')
New-Item -ItemType Directory -Force $FdaData, $FdaModels | Out-Null
Write-Host "data:   $FdaData`nmodels: $FdaModels"

Step '3/6 Docker image (first build ~20-30 min: CUDA kernels are compiled)'
if ($SkipBuild) { Write-Host 'skipped' } else { Compose build }
Compose run --rm -T fdanyone python -c "import torch; assert torch.cuda.is_available(), 'no GPU visible in Docker'; print('GPU in Docker:', torch.cuda.get_device_name(0))"

Step '4/6 Model weights (4DAnyone, Wan2.2 Turbo LoRA, GVHMR, BiRefNet; ~25 GB, first run only)'
Compose run --rm -T fdanyone python scripts/download_model.py --model_dir /app/models
Compose run --rm -T fdanyone python -c "from fdanyone.download import ensure_perceptual_vgg19; ensure_perceptual_vgg19('/app/models')"

Step '5/6 SMPL-X body model (separate licence, free registration at https://smpl-x.is.tue.mpg.de)'
$smplx = Join-Path $FdaModels 'body_models\smplx\SMPLX_NEUTRAL.npz'
if (Test-Path $smplx) {
    Write-Host 'already installed'
} elseif ($SmplxZip) {
    Copy-Item $SmplxZip (Join-Path $FdaModels 'models_smplx_v1_1.zip')
    Compose run --rm -T fdanyone python scripts/download_smplx.py --model_dir /app/models --archive_path /app/models/models_smplx_v1_1.zip
} else {
    Write-Host 'Register at https://smpl-x.is.tue.mpg.de and accept the licence; the next prompt can download it with your login.'
    Write-Host 'Or download models_smplx_v1_1.zip yourself and re-run: .\setup.ps1 -SmplxZip <path-to-zip>'
    # interactive (asks for the login), so not piped through Compose
    Push-Location $docker; $ErrorActionPreference = 'Continue'
    docker compose run --rm fdanyone python scripts/download_smplx.py --model_dir /app/models
    $ErrorActionPreference = 'Stop'; Pop-Location
    if (-not (Test-Path $smplx)) { throw 'SMPL-X is not installed yet: re-run setup.ps1 (or pass -SmplxZip).' }
}

Step '6/6 Examples (20 Pexels clips + 6 ready-made 4D models)'
if ($SkipExamples) { Write-Host 'skipped' } else {
    Compose run --rm -T fdanyone python scripts/download_example.py --data_dir /app/data
    Compose run --rm -T -v "$root\web:/app/web:ro" -v "$root\app:/app/appsrc:ro" fdanyone bash /app/appsrc/examples.sh
}

Write-Host "`nSetup complete. Start the app with:  .\app\start.ps1   (http://127.0.0.1:7870/)" -ForegroundColor Green
