import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWithQwen, generateCardsWithQwen, generateCardsBatchWithQwen, generateComicWithQwen, generateVideoScriptWithQwen } from '../server/providers/qwen.js';
import { positiveInteger, withQwenSlot } from '../server/providers/qwen-runtime.js';
const originalFetch=globalThis.fetch;
const originalEnv={...process.env};
const success=(content,finish_reason='stop')=>new Response(JSON.stringify({choices:[{finish_reason,message:{content:typeof content==='string'?content:JSON.stringify(content)}}]}),{headers:{'content-type':'application/json'}});
const card={id:'card',question:'May I use it?',answer:'Use',frontDetail:'Check the permitted purpose.',backDetail:'Read every stated condition.'};
const source='You must immediately notify us of unauthorized use.';
const category={id:'notice',title:'Notice',sourceSegments:[source]};
function configure(){
 process.env.QWEN_API_KEY='test-only';process.env.QWEN_BASE_URL='http://qwen.test/v1';
 process.env.QWEN_TOKENIZER_MODE='auto';process.env.QWEN_CONTEXT_TOKENS='16384';
 process.env.QWEN_GLOBAL_CONCURRENCY='3';process.env.QWEN_CARD_BATCH_CONCURRENCY='3';
 process.env.QWEN_REQUEST_TIMEOUT_MS='2000';process.env.QWEN_CHUNK_CHARS='3500';process.env.QWEN_MAX_TOKENS='2400';
 delete process.env.QWEN_MAX_ATTEMPTS;
}
function mockCompletion(fn){globalThis.fetch=async(url,options)=>url.endsWith('/tokenize')?new Response(JSON.stringify({count:100}),{headers:{'content-type':'application/json'}}):fn(url,options);}
function videoPlan(){return{model_prompt:'A clean 2D animated educational story with simple flat-shaded characters, plain background, bare walls, simple props and stable composition. No readable text, no labels, no model-generated subtitles, no document words, no logos. A user attempts to open a folder, a reviewer checks a token and the user chooses an approved path.',story_goal:'Understand the notice obligation.',shot_plan:Array.from({length:5},(_,i)=>({start_seconds:i*6,end_seconds:(i+1)*6,visual_beat:'A user opens a folder.',legal_point:source})),subtitle_lines:Array.from({length:5},(_,i)=>({start_seconds:i*6,end_seconds:(i+1)*6,speaker:'User',text:source}))};}
test.beforeEach(configure);
test.afterEach(()=>{globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in originalEnv))delete process.env[key];Object.assign(process.env,originalEnv);});

test('extraction preserves observed low severity and attaches verifiable source spans',async()=>{
 mockCompletion(async()=>success({categories:[{category_id:'termination',severity:'low',source_ranges:[[1,1]]}]}));
 const result=await analyzeWithQwen({text:source,fileName:'sample.txt'});
 assert.equal(result.categories[0].severity,'low');
 const evidence=result.categories[0].sourceEvidence[0];
 assert.equal(source.slice(evidence.start,evidence.end),evidence.text);assert.match(evidence.id,/^evidence-/);
});

test('fabricated quotations fail instead of being marked source-backed',async()=>{
 const bodies=[];mockCompletion(async(_url,options)=>{bodies.push(options.body);return success({categories:[{category_id:'refund',source_segments:['A fabricated refund obligation.']}]});});
 await assert.rejects(analyzeWithQwen({text:source}),/source-grounded JSON/);
 assert.equal(bodies.length,3);assert.notEqual(bodies[0],bodies[1]);
});

test('numbered passages retain original PDF text, wrapped conditions and the selected occurrence',async()=>{
 const input='No redistribution.\n😀 Non - commercial   use is allowed\nonly with written permission.\nNo redistribution.';
 let attempts=0;
 mockCompletion(async(_url,options)=>{
  const messages=JSON.parse(options.body).messages;
  assert.match(messages[1].content,/\[2\] 😀 Non - commercial use is allowed only with written permission\./);
  const ranges=++attempts===1 ? [[2,4]] : [[2,2],[3,3]];
  return success({categories:[{category_id:'permitted_use',source_ranges:ranges}]});
 });
 const {categories}=await analyzeWithQwen({text:input});
 const evidence=categories[0].sourceEvidence;
 assert.equal(attempts,2);
 assert.deepEqual(evidence.map(item=>item.text),['😀 Non - commercial   use is allowed\nonly with written permission.','No redistribution.']);
 assert.equal(evidence[1].start,input.lastIndexOf('No redistribution.'));
 assert(evidence.every(item=>input.slice(item.start,item.end)===item.text));
});

