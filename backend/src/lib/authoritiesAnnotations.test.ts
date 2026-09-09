import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, StandardFonts, degrees } from 'pdf-lib';
import * as pdf from 'pdf-lib';
import { ANNOTATION_SCHEMA, annotationSetForSource, decodeAnnotationSet, emptyAnnotationSet,
  rectToPdfQuad, type PdfAnnotation, type PdfAnnotationSet } from 'mike/shared/pdf-annotations.mjs';
import { initialAuthorityAnnotations, writeAuthorityAnnotations } from './authoritiesAnnotations';
import { buildAuthorities, prepareAuthorityAnnotations } from './authoritiesBuild';
import { createAuthoritiesDraft, decodeAuthoritiesDraft, reduceAuthoritiesDraft, type AuthoritiesDraft } from './authoritiesDomain';
import { decodeAuthoritiesUserAction } from './authoritiesActionContract';
import { sha256 } from './hash';
import type { NativePdfPassageGeometry } from './structureNative';
const mark = (id='one'): PdfAnnotation => ({id,kind:'highlight',origin:'manual',label:'Custom highlight',excerpt:'Manually selected passage',
  rgb:[1,.92,.6],opacity:.45,fragments:[{pageNumber:1,rects:[[.1,.2,.9,.4]]}]});
const set = (sourceSha256: string, marks=[mark()]): PdfAnnotationSet => ({schemaVersion:ANNOTATION_SCHEMA,sourceSha256,marks});
const annots = (document: PDFDocument, page=0) => {
  const value=document.getPage(page).node.lookupMaybe(PDFName.of('Annots'),PDFArray);
  return value?.asArray().map(ref=>document.context.lookup(ref,PDFDict)) ?? [];
};
const contents = (annot: PDFDict) => annot.lookup(PDFName.of('Contents'),PDFHexString).decodeText();
async function fixture(rotated=false) {
  const source=await PDFDocument.create(),page=source.addPage([400,500]);
  page.drawText('An uncited passage and a cited paragraph.',{x:40,y:350,size:12,font:await source.embedFont(StandardFonts.Helvetica)});
  if(rotated) {page.setCropBox(10,20,370,460);page.setRotation(degrees(90));}
  const bytes=await source.save(),hash=sha256(Buffer.from(bytes));
  let draft=createAuthoritiesDraft({kind:'manual'});
  draft=reduceAuthoritiesDraft(draft,{type:'add-authority',authority:{id:'case',key:'case',kind:'case',citation:'2024 SCC 1',
    name:'Test authority',displayName:null,evidenceIds:[],locators:[{kind:'paragraph',label:'42'}],sourceIdentity:null,
    excluded:false,source:{kind:'unresolved'},userAdded:true}});
  draft=reduceAuthoritiesDraft(draft,{type:'attach-source',authorityId:'case',bindingRole:'case-en',filename:'case.pdf',
    sourceSha256:hash,sourceUrl:null,origin:'manual',language:'en',binding:{kind:'local-file',handleId:'file',
      lastSeen:{name:'case.pdf',size:bytes.length,modified:1,sha256:hash}}});
  return {bytes,hash,draft};
}
const geometry=(hash:string): NativePdfPassageGeometry=>({schemaVersion:'legalpdf.passage-geometry.v1',sourceSha256:hash,
  parserVersion:'test',coordinateSpace:'visible_crop_box',coordinateOrigin:'top_left',rotationApplied:true,
  targets:[{id:'42',locatorKind:'paragraph',locator:'42',status:'found',pages:[{pageNumber:1,width:400,height:500,
    source:'native',passageRects:[[40,40,320,180]]}],quotes:[
      {text:'First independent quote',status:'found',pageNumber:1,rects:[[50,50,200,65]]},
      {text:'Second independent quote',status:'found',pageNumber:1,rects:[[50,100,230,115]]}]}]});
const action=(annotations:PdfAnnotationSet)=>({type:'set-annotations' as const,
  entries:[{authorityId:'case',bindingRole:'case-en',annotations}]});
