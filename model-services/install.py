#!/usr/bin/env python3
"""Copy only the versioned model wrapper files; never configure or start services."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import tempfile
from uuid import uuid4

PACKAGE = Path(__file__).resolve().parent
TREES = ("scripts_dev", "scripts")
ALLOWED = frozenset({
    "service_runtime.py", "hidream_image_server.py",
    "hidream-o1-image-2604/hidream_image_server.py",
    "hidream-o1-image-2604/apply_pipeline_patch.py",
    "hidream-o1-image-2604/patches/cooperative-cancellation.patch",
    "hidream-o1-image-2604/setup_hidream.sh",
    "hidream-o1-image-2604/serve_hidream_image.sh",
    "hidream-o1-image-2604/.env.example",
    "ltx-2.3/ltx_video_server.py", "ltx-2.3/timed_ltx23_experiment.py",
    "ltx-2.3/kokoro_tts_worker.py", "ltx-2.3/serve_ltx23_video.sh",
    "ltx-2.3/.env.example", "qwen-3.5-9b/serve_qwen35_9b_vllm.sh",
    "qwen-3.5-9b/.env.example", "tests/test_model_services.py", "tests/accept_models.py",
})


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def checked_path(root: Path, relative: str) -> Path:
    parts = PurePosixPath(relative).parts
    if not parts or relative.startswith("/") or ".." in parts or "\\" in relative:
        raise ValueError(f"Unsafe relative path: {relative}")
    current = root
    for index, part in enumerate(parts):
        current = current / part
        if current.is_symlink():
            raise ValueError(f"Refusing symlink: {current}")
        if current.exists() and index < len(parts) - 1 and not current.is_dir():
            raise ValueError(f"Parent is not a directory: {current}")
    return current


def sources(package: Path = PACKAGE) -> list[dict]:
    manifest = json.loads((package / "manifest.json").read_text())
    if manifest.get("format") != 1:
        raise ValueError("Unsupported package manifest format.")
    entries = manifest.get("files", [])
    names = [entry.get("path") for entry in entries]
    if len(names) != len(set(names)) or set(names) != ALLOWED:
        raise ValueError("Package manifest differs from the fixed source allowlist.")
    result = []
    for entry in entries:
        source = checked_path(package, entry["path"])
        if not source.is_file() or source.stat().st_size > 2 * 1024 * 1024:
            raise ValueError(f"Invalid source file: {entry['path']}")
        data = source.read_bytes()
        if sha256(data) != entry["sha256"]:
            raise ValueError(f"Package checksum mismatch: {entry['path']}")
        mode = int(entry["mode"], 8)
        if mode not in (0o644, 0o755):
            raise ValueError(f"Unsafe source mode: {entry['path']}")
        result.append({**entry, "data": data, "mode": mode})
    return result


def plan(root: Path, entries: list[dict]) -> list[dict]:
    changes = []
    for tree in TREES:
        for entry in entries:
            relative = f"{tree}/{entry['path']}"
            destination = checked_path(root, relative)
            if destination.exists() and not destination.is_file():
                raise ValueError(f"Destination is not a regular file: {relative}")
            original = destination.read_bytes() if destination.exists() else None
            if original != entry["data"]:
                changes.append({**entry, "relative": relative, "target": destination,
                    "original": original, "old_mode": stat.S_IMODE(destination.stat().st_mode) if original is not None else None})
    return changes


@contextmanager
def install_lock(root: Path):
    path = checked_path(root, ".model-services-install.lock")
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Installer lock is not a regular file.")
        os.fchmod(fd, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another model source installer is running.") from None
        yield
    finally:
        os.close(fd)


def atomic_write(path: Path, data: bytes, mode: int) -> None:
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def apply(root: Path, changes: list[dict]) -> Path | None:
    if not changes:
        return None
    backup_root = checked_path(root, ".model-service-backups")
    backup_root.mkdir(mode=0o700, exist_ok=True)
    backup_root.chmod(0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup = backup_root / f"{stamp}-{uuid4().hex[:8]}"
    backup.mkdir(mode=0o700)
    records = []
    # Finish every original-file backup before replacing any source.
    for change in changes:
        old = change["original"]
        record = {"path": change["relative"], "existed": old is not None,
            "old_sha256": sha256(old) if old is not None else None,
            "new_sha256": change["sha256"], "old_mode": change["old_mode"]}
        records.append(record)
        if old is not None:
            previous = backup / change["relative"]
            previous.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            atomic_write(previous, old, 0o600)
    atomic_write(backup / "changes.json", (json.dumps(records, indent=2) + "\n").encode(), 0o600)
    try:
        for change in changes:
            target = checked_path(root, change["relative"])
            # Refuse to overwrite an edit made after preflight.
            current = target.read_bytes() if target.exists() else None
            if current != change["original"]:
                raise ValueError(f"Source changed during installation: {change['relative']}")
            target.parent.mkdir(parents=True, exist_ok=True)
            atomic_write(target, change["data"], change["mode"])
            if sha256(target.read_bytes()) != change["sha256"]:
                raise ValueError(f"Installed checksum mismatch: {change['relative']}")
    except Exception:
        print(f"Installation stopped; original files are backed up at {backup}", file=sys.stderr)
        raise
    return backup


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path, help="Existing deployment parent containing scripts_dev/ and scripts/.")
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true", help="Compare source contents without writing anything; exit 1 on drift.")
    modes.add_argument("--apply", action="store_true", help="Copy allowlisted sources to both trees, backing up changed files.")
    args = parser.parse_args(argv)
    try:
        root = args.root.expanduser().resolve(strict=True)
        if not root.is_dir():
            raise ValueError("--root must be an existing directory.")
        entries = sources()
        if args.check:
            changes = plan(root, entries)
            for change in changes:
                print(f"DIFF {change['relative']}")
            print(f"{len(changes)} changed or missing files across {len(TREES)} service trees.")
            return 1 if changes else 0
        with install_lock(root):
            changes = plan(root, entries)
            backup = apply(root, changes)
        print(f"Installed {len(changes)} changed or missing files; source checksums verified.")
        if backup:
            print(f"Private source backup: {backup}")
        return 0
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"Model source installation refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
