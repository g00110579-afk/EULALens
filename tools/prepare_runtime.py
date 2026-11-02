#!/usr/bin/env python3
"""Prepare local deployment configuration without printing credentials.

Default is read-only. --apply backs up changed files and refuses changes while
services listen on their configured ports. Publish the matching UI before restart.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import shlex
import socket
import tempfile

PROJECT = Path(__file__).resolve().parents[1]

def read_env(path):
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key, value = line.split('=', 1)
                try: value = shlex.split(value, comments=True)[0] if value.strip() else ''
                except (ValueError, IndexError): value = value.strip().strip('"\'')
                values[key.strip()] = value
    return values

def update_env(path, changes):
    lines = path.read_text().splitlines() if path.exists() else []
    seen = set(); output = []
    for line in lines:
        key = line.split('=', 1)[0].strip() if '=' in line and not line.lstrip().startswith('#') else None
        if key in changes:
            output.append(f'{key}={shlex.quote(str(changes[key]))}'); seen.add(key)
        else: output.append(line)
    output.extend(f'{key}={shlex.quote(str(value))}' for key, value in changes.items() if key not in seen)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.config-')
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as stream: stream.write('\n'.join(output) + '\n')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--root', type=Path, default=PROJECT.parent)
    parser.add_argument('--project', type=Path, default=PROJECT)
    args = parser.parse_args()
    root = args.root.resolve(); project = args.project.resolve()
    files = {'web': project/'.env', 'qwen': root/'scripts_dev/qwen-3.5-9b/.env', 'image': root/'scripts_dev/hidream-o1-image-2604/.env', 'video': root/'scripts_dev/ltx-2.3/.env'}
    current = {name: read_env(path) for name, path in files.items()}
    def key(*candidates): return next((value for value in candidates if value and len(value) >= 32), secrets.token_urlsafe(48))
    qwen = key(current['qwen'].get('VLLM_API_KEY'), current['web'].get('QWEN_API_KEY'))
    image = key(current['image'].get('HIDREAM_API_KEY'), current['web'].get('HIDREAM_API_KEY'))
    video = key(current['video'].get('LTX_API_KEY'), current['web'].get('VIDEO_API_KEY'))
    expected = {
      'web': {'QWEN_API_KEY': qwen, 'HIDREAM_API_KEY': image, 'VIDEO_API_KEY': video, 'HOST': '127.0.0.1', 'PRESENTATION_MODE': 'false',
        'QWEN_BASE_URL':'http://127.0.0.1:8000/v1','HIDREAM_IMAGE_API_URL':'http://127.0.0.1:5052','VIDEO_API_URL':'http://127.0.0.1:5054/generate','VIDEO_PROVIDER':'ltx-local',
        'QWEN_CHUNK_CHARS':'3500','QWEN_MAX_TOKENS':'4096','QWEN_CONTEXT_TOKENS':'16384'},
      'qwen': {'VLLM_API_KEY':qwen,'HOST':'127.0.0.1'},
      'image': {'HIDREAM_API_KEY':image,'HIDREAM_HOST':'127.0.0.1','HIDREAM_WIDTH':'2048','HIDREAM_HEIGHT':'2048','HIDREAM_STEPS':'28'},
      'video': {'LTX_API_KEY':video,'LTX_HOST':'127.0.0.1'}
    }
    changes = {name: {key: value for key, value in values.items() if current[name].get(key) != value} for name, values in expected.items()}
    changes = {name: values for name, values in changes.items() if values}
    if not args.apply:
        print(json.dumps({'ready':not bool(changes),'configuration_updates':{name:list(values) for name,values in changes.items()},'next_step':('Configuration is synchronized. Check /api/readiness on the running API.' if not changes else 'After publishing the matching UI and stopping services, run this command with --apply, then start_eulalens.sh.')},indent=2))
        return 0 if not changes else 1
    if changes:
        occupied=[]
        for port in (5050,8000,5052,5054):
            with socket.socket() as sock:
                sock.settimeout(.25)
                if sock.connect_ex(('127.0.0.1',port))==0: occupied.append(port)
        if occupied:
            print(json.dumps({'error':'Stop the existing services before changing shared credentials. No configuration was changed.','listening_ports':occupied}))
            return 2
        backup = project/'.runtime/config-backups'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup.mkdir(parents=True,mode=0o700)
        for name, values in changes.items():
            if files[name].exists():
                target=backup/f'{name}.env';target.write_bytes(files[name].read_bytes());target.chmod(0o600)
            update_env(files[name],values)
    print(json.dumps({'ready':True,'updated_services':list(changes),'credentials_printed':False}))
    return 0
if __name__ == '__main__': raise SystemExit(main())
