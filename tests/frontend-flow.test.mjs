import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import '../live-runtime.js';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match=>match[1]).find(value=>value.includes('const LIVE_API_BASE'));
const comicReader=fs.readFileSync(new URL('../comic-reader.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function environment(api={}) {
  const elements=new Map();
  class Element {
    constructor(){this.dataset={};this.children=[];this.attributes={};this.style={setProperty(){}};this.classList={add(){},remove(){},toggle(){},contains(){return false;}};this.textContent='';this.innerHTML='';this.src='';this.complete=false;}
    appendChild(child){this.children.push(child);child.parentElement=this;if(child.id)elements.set(child.id,child);return child;}
    removeChild(child){this.children=this.children.filter(item=>item!==child);}
    remove(){this.parentElement?.removeChild(this);}
    append(...children){children.forEach(child=>this.appendChild(child));}
    replaceChildren(...children){this.children=[];this.innerHTML='';this.append(...children);}
    setAttribute(name,value){this.attributes[name]=value;}
    removeAttribute(name){delete this.attributes[name];if(name==='src')this.src='';}
    hasAttribute(name){return Boolean(this.attributes[name]||(name==='src'&&this.src));}
    insertAdjacentHTML(_position,html){this.innerHTML+=html;}
    querySelector(){return null;}
    get firstElementChild(){return this.children[0] || null;}
    get lastElementChild(){return this.children.at(-1) || null;}
    scrollTo(){}
    addEventListener(){} removeEventListener(){} scrollIntoView(){} focus(){} pause(){} load(){}
  }
  const get=id=>{if(!elements.has(id)){const node=new Element();node.id=id;node.parentElement=new Element();elements.set(id,node);}return elements.get(id);};
  get('comic-zoom').append(new Element(),new Element());
  const store=new Map();const storage={get length(){return store.size;},key:index=>[...store.keys()][index]??null,getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)};
  const ctx={console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,AbortController,DOMException,Promise,WeakSet,URL:class extends URL {static createObjectURL(){return'blob:test';}static revokeObjectURL(){}},crypto:{randomUUID,subtle:{digest:async (_algorithm, data)=>Uint8Array.from(createHash('sha256').update(new Uint8Array(data)).digest()).buffer}},TextEncoder,Uint8Array,Blob,
    location:{href:'https://web.test/'},localStorage:storage,sessionStorage:storage,addEventListener(){},scrollTo(){},requestAnimationFrame(){},
    document:{getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[],querySelector:selector=>selector==='#comic-reader .comic-art'?get('comic-crop').parentElement:null,addEventListener(){}},
    EULALensRuntime:{...globalThis.EULALensRuntime,createApi:()=>({json:async()=>({}),poll:async()=>({}),...api})}};
  ctx.window=ctx;vm.createContext(ctx);vm.runInContext(script,ctx);vm.runInContext(comicReader,ctx);
  const run=source=>vm.runInContext(source,ctx);
  return {ctx,run,get,elements,store};
}
const setupRun=`currentRun = newLiveRun(); currentRun.analysisJobId='analysis'; currentRun.documentTitle='Audit'; activeDocument='live'; categories = Array.from({length:8},(_,i)=>convertLiveCategory({id:'c'+i,title:'Category '+i,severity:'high',lenses:{},sourceSegments:[]})); currentRun.categories=categories;`;

test('actual media tab handlers cannot bypass the shared queue',async()=>{
  const starts=[];const e=environment({json:async(url)=>{starts.push(url);return await new Promise(()=>{});}});
  e.run(setupRun);
  e.run(`for (const cat of categories) { document.getElementById('active-category').dataset.catId=cat.id; switchRightTab('comic'); }`);
  await tick();assert.equal(starts.length,2);
  e.run(`for (const cat of categories) { document.getElementById('active-category').dataset.catId=cat.id; switchRightTab('comic'); }`);
  await tick();assert.equal(starts.length,2);
});

