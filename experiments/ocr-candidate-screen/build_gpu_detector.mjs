import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'../..'),owner=resolve(root,'legal-browser-ocr');
const variant=process.argv[2];
assert.ok(['gpu-fp32','gpu-fp16'].includes(variant),'Select gpu-fp32 or gpu-fp16');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const path=resolve(owner,'assets/detectors',variant),model=readFileSync(resolve(path,'model.onnx'));
const source=JSON.parse(readFileSync(resolve(path,'source.json'),'utf8'));
assert.equal(sha(model),source.sha256);
const basePath=resolve(owner,'dist',process.argv[3]||'legal-browser-ocr.html');
assert.ok(basePath.startsWith(resolve(owner,'dist')+'/')||basePath.startsWith(resolve(owner,'dist')+'\\'));
const base=readFileSync(basePath,'utf8');
function embedded(key){
  const matches=[...base.matchAll(new RegExp(`"${key}":"([^"]*)"`,'g'))];
  assert.equal(matches.length,1);
  return {match:matches[0][0],bytes:Buffer.from(matches[0][1],'base64')};
}
const original=embedded('indraDetector'),notice=embedded('packageNotice');
assert.equal(sha(original.bytes),source.source.sha256);
const manifest=JSON.parse(notice.bytes.toString('utf8'));
manifest.detector={...manifest.detector,sha256:sha(model),experimental_variant:variant,modifications:source};
manifest.assets[manifest.detector.path]={bytes:model.length,sha256:sha(model)};
const html=base.replace(original.match,()=>`"indraDetector":"${model.toString('base64')}"`)
  .replace(notice.match,()=>`"packageNotice":"${Buffer.from(JSON.stringify(manifest,null,2)+'\n').toString('base64')}"`);
const output=resolve(owner,`dist/runtime-speed-detector-${variant}.html`);
writeFileSync(output,html);
const receipt={origin:'machine_test',run_id:randomUUID(),variant,base_html_sha256:sha(Buffer.from(base)),
  html_sha256:sha(Buffer.from(html)),detector_sha256:sha(model),source};
writeFileSync(output.replace('.html','.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({output,sha256:receipt.html_sha256,detector_sha256:receipt.detector_sha256}));
