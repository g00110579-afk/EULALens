#!/usr/bin/env python3
"""Small local HTTP wrapper for LTX-2.3 video generation."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import signal
import shutil
import subprocess
import sys
import threading
import time
import concurrent.futures
import math
import wave
from uuid import uuid4
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR.parent))
from service_runtime import (ServiceError, authorize, finite_number, checked_artifact,
  stream_artifact, terminate_group, signal_group, remaining, acquired_until,
  prune_completed, speaker_voices)


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


ENV = read_env(SCRIPT_DIR / ".env.example")
ENV.update(read_env(SCRIPT_DIR / ".env"))
ENV.update({k: v for k, v in os.environ.items() if k.startswith("LTX_") or k in {"GPU", "HF_HOME"}})

HOST = ENV.get("LTX_HOST", "127.0.0.1")
PORT = int(ENV.get("LTX_PORT", "5054"))
PUBLIC_BASE_URL = ENV.get("LTX_PUBLIC_BASE_URL", f"http://localhost:{PORT}").rstrip("/")
OUTPUT_ROOT = Path(
  ENV.get(
    "LTX_OUTPUT_ROOT",
    ROOT / "Data/experiments/video-generation/ltx-2.3/app-renders",
  )
).resolve()
REQUEST_ROOT = OUTPUT_ROOT / "requests"
GENERATION_LOCK = threading.Lock()

# Track individual video jobs for safe cancellation.
JOB_LOCK = threading.Lock()
ACTIVE_JOBS = {}
PENDING_CANCELLATIONS = {}
CANCELLATION_TTL_SECONDS = 3600
ADMISSION = threading.BoundedSemaphore(max(1, int(ENV.get("LTX_MAX_PENDING_JOBS", "8"))))
AUDIO_EXECUTOR_LOCK = threading.Lock()


class VideoGenerationCanceled(Exception):
  pass


def prune_pending_cancellations():
  now = time.monotonic()
  expired = [
    job_id for job_id, timestamp in PENDING_CANCELLATIONS.items()
    if now - timestamp > CANCELLATION_TTL_SECONDS
  ]
  for job_id in expired:
    PENDING_CANCELLATIONS.pop(job_id, None)


def check_job_cancellation(job_id):
  if not job_id:
    return
  with JOB_LOCK:
    if job_id in PENDING_CANCELLATIONS:
      raise VideoGenerationCanceled(f"Video job {job_id} was canceled.")
    job = ACTIVE_JOBS.get(job_id)
    if job is not None and job.get("canceled"):
      raise VideoGenerationCanceled(f"Video job {job_id} was canceled.")
    if job is not None:
      remaining(job.get("deadline"))


RESIDENT_RUNNER = None
RESIDENT_LOAD_ERROR = None
KOKORO_PIPELINE = None
KOKORO_PIPELINE_LANG = None
KOKORO_LOCK = threading.Lock()
AUDIO_EXECUTOR = None


def slugify(value: str, fallback: str = "video") -> str:
  slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
  return slug or fallback


def send_json(handler: BaseHTTPRequestHandler, payload: dict, status: int = 200) -> None:
  data = json.dumps(payload, indent=2).encode("utf-8")
  handler.send_response(status)
  handler.send_header("Content-Type", "application/json")
  if status == 503:
    handler.send_header("Retry-After", "5")
  handler.send_header("Content-Length", str(len(data)))
  handler.end_headers()
  try:
    handler.wfile.write(data)
  except (BrokenPipeError, ConnectionResetError):
    pass


def int_env(name: str, fallback: int) -> int:
  try:
    return int(ENV.get(name, fallback))
  except (TypeError, ValueError):
    return fallback


def float_env(name: str, fallback: float) -> float:
  try:
    return float(ENV.get(name, fallback))
  except (TypeError, ValueError):
    return fallback


def bool_env(name: str, fallback: bool = False) -> bool:
  value = ENV.get(name)
  if value is None:
    return fallback
  return value.strip().lower() in {"1", "true", "yes", "on"}


def get_audio_executor() -> concurrent.futures.ThreadPoolExecutor:
  global AUDIO_EXECUTOR
  with AUDIO_EXECUTOR_LOCK:
    if AUDIO_EXECUTOR is None:
      AUDIO_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, int_env("LTX_AUDIO_WORKERS", 1)))
    return AUDIO_EXECUTOR


def read_request_json(handler: BaseHTTPRequestHandler) -> dict:
  try:
    length = int(handler.headers.get("Content-Length", "0"))
  except (TypeError, ValueError):
    raise ServiceError(400, "Content-Length is required.") from None
  if length <= 0:
    raise ServiceError(400, "A JSON request body is required.")
  if length > int_env("LTX_MAX_BODY_BYTES", 262144):
    raise ServiceError(413, "Request body too large.")
  if handler.headers.get("Transfer-Encoding"):
    raise ServiceError(400, "Transfer-Encoding is not supported.")
  try:
    body = json.loads(handler.rfile.read(length).decode("utf-8"))
  except (ValueError, UnicodeError):
    raise ServiceError(400, "Invalid JSON body.") from None
  if not isinstance(body, dict):
    raise ServiceError(422, "JSON body must be an object.")
  return body


def log_tail(path: Path, limit: int = 5000) -> str:
  if not path.exists():
    return ""
  text = path.read_text(errors="replace")
  return text[-limit:]


def public_url_for(path: Path) -> str:
  relative = path.resolve().relative_to(OUTPUT_ROOT).as_posix()
  return f"{PUBLIC_BASE_URL}/outputs/{relative}"


def clean_dialogue_text(value: object) -> str:
  return re.sub(r"\s+", " ", str(value or "")).strip()


def subtitle_text(line: dict) -> str:
  return clean_dialogue_text(line.get("text") or line.get("subtitle") or line.get("dialogue"))


def subtitle_speaker(line: dict) -> str:
  return clean_dialogue_text(line.get("speaker"))


def subtitle_start(line: dict, index: int) -> float:
  value = line.get("startSeconds", line.get("start_seconds"))
  try:
    return max(float(value), 0.0)
  except (TypeError, ValueError):
    return float(index * 4)


def subtitle_end(line: dict, index: int, duration: float) -> float:
  start = subtitle_start(line, index)
  value = line.get("endSeconds", line.get("end_seconds"))
  try:
    end = float(value)
  except (TypeError, ValueError):
    end = start + 4.0
  return min(max(end, start + 0.001), duration)


def normalize_subtitles(lines: object, duration: float) -> list[dict]:
  if not isinstance(lines, list):
    return []

  normalized: list[dict] = []
  for index, raw_line in enumerate(lines):
    if not isinstance(raw_line, dict):
      continue
    text = subtitle_text(raw_line)
    if not text:
      continue
    start = subtitle_start(raw_line, index)
    end = subtitle_end(raw_line, index, duration)
    # Audio timing is recomputed from all synthesized lines; never drop speech.
    start = min(start, max(0, duration - 0.01))
    end = max(start + 0.001, min(end, duration))
    normalized.append(
      {
        "start": start,
        "end": end,
        "speaker": subtitle_speaker(raw_line),
        "text": text,
      }
    )
  return normalized


def srt_time(seconds: float) -> str:
  total_ms = max(int(round(seconds * 1000)), 0)
  hours, remainder = divmod(total_ms, 3_600_000)
  minutes, remainder = divmod(remainder, 60_000)
  secs, millis = divmod(remainder, 1000)
  return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def write_srt(lines: list[dict], path: Path) -> None:
  blocks = []
  for index, line in enumerate(lines, start=1):
    speaker = f"{line['speaker']}: " if line.get("speaker") else ""
    text = f"{speaker}{line['text']}"
    blocks.append(f"{index}\n{srt_time(line['start'])} --> {srt_time(line['end'])}\n{text}\n")
  path.write_text("\n".join(blocks), encoding="utf-8")


def ffmpeg_filter_path(path: Path) -> str:
  return str(path).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def signal_subprocess_group(proc, sig) -> bool:
  return signal_group(proc, sig)


def communicate_with_cancellation(proc, job_id, poll_seconds=0.25, grace_seconds=2, timeout_seconds=None):
  stage_deadline = time.monotonic() + (timeout_seconds if timeout_seconds is not None else float_env("LTX_STAGE_TIMEOUT_SECONDS", 300))
  try:
    while True:
      check_job_cancellation(job_id)
      if time.monotonic() >= stage_deadline:
        raise ServiceError(504, "Generation stage timed out.")
      try:
        return proc.communicate(timeout=min(poll_seconds, remaining(stage_deadline)))
      except subprocess.TimeoutExpired:
        continue
  except BaseException:
    terminate_group(proc, grace_seconds)
    raise

def run_ffmpeg(cmd: list[str], job_id: str | None = None) -> None:
  check_job_cancellation(job_id)

  proc = subprocess.Popen(
    cmd,
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    start_new_session=True,
  )

  try:
    if job_id:
      with JOB_LOCK:
        job = ACTIVE_JOBS.get(job_id)
        if job is None or job.get("canceled"):
          try:
            signal_subprocess_group(proc, signal.SIGTERM)
          except ProcessLookupError:
            pass
        else:
          job["audio_process"] = proc

    stdout, stderr = communicate_with_cancellation(proc, job_id)
  finally:
    if job_id:
      with JOB_LOCK:
        job = ACTIVE_JOBS.get(job_id)
        if job is not None and job.get("audio_process") is proc:
          job["audio_process"] = None

  check_job_cancellation(job_id)

  if proc.returncode != 0:
    raise RuntimeError(
      json.dumps(
        {
          "cmd": cmd,
          "returncode": proc.returncode,
          "stdout": stdout[-3000:],
          "stderr": stderr[-5000:],
        }
      )
    )


def write_silence_audio(path: Path, duration: float, job_id: str | None = None) -> None:
  run_ffmpeg(
    [
      "ffmpeg",
      "-y",
      "-f",
      "lavfi",
      "-t",
      f"{duration:.3f}",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      str(path),
    ],
    job_id=job_id,
  )


def csv_env(name: str, fallback: str) -> list[str]:
  return [
    item.strip()
    for item in ENV.get(name, fallback).split(",")
    if item.strip()
  ]


def flite_voice_names() -> list[str]:
  return csv_env("LTX_TTS_VOICES", ENV.get("LTX_TTS_VOICE", "slt,kal")) or ["slt"]


def kokoro_voice_names() -> list[str]:
  return csv_env("LTX_KOKORO_VOICES", ENV.get("LTX_KOKORO_VOICE", "af_heart,am_adam")) or ["af_heart"]


def synthesize_flite_line_files(lines: list[dict], work_dir: Path, job_id: str | None = None) -> tuple[list[Path], dict]:
  voice_names = flite_voice_names()
  line_files: list[Path] = []
  line_voices = speaker_voices(lines, voice_names)

  for index, line in enumerate(lines):
    text_file = work_dir / f"tts-line-{index + 1:02}.txt"
    wav_file = work_dir / f"tts-line-{index + 1:02}.wav"
    text_file.write_text(line["text"], encoding="utf-8")
    voice = line_voices[index]
    run_ffmpeg(
      [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"flite=textfile={ffmpeg_filter_path(text_file)}:voice={voice}",
        "-ar",
        "44100",
        "-ac",
        "2",
        str(wav_file),
      ],
      job_id=job_id,
    )
    line_files.append(wav_file)

  return line_files, {"mode": "flite", "lineCount": len(lines), "voices": voice_names}


def get_kokoro_pipeline():
  global KOKORO_PIPELINE, KOKORO_PIPELINE_LANG

  lang_code = ENV.get("LTX_KOKORO_LANG_CODE", "a").strip() or "a"
  with KOKORO_LOCK:
    if KOKORO_PIPELINE is None or KOKORO_PIPELINE_LANG != lang_code:
      from kokoro import KPipeline

      KOKORO_PIPELINE = KPipeline(lang_code=lang_code, device=ENV.get("LTX_KOKORO_DEVICE", "cpu"))
      KOKORO_PIPELINE_LANG = lang_code
    return KOKORO_PIPELINE, lang_code


def synthesize_kokoro_line_files(lines: list[dict], work_dir: Path, job_id: str | None = None) -> tuple[list[Path], dict]:
  # Subprocess isolation gives all configurations enforceable deadlines/cancellation.
  python_path = ENV.get("LTX_KOKORO_PYTHON", "").strip() or sys.executable
  return synthesize_kokoro_line_files_external(lines, work_dir, python_path, job_id)


def synthesize_kokoro_line_files_external(lines: list[dict], work_dir: Path, python_path: str, job_id: str | None = None) -> tuple[list[Path], dict]:
  voice_names = kokoro_voice_names()
  lang_code = ENV.get("LTX_KOKORO_LANG_CODE", "a").strip() or "a"
  device = ENV.get("LTX_KOKORO_DEVICE", "cpu").strip() or "cpu"
  speed = float_env("LTX_KOKORO_SPEED", 1.0)
  sample_rate = int_env("LTX_KOKORO_SAMPLE_RATE", 24000)
  line_files = [work_dir / f"tts-line-{index + 1:02}.wav" for index in range(len(lines))]
  job_path = work_dir / "kokoro-tts-job.json"
  line_voices = speaker_voices(lines, voice_names)
  job = {
    "lines": [
      {
        "text": line["text"],
        "outputPath": str(line_files[index]),
        "voice": line_voices[index],
      }
      for index, line in enumerate(lines)
    ],
    "voices": voice_names,
    "langCode": lang_code,
    "device": device,
    "speed": speed,
    "sampleRate": sample_rate,
  }
  job_path.write_text(json.dumps(job, indent=2), encoding="utf-8")

  proc = subprocess.Popen(
    [python_path, str(SCRIPT_DIR / "kokoro_tts_worker.py"), str(job_path)],
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    start_new_session=True,
  )
  try:
    if job_id:
      with JOB_LOCK:
        job_record = ACTIVE_JOBS.get(job_id)
        if job_record is None or job_record.get("canceled"):
          try:
            signal_subprocess_group(proc, signal.SIGTERM)
          except ProcessLookupError:
            pass
        else:
          job_record["audio_process"] = proc

    stdout, stderr = communicate_with_cancellation(proc, job_id)
  finally:
    if job_id:
      with JOB_LOCK:
        job_record = ACTIVE_JOBS.get(job_id)
        if job_record is not None and job_record.get("audio_process") is proc:
          job_record["audio_process"] = None

  check_job_cancellation(job_id)

  if proc.returncode != 0:
    raise RuntimeError(
      json.dumps(
        {
          "cmd": [python_path, str(SCRIPT_DIR / "kokoro_tts_worker.py"), str(job_path)],
          "returncode": proc.returncode,
          "stdout": stdout[-3000:],
          "stderr": stderr[-5000:],
        }
      )
    )

  missing = [str(path) for path in line_files if not path.exists()]
  if missing:
    raise RuntimeError(f"Kokoro external worker did not create files: {missing}")

  return line_files, {
    "mode": "kokoro",
    "runtime": "external",
    "python": python_path,
    "lineCount": len(lines),
    "voices": voice_names,
    "langCode": lang_code,
    "device": device,
    "speed": speed,
    "sampleRate": sample_rate,
  }


def mix_line_files(lines: list[dict], line_files: list[Path], path: Path, duration: float, job_id: str | None = None) -> dict:
  if not line_files:
    write_silence_audio(path, duration, job_id)
    return {"subtitleLines": [], "playbackRate": 1.0}
  if len(lines) != len(line_files):
    raise ServiceError(422, "Speech and subtitle counts differ.")
  lengths = []
  for wav_file in line_files:
    with wave.open(str(wav_file), "rb") as wav:
      lengths.append(wav.getnframes() / wav.getframerate())
  gap = float_env("LTX_DIALOGUE_GAP_SECONDS", 0.08)
  available = duration - gap * max(0, len(lines) - 1)
  rate = max(1.0, sum(lengths) / max(available, 0.001))
  if rate > float_env("LTX_MAX_TTS_SPEEDUP", 1.25):
    raise ServiceError(422, "Dialogue is too long for this video; shorten the script or increase duration.")
  cursor = 0.0
  for line, length in zip(lines, lengths):
    line["start"] = cursor
    line["end"] = min(duration, cursor + length / rate)
    cursor = line["end"] + gap
  cmd = ["ffmpeg", "-nostdin", "-y", "-f", "lavfi", "-t", f"{duration:.6f}", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
  for wav_file in line_files:
    cmd.extend(["-i", str(wav_file)])
  filters = []
  mix_inputs = ["[0:a]"]
  for index, line in enumerate(lines):
    delay_ms = max(int(round(line["start"] * 1000)), 0)
    filters.append(f"[{index + 1}:a]atempo={rate:.8f},adelay={delay_ms}|{delay_ms}[a{index}]")
    mix_inputs.append(f"[a{index}]")
  volume = float_env("LTX_TTS_VOLUME", 1.0)
  filters.append(f"{''.join(mix_inputs)}amix=inputs={len(mix_inputs)}:duration=first:normalize=0,volume={volume},alimiter=limit=0.95:level=false[aout]")
  cmd.extend(["-filter_complex", ";".join(filters), "-map", "[aout]", "-t", f"{duration:.6f}", "-c:a", "aac", "-b:a", "128k", str(path)])
  run_ffmpeg(cmd, job_id=job_id)
  return {"playbackRate": rate, "subtitleLines": [{"startSeconds": line["start"], "endSeconds": line["end"], "speaker": line.get("speaker", ""), "text": line["text"]} for line in lines]}


def synthesize_dialogue_audio(lines: list[dict], path: Path, duration: float, work_dir: Path, job_id: str | None = None) -> dict:
  if not bool_env("LTX_TTS_DIALOGUE_AUDIO", True):
    write_silence_audio(path, duration, job_id)
    return {"mode": "silence", "reason": "LTX_TTS_DIALOGUE_AUDIO=false"}

  if not lines:
    write_silence_audio(path, duration, job_id)
    return {"mode": "silence", "reason": "no subtitle lines"}

  if shutil.which("ffmpeg") is None:
    raise RuntimeError("ffmpeg is required for dialogue audio post-processing.")

  provider = ENV.get("LTX_TTS_PROVIDER", "flite").strip().lower() or "flite"
  fallback_provider = ENV.get("LTX_TTS_FALLBACK_PROVIDER", "flite").strip().lower()
  providers = [provider]
  if fallback_provider and fallback_provider not in providers:
    providers.append(fallback_provider)

  errors: list[str] = []
  for candidate in providers:
    check_job_cancellation(job_id)
    try:
      if candidate == "kokoro":
        line_files, metadata = synthesize_kokoro_line_files(lines, work_dir, job_id)
      elif candidate == "flite":
        line_files, metadata = synthesize_flite_line_files(lines, work_dir, job_id)
      else:
        raise RuntimeError(f"Unsupported TTS provider: {candidate}")

      metadata.update(mix_line_files(lines, line_files, path, duration, job_id))
      metadata["degraded"] = candidate != provider
      if candidate != provider:
        metadata["fallbackFrom"] = provider
      return metadata
    except (VideoGenerationCanceled, ServiceError):
      raise
    except Exception as exc:
      check_job_cancellation(job_id)
      errors.append(f"{candidate}: {exc}")

  if bool_env("LTX_TTS_FALLBACK_TO_SILENCE", True):
    write_silence_audio(path, duration, job_id)
    return {"mode": "silence", "degraded": True, "reason": "Speech synthesis failed.", "errors": errors}

  raise RuntimeError(f"TTS failed: {' | '.join(errors)}")


def burn_subtitles_and_replace_audio(input_file: Path, output_file: Path, srt_file: Path, audio_file: Path, duration: float, job_id: str | None = None) -> None:
  subtitle_style = ENV.get(
    "LTX_SUBTITLE_STYLE",
    "FontName=DejaVu Sans,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H20000000,BorderStyle=3,Outline=1,Shadow=0,MarginV=30,Alignment=2",
  )
  vf = f"subtitles='{ffmpeg_filter_path(srt_file)}':force_style='{subtitle_style}'"
  run_ffmpeg(
    [
      "ffmpeg",
      "-y",
      "-i",
      str(input_file),
      "-i",
      str(audio_file),
      "-vf",
      vf,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-t",
      f"{duration:.3f}",
      "-c:v",
      "libx264",
      "-preset",
      ENV.get("LTX_POSTPROCESS_PRESET", "veryfast"),
      "-crf",
      ENV.get("LTX_POSTPROCESS_CRF", "20"),
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      str(output_file),
    ],
    job_id=job_id,
  )


def replace_audio_only(input_file: Path, output_file: Path, audio_file: Path, duration: float, job_id: str | None = None) -> None:
  run_ffmpeg(
    [
      "ffmpeg",
      "-y",
      "-i",
      str(input_file),
      "-i",
      str(audio_file),
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-t",
      f"{duration:.3f}",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      str(output_file),
    ],
    job_id=job_id,
  )


def start_parallel_audio(payload: dict) -> None:
  if not bool_env("LTX_PARALLEL_TTS", True):
    return
  if not bool_env("LTX_REPLACE_MODEL_AUDIO", True):
    return

  subtitles = normalize_subtitles(
    payload["script_payload"]["videos"][0].get("subtitle_lines"),
    payload["duration"],
  )
  audio_file = payload["request_dir"] / "dialogue-prefetch.m4a"
  started_at = time.perf_counter()
  future = get_audio_executor().submit(
    synthesize_dialogue_audio,
    subtitles,
    audio_file,
    payload["duration"],
    payload["request_dir"],
    payload.get("job_id"),
  )
  payload["parallel_audio"] = {
    "future": future,
    "audio_file": audio_file,
    "started_at": started_at,
    "subtitle_count": len(subtitles),
  }

  job_id = payload.get("job_id")
  if job_id:
    with JOB_LOCK:
      job = ACTIVE_JOBS.get(job_id)
      if job is not None:
        job["audio_future"] = future


def cancel_parallel_audio(payload: dict) -> None:
  job_id = payload.get("job_id")
  future = payload.get("parallel_audio", {}).get("future")

  if job_id:
    with JOB_LOCK:
      job = ACTIVE_JOBS.get(job_id)
      if job is not None:
        job["canceled"] = True
        proc = job.get("audio_process")
        if proc is not None and proc.poll() is None:
          try:
            signal_subprocess_group(proc, signal.SIGTERM)
          except ProcessLookupError:
            pass

  if future:
    future.cancel()


def resolve_parallel_audio(payload: dict) -> tuple[Path | None, dict | None]:
  job = payload.get("parallel_audio")
  if not job:
    return None, None

  future = job.get("future")
  audio_file = job.get("audio_file")
  if not future or not audio_file:
    return None, None

  wait_started = time.perf_counter()
  while True:
    check_job_cancellation(payload.get("job_id"))
    try:
      metadata = future.result(timeout=0.1)
      break
    except concurrent.futures.TimeoutError:
      continue
  metadata = {
    **metadata,
    "parallel": True,
    "waitSeconds": round(time.perf_counter() - wait_started, 3),
    "elapsedSinceStartSeconds": round(time.perf_counter() - job.get("started_at", wait_started), 3),
  }
  return audio_file, metadata


def postprocess_video(output_file: Path, payload: dict) -> tuple[Path, dict]:
  subtitles = normalize_subtitles(
    payload["script_payload"]["videos"][0].get("subtitle_lines"),
    payload["duration"],
  )
  burn_subtitles = bool_env("LTX_BURN_SUBTITLES", True) and bool(subtitles)
  replace_audio = bool_env("LTX_REPLACE_MODEL_AUDIO", True)

  if not burn_subtitles and not replace_audio:
    return output_file, {"enabled": False}

  final_file = output_file.with_name(f"{output_file.stem}-final.mp4")
  srt_file = payload["request_dir"] / f"{output_file.stem}.srt"
  audio_file = payload["request_dir"] / f"{output_file.stem}-dialogue.m4a"
  metadata: dict = {
    "enabled": True,
    "originalOutputFile": str(output_file),
    "finalOutputFile": str(final_file),
    "embeddedSubtitles": burn_subtitles,
    "dialogueAudio": replace_audio,
    "subtitleLineCount": len(subtitles),
  }

  if replace_audio:
    parallel_audio_file, parallel_audio_meta = resolve_parallel_audio(payload)
    if parallel_audio_file and parallel_audio_meta:
      audio_file = parallel_audio_file
      metadata["audio"] = parallel_audio_meta
    else:
      audio_started = time.perf_counter()
      metadata["audio"] = {
        **synthesize_dialogue_audio(subtitles, audio_file, payload["duration"], payload["request_dir"], payload.get("job_id")),
        "parallel": False,
        "elapsedSinceStartSeconds": round(time.perf_counter() - audio_started, 3),
      }
    metadata["audioFile"] = str(audio_file)
  else:
    audio_file = output_file

  if replace_audio and metadata.get("audio", {}).get("subtitleLines"):
    subtitles = normalize_subtitles(metadata["audio"]["subtitleLines"], payload["duration"])
  metadata["subtitleLines"] = [{"startSeconds": line["start"], "endSeconds": line["end"], "speaker": line.get("speaker", ""), "text": line["text"]} for line in subtitles]
  metadata["degraded"] = bool(metadata.get("audio", {}).get("degraded"))
  metadata["dialogueAudio"] = replace_audio and metadata.get("audio", {}).get("mode") != "silence"
  if burn_subtitles:
    write_srt(subtitles, srt_file)
    metadata["subtitleFile"] = str(srt_file)
    burn_subtitles_and_replace_audio(output_file, final_file, srt_file, audio_file, payload["duration"], job_id=payload.get("job_id"))
  elif replace_audio:
    replace_audio_only(output_file, final_file, audio_file, payload["duration"], job_id=payload.get("job_id"))

  return final_file, metadata


def build_request_payload(body: dict) -> dict:
  if not isinstance(body, dict):
    raise ServiceError(422, "Request must be an object.")
  prompt = body.get("prompt")
  if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= int_env("LTX_MAX_PROMPT_CHARS", 20000):
    raise ServiceError(422, "prompt must contain 1–20000 characters.")
  prompt = prompt.strip()
  metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
  job_id = body.get("jobId", uuid4().hex)
  if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", job_id):
    raise ServiceError(422, "jobId must contain 1–128 safe identifier characters.")
  category_id = str(metadata.get("categoryId") or body.get("category_id") or "video")[:200]
  title = str(metadata.get("categoryTitle") or body.get("title") or category_id)[:500]
  duration = finite_number(body.get("duration_seconds", ENV.get("LTX_DURATION_SECONDS", 30)), "duration_seconds", 1, float_env("LTX_MAX_DURATION_SECONDS", 60))
  frame_rate = finite_number(body.get("frame_rate", ENV.get("LTX_FRAME_RATE", 16)), "frame_rate", 1, 60)
  num_frames = 8 * max(1, round(duration * frame_rate / 8)) + 1
  if num_frames > int_env("LTX_MAX_FRAMES", 961):
    raise ServiceError(422, "Requested video exceeds the frame budget.")
  duration = num_frames / frame_rate
  subtitles = body.get("subtitles", [])
  if not isinstance(subtitles, list) or len(subtitles) > 64:
    raise ServiceError(422, "subtitles must contain at most 64 lines.")
  for line in subtitles:
    if not isinstance(line, dict) or not isinstance(line.get("text", line.get("subtitle", line.get("dialogue", ""))), str) or len(str(line.get("text", line.get("subtitle", line.get("dialogue", ""))))) > 2000:
      raise ServiceError(422, "Invalid subtitle line.")
    for key in ("startSeconds", "start_seconds", "endSeconds", "end_seconds"):
      if key in line:
        finite_number(line[key], key, 0, 120)
  # UUID is independent of user IDs and category labels; never reuse an input directory.
  request_dir = REQUEST_ROOT / uuid4().hex
  request_dir.mkdir(parents=True, exist_ok=False)
  return {"job_id": job_id, "prompt": prompt, "metadata": metadata, "category_id": category_id,
    "title": title, "duration": duration, "requested_duration": float(body.get("duration_seconds", ENV.get("LTX_DURATION_SECONDS", 30))),
    "frame_rate": frame_rate, "num_frames": num_frames, "request_dir": request_dir,
    "script_payload": {"videos": [{"category_id": category_id, "title": title, "duration_seconds": duration,
      "model_prompt": prompt, "negative_prompt": str(body.get("negative_prompt") or ENV.get("LTX_NEGATIVE_PROMPT", ""))[:20000],
      "shot_plan": body.get("shot_plan") or [], "subtitle_lines": subtitles}]}}


class ResidentLTXRunner:
  def __init__(self) -> None:
    os.environ["CUDA_VISIBLE_DEVICES"] = ENV.get("GPU", "1")
    os.environ.setdefault("HF_HOME", ENV.get("HF_HOME", "/media/main/Data/Abhijeet/huggingface"))
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    os.environ.setdefault("PYTORCH_ALLOC_CONF", "expandable_segments:True")

    repo = Path(ENV.get("LTX_REPO", SCRIPT_DIR / "repo/LTX-2")).resolve()
    if str(repo) not in sys.path:
      sys.path.insert(0, str(repo))

    import torch
    from ltx_core.components.guiders import MultiModalGuiderParams
    from ltx_core.loader import LTXV_LORA_COMFY_RENAMING_MAP, LoraPathStrengthAndSDOps
    from ltx_core.model.video_vae import TilingConfig, get_video_chunks_number
    from ltx_pipelines import distilled as distilled_module
    from ltx_pipelines import ti2vid_two_stages as full_module
    from ltx_pipelines.utils.constants import LTX_2_3_PARAMS
    from ltx_pipelines.utils.media_io import encode_video
    from ltx_pipelines.utils.types import OffloadMode

    torch.set_grad_enabled(False)
    self.modules = {
      "MultiModalGuiderParams": MultiModalGuiderParams,
      "LTXV_LORA_COMFY_RENAMING_MAP": LTXV_LORA_COMFY_RENAMING_MAP,
      "LoraPathStrengthAndSDOps": LoraPathStrengthAndSDOps,
      "TilingConfig": TilingConfig,
      "get_video_chunks_number": get_video_chunks_number,
      "distilled_module": distilled_module,
      "full_module": full_module,
      "LTX_2_3_PARAMS": LTX_2_3_PARAMS,
      "encode_video": encode_video,
      "OffloadMode": OffloadMode,
    }
    self.model_kind = ENV.get("LTX_MODEL_KIND", "distilled")
    self.offload = ENV.get("LTX_OFFLOAD", "none")
    self.pipeline = self._load_pipeline()
    if not bool_env("LTX_USE_MODEL_AUDIO", False):
      # Audio latents still condition video; only the unused final decode is skipped.
      self.pipeline.audio_decoder = lambda latent: None
    self.current_job_id = None
    for name in ("stage", "stage_1", "stage_2"):
      stage = getattr(self.pipeline, name, None)
      if stage is not None:
        self._guard_stage(stage)

  def _guard_stage(self, stage):
    original = stage.run
    def guarded(*args, **kwargs):
      check_job_cancellation(self.current_job_id)
      args = list(args)
      denoiser = kwargs.get("denoiser") if "denoiser" in kwargs else args[1]
      def checked_denoiser(*values, **options):
        check_job_cancellation(self.current_job_id)
        result = denoiser(*values, **options)
        check_job_cancellation(self.current_job_id)
        return result
      if "denoiser" in kwargs:
        kwargs["denoiser"] = checked_denoiser
      else:
        args[1] = checked_denoiser
      return original(*args, **kwargs)
    stage.run = guarded

  def _load_pipeline(self):
    modules = self.modules
    checkpoint_dir = Path(ENV.get("LTX_MODEL_DIR", SCRIPT_DIR / "models/LTX-2.3"))
    distilled_checkpoint = Path(
      ENV.get("LTX_DISTILLED_CHECKPOINT", checkpoint_dir / "ltx-2.3-22b-distilled-1.1.safetensors")
    )
    full_checkpoint = Path(ENV.get("LTX_DEV_CHECKPOINT", checkpoint_dir / "ltx-2.3-22b-dev.safetensors"))
    upsampler = Path(ENV.get("LTX_SPATIAL_UPSAMPLER", checkpoint_dir / "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"))
    gemma_root = Path(ENV.get("LTX_GEMMA_ROOT", SCRIPT_DIR / "models/gemma-3-12b-it-qat-q4_0-unquantized"))
    offload_mode = modules["OffloadMode"](self.offload)

    if self.model_kind == "distilled":
      return modules["distilled_module"].DistilledPipeline(
        distilled_checkpoint_path=str(distilled_checkpoint),
        spatial_upsampler_path=str(upsampler),
        gemma_root=str(gemma_root),
        loras=(),
        offload_mode=offload_mode,
      )

    distilled_lora_path = Path(
      ENV.get("LTX_DISTILLED_LORA", checkpoint_dir / "ltx-2.3-22b-distilled-lora-384-1.1.safetensors")
    )
    distilled_lora = [
      modules["LoraPathStrengthAndSDOps"](
        str(distilled_lora_path),
        float_env("LTX_DISTILLED_LORA_STRENGTH", 0.8),
        modules["LTXV_LORA_COMFY_RENAMING_MAP"],
      )
    ]
    return modules["full_module"].TI2VidTwoStagesPipeline(
      checkpoint_path=str(full_checkpoint),
      distilled_lora=distilled_lora,
      spatial_upsampler_path=str(upsampler),
      gemma_root=str(gemma_root),
      loras=(),
      offload_mode=offload_mode,
    )

  def generate(self, payload: dict, script_path: Path) -> dict:
    import torch
    self.current_job_id = payload["job_id"]
    with torch.inference_mode():
      return self._generate(payload, script_path)

  def _generate(self, payload: dict, script_path: Path) -> dict:
    check_job_cancellation(payload["job_id"])
    modules = self.modules
    video = payload["script_payload"]["videos"][0]
    output_file = payload["request_dir"] / f"{slugify(payload['category_id'])}-{self.model_kind}.mp4"
    metrics_path = payload["request_dir"] / "metrics.json"
    results_path = payload["request_dir"] / "results.json"
    tiling_config = modules["TilingConfig"].default()
    chunks = modules["get_video_chunks_number"](payload["num_frames"], tiling_config)
    started = time.perf_counter()

    if self.model_kind == "distilled":
      from timed_ltx23_experiment import generate_distilled_text_video
      generated_video, generated_audio = generate_distilled_text_video(
        self.pipeline, self.offload,
        prompt=payload["prompt"],
        seed=int_env("LTX_SEED", 42),
        height=int_env("LTX_HEIGHT", 512),
        width=int_env("LTX_WIDTH", 768),
        num_frames=payload["num_frames"],
        frame_rate=payload["frame_rate"],
        tiling_config=tiling_config,
        enhance_prompt=bool_env("LTX_ENHANCE_PROMPT", False),
      )
    else:
      params = modules["LTX_2_3_PARAMS"]
      guider = modules["MultiModalGuiderParams"]
      generated_video, generated_audio = self.pipeline(
        prompt=payload["prompt"],
        negative_prompt=video.get("negative_prompt") or ENV.get(
          "LTX_NEGATIVE_PROMPT",
          "distorted faces, distorted hands, extra fingers, extra arms, duplicate people, readable text, gibberish subtitles, watermark, logo, blur",
        ),
        seed=int_env("LTX_SEED", 42),
        height=int_env("LTX_HEIGHT", 512),
        width=int_env("LTX_WIDTH", 768),
        num_frames=payload["num_frames"],
        frame_rate=payload["frame_rate"],
        num_inference_steps=int_env("LTX_NUM_INFERENCE_STEPS", 30),
        video_guider_params=guider(
          cfg_scale=float_env("LTX_VIDEO_CFG_GUIDANCE_SCALE", params.video_guider_params.cfg_scale),
          stg_scale=float_env("LTX_VIDEO_STG_GUIDANCE_SCALE", params.video_guider_params.stg_scale),
          rescale_scale=float_env("LTX_VIDEO_RESCALE_SCALE", params.video_guider_params.rescale_scale),
          modality_scale=float_env("LTX_A2V_GUIDANCE_SCALE", params.video_guider_params.modality_scale),
          skip_step=int_env("LTX_VIDEO_SKIP_STEP", params.video_guider_params.skip_step),
          stg_blocks=params.video_guider_params.stg_blocks,
        ),
        audio_guider_params=guider(
          cfg_scale=float_env("LTX_AUDIO_CFG_GUIDANCE_SCALE", params.audio_guider_params.cfg_scale),
          stg_scale=float_env("LTX_AUDIO_STG_GUIDANCE_SCALE", params.audio_guider_params.stg_scale),
          rescale_scale=float_env("LTX_AUDIO_RESCALE_SCALE", params.audio_guider_params.rescale_scale),
          modality_scale=float_env("LTX_V2A_GUIDANCE_SCALE", params.audio_guider_params.modality_scale),
          skip_step=int_env("LTX_AUDIO_SKIP_STEP", params.audio_guider_params.skip_step),
          stg_blocks=params.audio_guider_params.stg_blocks,
        ),
        images=[],
        tiling_config=tiling_config,
        max_batch_size=int_env("LTX_MAX_BATCH_SIZE", 1),
      )

    check_job_cancellation(payload["job_id"])
    encode_started = time.perf_counter()
    def checked_frames():
      for chunk in generated_video:
        check_job_cancellation(payload["job_id"])
        yield chunk
    modules["encode_video"](
      video=checked_frames(),
      fps=payload["frame_rate"],
      audio=generated_audio if bool_env("LTX_USE_MODEL_AUDIO", False) else None,
      output_path=str(output_file),
      video_chunks_number=chunks,
    )
    check_job_cancellation(payload["job_id"])
    final_file, postprocess = postprocess_video(output_file, payload)
    check_job_cancellation(payload["job_id"])
    elapsed = round(time.perf_counter() - started, 3)
    metrics = {
      "model_kind": self.model_kind,
      "resident_pipeline": True,
      "wall_seconds": elapsed,
      "encode_video_seconds": round(time.perf_counter() - encode_started, 3),
      "output_path": str(final_file),
      "raw_output_path": str(output_file),
      "postprocess": postprocess,
      "script_path": str(script_path),
    }
    metrics_path.write_text(json.dumps(metrics, indent=2))
    result = {
      "title": payload["title"],
      "category_id": payload["category_id"],
      "returncode": 0,
      "output_file": str(final_file),
      "raw_output_file": str(output_file),
      "metrics_file": str(metrics_path),
      "parent_wall_seconds": elapsed,
      "timings": metrics,
    }
    results_path.write_text(json.dumps({"results": [result]}, indent=2))
    return build_response(final_file, results_path, payload["duration"], elapsed, result, postprocess, payload["job_id"])


def resident_enabled() -> bool:
  return bool_env("LTX_RESIDENT_PIPELINE", True)


def get_resident_runner() -> ResidentLTXRunner:
  global RESIDENT_LOAD_ERROR, RESIDENT_RUNNER
  if RESIDENT_RUNNER is not None:
    return RESIDENT_RUNNER
  try:
    RESIDENT_RUNNER = ResidentLTXRunner()
    RESIDENT_LOAD_ERROR = None
  except Exception as exc:
    RESIDENT_LOAD_ERROR = str(exc)
    raise
  return RESIDENT_RUNNER


def build_response(output_file: Path, results_path: Path, duration: float, elapsed: float, metrics: dict, postprocess: dict | None = None, job_id: str | None = None) -> dict:
  postprocess = postprocess or {}
  return {
    "status": "completed",
    "videoUrl": public_url_for(output_file),
    "video_url": public_url_for(output_file),
    "jobId": job_id,
    "degraded": bool(postprocess.get("degraded")),
    "subtitleLines": postprocess.get("subtitleLines", []),
    "duration_seconds": duration,
    "elapsed_seconds": elapsed,
    "outputFile": str(output_file),
    "resultsFile": str(results_path),
    "embeddedSubtitles": bool(postprocess.get("embeddedSubtitles")),
    "dialogueAudio": bool(postprocess.get("dialogueAudio")),
    "postprocess": postprocess,
    "metrics": metrics,
  }


def run_generation(body: dict) -> dict:
  if not ADMISSION.acquire(blocking=False):
    raise ServiceError(503, "Video queue is full; retry later.")
  admitted_at = time.monotonic()
  deadline = admitted_at + float_env("LTX_REQUEST_TIMEOUT_SECONDS", 7200)
  payload = None
  registered = False
  success = False
  try:
    payload = build_request_payload(body)
    job_id = payload["job_id"]
    with JOB_LOCK:
      prune_pending_cancellations()
      if job_id in ACTIVE_JOBS:
        raise ServiceError(409, "Job ID already registered.")
      ACTIVE_JOBS[job_id] = {"canceled": job_id in PENDING_CANCELLATIONS,
        "process": None, "audio_process": None, "owner": threading.get_ident(),
        "deadline": deadline,
        "request_dir": payload["request_dir"]}
      PENDING_CANCELLATIONS.pop(job_id, None)
      registered = True
    result = _run_generation(payload)
    check_job_cancellation(job_id)
    success = True
    result["generation_elapsed_seconds"] = result.get("elapsed_seconds")
    result["elapsed_seconds"] = round(time.monotonic() - admitted_at, 3)
    result["frame_rate"] = payload["frame_rate"]
    result["num_frames"] = payload["num_frames"]
    return result
  finally:
    try:
      if payload is not None:
        if registered:
          if not success:
            cancel_parallel_audio(payload)
          cleanup_video_job(payload["job_id"])
        # Mark only after all owned workers have stopped; retention never touches active work.
        if not registered or payload["job_id"] not in ACTIVE_JOBS:
          (payload["request_dir"] / ".eulalens-complete").touch()
        prune_completed(REQUEST_ROOT, float_env("LTX_RETENTION_SECONDS", 604800), int_env("LTX_MAX_RETAINED_JOBS", 500))
    finally:
      ADMISSION.release()


def _run_generation(payload: dict) -> dict:
  job_id = payload["job_id"]
  check_job_cancellation(job_id)
  script_path = payload["request_dir"] / "video_scripts.json"
  script_payload = payload["script_payload"]
  script_path.write_text(json.dumps(script_payload, indent=2))
  start_parallel_audio(payload)

  if resident_enabled():
    try:
      with acquired_until(GENERATION_LOCK, lambda: check_job_cancellation(job_id)):
        return get_resident_runner().generate(payload, script_path)
    except Exception:
      cancel_parallel_audio(payload)
      raise

  cmd = [
    sys.executable,
    str(SCRIPT_DIR / "timed_ltx23_experiment.py"),
    "--scripts",
    str(script_path),
    "--output-root",
    str(payload["request_dir"]),
    "--count",
    "1",
    "--model",
    ENV.get("LTX_MODEL_KIND", "distilled"),
    "--height",
    str(int_env("LTX_HEIGHT", 512)),
    "--width",
    str(int_env("LTX_WIDTH", 768)),
    "--num-frames",
    str(payload["num_frames"]),
    "--frame-rate",
    str(payload["frame_rate"]),
    "--seed",
    str(int_env("LTX_SEED", 42)),
    "--gpu",
    ENV.get("GPU", "1"),
    "--offload",
    ENV.get("LTX_OFFLOAD", "none"),
    "--tag",
    "app",
  ]

  steps = ENV.get("LTX_NUM_INFERENCE_STEPS")
  if steps:
    cmd.extend(["--num-inference-steps", steps])

  video_proc = None
  try:
    with acquired_until(GENERATION_LOCK, lambda: check_job_cancellation(job_id)):
      check_job_cancellation(job_id)
      started = time.perf_counter()
      proc = subprocess.Popen(
        cmd,
        cwd=SCRIPT_DIR,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
      )
      video_proc = proc

      if job_id:
        with JOB_LOCK:
          job = ACTIVE_JOBS.get(job_id)
          if job is not None:
            job["process"] = proc
            if job.get("canceled") and proc.poll() is None:
              signal_subprocess_group(proc, signal.SIGTERM)

      stdout, stderr = communicate_with_cancellation(
        proc,
        job_id,
        timeout_seconds=remaining(ACTIVE_JOBS[job_id]["deadline"], float_env("LTX_REQUEST_TIMEOUT_SECONDS", 7200)),
      )

      elapsed = round(time.perf_counter() - started, 3)
      if job_id:
        with JOB_LOCK:
          job = ACTIVE_JOBS.get(job_id)
          if job is not None and job.get("process") is proc:
            job["process"] = None
      proc = subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
      check_job_cancellation(job_id)
  except Exception:
    if video_proc is not None:
      terminate_group(video_proc)
      with JOB_LOCK:
        job = ACTIVE_JOBS.get(job_id)
        if job is not None:
          job["process"] = None

    cancel_parallel_audio(payload)
    raise

  output_dir_text = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
  output_dir = Path(output_dir_text) if output_dir_text else None
  results_path = output_dir / "results.json" if output_dir else None

  if proc.returncode != 0 or not results_path or not results_path.exists():
    cancel_parallel_audio(payload)
    raise RuntimeError(
      json.dumps(
        {
          "returncode": proc.returncode,
          "stdout": proc.stdout[-5000:],
          "stderr": proc.stderr[-5000:],
        }
      )
    )

  try:
    results = json.loads(results_path.read_text())
    first = (results.get("results") or [{}])[0]
  except Exception:
    cancel_parallel_audio(payload)
    raise
  output_file = Path(first.get("output_file", ""))
  if not output_file.is_file():
    cancel_parallel_audio(payload)
    raise RuntimeError(f"LTX result did not produce a video file: {output_file}")

  if first.get("returncode") not in (0, None):
    cancel_parallel_audio(payload)
    log_path = Path(first.get("log_file", ""))
    raise RuntimeError(log_tail(log_path) or "LTX generation failed")

  try:
    check_job_cancellation(job_id)
    check_job_cancellation(payload["job_id"])
    final_file, postprocess = postprocess_video(output_file, payload)
    check_job_cancellation(payload["job_id"])
    check_job_cancellation(job_id)
  except Exception:
    cancel_parallel_audio(payload)
    raise
  first["raw_output_file"] = str(output_file)
  first["output_file"] = str(final_file)
  first["postprocess"] = postprocess
  results["results"][0] = first
  results_path.write_text(json.dumps(results, indent=2))

  return {
    **build_response(final_file, results_path, payload["duration"], elapsed, first, postprocess, payload["job_id"]),
  }



def cleanup_video_job(job_id: str) -> None:
  with JOB_LOCK:
    job = ACTIVE_JOBS.get(job_id)
    if job is None or job.get("owner") != threading.get_ident():
      return
    future = job.get("audio_future")
  if future is not None:
    try:
      future.result(timeout=float_env("LTX_STAGE_TIMEOUT_SECONDS", 300) + 5)
    except Exception:
      pass
  with JOB_LOCK:
    if ACTIVE_JOBS.get(job_id) is job:
      ACTIVE_JOBS.pop(job_id, None)


def readiness() -> dict:
  errors = []
  if not ENV.get("LTX_API_KEY", "").strip():
    errors.append("authentication_not_configured")
  if shutil.which("ffmpeg") is None:
    errors.append("ffmpeg_missing")
  repo = Path(ENV.get("LTX_REPO", SCRIPT_DIR / "repo/LTX-2"))
  runtime_python = Path(ENV.get("LTX_MODEL_PYTHON", str(repo / ".venv/bin/python")))
  if not runtime_python.is_file() or not os.access(runtime_python, os.X_OK):
    errors.append("model_runtime_missing")
  checkpoint = ENV.get("LTX_DISTILLED_CHECKPOINT" if ENV.get("LTX_MODEL_KIND", "distilled") == "distilled" else "LTX_DEV_CHECKPOINT", "")
  for name, configured in (("checkpoint", checkpoint), ("upsampler", ENV.get("LTX_SPATIAL_UPSAMPLER", "")), ("text_encoder", ENV.get("LTX_GEMMA_ROOT", ""))):
    if not configured or not Path(configured).exists():
      errors.append(f"{name}_missing")
  if RESIDENT_LOAD_ERROR:
    errors.append("model_load_failed")
  return {"ok": True, "ready": not errors, "issues": errors,
    "residentPipeline": resident_enabled(), "modelLoaded": RESIDENT_RUNNER is not None,
    "activeJobs": len(ACTIVE_JOBS), "audioWorkers": int_env("LTX_AUDIO_WORKERS", 1)}


class Handler(BaseHTTPRequestHandler):
  server_version = "LTXVideoServer/0.2"

  def setup(self):
    super().setup()
    self.connection.settimeout(15)

  def do_HEAD(self):
    self.do_GET(head=True)

  def do_GET(self, head=False):
    parsed = urlparse(self.path)
    try:
      if parsed.path == "/health":
        send_json(self, readiness())
        return
      if parsed.path.startswith("/outputs/"):
        authorize(self.headers.get("Authorization"), ENV.get("LTX_API_KEY", ""))
        target = checked_artifact(OUTPUT_ROOT, unquote(parsed.path.removeprefix("/outputs/")), {".mp4"})
        stream_artifact(self, target, head=head)
        return
      raise ServiceError(404, "Not found.")
    except ServiceError as exc:
      send_json(self, {"error": str(exc)}, exc.status)
    except (BrokenPipeError, ConnectionResetError):
      return

  def do_POST(self):
    path = urlparse(self.path).path
    try:
      if path not in {"/generate", "/cancel"}:
        raise ServiceError(404, "Not found.")
      authorize(self.headers.get("Authorization"), ENV.get("LTX_API_KEY", ""))
      body = read_request_json(self)
      if path == "/cancel":
        job_id = body.get("jobId")
        if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", job_id):
          raise ServiceError(422, "A valid jobId is required.")
        with JOB_LOCK:
          prune_pending_cancellations()
          job = ACTIVE_JOBS.get(job_id)
          if job is None:
            if len(PENDING_CANCELLATIONS) >= int_env("LTX_MAX_PENDING_CANCELLATIONS", 256):
              raise ServiceError(503, "Cancellation queue is full.")
            PENDING_CANCELLATIONS[job_id] = time.monotonic()
          else:
            job["canceled"] = True
            for key in ("process", "audio_process"):
              signal_subprocess_group(job.get(key), signal.SIGTERM)
        send_json(self, {"jobId": job_id, "status": "cancellation-requested"})
      else:
        send_json(self, run_generation(body))
    except VideoGenerationCanceled:
      send_json(self, {"error": "Generation canceled.", "status": "canceled"}, 409)
    except ServiceError as exc:
      send_json(self, {"error": str(exc)}, exc.status)
    except (BrokenPipeError, ConnectionResetError):
      return
    except Exception as exc:
      print(f"[ltx-video] request failed: {type(exc).__name__}", flush=True)
      send_json(self, {"error": "Video generation failed."}, 500)

  def log_message(self, fmt, *args):
    print(f"[ltx-video] {self.address_string()} - {fmt % args}")


class BoundedHTTPServer(ThreadingHTTPServer):
  daemon_threads = True
  def __init__(self, *args, **kwargs):
    super().__init__(*args, **kwargs)
    self._request_slots = threading.BoundedSemaphore(max(4, int_env("LTX_MAX_HTTP_REQUESTS", 24)))
  def process_request(self, request, address):
    if not self._request_slots.acquire(blocking=False):
      try:
        request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\nRetry-After: 5\r\n\r\n")
      finally:
        self.shutdown_request(request)
      return
    try:
      super().process_request(request, address)
    except BaseException:
      self._request_slots.release()
      raise
  def process_request_thread(self, request, address):
    try:
      super().process_request_thread(request, address)
    finally:
      self._request_slots.release()


def main() -> int:
  if not ENV.get("LTX_API_KEY", "").strip():
    raise SystemExit("Set LTX_API_KEY before starting the video service.")
  OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
  REQUEST_ROOT.mkdir(parents=True, exist_ok=True)
  print(f"Starting LTX video service on http://{HOST}:{PORT}")
  print(f"GPU: {ENV.get('GPU', '1')}")
  print(f"Output root: {OUTPUT_ROOT}")
  if resident_enabled() and bool_env("LTX_PRELOAD_ON_STARTUP", True):
    print("Loading resident LTX pipeline before accepting requests...")
    started = time.perf_counter()
    get_resident_runner()
    print(f"Resident LTX pipeline loaded in {time.perf_counter() - started:.1f}s")
  elif resident_enabled():
    print("Resident LTX pipeline enabled; model will load on first request.")
  else:
    print("Resident LTX pipeline disabled; each request will use a child generation process.")
  BoundedHTTPServer((HOST, PORT), Handler).serve_forever()
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