test('partial cards display before the batch ends, and media starts without a card barrier',async()=>{
  const starts=[];let updateCards;
  const e=environment({json:async(url)=>{starts.push(url);return{jobId:url.includes('cards')?'cards':'media-'+starts.length};},poll:async(url,options)=>{
    if(url.includes('/cards/'))updateCards=options.onUpdate;
    return await new Promise(()=>{});
  }});
  e.run(`currentRun=newLiveRun();currentRun.analysisJobId='analysis';showLiveAnalysis(currentRun,{analysis:{categories:[{id:'c1',title:'First',lenses:{}},{id:'c2',title:'Second',lenses:{}}]}});openUpload(currentRun);`);
  await tick();assert.ok(starts.some(url=>url.includes('/cards/')));assert.ok(starts.some(url=>url.includes('/comic/')));assert.ok(starts.some(url=>url.includes('/video/')));
  e.run(`currentFormat='video';`);
  updateCards({status:'processing',results:[{categoryId:'c1',ok:true,cards:[{question:'Question',backDetail:'Answer'}]}]});
  assert.equal(e.run(`categories[0].cardsStatus`),'ready');assert.equal(e.run(`categories[1].cardsStatus`),'generating');assert.equal(e.run('currentFormat'),'video');
  updateCards({status:'ready',results:[{categoryId:'c1',ok:true,cards:[{question:'Question'}]},{categoryId:'c2',ok:false,error:'Upstream failed'}]});
  assert.equal(e.run(`categories[1].cardsStatus`),'error');
});

test('choosing a sample during PDF extraction leaves its queued analysis running in the background',async()=>{
  let release;const requests=[];const e=environment({json:async(url)=>{requests.push(url);return{jobId:'accepted'};},poll:async()=>({status:'ready',result:{analysis:{categories:[{id:'only',title:'From the PDF',lenses:{}}]}}})});
  e.ctx.extractPdfText=()=>new Promise(resolve=>{release=resolve;});
  const pending=e.ctx.handleUploadedFile({name:'old.pdf',type:'application/pdf',size:10});
  await tick();
  e.ctx.switchDocument('zoom');release('A long enough document for analysis.');await pending;await tick();
  assert.equal(e.run('activeDocument'),'zoom');assert.equal(requests.filter(url=>url==='/api/analyze/start').length,1);
  assert.equal(e.run('[...uploads.values()][0].categories[0].name'),'From the PDF');
  assert.ok(!e.run('categories.some(cat=>cat.name==="From the PDF")'));
});

test('filenames, summaries, cards and comic dialogue remain text',()=>{
  const e=environment();const attack='<img src=x onerror="window.pwned=1">';e.ctx.attack=attack;
  e.run(`currentRun=newLiveRun();activeDocument='live';const cat=convertLiveCategory({id:'c1',title:attack,summary:attack,lenses:{impact:attack,lookouts:[attack]}});categories=[cat];currentRun.categories=categories;cat.cards=[{icon:attack,front:attack,backTitle:attack,backDetail:attack}];cat.cardsStatus='ready';cat.comicStatus='ready';cat.comic='javascript:alert(1)';cat.comicScenes=[{title:attack,caption:attack,slots:[{text:attack,kind:attack,position:attack}]}];updateCategoryDetails(cat,{scroll:false});setUploadStatus(attack);`);
  for(const id of ['cat-summary','cat-impact','cat-lookouts','cat-cards','comic-dialogue'])assert.doesNotMatch(e.get(id).innerHTML,/<img/);
  assert.equal(e.get('comic-caption').textContent,attack);assert.equal(e.get('comic-dialogue').children[0].textContent,attack);
  assert.equal(e.get('upload-status').children[0].textContent,attack);assert.equal(e.get('cat-comic-img').src,'');
});

test('canceling a queued upload cleans up a media job accepted after cancellation',async()=>{
  let release;const calls=[];const e=environment({json:async(url)=>{calls.push(url);if(url.endsWith('/start'))return await new Promise(resolve=>{release=resolve;});return{status:'canceled'};}});
  e.run(setupRun);const promise=e.run(`ensureLiveComic(categories[0])`);await tick();
  e.run('registerUpload(currentRun);removeUpload(currentRun);');e.ctx.switchDocument('zoom');release({jobId:'late-comic'});await promise;await tick();
  assert.ok(calls.includes('/api/categories/comic/jobs/late-comic/cancel'));
  assert.equal(e.run('activeDocument'),'zoom');
});

