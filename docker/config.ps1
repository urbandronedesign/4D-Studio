# Dot-source from the PowerShell scripts: . "$PSScriptRoot\..\docker\config.ps1"
# Sets $FdaData, $FdaModels and $LichtfeldExe from the environment or docker/.env.
$envFile = Join-Path $PSScriptRoot '.env'
$cfg = @{}
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') { $cfg[$Matches[1]] = $Matches[2] }
    }
}
function Get-FdaSetting([string]$Name) { $v = [Environment]::GetEnvironmentVariable($Name); if ($v) { $v } else { $cfg[$Name] } }
$FdaData = Get-FdaSetting 'FDA_DATA'
$FdaModels = Get-FdaSetting 'FDA_MODELS'
$LichtfeldExe = Get-FdaSetting 'LICHTFELD_EXE'
if (-not $FdaData) { throw "FDA_DATA is not set: run setup.ps1 or create docker\.env (see docker\.env.example)" }
$FdaData = $FdaData -replace '/', '\'
