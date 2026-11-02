import asyncio
import json
import math
import inspect
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from time import monotonic
from typing import Any, Optional
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi import Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ConfigDict


ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT.parent))
from service_runtime import ServiceError, authorize, checked_artifact, prune_completed, remaining

HOST = os.getenv("HIDREAM_HOST", "127.0.0.1")
PORT = int(os.getenv("HIDREAM_PORT", "5052"))
REPO_DIR = (ROOT / os.getenv("HIDREAM_REPO_DIR", "repo/HiDream-O1-Image")).resolve()
MODEL_DIR = (ROOT / os.getenv("HIDREAM_MODEL_DIR", "models/HiDream-O1-Image-Dev-2604")).resolve()
OUTPUT_DIR = (ROOT / os.getenv("HIDREAM_OUTPUT_DIR", "outputs")).resolve()
PUBLIC_BASE_URL = os.getenv("HIDREAM_PUBLIC_BASE_URL", "http://localhost:5052").rstrip("/")

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="EULALens HiDream Image Service")
# Internal model service: browser access goes through the authenticated web backend.
class RequestBoundary:
    def __init__(self, app):
        self.app = app
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") not in {"/generate", "/cancel"}:
            return await self.app(scope, receive, send)
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        try:
            authorize(headers.get("authorization"), os.getenv("HIDREAM_API_KEY", ""))
            maximum = int_env("HIDREAM_MAX_BODY_BYTES", 262144)
            if int(headers.get("content-length", "0")) > maximum:
                raise ServiceError(413, "Request body too large.")
            body = bytearray()
            while True:
                event = await asyncio.wait_for(receive(), timeout=15)
                if event["type"] == "http.disconnect":
                    return
                body.extend(event.get("body", b""))
                if len(body) > maximum:
                    raise ServiceError(413, "Request body too large.")
                if not event.get("more_body"):
                    break
            delivered = False
            async def replay():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}
                return await receive()
            return await self.app(scope, replay, send)
        except ServiceError as exc:
            return await JSONResponse({"detail": str(exc)}, status_code=exc.status)(scope, receive, send)
        except (ValueError, asyncio.TimeoutError):
            return await JSONResponse({"detail": "Invalid or timed out request body."}, status_code=400)(scope, receive, send)

app.add_middleware(RequestBoundary)

state = {
    "loaded": False,
    "loading": False,
    "loadError": None,
    "model": None,
    "processor": None,
    "generate_image": None,
    "default_timesteps": None,
    "refine_prompt": None,
}
model_load_lock = Lock()
generation_lock = asyncio.Lock()

# Track cancellation requests across API and inference threads.
cancellation_lock = Lock()
canceled_job_ids = set()
registered_job_ids = set()
pending_cancellations = {}
CANCELLATION_TTL_SECONDS = 3600
job_deadlines = {}
SUPPORTED_RESOLUTIONS = {(2048, 2048), (2304, 1728), (1728, 2304), (2560, 1440), (1440, 2560), (2496, 1664), (1664, 2496), (3104, 1312), (1312, 3104), (2304, 1792), (1792, 2304)}


def prune_pending_cancellations():
    now = monotonic()
    expired = [
        job_id for job_id, timestamp in pending_cancellations.items()
        if now - timestamp > CANCELLATION_TTL_SECONDS
    ]
    for job_id in expired:
        pending_cancellations.pop(job_id, None)

class GenerationCanceled(Exception):
    pass



class GenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    prompt: str = Field(..., min_length=20, max_length=20000)
    jobId: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9_.:-]{1,128}$")
    categoryId: Optional[str] = Field(default=None, max_length=200)
    title: Optional[str] = Field(default=None, max_length=500)
    height: Optional[int] = Field(default=None, ge=256, le=4096)
    width: Optional[int] = Field(default=None, ge=256, le=4096)
    seed: Optional[int] = Field(default=None, ge=0, le=2147483647)
    steps: Optional[int] = Field(default=None, ge=1, le=100)
    guidanceScale: Optional[float] = Field(default=None, ge=0, le=20)
    refinePrompt: Optional[bool] = None
    layoutBboxes: Optional[Any] = None


