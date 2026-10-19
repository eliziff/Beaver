import { execFileSync, execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const root=fileURLToPath(new URL('../../',import.meta.url)),owner=resolve(root,'legal-browser-ocr');
const only=(process.argv.find(value=>value.startsWith('--only='))||'').slice(7).split(',').filter(Boolean);
const node=(args,cwd=root)=>execFileSync(process.execPath,args,{cwd,stdio:'inherit'});
const base='pool=6&layoutWorkers=4&preview=thumbnail&package=detectors&detector=indra&detectorSide=768';
const cases=[
  ['before-turbo','fp32','.76','workerSmoke=1'],
  ['quality','quality','1',''],
  ['int8','int8','.76',''],
  ['uint8','uint8','.76',''],
  ['mixed8','mixed8','.76',''],
  ['mixed7','mixed7','.76',''],
  ['pointwise8','pointwise8','.76',''],
  ['body8','body8','.76',''],
  ['ids','ids','.76',''],
  ['matmul','matmul','.76',''],
  ['matmulids','matmulids','.76',''],
  ['fused','fused','.76',''],
  ['fusedids','fusedids','.76',''],
  ['arena','fp32','.76','arena=1'],
  ['arena-pattern','fp32','.76','arena=1&memPattern=1'],
  ['opt-basic','fp32','.76','opt=basic'],
  ['opt-extended','fp32','.76','opt=extended'],
  ['sorted16','fp32','.76','sort=1&batch=16'],
  ['sorted8','fp32','.76','sort=1&batch=8'],
  ['sorted4','fp32','.76','sort=1&batch=4'],
  ['sorted32','fp32','.76','sort=1&batch=32'],
  ['bucket64','fp32','.76','bucket=64'],
  ['pagebatch2','fp32','.76','pageBatch=2'],
  ['pagebatch2-sorted','fp32','.76','pageBatch=2&sort=1&batch=16'],
  ['pagebatch2-bucket64','fp32','.76','pageBatch=2&bucket=64'],
  ['pagebatch3','fp32','.76','pageBatch=3'],
  ['pagebatch2-pool4','fp32','.76','pageBatch=2&pool=4'],
  ['pagebatch2-pool8','fp32','.76','pageBatch=2&pool=8'],
  ['detector640','fp32','.76','detectorSide=640'],
  ['detector512','fp32','.76','detectorSide=512'],
  ['detector896','fp32','.76','detectorSide=896'],
  ['student8','student8','1',''],
  ['student8-balanced','student8','.85',''],
  ['student8-turbo','student8','.76',''],
  ['student6','student6','1',''],
  ['student6-balanced','student6','.85',''],
  ['student6-turbo','student6','.76',''],
  ['after-turbo','fp32','.76',''],
  ['reduced-turbo','fp32','.76','package=reduced-detectors'],
  ['reduced-quality','quality','1','package=reduced-detectors'],
  ['reduced-student6','student6','1','package=reduced-detectors'],
  ['student6ids','student6ids','1',''],
  ['student8ids','student8ids','1',''],
  ['repeat-ids','ids','.76',''],
  ['repeat-turbo','fp32','.76',''],
].filter(([name])=>!only.length||only.includes(name));
if(!cases.length)throw new Error('No matching scenario');
if(!process.argv.includes('--skip-build')){
  node(['--test','--test-concurrency=1','*.test.mjs'],owner);
  execSync(process.platform==='win32'?'npm.cmd run build':'npm run build',{cwd:owner,stdio:'inherit'});
  const packages=new Set(cases.map(([,pack,,tuning])=>{
    const variant=new URLSearchParams(tuning).get('package')||'detectors';
    return JSON.stringify(['indra',...variant.split('-'),'pack='+pack]);
  }));
  for(const args of packages)for(const builder of ['build-runtime.mjs','build-single-html.mjs'])node([builder,...JSON.parse(args)],owner);
}
for(const[name,pack,mode,tuning]of cases){
  const query=new URLSearchParams(base);query.set('pack',pack);
  for(const[key,value]of new URLSearchParams(tuning))query.set(key,value);
  console.log('Scenario: '+name);
  const output='benchmarks/local-data/ocr-candidate-screen/browser/latest/desktop/speed-followup/'+name;
  for(const file of ['results.json','failure.json','indra.png','indra-searchable.pdf'])rmSync(resolve(root,output,file),{force:true});
  try{node(['experiments/ocr-candidate-screen/browser_benchmark.mjs','benchmarks/local-data/ocr-candidate-screen/browser/inputs/manifest.json',output,'indra',mode,query.toString(),'standalone']);}
  catch(error){
    mkdirSync(resolve(root,output),{recursive:true});
    writeFileSync(resolve(root,output,'failure.json'),JSON.stringify({scenario:name,query:Object.fromEntries(query),mode,error:error.message,exit_code:error.status},null,2)+'\n');
    process.exitCode=1;
  }
}
