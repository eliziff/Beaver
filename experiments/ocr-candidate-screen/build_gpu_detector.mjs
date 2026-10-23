import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';

const root=resolve(import.meta.dirname,'../..'),owner=resolve(root,'legal-browser-ocr');
const variant=process.argv[2];
assert.ok(['gpu-fp32','gpu-fp16','student','middle','middle-dice','middle-fast'].includes(variant),'Select a GPU detector or a trained student variant');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const trained=['student','middle','middle-dice','middle-fast'].includes(variant);
const path=trained?resolve(root,'benchmarks/local-data/ocr-candidate-screen',`detector-${variant}`):resolve(owner,'assets/detectors',variant);
const model=readFileSync(resolve(path,'model.onnx'));
const metadata=JSON.parse(readFileSync(resolve(path,trained?'results.json':'source.json'),'utf8'));
const source=trained?{sha256:metadata.model_sha256,source:{sha256:metadata.inputs.teacher_sha256},
  parameters:metadata.parameters,selected_epoch:metadata.selected_epoch,training_audit:metadata.inputs.splits,
  architecture:metadata.architecture,input_side:metadata.inputs.side,
  refinement:metadata.refinement,
  core_calibration:metadata.core_calibration,
  export_parity_passed:metadata.export_parity_passed,training_receipt_sha256:sha(Buffer.from(JSON.stringify(metadata)))}:metadata;
if(trained)assert.equal(source.export_parity_passed,true);
assert.equal(sha(model),source.sha256);
const basePath=resolve(owner,'dist',process.argv[3]||'legal-browser-ocr.html');
assert.ok(basePath.startsWith(resolve(owner,'dist')+'/')||basePath.startsWith(resolve(owner,'dist')+'\\'));
const base=readFileSync(basePath,'utf8');
const compressed=new Set(JSON.parse(base.match(/globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=(\[[^;]*\]);/)?.[1]||'[]'));
function embedded(key){
  const matches=[...base.matchAll(new RegExp(`"${key}":"([^"]*)"`,'g'))];
  assert.equal(matches.length,1);
  const bytes=Buffer.from(matches[0][1],'base64');
  return {match:matches[0][0],bytes:compressed.has(key)?gunzipSync(bytes):bytes};
}
const original=embedded('indraDetector'),notice=embedded('packageNotice');
assert.equal(sha(original.bytes),source.source.sha256);
const manifest=JSON.parse(notice.bytes.toString('utf8'));
manifest.detector={...manifest.detector,sha256:sha(model),experimental_variant:variant,modifications:source};
manifest.assets[manifest.detector.path]={bytes:model.length,sha256:sha(model)};
const encode=(key,bytes)=>(compressed.has(key)?gzipSync(bytes,{level:9}):bytes).toString('base64');
const html=base.replace(original.match,()=>`"indraDetector":"${encode('indraDetector',model)}"`)
  .replace(notice.match,()=>`"packageNotice":"${encode('packageNotice',Buffer.from(JSON.stringify(manifest,null,2)+'\n'))}"`);
const output=resolve(owner,`dist/runtime-speed-detector-${variant}.html`);
writeFileSync(output,html);
const receipt={origin:'machine_test',run_id:randomUUID(),variant,base_html_sha256:sha(Buffer.from(base)),
  html_sha256:sha(Buffer.from(html)),detector_sha256:sha(model),source};
writeFileSync(output.replace('.html','.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({output,sha256:receipt.html_sha256,detector_sha256:receipt.detector_sha256}));
