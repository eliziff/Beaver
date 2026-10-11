// Read actual retained original fields; literal candidates are not DOM/link gold.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';

const [directory,output]=process.argv.slice(2);
if(!directory || !output) throw Error('Supply an original seekable pack and private inventory output');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const indexBytes=fs.readFileSync(path.join(directory,'index.json')),index=JSON.parse(indexBytes);
if(index.schema!=='courtlistener.lossless-zstd-frames.v1') throw Error('Original frame index required');
const packFile=path.join(directory,'opinions.jsonl.zst'),handle=fs.openSync(packFile,'r');
const fields=['html','html_anon_2020','html_columbia','html_lawbox','html_with_citations','xml_harvard','xml_scan'];
const opening=/<([A-Za-z][\w:.-]*)(?=\s|\/?>)(?:"[^"]*"|'[^']*'|[^'">])*>/gu;
const attribute=/\s+([^\s=<>/'"]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
const counts={},witnesses=[];
let records=0,populated=0,sourceBytes=0,namedAnchors=0;
const started=performance.now();
try {
  if(fs.fstatSync(handle).size!==index.compressed_bytes) throw Error('Pack byte count changed');
  for(const frame of index.frames) {
    const compressed=Buffer.alloc(frame.bytes);
    if(fs.readSync(handle,compressed,0,compressed.length,frame.offset)!==compressed.length) throw Error('Short original frame');
    const raw=zstdDecompressSync(compressed);
    if(raw.length!==frame.raw_bytes || digest(raw)!==frame.sha256) throw Error('Original frame identity changed');
    const ids=[];
    for(const line of raw.toString('utf8').split('\n').filter(Boolean)) {
      const record=JSON.parse(line),id=String(record.opinion.id);ids.push(id);records++;
      for(const field of fields) {
        const source=record.opinion[field];if(source===null || source===undefined || source==='') continue;
        if(typeof source!=='string') throw Error('Original markup field is not a string');
        populated++;sourceBytes+=Buffer.byteLength(source);
        for(const match of source.matchAll(opening)) {
          const tag=match[1].toLowerCase();
          for(const attr of match[0].slice(1+match[1].length).matchAll(attribute)) {
            if(attr[1].toLowerCase()!=='name') continue;
            counts[field]??={};counts[field][tag]=(counts[field][tag]??0)+1;
            if(tag!=='a') continue;
            namedAnchors++;
            if(witnesses.length<20) witnesses.push({opinion_id:id,cluster_id:record.opinion.cluster_id,
              field,source_sha256:digest(Buffer.from(source)),source_utf8_bytes:Buffer.byteLength(source),
              source_utf16_start:match.index,literal_opening:match[0],raw_name:attr[2]??attr[3]??attr[4]??'',
              scope:'Literal opening-tag candidate; comment/script context and DOM eligibility not adjudicated'});
          }
        }
      }
    }
    if(JSON.stringify(ids)!==JSON.stringify(frame.ids)) throw Error('Original frame IDs changed');
  }
} finally {fs.closeSync(handle);}
if(records!==index.rows) throw Error('Original record count changed');
const report={schema:'courtlistener.original-named-source-inventory.v1',created_utc:new Date().toISOString(),
  pack:packFile,index:{file:path.join(directory,'index.json'),bytes:indexBytes.length,sha256:digest(indexBytes)},
  verified_frames:index.frames.length,records,populated_markup_fields:populated,source_utf8_bytes:sourceBytes,
  literal_name_attributes_by_field_and_tag:counts,literal_named_anchor_candidates:namedAnchors,witnesses,
  seconds:(performance.now()-started)/1000,
  scope:'Complete retained original fields in this pack, verified frame hashes and membership. Literal candidate discovery only; not independent DOM or successful fragment navigation, and not whole-corpus absence.'};
const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
if(bytes.length>16*1024*1024) throw Error('Inventory exceeds bounded publication allocation');
fs.writeFileSync(output,bytes,{flag:'wx'});
console.log(JSON.stringify({output,records,named_anchors:namedAnchors,counts,seconds:report.seconds}));
