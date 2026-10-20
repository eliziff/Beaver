import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,dirname,sep} from 'node:path';

const root=resolve(import.meta.dirname,'../..'),owner=resolve(root,'legal-browser-ocr');
const [kind,baseName='legal-browser-ocr.html']=process.argv.slice(2);
assert.ok(['jsep','asyncify','jspi'].includes(kind));
const cache=resolve(owner,'assets/ort-web-1.30.0'),dist=resolve(owner,'dist');
const basePath=resolve(dist,baseName);assert.ok(basePath.startsWith(dist+sep));
const provenance=JSON.parse(readFileSync(resolve(cache,'source.json'),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const [name,hash] of Object.entries(provenance.sha256))assert.equal(sha(readFileSync(resolve(cache,name))),hash,name);
const stage=resolve(dist,'gpu-runtime-source'),compiled=resolve(dist,'gpu-runtime-'+kind);
const sources=['recognition-worker.js','recognizer.js','text-layer.js','experiments/ocr-speed/gpu-argmax.js',
  'experiments/ocr-speed/detector-worker.js','experiments/ocr-speed/detector-post.js'];
const sourceHashes={};
for(const file of sources){
  const source=resolve(owner,file),target=resolve(stage,file);assert.ok(target.startsWith(stage+sep));
  mkdirSync(dirname(target),{recursive:true});copyFileSync(source,target);sourceHashes[file]=sha(readFileSync(source));
}
const api=resolve(cache,'dist',kind==='jsep'?'ort.min.mjs':kind==='jspi'?'ort.jspi.min.mjs':'ort.webgpu.min.mjs');
const {build}=createRequire(resolve(owner,'package.json'))('esbuild');
await build({entryPoints:[resolve(stage,'recognition-worker.js'),resolve(stage,'experiments/ocr-speed/detector-worker.js')],
  outdir:compiled,entryNames:'[name]',bundle:true,minify:true,format:'iife',legalComments:'inline',
  alias:{'onnxruntime-web/webgpu':api},define:{'import.meta.url':'globalThis.location.href'},logLevel:'warning'});
let html=readFileSync(basePath,'utf8');const baseHash=sha(Buffer.from(html));
function swap(key,bytes){
  const pattern=new RegExp('"'+key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'":"([^"]*)"','g');
  const matches=[...html.matchAll(pattern)];assert.equal(matches.length,1,key);
  const original=Buffer.from(matches[0][1],'base64');
  if(bytes)html=html.replace(pattern,()=>JSON.stringify(key)+':'+JSON.stringify(bytes.toString('base64')));
  return original;
}
const manifest=JSON.parse(swap('packageNotice').toString('utf8'));
for(const [key,target,bytes] of [
  ['recognitionWorker','dist/recognition-worker.js',readFileSync(resolve(compiled,'recognition-worker.js'))],
  ['detectorWorker','dist/detector-worker.js',readFileSync(resolve(compiled,'detector-worker.js'))],
  ['gpuMjs','dist/ort-wasm-simd-threaded.jsep.mjs',readFileSync(resolve(cache,`dist/ort-wasm-simd-threaded.${kind}.mjs`))],
  ['gpuWasm','dist/ort-wasm-simd-threaded.jsep.wasm',readFileSync(resolve(cache,`dist/ort-wasm-simd-threaded.${kind}.wasm`))],
]){swap(key,bytes);manifest.assets[target]={bytes:bytes.length,sha256:sha(bytes)};}
manifest.experimental_gpu_runtime={version:'1.30.0',kind,provenance};
swap('packageNotice',Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
const output=resolve(dist,`runtime-speed-ort130-${kind}.html`);writeFileSync(output,html);
const receipt={origin:'machine_test',run_id:randomUUID(),kind,base_html_sha256:baseHash,
  html_sha256:sha(Buffer.from(html)),sources:sourceHashes,provenance};
writeFileSync(output.replace('.html','.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({output,sha256:receipt.html_sha256,bytes:Buffer.byteLength(html)}));
