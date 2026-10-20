import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'../..'),owner=resolve(root,'legal-browser-ocr');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
let html=readFileSync(resolve(owner,'dist/legal-browser-ocr.html'),'utf8');
const base=sha(Buffer.from(html));
function asset(key,bytes){
  const pattern=new RegExp('"'+key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'":"([^"]*)"','g');
  const matches=[...html.matchAll(pattern)];assert.equal(matches.length,1,key);
  const original=Buffer.from(matches[0][1],'base64');
  if(bytes)html=html.replace(pattern,()=>JSON.stringify(key)+':'+JSON.stringify(bytes.toString('base64')));
  return original;
}
const notice=JSON.parse(asset('packageNotice').toString('utf8')),sources={};
for(const [kind,name] of [['standard','gpu8h'],['light','gpu64h']]){
  const folder=resolve(owner,'assets/indra-followup',name+'-argmax');
  const model=readFileSync(resolve(folder,'model.onnx')),source=JSON.parse(readFileSync(resolve(folder,'source.json'),'utf8'));
  assert.equal(sha(model),source.model_sha256);assert.equal(source.logit_parity_passed,true);
  const key=notice.models[kind].gpu.path;
  assert.equal(sha(asset(key,model)),source.original_model_sha256);
  notice.models[kind].gpu.sha256=sha(model);notice.assets[key]={bytes:model.length,sha256:sha(model)};
  sources[kind]=source;
}
notice.experimental_gpu_argmax={workgroup_query:'gpuArgMax=128',sources};
asset('packageNotice',Buffer.from(JSON.stringify(notice,null,2)+'\n'));
const output=resolve(owner,'dist/runtime-speed-gpu-argmax.html');
writeFileSync(output,html);
const receipt={origin:'machine_test',run_id:randomUUID(),base_html_sha256:base,html_sha256:sha(Buffer.from(html)),sources};
writeFileSync(output.replace('.html','.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({output,sha256:receipt.html_sha256}));
