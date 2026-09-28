const fs = require('node:fs'), path = require('node:path');
const out = path.resolve('tmp/pdf-pagination');
process.env.MIKE_LOCAL_DATA_DIR ||= path.join(out, 'authorities-store');
const { documentProjectionService: service } = require('../../backend/dist/lib/documentProjectionService');
const { reporterStartPages } = require('../../backend/dist/lib/pdfPagination');
const { PDFDocument } = require('../../backend/node_modules/pdf-lib');
const { prepareAuthorityAnnotations } = require('../../backend/dist/lib/authoritiesBuild');
const { createAuthoritiesDraft } = require('../../backend/dist/lib/authoritiesDomain');
const pdf = require('../../backend/node_modules/pdf-lib');
const { authorityPdfText } = require('../../backend/dist/lib/authorityPdfText');
const manifestArgument = process.argv.indexOf('--manifest');
const manifest = manifestArgument < 0 ? 'authorities-manifest.json' : process.argv[manifestArgument+1];
const rows = JSON.parse(fs.readFileSync(path.join(out,manifest)));
const outputArgument = process.argv.indexOf('--output');
const productOutput = outputArgument < 0 ? path.join(out,'product-final') : path.resolve(process.argv[outputArgument+1]);
if (process.argv.includes('--product')) fs.mkdirSync(productOutput,{recursive:true});
const onlyArgument = process.argv.indexOf('--only');
const selectedRows = (onlyArgument < 0 ? rows : rows.filter(row => row.sha256 === process.argv[onlyArgument+1]))
  .filter(row => !process.argv.includes('--oracle-only') ||
    fs.existsSync(path.join(out,row.sha256+'.visual.json')));