def str_to_bool(value: str, fallback: bool = False) -> bool:
    if value is None:
        return fallback
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def int_env(name: str, fallback: int) -> int:
    try:
        return int(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback


def float_env(name: str, fallback: float) -> float:
    try:
        return float(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback


def require_api_key(authorization: Optional[str]):
    try:
        authorize(authorization, os.getenv("HIDREAM_API_KEY", ""))
    except ServiceError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value or "comic").strip("-").lower()
    return slug[:60] or "comic"


def add_special_tokens(tokenizer):
    tokenizer.boi_token = "<|boi_token|>"
    tokenizer.bor_token = "<|bor_token|>"
    tokenizer.eor_token = "<|eor_token|>"
    tokenizer.bot_token = "<|bot_token|>"
    tokenizer.tms_token = "<|tms_token|>"


def get_tokenizer(processor):
    from transformers import PreTrainedTokenizerBase

    if isinstance(processor, PreTrainedTokenizerBase):
        return processor
    return processor.tokenizer


def resolve_torch_dtype(torch):
    dtype_name = os.getenv("HIDREAM_TORCH_DTYPE", "bfloat16").strip().lower()
    if dtype_name in {"float32", "fp32", "f32"}:
        return torch.float32
    if dtype_name in {"float16", "fp16", "half"}:
        return torch.float16
    if dtype_name in {"bfloat16", "bf16"}:
        return torch.bfloat16
    return torch.bfloat16


def ensure_repo_path():
    if not REPO_DIR.exists():
        raise RuntimeError(f"HiDream repo not found at {REPO_DIR}. Run ./setup_hidream.sh first.")
    repo_path = str(REPO_DIR)
    if repo_path not in sys.path:
        sys.path.insert(0, repo_path)


def load_pipeline():
    if state["loaded"]:
        return

    with model_load_lock:
        if state["loaded"]:
            return

        state["loading"] = True
        state["loadError"] = None
        try:
            ensure_repo_path()
            os.environ.setdefault("FA_VERSION", "none")
            os.environ.setdefault("HIDREAM_USE_FLASH_ATTN", "false")

            import torch
            from transformers import AutoProcessor
            from models.qwen3_vl_transformers import Qwen3VLForConditionalGeneration
            from models.pipeline import DEFAULT_TIMESTEPS, generate_image
            if "cancel_check" not in inspect.signature(generate_image).parameters:
                raise RuntimeError("HiDream cancellation extension is missing; run apply_pipeline_patch.py on the configured repository.")

            if not torch.cuda.is_available():
                raise RuntimeError("CUDA is required for HiDream image generation.")
            if not MODEL_DIR.exists():
                raise RuntimeError(f"HiDream model not found at {MODEL_DIR}. Run ./download_models.sh first.")

            print(f"[hidream] Loading processor and model from {MODEL_DIR}", flush=True)
            processor = AutoProcessor.from_pretrained(str(MODEL_DIR))
            model = Qwen3VLForConditionalGeneration.from_pretrained(
                str(MODEL_DIR),
                torch_dtype=resolve_torch_dtype(torch),
                device_map="cuda",
            ).eval()

            add_special_tokens(get_tokenizer(processor))

            state["model"] = model
            state["processor"] = processor
            state["generate_image"] = generate_image
            state["default_timesteps"] = DEFAULT_TIMESTEPS
            state["loaded"] = True
        except Exception as exc:
            state["loadError"] = str(exc)
            raise
        finally:
            state["loading"] = False


async def preload_pipeline():
    try:
        await asyncio.to_thread(load_pipeline)
    except Exception as exc:
        print(f"[hidream] Preload failed: {exc}", flush=True)


def maybe_refine_prompt(prompt: str, request: GenerateRequest) -> str:
    use_refiner = request.refinePrompt
    if use_refiner is None:
        use_refiner = str_to_bool(os.getenv("HIDREAM_USE_PROMPT_REFINE"), False)
    if not use_refiner:
        return prompt
    # One bounded request; the upstream refiner's nested retry/sleep loops cannot
    # obey a job deadline and previously blocked the only image worker.
    ensure_repo_path()
    from openai import OpenAI
    from prompt_agent_v2 import REWRITE_SYSTEM_PROMPT
    deadline = job_deadlines.get(request.jobId)
    with OpenAI(api_key=os.getenv("HIDREAM_PROMPT_REFINE_API_KEY", ""),
                base_url=os.getenv("HIDREAM_PROMPT_REFINE_BASE_URL", "http://127.0.0.1:8100/v1"),
                timeout=remaining(deadline, 60), max_retries=0) as client:
        response = client.chat.completions.create(
            model=os.getenv("HIDREAM_PROMPT_REFINE_MODEL", "HiDream-ai/Prompt-Refine"),
            messages=[{"role": "system", "content": REWRITE_SYSTEM_PROMPT}, {"role": "user", "content": prompt}],
            max_tokens=int_env("HIDREAM_PROMPT_REFINE_MAX_TOKENS", 2048))
    refined = response.choices[0].message.content
    if not refined or len(refined) > 20000:
        raise ServiceError(502, "Prompt refinement returned invalid output.")
    return refined.strip()


def generate_sync(request: GenerateRequest) -> dict:
    def check_cancellation():
        if request.jobId:
            with cancellation_lock:
                if request.jobId in canceled_job_ids:
                    raise GenerationCanceled(f"Job {request.jobId} was canceled.")
                remaining(job_deadlines.get(request.jobId))

    validate_generation_settings(request)
    check_cancellation()
    load_pipeline()
    check_cancellation()

    prompt = request.prompt.strip()
    refined_prompt = maybe_refine_prompt(prompt, request)
    check_cancellation()

    height = request.height or int_env("HIDREAM_HEIGHT", 2048)
    width = request.width or int_env("HIDREAM_WIDTH", 2048)
    seed = request.seed if request.seed is not None else int_env("HIDREAM_SEED", 42)
    steps = request.steps or int_env("HIDREAM_STEPS", 28)
    guidance_scale = request.guidanceScale
    if guidance_scale is None:
        guidance_scale = float_env("HIDREAM_GUIDANCE_SCALE", 0.0)

    model_type = os.getenv("HIDREAM_MODEL_TYPE", "dev").strip().lower()
    shift = float_env("HIDREAM_SHIFT", 1.0 if model_type == "dev" else 3.0)
    scheduler_name = os.getenv("HIDREAM_SCHEDULER", "flash" if model_type == "dev" else "default")
    timesteps_list = state["default_timesteps"] if model_type == "dev" else None

    extra_kwargs = {}
    if model_type == "dev" and scheduler_name == "flash":
        extra_kwargs["noise_scale_start"] = float_env("HIDREAM_NOISE_SCALE_START", 8.0)
        extra_kwargs["noise_scale_end"] = float_env("HIDREAM_NOISE_SCALE_END", 8.0)
        extra_kwargs["noise_clip_std"] = float_env("HIDREAM_NOISE_CLIP_STD", 8.0)

    layout_bboxes = request.layoutBboxes
    if layout_bboxes is not None and not isinstance(layout_bboxes, str):
        layout_bboxes = json.dumps(layout_bboxes)

    image = state["generate_image"](
        model=state["model"],
        processor=state["processor"],
        prompt=refined_prompt,
        ref_image_paths=[],
        height=height,
        width=width,
        num_inference_steps=steps,
        guidance_scale=guidance_scale,
        shift=shift,
        timesteps_list=timesteps_list,
        scheduler_name=scheduler_name,
        seed=seed,
        keep_original_aspect=False,
        layout_bboxes=layout_bboxes,
        cancel_check=check_cancellation,
        **extra_kwargs,
    )

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    base_name = slugify(request.categoryId or request.title or "comic")
    file_name = f"{stamp}-{base_name}-{uuid4().hex[:8]}.png"
    output_dir = OUTPUT_DIR / uuid4().hex
    output_dir.mkdir(parents=True, exist_ok=False)
    output_path = output_dir / file_name
    check_cancellation()
    try:
        image.save(output_path)
        check_cancellation()
    except BaseException:
        output_path.unlink(missing_ok=True)
        output_dir.rmdir()
        raise

    actual_width, actual_height = image.size

    (output_dir / ".eulalens-complete").touch()
    prune_completed(OUTPUT_DIR, float_env("HIDREAM_RETENTION_SECONDS", 604800), int_env("HIDREAM_MAX_RETAINED_JOBS", 500))
    relative_path = output_path.relative_to(OUTPUT_DIR).as_posix()
    image_url = f"{PUBLIC_BASE_URL}/outputs/{relative_path}" if PUBLIC_BASE_URL else f"/outputs/{relative_path}"

    return {
        "jobId": request.jobId,
        "categoryId": request.categoryId,
        "title": request.title,
        "imageUrl": image_url,
        "imagePath": str(output_path),
        "prompt": prompt,
        "refinedPrompt": refined_prompt,
        "seed": seed,
        "height": actual_height,
        "width": actual_width,
        "scheduler": scheduler_name,
        "steps": steps,
    }


def validate_generation_settings(request: GenerateRequest):
    if not request.prompt.strip() or len(request.prompt.strip()) < 20:
        raise HTTPException(status_code=422, detail="prompt must contain at least 20 nonblank characters.")
    width = request.width if request.width is not None else int_env("HIDREAM_WIDTH", 2048)
    height = request.height if request.height is not None else int_env("HIDREAM_HEIGHT", 2048)
    if (width, height) not in SUPPORTED_RESOLUTIONS:
        raise HTTPException(status_code=422, detail="Unsupported resolution; use a native size advertised by /health (square: 2048x2048).")
    steps = request.steps if request.steps is not None else int_env("HIDREAM_STEPS", 28)
    if os.getenv("HIDREAM_MODEL_TYPE", "dev").lower() == "dev" and steps != 28:
        raise HTTPException(status_code=422, detail="The dev model uses exactly 28 steps.")
    if request.layoutBboxes is not None:
        try:
            layout = json.loads(request.layoutBboxes) if isinstance(request.layoutBboxes, str) else request.layoutBboxes
            if len(json.dumps(layout, allow_nan=False)) > 32768:
                raise ValueError("Layout data is too large.")
            if isinstance(layout, dict):
                layout = next((layout[k] for k in ("layout_bboxes", "bboxes", "boxes", "bbox_list") if k in layout), None)
            if not isinstance(layout, list) or not 1 <= len(layout) <= 16:
                raise ValueError("Layout must contain 1–16 boxes.")
            cleaned = []
            for item in layout:
                box = item.get("bbox", item.get("box")) if isinstance(item, dict) else item
                label = str(item.get("text", item.get("label", ""))) if isinstance(item, dict) else ""
                if not isinstance(box, (list, tuple)) or len(box) != 4 or len(label) > 500:
                    raise ValueError("Invalid layout box.")
                if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 100 for v in box):
                    raise ValueError("Layout coordinates must be finite numbers between 0 and 100.")
                if box[0] >= box[1] or box[2] >= box[3]:
                    raise ValueError("Layout boxes must have positive width and height.")
                cleaned.append({"bbox": list(box), "text": label})
            # Never allow the upstream parser to interpret input as a local file path.
            request.layoutBboxes = cleaned
        except (ValueError, TypeError, StopIteration) as exc:
            raise HTTPException(status_code=422, detail="Invalid JSON layout boxes.") from exc


