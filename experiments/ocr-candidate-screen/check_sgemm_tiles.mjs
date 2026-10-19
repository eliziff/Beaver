import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const directory=resolve(process.argv[2]),receipt=resolve(process.argv[3]);
const results={origin:'machine_test',run_id:randomUUID(),modules:{}};
for(const name of ['tiles','fma']){
  const binary=readFileSync(resolve(directory,`sgemm-${name}.wasm`));
  const factory=(await import(pathToFileURL(resolve(directory,`sgemm-${name}.mjs`)).href)).default;
  const module=await factory({wasmBinary:binary});
  let sgemmCases=0,depthwiseCases=0,maximumError=0;
  function buffers(values,fn){
    const pointers=[];
    try{
      for(const value of values){const p=module._malloc(Math.max(4,value.byteLength));assert.ok(p);pointers.push(p);module.HEAPF32.set(value,p/4);}
      fn(pointers);
    }finally{for(const p of pointers)module._free(p);}
  }
  function sgemm(rows,n,k,alpha,zero,dyadic){
    const lda=k+3,ldc=n+5;
    const a=Float32Array.from({length:rows*lda},(_,i)=>dyadic?(i*7%31-15)/16:Math.sin(i*1.731)*.7);
    const b=Float32Array.from({length:k*n},(_,i)=>dyadic?(i*11%29-14)/16:Math.cos(i*.319)*.4);
    const c=Float32Array.from({length:(rows+1)*ldc},(_,i)=>(i%5-2)/128);
    const packed=new Float32Array(Math.max(1,Math.ceil(n/16)*k*16));
    for(let col=0;col<n;col++)for(let inner=0;inner<k;inner++)packed[Math.floor(col/16)*k*16+inner*16+col%16]=b[inner*n+col];
    buffers([a,packed,c],([ap,bp,cp])=>{
      assert.equal(module._sgemm_tiles_check(ap,bp,cp,k,n,lda,ldc,alpha,Number(zero),rows),rows);
      const output=module.HEAPF32.slice(cp/4,cp/4+c.length);
      for(let row=0;row<=rows;row++)for(let col=0;col<ldc;col++){
        const index=row*ldc+col;
        if(row===rows||col>=n){assert.equal(output[index],c[index],'Row/stride padding changed');continue;}
        let sum=0,magnitude=0;
        for(let inner=0;inner<k;inner++){
          const value=a[row*lda+inner]*b[inner*n+col];
          sum=dyadic?Math.fround(sum+Math.fround(value)):sum+value;
          magnitude+=Math.abs(value);
        }
        const scaled=dyadic?Math.fround(sum*alpha):sum*alpha;
        const expected=zero?scaled:dyadic?Math.fround(scaled+c[index]):scaled+c[index];
        if(dyadic)assert.equal(output[index],expected,`Exact GEMM ${name}, rows=${rows}, N=${n}, K=${k}`);
        else{
          const error=Math.abs(output[index]-expected),u=2**-24;
          const bound=((k+3)*u/(1-(k+3)*u))*(Math.abs(alpha)*magnitude+Math.abs(c[index])+1);
          assert.ok(error<=bound,`GEMM ${name}: ${error} > ${bound}`);
          maximumError=Math.max(maximumError,error);
        }
      }
      assert.deepEqual(module.HEAPF32.slice(ap/4,ap/4+a.length),a,'GEMM input changed');
    });
    sgemmCases++;
  }
  for(const rows of [4,6])for(const n of [1,2,3,4,5,7,8,9,12,15,16,17,23,31,32,33,1679])for(const k of [0,1,2,3,7,16,31,64,128,257])for(const alpha of [1,-.75,.25])for(const zero of [false,true])sgemm(rows,n,k,alpha,zero,true);
  for(const rows of [4,6])for(const n of [1,7,8,9,16,17,31,1679])for(const k of [7,128,257])for(const zero of [false,true])sgemm(rows,n,k,.713,zero,false);
  for(const width of [1,2,3,4,7,8,9,15,16,17,31,32,127,128,257])for(const batches of [1,2,3])for(const channels of [1,3,64,128])for(const withBias of [false,true]){
    const x=Float32Array.from({length:batches*channels*width},(_,i)=>(i*13%47-23)/16);
    const weights=Float32Array.from({length:channels*9},(_,i)=>(i*7%31-15)/32);
    const bias=Float32Array.from({length:channels},(_,i)=>(i%7-3)/128);
    const y=new Float32Array(x.length+16).fill(19.25),expected=y.slice();
    for(let n=0;n<batches;n++)for(let c=0;c<channels;c++)for(let t=0;t<width;t++){
      let sum=0;
      for(let k=0;k<9;k++){
        const p=t+k-4,pixel=p>=0&&p<width?x[(n*channels+c)*width+p]:0;
        sum=Math.fround(sum+Math.fround(pixel*weights[c*9+k]));
      }
      expected[(n*channels+c)*width+t]=Math.fround(sum+(withBias?bias[c]:0));
    }
    buffers([x,weights,bias,y],([xp,wp,bp,yp])=>{
      module._depthwise_check(xp,wp,withBias?bp:0,yp,batches,channels,width);
      assert.deepEqual(module.HEAPF32.slice(yp/4,yp/4+y.length),expected,`Depthwise ${name}, N=${batches}, C=${channels}, width=${width}`);
      assert.deepEqual(module.HEAPF32.slice(xp/4,xp/4+x.length),x,'Depthwise input changed');
    });
    depthwiseCases++;
  }
  results.modules[name]={wasm_sha256:createHash('sha256').update(binary).digest('hex'),sgemm_cases:sgemmCases,depthwise_cases:depthwiseCases,maximum_nondyadic_absolute_error:maximumError};
  console.log(`${name}: ${sgemmCases} matrix and ${depthwiseCases} depthwise checks passed`);
}
mkdirSync(dirname(receipt),{recursive:true});
writeFileSync(receipt,JSON.stringify(results,null,2)+'\n');