test('all comic scenarios remain selectable; initial scenario does not create a duplicate child render',async()=>{
  const calls=[];let update;let finish;
  const e=environment({json:async(url)=>{calls.push(url);return{jobId:'primary'};},poll:async(_url,options)=>{update=options.onUpdate;return await new Promise(resolve=>{finish=resolve;});}});
  e.run(setupRun);const pending=e.run(`ensureLiveComic(categories[0])`);await tick();
  const comics=[{id:'one',title:'First',panels:[]},{id:'two',title:'Second',panels:[]}];
  update({status:'rendering-image',comics,comic:comics[0],selectedComicId:'one'});
  e.run(`document.getElementById('active-category').dataset.catId='c0';switchRightTab('comic');`);await tick();assert.equal(calls.length,1);
  finish({status:'ready',comics,comic:comics[0],render:{image:{imageUrl:'/api/comic-assets/first.webp'}}});await pending;await tick();
  assert.equal(e.run(`categories[0].comics.length`),2);assert.equal(e.get('comic-scenarios').children.length,2);
  assert.equal(e.run(`categories[0].comicStatus`),'ready');
});

test('a background comic scenario updates its category without replacing the visible reader',()=>{
  const e=environment();e.run(setupRun);
  e.run(`const [visible, background]=categories; document.getElementById('active-category').dataset.catId=visible.id;
    visible.comicStatus='ready';visible.comicTitle='Current comic';visible.comicScenes=[{title:'A'},{title:'B'}];
    renderComicForCategory(visible);moveComicScene(1);
    background.comics=[{id:'other',title:'Background story',panels:[{title:'Other scene'}]}];
    displayComicScenario(background,'other');`);
  assert.equal(e.run('categories[1].selectedComicId'),'other');
  assert.equal(e.get('cat-comic-title').textContent,'Current comic');
  assert.equal(e.get('comic-scene-title').textContent,'B');
});

test('frontend retry reconnects to an accepted job after transport failure without another POST',async()=>{
  let posts=0,polls=0;
  const e=environment({json:async()=>{posts++;return{jobId:'accepted-video'};},poll:async()=>{
    if(++polls===1)throw new Error('Temporary transport deadline');
    return{status:'ready',video:{videoUrl:'/api/assets/accepted/video?token=capability'}};
  }});
  e.run(setupRun);await e.run(`ensureLiveVideo(categories[0])`);await tick();
  assert.equal(e.run(`categories[0].videoStatus`),'error');
  await e.run(`ensureLiveVideo(categories[0])`);await tick();
  assert.equal(posts,1);assert.equal(e.run(`categories[0].videoStatus`),'ready');
});

test('failed initial image can retry only its scenario without generating the story again',async()=>{
  const calls=[];let polls=0;const comic={id:'one',title:'First',panels:[]};
  const e=environment({json:async(url)=>{calls.push(url);return{jobId:calls.length===1?'primary':'retry-render'};},poll:async(_url,options)=>{
    options.onUpdate({status:'rendering-image',comics:[comic],comic});
    if(++polls===1)throw Object.assign(new Error('Image failed'),{terminal:true,jobStatus:'error'});
    return{status:'ready',comic,render:{image:{imageUrl:'/api/assets/retry/image'}}};
  }});
  e.run(setupRun);await e.run(`ensureLiveComic(categories[0])`);await tick();
  e.run(`document.getElementById('active-category').dataset.catId='c0';retryLiveMedia('comic');`);
  for(let i=0;i<5;i++)await tick();
  assert.equal(calls.length,2);assert.match(calls[1],/\/jobs\/primary\/scenarios\/one\/render$/);
  assert.equal(e.run(`categories[0].comicStatus`),'ready');
});

test('completion of the primary comic cannot replace a different selected scenario',async()=>{
  let update,finish;
  const e=environment({json:async()=>({jobId:'primary'}),poll:async(_url,options)=>{update=options.onUpdate;return await new Promise(resolve=>{finish=resolve;});}});
  e.run(setupRun);const pending=e.run(`ensureLiveComic(categories[0])`);await tick();
  const comics=[{id:'one',title:'First',panels:[]},{id:'two',title:'Second',panels:[]}];
  update({status:'rendering-image',comics,comic:comics[0]});
  e.run(`displayComicScenario(categories[0],'two');categories[0].scenarioRenders.two.status='ready';categories[0].scenarioRenders.two.imageUrl='https://api.test/two';displayComicScenario(categories[0],'two');`);
  finish({status:'ready',comic:comics[0],render:{image:{imageUrl:'/api/assets/primary/one'}}});await pending;await tick();
  assert.equal(e.run(`categories[0].selectedComicId`),'two');assert.equal(e.run(`categories[0].comic`),'https://api.test/two');
});

