import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const root=resolve(import.meta.dirname,'../..'),dist=resolve(root,'legal-browser-ocr/dist');
const [name,outputArg,query='']=process.argv.slice(2);
assert.ok(name&&outputArg,'usage: inspect_browser_gpu.mjs HTML_NAME PRIVATE_OUTPUT [QUERY]');
const html=resolve(dist,name),output=resolve(outputArg);
assert.ok(html.startsWith(dist+sep));
const {chromium}=createRequire(resolve(root,'package.json'))('playwright');
let browser;
try{
  browser=await chromium.launch({headless:true,channel:'chromium'});
  const context=await browser.newContext({offline:true}),page=await context.newPage(),logs=[];
  page.on('console',message=>logs.push({type:message.type(),message:message.text().slice(0,4000)}));
  const url=pathToFileURL(html),params=new URLSearchParams(query);
  params.set('backend','webgpu');params.set('tier','balanced');params.set('debug','1');url.search=params.toString();
  await page.goto(url.href);
  await page.waitForFunction(()=>/Model (ready|failed)/.test(document.querySelector('#status').textContent),null,{timeout:180000});
  assert.match(await page.locator('#status').textContent(),/Model ready/);
  const input=resolve(root,'benchmarks/local-data/ocr-candidate-screen/browser/full-test/inputs/input.pdf');
  await page.setInputFiles('#file',input);
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='Page 1 ready.',null,{timeout:120000});
  const pageResult=await page.evaluate(async()=>{const result=await window.legalOcrRecognizePage();return {seconds:result.seconds,characters:result.text.length}});
  assert.ok(pageResult.characters>100);
  const result={origin:'machine_test',run_id:randomUUID(),scope:'Verbose GPU node placement, first page only; not a speed benchmark',
    html_sha256:createHash('sha256').update(readFileSync(html)).digest('hex'),query:params.toString(),page:pageResult,logs};
  mkdirSync(output,{recursive:true});writeFileSync(resolve(output,'results.json'),JSON.stringify(result,null,2)+'\n');
  const placements=logs.filter(value=>/Node placements|Number of nodes|CPUExecutionProvider|WebGpuExecutionProvider|HardSwish|Softplus/.test(value.message));
  console.log(JSON.stringify({characters:pageResult.characters,log_count:logs.length,placements:placements.slice(-16)}));
}finally{if(browser)await browser.close();}
