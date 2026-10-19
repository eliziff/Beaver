import { execFileSync, execSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('../../',import.meta.url)),owner=resolve(root,'legal-browser-ocr');
const only=(process.argv.find(value=>value.startsWith('--only='))||'').slice(7).split(',').filter(Boolean);
const trained=process.argv.includes('--trained');
const node=(args,cwd=root)=>execFileSync(process.execPath,args,{cwd,stdio:'inherit'});
if(!process.argv.includes('--skip-build')){
  node(['--test','--test-concurrency=1','*.test.mjs'],owner);
  execSync(process.platform==='win32'?'npm.cmd run build':'npm run build',{cwd:owner,stdio:'inherit'});
  for(const spec of ['kraken','crnn','indra','indra detectors','indra reduced','crnn reduced','indra reduced detectors']){
    const args=spec.split(' '),suffix=args[0]==='kraken'?'':'-'+args.join('-');
    assert.ok(resolve(owner,'dist/legal-browser-ocr'+suffix+'-runtime').startsWith(resolve(owner,'dist')+sep));
    node(['build-runtime.mjs',...args],owner);
    node(['build-single-html.mjs',...args],owner);
  }
  if(trained)for(const builder of ['build-runtime.mjs','build-single-html.mjs'])node([builder,'indra','reduced','detectors','speed'],owner);
}
const tess='pool=6&layoutWorkers=4&layoutScale=.75&layoutTrim=1';
const detect='pool=6&layoutWorkers=4&preview=thumbnail&package=detectors';
const cases=trained?[
  ['before-quality','indra','pool=6&layoutWorkers=4&preview=thumbnail&package=reduced-detectors&detector=indra&detectorSide=768','1'],
  ['before-turbo','indra','pool=6&layoutWorkers=4&preview=thumbnail&package=reduced-detectors&detector=indra&detectorSide=768','.76'],
  ['trained-turbo','indra','pool=6&layoutWorkers=4&preview=thumbnail&package=reduced-detectors-speed&detector=indra&detectorSide=768','.76'],
  ['after-quality','indra','pool=6&layoutWorkers=4&preview=thumbnail&package=reduced-detectors&detector=indra&detectorSide=768','1'],
]:[
  ['control-before','indra',tess],
  ['thumbnail','indra',tess+'&preview=thumbnail'],
  ['indra-detector','indra',detect+'&detector=indra'],
  ['indra-detector-768','indra',detect+'&detector=indra&detectorSide=768'],
  ['paddle-detector','indra',detect+'&detector=paddle'],
  ['paddle-detector-max1024','indra',detect+'&detector=paddle&detectorLimit=max&detectorSide=1024'],
  ['reduced-indra','indra',tess+'&preview=thumbnail&package=reduced'],
  ['crnn-full','crnn',tess+'&preview=thumbnail'],
  ['reduced-crnn','crnn',tess+'&preview=thumbnail&package=reduced'],
  ['reduced-indra-detector','indra','pool=6&layoutWorkers=4&preview=thumbnail&package=reduced-detectors&detector=indra'],
  ['reduced-indra-detector-768','indra','pool=6&layoutWorkers=4&preview=thumbnail&package=reduced-detectors&detector=indra&detectorSide=768'],
  ['control-after','indra',tess],
  ['kraken-current','kraken','timing=1'],
];
for(const[name,model,query,mode='1']of cases){
  if(only.length&&!only.includes(name))continue;
  console.log('Scenario: '+name);
  node(['experiments/ocr-candidate-screen/browser_benchmark.mjs','benchmarks/local-data/ocr-candidate-screen/browser/inputs/manifest.json','benchmarks/local-data/ocr-candidate-screen/browser/latest/desktop/'+(trained?'recognizer-speed':'speed')+'/'+name,model,mode,query,'standalone']);
}
