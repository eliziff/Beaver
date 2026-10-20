import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {resolve,sep} from 'node:path';
import {cpus} from 'node:os';

const root=resolve(import.meta.dirname,'../..'),owner=resolve(root,'legal-browser-ocr');
const output=resolve(process.argv[2]||resolve(root,'benchmarks/local-data/ocr-candidate-screen/browser/gpu-argmax/latest'));
const {chromium}=createRequire(resolve(root,'package.json'))('playwright');
const control=resolve(owner,'assets/gpu-argmax/control.onnx');
const kernel=resolve(owner,'experiments/ocr-speed/gpu-argmax.js');
const server=createServer((request,response)=>{
  try{
    const url=new URL(request.url,'http://localhost');
    if(url.pathname==='/'){response.writeHead(200,{'Content-Type':'text/html'}).end('<title>ArgMax kernel check</title>');return;}
    let path;
    if(url.pathname==='/kernel.js')path=kernel;
    else if(url.pathname==='/control.onnx')path=control;
    else{
      const base=resolve(owner,'node_modules/onnxruntime-web/dist');
      path=resolve(base,'.'+url.pathname);
      assert.ok(path.startsWith(base+sep));
    }
    const bytes=readFileSync(path);
    response.writeHead(200,{'Content-Type':path.endsWith('.wasm')?'application/wasm':/\.m?js$/.test(path)?'text/javascript':'application/octet-stream'}).end(bytes);
  }catch{response.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({headless:true,channel:'chromium'});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const measured=await page.evaluate(async()=>{
    const ort=await import('/ort.webgpu.min.mjs'),{GpuArgMax}=await import('/kernel.js');
    ort.env.wasm.numThreads=1;
    ort.env.wasm.wasmPaths={mjs:'/ort-wasm-simd-threaded.jsep.mjs',wasm:'/ort-wasm-simd-threaded.jsep.wasm'};
    const session=await ort.InferenceSession.create('/control.onnx',{executionProviders:['webgpu'],preferredOutputLocation:{ids:'gpu-buffer'}});
    const device=ort.env.webgpu.device,kernels=[64,128,256].map(size=>({size,kernel:new GpuArgMax(device,size)}));
    await Promise.all(kernels.map(value=>value.kernel.pipeline));
    const checks=[],timings={stock:[],64:[],128:[],256:[]};
    let seed=47;
    try{
      for(const [rows,classes] of [[1,1],[5,33],[1,1680],[37,1680],[4096,1680]]){
        const data=new Float32Array(rows*classes),expected=new Uint32Array(rows);
        for(let i=0;i<data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=seed/2147483648-1;}
        for(let row=0;row<rows;row++){
          if(row%7===0){data[row*classes]=2;data[row*classes+classes-1]=2;}
          let best=data[row*classes],index=0;
          for(let c=1;c<classes;c++)if(data[row*classes+c]>best){best=data[row*classes+c];index=c;}
          expected[row]=index;
        }
        const buffer=device.createBuffer({size:Math.ceil(data.byteLength/16)*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
        device.queue.writeBuffer(buffer,0,data);
        const tensor=ort.Tensor.fromGpuBuffer(buffer,{dataType:'float32',dims:[rows,classes]});
        const stock=async()=>{const out=await session.run({logits:tensor},['ids']);try{return Uint32Array.from(await out.ids.getData(),Number)}finally{out.ids.dispose()}};
        // The stock shader bakes class count into a rank-keyed cache; OCR keeps its vocabulary fixed.
        const cases=[...(classes===1680?[{key:'stock',run:stock}]:[]),...kernels.map(value=>({key:String(value.size),run:()=>value.kernel.run(tensor)}))];
        const verify=(actual,key)=>{if(actual.length!==expected.length||actual.some((v,i)=>v!==expected[i]))throw Error(`ArgMax ${key} mismatch for ${rows}x${classes}: ${[...actual.slice(0,5)]} versus ${[...expected.slice(0,5)]}`)};
        try{
          for(const entry of cases)verify(await entry.run(),entry.key);
          checks.push({rows,classes,kernels:cases.map(value=>value.key),all_ids_equal:true});
          if(rows===4096){
            for(let round=0;round<7;round++)for(let i=0;i<cases.length;i++){
              const entry=cases[(round+i)%cases.length],started=performance.now();
              await entry.run();timings[entry.key].push((performance.now()-started)/1000);
            }
            for(const entry of cases)verify(await entry.run(),entry.key);
          }
        }finally{buffer.destroy();}
      }
    }finally{await session.release();}
    return {checks,timings};
  });
  assert.deepEqual(errors,[]);
  const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
  const result={origin:'machine_test',run_id:randomUUID(),scope:'Prepared GPU tensor ArgMax, including result download; no page-speed claim',
    browser:browser.version(),cpu:cpus()[0].model,kernel_sha256:sha(kernel),control_sha256:sha(control),...measured};
  result.median_seconds=Object.fromEntries(Object.entries(measured.timings).map(([k,v])=>[k,[...v].sort((a,b)=>a-b)[3]]));
  mkdirSync(output,{recursive:true});writeFileSync(resolve(output,'results.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({checks:result.checks,median_seconds:result.median_seconds}));
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
