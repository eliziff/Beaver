import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {resolve,sep} from 'node:path';
import {cpus} from 'node:os';

const root=resolve(import.meta.dirname,'../..'),owner=resolve(root,'legal-browser-ocr');
const output=resolve(process.argv[2]||resolve(root,'benchmarks/local-data/ocr-candidate-screen/browser/frontier/gpu-preparation'));
const {chromium}=createRequire(resolve(root,'package.json'))('playwright');
const server=createServer((request,response)=>{
  try{
    const pathname=new URL(request.url,'http://localhost').pathname;
    if(pathname==='/'){response.writeHead(200,{'Content-Type':'text/html','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}).end('<title>GPU crop input check</title>');return}
    let path;
    if(pathname==='/model.onnx')path=resolve(owner,'assets/indra-followup/gpu8h/model.onnx');
    else if(pathname.startsWith('/runtime/')){
      const base=resolve(owner,'node_modules/onnxruntime-web/dist');path=resolve(base,pathname.slice(9));assert.ok(path.startsWith(base+sep));
    }else{
      path=resolve(owner,'.'+pathname);assert.ok(['/recognizer.js','/experiments/ocr-speed/gpu-preparation.js','/experiments/ocr-speed/gpu-argmax.js'].includes(pathname));
    }
    response.writeHead(200,{'Content-Type':path.endsWith('.wasm')?'application/wasm':/\.m?js$/.test(path)?'text/javascript':'application/octet-stream'}).end(readFileSync(path));
  }catch{response.writeHead(404).end()}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({headless:true,channel:'chromium'});
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const measured=await page.evaluate(async()=>{
    const ort=await import('/runtime/ort.webgpu.min.mjs');
    const {GpuPreparation}=await import('/experiments/ocr-speed/gpu-preparation.js');
    const {LineRecognizer,recognizerProfile,packLines}=await import('/recognizer.js');
    ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths={mjs:'/runtime/ort-wasm-simd-threaded.jsep.mjs',wasm:'/runtime/ort-wasm-simd-threaded.jsep.wasm'};
    const session=await ort.InferenceSession.create('/model.onnx',{executionProviders:['webgpu']});
    const gpu=await GpuPreparation.create(ort),cpu=new LineRecognizer(ort,session,recognizerProfile('indra'),{}),checks=[],packing=[];
    try{
      for(const fractional of [false,true]){
        const canvas=new OffscreenCanvas(800,300),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,800,300);
        ctx.fillStyle='#172330';ctx.font='30px serif';ctx.fillText('Juniper accounts 482',35.5,55.25);ctx.fillText('October balance 716',39.1,121.8);
        if(!fractional){ctx.fillStyle='black';ctx.fillRect(10,190,100,20)}
        const lines=fractional?[{x:20.25,y:20.1,width:600.5,height:48.6},{x:27.7,y:87.3,width:580.3,height:49.2}]:[{x:0,y:170,width:128,height:60}];
        const bitmap=await createImageBitmap(canvas),expected=cpu.preparePage(bitmap,lines,1),prepared=await gpu.preparePages([{bitmap,lines}],1,{crop_pack_seconds:0});
        const width=Math.ceil(Math.max(...expected.map(line=>line.width),...prepared.lines.map(line=>line.width))/8)*8,device=gpu.device;
        const bytes=lines.length*32*width*4,readback=device.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        let reference;
        try{
        for(const borrowed of [false,true]){
          const target=borrowed?device.createBuffer({size:bytes+256,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST}):undefined;
          let packed;
          try{
          packed=gpu.pack(prepared.lines,width,target?ort.Tensor.fromGpuBuffer(target,{dataType:'float32',dims:[lines.length,1,32,width]}):undefined);
          const commands=device.createCommandEncoder();commands.copyBufferToBuffer(packed.tensor.gpuBuffer,0,readback,0,bytes);device.queue.submit([commands.finish()]);await readback.mapAsync(GPUMapMode.READ);
          const actual=new Float32Array(readback.getMappedRange()),truth=packLines(expected,recognizerProfile('indra'),width);
          if(!actual.every(value=>Number.isFinite(value)&&value>=0&&value<=1))throw Error('Invalid normalized GPU pixels');
          const widths=prepared.lines.map(line=>line.width),controlWidths=expected.map(line=>line.width);
          if(!fractional&&widths.some((value,i)=>value!==controlWidths[i]))throw Error('Integer ink box differs');
          let maximum=0,total=0,changed=0;
          for(let i=0;i<actual.length;i++){const delta=Math.abs(actual[i]-truth[i]);maximum=Math.max(maximum,delta);total+=delta;if(delta>1/255+.000001)changed++}
          if(widths.some((value,i)=>value!==controlWidths[i]))throw Error('Prepared line widths differ');
          if(!fractional&&maximum!==0)throw Error('Integer fixture pixels differ');
          if(fractional&&(total/actual.length>.005||maximum>.12))throw Error('Fractional resize error exceeded its checked tolerance');
          if(borrowed&&!actual.every((value,i)=>Object.is(value,reference[i])))throw Error('Direct GPU input differs from the temporary tensor');
          reference=actual.slice();
          checks.push({fractional,borrowed_input:borrowed,widths,control_widths:controlWidths,mean_normalized_delta:total/actual.length,max_normalized_delta:maximum,pixels_above_one_gray_level:changed,pixels:actual.length});
          }finally{if(readback.mapState==='mapped')readback.unmap();packed?.release();target?.destroy()}
        }
        if(fractional)for(const width of [512,1024])for(const count of [1,8,16]){
          const batch=Array.from({length:count},(_,i)=>prepared.lines[i%prepared.lines.length]);
          const target=device.createBuffer({size:16*32*width*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
          const tensor=ort.Tensor.fromGpuBuffer(target,{dataType:'float32',dims:[count,1,32,width]}),times={direct:[],copy:[]};
          try{
            await device.queue.onSubmittedWorkDone();
            for(let repeat=0;repeat<9;repeat++)for(const direct of [true,false,false,true]){
              let packed;
              const started=performance.now();
              try{
                packed=gpu.pack(batch,width,direct?tensor:undefined);
                if(!direct){
                  const commands=device.createCommandEncoder();commands.copyBufferToBuffer(packed.tensor.gpuBuffer,0,target,0,count*32*width*4);device.queue.submit([commands.finish()]);
                }
                await device.queue.onSubmittedWorkDone();
                if(repeat)times[direct?'direct':'copy'].push(performance.now()-started);
              }finally{packed?.release()}
            }
            const median=values=>{values=[...values].sort((a,b)=>a-b);return (values[(values.length-1)>>1]+values[values.length>>1])/2};
            packing.push({batch:count,width,unit:'milliseconds',scope:'Host elapsed through queue completion; preparation only, no recognizer; ABBA order after warmup',
              direct_median:median(times.direct),copy_median:median(times.copy),times});
          }finally{target.destroy()}
        }
        }finally{readback.destroy();prepared.release();bitmap.close()}
      }
    }finally{await session.release()}
    return {checks,packing};
  });
  const result={origin:'machine_test',run_id:randomUUID(),scope:'Independent generated image geometry/normalization checks; document CER is gated separately',
    kernel_sha256:createHash('sha256').update(readFileSync(resolve(owner,'experiments/ocr-speed/gpu-preparation.js'))).digest('hex'),
    browser_version:browser.version(),hardware:{cpu:cpus()[0].model,logical_cpus:cpus().length},...measured};
  mkdirSync(output,{recursive:true});writeFileSync(resolve(output,'results.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({...result,packing:result.packing.map(({times,...row})=>row)}));
}catch(error){console.error(String(error).slice(0,2200));process.exitCode=1}
finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