test('rechecks an empty extraction of a short license with a wrapped device limit', async () => {
  const text = 'The user may install this fictional software on one device only. A separate\r\nlicense is required to install the software on an additional device.';
  let attempts = 0;
  mockCompletion(async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[1].content;
    assert.match(prompt, /\[2\] A separate license is required/);
    if (++attempts === 1) return success({ categories: [] });
    assert.match(prompt, /explicit rule/);
    return success({ categories: [{ category_id: 'device_limit', source_ranges: [[1, 2]] }] });
  });
  const { categories } = await analyzeWithQwen({ text });
  assert.equal(attempts, 2);
  assert.equal(categories[0].sourceEvidence[0].text, text);
});

test('a normative keyword alone cannot turn empty model results into a license rule', async () => {
  let attempts = 0;
  mockCompletion(async () => { attempts++; return success({ categories: [] }); });
  await assert.rejects(analyzeWithQwen({ text: 'The heading is “Required notices”.' }), { code: 'NO_SUPPORTED_CATEGORIES' });
  assert.equal(attempts, 2);
  await assert.rejects(analyzeWithQwen({ text: 'Copyright information. Table of contents.' }), { code: 'NO_SUPPORTED_CATEGORIES' });
  assert.equal(attempts, 3);
});

test('overlapping chunks can use different category names for the same source range',async()=>{
 process.env.QWEN_CHUNK_CHARS='120';
 const text='Background. '.repeat(8)+'Keep a backup.'+' More context.'.repeat(10);
 let hits=0;
 mockCompletion(async(_url,options)=>{
  const prompt=JSON.parse(options.body).messages.find(m=>m.role==='user').content;
  const match=prompt.match(/^\[(\d+)\] Keep a backup\.$/m);
  if(!match)return success({categories:[]});
  const id=Number(match[1]);
  return success({categories:[{category_id:++hits===1?'backup':'backup_copy',summary:'Observation '+hits,source_ranges:[[id,id]]}]});
 });
 const {categories}=await analyzeWithQwen({text});
 assert.equal(hits,2);assert.equal(categories.length,1);
 assert.equal(categories[0].sourceEvidence.length,1);
 assert.match(categories[0].summary,/Observation 1/);assert.match(categories[0].summary,/Observation 2/);
});

test('all nine evidence segments reach cards and video prompts',async()=>{
 const longCategory={...category,sourceSegments:Array.from({length:9},(_,i)=>`Evidence ${i+1}: condition ${i+1} applies.`)};
 let prompt='';mockCompletion(async(_url,options)=>{prompt=JSON.parse(options.body).messages.at(-1).content;return success({cards:[card]});});
 const result=await generateCardsWithQwen({category:longCategory});
 assert.match(prompt,/Evidence 9/);assert.equal(result.evidenceCoverage.omitted,0);
 const prompts=[];mockCompletion(async(_url,options)=>{prompts.push(JSON.parse(options.body).messages.map(m=>m.content).join('\n'));return success(videoPlan());});
 await generateVideoScriptWithQwen({category:longCategory});assert(prompts.every(p=>p.includes('Evidence 9')));
});

test('supported immediate notice obligations keep their meaning in generated dialogue',async()=>{
 mockCompletion(async()=>success(videoPlan()));
 const {video}=await generateVideoScriptWithQwen({category});
 assert.equal(video.subtitleLines[0].text,source);assert.equal(video.shotPlan[0].legalPoint,source);
});

test('empty video and one-scene comic are rejected after attempted repairs',async()=>{
 mockCompletion(async()=>success({model_prompt:'A cat walks.'}));
 await assert.rejects(generateVideoScriptWithQwen({category}),e=>e.code==='QWEN_INVALID_PLAN');
 mockCompletion(async()=>success({comics:[{id:'one',scenes:[{narration:'A user opens a folder.',visual_description:'A user opens a folder.'}]}]}));
 await assert.rejects(generateComicWithQwen({category}),e=>e.code==='QWEN_INVALID_PLAN');
});

test('truncation increases output budget instead of resending the same request',async()=>{
 const budgets=[];mockCompletion(async(_url,options)=>{budgets.push(JSON.parse(options.body).max_tokens);return budgets.length===1?success('{"categories":[','length'):success({categories:[{category_id:'notice',source_ranges:[[1,1]]}]});});
 await analyzeWithQwen({text:source});assert.deepEqual(budgets,[2400,4800]);
});