test('PDF text extraction disables eval and releases page/document resources',async()=>{
  let options,cleaned=0,destroyed=0;
  const e=environment();
  e.ctx.getPdfReader=async()=>({getDocument:input=>{
    options=input;
    return{promise:Promise.resolve({numPages:1,getPage:async()=>({getTextContent:async()=>({items:[{str:'First line',hasEOL:true},{str:'Second line'}]}),cleanup(){cleaned++;}})}),async destroy(){destroyed++;}};
  }});
  const text=await e.ctx.extractPdfText({arrayBuffer:async()=>new ArrayBuffer(8)},new AbortController().signal);
  assert.equal(options.isEvalSupported,false);assert.match(text,/First line\nSecond line/);
  assert.equal(cleaned,1);assert.equal(destroyed,1);
  assert.doesNotMatch(html,/pdf\.js\/3\.11\.174/);
  const version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).dependencies['pdfjs-dist'];
  assert(html.includes('https://cdn.jsdelivr.net/npm/pdfjs-dist@'+version+'/build/'));
  assert.match(html,/import\(build \+ 'pdf\.min\.mjs'\)/);
  assert.match(html,/workerSrc = build \+ 'pdf\.worker\.min\.mjs'/);
});

test('restoring a selected secondary scenario resumes its saved job without any new submission',async()=>{
  let posts=0;const polled=[];
  const comics=[{id:'one',title:'First',panels:[]},{id:'two',title:'Second',panels:[]}];
  const e=environment({json:async()=>{posts++;return{jobId:'unexpected'};},poll:async(url,options)=>{
    polled.push(url);const second=url.endsWith('/secondary');
    const job={status:'ready',comics,comic:comics[second?1:0],render:{image:{imageUrl:'/api/assets/'+(second?'two':'one')}}};
    options.onUpdate(job);return job;
  }});
  e.run(setupRun);
  e.run(`categories[0].comicJobId='primary';categories[0].selectedComicId='two';categories[0].scenarioRenders={two:{jobId:'secondary'}};`);
  await e.run(`ensureLiveComic(categories[0])`);for(let i=0;i<4;i++)await tick();
  assert.equal(posts,0);assert.ok(polled.some(url=>url.endsWith('/secondary')));
  assert.match(e.run(`categories[0].comic`),/\/two$/);assert.equal(e.run(`categories[0].selectedComicId`),'two');
});

test('video consumes returned subtitles and displays degraded-audio notice',async()=>{
  const fitted=[{startSeconds:1.2,endSeconds:5.7,text:'Actual spoken duration'}];
  const e=environment({json:async()=>({jobId:'video'}),poll:async()=>({status:'ready',video:{videoUrl:'/api/assets/video/movie',subtitleLines:fitted,embeddedSubtitles:false,degradation:true}})});
  e.run(setupRun);e.run(`document.getElementById('active-category').dataset.catId='c0';`);
  await e.run(`ensureLiveVideo(categories[0])`);await tick();
  assert.equal(e.run(`categories[0].videoSubtitleLines[0].endSeconds`),5.7);
  assert.ok(e.get('cat-video')._liveCaptionTrack);assert.match(e.get('video-degradation').textContent,/audio could not be generated/);
});

test('cancel reaches a newly accepted video retry after the previous job failed terminally', async () => {
  const calls = []; let polls = 0;
  const e = environment({json: async url => { calls.push(url); return {jobId: calls.filter(item => item.endsWith('/start')).length === 1 ? 'failed-video' : 'retry-video'}; }, poll: async () => {
    if (++polls === 1) throw Object.assign(new Error('Failed'), {terminal: true, jobStatus: 'error'});
    return new Promise(() => {});
  }});
  e.run(setupRun); await e.run(`ensureLiveVideo(categories[0])`); await tick();
  assert.equal(e.run('categories[0].videoFinished'), true);
  e.run(`document.getElementById('active-category').dataset.catId='c0';retryLiveMedia('video');`);
  for (let i=0; i<3; i++) await tick();
  assert.equal(e.run('categories[0].videoFinished'), false);
  await e.run(`cancelLiveJobs(categories)`);
  assert.ok(calls.includes('/api/categories/video/jobs/retry-video/cancel'));
});

