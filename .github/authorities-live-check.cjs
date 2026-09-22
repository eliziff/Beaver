const {createRequire}=require('node:module'),path=require('node:path'),fs=require('node:fs');
const requireBackend=createRequire(path.resolve('backend/package.json'));
const assert=require('node:assert/strict');
const express=requireBackend('express'),request=requireBackend('supertest');
const {PDFDocument}=requireBackend('pdf-lib');
const {createDocumentApplication}=require(path.resolve('backend/dist/lib/documentApplication.js'));
const {documentRepository}=require(path.resolve('backend/dist/lib/relationalDocumentRepository.js'));
const {filesystemDocumentObjects}=require(path.resolve('backend/dist/lib/filesystemObjectStorage.js'));
const {createWorkProductApplication}=require(path.resolve('backend/dist/lib/workProductApplication.js'));
const {workProductRepository}=require(path.resolve('backend/dist/lib/relationalWorkProductRepository.js'));
const {createAuthoritiesDraft}=require(path.resolve('backend/dist/lib/authoritiesDomain.js'));
const {createAuthoritiesWorkspaceApplication}=require(path.resolve('backend/dist/lib/authoritiesWorkspaceApplication.js'));
const {createAuthoritiesRouter}=require(path.resolve('backend/dist/routes/authorities.js'));
const {createDocumentsRouter}=require(path.resolve('backend/dist/routes/documentRoutes.js'));
const {closeRelationalDatabase}=require(path.resolve('backend/dist/lib/relationalDatabase.js'));
const queue=require(path.resolve('backend/dist/lib/jobQueue.js'));
const {pdfJobHandlers,enqueuePdfReprocess}=require(path.resolve('backend/dist/lib/pdfJobs.js'));
const root=process.env.HIGHLIGHT_RECEIPTS;
const scope={userId:'00000000-0000-0000-0000-000000000001'};
const documents=createDocumentApplication(documentRepository,filesystemDocumentObjects());
const products=createWorkProductApplication(workProductRepository);
const application=createAuthoritiesWorkspaceApplication(documents,products,{});
const trace=[];let denyTextReads=false;
const resolve=documents.projectionSource;
documents.projectionSource=async(...args)=>{const source=await resolve(...args);return source&&{...source,readBytes:()=>{
  if(denyTextReads)throw Error('Text-layer GET reread source bytes');return source.readBytes();}};};
