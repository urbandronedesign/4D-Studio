#!/usr/bin/env bash
# Prepare the starter examples (runs inside the fdanyone container, cwd /app):
#  1. a poster image for every input clip in data/source/pexels  -> data/app/examples/<clip>.jpg
#  2. the six 4DAnyone example 4DGS models from Hugging Face     -> data/4dgs/examples/<name>.npz
#     exported for the web player                                -> data/web/ex-<name>/model_sh{3,1}.s4d
set -uo pipefail
mkdir -p data/app/examples data/4dgs/examples
for f in data/source/pexels/*.mp4; do
  out="data/app/examples/$(basename "${f%.*}").jpg"
  [ -f "$out" ] || ffmpeg -loglevel error -y -ss 1 -i "$f" -frames:v 1 -vf "scale=-2:360" -q:v 4 "$out"
done
echo "posters: $(ls data/app/examples/*.jpg | wc -l)"

for name in wusan-2 pexels-fashion zhang-weili chris engineai-t800 robotamu; do
  npz="data/4dgs/examples/$name.npz"
  if [ ! -f "$npz" ]; then
    python - "$name" <<'PY'
import shutil, sys
from huggingface_hub import hf_hub_download
name = sys.argv[1]
p = hf_hub_download("AntResearch/4DAnyone", f"data/4dgs/examples/{name}.npz", cache_dir="/app/models/.cache")
shutil.copy(p, f"data/4dgs/examples/{name}.npz")
PY
  fi
  [ -f "$npz" ] || { echo "download failed: $name"; continue; }
  mkdir -p "data/web/ex-$name"
  for d in 3 1; do
    [ -f "data/web/ex-$name/model_sh$d.s4d" ] || python /app/web/export_4d.py --npz "$npz" --out "data/web/ex-$name/model_sh$d.s4d" --sh $d | grep -E '"(gaussians|mb)"'
  done
  [ -f "data/web/ex-$name/poster.webp" ] || PYTHONPATH=/app python /app/appsrc/poster.py "$npz" "data/web/ex-$name" || echo "poster failed: $name"
  echo "example ready: $name"
done
