// Stream the remaining public snapshots once; original bodies stay in retained witnesses.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

const owner=path.resolve('benchmarks/local-data/courtlistener-renditions/all-collections');
const args=process.argv.slice(2),courtsOnly=args[0]==='courts';
const suppliedBuild=courtsOnly?args[1]:args[0];
if(args.length>(courtsOnly?2:1))throw Error('Use record-census-batch.mjs [courts] [BUILD_JSON]');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/u,''));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const proof=file=>{const bytes=fs.readFileSync(file);return {path:path.relative(process.cwd(),file).replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)};};
const allocation=read(path.join(owner,'allocation.json'));
const catalogFile=path.join(owner,'catalog/catalog.json'),catalogProof=proof(catalogFile),catalog=read(catalogFile);
const priorBuildFile=path.join(owner,'build-native.json'),priorBuild=read(priorBuildFile);
const restoredBuildFile=path.join(owner,'restore-native.json');
const buildFile=suppliedBuild?path.resolve(suppliedBuild):fs.existsSync(restoredBuildFile)?restoredBuildFile:priorBuildFile,buildProof=proof(buildFile),build=read(buildFile);
if(process.env.COURTLISTENER_BUDGET_WRITER!=='1'||allocation.maximum_owner_bytes!==2400000000)throw Error('Existing guarded all-collection allocation required');
if(!catalog.listing_complete||catalog.csv_tables.length!==33||catalog.snapshot!=='2026-09-30')throw Error('Complete pinned public catalog required');
if(build.exit_code!==0||!build.source_stable)throw Error('Stable actual native compilation required');
// A restored executable may differ; completed source inventories retain their original producer.
for(const file of ['Cargo.toml','Cargo.lock','src/main.rs','src/metadata.rs','src/record_census.rs','src/census_features.rs']){
  const source='legal-structure/experiments/courtlistener-corpus/'+file;
  if(JSON.stringify(build.source_after[source])!==JSON.stringify(priorBuild.source_after[source]))throw Error('Record census source changed: '+source);
}
const executable=path.resolve(build.native.path),actual=proof(executable);
if(executable!==path.resolve('native/legal-structure-node/target/release/courtlistener-corpus.exe'))throw Error('Canonical native corpus executable required');
if(actual.bytes!==build.native.bytes||actual.sha256!==build.native.sha256)throw Error('Actual native executable differs from build');
const opinions=read('benchmarks/local-data/courtlistener-renditions/whole-corpus-census/full-snapshot-v2/transport-proof.json');
const opinionSource=catalog.csv_tables.find(table=>table.family==='opinions');
if(opinions.status!=='complete'||opinions.source.url!==opinionSource.url||opinions.source.bytes!==opinionSource.bytes||opinions.source.etag!==opinionSource.etag)throw Error('Prior complete opinions snapshot differs');
const tables=catalog.csv_tables.filter(table=>courtsOnly?table.family==='courts':table.family!=='opinions').sort((a,b)=>a.family==='courts'?-1:b.family==='courts'?1:a.bytes-b.bytes);
const copy=path.join(path.dirname(executable),'courtlistener-corpus-record-source.exe');
fs.copyFileSync(executable,copy,fs.constants.COPYFILE_EXCL);
const state={schema:'courtlistener.all-collections-source-batch.v1',status:'running',started_utc:new Date().toISOString(),catalog:catalogProof,build:buildProof,prior_build:proof(priorBuildFile),native:actual,run_copy:proof(copy),prior_opinions_proof:proof(path.resolve('benchmarks/local-data/courtlistener-renditions/whole-corpus-census/full-snapshot-v2/transport-proof.json')),runs:[],tests_written_or_run:0,scope:'Every remaining public quarterly CSV through verified EOF. Complete column accounting and form/witness coverage are separate; API-only records and binary bodies are outside these snapshots.'};
const publish=()=>{const file=path.join(owner,'batch-progress.json'),pending=file+'.pending';fs.writeFileSync(pending,JSON.stringify(state,null,2)+'\n');fs.renameSync(pending,file);};
let child=null,stopping=false;
// Finish the in-flight table before stopping so its transport owns child cleanup.
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;});
try{
  publish();
  for(const table of tables){
    if(stopping)break;
    const source={url:table.url,bytes:table.bytes,etag:table.etag,table:table.family,columns:table.columns};
    if(table.local_retained){source.local_path=table.local_retained.path;source.sha256=table.local_retained.sha256;}
    const directory=path.join(owner,'tables',table.family);fs.mkdirSync(directory,{recursive:true});
    const manifest=path.join(directory,'source.json');
    const descriptor={schema:'courtlistener.record-source-descriptor.v1',census_kind:'record',source,declared_database_table:table.table,declared_joins:table.joins,catalog:catalogProof};
    if(fs.existsSync(manifest)){
      if(JSON.stringify(read(manifest))!==JSON.stringify(descriptor))throw Error('Existing source descriptor differs: '+table.family);
      const terminal=path.join(directory,'census/transport-proof.json');
      const prepared=path.join(directory,'census/transport-prepared.json');
      const receipt=fs.existsSync(terminal)?read(terminal):null;
      const producer=fs.existsSync(prepared)?read(prepared).native:null;
      if(receipt?.status!=='complete'||JSON.stringify(receipt.source)!==JSON.stringify(source)||![actual.sha256,priorBuild.native.sha256].includes(producer?.sha256))throw Error('Existing table run is incomplete or differs: '+table.family);
      state.runs.push({table:table.family,source_manifest:proof(manifest),terminal:{code:0,signal:null},proof:proof(terminal),native_producer:producer,status:'complete',records:receipt.source_rows,feature_inventory_complete:receipt.feature_inventory_complete,reused_complete_run:true});
      publish();continue;
    }
    fs.writeFileSync(manifest,JSON.stringify(descriptor,null,2)+'\n',{flag:'wx'});
    state.current_table=table.family;publish();
    const largeMetadata=allocation.large_metadata_tables.families.includes(table.family);
    const limits=largeMetadata?allocation.large_metadata_tables:
      {maximum_bytes:allocation.table_census_maximum_bytes,witness_bytes:allocation.table_witness_maximum_bytes,feature_limit:allocation.table_feature_key_limit};
    const argv=['experiments/courtlistener-renditions/census.mjs',manifest,copy,'C:/Program Files/Git/usr/bin/bzip2.exe',path.join(directory,'census'),String(limits.maximum_bytes),String(limits.witness_bytes),String(limits.feature_limit)];
    const began=performance.now();
    const result=await new Promise(resolve=>{
      child=spawn(process.execPath,argv,{stdio:['ignore','inherit','inherit'],windowsHide:true,env:{...process.env,COURTLISTENER_CENSUS_ALLOCATION:JSON.stringify(allocation),COURTLISTENER_GUARD_BYTES:String(allocation.protected_guard_bytes)}});
      child.once('error',error=>resolve({error:error.message}));child.once('close',(code,signal)=>resolve({code,signal}));
    });
    child=null;
    const terminal=path.join(directory,'census/transport-proof.json');
    const receipt=fs.existsSync(terminal)?read(terminal):null;
    state.runs.push({table:table.family,source_manifest:proof(manifest),argv,limits,terminal:result,seconds:(performance.now()-began)/1000,proof:receipt?proof(terminal):null,status:receipt?.status??'failed_before_terminal_proof',records:receipt?.source_rows??null,feature_inventory_complete:receipt?.feature_inventory_complete??false});
    publish();
    console.log(JSON.stringify({table:table.family,status:state.runs.at(-1).status,records:state.runs.at(-1).records}));
  }
  state.status=!stopping&&state.runs.length===tables.length&&state.runs.every(run=>run.terminal.code===0&&run.status==='complete')?(courtsOnly?'complete_courts_rows':'complete_public_bulk_rows'):'incomplete';
}finally{
  child?.kill();
  fs.unlinkSync(copy);
  state.completed_utc=new Date().toISOString();state.run_copy_removed=true;publish();
}
if(!['complete_public_bulk_rows','complete_courts_rows'].includes(state.status))process.exitCode=1;
