import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {publisherPdfCandidate} from '../../AuthoritiesHelper/modern/authorities-lite/publisher.mjs';
const require=createRequire(import.meta.url);
const {PDFDocument}=require('../../backend/node_modules/pdf-lib');
const rows=JSON.parse(fs.readFileSync('tmp/pdf-pagination/publisher-cached.json','utf8'));
const results=[];
for(const row of rows){
 const bytes=fs.readFileSync(row.path);
 const hash=crypto.createHash('sha256').update(bytes).digest('hex');
 const pages=(await PDFDocument.load(bytes)).getPageCount();
 results.push({id:row.id,url:row.url,indexUrls:row.indexUrls,match:row.indexUrls.some(url=>publisherPdfCandidate(url)===row.url),hashMatches:hash===row.sha256,pages});
}
const summary={total:results.length,uniquePdfs:new Set(rows.map(row=>row.sha256)).size,matches:results.filter(row=>row.match).length,hashMatches:results.filter(row=>row.hashMatches).length,results};
fs.writeFileSync('tmp/pdf-pagination/publisher-cached-results.json',JSON.stringify(summary,null,2));
console.log(JSON.stringify({...summary,results:undefined}));
if(results.some(row=>!row.match||!row.hashMatches))process.exitCode=1;
