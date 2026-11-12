EULALens model services — reviewed source package, 2026-11-02.1

This directory versions the Qwen launcher, HiDream image wrapper, LTX video
wrapper, shared safeguards, HiDream cancellation extension, and CPU regression
tests. Service paths mirror scripts_dev/. Both deployment trees receive the
same canonical files. No model weights, full vendor source, caches, generated
media, live .env files, or credentials belong in this directory.

The manifest records package SHA256 values and the corresponding reviewed
scripts_dev hashes. Runtime source is copied byte-for-byte. Two packaging-only
adaptations are recorded: portable test paths/synthetic vendor fixture, and a
blank Qwen example API key. The external checkout revisions examined were:
  HiDream-O1-Image: 3237a638a5c2c7be106b0175958f4c0db8c2dfbf
  LTX-2:           d6053703e00195bc668cbd1d5eda9dc0b2e7b74a
These revisions identify reviewed interfaces; they do not install dependencies.
The manifest also records the upstream and audited HiDream models/pipeline.py
SHA256 values. These fingerprint Python source, not model weights. The active
scripts_dev vendor source already contained the cancellation callback at audit
baseline; packaging makes that previously local extension reproducible. The
patch helper was checked against both a synthetic fixture and the exact Git
revision above without loading or importing a model.

Checking and applying sources

Run from the website repository, substituting the actual deployment parent:
  python3 model-services/install.py --root /path/to/EULALens --check
  python3 model-services/install.py --root /path/to/EULALens --apply
  python3 model-services/install.py --root /path/to/EULALens --check

--root is required and must already exist. --check makes no filesystem changes;
exit 0 means the source contents in both scripts_dev/ and scripts/ match, exit 1
means missing/different files, and exit 2 means an unsafe path or other error.
The installer verifies every packaged checksum and a fixed source allowlist
before copying. It rejects destination symlinks and competing installer runs.

--apply uses an atomic replacement for each changed file. It first saves every
changed original source to .model-service-backups/<UTC timestamp>-<unique ID>/
under the deployment root. Backup roots are mode 0700; backup files are 0600.
changes.json records original modes, hashes, and whether each path existed.
Unchanged files are left alone; a second identical apply creates no new backup.
If a write fails partway through, the installer stops and prints the backup
location. Inspect changes.json and restore only the intended source files before
retrying; the operation is atomic per file, not a transaction across all files.
The target directory must be writable only by trusted deployment operators.

The installer never reads or replaces .env files, scans model data, invokes the
patch helper, downloads anything, starts a service, or restarts a live process.
Old unlisted wrapper files and generated media are not deleted. Applying source
files stages the code only: Python processes already running retain loaded code,
and later subprocesses can load updated files. Schedule application when model
jobs have drained to avoid mixing wrapper versions within a running job.

Required external runtime and configuration

Use existing tested environments and model checkouts. The source installer is
standard-library Python on Linux; it uses fcntl and requires Python 3.10+.
Service tests were run with Python 3.11, FastAPI, Pydantic v2, Starlette with file
Range support, python-dotenv, httpx, ffmpeg, and ffprobe. They require no CUDA,
model weights, network model service, or vendor checkout. The process-group
test uses Linux /proc. Run the two suites separately:
  python3 model-services/tests/test_installer.py
  python3 model-services/tests/test_model_services.py
Use the existing HiDream environment's Python for the second command if the
system interpreter lacks those packages. Installed tests also run from
scripts_dev/tests/test_model_services.py or scripts/tests/test_model_services.py.

Actual generation additionally needs compatible CUDA/PyTorch and existing model
packages. Qwen uses vLLM and the Qwen3.5-9B model. HiDream needs its vendor checkout,
processor/model files, scheduler dependencies, and optionally an OpenAI-compatible
prompt refiner. LTX needs its vendor checkout, model Python environment,
checkpoint, spatial upsampler, Gemma encoder and any selected LoRA. Kokoro speech
uses an external Python process with its own installed model/runtime. ffmpeg is
required for audio alignment, subtitle burning, and media assembly.

