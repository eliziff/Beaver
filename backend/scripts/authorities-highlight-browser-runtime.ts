/** Synthetic native geometry is controlled; the reducer, annotation preparation and book exporter are real. */
import { createServer } from 'node:http';
import { PDFDocument } from 'pdf-lib';
import * as pdf from 'pdf-lib';
import { buildAuthorities, prepareAuthorityAnnotations } from '../src/lib/authoritiesBuild';
import { decodeAuthoritiesDraft, reduceAuthoritiesDraft } from '../src/lib/authoritiesDomain';
import { decodeAuthoritiesUserAction } from '../src/lib/authoritiesActionContract';
import { sha256 } from '../src/lib/hash';
const port=Number(process.env.ANNOTATION_TEST_PORT || 3037);
createServer(async(req,res)=>{
  if(req.method!=='POST') {res.writeHead(405).end();return;}
  try {
    let body='';for await(const chunk of req) {body+=chunk;if(body.length>5_000_000)throw new Error('Fixture too large');}
    const input=JSON.parse(body),draft=decodeAuthoritiesDraft(input.product.state);
    if(!draft)throw new Error('Invalid draft');
    if(req.url==='/api/test-annotations/save') {
      if(input.revision!==input.product.revision)throw new Error('Revision conflict');
      const action=decodeAuthoritiesUserAction(input.action);
      if(action.type!=='set-annotations')throw new Error('Unexpected fixture action');
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({...input.product,revision:input.revision+1,state:reduceAuthoritiesDraft(draft,action)}));
    } else if(req.url==='/api/test-annotations/prepare') {
      const bytes=Buffer.from(input.bytes,'base64'),document=await PDFDocument.load(bytes);
      const authority=draft.authorities[input.authorityId];
      const source=authority.source.kind==='attached'&&authority.source.sources.find(item=>item.bindingRole===input.bindingRole);
      if(!source||source.sourceSha256!==sha256(bytes))throw new Error('Source mismatch');
      const passageGeometry={schemaVersion:'legalpdf.passage-geometry.v1' as const,sourceSha256:source.sourceSha256,parserVersion:'fixture',
        coordinateSpace:'visible_crop_box' as const,coordinateOrigin:'top_left' as const,rotationApplied:true as const,
        targets:input.authorityId==='text'?[{id:'42',status:'found' as const,locatorKind:'paragraph' as const,locator:'42',
          pages:[{pageNumber:2,width:612,height:792,source:'native' as const,passageRects:[[70,128,360,190] as [number,number,number,number]]}],
          quotes:[{text:'First independent quote',status:'found' as const,pageNumber:2,rects:[[70,128,310,148] as [number,number,number,number]]},
            {text:'Second independent quote',status:'found' as const,pageNumber:2,rects:[[70,168,330,188] as [number,number,number,number]]}]}]:[]};
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify(prepareAuthorityAnnotations(pdf,document,draft,authority,source,{passageGeometry},true)));
    } else if(req.url==='/api/test-annotations/build') {
      const sources=Object.fromEntries(Object.entries(input.files).map(([role,value])=>[role,{bytes:Buffer.from(String(value),'base64')}]));
      const result=await buildAuthorities({draft,title:input.product.title,workProduct:{id:input.product.id,revision:input.product.revision},sources});
      res.setHeader('Content-Type','application/pdf');res.end(result.artifacts.book!.bytes);
    } else res.writeHead(404).end();
  } catch(error) {res.writeHead(400,{'Content-Type':'text/plain'});res.end(String(error));}
}).listen(port,'127.0.0.1',()=>console.log(`Annotation browser fixture on ${port}`));
