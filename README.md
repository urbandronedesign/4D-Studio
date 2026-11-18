# 4D Studio

Turn one ordinary video of a person into a **4D Gaussian splat** you can orbit, scrub and stream in a web browser.

```
video ──► 4DAnyone (12–48 synthetic views) ──► 4DGS fit (20k–100k steps) ──┬──► web 4D model (.s4d) ──► 4d.html player
          Docker, 15–45 min                   Docker, 25–140 min            │    ~20 MB, streams once
                                                                            └──► per-frame splats (.sog), optional
                                                                                 LichtFeld Studio, ~1.6 min/frame
```

It is a small local app (Node, no dependencies) around [4DAnyone](https://github.com/ant-research/4DAnyone), which runs in Docker,
plus a custom WebGL2 player that evaluates the whole 4D model in the browser.
Timings are for an RTX 5090.

> **Licence warning:** several components (Wan2.2 Turbo LoRA: CC BY-NC-SA, GVHMR, SMPL-X) are **non-commercial**.
> This setup is for **research and personal use only**. See [CREDITS.md](CREDITS.md).

---

## 1. Install on a new machine

### Requirements

| | |
|---|---|
| OS | Windows 10/11 (the scripts are PowerShell; the pipeline itself runs in a Linux container) |
| GPU | NVIDIA, **24 GB VRAM or more** (the Best preset uses ~20 GB), recent driver. Ampere, Ada, Hopper or Blackwell (RTX 3090 / 4090 / 5090, A6000, L40S, H100) |
| Docker | [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) with the **WSL2 backend** (GPU support is built in) |
| Node.js | 18 or newer ([nodejs.org](https://nodejs.org)) |
| Git | to clone this repository |
| Disk | a **fast SSD** with ~80 GB free: image ~25 GB, weights ~25 GB, each Best capture a few GB |
| Account | a free [SMPL-X](https://smpl-x.is.tue.mpg.de) registration (body model licence) |

Put Docker Desktop's disk image (*Settings → Resources → Disk image location*), the models folder and the data folder on an SSD.
On a slow hard drive, builds and model loading crawl.

### Setup (one command, ~1 h, mostly downloads and the image build)

```powershell
git clone https://github.com/<you>/4D-Studio.git
cd 4D-Studio
.\setup.ps1 -Data D:\4DStudio\data -Models D:\4DStudio\models
```

`setup.ps1` is safe to re-run; each step skips what is already done:

1. checks Docker, Node and the GPU;
2. writes `docker\.env` with your two folders (template: [docker/.env.example](docker/.env.example));
3. builds the Docker image `4danyone:spike` (CUDA 12.8, PyTorch 2.8, gsplat; 4DAnyone pinned to commit `1b5c707`) and checks that the GPU is visible inside it;
4. downloads the weights pinned by 4DAnyone (Hugging Face `AntResearch/4DAnyone` revision `4c80e87`, BiRefNet, VGG-19);
5. installs **SMPL-X**: it asks for your SMPL-X login, or use `-SmplxZip <path>\models_smplx_v1_1.zip` after downloading it yourself;
6. downloads the 20 example clips and the 6 ready-made example 4D models, and prepares their thumbnails and posters (`-SkipExamples` to skip).

If PowerShell refuses to run scripts: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### Start

```powershell
.\app\start.ps1          # opens http://127.0.0.1:7870/
.\app\start.ps1 -Lan     # also reachable from other devices on the local network (no password: trusted networks only)
```

### Moving to another machine with existing results

Code lives in this repository; everything else is in the two folders from `docker\.env`.
To carry captures over, copy the data folder (at least `web\`, `source\` and `app\jobs.json`) and point `FDA_DATA` at it.
The models folder can be copied too, or simply downloaded again by `setup.ps1`.

---

## 2. The app

Drop a video, choose **Preview** (12 views, 20k steps, about 45 min) or **Production** (48 views, 100k steps, about 3 h), and wait.
When the job is done, **Open** plays the 4D result in the streaming player.

- **Layout:** a header with the GPU status and **New capture**, a create area (drop zone and example videos), and a **library** of poster cards.
  - Tabs filter the library: All, In progress, Ready and Examples.
  - Each card's **⋯** menu has Open, Rename, Source video, Retry, Cancel and Remove.
  - Cards in progress show the stage (Tracking, Views, 4D fit, Packaging), the percentage and the time left.
- **Preview first:** choosing a file (drop or browse) or an **example video** opens the New capture dialog.
  It shows the video, a name field and the quality choice, and checks the length and resolution automatically.
  Nothing is uploaded or started until **Start processing**.
- **Good source clips** show the **full body**, feet visible the whole time, against a plain background.
  With a half-body clip the model invents the legs differently in each view (about 4–5 dB lower PSNR).
- **Clip length:** 4DAnyone needs 121 frames. A clip that has fewer at its own frame rate but lasts at least 4.1 s is resampled to 30 fps automatically. Shorter clips are refused.
- **Posters:** `app\poster.py` renders each finished model from its front camera on a transparent background.
- **Player:** title and details panel (I), progress ring while streaming, time in seconds, speed (1–4) and quality menus, loop (L), reset view (R), fullscreen (F), shortcuts (?).
- **Examples:** the 20 Pexels clips bundled with 4DAnyone (full-body ones first, list in `app\examples.json`) and 6 ready-made models that open without training.
- **Queue:** jobs run one at a time on the GPU.
- **Jobs survive app restarts:** each job runs in a detached container (`fdanyone-<run>`) that writes its own log.
  The server only polls the container's state and re-adopts running jobs, so closing or updating the app never interrupts processing.
  Each job runs a private copy of `pipeline.sh`, so the script can be edited while a job runs.
- **Failures:** a failed job shows the error line from its log, `<data>\<run>.log`. **Retry** resumes it: finished views are skipped and the 4DGS fit resumes from its last checkpoint.
- **Library:** runs exported by hand into `<data>\web\<run>\` also appear in the list.
- **How it works:** `app\server.mjs` starts
  `docker compose run -d fdanyone bash pipeline.sh <video> <run> <views/layer> <pitches> <steps>`.
  [app/pipeline.sh](app/pipeline.sh) generates the views, fits the 4DGS, exports `model_sh3` and `model_sh1` and renders the poster. The server then gzips the models.

---

## 3. Repository layout

| Path | What |
|---|---|
| `setup.ps1` | one-time setup (above) |
| `app\` | the app: `server.mjs` (API, job queue, static files), `index.html` (UI), `pipeline.sh`, `poster.py`, `examples.sh`, `examples.json`, `start.ps1` |
| `web\` | the 4D player (`4d.html`, `4d-worker.js`), the exporter `export_4d.py`, the SOG player (`index.html`), the standalone server `serve.mjs`, helper scripts, `fidelity\` checks |
| `docker\` | `Dockerfile`, `compose.yaml` (service `fdanyone`), `.env.example`, `config.ps1` (reads `.env` for the PowerShell scripts) |
| `lichtfeld\` | optional per-frame 3DGS scripts for LichtFeld Studio |
| `CREDITS.md` | every borrowed component and its licence |

Not in the repository (created by `setup.ps1`): `docker\.env`, the models folder (mounted at `/app/models`) and the data folder (mounted at `/app/data`).
Inside the container the working directory is `/app` (the 4DAnyone checkout), so `data/...` there is `<data>\...` on the host.

Data folders for a run called `<run>`:

| Path | Produced by |
|---|---|
| `<data>\source\pexels\`, `<data>\source\uploads\` | example and uploaded videos |
| `<data>\4danyone\<run>\` | synthetic multi-view videos |
| `<data>\4dgs\<run>\checkpoints\latest.npz` | the 4DGS model (about 30 MB) |
| `<data>\<run>.log` | the job log |
| `<data>\web\<run>\model_sh{3,1}.s4d(.gz)`, `poster.webp` | streamable 4D models and poster |
| `<data>\app\jobs.json` | the app's job list |
| `<data>\lichtfeld\sequence\<run>\frame_NNNNNN.sog` | optional per-frame splats |

---

## 4. Running the pipeline by hand

The same script the app uses, from `docker\`:

```powershell
cd docker
docker compose run --rm -T -v "${PWD}\..\web:/app/web:ro" -v "${PWD}\..\app:/app/appsrc:ro" fdanyone `
  bash /app/appsrc/pipeline.sh data/source/<clip>.mp4 <run> 16 '[-10,15,35]' 100000 *> <data>\<run>.log
```

Arguments: views per layer, layer pitches in degrees, 4DGS steps. The app's presets are `6 '[0,30]' 20000` (Preview) and `16 '[-10,15,35]' 100000` (Production).

Watch progress in a second window (stage markers, view progress, 4DGS step and ETA):

```powershell
.\lichtfeld\watch_pipeline.ps1 -Run <run>
```

| Stage (Production) | Time | Notes |
|---|---|---|
| 48-view inference | about 41–45 min | |
| 4DGS fit, 100k steps | about 140 min | about 19.5 GB of VRAM |

Re-export an existing 4DGS model for the web (about 1 min), and play it standalone:

```powershell
cd web
.\make_4d.ps1 -Run <run>          # writes <data>\web\<run>\model_sh3/sh1.s4d, plus .gz copies
.\play.ps1 -Run <run>             # http://127.0.0.1:8081/   (-Lan for the local network)
```

---

## 5. Web streaming: how the 4D player works

The 4DGS model already describes the whole clip, so the browser downloads it **once** and evaluates every moment itself.
For each Gaussian at time t:
- position(t) = mean + velocity · (t − t0)
- opacity(t) = opacity · exp(−½((t − t0)/σt)²)
- colour: SH coefficients (degree 3), evaluated for the viewing direction

The renderer is WebGL2: Gaussians are stored in an RGBA32UI texture, drawn as instanced quads with EWA projection and front-to-back blending.
A worker culls by time and depth-sorts (16-bit counting sort, about 9 ms).

**In the player:**
- Quality menu: High (SH3) or Standard (SH1); URL `?q=sh3|sh1`.
- Mouse: drag to orbit; right-drag or shift-drag to pan; wheel to zoom.
- Keyboard: Space plays or pauses; ←/→ step one frame; 1–4 speed; L loop; R reset view; F fullscreen; I details; ? shortcuts.
- While downloading, playback starts after the first 1–2 MB and never runs past the part of the clip that has arrived (records are sorted by first-visible time).

Measured on `full48b` (531k Gaussians, 121 frames at 25 fps):

| Model | Raw | gzip (what is sent) |
|---|---|---|
| SH3 (default) | 42 MB | **22.8 MB** |
| SH1 (data saver) | 24 MB | 19.4 MB |
| *for comparison: per-frame SOG sequence* | | *504 MB* |

| Connection | Behaviour (SH3) |
|---|---|
| Local / 40 Mbit/s | playing within 3 s |
| 10 Mbit/s | plays progressively behind the download, real time from about 17 s |

About 30–45k Gaussians are visible at any moment; the full model needs about 60 MB of GPU memory.

### Rendering fidelity: the web player matches the training rasterizer

`web\fidelity\` renders the same training cameras with gsplat (`ref_render.py`) and with the web player in `?eval` mode (`web_render.mjs`), and `compare.py` reports the PSNR.

| Measured on full48b (4 cameras × 4 frames) | RGB PSNR | Alpha PSNR |
|---|---|---|
| First web renderer | 41.5 dB | 40.0 dB |
| **Current renderer + S4D2 format (SH3)** | **43.4 dB** | **54.1 dB** |
| S4D2 with SH1 | 36.3 dB | 54.1 dB |
| S4D2 with SH0 | 33.8 dB | 54.1 dB |

What closed the gap, matching gsplat 1.5.3 and 4DAnyone exactly:
- **Temporal cut:** a Gaussian is drawn only while its temporal marginal is at least 0.05 (`marginal_threshold`).
- **Alpha:** α = min(0.999, o·e^(−½d²)), skipped below 1/255.
- **Footprint:** 3.33σ.
- **Colour:** clamped after adding all SH bands, so the base colour is stored as f16.

Quantisation choices changed results by less than 0.1 dB; **dropping SH bands costs 7–10 dB**, so SH3 stays the default.

To rerun the check after changing the renderer (Edge or Chrome required):

```powershell
cd docker
# 1. reference renders (GPU)
docker compose run --rm -T -v "${PWD}\..\web:/app/web:ro" -e PYTHONPATH=/app --entrypoint python fdanyone `
  /app/web/fidelity/ref_render.py --npz /app/data/4dgs/<run>/checkpoints/latest.npz --out /app/data/web/<run>/eval
# 2. web renders: serve the eval folder, which must contain the .s4d to test (e.g. a copy of model_sh3.s4d)
node ..\web\serve.mjs <data>\web\<run>\eval 8090        # in its own window
node ..\web\fidelity\web_render.mjs "http://127.0.0.1:8090/4d.html?eval&file=model_sh3.s4d" <data>\web\<run>\eval mine
# 3. compare
docker compose run --rm -T -v "${PWD}\..\web:/app/web:ro" --entrypoint python fdanyone /app/web/fidelity/compare.py /app/data/web/<run>/eval mine
```

URL switches: `?marginal=<x>` overrides the temporal cut, `?legacy` brings back the first renderer's rules, `?file=<name>.s4d` loads a specific file.

### File format (`.s4d`, written by `export_4d.py`)

`"S4D2"` magic, a `u32` header length, a JSON header, then fixed-size records.

- Header: bbox, time range, fps, SH degree and per-band SH scales (`sh_scales`), `marginal_threshold`, home camera, the training cameras, the record encoding (`enc`) and a `progress` table.
- Records are sorted by the time each Gaussian first becomes visible, so a partial download is a complete scene up to some time; `progress` gives that time per record count.
- Record fields: mean (u16 ×3, quantised in the bbox), t0 (u16), velocity (f16 ×3), σt (f16), log-scale (f16 ×3), quaternion (i16 ×4), SH DC colour (f16 ×3, unclamped), opacity (u8), padding, SH bands 1..d (i8 each).
- Coordinates are 4DAnyone's world: Y up, metres (the exporter multiplies the npz's training units by `space_scale` 0.1).
- The older `S4D1` layout (i8 quaternion, u8 RGBA) is still readable; `export_4d.py --v1` writes it.

### Hosting it online

The player is static files:

1. Copy `web\4d.html`, `web\4d-worker.js` and the contents of `<data>\web\<run>\` (the `.s4d` files, their `.gz` copies and `models.json`) into one folder. The local server writes `models.json` on the first visit.
2. Make sure the host compresses the `.s4d` files (gzip or brotli), or serves the `.gz` copies with `Content-Encoding: gzip`. Otherwise SH3 costs 42 MB instead of 23 MB.

---

## 6. Per-frame splats with LichtFeld Studio (optional)

For ordinary static 3DGS files per frame (LichtFeld, SuperSplat, PlayCanvas).
It builds a COLMAP dataset per frame from the synthetic views, initialises it from the 4DGS slice at that time, trains, and exports SOG.
Requires [LichtFeld Studio](https://github.com/MrNeRF/LichtFeld-Studio) v0.5.5; set `LICHTFELD_EXE` in `docker\.env`.

```powershell
cd lichtfeld
.\run_sequence.ps1 -Run <run>                    # all frames: 20k steps, 200k splat cap, SOG + JSON only (resumable)
.\run_sequence.ps1 -Run <run> -Start 0 -End 9    # a range of frames
.\run_frame.ps1 -Run <run> -Frame 0 -Open        # one frame, kept for inspection, opened in LichtFeld
```

What one frame does:
1. `prepare_frame.py` writes a COLMAP dataset (RGBA images with the mask as alpha; world rotated 180° about X into LichtFeld's Y-down convention).
2. `fourdgs_to_ply.py` slices the 4DGS at that time into `init_4dgs.ply`.
3. LichtFeld trains with `--mask-mode segment --pose-opt --init init_4dgs.ply --min-track-length 0`.
4. `evaluate.ps1` measures masked PSNR and LPIPS on all views.

The reference frame first runs a quick pass, and views that disagree with the others (more than 3 dB below the median, robust z above 2.5, at most 6) are excluded for the whole sequence (`sequence.json`).

| Setting (frame 0, 10k steps) | PSNR | LPIPS |
|---|---|---|
| Baseline | 26.3 | 0.150 |
| + pose optimisation | 27.2 | 0.139 |
| + init from the 4DGS slice | 29.5 | 0.055 |
| + inconsistent views excluded | 30.6 | 0.044 |

On `full48b`: 121 frames, PSNR 34.6–36.1 (average 35.3), LPIPS about 0.039, about 1.6 min per frame, 504 MB in total.

Play the SOG sequence (streams a moving window of 40 frames; needs about 104 MB/s at 25 fps, so local or wired only):

```powershell
cd web\tools; npm ci; cd ..                       # once: PlayCanvas splat-transform
.\make_lite.ps1 -Run <run>                        # lighter copies without SH bands: SH1 375 MB, SH0 289 MB
.\play.ps1 -Run <run> -Sog                        # http://127.0.0.1:8080/  (?q=sh0|sh1, ?ahead=40&start=12)
```

---

## 7. Testing the players

```powershell
cd web
node check_player.mjs "http://127.0.0.1:8081/?q=sh3" out.png 20              # headless Edge/Chrome: console errors + screenshot
$env:SAMPLES="6"; node check_player.mjs "http://127.0.0.1:8081/" out.png 24   # also prints the status line every few seconds
$env:THROTTLE_MBPS="10"; node serve.mjs <data>\web\<run> 8082                # simulate a 10 Mbit/s connection
```

Headless browsers render with software GL, so playback there is slower than in a real browser.

---

## 8. Known limits and next steps

- The app has **no authentication**: keep it on `127.0.0.1`, or a trusted network / VPN (for example Tailscale) with `-Lan`.
- Tested on Windows with an RTX 5090. Linux would need shell equivalents of the PowerShell scripts (the server and pipeline are portable).
- The 4D player has been tested on desktop browsers; phones have less GPU memory and slower CPUs for the sort.
- Each new clip needs the GPU pipeline; only playback runs in the browser.
- Ideas: run the pipeline on a cloud GPU with the same image; smaller downloads (drop near-transparent Gaussians, entropy-code the records).
