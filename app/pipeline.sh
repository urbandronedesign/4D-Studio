#!/usr/bin/env bash
# Video -> 4DAnyone views -> 4DGS fit -> web models. Runs inside the fdanyone container (cwd /app).
#   bash /app/appsrc/pipeline.sh <video> <run> <views_per_layer> <layer_pitches_json> <steps>
# Re-running a run skips the views if they were finished, and the 4DGS fit resumes from its last checkpoint.
set -euo pipefail
video="$1"; run="$2"; vpl="$3"; pitches="$4"; steps="$5"
gen="data/4danyone/$run"; gs="data/4dgs/$run"; web="data/web/$run"
layers=$(( $(echo "$pitches" | tr -cd ',' | wc -c) + 1 ))
t0=$(date +%s)
stamp() { echo "[$(date +%H:%M:%S)] +$(( ($(date +%s) - t0) / 60 )) min: $*"; }

if [ -f "$gen/.views_done" ]; then
  stamp "SKIP inference (views already generated)"
else
  # 4DAnyone needs 121 frames. At the source clock that can mean 5 s (24 fps); resampling to 30 fps needs only 4.03 s.
  fps_args=()
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$video" 2>/dev/null || echo 0)
  rate=$(ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate -of csv=p=0 "$video" 2>/dev/null || echo 0/1)
  fps=$(awk -F/ "BEGIN { } { if (\$2 > 0) printf \"%.3f\", \$1 / \$2; else print 0 }" <<< "$rate")
  # 4DAnyone keeps the source clock (24/25/30 fps, or an even divisor of them): enough frames there means no resampling
  native=$(awk "BEGIN { f = $fps; t = (f > 30.5 ? (f % 30 < 0.5 ? 30 : (f % 25 < 0.5 ? 25 : 24)) : f); printf \"%d\", $dur * t }")
  if [ "${native:-0}" -lt 121 ]; then
    if awk "BEGIN { exit !($dur >= 4.07) }"; then
      fps_args=(--target_fps 30); stamp "short clip (${dur} s): resampling to 30 fps"
    else
      echo "error: the video is ${dur} s long; at least 4.1 s is needed (121 frames at 30 fps)"; exit 2
    fi
  fi
  stamp "START inference ($(( vpl * layers )) views)"
  python inference.py --video_path "$video" --output_dir "$gen" --views_per_layer "$vpl" --layer_pitches "$pitches" "${fps_args[@]}"
  touch "$gen/.views_done"
  stamp "DONE inference"
fi

stamp "START 4DGS fit ($steps steps)"
python reconstruct.py --data_dir "$gen" --output_dir "$gs" --steps "$steps"
stamp "DONE 4DGS fit"

stamp "START web export"
mkdir -p "$web"
for d in 3 1; do
  python /app/web/export_4d.py --npz "$gs/checkpoints/latest.npz" --out "$web/model_sh$d.s4d" --sh "$d"
done
PYTHONPATH=/app python /app/appsrc/poster.py "$gs/checkpoints/latest.npz" "$web" || echo "poster failed (not fatal)"
stamp "DONE web export"
