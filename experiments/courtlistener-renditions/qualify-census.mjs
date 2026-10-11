// Actual retained opinions: validate source values/counts and reopened census witnesses.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const [native,sourceFile,poolFile,out,featureArg='500000'] = process.argv.slice(2);
if(!out || ![6,7].includes(process.argv.length)) throw new Error('Use: qualify-census.mjs NATIVE SOURCE_JSONL_OR_WITNESSES_ZST POOL_MANIFEST OUT [FEATURE_LIMIT]');
const featureLimit=Number(featureArg);
if(!Number.isSafeInteger(featureLimit)||featureLimit<1) throw new Error('Invalid feature limit');
if(!process.env.COURTLISTENER_CENSUS_ALLOCATION) throw new Error('Existing budget allocation required');
const columns=JSON.parse(fs.readFileSync(poolFile,'utf8')).source.columns;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const encode=value=>value===null?'':`"${value.replaceAll('\\','\\\\').replaceAll('"','\\"')}"`;
const sourceHash=crypto.createHash('sha256'),csvHash=crypto.createHash('sha256');
let sourceBytes=0,csvBytes=0,rows=0;
const expected=[],stats=columns.map(name=>({name,null_rows:0,empty_string_rows:0,nonempty_string_rows:0,string_utf8_bytes:0,maximum_utf8_bytes:0,minimum_nonempty_utf8_bytes:null}));
fs.mkdirSync(out,{recursive:true});
const started=performance.now(),log=fs.openSync(path.join(out,'native.log'),'wx');
const child=spawn(native,['census',out,String(512*1024*1024),String(128*1024*1024),String(featureLimit)],{stdio:['pipe','ignore',log],windowsHide:true});
fs.closeSync(log);
const terminal=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
child.stdin.on('error',()=>{});
const send=async text=> {
  const bytes=Buffer.from(text);csvHash.update(bytes);csvBytes+=bytes.length;
  if(!child.stdin.write(bytes)) await once(child.stdin,'drain');
};
const meter=new Transform({transform(chunk,_encoding,callback){sourceHash.update(chunk);sourceBytes+=chunk.length;callback(null,chunk);}});
const packedSource=sourceFile.endsWith('.zst');
let sourceDecoder=null,sourceTerminal=null,sourcePipeline=null,sourceReadFailure=null,originalIndices=null,originalIndexHash=null;
let result;
try {
  await send(columns.map(encode).join(',')+'\n');
  let sourceInput=fs.createReadStream(sourceFile).pipe(meter);
  if(packedSource) {
    const indexFile=path.join(path.dirname(sourceFile),'witness-index.jsonl');
    const indexRaw=fs.readFileSync(indexFile);
    originalIndexHash=sha(indexRaw);
    originalIndices=indexRaw.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const sourceLog=fs.openSync(path.join(out,'source-reopen.log'),'wx');
    sourceDecoder=spawn(native,['decode',sourceFile],{stdio:['ignore','pipe',sourceLog],windowsHide:true});
    fs.closeSync(sourceLog);
    sourceTerminal=new Promise((resolve,reject)=>{sourceDecoder.once('error',reject);sourceDecoder.once('close',code=>resolve(code));});
    // Hash the stored compressed source independently of the decoder's reads.
    sourcePipeline=pipeline(sourceInput,new Writable({write(_chunk,_encoding,callback){callback();}}))
      .catch(error=>{sourceReadFailure=error;});
    sourceInput=sourceDecoder.stdout;
  }
  const input=readline.createInterface({input:sourceInput,crlfDelay:Infinity});
  for await(const line of input) {
    const record=JSON.parse(line);
    let values;
    if(packedSource) {
      const index=originalIndices[rows];
      if(!index || JSON.stringify(record.columns)!==JSON.stringify(columns) || record.values?.length!==columns.length || index.source_ordinal_zero_based!==record.source_ordinal_zero_based || sha(line+'\n')!==index.raw_sha256 || Buffer.byteLength(line+'\n')!==index.raw_bytes) throw new Error('Retained original witness/index identity differs');
      values=record.values;
      for(let i=0;i<columns.length;i++) if(values[i]!==null) {
        const proof=record.source_string_hashes[columns[i]];
        if(proof?.sha256!==sha(values[i])||proof?.utf8_bytes!==Buffer.byteLength(values[i])) throw new Error('Retained original source string proof differs');
      }
    } else {
      const row=record.opinion;
      if(Object.keys(row).length!==columns.length || columns.some(name=>!Object.hasOwn(row,name))) throw new Error('Original source field set differs');
      values=columns.map(name=>row[name]);
    }
    if(values.some(value=>value!==null&&typeof value!=='string')) throw new Error('Unexpected original scalar type');
    const csv=values.map(encode).join(',')+'\n';
    expected.push({values_sha256:sha(JSON.stringify(values)),csv_sha256:sha(csv),csv_bytes:Buffer.byteLength(csv)});
    for(let i=0;i<values.length;i++) {
      const value=values[i],stat=stats[i];
      if(value===null) stat.null_rows++;
      else {
        const bytes=Buffer.byteLength(value);stat.string_utf8_bytes+=bytes;stat.maximum_utf8_bytes=Math.max(stat.maximum_utf8_bytes,bytes);
        if(value==='') stat.empty_string_rows++;
        else {stat.nonempty_string_rows++;stat.minimum_nonempty_utf8_bytes=Math.min(stat.minimum_nonempty_utf8_bytes??bytes,bytes);}
      }
    }
    rows++;await send(csv);
  }
  if(packedSource) {
    await sourcePipeline;
    if(sourceReadFailure) throw sourceReadFailure;
    if(await sourceTerminal!==0 || rows!==originalIndices.length) throw new Error('Retained original source pack did not reopen completely');
  }
  child.stdin.end();result=await terminal;
} finally {
  if(child.exitCode===null&&!child.killed) child.kill();
  if(sourceDecoder?.exitCode===null&&!sourceDecoder.killed) sourceDecoder.kill();
  meter.destroy();
  if(sourcePipeline) await sourcePipeline;
}
if(result.code!==0) throw new Error(`Actual corpus census failed: ${JSON.stringify(result)}`);
const csvSha=csvHash.digest('hex'),sourceSha=sourceHash.digest('hex');
const summary=JSON.parse(fs.readFileSync(path.join(out,'summary.json'),'utf8'));
if(!summary.decoded_input_complete || summary.records_observed!==rows || summary.records_read!==rows || summary.decoded_csv_bytes!==csvBytes || summary.decoded_csv_sha256!==csvSha || JSON.stringify(summary.source_columns)!==JSON.stringify(columns)) throw new Error('Independent complete-row/CSV accounting differs');
for(let i=0;i<stats.length;i++) for(const [key,value] of Object.entries(stats[i])) if(summary.column_stats[i][key]!==value) throw new Error(`Original column accounting differs: ${columns[i]}.${key}`);
const indices=fs.readFileSync(path.join(out,'witness-index.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const witnessLog=fs.openSync(path.join(out,'witness-reopen.log'),'wx');
const decoder=spawn(native,['decode',path.join(out,'witnesses.jsonl.zst')],{stdio:['ignore','pipe',witnessLog],windowsHide:true});
fs.closeSync(witnessLog);
const decodedTerminal=new Promise((resolve,reject)=>{decoder.once('error',reject);decoder.once('close',code=>resolve(code));});
let witnessed=0,featureProofs=0;
try {
  const lines=readline.createInterface({input:decoder.stdout,crlfDelay:Infinity});
  for await(const line of lines) {
    const witness=JSON.parse(line),index=indices[witnessed],original=expected[witness.source_ordinal_zero_based];
    if(!index || !original || index.source_ordinal_zero_based!==witness.source_ordinal_zero_based || sha(JSON.stringify(witness.values))!==original.values_sha256 || witness.original_csv_row_sha256!==original.csv_sha256 || witness.original_csv_row_bytes!==original.csv_bytes || JSON.stringify(witness.columns)!==JSON.stringify(columns) || sha(line+'\n')!==index.raw_sha256 || Buffer.byteLength(line+'\n')!==index.raw_bytes) throw new Error('Reopened complete witness differs from retained original values/derived CSV');
    for(let i=0;i<columns.length;i++) {
      const value=witness.values[i];
      if(value!==null) {
        const proof=witness.source_string_hashes[columns[i]];
        if(proof?.sha256!==sha(value)||proof?.utf8_bytes!==Buffer.byteLength(value)) throw new Error('Witness scalar hash differs');
      }
    }
    featureProofs+=index.feature_proofs.length;witnessed++;
  }
  if(await decodedTerminal!==0) throw new Error('Reopening real original witnesses failed');
} finally {if(decoder.exitCode===null&&!decoder.killed) decoder.kill();}
if(witnessed!==indices.length || witnessed!==summary.witnesses.retained_rows) throw new Error('Witness row counts differ');
const receipt={schema:'courtlistener.retained-source-census-qualification.v1',status:'passed',created_utc:new Date().toISOString(),
  source:{path:sourceFile,bytes:sourceBytes,sha256:sourceSha,records:rows,
    format:packedSource?'complete-census-witnesses-zstd':'retained-opinion-jsonl',
    witness_index_sha256:originalIndexHash,all_input_witnesses_reopened_exact:packedSource?true:null},
  derived_csv:{bytes:csvBytes,sha256:csvSha,scope:'COPY backslash CSV encoded from exact retained source values; not original remote CSV bytes'},
  native:{path:native,bytes:fs.statSync(native).size,sha256:sha(fs.readFileSync(native)),terminal:result},
  feature_keys:summary.feature_keys,reopened_complete_witnesses:witnessed,retained_feature_proofs:featureProofs,
  feature_limit:featureLimit,feature_inventory_complete:summary.feature_inventory_complete,
  feature_overflow:summary.feature_overflow,
  native_seconds:summary.seconds,total_seconds:(performance.now()-started)/1000,
  all_column_presence_and_byte_counts_exact:true,reopened_witness_values_exact:true,
  full_courtlistener_corpus:false,tests_written_or_run:false,browser_runs:0};
fs.writeFileSync(path.join(out,'qualification.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt));
