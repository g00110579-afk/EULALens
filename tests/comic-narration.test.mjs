import test from 'node:test';
import assert from 'node:assert/strict';
import { comicSceneText, createComicNarration } from '../server/comic-narration.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const job = { kind: 'comic', jobId: 'comic-fixture', comics: [{ id: 'example', scenes: [{ narration: 'Scene one.' }, { narration: 'Scene two.' }] }] };

test('scene narration supports persisted scripts without display panels or authored narration', () => {
  assert.equal(comicSceneText({ scenes: [{ overlay_caption: 'The user checks the terms.', dialogue: 'One device.' }] }, 0), 'The user checks the terms.\nOne device.');
  assert.equal(comicSceneText({ panels: [{ body: 'Caption', slots: [{ text: 'Caption' }] }], scenes: [{ dialogue: 'Spoken line' }] }, 0), 'Caption\nSpoken line');
  assert.equal(comicSceneText({ panels: [{ title: 'Original title' }] }, 0), 'Original title');
  assert.throws(() => comicSceneText({ scenes: [{}] }, 0), /suitable narration/);
  assert.throws(() => comicSceneText({ scenes: [{ narration: 'x'.repeat(4097) }] }, 0), /suitable narration/);
});

test('concurrent readers share one model request and the last disconnect cancels it for retry', async () => {
  const calls = [];
  let release;
  const narrator = createComicNarration({ synthesize: ({text, signal}) => new Promise((resolve, reject) => {
    calls.push({text, signal}); release = () => resolve(Buffer.from(text));
    signal.addEventListener('abort', () => reject(signal.reason), {once:true});
  }) });
  try {
    const a = new AbortController(), b = new AbortController();
    const first = narrator.audio(job, 'example', 0, a.signal);
    const second = narrator.audio(job, 'example', 0, b.signal);
    await tick();
    assert.equal(calls.length, 1);
    a.abort(); await assert.rejects(first, { name: 'AbortError' });
    assert.equal(calls[0].signal.aborted, false);
    release(); assert.equal((await second).toString(), 'Scene one.');
    const next = new AbortController();
    const interrupted = narrator.audio(job, 'example', 1, next.signal);
    await tick(); next.abort();
    await assert.rejects(interrupted, { name: 'AbortError' });
    const retry = narrator.audio(job, 'example', 1, b.signal);
    await tick();
    assert.equal(calls.length, 3);
    release(); await retry;
    await narrator.audio(job, 'example', 1, b.signal);
    assert.equal(calls.length, 3);
  } finally { await narrator.close(); }
});

test('a single session cannot occupy every slot and shutting down rejects queued work', async () => {
  let started = 0;
  const narrator = createComicNarration({ synthesize: ({signal}) => new Promise((_resolve, reject) => {
    started++;
    signal.addEventListener('abort', () => reject(signal.reason), {once:true});
  }) });
  const signal = new AbortController().signal;
  const read = (id, owner) => narrator.audio({...job, jobId:id, owner}, 'example', 0, signal);
  const admitted = Promise.allSettled([0, 1, 2, 3].map(i => read('a'+i, 'owner-a')));
  await assert.rejects(read('a4', 'owner-a'), {statusCode:429});
  const other = Promise.allSettled([read('b0', 'owner-b')]);
  await tick();
  assert.equal(started, 1);
  await narrator.close();
  assert((await admitted).every(result => result.status === 'rejected'));
  assert.equal((await other)[0].status, 'rejected');
  assert.equal(started, 1);
});

test('early preparation shares the current clip, gives waiting readers the next turn, and stops on cancellation', async () => {
  const calls = [];
  const narrator = createComicNarration({ synthesize: ({ text, signal }) => new Promise((resolve, reject) => {
    calls.push({ text, finish: () => resolve(Buffer.from(text)) });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const warm = new AbortController(), reader = new AbortController();
  const alternate = { id: 'alt', scenes: [{ narration: 'Alternate scene.' }] };
  const story = { ...job, comics: [alternate, ...job.comics], selectedComicId: 'example' };
  try {
    narrator.prepare(story, warm.signal);
    await tick();
    assert.deepEqual(calls.map(call => call.text), ['Scene one.']);
    const shared = narrator.audio(story, 'example', 0, reader.signal);
    const requested = narrator.audio(story, 'alt', 0, reader.signal);
    calls[0].finish();
    await shared; await tick();
    assert.deepEqual(calls.map(call => call.text), ['Scene one.', 'Alternate scene.']);
    warm.abort();
    calls[1].finish();
    await requested; await tick();
    assert.equal(calls.length, 2);
    assert.equal((await narrator.audio(story, 'example', 0, reader.signal)).toString(), 'Scene one.');
    assert.equal(calls.length, 2);
  } finally { await narrator.close(); }
});
