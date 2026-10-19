import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const directory=resolve(process.argv[2]);
const factory=(await import(pathToFileURL(resolve(directory,'fused-head.mjs')).href)).default;
const module=await factory({wasmBinary:readFileSync(resolve(directory,'fused-head.wasm'))});
for(const[N,C,T,K,tie]of [[2,13,19,11,false],[1,64,32,1679,false],[1,8,16,9,true]]){
  const input=Float32Array.from({length:N*C*T},(_,i)=>(i*7%31-15)/16);
  const weights=Float32Array.from({length:K*C},(_,i)=>tie?0:(i*11%29-14)/16);
  const bias=Float32Array.from({length:K},(_,i)=>tie?0:(i%5-2)/128);
  const expected=[];
  for(let n=0;n<N;n++)for(let t=0;t<T;t++){
    let best=0,maximum=-Infinity;
    for(let k=0;k<K;k++){
      let value=0;
      for(let c=0;c<C;c++)value=Math.fround(value+Math.fround(input[(n*C+c)*T+t]*weights[k*C+c]));
      value=Math.fround(value+bias[k]);
      if(value>maximum){maximum=value;best=k;}
    }
    expected.push(best);
  }
  const pointers=[];
  try{
    const allocate=bytes=>{const ptr=module._malloc(bytes);assert.ok(ptr);pointers.push(ptr);return ptr;};
    const x=allocate(input.byteLength),w=allocate(weights.byteLength),b=allocate(bias.byteLength),ids=allocate(N*T*4);
    module.HEAPF32.set(input,x/4);module.HEAPF32.set(weights,w/4);module.HEAPF32.set(bias,b/4);
    module._fused_ctc_head(x,w,b,ids,N,C,T,K);
    assert.deepEqual(Array.from(module.HEAP32.subarray(ids/4,ids/4+N*T)),expected);
  }finally{for(const ptr of pointers)module._free(ptr);}
}
console.log('Fused WASM head: exact IDs for batch, channel, time and class tails, full-size alphabet, and blank ties');
