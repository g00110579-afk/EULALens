"""Small standard-library safeguards shared by the local model services."""
from __future__ import annotations

import contextlib
import hmac
import math
import mimetypes
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time
import threading

_RETENTION_LOCK = threading.Lock()


class ServiceError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def authorize(header: str | None, key: str) -> None:
    if not key or not key.strip():
        raise ServiceError(503, "Service authentication is not configured.")
    if not hmac.compare_digest(str(header or "").encode("utf-8"), f"Bearer {key.strip()}".encode("utf-8")):
        raise ServiceError(401, "Invalid service credentials.")


def finite_number(value, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool):
        raise ServiceError(422, f"{name} must be a number.")
    try:
        result = float(value)
    except (ValueError, TypeError):
        raise ServiceError(422, f"{name} must be a number.") from None
    if not math.isfinite(result) or not minimum <= result <= maximum:
        raise ServiceError(422, f"{name} must be between {minimum} and {maximum}.")
    return result


def checked_artifact(root: Path, relative: str, suffixes: set[str]) -> Path:
    root = root.resolve()
    target = (root / relative).resolve()
    if not target.is_relative_to(root) or not target.is_file() or target.suffix.lower() not in suffixes:
        raise ServiceError(404, "Artifact not found.")
    return target


def byte_range(value: str | None, size: int) -> tuple[int, int, bool]:
    if not value:
        return 0, max(0, size - 1), False
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip())
    if not match or not any(match.groups()) or size <= 0:
        raise ServiceError(416, "Invalid byte range.")
    left, right = match.groups()
    if not left:
        count = int(right)
        if count <= 0:
            raise ServiceError(416, "Invalid byte range.")
        start, end = max(0, size - count), size - 1
    else:
        start, end = int(left), min(int(right), size - 1) if right else size - 1
    if start >= size or end < start:
        raise ServiceError(416, "Unsatisfiable byte range.")
    return start, end, True


def stream_artifact(handler, path: Path, head: bool = False) -> None:
    size = path.stat().st_size
    try:
        start, end, partial = byte_range(handler.headers.get("Range"), size)
    except ServiceError:
        handler.send_response(416)
        handler.send_header("Content-Range", f"bytes */{size}")
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return
    count = end - start + 1 if size else 0
    handler.send_response(206 if partial else 200)
    handler.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
    handler.send_header("Content-Length", str(count))
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Cache-Control", "private, max-age=3600")
    handler.send_header("X-Content-Type-Options", "nosniff")
    if partial:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    handler.end_headers()
    if head:
        return
    with path.open("rb") as source:
        source.seek(start)
        while count:
            block = source.read(min(65536, count))
            if not block:
                break
            handler.wfile.write(block)
            count -= len(block)


def signal_group(proc, sig) -> bool:
    if proc is None:
        return False
    try:
        os.killpg(proc.pid, sig)
        return True
    except ProcessLookupError:
        return False


def terminate_group(proc, grace: float = 2.0) -> tuple[str, str]:
    """The process-group leader exiting must not exempt descendants from teardown."""
    signal_group(proc, signal.SIGTERM)
    try:
        out = proc.communicate(timeout=grace)
    except subprocess.TimeoutExpired:
        out = None
    # Child output may go to a file; leader pipes closing does not prove group exit.
    signal_group(proc, signal.SIGKILL)
    if out is None:
        out = proc.communicate(timeout=max(grace, 1.0))
    return out


def remaining(deadline: float | None, maximum: float = 300.0) -> float:
    value = maximum if deadline is None else min(maximum, deadline - time.monotonic())
    if value <= 0:
        raise ServiceError(504, "Generation deadline exceeded.")
    return value


@contextlib.contextmanager
def acquired_until(lock, check):
    while not lock.acquire(timeout=0.1):
        check()
    try:
        check()
        yield
    finally:
        lock.release()


def prune_completed(root: Path, max_age_seconds: float, max_jobs: int) -> None:
    """Only remove marked completed service jobs, never active or unrelated files."""
    if not root.exists() or not _RETENTION_LOCK.acquire(blocking=False):
        return
    try:
        now = time.time()
        max_age_seconds, max_jobs = max(60, max_age_seconds), max(1, max_jobs)
        jobs = []
        for child in root.iterdir():
            if child.is_dir() and not child.is_symlink():
                marker = child / ".eulalens-complete"
                try:
                    if marker.is_file():
                        jobs.append((marker.stat().st_mtime, child))
                except FileNotFoundError:
                    continue
        jobs.sort(reverse=True)
        for index, (completed, child) in enumerate(jobs):
            if now - completed > max_age_seconds or index >= max_jobs:
                shutil.rmtree(child, ignore_errors=True)
    finally:
        _RETENTION_LOCK.release()


def speaker_voices(lines: list[dict], voices: list[str]) -> list[str]:
    mapping = {}
    result = []
    for line in lines:
        speaker = str(line.get("speaker") or "narrator").strip().casefold()
        if speaker not in mapping:
            mapping[speaker] = voices[len(mapping) % len(voices)]
        result.append(mapping[speaker])
    return result