The web API also reads comic scenes aloud through the bundled Kokoro worker.
Set EULALENS_KOKORO_PYTHON if the kokoro-tts environment is outside the web
environment’s sibling conda directory. Install en_core_web_sm and libsndfile
with MP3 encoding, and cache Kokoro-82M and the af_heart voice before starting
the API. Live comic speech uses CPU and unloads the model after two idle minutes.

.env.example files describe settings, not deployable credentials. Some examples
retain the original machine's absolute paths as a record; set paths for the
target machine explicitly. In particular, configure LTX_REPO, LTX_MODEL_PYTHON
when different from <LTX_REPO>/.venv/bin/python, LTX_SERVER_PYTHON if needed,
LTX_* model paths, LTX_KOKORO_PYTHON, HIDREAM_REPO_DIR, HIDREAM_MODEL_DIR,
HIDREAM_OUTPUT_DIR, LTX_OUTPUT_ROOT, and HF_HOME. The wrapper and launcher honor
exported environment values over local .env values. setup_hidream.sh is a
separate, optional bootstrap utility that DOES download/install packages if
manually invoked; the source installer never invokes it.

Use distinct strong service credentials, supplied securely outside Git:
  VLLM_API_KEY for Qwen; backend QWEN_API_KEY must match.
  HIDREAM_API_KEY for HiDream; backend HIDREAM_API_KEY must match.
  LTX_API_KEY for video; backend VIDEO_API_KEY must match.
Set internal hosts to 127.0.0.1. Ports default to Qwen 8000, image 5052, video 5054.
The web backend proxies authenticated media; direct model artifact requests also
require their service key. Configure matching web/model credentials before
activation, and deploy the matching authenticated web client and backend.

The two-L40S launcher puts Qwen and CPU-offloaded LTX on GPU 0 and HiDream
on GPU 1. This lets the two diffusion models render concurrently on separate
GPUs. Recent 704 × 448, 12 fps LTX workers peaked at 8,600 MiB alongside a
Qwen allocation of 26,980 MiB on a 46,068 MiB GPU. Set EULALENS_VIDEO_GPU
when launching on hardware with a different placement or memory budget.

HiDream's dev checkpoint supports native preset sizes, including 2048x2048,
and exactly 28 steps. The wrapper rejects unsupported 1024x1024/four-step
requests instead of claiming controls that the pipeline ignores. /health
advertises supported resolutions and readiness. LTX returns the actual
8k+1-frame duration and subtitle timing after speech alignment, plus explicit
degraded metadata when configured speech fallbacks are used.

Installing the HiDream extension

The wrapper requires a generate_image(cancel_check=...) callback. The small
patch is versioned in hidream-o1-image-2604/patches/cooperative-cancellation.patch.
For each distinct existing HiDream checkout, back up the vendor pipeline file
and run the idempotent, syntax-checked helper explicitly:
  python3 model-services/hidream-o1-image-2604/apply_pipeline_patch.py /path/to/HiDream-O1-Image
The helper refuses unsupported upstream signatures/loops. It also makes flash
attention selection configurable. No full vendor code is copied into this repo.
LTX cancellation hooks live in the wrapper's per-instance diffusion stage and
subprocess handling; no separate LTX vendor patch is required.

Activation remains separate: review source differences, apply while jobs are
drained, configure credentials/paths and native image size, apply/check the
HiDream extension, run CPU tests, then deliberately restart services and perform
small authenticated GPU generation, cancellation, and media Range checks.
Neither this installer nor these tests activate a live deployment.

Live acceptance is explicitly opt-in. After the operator confirms readiness,
use the staged credentials privately and test one native image plus a 49-frame
video with short dialogue:
  python3 model-services/tests/accept_models.py --root /path/to/EULALens --service all --report /path/to/private/model-acceptance.json --run
The default additionally tests cancellation before admission without executing
an extra inference. --cancel active explicitly tests interruption of one extra
job on each otherwise idle selected service. The harness never restarts a
service and refuses non-loopback settings. It verifies authentication, output
metadata, HEAD/Range responses, native PNG size, decoded video frame count and
duration, non-silent audio, and returned/sidecar caption consistency. It saves
a caption frame for visual review; it does not claim automated visual quality
or OCR correctness. --run is mandatory; omitting it submits no requests.