test('primary image failure remains retryable after another scenario was selected', async () => {
  const calls=[]; let update, fail; let polls=0;
  const comics=[{id:'one',title:'First',panels:[]},{id:'two',title:'Second',panels:[]}];
  const e=environment({json:async url=>{calls.push(url);return{jobId:calls.length===1?'primary':'retry-image'};},poll:async(_url, options)=>{
    if (++polls===1) { update=options.onUpdate; return new Promise((_resolve,reject)=>{fail=reject;}); }
    return{status:'ready',comic:comics[0],render:{image:{imageUrl:'/api/assets/retry/one'}}};
  }});
  e.run(setupRun); const first=e.run(`ensureLiveComic(categories[0])`); await tick();
  update({status:'rendering-image',comics,comic:comics[0]});
  e.run(`displayComicScenario(categories[0],'two');`);
  fail(Object.assign(new Error('Initial image failed'),{terminal:true,jobStatus:'error'})); await first; await tick();
  assert.equal(e.run('categories[0].scenarioRenders.one.terminalFailure'),true);
  e.run(`document.getElementById('active-category').dataset.catId='c0';displayComicScenario(categories[0],'one');retryLiveMedia('comic');`);
  for(let i=0;i<5;i++)await tick();
  assert.match(calls[1],/\/jobs\/primary\/scenarios\/one\/render$/, JSON.stringify({calls, state:e.run('categories[0].scenarioRenders.one'), status:e.run('categories[0].comicStatus'), queue:e.run('mediaScheduler.jobs.size')}));
  assert.equal(e.run('categories[0].comicStatus'),'ready');
});

test('a saved run with an unavailable session offers reupload without starting a replacement job', async () => {
  let posts = 0;
  const e = environment({ json: async () => { posts++; return {}; }, poll: async () => { throw Object.assign(new Error('Job not found or expired.'), { status: 404, terminal: true }); } });
  e.run(`runStore.save({documentId:'saved',analysisJobId:'old-analysis',createdAt:Date.now(),categories:[]});`);
  await e.ctx.restoreLiveRun();
  assert.match(e.run("uploads.get('saved').row.detail.textContent"), /no longer available.*browser session.*Upload the PDF again/);
  assert.equal(e.run('runStore.load()'), null);
  assert.equal(e.run('isRunCurrent(currentRun)'), false);
  assert.equal(posts, 0);
});

test('restored categories keep reserved scenario identifiers isolated from one another', async () => {
  let starts=0;
  const e=environment({json:async()=>({jobId:'render-'+ ++starts}),poll:async url=>({status:'ready',comic:{id:'constructor',title:'Secondary',panels:[]},render:{image:{imageUrl:'/api/assets/'+url.split('/').pop()+'/image.png'}}})});
  e.run(`const actualComicLoader=ensureLiveComic;ensureLiveComic=()=>Promise.resolve();ensureLiveVideo=()=>Promise.resolve();loadLiveCards=()=>Promise.resolve();
    currentRun=newLiveRun({analysisJobId:'analysis',media:['one','two'].map(id=>({categoryId:id,comicJobId:'parent-'+id,selectedComicId:'first',scenarioJobs:{first:{jobId:'parent-'+id}}}))});
    showLiveAnalysis(currentRun,{analysis:{categories:['one','two'].map(id=>({id,title:id,lenses:{}}))}});openUpload(currentRun);
    ensureLiveComic=actualComicLoader;
    for(const cat of categories){cat.primaryComicId='first';cat.comics=[{id:'first',title:'First',panels:[]},{id:'constructor',title:'Secondary',panels:[]}];}
    displayComicScenario(categories[0],'constructor');`);
  await e.run(`ensureLiveComic(categories[0],{scenarioId:'constructor'})`);await tick();
  e.run(`displayComicScenario(categories[1],'constructor')`);
  await e.run(`ensureLiveComic(categories[1],{scenarioId:'constructor'})`);
  assert.equal(starts,2);
  assert.notEqual(e.run('categories[0].comic'),e.run('categories[1].comic'));
  assert.equal(e.run('categories[0].scenarioRenders.constructor === categories[1].scenarioRenders.constructor'),false);
});

