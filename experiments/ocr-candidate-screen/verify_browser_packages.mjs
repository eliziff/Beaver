import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url)),browserRoot=resolve(root,'legal-browser-ocr');
const require=createRequire(resolve(browserRoot,'package.json'));
const {createCanvas}=require('@napi-rs/canvas');
const {getDocument}=await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const directory=resolve(process.argv[2]);
const family=process.argv[3];
assert.ok(!family||['speed','recognizer-speed','speed-followup','speed-frontier','speed-pipeline'].includes(family));
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const normalized=s=>s.replace(/[\u00ad\u00ac]\r?\n/g,'').normalize('NFKC').replace(/[\u00ad\u00ac]/g,'').replace(/\s+/gu,' ').trim();
const load=path=>getDocument({data:Uint8Array.from(readFileSync(path))}).promise;
async function pixels(doc){
  const page=await doc.getPage(1),view=page.getViewport({scale:1}),canvas=createCanvas(Math.ceil(view.width),Math.ceil(view.height));
  await page.render({canvasContext:canvas.getContext('2d'),viewport:view}).promise;
  return Buffer.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data);
}
const input=resolve(directory,'../../inputs/input.pdf');
const original=await load(input),originalPixels=await pixels(original),result={scenarios:{},packages:{}};
const scenarios=family?readdirSync(resolve(directory,family),{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>family+'/'+entry.name):['hosted/quality','hosted/turbo','standalone/quality','standalone/turbo','layout-75-trim'];
const pools=resolve(directory,'pools');
if(!family&&existsSync(pools))scenarios.push(...readdirSync(pools,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>'pools/'+entry.name));
const packages=new Map();
try{
  for(const scenario of scenarios){
    if(!existsSync(resolve(directory,scenario,'results.json'))){
      const failure=resolve(directory,scenario,'failure.json');
      assert.ok(existsSync(failure),scenario+': missing completed result or failure receipt');
      result.scenarios[scenario]={failed:true,...JSON.parse(readFileSync(failure))};
      continue;
    }
    const receipt=JSON.parse(readFileSync(resolve(directory,scenario,'results.json')));
    assert.equal(receipt.input_pdf_sha256,hash(input));
    const checked={};
    for(const[id,entry]of Object.entries(receipt.models)){
      const variant=receipt.protocol.query.package||'',pack=receipt.protocol.query.pack,kernels=receipt.protocol.query.kernels,noPreviews=receipt.protocol.query.noPreviewsPackage==='1',suffix=(id==='kraken'?'':'-'+id)+(variant?'-'+variant:'')+(pack?'-'+pack:'')+(kernels?'-'+kernels:'')+(noPreviews?'-no-previews':'');
      packages.set(id+(variant?'-'+variant:'')+(pack?'-'+pack:'')+(kernels?'-'+kernels:'')+(noPreviews?'-no-previews':''),{id,suffix,pack,kernels,speed:variant.endsWith('-speed')});
      if(family)assert.equal(entry.standalone_sha256,hash(resolve(browserRoot,'dist/legal-browser-ocr'+suffix+'.html')));
      assert.ok([3,7].includes(receipt.protocol.rounds));
      assert.equal(entry.runs.length,receipt.protocol.rounds);
      assert.ok(entry.path_parity.equal&&entry.offline_standalone.png_characters>100);
      for(const run of entry.runs.slice(1))assert.deepEqual(entry.runs[0].texts,run.texts);
      const exported=await load(resolve(directory,scenario,id+'-searchable.pdf'));
      let whitespaceDifferences=0;
      try{
        assert.equal(exported.numPages,receipt.protocol.pages);
        for(let i=0;i<exported.numPages;i++){
          const content=await(await exported.getPage(i+1)).getTextContent({disableNormalization:true});
          const text=normalized(content.items.filter(item=>'str'in item).map(item=>item.str+(item.hasEOL?'\n':'')).join(''));
          const expected=normalized(entry.runs[0].texts[i]);
          // PDF viewers infer visual line boundaries; plain OCR also joins
          // discretionary wraps. Check character retention separately from spaces.
          assert.ok(text.replace(/\s/gu,'')===expected.replace(/\s/gu,''),scenario+'/'+id+': normalized text lost on page '+(i+1));
          whitespaceDifferences+=Number(text!==expected);
        }
        assert.ok((await pixels(exported)).equals(originalPixels),scenario+'/'+id+': original page pixels changed');
        checked[id]={normalized_nonwhitespace_text_pages:exported.numPages,pages_with_visual_whitespace_differences:whitespaceDifferences,preserved_first_page_pixels:true};
      }finally{await exported.destroy()}
    }
    result.scenarios[scenario]=checked;
    console.log(scenario+': PDF text and original-page pixels verified');
  }
}finally{await original.destroy()}
for(const[key,{id,suffix,pack,kernels,speed}]of packages){
  const html=resolve(browserRoot,'dist/legal-browser-ocr'+suffix+'.html');
  const archive=resolve(browserRoot,'dist/legal-browser-ocr'+suffix+'-runtime.tar.gz');
  result.packages[key]={standalone_sha256:hash(html),standalone_bytes:statSync(html).size,archive_sha256:hash(archive),archive_bytes:statSync(archive).size,
    model_sha256:hash(resolve(browserRoot,pack?'assets/indra-followup/'+pack+'/model.onnx':id==='kraken'?'assets/model.ort':'assets/'+id+(speed?'-speed':'')+'/model.onnx'))};
  if(kernels)result.packages[key].wasm_sha256=hash(resolve(browserRoot,`assets/indra-kernels/${kernels}/ort-wasm-simd-threaded.wasm`));
}
result.source_sha256=Object.fromEntries(['app.js','recognition-worker.js','recognizer.js','tesseract-layout.js','tesseract-layout-worker.js','build-runtime.mjs','build-single-html.mjs','experiments/ocr-speed/preview.js','experiments/ocr-speed/session-options.js','experiments/ocr-speed/detector-worker.js','experiments/ocr-speed/detector-post.js'].map(name=>[name,hash(resolve(browserRoot,name))]));
result.runtime={app_sha256:hash(resolve(browserRoot,'dist/app.js')),recognition_worker_sha256:hash(resolve(browserRoot,'dist/recognition-worker.js')),
  full_wasm_sha256:hash(resolve(browserRoot,'dist/ort-wasm-simd-threaded.wasm')),kraken_compact_wasm_sha256:hash(resolve(browserRoot,'assets/ort.wasm'))};
if(family){
  result.runtime.detector_worker_sha256=hash(resolve(browserRoot,'dist/detector-worker.js'));
  result.runtime.reduced_wasm_sha256=hash(resolve(browserRoot,'assets/reduced/ort-wasm-simd-threaded.wasm'));
  result.runtime.reduced_loader_sha256=hash(resolve(browserRoot,'assets/reduced/ort-wasm-simd-threaded.mjs'));
  result.detector_assets_sha256=Object.fromEntries(['config.json','indra/model.onnx','indra/meta.json','indra/source.json','paddle/model.onnx','paddle/inference.yml','paddle/source.json'].map(name=>[name,hash(resolve(browserRoot,'assets/detectors',name))]));
  for(const scenario of scenarios){
    if(!existsSync(resolve(directory,scenario,'results.json')))continue;
    const receipt=JSON.parse(readFileSync(resolve(directory,scenario,'results.json')));
    for(const[name,value]of Object.entries(receipt.source_sha256))assert.equal(value,result.source_sha256[name],scenario+': source changed: '+name);
  }
  result.paired_output={};
  const pairs=[['preview-control-before','no-previews'],['no-previews','preview-control-after'],['kernel-control-before','kernel-control-after'],['control-before','control-after'],['control-before','turbo-sgemm'],['c64-baseline','c64-sgemm'],['student8-full','student8-sgemm'],['student8-sgemm','student8-pool4'],['control-before','thumbnail'],['thumbnail','reduced-indra'],['crnn-full','reduced-crnn'],['indra-detector','reduced-indra-detector'],['indra-detector-768','reduced-indra-detector-768']];
  const balanced=resolve(directory,family,'kernel-balanced/results.json');
  if(existsSync(balanced)&&JSON.parse(readFileSync(balanced)).protocol.query.kernels==='sgemm4dw')pairs.push(['kernel-control-before','kernel-balanced']);
  for(const[a,b]of pairs){
    const paths=[a,b].map(name=>resolve(directory,family,name,'results.json'));
    if(paths.some(path=>!existsSync(path)))continue;
    const[x,y]=paths.map(path=>Object.values(JSON.parse(readFileSync(path)).models)[0]);
    assert.deepEqual(x.runs[0].texts,y.runs[0].texts,a+'/'+b);
    assert.deepEqual(x.runs[0].stages.map(stage=>stage.layout_boxes),y.runs[0].stages.map(stage=>stage.layout_boxes),a+'/'+b);
    assert.deepEqual(x.layout_lines,y.layout_lines,a+'/'+b);
    result.paired_output[a+'/'+b]={identical_text:true,identical_raw_and_recognized_line_geometry:true};
  }
  if(family==='recognizer-speed'){
    const load=name=>Object.values(JSON.parse(readFileSync(resolve(directory,family,name,'results.json'))).models)[0];
    const control=load('before-quality');
    for(const name of ['before-turbo','trained-turbo','after-quality']){
      assert.deepEqual(control.runs[0].stages.map(stage=>stage.layout_boxes),load(name).runs[0].stages.map(stage=>stage.layout_boxes),name+': detection changed');
      result.paired_output['before-quality/'+name]={identical_raw_line_geometry:true};
    }
    assert.deepEqual(control.runs[0].texts,load('after-quality').runs[0].texts);
  }
  if(family==='speed-followup'){
    const load=name=>Object.values(JSON.parse(readFileSync(resolve(directory,family,name,'results.json'))).models)[0];
    const control=load('before-turbo');
    for(const name of ['after-turbo','ids','arena','arena-pattern','opt-basic','opt-extended','sorted16','sorted8','sorted4','sorted32','bucket64','pagebatch2','pagebatch2-sorted','pagebatch2-bucket64','pagebatch3','pagebatch2-pool4','pagebatch2-pool8','reduced-turbo','repeat-ids','repeat-turbo']){
      if(!existsSync(resolve(directory,family,name,'results.json')))continue;
      const candidate=load(name);
      assert.deepEqual(candidate.runs[0].stages.map(stage=>stage.layout_boxes),control.runs[0].stages.map(stage=>stage.layout_boxes),name+': detection changed');
      assert.deepEqual(candidate.runs[0].texts,control.runs[0].texts,name+': text changed');
      result.paired_output['before-turbo/'+name]={identical_raw_line_geometry:true,identical_text:true};
    }
    for(const[a,b]of [['student6','student6ids'],['student8','student8ids'],['student6','reduced-student6'],['quality','reduced-quality']]){
      if(!existsSync(resolve(directory,family,b,'results.json')))continue;
      const[x,y]=[load(a),load(b)];
      assert.deepEqual(x.runs[0].texts,y.runs[0].texts,a+'/'+b+': text changed');
      assert.deepEqual(x.runs[0].stages.map(stage=>stage.layout_boxes),y.runs[0].stages.map(stage=>stage.layout_boxes),a+'/'+b+': detection changed');
      result.paired_output[a+'/'+b]={identical_raw_line_geometry:true,identical_text:true};
    }
  }
}
writeFileSync(resolve(directory,family||'','verification.json'),JSON.stringify(result,null,2)+'\n');
