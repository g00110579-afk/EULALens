import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'eulalens-presentation-'));
process.env.PRESENTATION_PRECOMPUTED_ROOT=root;
const slug='01-test';const dir=path.join(root,'documents',slug);fs.mkdirSync(dir,{recursive:true});
const text='These are complete contract terms. '.repeat(60)+'Only personal use is permitted.';
fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({documents:[{slug,title:'Known.pdf'}]}));
fs.writeFileSync(path.join(dir,'extracted_text.txt'),text);
fs.writeFileSync(path.join(dir,'precomputed.json'),JSON.stringify({source:{title:'Known.pdf'},categories:[{id:'partial',title:'Missing video',sourceSegments:['Only personal use is permitted.'],cards:[],comic:[],video:{},precompute:{video:'error'}}]}));
const {buildPresentationAnalysis}=await import('../server/presentationMode.js');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('familiar filename and matching prefix cannot select a different document',()=>{
 assert.equal(buildPresentationAnalysis({fileName:'Known.pdf',text:'A completely different contract document.'}),null);
 assert.equal(buildPresentationAnalysis({fileName:'Other.pdf',text:text.slice(0,1500)+'Commercial use is permitted.'}),null);
});
test('full normalized content identity retains categories with missing media',()=>{
 const result=buildPresentationAnalysis({fileName:'Renamed.pdf',text:text.replaceAll(' ', '\n')});
 assert.equal(result.presentation.matchedBy,'content-sha256');assert.equal(result.categories.length,1);
 assert.equal(result.categories[0].cardsStatus,'pending');assert.equal(result.categories[0].mediaAvailability.video,false);
});
