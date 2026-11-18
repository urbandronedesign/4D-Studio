# Export a 4DGS run as streamable 4D models for the web player (4d.html), plus precompressed .gz copies.
#   .\make_4d.ps1 -Run full48b                 # -> <data>\web\full48b\model_sh{3,1}.s4d(.gz)
#   .\make_4d.ps1 -Run full48b -Sh 3
# SH0 is not made by default: measured 33.8 dB vs 43.4 dB (SH3) against the training renderer.
param([string]$Run = "full48b", [int[]]$Sh = @(3, 1))
. "$PSScriptRoot\..\docker\config.ps1"
$ErrorActionPreference = "Continue"
$npz = "/app/data/4dgs/$Run/checkpoints/latest.npz"
$out = "$FdaData\web\$Run"
New-Item -ItemType Directory -Force $out | Out-Null
$cmd = ($Sh | ForEach-Object { "python /app/web/export_4d.py --npz $npz --out /app/data/web/$Run/model_sh$_.s4d --sh $_" }) -join " && "
Push-Location "$PSScriptRoot\..\docker"
docker compose run --rm -T -v "${PSScriptRoot}:/app/web:ro" --entrypoint bash fdanyone -c $cmd
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "export failed ($code)" }
# gzip -9 next to each model; the server sends it with Content-Encoding: gzip
node -e "const fs=require('fs'),z=require('zlib'),p=require('path');for(const f of fs.readdirSync(process.argv[1]).filter(f=>f.endsWith('.s4d'))){const s=p.join(process.argv[1],f);fs.writeFileSync(s+'.gz',z.gzipSync(fs.readFileSync(s),{level:9}));console.log(f, (fs.statSync(s).size/1048576).toFixed(1)+' MB ->', (fs.statSync(s+'.gz').size/1048576).toFixed(1)+' MB gz')}" $out