async function build(draft:AuthoritiesDraft,bytes:Uint8Array,passageGeometry?:NativePdfPassageGeometry) {
  const result=await buildAuthorities({draft,title:'Editor test',workProduct:{id:'test',revision:1},
    sources:{'case-en':{bytes,passageGeometry}}});
  return PDFDocument.load(result.artifacts.book!.bytes);
}
describe('persistent visual PDF annotations',()=>{
  it('distinguishes never reviewed from deliberately empty and rejects stale geometry',()=>{
    const hash='a'.repeat(64);
    expect(annotationSetForSource(undefined,'pdf',hash)).toBeUndefined();
    expect(annotationSetForSource({pdf:emptyAnnotationSet(hash)},'pdf',hash)?.marks).toEqual([]);
    expect(()=>annotationSetForSource({pdf:set(hash)},'pdf','b'.repeat(64))).toThrow(/changed/);
  });
  it('validates untrusted coordinates, pages, duplicate IDs, and appearance values',()=>{
    for(const change of [(s:PdfAnnotationSet)=>s.marks.push(mark()),
      (s:PdfAnnotationSet)=>s.marks[0].fragments[0].rects[0][0]=NaN,
      (s:PdfAnnotationSet)=>s.marks[0].fragments[0].pageNumber=0,
      (s:PdfAnnotationSet)=>s.marks[0].rgb[0]=2,
      (s:PdfAnnotationSet)=>s.marks[0].opacity=Infinity]) {
      const value=set('a'.repeat(64));change(value);expect(()=>decodeAnnotationSet(value)).toThrow();
    }
  });
  it('persists edits through the public action and JSON draft decoder, including deletion of every mark',async()=>{
    const {draft,hash}=await fixture();
    const parsed=decodeAuthoritiesUserAction(JSON.parse(JSON.stringify(action(set(hash,[])))));
    const edited=reduceAuthoritiesDraft(draft,parsed as ReturnType<typeof action>);
    expect(decodeAuthoritiesDraft(JSON.parse(JSON.stringify(edited)))?.authorities.case.annotations?.['case-en'].marks).toEqual([]);
    expect(draft.authorities.case.annotations).toBeUndefined();
  });
  it('preserves saved annotation edits when the citation document is refreshed',async()=>{
    const {draft,hash}=await fixture();
    const edited=reduceAuthoritiesDraft(draft,action(set(hash)));
    const refreshed=reduceAuthoritiesDraft(edited,{type:'refresh',review:{import:draft.import,bindings:draft.bindings,
      units:draft.units,occurrences:draft.occurrences,authorities:draft.authorities,authorityOrder:draft.authorityOrder}});
    expect(refreshed.authorities.case.annotations).toEqual(edited.authorities.case.annotations);
  });
  it('rejects a source replacement without partially saving a batch',async()=>{
    const {draft,hash}=await fixture();
    const edited=reduceAuthoritiesDraft(draft,action(set(hash)));
    expect(()=>reduceAuthoritiesDraft(edited,action(set('f'.repeat(64))))).toThrow(/changed/);
    expect(edited.authorities.case.annotations?.['case-en'].sourceSha256).toBe(hash);
  });
  it('preserves quad corners for every crop rotation',()=>{
    const crop={x:10,y:20,width:400,height:600},r:[number,number,number,number]=[.1,.2,.3,.4];
    expect(rectToPdfQuad(r,crop,0)).toEqual([50,500,130,500,50,380,130,380]);
    expect(rectToPdfQuad(r,crop,90)).toEqual([90,80,90,200,170,80,170,200]);
    expect(rectToPdfQuad(r,crop,180)).toEqual([370,140,290,140,370,260,290,260]);
    expect(rectToPdfQuad(r,crop,270)).toEqual([330,560,330,440,250,560,250,440]);
  });
  it('creates independently selectable quote marks for one pinpoint',async()=>{
    const {hash}=await fixture();
    const result=initialAuthorityAnnotations({sourceSha256:hash,style:'text',geometry:geometry(hash),pages:[{width:400,height:500}],citedPages:new Set()});
    expect(result.annotations.marks.map(mark=>mark.excerpt)).toEqual(['First independent quote','Second independent quote']);
    expect(new Set(result.annotations.marks.map(mark=>mark.id)).size).toBe(2);
  });
  it('exports manual annotations with automatic marking off, without flattening or changing source bytes',async()=>{
    const {draft,bytes,hash}=await fixture(true);draft.settings.passageMarking='none';
    const edited=reduceAuthoritiesDraft(draft,action(set(hash)));
    const output=await build(edited,bytes),annotations=annots(output,2);
    expect(annotations.map(contents)).toEqual(['Manually selected passage']);
    expect(String(annotations[0].lookup(PDFName.of('Subtype')))).toBe('/Highlight');
    expect(annotations[0].lookup(PDFName.of('QuadPoints'),PDFArray).size()).toBe(8);
    expect(annotations[0].lookup(PDFName.of('F'),PDFNumber).asNumber()).toBe(4);
    expect(annotations[0].has(PDFName.of('AP'))).toBe(true);
    expect(sha256(Buffer.from(bytes))).toBe(hash);expect(annots(await PDFDocument.load(bytes))).toHaveLength(0);
    // A separate PDF consumer can remove the annotation and save without modifying the page text.
    const refs=output.getPage(2).node.lookup(PDFName.of('Annots'),PDFArray);
    refs.remove(0);
    expect(annots(await PDFDocument.load(await output.save()),2)).toHaveLength(0);
  });
  it('exports the edited set, never independently regenerating deleted automatic quotes',async()=>{
    const {draft,bytes,hash}=await fixture();draft.settings.passageMarking='text';
    const source=await PDFDocument.load(bytes);
    const initial=prepareAuthorityAnnotations(pdf,source,draft,draft.authorities.case,
      {bindingRole:'case-en',filename:'case.pdf',sourceSha256:hash},{passageGeometry:geometry(hash)}).annotations;
    const edited=reduceAuthoritiesDraft(draft,action({...initial,marks:[initial.marks[1],mark()]}));
    expect(annots(await build(edited,bytes,geometry(hash)),2).map(contents)).toEqual([
      'Cited quote — Second independent quote','Manually selected passage']);
    const empty=reduceAuthoritiesDraft(edited,action(set(hash,[])));
    expect(annots(await build(empty,bytes,geometry(hash)),2)).toHaveLength(0);
  });
  it('rejects annotations on missing pages instead of dropping them during export',async()=>{
    const document=await PDFDocument.create();document.addPage();
    const value=mark();value.fragments[0].pageNumber=2;
    expect(()=>writeAuthorityAnnotations(pdf,document,set('a'.repeat(64),[value]),'source')).toThrow(/missing PDF page/);
  });
});