const app=express();app.use(express.json());
app.use((req,res,next)=>{trace.push({method:req.method,url:req.url,bytes:Number(req.headers['content-length']||0)});next();});
app.use('/api/documents',createDocumentsRouter({},documents));
// Controlled slow annotation operation proves first paint is independent of it.
app.use('/api/authorities',async(req,res,next)=>{if(req.url.endsWith('/annotations'))await new Promise(r=>setTimeout(r,1500));next();},createAuthoritiesRouter(application));
async function waitUntil(read,predicate){for(let i=0;i<300;i++){const v=await read();if(predicate(v))return v;await new Promise(r=>setTimeout(r,100));}throw Error('Fixture job did not complete');}
(async()=>{
 if(process.argv[2]==='restore'){
  const {file,expected}=JSON.parse(fs.readFileSync(path.join(root,'lifecycle.json')));
  denyTextReads=true;
  const response=await request(app).get(`/api/documents/${file.id}/pdf-text-layer?version_id=${file.current_version_id}`).expect(200);
  assert.deepEqual(response.body,expected);
  console.log('PASS fresh process: SQLite descriptor to cached OCR to HTTP without reading source bytes');
  await closeRelationalDatabase();return;
 }
 fs.mkdirSync(root,{recursive:true});
 const pdf=await PDFDocument.create(),image=await pdf.embedPng(fs.readFileSync(path.join(root,'scan.png')));
 for(let i=0;i<12;i++)pdf.addPage([612,792]).drawImage(image,{x:0,y:0,width:612,height:792});
 const bytes=Buffer.from(await pdf.save());fs.writeFileSync(path.join(root,'scan.pdf'),bytes);
 const worker=queue.startJobWorker(pdfJobHandlers(documents));
 let file;
 try{
  file=await documents.create(scope,{filename:'scan.pdf',fileType:'pdf',bytes,pdfOcrProvider:null});
  const original=(await waitUntil(()=>documents.projectionSource(scope,file.id,file.current_version_id),s=>!!s?.pdfProfile)).pdfProfile;
  for(const page of [2,1]){
   const job=await enqueuePdfReprocess({userId:scope.userId,documentId:file.id,versionId:file.current_version_id,
    sourceSha256:file.source_sha256,ocrProvider:'tesseract',layout:false,pages:[page]});
   const done=await waitUntil(()=>queue.getJob(job.id,scope.userId),j=>['succeeded','failed','cancelled'].includes(j?.status));
   assert.equal(done.status,'succeeded',JSON.stringify(done));
  }
  const source=await documents.projectionSource(scope,file.id,file.current_version_id);
  assert.equal(source.pdfProfile.cacheKey,original.cacheKey);assert.ok(!source.pdfProfile.profile.ocr);
  assert.deepEqual(Object.keys(source.pdfProfile.textLayerPages),['1','2']);
  denyTextReads=true;
  const response=await request(app).get(`/api/documents/${file.id}/pdf-text-layer?version_id=${file.current_version_id}`).expect(200);
  denyTextReads=false;
  assert.deepEqual(response.body.pages.map(p=>p.pageNumber),[1,2]);
  for(const page of response.body.pages)assert.match(page.lines.flatMap(l=>l.words).map(w=>w.text).join(' '),/Recognized words are selectable/);
  fs.writeFileSync(path.join(root,'lifecycle.json'),JSON.stringify({file,expected:response.body},null,2));
  const draft=createAuthoritiesDraft({kind:'manual'});draft.settings.passageMarking='highlight';draft.settings.scannedPdfPolicy='full';
  draft.bindings.scan={kind:'document',documentId:file.id,version:{versionId:file.current_version_id,sha256:file.source_sha256}};
  draft.authorityOrder=['scan'];draft.authorities.scan={id:'scan',key:'scan',kind:'case',citation:'Synthetic scan',
   name:'Synthetic scan',displayName:null,evidenceIds:[],locators:[{kind:'page',label:'1'}],sourceIdentity:null,excluded:false,
   source:{kind:'attached',sources:[{bindingRole:'scan',filename:'scan.pdf',language:'en',origin:'uploaded',sourceUrl:null,sourceSha256:file.source_sha256}]}};
  const product=await products.create(scope,{kind:'authorities',title:'OCR regression',state:draft});
  const prep=await request(app).post(`/api/authorities/${product.id}/annotations`).send({authorityId:'scan',bindingRole:'scan',sourceSha256:file.source_sha256}).expect(200);
  assert.equal(prep.body.annotations.sourceSha256,file.source_sha256);
  await request(app).post(`/api/authorities/${product.id}/annotations`).send({authorityId:'scan',bindingRole:'scan',sourceSha256:'0'.repeat(64)}).expect(409);
  app.get('/api/fixture',async(req,res)=>res.json(await products.get(scope,product.id)));
  app.get('/api/fixture-trace',(req,res)=>res.json(trace));
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({recognizedPages:[1,2],unrequestedPages:10,wholeProfilePreserved:true,annotations:prep.body.annotations.marks.length},null,2));
 }finally{await worker.stop();await closeRelationalDatabase();}
 require('node:child_process').execFileSync(process.execPath,[__filename,'restore'],{stdio:'inherit',env:process.env});
 console.log('PASS real Tesseract -> durable worker -> SQLite version profile -> text-layer route');
 const server=app.listen(3037,'127.0.0.1',()=>console.log('READY Authorities HTTP fixture'));
 process.on('SIGTERM',()=>{server.close();void closeRelationalDatabase().then(()=>process.exit(0));});
})().catch(error=>{console.error(error);process.exit(1);});
