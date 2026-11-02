#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

ENV_CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES-}"
ENV_CUDA_VISIBLE_DEVICES_SET="${CUDA_VISIBLE_DEVICES+x}"
ENV_HIDREAM_USE_PROMPT_REFINE="${HIDREAM_USE_PROMPT_REFINE-}"
ENV_HIDREAM_USE_PROMPT_REFINE_SET="${HIDREAM_USE_PROMPT_REFINE+x}"

declare -A SERVICE_LAUNCH_ENV=()
while IFS= read -r name; do
  case "$name" in
    LTX_*|HIDREAM_*|VLLM_*|CUDA_VISIBLE_DEVICES|GPU|HOST|PORT|MODEL_ID|SERVED_MODEL_NAME|MAX_MODEL_LEN|GPU_MEMORY_UTILIZATION|TENSOR_PARALLEL_SIZE|DTYPE|CONDA_ENV|HF_HOME)
      SERVICE_LAUNCH_ENV["$name"]="${!name}" ;;
  esac
done < <(compgen -e)

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi
for name in "${!SERVICE_LAUNCH_ENV[@]}"; do
  export "$name=${SERVICE_LAUNCH_ENV[$name]}"
done


if [ -n "$ENV_CUDA_VISIBLE_DEVICES_SET" ]; then
  export CUDA_VISIBLE_DEVICES="$ENV_CUDA_VISIBLE_DEVICES"
fi

if [ -n "$ENV_HIDREAM_USE_PROMPT_REFINE_SET" ]; then
  export HIDREAM_USE_PROMPT_REFINE="$ENV_HIDREAM_USE_PROMPT_REFINE"
fi

export CONDA_ENV="${CONDA_ENV:-hidream-o1}"
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
export HIDREAM_HOST="${HIDREAM_HOST:-127.0.0.1}"
export HIDREAM_PORT="${HIDREAM_PORT:-5052}"

echo "Starting HiDream image service on GPU(s): $CUDA_VISIBLE_DEVICES"
conda run --no-capture-output -n "$CONDA_ENV" python hidream_image_server.py
