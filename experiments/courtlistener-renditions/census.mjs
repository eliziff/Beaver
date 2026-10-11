// Stream one pinned public snapshot; the Rust census owns CSV and source analysis.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';

const args=process.argv.slice(2);
const [sourceFile, nativeFile, bzipFile, outputDirectory, maximumArg, witnessArg, featureArg, modeArg, deadlineFlag, deadlineArg, decoderFlag] = args;
const nativeAggregate=modeArg==='--native-aggregate';
const sevenZipDecoder=decoderFlag==='--decoder=7za';
const decoderArgs=sevenZipDecoder?['x','-so','-si','-tbzip2','-mmt=2','-bso0','-bsp0']:['-dc'];
if (!featureArg || (args.length!==7 && !((args.length===10 || (args.length===11 && sevenZipDecoder)) && nativeAggregate && deadlineFlag==='--deadline-utc' && deadlineArg==='2026-10-10T15:00:00Z'))) throw new Error('Use: census.mjs SOURCE_MANIFEST NATIVE_EXE BZIP_EXE OUT MAXIMUM_BYTES WITNESS_BYTES FEATURE_LIMIT [--native-aggregate --deadline-utc 2026-10-10T15:00:00Z [--decoder=7za]]');
const maximumBytes = Number(maximumArg), witnessBytes = Number(witnessArg), featureLimit = Number(featureArg);
if (![maximumBytes,featureLimit].every(value=>Number.isSafeInteger(value)&&value>0) || !Number.isSafeInteger(witnessBytes) || (nativeAggregate?witnessBytes!==0:witnessBytes<=0) || witnessBytes>=maximumBytes) throw new Error('Invalid census limits');
const sourceRaw = fs.readFileSync(sourceFile);
if(nativeAggregate&&sourceRaw.length>128*1024)throw new Error('Aggregate source manifest exceeds bounded metadata limit');
const descriptor = JSON.parse(sourceRaw);
const source = descriptor.source;
const recordCensus=descriptor.census_kind==='record';
const expected=descriptor.expected_complete;
if(nativeAggregate&&(!recordCensus||source?.table!=='opinions'||source.local_path||!Array.isArray(source.columns)||source.columns.length!==22||!/^[a-f0-9]{64}$/u.test(source.sha256??'')||!Number.isSafeInteger(expected?.decoded_bytes)||expected.decoded_bytes<=0||!/^[a-f0-9]{64}$/u.test(expected?.decoded_sha256??'')||!Number.isSafeInteger(expected?.source_rows)||expected.source_rows<=0)) throw new Error('Native aggregate requires the complete previously hashed opinions snapshot');
const bulkRoot='https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/bulk-data/';
if (!source?.url?.startsWith(recordCensus?bulkRoot:bulkRoot+'opinions-') || !Number.isSafeInteger(source.bytes) || source.bytes<=0 || !source.etag || (!recordCensus&&!Array.isArray(source.columns))) throw new Error('Pinned official snapshot descriptor required');
if(recordCensus&&(!/^[a-z0-9_-]+$/u.test(source.table??'')||!new RegExp(`^${source.table}-\\d{4}-\\d{2}-\\d{2}\\.csv\\.bz2$`,'u').test(source.url.slice(bulkRoot.length)))) throw new Error('Record table and snapshot filename differ');
const localSource=source.local_path?path.resolve(source.local_path):null;
if(localSource&&(!recordCensus||!localSource.startsWith(path.resolve('benchmarks/local-data/courtlistener-renditions/metadata/source')+path.sep)||!/^[a-f0-9]{64}$/u.test(source.sha256??'')||fs.statSync(localSource).size!==source.bytes)) throw new Error('Retained source identity/path differs');
const out = path.resolve(outputDirectory);
const durableRoot = path.resolve('benchmarks/local-data/courtlistener-renditions');
if (!out.startsWith(durableRoot+path.sep)) throw new Error('Census output must be in its private durable corpus owner');
if (!process.env.COURTLISTENER_CENSUS_ALLOCATION) throw new Error('Allocate bounded census storage with the existing budget writer before starting');
fs.mkdirSync(out,{recursive:true});
const sha = bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const decoderToolBefore=sevenZipDecoder?{path:bzipFile,bytes:fs.statSync(bzipFile).size,sha256:sha(fs.readFileSync(bzipFile))}:null;
const decoderProvenance=sevenZipDecoder?{backend:'7zip-bzip2-stdin',tool:decoderToolBefore,argv:[bzipFile,...decoderArgs],stdin_streamed:true}:null;
const publish = (name,value)=> {
  const destination=path.join(out,name),pending=destination+'.pending';
  const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');
  if(nativeAggregate&&bytes.length>128*1024)throw new Error('Aggregate transport receipt exceeds bounded metadata limit');
  fs.writeFileSync(pending,bytes,{flag:'wx'});
  fs.renameSync(pending,destination);
};
const exclusive = (name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const headers = text=> {
  const blocks=text.trim().split(/\r?\n\r?\n/u);
  const block=blocks.at(-1), lines=block.split(/\r?\n/u);
  return {status:Number(lines[0].match(/^HTTP\/\S+\s+(\d+)/u)?.[1]),
    fields:Object.fromEntries(lines.slice(1).filter(line=>line.includes(':')).map(line=> {
      const colon=line.indexOf(':');return [line.slice(0,colon).toLowerCase(),line.slice(colon+1).trim()];
    }))};
};
const started = Date.now();
const curl = 'C:/Windows/System32/curl.exe';
const exec = promisify(execFile);
let compressedBytes=0,decodedBytes=0,lastProgress=started,abortReason=null;
const compressedHash=crypto.createHash('sha256'),decodedHash=crypto.createHash('sha256');
const streams=[],children=[],childEnds=[],terminal={},logBounds={};
const stopEvents=[];
const headController=nativeAggregate?new AbortController():null;
const stop=reason=> {
  const message=nativeAggregate?String(reason).slice(0,4096):String(reason);
  abortReason ??= message;
  if(nativeAggregate&&stopEvents.length<16)stopEvents.push({at_utc:new Date().toISOString(),reason:message});
  headController?.abort();
  for (const child of children) if(child.exitCode===null && !child.killed) child.kill();
  for (const stream of streams) if(!stream.destroyed) stream.destroy();
};
if(nativeAggregate){
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>stop(signal));
  let control='';
  process.stdin.on('data',chunk=>{
    control+=chunk.toString('utf8');
    if(control.length>32)stop('Invalid aggregate host cancellation control');
    else if(control.includes('\n'))stop(control.trim()==='cancel'?'Host cancelled aggregate; only an incomplete prefix is retained':'Invalid aggregate host cancellation control');
  });
}
const deadline=nativeAggregate?Date.parse(deadlineArg):null;
const deadlineTimer=nativeAggregate?setTimeout(()=>stop('Native aggregate deadline reached; only an incomplete prefix is retained'),Math.max(0,deadline-Date.now())):null;
let observedHead=null;
let preparationError=null;
try {if(!localSource){
  if(nativeAggregate&&Date.now()>=deadline)throw new Error('Native aggregate deadline passed before transport');
  const head = await exec(curl,['--head','--fail','--silent','--show-error','--location','--max-time','30','--header',`If-Match: ${source.etag}`,'--url',source.url],{windowsHide:true,maxBuffer:1024*1024,...(nativeAggregate?{signal:headController.signal}:{})});
  observedHead = headers(head.stdout);
  if (observedHead.status!==200 || Number(observedHead.fields['content-length'])!==source.bytes || observedHead.fields.etag!==source.etag) throw new Error('Remote snapshot identity differs from pinned source');
}}catch(error){if(!nativeAggregate)throw error;preparationError=String(error).slice(0,4096);stop(error);}
try {exclusive('transport-prepared.json',{
  schema:'courtlistener.whole-source-transport.v1',status:'prepared',created_utc:new Date().toISOString(),
  source,source_manifest:{path:sourceFile,bytes:sourceRaw.length,sha256:sha(sourceRaw)},
  transport_harness:{path:fileURLToPath(import.meta.url),sha256:sha(fs.readFileSync(fileURLToPath(import.meta.url)))},
  census_kind:recordCensus?'record':'opinions',retained_local_source:localSource,
  native:{path:nativeFile,bytes:fs.statSync(nativeFile).size,sha256:sha(fs.readFileSync(nativeFile))},
  bzip:{path:bzipFile,bytes:fs.statSync(bzipFile).size,sha256:sha(fs.readFileSync(bzipFile))},
  census_limits:{maximum_bytes:maximumBytes,witness_bytes:witnessBytes,feature_limit:featureLimit},
  head:observedHead,
  checksum_scope:nativeAggregate?'The prior complete snapshot compressed and decoded SHA256, size, columns and row count are independently pinned.':'S3 multipart ETag pins the object. Full-stream SHA256 will be observed, not pre-pinned independently.',
  ...(nativeAggregate?{native_aggregate:true,deadline_utc:deadlineArg,expected_complete:expected,preparation_error:preparationError,failure_source_capture:'Every failed original row and field required within the existing Native output cap',maximum_child_log_bytes:1024*1024}:{}),
  ...(sevenZipDecoder?{decoder:decoderProvenance}:{}),
  tests_written_or_run:false,browser_runs:0
});}catch(error){if(nativeAggregate){clearTimeout(deadlineTimer);process.stdin.destroy();}throw error;}
const meter = (kind,hash)=>new Transform({transform(chunk,_encoding,callback){
  hash.update(chunk);
  if(kind==='compressed') compressedBytes+=chunk.length;else decodedBytes+=chunk.length;
  if(compressedBytes>source.bytes) return callback(new Error('Snapshot delivered more bytes than pinned'));
  if(nativeAggregate&&decodedBytes>expected.decoded_bytes)return callback(new Error('Decoded stream delivered more bytes than the prior whole snapshot'));
  callback(null,chunk);
}});
const launch = (name,executable,args)=> {
  const stderr=fs.openSync(path.join(out,name+'.log'),'wx');
  const child=spawn(executable,args,{stdio:['pipe','pipe',nativeAggregate?'pipe':stderr],windowsHide:true});
  if(nativeAggregate){
    logBounds[name]={stored_bytes:0,discarded_bytes:0,maximum_bytes:1024*1024};
    child.stderr.on('data',chunk=>{
      const state=logBounds[name],keep=Math.min(chunk.length,state.maximum_bytes-state.stored_bytes);
      try{if(keep)fs.writeSync(stderr,chunk.subarray(0,keep));state.stored_bytes+=keep;state.discarded_bytes+=chunk.length-keep;}catch(error){stop(error);}
    });
    child.once('close',()=>fs.closeSync(stderr));
  }else fs.closeSync(stderr);
  children.push(child);
  const ended=new Promise(resolve=> {
    child.once('error',error=>{terminal[name]={error:error.message};stop(error);resolve(terminal[name]);});
    child.once('close',(code,signal)=> {
      terminal[name]={...(nativeAggregate?terminal[name]:{}),code,signal};
      if(code!==0) stop(`${name} exited ${code??signal}`);
      resolve(terminal[name]);
    });
  });
  childEnds.push(ended);
  return {child,ended};
};
let timer;
const progress=()=> {
  const available=fs.statfsSync(out), physical=available.bavail*available.bsize;
  const floor=Number(process.env.COURTLISTENER_GUARD_BYTES??4406164480);
  if(physical<floor) stop('Physical free space reached protected corpus/browser floor');
  if(nativeAggregate){
    const bytes=fs.readdirSync(out,{withFileTypes:true}).reduce((sum,e)=>sum+(e.isFile()?fs.statSync(path.join(out,e.name)).size:0),0);
    if(bytes>maximumBytes+8*1024*1024)stop('Aggregate transport output reached its bounded allocation');
  }
  const now=Date.now();
  publish('transport-progress.json',{
    schema:'courtlistener.whole-source-progress.v1',status:abortReason?'stopping':'running',updated_utc:new Date().toISOString(),
    compressed_bytes:compressedBytes,expected_compressed_bytes:source.bytes,compressed_fraction:compressedBytes/source.bytes,
    decoded_bytes:decodedBytes,elapsed_seconds:(now-started)/1000,physical_available_bytes:physical,
    whole_corpus_complete:false,abort_reason:abortReason,pids:Object.fromEntries(children.map((child,index)=>[['native','bzip','curl'][index],child.pid])),
    ...(nativeAggregate?{native_aggregate:true,deadline_utc:deadlineArg,digest_scope:'observed_prefix',child_logs:logBounds}:{})
  });
  if(now-lastProgress>=60000) {
    console.log(JSON.stringify({compressed_bytes:compressedBytes,compressed_percent:100*compressedBytes/source.bytes,decoded_bytes:decodedBytes,elapsed_seconds:(now-started)/1000}));
    lastProgress=now;
  }
};
if(!nativeAggregate)for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>stop(signal));
let streamResults;
try {
  if(abortReason)throw new Error(abortReason);
  const receiver=launch('native',nativeFile,[...(recordCensus?['record-census',source.table]:['census']),out,String(maximumBytes),String(witnessBytes),String(featureLimit),...(nativeAggregate?['--native-aggregate']:[])]);
  receiver.child.stdout.resume();
  const decompressor=launch('bzip',bzipFile,decoderArgs);
  const downloader=localSource?null:launch('curl',curl,['--fail','--silent','--show-error','--location','--header',`If-Match: ${source.etag}`,'--header','Accept-Encoding: identity','--dump-header',path.join(out,'response-headers.txt'),'--url',source.url]);
  downloader?.child.stdin.end();
  const sourceStream=localSource?fs.createReadStream(localSource):downloader.child.stdout;
  if(localSource) streams.push(sourceStream);
  const compressedMeter=meter('compressed',compressedHash),decodedMeter=meter('decoded',decodedHash);
  streams.push(compressedMeter,decodedMeter);
  timer=setInterval(()=>{try{progress();}catch(error){stop(error);}},10000);
  progress();
  const guarded=promise=>nativeAggregate?promise.catch(error=>{stop(error);throw error;}):promise;
  streamResults=await Promise.allSettled([
    guarded(pipeline(sourceStream,compressedMeter,decompressor.child.stdin)),
    guarded(pipeline(decompressor.child.stdout,decodedMeter,receiver.child.stdin))
  ]);
  for(const result of streamResults) if(result.status==='rejected') stop(result.reason);
  await Promise.all([receiver.ended,decompressor.ended,...(downloader?[downloader.ended]:[])]);
} catch(error){
  if(!nativeAggregate)throw error;
  stop(error);
} finally {
  clearInterval(timer);
  if(deadlineTimer)clearTimeout(deadlineTimer);
  if(nativeAggregate)process.stdin.destroy();
  for(const child of children) if(child.exitCode===null && !child.killed) child.kill();
}
if(nativeAggregate)await Promise.allSettled(childEnds);
const compressedSha=compressedHash.digest('hex'),decodedSha=decodedHash.digest('hex');
const failures=[];
let decoderToolAfter=null;
if(sevenZipDecoder){
  try{decoderToolAfter={path:bzipFile,bytes:fs.statSync(bzipFile).size,sha256:sha(fs.readFileSync(bzipFile))};}catch(error){failures.push('Decoder tool identity unavailable after transport: '+error.message);}
  if(decoderToolAfter?.bytes!==decoderToolBefore.bytes||decoderToolAfter?.sha256!==decoderToolBefore.sha256)failures.push('Decoder tool bytes changed during transport');
}
if(abortReason) failures.push(abortReason);
if(compressedBytes!==source.bytes) failures.push('Compressed byte count differs from full pinned snapshot');
if(source.sha256&&compressedSha!==source.sha256) failures.push('Compressed SHA256 differs from retained original identity');
for(const [name,result] of Object.entries(terminal)) if(result.code!==0) failures.push(`${name} terminal failure`);
let served=null,summary=null;
let failureEvidence=null,storedWitnessBytes=null,storedFailureIndexBytes=null;
if(!localSource){
  try {served=headers(fs.readFileSync(path.join(out,'response-headers.txt'),'utf8'));} catch(error){failures.push(error.message);}
  if(served?.status!==200 || served?.fields.etag!==source.etag || Number(served?.fields['content-length'])!==source.bytes) failures.push('GET snapshot identity mismatch');
}
try {summary=JSON.parse(fs.readFileSync(path.join(out,'summary.json'),'utf8'));} catch(error){failures.push(error.message);}
if(!summary?.decoded_input_complete || summary?.status!=='complete_decoded_input' || summary?.records_read!==summary?.records_observed) failures.push('Native source census did not complete all rows through CSV EOF');
if(source.columns&&JSON.stringify(summary?.source_columns)!==JSON.stringify(source.columns)) failures.push('CSV header differs from pinned original columns');
if(summary?.decoded_csv_bytes!==decodedBytes || summary?.decoded_csv_sha256!==decodedSha) failures.push('Native and transport decoded-stream proof differ');
if(nativeAggregate){
  if(decodedBytes!==expected.decoded_bytes||decodedSha!==expected.decoded_sha256)failures.push('Decoded stream differs from the prior complete snapshot identity');
  if(summary?.records_observed!==expected.source_rows)failures.push('Source row count differs from the prior complete snapshot');
  if(summary?.native_aggregate?.attempts_complete!==true)failures.push('Native aggregate did not attempt and ordered-reduce every nonempty rendition through CSV EOF');
  const allowed=new Set(['summary.json','progress.json','witnesses.jsonl.zst','witness-index.jsonl','native.log','bzip.log','curl.log','response-headers.txt','transport-prepared.json','transport-progress.json']);
  for(const file of fs.readdirSync(out))if(!allowed.has(file))failures.push('Aggregate mode stored an unexpected output: '+file);
  try{
    const fileProof=name=>{
      const file=fs.openSync(path.join(out,name),'r'),digest=crypto.createHash('sha256'),buffer=Buffer.alloc(64*1024);
      let bytes=0;
      try{for(let count;(count=fs.readSync(file,buffer,0,buffer.length,null))!==0;){bytes+=count;digest.update(buffer.subarray(0,count));}}finally{fs.closeSync(file);}
      return{path:name,bytes,sha256:digest.digest('hex')};
    };
    const witness=fileProof('witnesses.jsonl.zst'),index=fileProof('witness-index.jsonl'),reported=summary?.native_aggregate?.failure_evidence;
    storedWitnessBytes=witness.bytes;storedFailureIndexBytes=index.bytes;
    failureEvidence={reported:reported??null,witness,index,ledger_failed_rows:null,ledger_failed_fields:null,verified:false};
    if(reported?.schema!=='courtlistener.native-aggregate-failure-evidence.v1'||reported.witness_file!==witness.path||reported.index_file!==index.path)throw new Error('Native failure evidence schema or file names differ');
    if(reported.complete_for_reduced_prefix!==true||reported.successful_prefix_is_full_file!==true||reported.first_unretained_failure!==null)throw new Error('Native failure-source capture is incomplete');
    if(reported.compressed_bytes!==witness.bytes||reported.witness_file_bytes!==witness.bytes||reported.compressed_sha256!==witness.sha256||reported.index_bytes!==index.bytes||reported.index_file_bytes!==index.bytes||reported.index_sha256!==index.sha256)throw new Error('Native failure evidence file byte/hash bindings differ');
    const aggregate=summary.native_aggregate,validFields=new Set(aggregate.field_order),counts={error:0,panic:0};
    let rows=0,fields=0,offset=0,lastOrdinal=-1;
    for(const line of fs.readFileSync(path.join(out,index.path),'utf8').split('\n')){
      if(!line)continue;
      const row=JSON.parse(line);
      if(row.schema!=='courtlistener.native-aggregate-failure-index.v1'||row.table!=='opinions'||row.witness_ordinal!==rows||!Number.isSafeInteger(row.source_ordinal_zero_based)||row.source_ordinal_zero_based<=lastOrdinal||row.source_ordinal_zero_based>=summary.records_observed||row.compressed_offset!==offset||!Number.isSafeInteger(row.compressed_bytes)||row.compressed_bytes<=0||!Array.isArray(row.failures)||row.failures.length===0)throw new Error('Native failure ledger row/order/frame boundary differs');
      const seen=new Set();
      for(const failed of row.failures){
        if(!validFields.has(failed.field)||seen.has(failed.field)||!Object.hasOwn(counts,failed.status)||typeof failed.error!=='string'||sha(Buffer.from(failed.error))!==failed.error_sha256)throw new Error('Native failure ledger omitted or changed a complete field error');
        seen.add(failed.field);counts[failed.status]++;fields++;
      }
      offset+=row.compressed_bytes;lastOrdinal=row.source_ordinal_zero_based;rows++;
    }
    failureEvidence.ledger_failed_rows=rows;failureEvidence.ledger_failed_fields=fields;
    if(offset!==witness.bytes||rows!==reported.retained_failed_rows||fields!==reported.retained_failed_fields||counts.error!==aggregate.parser_errors||counts.panic!==aggregate.parser_panics)throw new Error('Native complete failure ledger counts differ from parser outcomes or frame bytes');
    if(aggregate.witness_capture_enabled!==true||aggregate.raw_sources_or_documents_retained!==(rows!==0))throw new Error('Native failure-only capture policy differs');
    if(['summary.json','progress.json'].reduce((n,name)=>n+fs.statSync(path.join(out,name)).size,witness.bytes+index.bytes)>maximumBytes)throw new Error('Native receipts and complete failure evidence exceed the shared output cap');
    failureEvidence.verified=true;
  }catch(error){failures.push('Native failure evidence: '+String(error.message??error).slice(0,4096));}
}
let prefix=null;
if(nativeAggregate&&failures.length){try{
  const file=path.join(out,'progress.json'),bytes=fs.readFileSync(file),p=JSON.parse(bytes);
  prefix={path:file,bytes:bytes.length,sha256:sha(bytes),status:p.status,decoded_input_complete:false,records_read:p.records_read,records_observed:p.records_observed,
    ordered_semantic_prefix_sha256:p.native_aggregate?.ordered_semantic_prefix_sha256??null};
}catch{}}
publish('transport-proof.json',{
  schema:'courtlistener.whole-source-transport-proof.v1',status:failures.length?'incomplete':'complete',completed_utc:new Date().toISOString(),
  source,source_manifest_sha256:sha(sourceRaw),terminal,get:served,
  census_kind:recordCensus?'record':'opinions',retained_local_source:localSource,
  compressed_bytes:compressedBytes,compressed_sha256:compressedSha,decoded_bytes:decodedBytes,decoded_sha256:decodedSha,
  source_rows:summary?.records_observed??null,csv_eof:nativeAggregate&&failures.length?false:summary?.decoded_input_complete??false,
  feature_inventory_complete:summary?.feature_inventory_complete??null,
  feature_overflow:summary?.feature_overflow??null,
  elapsed_seconds:(Date.now()-started)/1000,failures,
  scope:nativeAggregate?'Pinned opinions snapshot and Native parser aggregate attempts. Full completion requires the prior whole-stream hashes/size/columns/rows, successful child terminals, CSV EOF and complete ordered rendition attempts. Counts/hashes do not certify independent legal semantics or browser navigation.':`Entire pinned ${recordCensus?source.table:'opinions'} snapshot transport and source-row census; structural inventory coverage is reported separately. Observed DOM/value-form relationships are not independent legal-semantic gold or publisher-navigation proof.`,
  checksum_scope:nativeAggregate?'Verified complete hashes must equal the prior snapshot. Incomplete transport hashes describe only the observed prefix.':'Compressed and decoded SHA256 are observed whole-stream digests bound to pinned ETag and terminal integrity checks.',
  ...(nativeAggregate?{native_aggregate:true,deadline_utc:deadlineArg,deadline_reached:stopEvents.some(e=>e.reason.startsWith('Native aggregate deadline reached')),abort_reason:abortReason,stop_events:stopEvents,
    digest_scope:failures.length?'observed_prefix':'verified_complete_snapshot',expected_complete:expected,native_aggregate_summary:summary?.native_aggregate?{
      attempts_complete:summary.native_aggregate.attempts_complete,all_nonempty_parsed:summary.native_aggregate.all_nonempty_parsed,
      ordered_semantic_sha256:failures.length?null:summary.native_aggregate.ordered_semantic_sha256,
      ordered_semantic_prefix_sha256:summary.native_aggregate.ordered_semantic_prefix_sha256
    }:null,
    persisted_native_prefix:prefix,child_logs:logBounds,stored_witness_bytes:storedWitnessBytes,stored_failure_index_bytes:storedFailureIndexBytes,failure_evidence:failureEvidence,stream_results:streamResults?.map(r=>r.status==='fulfilled'?{status:r.status}:{status:r.status,reason:String(r.reason)})??[]}:{}),
  ...(sevenZipDecoder?{decoder:{...decoderProvenance,tool_after:decoderToolAfter,tool_stable:decoderToolAfter?.bytes===decoderToolBefore.bytes&&decoderToolAfter?.sha256===decoderToolBefore.sha256}}:{}),
  tests_written_or_run:false,browser_runs:0
});
console.log(JSON.stringify({status:failures.length?'incomplete':'complete',source_rows:summary?.records_observed,compressed_bytes:compressedBytes,failures}));
if(failures.length) process.exitCode=1;
