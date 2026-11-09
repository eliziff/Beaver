// A fresh process renders the invented 5,400-section Act, then our PDF parser reopens it.
// node scripts/benchmark-statute-source-pdf.mjs REPORT_JSON [BEFORE_JSON]
import './background-work.mjs';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,rmSync,existsSync,realpathSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {longStatuteRecord,LONG_STATUTE} from './authorities-stress/fixtures.mjs';
import {defaultNativeAddon} from '../shared/nativeAddonFile.mjs';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(path.join(root,'backend/package.json'));
require('tsx/cjs');
const {renderAuthoritySourcePdf}=require(path.join(root,'backend/src/lib/authoritiesBuild.ts'));
const {structureNative}=require(path.join(root,'backend/src/lib/structureNative.ts'));
const sha=x=>createHash('sha256').update(x).digest('hex');
if(!process.argv[2])throw new Error('Supply a report path, optionally followed by a saved pre-change report.');
const output=path.resolve(process.argv[2]),baseline=process.argv[3]&&JSON.parse(readFileSync(process.argv[3],'utf8'));
assert.equal(path.extname(output),'.json','The report must have a .json extension');
assert.notEqual(output,process.argv[3]&&path.resolve(process.argv[3]));
const cache=path.join(root,'.tmp/refactor-regression/statute-source-cache');
assert.ok(!existsSync(cache));
try {
 const input={kind:'legislation',name:LONG_STATUTE.name,citation:LONG_STATUTE.citation,date:null,sourceUrl:null,
  text:longStatuteRecord().unofficial_text_en,provider:'machine_test',retrieved:'2031-01-01',federal:true};
 const started=performance.now(),{bytes,pageCount}=await renderAuthoritySourcePdf(input),renderMs=performance.now()-started;
 const native=structureNative(),sourceSha256=sha(bytes);
 const document=await native.openSource(bytes,{documentId:'machine_test:statute-render',versionId:sourceSha256,
  sourceSha256,fileType:'pdf',pdf:{cacheDir:cache}});
 const text=native.documentText(document).replace(/\s/gu,'');
 const outline=native.documentOutline(document);
 // Wrapping moves source offsets; compare the hierarchy (including its pages) and all words separately.
 const shape=outline.filter(entry=>entry.kind!=='text').map(({start,end,...entry})=>
  ({...entry,...entry.text&&{text:entry.text.replace(/\s/gu,'')}}));
 const product={pageCount,textSha256:sha(text),outlineSha256:sha(JSON.stringify(outline)),outlineShapeSha256:sha(JSON.stringify(shape))};
 const report={machine_test:true,runId:randomUUID(),inputSha256:sha(JSON.stringify(input)),renderMs,bytes:bytes.length,sourceSha256,product,
  addonSha256:sha(readFileSync(process.env.LEGAL_STRUCTURE_NATIVE??defaultNativeAddon(path.join(root,'native/legal-structure-node'))))};
 mkdirSync(path.dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 writeFileSync(output.replace(/\.json$/,'.outline.json'),JSON.stringify(outline));
 console.log(JSON.stringify(report));
 if(baseline){assert.equal(report.inputSha256,baseline.inputSha256);for(const key of ['pageCount','textSha256','outlineShapeSha256'])if(key in baseline.product)assert.equal(product[key],baseline.product[key],key);}
} finally {if(existsSync(cache)){assert.equal(realpathSync(cache),cache);rmSync(cache,{recursive:true,force:true});}}
