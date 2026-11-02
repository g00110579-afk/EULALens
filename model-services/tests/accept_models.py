#!/usr/bin/env python3
"""Explicit opt-in live model acceptance. Reads local keys privately; never restarts services."""
from __future__ import annotations

import argparse
import array
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import shlex
import struct
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from uuid import uuid4


class CheckFailed(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise CheckFailed(message)


def read_env(path):
    values = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            name, value = line.split("=", 1)
            tokens = shlex.split(value, comments=True)
            values[name.strip()] = tokens[0] if tokens else ""
    return values


class Service:
    def __init__(self, root, kind, timeout):
        self.kind, self.timeout = kind, timeout
        folder = "hidream-o1-image-2604" if kind == "image" else "ltx-2.3"
        self.directory = root / "scripts_dev" / folder
        self.env = read_env(self.directory / ".env")
        prefix = "HIDREAM" if kind == "image" else "LTX"
        self.key = self.env.get(prefix + "_API_KEY", "")
        require(bool(self.key), kind + " service key is missing")
        require(self.env.get(prefix + "_HOST", "127.0.0.1") in {"127.0.0.1", "localhost", "::1"}, kind + " is not configured for loopback")
        port = int(self.env.get(prefix + "_PORT", "5052" if kind == "image" else "5054"))
        self.base = f"http://127.0.0.1:{port}"
        configured = self.env.get(prefix + ("_OUTPUT_DIR" if kind == "image" else "_OUTPUT_ROOT"))
        require(bool(configured), kind + " output root must be explicit for acceptance")
        self.output_root = (self.directory / configured).resolve()

    def request(self, path, body=None, method=None, authorized=True, headers=None, timeout=None):
        headers = dict(headers or {})
        if authorized:
            headers["Authorization"] = "Bearer " + self.key
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=timeout or self.timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read(8 * 1024 * 1024 + 1)
            require(len(data) <= 8 * 1024 * 1024, "Response exceeds acceptance size limit")
            return response.status, dict(response.headers.items()), data

    def json(self, path, body=None, authorized=True, timeout=None):
        status, _, raw = self.request(path, body=body, authorized=authorized, timeout=timeout)
        try:
            payload = json.loads(raw)
        except ValueError:
            raise CheckFailed(f"{self.kind} {path} returned non-JSON status {status}") from None
        return status, payload

    def health(self):
        status, payload = self.json("/health", authorized=False, timeout=10)
        require(status == 200 and payload.get("ready") is True, self.kind + " is not ready")
        return {name: payload[name] for name in ("ready", "loaded", "modelLoaded", "residentPipeline", "activeJobs") if name in payload}

    def media_path(self, url):
        parsed = urllib.parse.urlsplit(url)
        require(parsed.path.startswith("/outputs/") and not parsed.query, "Unexpected generated media URL")
        return parsed.path

    def local_file(self, value, suffix):
        path = Path(value).resolve()
        require(path.is_relative_to(self.output_root) and path.is_file() and path.suffix == suffix, "Generated artifact is outside the configured media root")
        return path

    def verify_media(self, url, path):
        route = self.media_path(url)
        require(self.request(route, method="HEAD", authorized=False)[0] == 401, "Media accepts unauthenticated access")
        status, headers, data = self.request(route, method="HEAD")
        require(status == 200 and not data, "Authenticated HEAD failed")
        normalized = {key.lower(): value for key, value in headers.items()}
        require(int(normalized["content-length"]) == path.stat().st_size, "Media size differs from local output")
        status, headers, data = self.request(route, headers={"Range": "bytes=0-31"})
        require(status == 206 and data == path.read_bytes()[:32], "Media byte range is incorrect")
        status, headers, _ = self.request(route, headers={"Range": f"bytes={path.stat().st_size + 10}-"})
        normalized = {key.lower(): value for key, value in headers.items()}
        require(status == 416 and normalized.get("content-range") == f"bytes */{path.stat().st_size}", "Out-of-range response is incorrect")
        return {"authenticatedHead": True, "unauthenticatedRejected": True, "byteRange": True,
            "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def image_payload(job_id):
    return {"jobId": job_id, "categoryId": "acceptance-privacy", "title": "Privacy acceptance",
        "prompt": "A clean friendly editorial illustration of a person reading a privacy notice at a desk, an envelope icon and a small lock icon, warm daylight, clear flat colors, coherent hands, no lettering, no watermark.",
        "width": 2048, "height": 2048, "steps": 28, "seed": 42}


def video_payload(job_id):
    return {"jobId": job_id,
        "prompt": "A calm locked camera medium shot of two friendly adults sitting across a small desk in a bright office. One asks a short question and the other answers. Gentle natural head movements, coherent faces and hands, warm daylight, no visible text, no subtitles, no watermark.",
        "duration_seconds": 4, "frame_rate": 12,
        "subtitles": [{"startSeconds": 0, "endSeconds": 1.7, "speaker": "Customer", "text": "What is shared?"},
            {"startSeconds": 1.8, "endSeconds": 3.8, "speaker": "Provider", "text": "Only your email."}],
        "metadata": {"categoryId": "acceptance-privacy", "categoryTitle": "Privacy acceptance"}}


def generate(service, payload):
    started = time.monotonic()
    try:
        status, result = service.json("/generate", body=payload)
        require(status == 200, f"{service.kind} generation failed with HTTP {status}")
        require(result.get("jobId") == payload["jobId"], "Service changed the job ID")
        return result, round(time.monotonic() - started, 3)
    except BaseException:
        # A client transport failure does not imply that the service stopped its job.
        try:
            service.json("/cancel", body={"jobId": payload["jobId"]}, timeout=10)
        except Exception:
            pass
        raise


def accept_image(service):
    payload = image_payload("accept-image-" + uuid4().hex)
    result, elapsed = generate(service, payload)
    path = service.local_file(result["imagePath"], ".png")
    with path.open("rb") as source:
        header = source.read(24)
    require(header[:8] == b"\x89PNG\r\n\x1a\n", "Image is not a PNG")
    width, height = struct.unpack(">II", header[16:24])
    require((width, height) == (2048, 2048) == (result["width"], result["height"]), "Image dimensions/metadata do not match requested native size")
    require(result["steps"] == 28, "Unexpected image step count")
    return {"jobId": result["jobId"], "elapsedSeconds": elapsed, "file": str(path),
        "width": width, "height": height, "steps": result["steps"], "media": service.verify_media(result["imageUrl"], path)}


def ffmpeg(args):
    result = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", *args], capture_output=True, timeout=40)
    require(result.returncode == 0, "ffmpeg artifact verification failed")
    return result.stdout


def srt_time(value):
    millis = round(value * 1000)
    hours, millis = divmod(millis, 3600000)
    minutes, millis = divmod(millis, 60000)
    seconds, millis = divmod(millis, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"


def accept_video(service, report_path):
    payload = video_payload("accept-video-" + uuid4().hex)
    result, elapsed = generate(service, payload)
    require(result["status"] == "completed", "Video is not complete")
    require(result.get("degraded") is False and result.get("dialogueAudio") is True, "Video audio is degraded or absent")
    require(result.get("embeddedSubtitles") is True, "Video captions were not embedded")
    path = service.local_file(result["outputFile"], ".mp4")
    probe = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(path)], capture_output=True, text=True, timeout=40)
    require(probe.returncode == 0, "ffprobe could not decode generated video")
    data = json.loads(probe.stdout)
    video = next(stream for stream in data["streams"] if stream["codec_type"] == "video")
    audio = next((stream for stream in data["streams"] if stream["codec_type"] == "audio"), None)
    require(audio is not None, "Generated video has no audio stream")
    frames = int(video["nb_read_frames"])
    require(frames == 49 == result["num_frames"] and (frames - 1) % 8 == 0, "Video frame count is incorrect")
    require((video["width"], video["height"]) == (int(service.env["LTX_WIDTH"]), int(service.env["LTX_HEIGHT"])), "Video resolution differs from configured dimensions")
    duration = float(data["format"]["duration"])
    require(abs(duration - frames / 12) < .12 and abs(result["duration_seconds"] - frames / 12) < .001, "Video duration is inconsistent")
    lines = result["subtitleLines"]
    require(len(lines) == len(payload["subtitles"]), "Caption lines were lost")
    previous = 0
    for actual, expected in zip(lines, payload["subtitles"]):
        require(actual["text"] == expected["text"] and actual["speaker"] == expected["speaker"], "Caption content changed")
        require(previous <= actual["startSeconds"] < actual["endSeconds"] <= duration, "Caption timing overlaps or exceeds video duration")
        previous = actual["endSeconds"]
    srt = service.local_file(result["postprocess"]["subtitleFile"], ".srt").read_text()
    for line in lines:
        require(line["text"] in srt and f'{srt_time(line["startSeconds"])} --> {srt_time(line["endSeconds"])}' in srt, "Caption sidecar differs from actual returned timing")
    pcm = array.array("h", ffmpeg(["-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"]))
    rms = math.sqrt(sum(sample * sample for sample in pcm) / max(1, len(pcm))) / 32768
    require(rms > .001, "Video speech track is effectively silent")
    # Save one actual caption frame for visual review; never claim OCR correctness.
    frame = report_path.with_suffix(".caption.png")
    midpoint = (lines[0]["startSeconds"] + lines[0]["endSeconds"]) / 2
    ffmpeg(["-y", "-ss", str(midpoint), "-i", str(path), "-frames:v", "1", str(frame)])
    return {"jobId": result["jobId"], "elapsedSeconds": elapsed, "file": str(path),
        "width": video["width"], "height": video["height"], "frames": frames, "durationSeconds": duration,
        "audioRms": round(rms, 5), "subtitleLines": lines, "captionFrame": str(frame), "degraded": result["degraded"],
        "media": service.verify_media(result["videoUrl"], path)}


def cancellation(service, active=False):
    payload = (image_payload if service.kind == "image" else video_payload)("accept-cancel-" + uuid4().hex)
    started = time.monotonic()
    if active:
        require(service.health().get("activeJobs", 0) == 0, "Active cancellation probe requires an idle service")
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(service.json, "/generate", body=payload)
            limit = time.monotonic() + 20
            while time.monotonic() < limit:
                if service.health().get("activeJobs", 0) > 0 or future.done():
                    break
                time.sleep(.1)
            require(not future.done(), "Probe completed before active cancellation could be observed")
            require(service.health().get("activeJobs", 0) > 0, "Probe was not admitted")
            status, _ = service.json("/cancel", body={"jobId": payload["jobId"]}, timeout=10)
            require(status == 200, "Active cancellation was not acknowledged")
            status, _ = future.result(timeout=120)
    else:
        status, _ = service.json("/cancel", body={"jobId": payload["jobId"]}, timeout=10)
        require(status == 200, "Pre-admission cancellation was not acknowledged")
        status, _ = service.json("/generate", body=payload, timeout=30)
    require(status == 409, f"Canceled generation returned HTTP {status}")
    limit = time.monotonic() + 10
    while service.health().get("activeJobs", 0) and time.monotonic() < limit:
        time.sleep(.1)
    require(service.health().get("activeJobs", 0) == 0, "Canceled service job retained ownership")
    return {"jobId": payload["jobId"], "mode": "active" if active else "before-admission", "responseStatus": status,
        "elapsedSeconds": round(time.monotonic() - started, 3), "activeJobsAfter": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--service", choices=("image", "video", "all"), default="all")
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--run", action="store_true", help="Explicitly authorize real model generation after services are ready.")
    parser.add_argument("--cancel", choices=("none", "pre", "active"), default="pre")
    parser.add_argument("--timeout", type=int, default=1200)
    args = parser.parse_args()
    if not args.run:
        parser.error("No jobs submitted. --run is required for real GPU acceptance.")
    report = {"startedAt": datetime.now(timezone.utc).isoformat(), "services": {}}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    try:
        for kind in (("image", "video") if args.service == "all" else (args.service,)):
            service = Service(args.root.resolve(), kind, args.timeout)
            health = service.health()
            require(health.get("activeJobs", 0) == 0, kind + " service must be idle for acceptance")
            print(f"{kind}: ready; starting one acceptance generation", flush=True)
            outcome = accept_image(service) if kind == "image" else accept_video(service, args.report)
            outcome["healthBefore"] = health
            if args.cancel != "none":
                outcome["cancellation"] = cancellation(service, active=args.cancel == "active")
            report["services"][kind] = outcome
            args.report.write_text(json.dumps(report, indent=2) + "\n")
            print(f"{kind}: generation, metadata, media and cancellation checks passed", flush=True)
        report["passed"] = True
    except Exception as error:
        report["passed"] = False
        report["error"] = str(error) if isinstance(error, CheckFailed) else type(error).__name__
        print("Acceptance failed: " + report["error"], flush=True)
    finally:
        report["finishedAt"] = datetime.now(timezone.utc).isoformat()
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