test('whole evidence that exceeds context receives an explicit error',async()=>{
 let calls=0;process.env.QWEN_TOKENIZER_MODE='conservative';process.env.QWEN_CONTEXT_TOKENS='3000';
 globalThis.fetch=async()=>{calls++;return success({cards:[card]});};
 await assert.rejects(generateCardsWithQwen({category:{...category,sourceSegments:['Evidence '.repeat(2000)]}}),e=>e.code==='QWEN_INPUT_TOO_LARGE'&&e.status===413);
 assert.equal(calls,0);
});

test('global concurrency bounds simultaneous batches and reports settled progress',async()=>{
 let active=0,peak=0;const progress=[];
 mockCompletion(async(_url,options)=>{active++;peak=Math.max(peak,active);const slow=JSON.parse(options.body).messages.at(-1).content.includes('Slow');await new Promise(r=>setTimeout(r,slow?35:5));active--;return success({cards:[card]});});
 const cats=[{...category,id:'slow',title:'Slow'},{...category,id:'fast',title:'Fast'},{...category,id:'third',title:'Third'}];
 const [first,second]=await Promise.all([generateCardsBatchWithQwen({categories:cats,onProgress:r=>progress.push(r.categoryId)}),generateCardsBatchWithQwen({categories:cats})]);
 assert.equal(peak,3);assert.equal(first.length,3);assert.equal(second.length,3);assert.equal(progress[0],'fast');assert.deepEqual(first.map(x=>x.categoryId),cats.map(x=>x.id));
});

test('canceling a queued operation removes it without running inference',async()=>{
 process.env.QWEN_GLOBAL_CONCURRENCY='1';let release;let queuedRan=false;
 const first=withQwenSlot(()=>new Promise(resolve=>{release=resolve;}));await new Promise(r=>setTimeout(r,1));
 const controller=new AbortController();const second=withQwenSlot(()=>{queuedRan=true;},controller.signal);
 controller.abort();await assert.rejects(second,{name:'AbortError'});release();await first;assert.equal(queuedRan,false);
});

test('deadline remains active while response body is being read',async()=>{
 process.env.QWEN_REQUEST_TIMEOUT_MS='20';
 mockCompletion(async(_url,options)=>({ok:true,json:()=>new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});})}));
 await assert.rejects(generateCardsWithQwen({category}),e=>e.code==='QWEN_TIMEOUT');
});

test('fractional or zero concurrency/chunk configuration cannot become a zero-step loop',()=>{
 for(const value of ['0.5','0','-1','NaN'])assert.throws(()=>positiveInteger(value,3,'test'),/must be an integer/);
 assert.equal(positiveInteger(undefined,3),3);
});

test('merging chunks retains later summaries/conditions and exact input offsets',async()=>{
 process.env.QWEN_CHUNK_CHARS='60';let sequence=0;
 mockCompletion(async()=>{
  return success({categories:[{category_id:'license',severity:'low',summary:`Condition ${++sequence}.`,impact:`Impact ${sequence}.`,source_ranges:[[1,1]]}]});
 });
 const input='  Personal use is allowed under the license.\nCommercial use requires written permission from the owner.  ';
 const result=await analyzeWithQwen({text:input});const merged=result.categories[0];
 assert.equal(result.categories.length,1);assert.match(merged.summary,/Condition 1/);assert.match(merged.summary,/Condition 2/);
 assert(merged.sourceEvidence.every(e=>input.slice(e.start,e.end)===e.text));assert.equal(merged.sourceEvidence[0].start,2);
});


test('mandatory no-document-text instruction does not force a redundant video repair',async()=>{
 let requests=0;mockCompletion(async()=>{requests++;return success(videoPlan());});
 const {video}=await generateVideoScriptWithQwen({category});
 assert.equal(requests,1);assert.equal(video.subtitleLines.length,5);
 assert(!video.qualityWarnings.some(issue=>issue.startsWith('avoid stamps')));
});

test('unsupported legal claims cannot pass after repair exhaustion',async()=>{
 const plan=videoPlan();plan.subtitle_lines[0].text='You will pay a penalty.';
 mockCompletion(async()=>success(plan));
 await assert.rejects(generateVideoScriptWithQwen({category}),e=>e.code==='QWEN_INVALID_PLAN');
});


test('complete comic structure is not regenerated for advisory style preferences',async()=>{
 let requests=0;
 const plan={comics:[{id:'story',protagonist_goal:'Use the software for a personal project.',visual_read_through:'The user keeps a personal file private.',scenes:Array.from({length:4},(_,index)=>({scene_title:`Scene ${index+1}`,narration:'The user keeps a personal file.',visual_description:'A user holds a folder in a plain room.'}))}]};
 mockCompletion(async()=>{requests++;return success(plan);});
 const result=await generateComicWithQwen({category});
 assert.equal(requests,1);assert.equal(result.comic.scenes.length,4);assert(Array.isArray(result.comic.qualityWarnings));
});


