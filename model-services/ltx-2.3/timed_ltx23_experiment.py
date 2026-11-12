#!/usr/bin/env python3
"""Timed LTX 2.3 experiments with generation-only denoising metrics."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import threading
import time
from contextlib import ExitStack
from copy import copy
from datetime import datetime
from uuid import uuid4
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent
DEFAULT_OUTPUT_ROOT = ROOT / "Data/experiments/video-generation/ltx-2.3-timed"


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def slugify(value: str, fallback: str = "video") -> str:
    import re

    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or fallback


def gpu_memory_mib(gpu: str) -> int | None:
    try:
        output = subprocess.check_output(
            ["nvidia-smi", "--id", gpu, "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None
    try:
        return int(output.strip().splitlines()[0])
    except Exception:
        return None


def gpu_process_memory_mib(pid: int) -> int | None:
    try:
        output = subprocess.check_output(
            ["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None
    total = 0
    found = False
    for line in output.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 2:
            continue
        try:
            app_pid = int(parts[0])
            used = int(parts[1])
        except ValueError:
            continue
        if app_pid == pid:
            total += used
            found = True
    return total if found else None


def monitor_gpu(gpu: str, stop: threading.Event, samples: list[dict[str, Any]], pid: int) -> None:
    while not stop.is_set():
        used = gpu_memory_mib(gpu)
        process_used = gpu_process_memory_mib(pid)
        if used is not None:
            sample: dict[str, Any] = {"t": time.time(), "memory_used_mib": used}
            if process_used is not None:
                sample["process_memory_used_mib"] = process_used
            samples.append(sample)
        time.sleep(1)


def generate_distilled_text_video(pipeline, offload, **options):
    """Run the pinned two-stage text-to-video pipeline with request-local weights."""
    pipeline = copy(pipeline)
    # Both stages request image conditioning even for an empty image list.
    # The upstream conditioning function returns [] without using its encoder.
    pipeline.image_conditioner = lambda build_conditionings: []
    if offload != "cpu":
        return pipeline(images=[], **options)

    stage = pipeline.stage
    with ExitStack() as weights:
        transformer = None

        def denoise(**stage_args):
            nonlocal transformer
            if transformer is None:
                # Build after Gemma releases its GPU memory. The same streamed
                # transformer serves both passes of the distilled checkpoint.
                transformer = weights.enter_context(stage.model_context())
                return stage.run(transformer, **stage_args)
            try:
                return stage.run(transformer, **stage_args)
            finally:
                weights.close()
                transformer = None

        pipeline.stage = denoise
        return pipeline(images=[], **options)


def run_in_child(args: argparse.Namespace) -> int:
    env_values = read_env(SCRIPT_DIR / ".env.example")
    env_values.update(read_env(SCRIPT_DIR / ".env"))
    env_values.update({k: v for k, v in os.environ.items() if k.startswith("LTX_") or k in {"GPU", "HF_HOME"}})
    gpu = str(args.gpu or env_values.get("GPU", "1"))
    os.environ["CUDA_VISIBLE_DEVICES"] = gpu
    os.environ.setdefault("HF_HOME", "/media/main/Data/Abhijeet/huggingface")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    os.environ.setdefault("PYTORCH_ALLOC_CONF", "expandable_segments:True")

    import logging

    import torch
    from ltx_core.components.guiders import MultiModalGuiderParams
    from ltx_core.loader import LTXV_LORA_COMFY_RENAMING_MAP, LoraPathStrengthAndSDOps
    from ltx_core.model.video_vae import TilingConfig, get_video_chunks_number
    from ltx_pipelines import distilled as distilled_module
    from ltx_pipelines import ti2vid_two_stages as full_module
    from ltx_pipelines.utils import blocks
    from ltx_pipelines.utils.constants import LTX_2_3_PARAMS
    from ltx_pipelines.utils.media_io import encode_video
    from ltx_pipelines.utils.types import OffloadMode

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s:%(name)s:%(message)s")
    torch.set_grad_enabled(False)

    timings: dict[str, Any] = {
        "denoise_stages": [],
        "prompt_encode_seconds": [],
        "upsample_seconds": [],
        "video_decode_setup_seconds": [],
        "audio_decode_seconds": [],
    }

    def sync() -> None:
        if torch.cuda.is_available():
            torch.cuda.synchronize()

    original_stage_run = blocks.DiffusionStage.run

    def timed_stage_run(self: Any, *run_args: Any, **run_kwargs: Any) -> Any:
        sync()
        started = time.perf_counter()
        result = original_stage_run(self, *run_args, **run_kwargs)
        sync()
        elapsed = time.perf_counter() - started
        width = run_kwargs.get("width")
        height = run_kwargs.get("height")
        frames = run_kwargs.get("frames")
        if width is None and len(run_args) >= 5:
            width = run_args[4]
        if height is None and len(run_args) >= 6:
            height = run_args[5]
        if frames is None and len(run_args) >= 7:
            frames = run_args[6]
        timings["denoise_stages"].append(
            {
                "seconds": round(elapsed, 3),
                "width": width,
                "height": height,
                "frames": frames,
            }
        )
        return result

    original_prompt = blocks.PromptEncoder.__call__

    def timed_prompt(self: Any, *prompt_args: Any, **prompt_kwargs: Any) -> Any:
        sync()
        started = time.perf_counter()
        result = original_prompt(self, *prompt_args, **prompt_kwargs)
        sync()
        timings["prompt_encode_seconds"].append(round(time.perf_counter() - started, 3))
        return result

    original_upsample = blocks.VideoUpsampler.__call__

    def timed_upsample(self: Any, *upsample_args: Any, **upsample_kwargs: Any) -> Any:
        sync()
        started = time.perf_counter()
        result = original_upsample(self, *upsample_args, **upsample_kwargs)
        sync()
        timings["upsample_seconds"].append(round(time.perf_counter() - started, 3))
        return result

    original_video_decode = blocks.VideoDecoder.__call__

    def timed_video_decode(self: Any, *decode_args: Any, **decode_kwargs: Any) -> Any:
        sync()
        started = time.perf_counter()
        result = original_video_decode(self, *decode_args, **decode_kwargs)
        sync()
        timings["video_decode_setup_seconds"].append(round(time.perf_counter() - started, 3))
        return result

    original_audio_decode = blocks.AudioDecoder.__call__

    def timed_audio_decode(self: Any, *decode_args: Any, **decode_kwargs: Any) -> Any:
        sync()
        started = time.perf_counter()
        result = original_audio_decode(self, *decode_args, **decode_kwargs)
        sync()
        timings["audio_decode_seconds"].append(round(time.perf_counter() - started, 3))
        return result

    blocks.DiffusionStage.run = timed_stage_run
    blocks.PromptEncoder.__call__ = timed_prompt
    blocks.VideoUpsampler.__call__ = timed_upsample
    blocks.VideoDecoder.__call__ = timed_video_decode
    blocks.AudioDecoder.__call__ = timed_audio_decode

    script = json.loads(args.script_json.read_text())
    video = script["videos"][args.index]

    model_kind = args.model
    checkpoint_dir = SCRIPT_DIR / "models/LTX-2.3"
    distilled_checkpoint = Path(env_values.get("LTX_DISTILLED_CHECKPOINT", checkpoint_dir / "ltx-2.3-22b-distilled-1.1.safetensors"))
    full_checkpoint = Path(env_values.get("LTX_DEV_CHECKPOINT", checkpoint_dir / "ltx-2.3-22b-dev.safetensors"))
    upsampler = Path(env_values.get("LTX_SPATIAL_UPSAMPLER", checkpoint_dir / "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"))
    gemma_root = Path(env_values.get("LTX_GEMMA_ROOT", SCRIPT_DIR / "models/gemma-3-12b-it-qat-q4_0-unquantized"))
    distilled_lora_path = Path(
        env_values.get("LTX_DISTILLED_LORA", checkpoint_dir / "ltx-2.3-22b-distilled-lora-384-1.1.safetensors")
    )
    distilled_lora = [
        LoraPathStrengthAndSDOps(str(distilled_lora_path), args.distilled_lora_strength, LTXV_LORA_COMFY_RENAMING_MAP)
    ]

    height = args.height
    width = args.width
    num_frames = args.num_frames
    frame_rate = args.frame_rate
    seed = args.seed
    tiling_config = TilingConfig.default()
    chunks = get_video_chunks_number(num_frames, tiling_config)

    started_wall = time.perf_counter()
    if model_kind == "distilled":
        pipeline_started = time.perf_counter()
        pipeline = distilled_module.DistilledPipeline(
            distilled_checkpoint_path=str(distilled_checkpoint),
            spatial_upsampler_path=str(upsampler),
            gemma_root=str(gemma_root),
            loras=(),
            offload_mode=OffloadMode(args.offload),
        )
        if env_values.get("LTX_USE_MODEL_AUDIO", "false").lower() not in {"true", "1", "yes"}:
            pipeline.audio_decoder = lambda latent: None
        timings["pipeline_init_seconds"] = round(time.perf_counter() - pipeline_started, 3)
        call_started = time.perf_counter()
        generated_video, generated_audio = generate_distilled_text_video(
            pipeline, args.offload,
            prompt=video["model_prompt"],
            seed=seed,
            height=height,
            width=width,
            num_frames=num_frames,
            frame_rate=frame_rate,
            tiling_config=tiling_config,
            enhance_prompt=args.enhance_prompt,
        )
    else:
        pipeline_started = time.perf_counter()
        pipeline = full_module.TI2VidTwoStagesPipeline(
            checkpoint_path=str(full_checkpoint),
            distilled_lora=distilled_lora,
            spatial_upsampler_path=str(upsampler),
            gemma_root=str(gemma_root),
            loras=(),
            offload_mode=OffloadMode(args.offload),
        )
        if env_values.get("LTX_USE_MODEL_AUDIO", "false").lower() not in {"true", "1", "yes"}:
            pipeline.audio_decoder = lambda latent: None
        timings["pipeline_init_seconds"] = round(time.perf_counter() - pipeline_started, 3)
        params = LTX_2_3_PARAMS
        call_started = time.perf_counter()
        generated_video, generated_audio = pipeline(
            prompt=video["model_prompt"],
            negative_prompt=video.get("negative_prompt") or args.negative_prompt,
            seed=seed,
            height=height,
            width=width,
            num_frames=num_frames,
            frame_rate=frame_rate,
            num_inference_steps=args.num_inference_steps,
            video_guider_params=MultiModalGuiderParams(
                cfg_scale=args.video_cfg_guidance_scale or params.video_guider_params.cfg_scale,
                stg_scale=args.video_stg_guidance_scale or params.video_guider_params.stg_scale,
                rescale_scale=args.video_rescale_scale or params.video_guider_params.rescale_scale,
                modality_scale=args.a2v_guidance_scale or params.video_guider_params.modality_scale,
                skip_step=args.video_skip_step if args.video_skip_step is not None else params.video_guider_params.skip_step,
                stg_blocks=params.video_guider_params.stg_blocks,
            ),
            audio_guider_params=MultiModalGuiderParams(
                cfg_scale=args.audio_cfg_guidance_scale or params.audio_guider_params.cfg_scale,
                stg_scale=args.audio_stg_guidance_scale or params.audio_guider_params.stg_scale,
                rescale_scale=args.audio_rescale_scale or params.audio_guider_params.rescale_scale,
                modality_scale=args.v2a_guidance_scale or params.audio_guider_params.modality_scale,
                skip_step=args.audio_skip_step if args.audio_skip_step is not None else params.audio_guider_params.skip_step,
                stg_blocks=params.audio_guider_params.stg_blocks,
            ),
            images=[],
            tiling_config=tiling_config,
            max_batch_size=args.max_batch_size,
        )

    timings["pipeline_call_seconds"] = round(time.perf_counter() - call_started, 3)
    encode_started = time.perf_counter()
    encode_video(
        video=generated_video,
        fps=frame_rate,
        audio=generated_audio if env_values.get("LTX_USE_MODEL_AUDIO", "false").lower() in {"true", "1", "yes"} else None,
        output_path=str(args.output_path),
        video_chunks_number=chunks,
    )
    timings["encode_video_seconds"] = round(time.perf_counter() - encode_started, 3)
    timings["wall_seconds"] = round(time.perf_counter() - started_wall, 3)
    timings["denoise_total_seconds"] = round(sum(item["seconds"] for item in timings["denoise_stages"]), 3)
    timings["model_kind"] = model_kind
    timings["prompt"] = video["model_prompt"]
    timings["output_path"] = str(args.output_path)
    args.metrics_json.write_text(json.dumps(timings, indent=2))
    print(args.output_path)
    return 0


def run_parent(args: argparse.Namespace) -> int:
    payload = json.loads(args.scripts.read_text())
    videos = payload.get("videos", [])
    if not videos:
        raise ValueError(f"No videos found in {args.scripts}")

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output_dir = args.output_root / f"{stamp}-{uuid4().hex}"
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(args.scripts, output_dir / "video_scripts.json")
    env_values = read_env(SCRIPT_DIR / ".env.example")
    env_values.update(read_env(SCRIPT_DIR / ".env"))
    env_values.update({k: v for k, v in os.environ.items() if k.startswith("LTX_") or k in {"GPU", "HF_HOME"}})
    repo = Path(env_values.get("LTX_REPO", SCRIPT_DIR / "repo/LTX-2")).resolve()
    python = Path(env_values.get("LTX_MODEL_PYTHON", str(repo / ".venv/bin/python")))

    all_results = []
    for index, video in enumerate(videos[: args.count]):
        slug = slugify(video.get("category_id") or video.get("title") or f"video-{index + 1}")
        tag = slugify(args.tag, "") if args.tag else "timed"
        output_path = output_dir / f"{index + 1:02d}-{slug}-{args.model}-{tag}.mp4"
        metrics_path = output_dir / f"{index + 1:02d}-{slug}-{args.model}-{tag}.metrics.json"
        log_path = output_dir / f"{index + 1:02d}-{slug}-{args.model}-{tag}.log"
        child_cmd = [
            str(python),
            str(Path(__file__).resolve()),
            "--child",
            "--gpu",
            str(args.gpu),
            "--script-json",
            str(output_dir / "video_scripts.json"),
            "--index",
            str(index),
            "--output-path",
            str(output_path),
            "--metrics-json",
            str(metrics_path),
            "--model",
            args.model,
            "--height",
            str(args.height),
            "--width",
            str(args.width),
            "--num-frames",
            str(args.num_frames),
            "--frame-rate",
            str(args.frame_rate),
            "--seed",
            str(args.seed),
            "--offload",
            args.offload,
            "--num-inference-steps",
            str(args.num_inference_steps),
            "--distilled-lora-strength",
            str(args.distilled_lora_strength),
            "--max-batch-size",
            str(args.max_batch_size),
        ]
        if args.enhance_prompt:
            child_cmd.append("--enhance-prompt")
        for option_name in (
            "negative_prompt",
            "video_cfg_guidance_scale",
            "video_stg_guidance_scale",
            "video_rescale_scale",
            "a2v_guidance_scale",
            "video_skip_step",
            "audio_cfg_guidance_scale",
            "audio_stg_guidance_scale",
            "audio_rescale_scale",
            "v2a_guidance_scale",
            "audio_skip_step",
        ):
            value = getattr(args, option_name)
            if value is not None:
                child_cmd.extend([f"--{option_name.replace('_', '-')}", str(value)])

        start = time.perf_counter()
        with log_path.open("w") as log:
            proc = subprocess.Popen(child_cmd, cwd=repo, stdout=log, stderr=subprocess.STDOUT, text=True)
            samples: list[dict[str, Any]] = []
            stop = threading.Event()
            monitor = threading.Thread(target=monitor_gpu, args=(args.gpu, stop, samples, proc.pid), daemon=True)
            monitor.start()
            returncode = proc.wait()
            stop.set()
            monitor.join(timeout=2)
        elapsed = time.perf_counter() - start
        metrics = json.loads(metrics_path.read_text()) if metrics_path.exists() else {}
        result = {
            "title": video.get("title"),
            "category_id": video.get("category_id"),
            "returncode": returncode,
            "output_file": str(output_path),
            "log_file": str(log_path),
            "metrics_file": str(metrics_path),
            "parent_wall_seconds": round(elapsed, 3),
            "max_gpu_memory_mib": max((sample["memory_used_mib"] for sample in samples), default=None),
            "max_process_gpu_memory_mib": max((sample.get("process_memory_used_mib", 0) for sample in samples), default=None),
            "timings": metrics,
        }
        all_results.append(result)
        (output_dir / "results.json").write_text(json.dumps({"results": all_results}, indent=2))
        if returncode != 0:
            break

    print(output_dir)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--child", action="store_true")
    parser.add_argument("--scripts", type=Path)
    parser.add_argument("--script-json", type=Path)
    parser.add_argument("--index", type=int, default=0)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--output-path", type=Path)
    parser.add_argument("--metrics-json", type=Path)
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--model", choices=["distilled", "full"], default="distilled")
    parser.add_argument("--height", type=int, default=512)
    parser.add_argument("--width", type=int, default=768)
    parser.add_argument("--num-frames", type=int, default=481)
    parser.add_argument("--frame-rate", type=float, default=16)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--gpu", default="1")
    parser.add_argument("--offload", choices=["none", "cpu", "disk"], default="none")
    parser.add_argument("--tag", default="")
    parser.add_argument("--enhance-prompt", action="store_true")
    parser.add_argument("--negative-prompt", default="distorted faces, distorted hands, extra fingers, extra arms, duplicate people, readable text, gibberish subtitles, watermark, logo, blur")
    parser.add_argument("--num-inference-steps", type=int, default=30)
    parser.add_argument("--distilled-lora-strength", type=float, default=0.8)
    parser.add_argument("--max-batch-size", type=int, default=1)
    parser.add_argument("--video-cfg-guidance-scale", type=float, default=None)
    parser.add_argument("--video-stg-guidance-scale", type=float, default=None)
    parser.add_argument("--video-rescale-scale", type=float, default=None)
    parser.add_argument("--a2v-guidance-scale", type=float, default=None)
    parser.add_argument("--video-skip-step", type=int, default=None)
    parser.add_argument("--audio-cfg-guidance-scale", type=float, default=None)
    parser.add_argument("--audio-stg-guidance-scale", type=float, default=None)
    parser.add_argument("--audio-rescale-scale", type=float, default=None)
    parser.add_argument("--v2a-guidance-scale", type=float, default=None)
    parser.add_argument("--audio-skip-step", type=int, default=None)
    args = parser.parse_args()

    if args.child:
        if args.script_json is None or args.output_path is None or args.metrics_json is None:
            raise ValueError("--child requires --script-json, --output-path, and --metrics-json")
        return run_in_child(args)
    if args.scripts is None:
        raise ValueError("--scripts is required")
    return run_parent(args)


if __name__ == "__main__":
    raise SystemExit(main())
