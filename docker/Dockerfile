# 4DAnyone runtime image (Phase 0 spike).
# Weights are NOT baked in: mount a host folder at /app/models.
# devel base is required: fdanyone compiles its 4DGS CUDA kernels at runtime.
FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu22.04

ARG FDANYONE_COMMIT=1b5c707cfe7c7fda19d08f37a10e1c444c3299ef
# Ampere (3090/A6000), Ada (4090/L40S), Hopper (H100), Blackwell consumer (5090)
ARG TORCH_CUDA_ARCH_LIST="8.6;8.9;9.0;12.0"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    TORCH_CUDA_ARCH_LIST=${TORCH_CUDA_ARCH_LIST} \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    HF_HOME=/app/models/.hf-cache \
    TORCH_EXTENSIONS_DIR=/app/models/.torch-extensions \
    YOLO_CONFIG_DIR=/tmp/ultralytics

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates curl ffmpeg ninja-build build-essential \
        libgl1 libglib2.0-0 libsm6 libxext6 \
    && rm -rf /var/lib/apt/lists/*

# uv manages Python 3.11 independently of the distro python
COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /uvx /usr/local/bin/
RUN uv venv --python 3.11 /opt/venv

WORKDIR /app
RUN git clone https://github.com/ant-research/4DAnyone.git . \
    && git checkout ${FDANYONE_COMMIT} \
    && git submodule update --init third_party/GVHMR

# torch 2.8 on PyPI (Linux) is the CUDA 12.8 build -> supports sm_120 (RTX 5090)
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install -r requirements.txt -r requirements-gui.txt

# gsplat compiles CUDA code; needs torch present (no build isolation)
RUN --mount=type=cache,target=/root/.cache/uv \
    MAX_JOBS=8 uv pip install --no-build-isolation -r requirements-4dgs.txt

# Optional faster attention; non-fatal if it fails to build
RUN --mount=type=cache,target=/root/.cache/uv \
    (uv pip install sageattention==1.0.6 || echo "sageattention skipped")

RUN python -c "import torch, gsplat; print('torch', torch.__version__, 'cuda', torch.version.cuda, 'archs', torch.cuda.get_arch_list())"

VOLUME ["/app/models", "/app/data"]
EXPOSE 7860 7861
CMD ["bash"]