@app.get("/health")
def health():
    issues = []
    if not os.getenv("HIDREAM_API_KEY", "").strip():
        issues.append("authentication_not_configured")
    if not REPO_DIR.is_dir() or not MODEL_DIR.is_dir():
        issues.append("model_assets_missing")
    if state["loadError"]:
        issues.append("model_load_failed")
    if not state["loaded"]:
        issues.append("model_not_loaded")
    return {"ok": True, "ready": not issues, "issues": issues,
        "loaded": state["loaded"], "loading": state["loading"],
        "activeJobs": len(registered_job_ids),
        "supportedResolutions": [{"width": w, "height": h} for w, h in sorted(SUPPORTED_RESOLUTIONS)],
        "fixedSteps": 28 if os.getenv("HIDREAM_MODEL_TYPE", "dev").lower() == "dev" else None}


@app.api_route("/outputs/{relative_path:path}", methods=["GET", "HEAD"])
def output_file(relative_path: str, authorization: Optional[str] = Header(default=None)):
    require_api_key(authorization)
    try:
        path = checked_artifact(OUTPUT_DIR, relative_path, {".png", ".webp"})
    except ServiceError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    return FileResponse(path, headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"})


@app.on_event("startup")
async def startup():
    if str_to_bool(os.getenv("HIDREAM_PRELOAD_ON_STARTUP"), False):
        asyncio.create_task(preload_pipeline())


class CancelRequest(BaseModel):
    jobId: str = Field(..., pattern=r"^[A-Za-z0-9_.:-]{1,128}$")


@app.post("/cancel")
async def cancel_generation(request: CancelRequest, authorization: Optional[str] = Header(default=None)):
    require_api_key(authorization)
    with cancellation_lock:
        prune_pending_cancellations()
        if request.jobId in registered_job_ids:
            canceled_job_ids.add(request.jobId)
        else:
            if len(pending_cancellations) >= int_env("HIDREAM_MAX_PENDING_CANCELLATIONS", 256):
                raise HTTPException(status_code=503, detail="Cancellation queue is full.")
            pending_cancellations[request.jobId] = monotonic()
    return {"jobId": request.jobId, "status": "cancellation-requested"}


@app.post("/generate")
async def generate(request: GenerateRequest, authorization: Optional[str] = Header(default=None)):
    require_api_key(authorization)
    validate_generation_settings(request)
    if request.jobId is None:
        request = request.model_copy(update={"jobId": uuid4().hex})
    with cancellation_lock:
        prune_pending_cancellations()
        if request.jobId in registered_job_ids:
            raise HTTPException(status_code=409, detail="Job ID already registered.")
        if len(registered_job_ids) >= int_env("HIDREAM_MAX_PENDING_JOBS", 8):
            raise HTTPException(status_code=503, detail="Image queue is full.", headers={"Retry-After": "5"})
        registered_job_ids.add(request.jobId)
        job_deadlines[request.jobId] = monotonic() + float_env("HIDREAM_REQUEST_TIMEOUT_SECONDS", 600)
        if request.jobId in pending_cancellations:
            pending_cancellations.pop(request.jobId, None)
            canceled_job_ids.add(request.jobId)
    acquired = False
    worker = None
    try:
        while not acquired:
            with cancellation_lock:
                if request.jobId in canceled_job_ids:
                    raise GenerationCanceled("Generation canceled.")
                timeout = remaining(job_deadlines[request.jobId], 0.1)
            try:
                await asyncio.wait_for(generation_lock.acquire(), timeout=timeout)
                acquired = True
            except asyncio.TimeoutError:
                continue
        worker = asyncio.create_task(asyncio.to_thread(generate_sync, request))
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        with cancellation_lock:
            canceled_job_ids.add(request.jobId)
        # to_thread keeps running after coroutine cancellation. Keep ownership and
        # cancellation state until that thread has acknowledged it and exited.
        if worker is not None:
            while not worker.done():
                try:
                    await asyncio.shield(worker)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            if worker.done() and not worker.cancelled():
                worker.exception()
        raise
    except GenerationCanceled as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ServiceError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        print(f"[hidream] generation failed: {type(exc).__name__}", flush=True)
        raise HTTPException(status_code=500, detail="Image generation failed.") from exc
    finally:
        if acquired:
            generation_lock.release()
        with cancellation_lock:
            registered_job_ids.discard(request.jobId)
            canceled_job_ids.discard(request.jobId)
            job_deadlines.pop(request.jobId, None)


if __name__ == "__main__":
    import uvicorn

    if not os.getenv("HIDREAM_API_KEY", "").strip():
        raise SystemExit("Set HIDREAM_API_KEY before starting the image service.")
    uvicorn.run(app, host=HOST, port=PORT, limit_concurrency=int_env("HIDREAM_MAX_HTTP_REQUESTS", 32), timeout_keep_alive=5)