test('the queue opens the first completed playable video even when jobs reconnect out of order', () => {
  const e = environment();
  e.run(setupRun);
  e.run(`registerUpload(currentRun); currentRun.analysisFinished = true;
    window.openUpload = (run, cat) => { window.openedCategory = cat.id; };
    categories[0].videoStatus = 'ready';
    categories[1].videoStatus = 'generating-video';
    updateUploadRow(currentRun);`);
  const row = e.run('currentRun.row');
  assert.equal(row.firstVideo.hidden, true);
  assert.equal(row.phase.textContent, 'Rendering first video');
  e.run(`Object.assign(categories[2], {videoStatus:'ready', video:'https://example.test/newer.mp4', videoCompletedAt:20});
    updateUploadRow(currentRun);`);
  assert.equal(row.firstVideo.hidden, false);
  assert.equal(row.videoLabel.textContent, 'First video ready · Category 2');
  e.run(`Object.assign(categories[3], {videoStatus:'ready', video:'https://example.test/earlier.mp4', videoCompletedAt:10});
    updateUploadRow(currentRun);`);
  assert.equal(row.videoLabel.textContent, 'First video ready · Category 3');
  row.firstVideo.onclick();
  assert.equal(e.ctx.openedCategory, 'c3');
  e.run("for (const cat of categories) cat.videoStatus = 'error'; updateUploadRow(currentRun);");
  assert.equal(row.firstVideo.hidden, true);
  assert.equal(row.phase.textContent, 'No video available');
});

test('the matching Deepfake upload can open its prepared category before analysis and schedules only remaining categories', async () => {
  const requests = [];
  let finishAnalysis;
  const e = environment({
    json: async (url, options) => {
      requests.push({url, body: options.body});
      return {jobId: 'job-' + requests.length};
    },
    poll: async url => new Promise(resolve => {
      if (url.includes('/analyze/')) finishAnalysis = resolve;
    })
  });
  e.ctx.extractPdfText = async () => 'PDF text';
  const bytes = fs.readFileSync(new URL('../deepfake/eula_deepfake.pdf', import.meta.url));
  const file = {name: 'renamed.pdf', type: 'application/pdf', size: bytes.length,
    arrayBuffer: async () => new Uint8Array(bytes).buffer};
  const pending = e.ctx.handleUploadedFile(file);
  for (let attempt=0; !finishAnalysis && attempt<30; attempt++) await tick();
  assert.ok(finishAnalysis, e.run("[...uploads.values()][0]?.uploadError"));
  const active = '[...uploads.values()][0]';
  e.run(`openUpload(${active}, ${active}.previewCategory)`);
  assert.match(e.get('cat-video').src, /deepfake\/videos\/permitted-use.mp4$/);
  assert.equal(e.get('cat-title').textContent, 'Permitted Use');
  finishAnalysis({result: {analysis: {categories: [
    {id:'permitted-use', title:'Permitted Use'}, {id:'access-control', title:'Access Control'}
  ]}}});
  await pending; await tick();
  assert.equal(e.run('categories.length'), 2);
  assert.equal(e.run('categories[0] === currentRun.previewCategory'), true);
  const media = requests.filter(r => r.body.category);
  assert.deepEqual(media.map(r => r.body.category.id), ['access-control','access-control']);
  assert.deepEqual(Array.from(requests.find(r => r.body.categories).body.categories, c => c.id), ['access-control']);
  assert.equal(e.run('runStore.load().deepfakePreview'), true);

  const changed = new Uint8Array(bytes); changed[100] ^= 1;
  void e.ctx.handleUploadedFile({...file, name:'EULA_Explainable_Deepfake_Detection_Challenge_2026.pdf', arrayBuffer:async()=>changed.buffer});
  await tick(); await tick();
  assert.equal(e.run('[...uploads.values()][1].previewCategory'), undefined);
});
