#!/usr/bin/env python3
"""Generate Kokoro TTS line WAV files from a JSON job.

This is intentionally separate from ltx_video_server.py so Kokoro can live in
its own Python environment while the LTX server keeps using its existing env.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro import KPipeline


def main() -> int:
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
    segments = []

    for _graphemes, _phonemes, audio in pipeline(text, voice=voice, speed=speed):
      if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
      segments.append(np.asarray(audio, dtype=np.float32).reshape(-1))

    if not segments:
      raise RuntimeError(f"Kokoro returned no audio for line {index + 1}.")

    sf.write(output_path, np.concatenate(segments), sample_rate)
    output_files.append(str(output_path))

  print(json.dumps({"ok": True, "outputFiles": output_files}))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
