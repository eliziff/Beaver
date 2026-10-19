import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { cpus, freemem } from 'node:os';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url)),owner=resolve(root,'legal-browser-ocr');
const {chromium}=createRequire(resolve(root,'package.json'))('playwright');
const [manifestArg,outputArg,casesArg,...options]=process.argv.slice(2);
const runtimeArg=options.find(value=>!value.startsWith('--'));
const profileOnly=options.includes('--profile-only');
assert.ok(manifestArg&&outputArg&&casesArg,'usage: wasm_kernel_benchmark.mjs INPUT_MANIFEST OUTPUT CASE:1,CASE:.76 [RUNTIME_DIR]');
const manifestPath=resolve(manifestArg),inputs=dirname(manifestPath),output=resolve(outputArg);
const ort=resolve(owner,'node_modules/onnxruntime-web/dist'),runtime=runtimeArg?resolve(runtimeArg):ort;
const hash=value=>createHash('sha256').update(value).digest('hex');
const manifest=JSON.parse(readFileSync(manifestPath));
const component=manifest.head?resolve(owner,manifest.head.model):null;
assert.ok(!component||component.startsWith(resolve(owner,'assets/indra-kernels')+sep));
const cases=casesArg.split(',').map(value=>{
  const [name,scale,variant]=value.split(':');
  assert.match(name,/^[a-z0-9]+$/);assert.ok(['1','0.76','.76'].includes(scale));
  assert.ok(!variant||(variant==='fused'&&manifest.head));
  const file=component||resolve(owner,'assets/indra-followup',name,'model.onnx');
  return {name,key:name+(variant?'-'+variant:''),execution:variant?'fused-head':'ort',scale:String(Number(scale)),model_sha256:hash(readFileSync(file))};
});
for(const entries of Object.values(manifest.scales))for(const entry of entries){
  assert.match(entry.file,/^[a-zA-Z0-9.-]+$/);
  const bytes=readFileSync(resolve(inputs,entry.file));assert.equal(hash(bytes),entry.sha256);
  assert.equal(bytes.length,entry.dims.reduce((a,b)=>a*b,4));
}
let goldHead;
if(manifest.head){
  assert.equal(hash(readFileSync(component)),manifest.head.model_sha256);
  const ids=[];
  for(const entry of manifest.scales['1']){
    assert.equal(entry.dims[1],manifest.head.channels);assert.equal(entry.dims[2],1);
    assert.equal(entry.widths.length,entry.dims[0]);
    assert.ok(entry.widths.every(value=>Number.isSafeInteger(value)&&value>=0&&value<=entry.dims[3]));
    assert.match(entry.ids_file,/^[a-zA-Z0-9.-]+$/);
    const bytes=readFileSync(resolve(inputs,entry.ids_file));assert.equal(hash(bytes),entry.ids_sha256);
    const values=new Int32Array(Uint8Array.from(bytes).buffer),steps=entry.dims[3];
    for(let n=0;n<entry.widths.length;n++)for(let t=0;t<entry.widths[n];t++)ids.push(values[n*steps+t]);
  }
  goldHead=hash(Buffer.from(Uint32Array.from(ids).buffer));
  for(const entry of [manifest.head.weight,manifest.head.bias]){
    assert.match(entry.file,/^[a-zA-Z0-9.-]+$/);assert.equal(hash(readFileSync(resolve(inputs,entry.file))),entry.sha256);
  }
}
mkdirSync(output,{recursive:true});
const server=createServer((request,response)=>{
  try{
    const path=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    if(path==='/'){response.writeHead(200,{'Content-Type':'text/html'}).end('<title>OCR CPU kernel measurement</title>');return;}
    const prefix=['/ort/','/runtime/','/inputs/','/assets/','/head/','/component/'].find(prefix=>path.startsWith(prefix));
    if(!prefix)throw Error('Unknown asset');
    const base={'/ort/':ort,'/runtime/':runtime,'/inputs/':inputs,'/assets/':resolve(owner,'assets/indra-followup'),'/head/':resolve(owner,'assets/indra-kernels/head'),'/component/':component&&dirname(component)}[prefix];
    if(!base)throw Error('No component model');
    const file=resolve(base,path.slice(prefix.length));if(!file.startsWith(base+sep))throw Error('Invalid asset path');
    response.writeHead(200,{'Content-Type':file.endsWith('.mjs')?'text/javascript':file.endsWith('.wasm')?'application/wasm':'application/octet-stream'}).end(readFileSync(file));
  }catch{response.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  const counters=()=>cpus().reduce((a,c)=>({idle:a.idle+c.times.idle,total:a.total+Object.values(c.times).reduce((x,y)=>x+y,0)}),{idle:0,total:0});
  const start=counters();await new Promise(resolve=>setTimeout(resolve,1000));const end=counters();
  const background={cpu_busy_percent:100*(1-(end.idle-start.idle)/(end.total-start.total)),available_memory_bytes:freemem()};
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result=await page.evaluate(async({manifest,cases,rounds})=>{
    const ort=await import('/ort/ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths={mjs:'/runtime/ort-wasm-simd-threaded.mjs',wasm:'/runtime/ort-wasm-simd-threaded.wasm'};
    ort.env.wasm.numThreads=1;
    const inputs={};
    for(const[scale,entries]of Object.entries(manifest.scales)){
      inputs[scale]=await Promise.all(entries.map(async entry=>({
        image:new ort.Tensor('float32',new Float32Array(await(await fetch('/inputs/'+entry.file)).arrayBuffer()),entry.dims),
        widths:new ort.Tensor('int64',BigInt64Array.from(entry.widths,BigInt),[entry.widths.length]),
      })));
    }
    const sessions=[];
    let head;
    for(const entry of cases){
      if(entry.execution==='fused-head'){
        if(!head){
          const factory=(await import('/head/fused-head.mjs')).default;
          const module=await factory({wasmBinary:new Uint8Array(await(await fetch('/head/fused-head.wasm')).arrayBuffer())});
          const weight=new Float32Array(await(await fetch('/inputs/'+manifest.head.weight.file)).arrayBuffer());
          const bias=new Float32Array(await(await fetch('/inputs/'+manifest.head.bias.file)).arrayBuffer());
          if(weight.length!==manifest.head.channels*manifest.head.classes||bias.length!==manifest.head.classes)throw Error('Classifier weight dimensions do not match');
          const entries=Object.values(manifest.scales).flat();
          const wp=module._malloc(weight.byteLength),bp=module._malloc(bias.byteLength);
          const xp=module._malloc(Math.max(...entries.map(x=>x.dims.reduce((a,b)=>a*b,4))));
          const ip=module._malloc(Math.max(...entries.map(x=>x.dims[0]*x.dims[3]*4)));
          if(!wp||!bp||!xp||!ip)throw Error('Fused classifier allocation failed');
          module.HEAPF32.set(weight,wp/4);module.HEAPF32.set(bias,bp/4);
          head={module,wp,bp,xp,ip};
        }
        sessions.push({entry,run:async feed=>{
          const[N,C,,T]=feed.image.dims,{module,wp,bp,xp,ip}=head;
          module.HEAPF32.set(feed.image.data,xp/4);
          module._fused_ctc_head(xp,wp,bp,ip,N,C,T,manifest.head.classes);
          return {class_ids:new ort.Tensor('int32',module.HEAP32.slice(ip/4,ip/4+N*T),[N,T]),
            lengths:new ort.Tensor('int64',feed.widths.data.slice(),feed.widths.dims)};
        }});
        continue;
      }
      const session=await ort.InferenceSession.create(await(await fetch(manifest.head?'/component/model.onnx':'/assets/'+entry.name+'/model.onnx')).arrayBuffer(),{
        executionProviders:['wasm'],graphOptimizationLevel:'all',enableCpuMemArena:false,enableMemPattern:false,
      });
      const fetches=session.outputNames.includes('class_ids')?['class_ids','lengths']:['logits','lengths'];
      sessions.push({entry,run:feed=>session.run(feed,fetches)});
    }
    async function run(value,inspect=false){
      const ids=[];let lines=0;
      const started=performance.now();
      for(const feed of inputs[value.entry.scale]){
        const out=await value.run(feed);
        lines+=feed.widths.dims[0];
        if(inspect){
          const count=out.lengths.data;
          if(out.class_ids){
            const steps=out.class_ids.dims[1];
            for(let n=0;n<count.length;n++)for(let t=0;t<Number(count[n]);t++)ids.push(Number(out.class_ids.data[n*steps+t]));
          }else{
            const[,steps,classes]=out.logits.dims,data=out.logits.data;
            for(let n=0;n<count.length;n++)for(let t=0;t<Number(count[n]);t++){
              let best=0,max=-Infinity;const offset=(n*steps+t)*classes;
              for(let c=0;c<classes;c++)if(data[offset+c]>max){max=data[offset+c];best=c;}
              ids.push(best);
            }
          }
        }
        for(const tensor of Object.values(out))tensor.dispose();
      }
      const seconds=(performance.now()-started)/1000;
      if(!inspect)return {seconds,lines};
      const digest=await crypto.subtle.digest('SHA-256',Uint32Array.from(ids).buffer);
      return {lines,greedy_ids_sha256:Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')};
    }
    const results={};
    for(const value of sessions)results[value.entry.key]={...value.entry,...await run(value,true),seconds:[]};
    for(let round=0;round<rounds;round++)for(let i=0;i<sessions.length;i++){
      const value=sessions[(i+round)%sessions.length];
      results[value.entry.key].seconds.push((await run(value)).seconds);
    }
    // Profiling is separate from the latency trials.
    globalThis.ocrKernelProfile=async()=>{for(let i=0;i<6;i++)await run(sessions[0]);};
    return {user_agent:navigator.userAgent,logical_cpus:navigator.hardwareConcurrency,models:results};
  },{manifest,cases,rounds:profileOnly?0:7});
  for(const entry of Object.values(result.models)){
    assert.equal(entry.lines,manifest.lines);assert.equal(entry.seconds.length,profileOnly?0:7);
    if(goldHead)assert.equal(entry.greedy_ids_sha256,goldHead,entry.key+': classifier changed IDs');
    if(profileOnly)continue;
    entry.median_seconds=[...entry.seconds].sort((a,b)=>a-b)[3];
    entry.lines_per_second=entry.lines/entry.median_seconds;
    console.log(`${entry.key}: ${entry.lines_per_second.toFixed(2)} prepared lines/s`);
  }
  const client=await page.context().newCDPSession(page);
  await client.send('Profiler.enable');await client.send('Profiler.setSamplingInterval',{interval:200});await client.send('Profiler.start');
  await page.evaluate(()=>globalThis.ocrKernelProfile());
  const {profile}=await client.send('Profiler.stop');await client.detach();
  writeFileSync(resolve(output,'cpu-profile.json'),JSON.stringify(profile)+'\n');
  const nodes=new Map(profile.nodes.map(node=>[node.id,node]));
  const counts=new Map();for(const id of profile.samples||[]){const name=nodes.get(id).callFrame.functionName||'(anonymous)';counts.set(name,(counts.get(name)||0)+1);}
  result.profile_top_functions=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([name,samples])=>({name,samples}));
  result.protocol={origin:'machine_test',run_id:randomUUID(),scope:profileOnly?'CPU sampling only; no latency claim':'prepared tensors, single-thread CPU WASM only; excludes crop preparation, decoding and document work',rounds:profileOnly?0:7,order:'rotate starting model each round',warmup:'all 128 development sample lines per model; warmup greedy output fingerprint recorded',profile:'separate sampling after timing; first listed model'};
  result.hardware={cpu:cpus()[0].model,logical_cpus:cpus().length};
  result.background_before=background;
  result.input_manifest_sha256=hash(readFileSync(manifestPath));
  result.runtime_sha256=hash(readFileSync(resolve(runtime,'ort-wasm-simd-threaded.wasm')));
  result.loader_sha256=hash(readFileSync(resolve(runtime,'ort-wasm-simd-threaded.mjs')));
  if(manifest.head){result.head=manifest.head;result.fused_head_wasm_sha256=hash(readFileSync(resolve(owner,'assets/indra-kernels/head/fused-head.wasm')));}
  writeFileSync(resolve(output,'results.json'),JSON.stringify(result,null,2)+'\n');
}finally{
  if(browser)await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
