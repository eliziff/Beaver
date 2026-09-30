// Validate candidates, not CAPTCHAs: one request at a time, stop each host on a challenge.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {publisherPdfCandidate, verifiedDecisiaPdf} from '../../AuthoritiesHelper/modern/authorities-lite/publisher.mjs';
const require=createRequire(import.meta.url);
const {PDFDocument}=require('../../backend/node_modules/pdf-lib');
const out=path.resolve('tmp/pdf-pagination',process.argv.includes('--after-clearance')?'publisher-rule-after-clearance':'publisher-rule');fs.mkdirSync(out,{recursive:true});
const candidates=JSON.parse(fs.readFileSync('tmp/pdf-pagination/rule-candidates.json','utf8'));
const blocked=new Set(),results=[];
async function get(url){
 const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Accept:'application/pdf,text/html'}});
 if(Number(response.headers.get('content-length'))>20*1024*1024){await response.body.cancel();throw new Error('Response exceeds validation size limit');}
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>20*1024*1024)throw new Error('Response exceeds validation size limit');chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const bytes=Buffer.concat(chunks),type=response.headers.get('content-type')||'';
 const challenge=response.headers.get('cf-mitigated')==='challenge'||(/html/.test(type)&&/\/robocop\/captcha\//i.test(bytes.toString()));
 return {status:response.status,type,challenge,bytes,location:response.headers.get('location')};
}
for(const row of candidates){
 const candidate=publisherPdfCandidate(row.url),host=new URL(row.url).hostname;
 if(!candidate)continue;
 const file=path.join(out,crypto.createHash('sha256').update(row.url).digest('hex')+'.json');
 if(fs.existsSync(file)){const prior=JSON.parse(fs.readFileSync(file));results.push(prior);if(prior.outcome==='challenge')blocked.add(host);continue;}
 if(blocked.has(host)){results.push({...row,candidate,outcome:'skipped_after_challenge'});continue;}
 const result={...row,candidate,at:new Date().toISOString()};
 try{
   const found=await get(candidate);Object.assign(result,{status:found.status,type:found.type,bytes:found.bytes.length});
   if(found.challenge){result.outcome='challenge';blocked.add(host);}
   else if(found.status===200&&found.bytes.subarray(0,5).toString()==='%PDF-'){
     result.pages=(await PDFDocument.load(found.bytes)).getPageCount();result.outcome='valid_pdf';
     result.sha256=crypto.createHash('sha256').update(found.bytes).digest('hex');
     // An independent published control confirms that the derived URL is the intended representation.
     const page=await get(row.url+'?iframe=true');
     if(page.challenge){blocked.add(host);result.control='challenge';}
     else{const evidence=verifiedDecisiaPdf(page.bytes.toString(),row.url);result.control=evidence?.url===candidate?'matches':evidence?'different':'unavailable';result.publishedPdf=evidence?.url??null;}
   }else result.outcome=found.status===404?'not_found':'other_response';
 }catch(error){result.outcome??='network_or_parse_error';result.error=String(error);}
 results.push(result);fs.writeFileSync(file,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 await new Promise(resolve=>setTimeout(resolve,1000));
}
const counts={};for(const row of results)counts[row.outcome]=(counts[row.outcome]||0)+1;
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({counts,results},null,2));console.log(JSON.stringify({counts}));