if (!selectedRows.length) throw new Error('No matching acquisition receipt');
async function predict(row) {
  if (process.argv.includes('--product')) {
    if (row.origin !== 'original') return;
    const receipt = path.join(productOutput,row.sha256+'.product.json');
    if (fs.existsSync(receipt)) return;
    const starts=reporterStartPages(row.citations);
    const visualPath=path.join(out,row.sha256+'.visual.json');
    const oracle=process.argv.includes('--oracle') && fs.existsSync(visualPath)
      ? JSON.parse(fs.readFileSync(visualPath)).pages.filter(page=>page.status==='readable' &&
        page.labels.length===1 && /^\d+$/.test(page.labels[0].text)).at(-1) : null;
    const pinpoint=oracle?.labels[0].text ?? String(starts[0]+Math.min(2,row.page_count-1));
    const target={id:'pinpoint',locatorKind:'page',locator:pinpoint};
    const started=performance.now();
    let result, bindings;
    try {
      const bytes=fs.readFileSync(row.path),ocrRuns=[];
      bindings=await service.pdfPagination({documentId:row.sha256,versionId:row.sha256,
        sourceSha256:row.sha256,fileType:'pdf',reporterOriginal:true,readBytes:()=>bytes},row.citations);
      const prepared=await authorityPdfText({bytes,citations:row.citations,reporterOriginal:true,
        documentId:row.sha256,versionId:row.sha256,sourceSha256:row.sha256,
        scannedPdfPolicy:'cited-pages',ocrTargets:[target],passageTargets:[target]},
        {...service,pdfPagination:async (...args)=>{
          bindings=await service.pdfPagination(...args); return bindings;
        },preparePdf:async input=>{
          if(input.ocrProvider && (!input.pages?.length || input.pages.length>Math.min(3,row.page_count)+1))
            throw new Error('Page-only OCR exceeded anchor plus pinpoint scope');
          const value=await service.preparePdf(input);
          ocrRuns.push({requested:input.pages??[],routed:value.ocrRoutedPages.map(page=>page+1)});
          const restored=await service.preparePdf({...input,pages:undefined,ocrProvider:undefined,layout:undefined,
            pdfProfile:{cacheKey:value.cacheKey,profile:value.profile,status:value.status}});
          if(JSON.stringify(restored.ocrRoutedPages)!==JSON.stringify(value.ocrRoutedPages))throw new Error('Reopening changed OCR coverage');
          return value;
        }});
      const destinations=prepared.passageGeometry.targets.flatMap(target=>target.pages.map(page=>page.pageNumber));
      const displayed=prepared.pageLabels.flatMap((label,index)=>label===pinpoint?[index+1]:[]);
      const draft=createAuthoritiesDraft({kind:'manual'},{},'book');
      const attached={bindingRole:'source',filename:'case.pdf',sourceSha256:row.sha256,origin:'original',sourceUrl:row.url,language:'en'};
      const authority={id:'case',citation:row.citation,locators:[{kind:'page',label:pinpoint}],source:{kind:'attached',sources:[attached]}};
      draft.authorities.case=authority;draft.settings.passageMarking='sidelined';
      const marks=prepareAuthorityAnnotations(pdf,await PDFDocument.load(bytes),draft,authority,attached,prepared,true);
      const highlighted=[...new Set(marks.annotations.marks.flatMap(mark=>mark.fragments.map(fragment=>fragment.pageNumber)))];
      result={pinpoint,destinations,displayed,highlighted,ocrRuns,bindings,
        ...(oracle ? {expectedPdfPage:oracle.pdf_page,
          oracleMatch:destinations.length===1 && destinations[0]===oracle.pdf_page &&
            displayed.length===1 && displayed[0]===oracle.pdf_page &&
            highlighted.length===1 && highlighted[0]===oracle.pdf_page} : {}),
        agreement:destinations.length===1&&JSON.stringify(destinations)===JSON.stringify(displayed)&&JSON.stringify(displayed)===JSON.stringify(highlighted),
        ocrTextPages:prepared.ocrTextByPage.flatMap((text,index)=>text?[index+1]:[])};
    } catch(error) { result={pinpoint,bindings,error:String(error)}; }
    result.elapsedMs=performance.now()-started;
    fs.writeFileSync(receipt,JSON.stringify(result));
    console.log(JSON.stringify({citation:row.citation,pinpoint:result.pinpoint,
      expectedPdfPage:result.expectedPdfPage,destinations:result.destinations,
      displayed:result.displayed,highlighted:result.highlighted,
      agreement:result.agreement,oracleMatch:result.oracleMatch,
      ocrRuns:result.ocrRuns,elapsedMs:Math.round(result.elapsedMs),error:result.error}));return;
  }
  const filename = path.join(out,row.sha256+'.prediction.json');
  const previous = JSON.parse(fs.readFileSync(filename));
  if (previous.partialOcrChecked) return;
  if(row.origin !== 'original') return;
  const bytes = fs.readFileSync(row.path), started=performance.now();
  const reference={documentId:row.sha256,versionId:row.sha256,sourceSha256:row.sha256};
  const source={...reference,fileType:'pdf',reporterOriginal:true,readBytes:()=>bytes};
  const citations=row.citations, starts=reporterStartPages(citations);
  let labels=await service.pdfPageLabels(source,citations), anchor=-1, recognized=0;
  const findAnchor=()=>labels.findIndex(label=>label && starts.includes(Number(label)));
  anchor=findAnchor();
  for(let number=1;anchor<0 && number<=Math.min(3,labels.length);number++) {
    const prepared=await service.preparePdf({...reference,bytes,ocrProvider:'kraken-lite',layout:false,
      pages:Array.from({length:number},(_,i)=>i+1)});
    source.pdfProfile={cacheKey:prepared.cacheKey,profile:prepared.profile,status:prepared.status};
    recognized=number;labels=await service.pdfPageLabels(source,citations);anchor=findAnchor();
  }
  let agreement=null;
  if(anchor>=0) {
    const destination=Math.min(anchor+2,labels.length-1),pinpoint=labels[destination];
    const draft=createAuthoritiesDraft({kind:'manual'},{},'book');
    const attached={bindingRole:'source',filename:'case.pdf',sourceSha256:row.sha256,origin:'original',sourceUrl:row.url,language:'en'};
    const authority={id:'case',citation:row.citation,locators:[{kind:'page',label:pinpoint}],source:{kind:'attached',sources:[attached]}};
    draft.authorities.case=authority;draft.settings.passageMarking='sidelined';
    const annotations=prepareAuthorityAnnotations(pdf,await PDFDocument.load(bytes),draft,authority,attached,{pageLabels:labels},true);
    const pages=[...new Set(annotations.annotations.marks.flatMap(mark=>mark.fragments.map(fragment=>fragment.pageNumber)))];
    agreement=pages.length===1&&pages[0]===destination+1;
    if(!agreement)throw new Error('Display/highlight disagreement '+row.citation);
  }
  fs.writeFileSync(filename,JSON.stringify({partialOcrChecked:true,recognized,starts,anchor:anchor<0?null:anchor+1,
    elapsedMs:performance.now()-started,agreement,bindings:labels.map((label,i)=>({pdfPage:i+1,label}))}));
  console.log(JSON.stringify({citation:row.citation,anchor:anchor+1||null,recognized,agreement}));
}
(async()=>{
  for(const row of selectedRows) await predict(row);
  console.log('Authorities partial-OCR predictions complete');
})().catch(error=>{console.error(error);process.exitCode=1});
