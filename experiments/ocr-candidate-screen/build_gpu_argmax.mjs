import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';

const root=resolve(import.meta.dirname,'../..'),owner=resolve(root,'legal-browser-ocr');
const variant=process.argv[2]||'argmax';
assert.ok(['argmax','capture'].includes(variant));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
let html=readFileSync(resolve(owner,'dist/legal-browser-ocr.html'),'utf8');
const compressed=new Set(JSON.parse(html.match(/globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=(\[[^;]*\]);/)?.[1]||'[]'));
const base=sha(Buffer.from(html));
function asset(key,bytes){
  const pattern=new RegExp('"'+key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'":"([^"]*)"','g');
  const matches=[...html.matchAll(pattern)];assert.equal(matches.length,1,key);
  const original=Buffer.from(matches[0][1],'base64');
  if(bytes)html=html.replace(pattern,()=>JSON.stringify(key)+':'+JSON.stringify((compressed.has(key)?gzipSync(bytes,{level:9}):bytes).toString('base64')));
  return compressed.has(key)?gunzipSync(original):original;
}
const notice=JSON.parse(asset('packageNotice').toString('utf8')),sources={};
for(const [kind,name] of [['standard','gpu8h'],['light','gpu64h']]){
  const folder=resolve(owner,'assets/indra-followup',name+'-'+variant);
  const model=readFileSync(resolve(folder,'model.onnx')),source=JSON.parse(readFileSync(resolve(folder,'source.json'),'utf8'));
  assert.equal(sha(model),source.model_sha256);
  assert.ok(source.logit_parity_passed===true||variant==='capture'&&source.checks.length===3&&source.checks.every(check=>check.logits_exact));
  const key=notice.models[kind].gpu.path;
  assert.equal(sha(asset(key,model)),source.original_model_sha256);
  notice.models[kind].gpu.sha256=sha(model);notice.assets[key]={bytes:model.length,sha256:sha(model)};
  sources[kind]=source;
}
notice['experimental_gpu_'+variant]={query:variant==='capture'?'gpuCapture=1':'gpuArgMax=128',sources};
asset('packageNotice',Buffer.from(JSON.stringify(notice,null,2)+'\n'));
const output=resolve(owner,`dist/runtime-speed-gpu-${variant}.html`);
writeFileSync(output,html);
const receipt={origin:'machine_test',run_id:randomUUID(),base_html_sha256:base,html_sha256:sha(Buffer.from(html)),sources};
writeFileSync(output.replace('.html','.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({output,sha256:receipt.html_sha256}));
