#!/usr/bin/env python3
"""Generate Kokoro TTS line WAV files from a JSON job.

This is intentionally separate from ltx_video_server.py so Kokoro can live in
its own Python environment while the LTX server keeps using its existing env.
"""

from __future__ import annotations

import io
import json
import struct
import sys
from contextlib import redirect_stdout
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro import KPipeline


def synthesize_line(pipeline, text: str, voice: str, speed: float = 1.0) -> np.ndarray:
  """Synthesize a complete line, including every chunk produced by Kokoro."""
  segments = []
  for _graphemes, _phonemes, audio in pipeline(text, voice=voice, speed=speed):
    if hasattr(audio, "detach"):
      audio = audio.detach().cpu().numpy()
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    if samples.size:
      segments.append(samples)
  if not segments:
    raise RuntimeError("Kokoro returned no audio for the requested line.")
  return np.concatenate(segments)


def serve_comic_narration() -> int:
  """Read JSON-encoded scene text; return a four-byte length and MP3 bytes."""
  from spacy.util import is_package

  # Misaki otherwise asks pip to download the tokenizer during the first request.
  if not is_package("en_core_web_sm"):
    raise RuntimeError("Install the en_core_web_sm package in the Kokoro environment.")
  output = sys.stdout.buffer
  with redirect_stdout(sys.stderr):
    pipeline = KPipeline(lang_code="a", device="cpu", repo_id="hexgrad/Kokoro-82M")
    for request in sys.stdin:
      try:
        text = json.loads(request)
        if not isinstance(text, str) or not text.strip() or len(text) > 4096:
          raise ValueError("Invalid scene text")
        audio = synthesize_line(pipeline, text, "af_heart")
        if not np.isfinite(audio).all() or np.max(np.abs(audio)) < 0.0001:
          raise ValueError("No audible narration")
        encoded = io.BytesIO()
        sf.write(encoded, audio, 24000, format="MP3", subtype="MPEG_LAYER_III")
        payload = encoded.getvalue()
      except Exception as error:
        # Keep the protocol framed and avoid logging private scene text.
        print(f"Comic narration failed ({type(error).__name__}).", file=sys.stderr)
        payload = b""
      output.write(struct.pack(">I", len(payload)))
      output.write(payload)
      output.flush()
  return 0


def main() -> int:
  if sys.argv[1:] == ["--comic-narration"]:
    return serve_comic_narration()
  if len(sys.argv) != 2:
    raise SystemExit("Usage: kokoro_tts_worker.py /path/to/job.json")

  job_path = Path(sys.argv[1])
  job = json.loads(job_path.read_text(encoding="utf-8"))
  lines = job.get("lines") or []
  voice_names = job.get("voices") or ["af_heart"]
  lang_code = job.get("langCode") or "a"
  device = job.get("device") or "cpu"
  speed = float(job.get("speed") or 1.0)
  sample_rate = int(job.get("sampleRate") or 24000)

  pipeline = KPipeline(lang_code=lang_code, device=device)
  output_files = []

  for index, line in enumerate(lines):
    text = str(line.get("text") or "").strip()
    if not text:
      continue

    output_path = Path(line["outputPath"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    voice = line.get("voice") or voice_names[0]
    sf.write(output_path, synthesize_line(pipeline, text, voice, speed), sample_rate)
    output_files.append(str(output_path))

  print(json.dumps({"ok": True, "outputFiles": output_files}))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
