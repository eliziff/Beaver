import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { AuthoritiesHighlights } from '../../src/app/authorities/AuthoritiesHighlightEditor';
import type { AuthoritiesHost } from '../../src/app/authorities/host';
import type { AuthoritiesProduct } from '../../src/app/authorities/types';
import '../../src/app/globals.css';
const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
for(let number=1;number<=12;number++) {
  const page=document.addPage([612,792]);
  page.drawText(`Authority page ${number}`,{x:72,y:730,size:18,font});
  page.drawText(`Uncited passage on page ${number}.`,{x:72,y:550,size:12,font});
  page.drawText('A second sentence remains available for context.',{x:72,y:525,size:12,font});
  if(number===2) {
    page.drawText('[42] First independent quote',{x:72,y:650,size:12,font});
    page.drawText('Second independent quote',{x:72,y:610,size:12,font});
  }
  if(number===6) {page.setCropBox(24,20,550,720);page.setRotation(degrees(90));}
}
const scan = await PDFDocument.create();
const canvas=globalThis.document.createElement('canvas'); canvas.width=600;canvas.height=300;
const context=canvas.getContext('2d')!;
context.fillStyle='white';context.fillRect(0,0,600,300);context.fillStyle='black';context.font='24px sans-serif';
context.fillText('Scanned authority with no selectable text.',25,75);
scan.addPage([612,792]).drawImage(await scan.embedPng(canvas.toDataURL('image/png')),{x:30,y:400,width:550,height:275});
const files:Record<string,Uint8Array>={'text-en':await document.save(),'scan-en':await scan.save()};
const hashes=Object.fromEntries(await Promise.all(Object.entries(files).map(async([role,bytes])=>[role,
  [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer))].map(v=>v.toString(16).padStart(2,'0')).join('')])));
const initial:AuthoritiesProduct={id:'browser-test',kind:'authorities',title:'Browser annotation test',revision:1,projectId:null,
  createdAt:'2026-09-06',updatedAt:'2026-09-06',outputs:{},state:{schemaVersion:'beaver.authorities-draft.v1',import:{kind:'manual'},
    outputMode:'book',insertIntoDocument:false,settings:{profileId:'general',sourceMode:'automatic',tabStyle:'numeric',tableOrder:'first-reference',
      tableDelivery:'native-append',tableLocation:'pages',passageMarking:'text',scannedPdfPolicy:'page-margin',missingSourcePolicy:'placeholder'},
    cover:{courtFileNumber:'',partyGroups:[],applicationUnder:'',title:''},bookParts:{cover:null,index:null,supplements:[]},
    ledger:null,units:[],occurrences:{},discrepancyDecisions:{},authorityOrder:['text','scan'],
    bindings:Object.fromEntries(Object.entries(files).map(([role,bytes])=>[role,{kind:'local-file',handleId:role,
      lastSeen:{name:`${role}.pdf`,size:bytes.length,modified:1,sha256:hashes[role]}}])),
    authorities:Object.fromEntries(['text','scan'].map(id=>[id,{id,key:id,kind:'case',citation:id==='text'?'2024 SCC 1':'2024 SCC 2',
      name:id==='text'?'Text authority':'Scanned authority',displayName:null,evidenceIds:[],sourceIdentity:null,excluded:false,userAdded:true,
      locators:id==='text'?[{kind:'paragraph',label:'42'}]:[],source:{kind:'attached',sources:[{bindingRole:`${id}-en`,filename:`${id}.pdf`,
        sourceSha256:hashes[`${id}-en`],sourceUrl:null,origin:'manual',language:'en'}]}}]))}};
const base64=(bytes:Uint8Array)=>{let s='';for(const byte of bytes)s+=String.fromCharCode(byte);return btoa(s);};
const post=async(path:string,body:unknown)=>{
  const response=await fetch(`/api/test-annotations/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok)throw new Error(await response.text());return response;
};
function App() {
  const [product,setProduct]=useState(initial),[error,setError]=useState('');
  const host={readSource:async(_product:AuthoritiesProduct,role:string)=>new Blob([files[role].slice().buffer],{type:'application/pdf'}),
    prepareAnnotations:async(value:AuthoritiesProduct,authorityId:string,bindingRole:string)=>
      (await post('prepare',{product:value,authorityId,bindingRole,bytes:base64(files[bindingRole])})).json(),
    act:async(_id:string,revision:number,action:unknown)=>
      (await post('save',{product,revision,action})).json(),
  } as unknown as AuthoritiesHost;
  Object.assign(window,{annotationTestProduct:product});
  async function build() {
    try {
      const response=await post('build',{product,files:Object.fromEntries(Object.entries(files).map(([role,bytes])=>[role,base64(bytes)]))});
      const blob=await response.blob(),url=URL.createObjectURL(blob),a=globalThis.document.createElement('a');
      a.href=url;a.download='annotation-test.pdf';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(cause) {setError(String(cause));}
  }
  return <div className="mx-auto max-w-4xl p-6">
    <AuthoritiesHighlights product={product} tabs={new Map([['text','Tab 1'],['scan','Tab 2']])} host={host} busy={false} onSaved={setProduct}/>
    <button className="m-4 border p-2" onClick={()=>void build()}>Build test book</button>
    <button className="m-4 border p-2" onClick={()=>setProduct({...initial,state:{...initial.state,
      settings:{...initial.state.settings,passageMarking:'none'}}})}>Start with no automatic highlights</button>
    <p role="alert">{error}</p>
  </div>;
}
createRoot(globalThis.document.getElementById('root')!).render(<App/>);
