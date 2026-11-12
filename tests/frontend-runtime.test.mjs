import test from 'node:test';
import assert from 'node:assert/strict';
import '../live-runtime.js';
const { Scheduler, createApi, createRunStore, escapeHtml, safeUrl } = globalThis.EULALensRuntime;
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const storage = () => { const values = new Map(); return { get length() { return values.size; }, key: i => [...values.keys()][i], setItem: (k,v) => values.set(k,v), getItem: k => values.get(k), removeItem: k => values.delete(k), values }; };

test('manual and automatic requests share a bound; duplicates reprioritize without rerunning', async () => {
  const scheduler = new Scheduler({ comic: 2 }); const releases = []; const started = [];
  const work = id => async () => { started.push(id); await new Promise(resolve => releases.push(resolve)); };
  const a = scheduler.enqueue('a','comic',work('a'));
  const b = scheduler.enqueue('b','comic',work('b'));
  const c = scheduler.enqueue('c','comic',work('c'));
  const d = scheduler.enqueue('d','comic',work('d'));
  assert.equal(scheduler.enqueue('d','comic',work('duplicate'),{priority:10}),d);
  await tick(); assert.deepEqual(started,['a','b']);
  releases.shift()(); await tick(); assert.deepEqual(started,['a','b','d']);
  releases.shift()(); await tick(); assert.deepEqual(started,['a','b','d','c']);
  releases.forEach(resolve=>resolve()); await Promise.all([a,b,c,d]);
});

test('canceling pending queue entries never starts their work', async () => {
  const scheduler = new Scheduler({video:1}); let release; let ran=false;
  const active=scheduler.enqueue('a','video',()=>new Promise(resolve=>{release=resolve;}));
  const controller=new AbortController();
  const waiting=scheduler.enqueue('b','video',async()=>{ran=true;},{signal:controller.signal});
  const rejected=assert.rejects(waiting,{name:'AbortError'});
  controller.abort(); await rejected;await tick();release();await active;await tick();assert.equal(ran,false);
});

test('polling retries the same accepted job after network failure and sends session bearer', async () => {
  const calls=[];let gets=0;const tokens=storage();
  const api=createApi('https://api.test',{sleep:async()=>{},sessionStorage:tokens,fetch:async(url,init)=>{
    calls.push({url,init});
    if(url.endsWith('/api/session'))return response({csrfToken:'csrf',sessionToken:'browser-session'});
    if(++gets<3)throw new TypeError('offline');
    return response({status:'ready',jobId:'accepted'});
  }});
  const job=await api.poll('/jobs/accepted',{intervalMs:1});
  assert.equal(job.jobId,'accepted');assert.equal(calls.filter(x=>x.url.endsWith('/jobs/accepted')).length,3);
  assert.ok(calls.slice(1).every(x=>x.init.headers.Authorization==='Bearer browser-session'));
  assert.ok(calls.every(x=>x.init.credentials==='include'));
  assert.ok(calls.every(x=>!x.init.method || x.init.method==='GET'));
});

test('write retries preserve idempotency and include CSRF; an expired session refreshes once', async () => {
  const calls=[];let writes=0;
  const api=createApi('https://api.test',{sleep:async()=>{},sessionStorage:storage(),fetch:async(url,init)=>{
    calls.push({url,init});
    if(url.endsWith('/api/session'))return response({csrfToken:'csrf',sessionToken:'browser-session'});
    if(++writes===1)return response({error:'expired'},401);
    if(writes===2)return response({error:'busy'},503);
    return response({jobId:'one-job'});
  }});
  await api.json('/start',{method:'POST',body:{text:'private'},idempotencyKey:'stable'});
  const posts=calls.filter(x=>x.url.endsWith('/start'));
  assert.equal(posts.length,3);assert.ok(posts.every(x=>x.init.headers['Idempotency-Key']==='stable'));
  assert.ok(posts.every(x=>x.init.headers['X-CSRF-Token']==='csrf'));
  assert.equal(calls.filter(x=>x.url.endsWith('/api/session')).length,2);
});

test('terminal canceled job is reported as terminal; polling aborts promptly', async () => {
  const api=createApi('https://api.test',{sessionStorage:storage(),fetch:async(url)=>response(url.endsWith('/api/session')?{csrfToken:'c'}:{status:'canceled'})});
  await assert.rejects(api.poll('/jobs/a'),error=>error.terminal && error.jobStatus==='canceled');
  const controller=new AbortController();controller.abort();
  await assert.rejects(api.poll('/jobs/a',{signal:controller.signal}),{name:'AbortError'});
});

test('run restoration persists identifiers only and expires old references',()=>{
  const data=storage();const store=createRunStore(data);
  const run={documentId:'doc',analysisJobId:'analysis',cardsJobId:'cards',createdAt:Date.now(),text:'SECRET FULL TEXT',documentTitle:'PRIVATE FILE',categories:[{id:'cat',summary:'SECRET SUMMARY',sourceSegments:['SECRET CLAUSE'],comicJobId:'comic',scenarioRenders:{scenario:{jobId:'render',imageUrl:'secret',prompt:'secret'}}}]};
  store.save(run);const encoded=[...data.values.values()][0];
  assert.doesNotMatch(encoded,/SECRET|PRIVATE|prompt|imageUrl|summary|sourceSegments/);
  assert.equal(store.load().media[0].scenarioJobs.scenario.jobId,'render');
  store.save({...run,createdAt:Date.now()-25*3600000});assert.equal(store.load(),null);
});

test('untrusted strings are escaped and executable URL schemes rejected',()=>{
  assert.equal(escapeHtml('<img onerror="x">&\''),'&lt;img onerror=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(safeUrl('javascript:alert(1)','https://api.test'), '');
  assert.equal(safeUrl('data:text/html,<script>x</script>','https://api.test'), '');
  assert.equal(safeUrl('/media/video.mp4','https://api.test'),'https://api.test/media/video.mp4');
});

test('expired job status and missing retained job are terminal retryable outcomes',async()=>{
  for (const status of ['expired','missing']) {
    const api=createApi('https://api.test',{sessionStorage:storage(),fetch:async(url)=>response(url.endsWith('/api/session')?{csrfToken:'c'}:{status:'expired',error:'Expired'},url.endsWith('/api/session')||status==='expired'?200:404)});
    await assert.rejects(api.poll('/jobs/a'),error=>error.terminal && error.jobStatus==='expired');
  }
});

test('WebVTT uses actual returned speech timings and rejects invalid cues',()=>{
  const vtt=globalThis.EULALensRuntime.subtitleVtt([{startSeconds:1.234,endSeconds:4.987,text:'Adjusted speech'},{startSeconds:5,endSeconds:3,text:'invalid'},{startSeconds:6,endSeconds:7,text:'<script>\nnot HTML'}]);
  assert.match(vtt,/00:00:01\.234 --> 00:00:04\.987/);
  assert.doesNotMatch(vtt,/invalid|<script>/);assert.match(vtt,/&lt;script> not HTML/);
});
