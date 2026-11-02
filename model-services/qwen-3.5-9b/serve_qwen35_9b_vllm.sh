#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

declare -A SERVICE_LAUNCH_ENV=()
while IFS= read -r name; do
  case "$name" in
    LTX_*|HIDREAM_*|VLLM_*|CUDA_VISIBLE_DEVICES|GPU|HOST|PORT|MODEL_ID|SERVED_MODEL_NAME|MAX_MODEL_LEN|GPU_MEMORY_UTILIZATION|TENSOR_PARALLEL_SIZE|DTYPE|CONDA_ENV|HF_HOME)
      SERVICE_LAUNCH_ENV["$name"]="${!name}" ;;
  esac
done < <(compgen -e)

if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/.env"
  set +a
fi
for name in "${!SERVICE_LAUNCH_ENV[@]}"; do
  export "$name=${SERVICE_LAUNCH_ENV[$name]}"
done


MODEL_ID="${MODEL_ID:-Qwen/Qwen3.5-9B}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-qwen3.5-9b}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"
VLLM_API_KEY="${VLLM_API_KEY:?Set VLLM_API_KEY before starting Qwen}"
HF_HOME="${HF_HOME:-/media/main/Data/Abhijeet/huggingface}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-16384}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.46}"
TENSOR_PARALLEL_SIZE="${TENSOR_PARALLEL_SIZE:-1}"
DTYPE="${DTYPE:-auto}"
CONDA_ENV="${CONDA_ENV:-vllm-omni}"

mkdir -p "${HF_HOME}" "${SCRIPT_DIR}/.cache"

export HF_HOME
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
export HUGGINGFACE_HUB_CACHE="${HUGGINGFACE_HUB_CACHE:-${HF_HOME}/hub}"
export VLLM_WORKER_MULTIPROC_METHOD="${VLLM_WORKER_MULTIPROC_METHOD:-spawn}"

if [[ -n "${CONDA_PREFIX:-}" ]]; then
  export LD_LIBRARY_PATH="${CONDA_PREFIX}/lib:${LD_LIBRARY_PATH:-}"
fi

if ! command -v vllm >/dev/null 2>&1; then
  if command -v conda >/dev/null 2>&1 && [[ "${CONDA_DEFAULT_ENV:-}" != "${CONDA_ENV}" ]]; then
    echo "vLLM is not active; re-running with conda env '${CONDA_ENV}'."
    exec conda run --no-capture-output -n "${CONDA_ENV}" "${SCRIPT_DIR}/serve_qwen35_9b_vllm.sh" "$@"
  fi

  echo "vLLM is not installed or not available on PATH." >&2
  echo "Install it with 'pip install vllm' or set CONDA_ENV to an env that has vLLM." >&2
  exit 1
fi

if [[ "${SKIP_CUDA_CHECK:-false}" != "true" ]]; then
  python - <<'PY'
import sys

try:
    import torch
except Exception as exc:
    print(f"Unable to import torch for CUDA preflight: {exc}", file=sys.stderr)
    sys.exit(1)

if not torch.cuda.is_available() or torch.cuda.device_count() < 1:
    print("CUDA GPU is not visible to Python. vLLM needs a visible NVIDIA GPU for this 9B model.", file=sys.stderr)
    print("Set SKIP_CUDA_CHECK=true only if you know your vLLM build can run this configuration without CUDA.", file=sys.stderr)
    sys.exit(1)
PY
fi

args=(
  serve "${MODEL_ID}"
  --host "${HOST}"
  --port "${PORT}"
  --served-model-name "${SERVED_MODEL_NAME}"
  --api-key "${VLLM_API_KEY}"
  --max-model-len "${MAX_MODEL_LEN}"
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION}"
  --tensor-parallel-size "${TENSOR_PARALLEL_SIZE}"
  --dtype "${DTYPE}"
)

if [[ "${TRUST_REMOTE_CODE:-false}" == "true" ]]; then
  args+=(--trust-remote-code)
fi

if [[ -n "${DOWNLOAD_DIR:-}" ]]; then
  args+=(--download-dir "${DOWNLOAD_DIR}")
fi

if [[ -n "${QUANTIZATION:-}" ]]; then
  args+=(--quantization "${QUANTIZATION}")
fi

if [[ -n "${VLLM_EXTRA_ARGS:-}" ]]; then
  read -r -a extra_args <<< "${VLLM_EXTRA_ARGS}"
  args+=("${extra_args[@]}")
fi

cat <<EOF
Starting vLLM
  model: ${MODEL_ID}
  served model name: ${SERVED_MODEL_NAME}
  endpoint: http://${HOST}:${PORT}/v1
  CUDA_VISIBLE_DEVICES: ${CUDA_VISIBLE_DEVICES}
  GPU memory utilization: ${GPU_MEMORY_UTILIZATION}
  Hugging Face cache: ${HF_HOME}
EOF

exec vllm "${args[@]}"
