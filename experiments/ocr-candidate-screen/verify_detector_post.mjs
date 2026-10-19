import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeIndra, decodePaddle } from '../../legal-browser-ocr/experiments/ocr-speed/detector-post.js';

const directory=resolve(process.argv[2]),reference=JSON.parse(readFileSync(resolve(directory,'reference.json'))),results={};
const overlap=(a,b)=>{const intersection=Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))*Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));return intersection/((a.x1-a.x0)*(a.y1-a.y0)+(b.x1-b.x0)*(b.y1-b.y0)-intersection)};
for(const[name,entry]of Object.entries(reference)){
  const bytes=readFileSync(resolve(directory,name+'-output.f32')),data=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
  const[height,width]=entry.output_shape.slice(-2),actual=name==='indra'?decodeIndra(data,width,height):decodePaddle(data,width,height,entry.config);
  const expected=entry.boxes.map(([x0,y0,x1,y1])=>({x0,y0,x1,y1})),unmatched=new Set(actual);
  assert.equal(actual.length,expected.length,name+': native line count differs');
  let maximumDifference=0,minimumIoU=1;
  for(const box of expected){
    const best=[...unmatched].sort((a,b)=>overlap(box,b)-overlap(box,a))[0];
    assert.ok(best,name+': missing native line');
    unmatched.delete(best);
    const clipped=name==='paddle'?Object.fromEntries(Object.entries(best).map(([key,value])=>[key,Math.round(Math.max(0,Math.min(key.startsWith('x')?width:height,value)))])):best;
    const difference=Math.max(...['x0','y0','x1','y1'].map(key=>Math.abs(clipped[key]-box[key])));
    maximumDifference=Math.max(maximumDifference,difference);minimumIoU=Math.min(minimumIoU,overlap(box,clipped));
    assert.ok(difference<=(name==='indra'?.001:2),`${name}: box differs by ${difference} pixels`);
  }
  results[name]={native_boxes:expected.length,javascript_boxes:actual.length,maximum_coordinate_difference:maximumDifference,minimum_iou:minimumIoU};
  console.log(name+': '+JSON.stringify(results[name]));
}
writeFileSync(resolve(directory,'verification.json'),JSON.stringify(results,null,2)+'\n');
