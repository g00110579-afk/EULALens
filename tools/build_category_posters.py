#!/usr/bin/env python3
"""Rebuild the sample category picker's six WebP contact sheets with FFmpeg."""

import json
import math
import re
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "category-posters"
WIDTH, HEIGHT = 320, 180

# Selected shots for videos whose endings fade, lose the subject, or still have captions.
# Store paths, not ordinal positions; the picker can reorder the categories independently.
STILL_TIMES = {
    "zoom/videos/authority-warranty.mp4": 3,
    "zoom/videos/account-termination.mp4": 21,
    "zoom/videos/proprietary-rights.mp4": 3,
    "zoom/videos/termination-survival.mp4": 3,
    "zoom/videos/termination-obligations.mp4": 21,
    "zoom/videos/injunctive-relief.mp4": 21,
    "zoom/videos/no-warranties.mp4": 3,
    "zoom/videos/arbitration-waiver.mp4": 3,
    "zoom/videos/contract-modification.mp4": 12,
    "zoom/videos/arbitration-mandate.mp4": 21,
    "zoom/videos/governing-language.mp4": 3,
    "zoom/videos/severability.mp4": 3,
    "spotify/videos/account-security-and-ownership.mp4": 21,
    "spotify/videos/price-change-acceptance.mp4": 3,
    "spotify/videos/withdrawal-right-limitations.mp4": 21,
    "spotify/videos/user-content-responsibility.mp4": 3,
    "spotify/videos/class-action-waiver.mp4": 3,
    "spotify/videos/confidentiality.mp4": 3,
    "spotify/videos/arbitration-provision-modification.mp4": 12,
    "spotify/videos/arbitration-severability.mp4": 21,
    "spotify/videos/severability.mp4": 21,
    "steam/videos/user-generated-content-license.mp4": 3,
    "steam/videos/third-party-liability.mp4": 3,
    "steam/videos/account-termination.mp4": 21,
    "steam/videos/workshop-removal-discretion.mp4": 3,
    "steam/videos/unilateral-amendment.mp4": 21,
    "steam/videos/termination.mp4": 12,
    "steam/videos/bundle-termination.mp4": 3,
    "steam/videos/survival-of-terms.mp4": 12,
    "steam/videos/severability.mp4": 3,
    "steam/videos/law-enforcement-compliance.mp4": 12,
    "windows11/videos/arbitration-class-action-waiver.mp4": 3,
    "windows11/videos/arbitration-mechanics.mp4": 12,
    "adobe/videos/third-party-liability-exclusion.mp4": 21,
    "adobe/videos/class-action-waiver.mp4": 21,
    "adobe/videos/no-waiver.mp4": 21,
    "deepfake/videos/licensor-discretion.mp4": 21,
}


def sample_documents():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    for match in re.finditer(r"const (\w+)Categories = (\[)", html):
        categories, _ = json.JSONDecoder().raw_decode(html, match.start(2))
        yield match.group(1), categories


def video_frame(category):
    video = Path(category["video"])
    if video.is_absolute() or ".." in video.parts or video.suffix != ".mp4":
        raise ValueError(f"Unexpected sample video path: {video}")
    # Most clips continue for a moment after the last dialogue caption.
    seek = ["-sseof", "-0.52"]
    filters = []
    if video.as_posix() in STILL_TIMES:
        seek = ["-ss", str(STILL_TIMES[video.as_posix()])]
        # Frame the actors and props above the subtitles burned into these shots.
        filters.append("crop=iw*0.80:iw*0.80*9/16:(iw-ow)/2:ih*0.025")
    filters.extend([
        f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase",
        f"crop={WIDTH}:{HEIGHT}",
        "setsar=1",
    ])
    frame = subprocess.check_output([
        "ffmpeg", "-loglevel", "error", *seek, "-i", ROOT / video,
        "-frames:v", "1", "-vf", ",".join(filters), "-threads", "1",
        "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ])
    if len(frame) != WIDTH * HEIGHT * 3:
        raise ValueError(f"Missing frame from {video}")
    return frame


def make_sheet(document, categories, output):
    columns = min(6, max(1, len(categories)))
    rows = math.ceil(len(categories) / columns)
    width, height = columns * WIDTH, rows * HEIGHT
    pixels = bytearray(width * height * 3)
    tiles = {}
    for i, category in enumerate(categories):
        if category["id"] in tiles:
            raise ValueError(f"Duplicate category in {document}: {category['id']}")
        tiles[category["id"]] = i
        frame = video_frame(category)
        left, top = (i % columns) * WIDTH, (i // columns) * HEIGHT
        stride = WIDTH * 3
        for y in range(HEIGHT):
            offset = ((top + y) * width + left) * 3
            pixels[offset:offset + stride] = frame[y * stride:(y + 1) * stride]
    filename = document + ".webp"
    subprocess.run([
        "ffmpeg", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgb24",
        "-video_size", f"{width}x{height}", "-i", "pipe:0", "-frames:v", "1",
        "-c:v", "libwebp", "-quality", "72", "-compression_level", "6",
        "-threads", "1", "-y", output / filename,
    ], input=pixels, check=True)
    return {"src": f"category-posters/{filename}", "columns": columns, "rows": rows, "tiles": tiles}


def main():
    OUTPUT.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=OUTPUT) as scratch:
        output = Path(scratch)
        sheets = {
            document: make_sheet(document, categories, output)
            for document, categories in sample_documents()
        }
        if not sheets:
            raise ValueError("No sample category lists found")
        name = "category-posters.js"
        (output / name).write_text(
            "// Generated by tools/build_category_posters.py from the sample videos.\n"
            + "const categoryPosterSheets = " + json.dumps(sheets, indent=2, ensure_ascii=False)
            + ";\n", encoding="utf-8",
        )
        for filename in output.glob("*.webp"):
            filename.replace(OUTPUT / filename.name)
        (output / name).replace(ROOT / name)


if __name__ == "__main__":
    main()
