// The API serializes calls and reuses one CPU model while a comic is being read.
// A four-byte length followed by an MP3 keeps stdout separate from Python logs.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config.js';
import { httpError } from '../http.js';

export const maxAudioBytes = 4 * 1024 * 1024;

export function createKokoroWorker() {
  let worker;
  let idleTimer;
  const script = path.join(projectRoot, 'model-services', 'ltx-2.3', 'kokoro_tts_worker.py');
  const siblingPython = path.resolve(path.dirname(process.execPath), '../../kokoro-tts/bin/python');
  function close() {
    clearTimeout(idleTimer);
    worker?.kill('SIGKILL');
    worker = undefined;
  }
  function start() {
    const python = process.env.EULALENS_KOKORO_PYTHON || process.env.LTX_KOKORO_PYTHON || (existsSync(siblingPython) ? siblingPython : 'python3');
    const child = spawn(python, ['-u', script, '--comic-narration'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', CUDA_VISIBLE_DEVICES: '', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2', TOKENIZERS_PARALLELISM: 'false' }
    });
    child.on('error', () => {}); // Spawn failure also closes the pipes and emits close.
    child.stdin.on('error', () => child.kill('SIGKILL'));
    child.once('close', () => { if (worker === child) worker = undefined; });
    return child;
  }
  async function synthesize({ text, signal }) {
    signal.throwIfAborted();
    clearTimeout(idleTimer);
    const child = worker ||= start();
    return new Promise((resolve, reject) => {
      let length;
      let failure;
      // Wait for a terminated worker to actually exit before the gate admits another.
      function terminate(error) {
        failure ||= error;
        child.kill('SIGKILL');
      }
      const unavailable = () => httpError(503, 'Comic narration is unavailable. Check the Kokoro environment or try again.');
      const abort = () => terminate(signal.reason);
      function cleanup() {
        signal.removeEventListener('abort', abort);
        child.stdout.off('readable', read);
        child.off('close', closed);
      }
      function closed() {
        cleanup();
        reject(failure || unavailable());
      }
      function read() {
        if (failure) return;
        if (length === undefined) {
          const header = child.stdout.read(4);
          if (header === null) return;
          if (header.length !== 4) { terminate(unavailable()); return; }
          length = header.readUInt32BE(0);
          if (!length || length > maxAudioBytes) { terminate(unavailable()); return; }
        }
        const audio = child.stdout.read(length);
        if (audio === null) return;
        if (audio.length !== length) { terminate(unavailable()); return; }
        cleanup();
        idleTimer = setTimeout(close, 120000);
        idleTimer.unref();
        resolve(audio);
      }
      child.once('close', closed);
      child.stdout.on('readable', read);
      signal.addEventListener('abort', abort, { once: true });
      child.stdin.write(JSON.stringify(text) + '\n');
    });
  }
  return { synthesize, close };
}
