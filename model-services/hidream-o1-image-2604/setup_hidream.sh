#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

CONDA_ENV="${CONDA_ENV:-hidream-o1}"
HIDREAM_REPO_DIR="${HIDREAM_REPO_DIR:-repo/HiDream-O1-Image}"

if ! conda env list | awk '{print $1}' | grep -Fxq "$CONDA_ENV"; then
  conda create -y -n "$CONDA_ENV" python=3.11
fi

if [ ! -d "$HIDREAM_REPO_DIR/.git" ]; then
  mkdir -p "$(dirname "$HIDREAM_REPO_DIR")"
  GIT_LFS_SKIP_SMUDGE=1 git clone --branch dev https://github.com/HiDream-ai/HiDream-O1-Image.git "$HIDREAM_REPO_DIR"
fi

python3 apply_pipeline_patch.py "$HIDREAM_REPO_DIR"

conda run -n "$CONDA_ENV" python -m pip install --upgrade pip
conda run -n "$CONDA_ENV" python -m pip install -r "$HIDREAM_REPO_DIR/requirements.txt"
conda run -n "$CONDA_ENV" python -m pip install fastapi uvicorn python-dotenv "huggingface_hub[cli]"
conda run -n "$CONDA_ENV" python -m pip install --force-reinstall \
  "torch==2.6.0+cu124" \
  "torchvision==0.21.0+cu124" \
  --index-url https://download.pytorch.org/whl/cu124
