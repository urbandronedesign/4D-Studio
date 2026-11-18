# Credits

This project assembles open work by others. Their licences apply to their parts; several are **non-commercial**.

| Component | Used for | Licence |
|---|---|---|
| [4DAnyone](https://github.com/ant-research/4DAnyone) (Ant Research) | Video → multi-view generation, 4DGS training code, example clips and models | Apache-2.0 (code); assets have their own terms |
| [4D Gaussian Splatting](https://github.com/LogosIntelligenceLab/4d-gaussian-splatting) (Fudan Zhang Vision Group) | The 4D Gaussian representation 4DAnyone implements | see repository |
| [gsplat](https://github.com/nerfstudio-project/gsplat) (nerfstudio) | Training rasterizer, poster and reference renders | Apache-2.0 |
| [Wan2.2-TI2V-5B](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B) | Video diffusion base model | Apache-2.0 |
| [Wan2.2-TI2V-5B-Turbo](https://huggingface.co/quanhaol/Wan2.2-TI2V-5B-Turbo) (LoRA via [Kijai/WanVideo_comfy](https://huggingface.co/Kijai/WanVideo_comfy)) | 4-step accelerated generation | **CC BY-NC-SA 4.0** |
| [GVHMR](https://github.com/zju3dv/GVHMR) | Human motion recovery | **non-commercial** (research / education) |
| [SMPL-X](https://smpl-x.is.tue.mpg.de/) | Body model | **non-commercial** licence |
| [BiRefNet](https://huggingface.co/ZhengPeng7/BiRefNet) | Foreground masks | MIT |
| [DiffSynth-Studio](https://github.com/modelscope/DiffSynth-Studio) | Inference runtime vendored by 4DAnyone | Apache-2.0 |
| YOLO / ViTPose / HMR2 (via GVHMR) | Detection and pose | AGPL-3.0 (YOLO) and others |
| [antimatter15/splat](https://github.com/antimatter15/splat) | Design reference for the WebGL splat renderer (projection, quad, sort) | MIT |
| [PlayCanvas engine](https://github.com/playcanvas/engine) and [splat-transform](https://github.com/playcanvas/splat-transform) | Per-frame SOG player and SH reduction | MIT |
| [LichtFeld Studio](https://github.com/MrNeRF/LichtFeld-Studio) | Per-frame 3DGS training and SOG export | GPL-3.0 |
| [Pexels](https://www.pexels.com/license/) | Example videos (free to use and modify) | Pexels licence |

Because of the CC BY-NC-SA, GVHMR and SMPL-X terms, the whole pipeline is for **research and personal use only**.