it('places one paragraph line to the left of its complete extent', () => {
  const hash = 'a'.repeat(64), input = geometry(hash);
  input.targets[0].pages[0].passageRects = [[40, 40, 320, 60], [50, 65, 300, 110], [50, 115, 300, 180]];
  const result = initialAuthorityAnnotations({ sourceSha256: hash, style: 'margin', geometry: input,
    pages: [{ width: 400, height: 500 }], citedPages: new Set() });
  const lines = result.annotations.marks.filter(mark => mark.kind === 'margin');
  expect(lines).toHaveLength(1);
  expect(lines[0].fragments).toHaveLength(1);
  lines[0].fragments[0].rects[0].forEach((value, i) => expect(value).toBeCloseTo([33/400, 40/500, 35/400, 180/500][i]));
});

it('marks the page that prints a paragraph the geometry could not place', async () => {
  const {draft,bytes,hash}=await fixture();
  const unplaced=geometry(hash);unplaced.targets[0].status='ambiguous';unplaced.targets[0].pages=[];
  const result=prepareAuthorityAnnotations(pdf,await PDFDocument.load(bytes),draft,draft.authorities.case,
    {bindingRole:'case-en',filename:'case.pdf',sourceSha256:hash},
    {passageGeometry:unplaced,pageTextByPage:['An uncited passage and [42] a cited paragraph.']});
  expect(result.annotations.marks.map(mark=>mark.label)).toEqual(['Cited page']);
  expect(result.pageMarked).toEqual(['para 42']);
});

it('populates compact paragraph cards directly from prepared PDF text', () => {
  const source = geometry('a'.repeat(64)); source.targets[0].pages[0].text = '[42] First sentence. Second sentence.';
  const result = initialAuthorityAnnotations({sourceSha256: source.sourceSha256, style:'margin', geometry:source,
    pages:[{width:400,height:500}], citedPages:new Set()});
  expect(result.annotations.marks[0].excerpt).toBe('[42] First sentence. Second sentence.');
});
it('keeps a cross-page quotation as a single editable mark', () => {
  const source = geometry('a'.repeat(64));
  source.targets[0].pages.push({...source.targets[0].pages[0],pageNumber:2});
  source.targets[0].quotes = [{text:'A quotation across pages',status:'found',rects:[],
    fragments:[{pageNumber:1,rects:[[50,400,200,415]]},{pageNumber:2,rects:[[50,40,200,55]]}]}];
  const result = initialAuthorityAnnotations({sourceSha256:source.sourceSha256,style:'text',geometry:source,
    pages:[{width:400,height:500},{width:400,height:500}],citedPages:new Set()});
  expect(result.annotations.marks).toHaveLength(1);
  expect(result.annotations.marks[0].fragments.map(f=>f.pageNumber)).toEqual([1,2]);
  expect(result.pageMarked).toEqual([]);
});
