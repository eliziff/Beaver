import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const directory=resolve(process.argv[2]);
const factory=(await import(pathToFileURL(resolve(directory,'sgemm-check.mjs')).href)).default;
const module=await factory({wasmBinary:readFileSync(resolve(directory,'sgemm-check.wasm'))});
let cases=0;
for(const n of [1,2,3,4,5,7,8,9,12,15,16,17,23,31,32,33,1679])for(const k of [0,1,2,3,7,16,31,64,128,257])for(const alpha of [1,-.75,.25])for(const zero of [false,true]){
  const lda=k+3,ldc=n+5;
  const a=Float32Array.from({length:4*lda},(_,i)=>(i*7%31-15)/16);
  const b=Float32Array.from({length:k*n},(_,i)=>(i*11%29-14)/16);
  const c=Float32Array.from({length:4*ldc},(_,i)=>(i%5-2)/128);
  const expected=c.slice(),packed=new Float32Array(Math.max(1,Math.ceil(n/16)*k*16));
  for(let column=0;column<n;column++)for(let inner=0;inner<k;inner++)packed[Math.floor(column/16)*k*16+inner*16+column%16]=b[inner*n+column];
  for(let row=0;row<4;row++)for(let column=0;column<n;column++){
    let sum=0;
    for(let inner=0;inner<k;inner++)sum=Math.fround(sum+Math.fround(a[row*lda+inner]*b[inner*n+column]));
    sum=Math.fround(sum*alpha);
    expected[row*ldc+column]=zero?sum:Math.fround(sum+c[row*ldc+column]);
  }
  const pointers=[];
  try{
    const alloc=bytes=>{const ptr=module._malloc(bytes);assert.ok(ptr);pointers.push(ptr);return ptr;};
    const ap=alloc(a.byteLength),bp=alloc(packed.byteLength),cp=alloc(c.byteLength);
    module.HEAPF32.set(a,ap/4);module.HEAPF32.set(packed,bp/4);module.HEAPF32.set(c,cp/4);
    assert.equal(module._sgemm_check(ap,bp,cp,k,n,lda,ldc,alpha,Number(zero)),4);
    assert.deepEqual(module.HEAPF32.slice(cp/4,cp/4+c.length),expected,`N=${n}, K=${k}, alpha=${alpha}, zero=${zero}`);
    cases++;
  }finally{for(const ptr of pointers)module._free(ptr);}
}
console.log(`${cases} WASM SGEMM cases passed: packed columns, dimension tails, leading strides, alpha, accumulation, untouched row padding`);
