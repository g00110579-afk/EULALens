#!/usr/bin/env python3
"""Render one seekable Kokoro MP3 per sample comic and its scene cue times."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

os.environ.setdefault("HF_HUB_OFFLINE", "1")

import numpy as np
from kokoro import KPipeline

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "model-services" / "ltx-2.3"))
from kokoro_tts_worker import synthesize_line

SAMPLE_RATE = 24000
VOICE = "af_heart"
GAP = np.zeros(round(0.30 * SAMPLE_RATE), dtype=np.float32)
CACHE = PROJECT / ".runtime" / "comic-audio-build" / "rendered.json"
MANIFEST = PROJECT / "sample-narration.js"


def sample_comics():
    html = (PROJECT / "index.html").read_text(encoding="utf-8")
    for match in re.finditer(r"const \w+Categories = (\[)", html):
        categories, _ = json.JSONDecoder().raw_decode(html, match.start(1))
        for category in categories:
            path = Path(category["comic"])
            if path.is_absolute() or len(path.parts) != 3 or path.parts[1] != "comics" or ".." in path.parts:
                raise ValueError(f"Unexpected sample artwork path: {path}")
            lines = [scene["narration"].strip() for scene in category["comicScenes"]]
            if not lines or not all(lines):
                raise ValueError(f"Missing source narration in {path}")
            yield path, lines


def render(pipeline, lines, destination):
    waveform = []
    starts = []
    frames = 0
    for line in lines:
        if waveform:
            waveform.append(GAP)
            frames += len(GAP)
        starts.append(round(frames / SAMPLE_RATE, 3))
        audio = synthesize_line(pipeline, line, VOICE)
        if len(audio) == 0 or not np.isfinite(audio).all() or np.max(np.abs(audio)) < 0.001:
            raise ValueError(f"No audible speech for {destination} at scene {len(starts)}")
        waveform.append(audio)
        frames += len(audio)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".part")
    try:
        subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                        "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
                        "-map_metadata", "-1", "-codec:a", "libmp3lame", "-b:a", "48k",
                        "-threads", "1", "-f", "mp3", str(temporary)],
                       input=np.concatenate(waveform).astype("<f4", copy=False).tobytes(), check=True)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return starts


def write_atomic(path, text):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    args = parser.parse_args()
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    manifest = {}
    pipeline = None
    for artwork, lines in sample_comics():
        key = artwork.as_posix()
        if key in manifest:
            raise ValueError(f"Duplicate artwork key: {key}")
        src = Path("sample-audio") / artwork.parts[0] / artwork.with_suffix(".mp3").name
        destination = PROJECT / src
        recipe = [VOICE, SAMPLE_RATE, len(GAP), "kokoro-v1.0/mp3-48k", lines]
        digest = hashlib.sha256(json.dumps(recipe).encode()).hexdigest()
        saved = cache.get(key, {})
        if saved.get("digest") != digest or not destination.is_file() or destination.stat().st_size != saved.get("bytes"):
            if pipeline is None:
                pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", device=args.device)
            starts = render(pipeline, lines, destination)
            saved = cache[key] = {"digest": digest, "starts": starts, "bytes": destination.stat().st_size}
            write_atomic(CACHE, json.dumps(cache))
        manifest[key] = {"src": src.as_posix(), "starts": saved["starts"]}
        print(f"{len(manifest):3}  {src}", flush=True)
    if not manifest:
        raise ValueError("No sample comics found")
    write_atomic(MANIFEST, "// Generated from the original scene narration by tools/build_sample_narration.py.\n"
                 + "const sampleNarration = " + json.dumps(manifest, ensure_ascii=False, indent=2) + ";\n")


if __name__ == "__main__":
    main()
