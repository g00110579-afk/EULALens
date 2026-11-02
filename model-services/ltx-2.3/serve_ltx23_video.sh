#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

declare -A SERVICE_LAUNCH_ENV=()
while IFS= read -r name; do
  case "$name" in
    LTX_*|HIDREAM_*|VLLM_*|CUDA_VISIBLE_DEVICES|GPU|HOST|PORT|MODEL_ID|SERVED_MODEL_NAME|MAX_MODEL_LEN|GPU_MEMORY_UTILIZATION|TENSOR_PARALLEL_SIZE|DTYPE|CONDA_ENV|HF_HOME)
      SERVICE_LAUNCH_ENV["$name"]="${!name}" ;;
  esac
done < <(compgen -e)

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
for name in "${!SERVICE_LAUNCH_ENV[@]}"; do
  export "$name=${SERVICE_LAUNCH_ENV[$name]}"
done


export LTX_HOST="${LTX_HOST:-127.0.0.1}"
export LTX_PORT="${LTX_PORT:-5054}"
export GPU="${GPU:-1}"

echo "Starting LTX video service on GPU ${GPU}"
REPO_DIR="${LTX_REPO:-$PWD/repo/LTX-2}"
SERVER_PYTHON="${LTX_SERVER_PYTHON:-$REPO_DIR/.venv/bin/python}"

if [[ -x "$SERVER_PYTHON" ]]; then
  exec "$SERVER_PYTHON" ltx_video_server.py
fi

echo "Warning: ${SERVER_PYTHON} not found; falling back to python3." >&2
echo "Resident preload needs the LTX repo venv. Run ./download_ltx23_models.sh first." >&2
exec python3 ltx_video_server.py
