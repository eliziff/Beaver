import { annotatePdf } from 'mike/shared/pdf-annotation-writer.mjs';
import { structureNative } from './structureNative';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, StandardFonts, degrees } from 'pdf-lib';
import * as pdf from 'pdf-lib';
import { ANNOTATION_SCHEMA, annotationSetForSource, decodeAnnotationSet, emptyAnnotationSet,
  type PdfAnnotation, type PdfAnnotationSet } from 'mike/shared/pdf-annotations.mjs';
import { buildAuthorities } from './authoritiesBuild';
import { createAuthoritiesDraft, decodeAuthoritiesDraft, reduceAuthoritiesDraft, type AuthoritiesDraft } from './authoritiesDomain';
import { decodeAuthoritiesUserAction } from './authoritiesActionContract';
import { sha256 } from './hash';
const mark = (id='one'): PdfAnnotation => ({id,kind:'highlight',origin:'manual',label:'Custom highlight',excerpt:'Manually selected passage',
  rgb:[1,.92,.6],opacity:.45,fragments:[{pageNumber:1,rects:[[.1,.2,.9,.4]]}]});
const set = (sourceSha256: string, marks=[mark()]): PdfAnnotationSet => ({schemaVersion:ANNOTATION_SCHEMA,sourceSha256,marks});
const annots = (document: PDFDocument, page=0) => {
  const value=document.getPage(page).node.lookupMaybe(PDFName.of('Annots'),PDFArray);
  return value?.asArray().map(ref=>document.context.lookup(ref,PDFDict)) ?? [];
};
// Each mark is known by its NM (namespace:mark:page:part); it carries no author or comment.
const markId = (annot: PDFDict) => {
  expect(annot.has(PDFName.of('T'))||annot.has(PDFName.of('Contents'))).toBe(false);
  return annot.lookup(PDFName.of('NM'),PDFHexString).decodeText().split(':')[1];
};
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
const action=(annotations:PdfAnnotationSet)=>({type:'set-annotations' as const,
  entries:[{authorityId:'case',bindingRole:'case-en',annotations}]});
async function build(draft:AuthoritiesDraft,bytes:Uint8Array) {
  const result=await buildAuthorities({draft,title:'Editor test',workProduct:{id:'test',revision:1},
    sources:{'case-en':{bytes}}});
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
  it('exports manual annotations with automatic marking off, without flattening or changing source bytes',async()=>{
    const {draft,bytes,hash}=await fixture(true);draft.settings.passageMarking='none';
    const edited=reduceAuthoritiesDraft(draft,action(set(hash)));
    const output=await build(edited,bytes),page=output.getPageCount()-1,annotations=annots(output,page);
    expect(annotations.map(markId)).toEqual(['one']);
    expect(String(annotations[0].lookup(PDFName.of('Subtype')))).toBe('/Highlight');
    expect(annotations[0].lookup(PDFName.of('QuadPoints'),PDFArray).size()).toBe(8);
    expect(annotations[0].lookup(PDFName.of('F'),PDFNumber).asNumber()).toBe(4);
    expect(annotations[0].has(PDFName.of('AP'))).toBe(true);
    expect(sha256(Buffer.from(bytes))).toBe(hash);expect(annots(await PDFDocument.load(bytes))).toHaveLength(0);
    // A separate PDF consumer can remove the annotation and save without modifying the page text.
    const refs=output.getPage(page).node.lookup(PDFName.of('Annots'),PDFArray);
    refs.remove(0);
    expect(annots(await PDFDocument.load(await output.save()),page)).toHaveLength(0);
  });
  it('exports the edited set, never independently regenerating deleted automatic quotes',async()=>{
    const {draft,bytes,hash}=await fixture();draft.settings.passageMarking='text';
    // A reviewed set keeps one automatic quote of two: the other is never made again.
    const kept={...mark('quote-2'),origin:'automatic' as const,label:'para 42 · Quote'};
    const edited=reduceAuthoritiesDraft(draft,action(set(hash,[kept,mark()])));
    const output=await build(edited,bytes);
    expect(annots(output,output.getPageCount()-1).map(markId)).toEqual(['quote-2','one']);
    const empty=reduceAuthoritiesDraft(edited,action(set(hash,[])));
    const cleared=await build(empty,bytes);
    expect(annots(cleared,cleared.getPageCount()-1)).toHaveLength(0);
  });
  it('rejects annotations on missing pages instead of dropping them during export',async()=>{
    const document=await PDFDocument.create();document.addPage();
    const value=mark();value.fragments[0].pageNumber=2;
    const bytes=await document.save();
    expect(()=>annotatePdf(structureNative(),bytes,set('a'.repeat(64),[value]),'source')).toThrow(/missing PDF page/);
  });
});