test('completion transport failure is retried within the existing request deadline',async()=>{
 let calls=0;mockCompletion(async()=>{if(++calls===1)throw new TypeError('fetch failed');return success({cards:[card]});});
 const result=await generateCardsWithQwen({category});assert.equal(calls,2);assert.equal(result.cards.length,1);
});

test('transient tokenizer HTTP and transport failures recover before completion',async()=>{
 let tokenizeCalls=0,completionCalls=0;
 globalThis.fetch=async(url)=>{
  if(url.endsWith('/tokenize')){tokenizeCalls++;if(tokenizeCalls===1)return new Response('Busy',{status:503});if(tokenizeCalls===2)throw new TypeError('fetch failed');return new Response(JSON.stringify({count:100}));}
  completionCalls++;return success({cards:[card]});
 };
 await generateCardsWithQwen({category});assert.equal(tokenizeCalls,3);assert.equal(completionCalls,1);
});

test('overlapping boundary context keeps a split qualification with its permission and exact offsets',async()=>{
 process.env.QWEN_CHUNK_CHARS='120';const qualification='Personal use is allowed only with written consent.';
 const text='Context. '.repeat(10)+qualification+' Later background.'.repeat(10);const prompts=[];
 mockCompletion(async(_url,options)=>{
  const prompt=JSON.parse(options.body).messages.find(m=>m.role==='user').content;
  const chunk=prompt.slice(prompt.indexOf('\n\n')+2);prompts.push(chunk);
  const line=chunk.split('\n').find(item=>item.endsWith(qualification));
  const id=line ? Number(line.match(/^\[(\d+)\]/)[1]) : 1;
  return success({categories:[{category_id:'license',severity:'low',source_ranges:[[id,id]]}]});
 });
 const result=await analyzeWithQwen({text});assert(prompts.some(chunk=>chunk.includes(qualification)));
 const evidence=result.categories[0].sourceEvidence;assert(evidence.some(item=>item.text===qualification));
 assert(evidence.every(item=>text.slice(item.start,item.end)===item.text));assert.equal(new Set(evidence.map(item=>item.id)).size,evidence.length);
});

test('comic overlay wording and late legal qualifiers are preserved verbatim',async()=>{
 const wording='The term "public property" does not mean you sign away my rights.';
 const longLegal='A full explanation '.repeat(15)+'except when the author gives written permission.';
 const plan={comics:[{id:'story',protagonist_goal:'Understand the permission.',visual_read_through:'The user keeps a personal file.',scenes:Array.from({length:4},()=>({narration:longLegal,legal_point:longLegal,visual_description:'A user holds a folder in a plain room.',overlay_slots:[{kind:'speech',text:wording}]}))}]};
 mockCompletion(async()=>success(plan));const result=await generateComicWithQwen({category});const scene=result.comic.scenes[0];
 assert.equal(scene.overlaySlots[0].text,wording);assert.equal(scene.legalPoint,longLegal);assert.equal(scene.narration,longLegal);
 assert.equal(scene.dialogue,wording);assert.match(result.comic.imagePrompt,/holds a folder/);
});
test('comic summaries retain qualifiers and stay attached to their scenarios', async () => {
  const scene = { narration: 'A user opens a folder.', visual_description: 'A user holds a folder.' };
  const base = { id: 'first', protagonist_goal: 'Review a file.', visual_read_through: 'The user reviews a file.', scenes: Array(4).fill(scene) };
  const summary = 'The user carefully reviews the file and its conditions. '.repeat(7) + 'Permission depends on written consent.';
  let plan = { story_summary: summary, comics: [base] };
  mockCompletion(async () => success(plan));
  const single = await generateComicWithQwen({ category });
  assert.equal(single.comic.comics[0].storySummary, summary);
  plan = { story_summary: 'Two employees consider different ways of using a file.', comics: [{ ...base, story_summary: summary }, { ...base, id: 'second' }] };
  const multiple = await generateComicWithQwen({ category });
  assert.equal(multiple.comic.storySummary, plan.story_summary);
  assert.equal(multiple.comic.comics[0].storySummary, summary);
  assert.equal(multiple.comic.comics[1].storySummary, '');
});

test('null comic scenes fail validation cleanly rather than throwing a TypeError',async()=>{
 mockCompletion(async()=>success({comics:[{scenes:[null,null,null,null]}]}));
 await assert.rejects(generateComicWithQwen({category}),error=>error.code==='QWEN_INVALID_PLAN');
});
