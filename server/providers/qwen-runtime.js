// One admission queue per server process, shared by all Qwen call sites.
const waiting = [];
let active = 0;
const unsupportedTokenizers = new Set();

export function positiveInteger(value, fallback, name = 'Qwen setting', maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw Object.assign(new Error(`${name} must be an integer between 1 and ${maximum}.`), { status: 500, code: 'QWEN_CONFIGURATION' });
  }
  return number;
}

export function qwenError(message, code, status = 502) {
  return Object.assign(new Error(message), { code, status, statusCode: status });
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Request canceled.', 'AbortError');
}

function drain() {
  while (waiting.length && active < waiting[0].limit) {
    const entry = waiting.shift();
    entry.signal?.removeEventListener('abort', entry.abort);
    if (entry.signal?.aborted) { entry.reject(entry.signal.reason); continue; }
    active += 1;
    entry.resolve(() => { active -= 1; drain(); });
  }
}

function acquire(signal, limit, maxQueue) {
  throwIfAborted(signal);
  if (waiting.length >= maxQueue) throw qwenError('Qwen is busy. Please retry after current work completes.', 'QWEN_QUEUE_FULL', 429);
  return new Promise((resolve, reject) => {
    const entry = { signal, limit, resolve, reject };
    entry.abort = () => {
      const index = waiting.indexOf(entry);
      if (index !== -1) waiting.splice(index, 1);
      reject(signal.reason || new DOMException('Request canceled.', 'AbortError'));
      drain();
    };
    signal?.addEventListener('abort', entry.abort, { once: true });
    waiting.push(entry);
    drain();
  });
}

export async function withQwenSlot(operation, callerSignal) {
  const limit = positiveInteger(process.env.QWEN_GLOBAL_CONCURRENCY, 3, 'QWEN_GLOBAL_CONCURRENCY', 32);
  const maxQueue = positiveInteger(process.env.QWEN_MAX_QUEUE, 128, 'QWEN_MAX_QUEUE', 4096);
  const timeoutMs = positiveInteger(process.env.QWEN_REQUEST_TIMEOUT_MS, 180000, 'QWEN_REQUEST_TIMEOUT_MS', 3600000);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(callerSignal.reason || new DOMException('Request canceled.', 'AbortError'));
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(Object.assign(qwenError('Qwen request exceeded its deadline.', 'QWEN_TIMEOUT', 504), { name: 'TimeoutError' })), timeoutMs);
  let release;
  try {
    release = await acquire(controller.signal, limit, maxQueue);
    throwIfAborted(controller.signal);
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', forwardAbort);
    release?.();
  }
}

export function abortableDelay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('Request canceled.', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function promptTokenCount(config, messages, signal) {
  const mode = process.env.QWEN_TOKENIZER_MODE || 'auto';
  if (!['auto', 'required', 'conservative'].includes(mode)) throw qwenError('QWEN_TOKENIZER_MODE must be auto, required, or conservative.', 'QWEN_CONFIGURATION', 500);
  const tokenizeUrl = process.env.QWEN_TOKENIZE_URL || `${config.baseUrl.replace(/\/v1\/?$/, '')}/tokenize`;
  if (mode === 'required' || (mode !== 'conservative' && !unsupportedTokenizers.has(tokenizeUrl))) {
    const attempts = positiveInteger(process.env.QWEN_MAX_ATTEMPTS, 3, 'QWEN_MAX_ATTEMPTS', 5);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response;
      try {
        response = await fetch(tokenizeUrl, {
          method: 'POST', signal,
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: config.model, messages, add_generation_prompt: true, chat_template_kwargs: { enable_thinking: false } })
        });
      } catch (error) {
        throwIfAborted(signal);
        if (attempt === attempts || !(error instanceof TypeError || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_SOCKET'].includes(error.cause?.code || error.code))) throw error;
        await abortableDelay(250 * 2 ** (attempt - 1), signal);
        continue;
      }
      if (response.ok) {
        let result;
        try { result = await response.json(); } catch {
          throwIfAborted(signal);
          if (attempt === attempts) throw qwenError('Qwen tokenizer returned unreadable JSON.', 'QWEN_TOKENIZER');
          await abortableDelay(250 * 2 ** (attempt - 1), signal);
          continue;
        }
        if (Number.isInteger(result.count) && result.count >= 0) return result.count;
        if (mode === 'required') throw qwenError('Qwen tokenizer returned an invalid count.', 'QWEN_TOKENIZER');
        break;
      }
      await response.body?.cancel();
      if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
        await abortableDelay(250 * 2 ** (attempt - 1), signal);
        continue;
      }
      if (![404, 405, 422, 501].includes(response.status)) throw qwenError(`Qwen tokenizer failed (${response.status}).`, 'QWEN_TOKENIZER');
      if (mode === 'required') throw qwenError('Qwen tokenizer endpoint is unavailable.', 'QWEN_TOKENIZER');
      break;
    }
    unsupportedTokenizers.add(tokenizeUrl);
  }
  // UTF-8 bytes conservatively bound byte-BPE content tokens. Reserve template overhead.
  return 256 + messages.reduce((sum, message) => sum + Buffer.byteLength(String(message.content || ''), 'utf8') + 64, 0);
}
