// Extract complete original renditions selected by the retained literal inventory.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {zstdDecompressSync} from 'node:zlib';

const [inventoryFile, candidatesFile, output]=process.argv.slice(2);
if(!output) throw Error('Supply the named-source inventory, original candidate metadata and durable output directory');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const inventoryBytes=fs.readFileSync(inventoryFile),inventory=JSON.parse(inventoryBytes);
const wanted=new Map();
for(const witness of inventory.witnesses) wanted.set(witness.opinion_id+':'+witness.field,witness);
const wantedIds=new Set([...wanted.values()].map(witness=>witness.opinion_id));
const candidates=new Map(),candidateHash=createHash('sha256');
let candidateBytes=0,candidateRows=0,opened=false,closed=false;
const candidateStream=fs.createReadStream(candidatesFile);
candidateStream.on('data',bytes=>{candidateHash.update(bytes);candidateBytes+=bytes.length;});
for await(const line of createInterface({input:candidateStream,crlfDelay:Infinity})) {
  const value=line.trim();
  if(!value) continue;
  if(value==='[' && !opened) {opened=true;continue;}
  if(value===']' && opened && !closed) {closed=true;continue;}
  if(!opened || closed || !value.startsWith('{')) throw Error('Original candidate array line format changed');
  const row=JSON.parse(value.endsWith(',')?value.slice(0,-1):value);
  candidateRows++;
  if(wantedIds.has(String(row.opinion_id))) {
    if(candidates.has(String(row.opinion_id))) throw Error('Repeated original candidate');
    candidates.set(String(row.opinion_id),row);
  }
}
if(!opened || !closed || candidateRows!==inventory.records) throw Error('Original candidate array incomplete');
const indexBytes=fs.readFileSync(inventory.index.file),index=JSON.parse(indexBytes);
if(digest(indexBytes)!==inventory.index.sha256 || indexBytes.length!==inventory.index.bytes) throw Error('Original index changed');
const handle=fs.openSync(inventory.pack,'r'),sources=[],found=new Set();
const started=performance.now();
try {
  if(fs.fstatSync(handle).size!==index.compressed_bytes) throw Error('Original pack byte count changed');
  for(const frame of index.frames) {
    if(!frame.ids.some(id=>wantedIds.has(String(id)))) continue;
    const compressed=Buffer.alloc(frame.bytes);
    if(fs.readSync(handle,compressed,0,compressed.length,frame.offset)!==compressed.length) throw Error('Short original frame');
    const raw=zstdDecompressSync(compressed);
    if(raw.length!==frame.raw_bytes || digest(raw)!==frame.sha256) throw Error('Original frame identity changed');
    const records=raw.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
    if(JSON.stringify(records.map(row=>String(row.opinion.id)))!==JSON.stringify(frame.ids)) throw Error('Original frame membership changed');
    for(const record of records) for(const [key,witness] of wanted) {
      if(String(record.opinion.id)!==witness.opinion_id) continue;
      if(found.has(key)) throw Error('Repeated original source');
      const metadata=candidates.get(witness.opinion_id),bytes=Buffer.from(record.opinion[witness.field]);
      if(!metadata?.url || metadata.url_source!=='official cluster id and slug' || String(metadata.cluster_id)!==String(record.opinion.cluster_id)) throw Error('Original canonical metadata missing');
      if(bytes.length!==witness.source_utf8_bytes || digest(bytes)!==witness.source_sha256) throw Error('Literal source identity changed');
      sources.push({opinion_id:witness.opinion_id,cluster_id:record.opinion.cluster_id,field:witness.field,
        url:metadata.url,sha256:witness.source_sha256,bytes:bytes.length,raw:bytes,
        source_frame:{offset:frame.offset,bytes:frame.bytes,raw_bytes:frame.raw_bytes,sha256:frame.sha256},
        sampling:metadata});
      found.add(key);
    }
  }
} finally {fs.closeSync(handle);}
if(found.size!==wanted.size) throw Error('Named source witness absent from original pack');
if(fs.existsSync(path.join(output,'preparation.json'))) throw Error('Existing preparation must be reused');
fs.mkdirSync(path.join(output,'originals'),{recursive:true});
const sourceManifest=[],pageManifest=[];
for(const source of sources) {
  const relative=path.posix.join('originals',source.sha256+'.html'),file=path.join(output,relative);
  fs.writeFileSync(file,source.raw,{flag:'wx'});
  sourceManifest.push({url:source.url,sha256:source.sha256,bytes:source.bytes,corpus_path:relative,format:'html',
    opinion_id:source.opinion_id,cluster_id:source.cluster_id,field:source.field,
    provenance:'Complete original bulk rendition, exact retained frame and field identity; not served publisher HTML'});
  pageManifest.push({url:source.url,sha256:source.sha256,path:path.resolve(file),file:source.sha256+'.html'});
}
const write=(name,value)=>fs.writeFileSync(path.join(output,name),value,{flag:'wx'});
write('source-manifest.jsonl',sourceManifest.map(row=>JSON.stringify(row)).join('\n')+'\n');
write('page-html-manifest.jsonl',pageManifest.map(row=>JSON.stringify(row)).join('\n')+'\n');
write('anchor-targets.jsonl','');
const receipt={schema:'courtlistener.named-source-preparation.v1',created_utc:new Date().toISOString(),
  inventory:{file:inventoryFile,bytes:inventoryBytes.length,sha256:digest(inventoryBytes)},
  candidate_metadata:{file:candidatesFile,bytes:candidateBytes,sha256:candidateHash.digest('hex'),rows:candidateRows},
  extractor_sha256:digest(fs.readFileSync(fileURLToPath(import.meta.url))),
  sources:sources.map(({raw,...source})=>source),seconds:(performance.now()-started)/1000,
  scope:'Complete original fields for real literal witnesses, independently hashed and bound to original source frames and canonical metadata. Browser eligibility, query resolution and deployed fragment navigation remain unproved.'};
write('preparation.json',JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({sources:sources.length,original_bytes:sources.reduce((sum,row)=>sum+row.bytes,0),seconds:receipt.seconds}));
