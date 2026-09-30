import type { PDFDocumentProxy, TextLayer } from 'pdfjs-dist';
import type * as ViewerModule from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import { createPdfViewer } from '../browser-pdf.mjs';
import { attachPdfAnnotationLayer, focusPdfAnnotation, type PdfAnnotationEditorPort } from './pdfAnnotationLayer';
import { attachPdfTextSelection } from './pdfTextSelection';
import { createPdfPageTextLayer, type PdfPageTextLoader } from './pdfPageTextLayer';
import type { RecognizedPage } from './pdfRecognizedText';
import type { PdfAnnotation } from '../pdf-annotations.mjs';

export const PDF_ZOOM_MIN = .5, PDF_ZOOM_MAX = 3, PDF_ZOOM_STEP = .25;
const clampZoom = (value: number) => Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, value));

/** PDF.js owns raster work; this session owns Beaver's resident text, marks and interaction. */
export function createPdfSession(options: {
  lib: Pick<typeof ViewerModule, 'PDFViewer' | 'EventBus'>; TextLayer: typeof TextLayer;
  pdf: PDFDocumentProxy; container: HTMLElement; element: HTMLElement; signal: AbortSignal;
  readEditor?: () => PdfAnnotationEditorPort | undefined;
  readText?: (number: number) => RecognizedPage | undefined;
  readTextLoader?: () => PdfPageTextLoader | undefined;
  onTextReady?: (number: number, element: HTMLElement) => void;
  onPage?: (number: number) => void; onZoom?: (zoom: number) => void;
  onRendered?: (number: number, error?: unknown) => void; onError: (error: unknown) => void;
}) {
  const {pdf,container,element}=options, abort=new AbortController(), {signal}=abort;
  const {viewer,eventBus,destroy:destroyViewer}=createPdfViewer(options.lib,container,element,signal);
  const pendingText=new Set<number>();
  const pages: HTMLElement[]=[], layers=new Map<number, {
    holder: HTMLElement; scale: number; layer: ReturnType<typeof createPdfPageTextLayer>;
  }>();
  let annotations: ReturnType<typeof attachPdfAnnotationLayer> | undefined;
  let zoom=1, fit=1, frame=0, settle=0, zooming=false, navigation=0, disposed=false;
  let requestedZoom=1, origin: number[] | undefined;
  const release=(number: number)=>{
    const entry=layers.get(number);entry?.layer.destroy();entry?.holder.remove();layers.delete(number);
  };
  const updateAnnotations=(number?: number)=>{
    if(!options.readEditor?.()) { annotations?.destroy();annotations=undefined;return; }
    annotations ??= attachPdfAnnotationLayer(container,pages,()=>options.readEditor!()!);
    annotations.update(number);
  };
  const sync=(number: number)=>{
    const view=viewer.getPageView(number-1);if(!view)return;
    pages[number-1]=view.div;
    Object.assign(view.div.dataset,{pdfScale:String(view.viewport.scale),geometryReady:String(!!view.pdfPage),
      legalBlock:'',locatorKind:'page',locatorValue:String(number)});
    view.div.style.visibility=view.pdfPage?'':'hidden';
    const entry=layers.get(number);
    if(entry) {
      if(!entry.holder.isConnected)release(number);
      else { entry.holder.style.transform=view.viewport.scale===entry.scale?'':`scale(${view.viewport.scale/entry.scale})`;
        entry.holder.style.pointerEvents=zooming?'none':''; }
    }
  };
  const ensureText=(number: number)=>{
    if(signal.aborted)return Promise.resolve();
    const view=viewer.getPageView(number-1);if(!view?.pdfPage)return Promise.resolve();
    let entry=layers.get(number);
    if(entry && (!entry.holder.isConnected || entry.scale!==view.viewport.scale)) {release(number);entry=undefined;}
    if(!entry) {
      const holder=document.createElement('div');
      Object.assign(holder.style,{position:'absolute',inset:'0',transformOrigin:'0 0'});view.div.append(holder);
      const layer=createPdfPageTextLayer({wrapper:holder,page:Promise.resolve(view.pdfPage),pageNumber:number,
        scale:view.viewport.scale,TextLayer:options.TextLayer,source:options.readText?.(number),loader:options.readTextLoader?.(),
        onReady:()=>{if(!signal.aborted)options.onTextReady?.(number,view.div);}});
      entry={holder,layer,scale:view.viewport.scale};layers.set(number,entry);
    }
    return entry.layer.ready;
  };
  const preparePage=async(number: number)=>{
    if(!Number.isInteger(number) || number<1 || number>pdf.numPages || signal.aborted)return false;
    try {
      const view=viewer.getPageView(number-1),page=view.pdfPage ?? await pdf.getPage(number);
      if(signal.aborted)return false;
      if(!view.pdfPage)view.setPdfPage(page);
      sync(number);updateAnnotations(number);return true;
    } catch(error) { if(!signal.aborted)options.onError(error);return false; }
  };
  const navigate=async(number: number,mark?: PdfAnnotation)=>{
    const request=++navigation;
    if(!await preparePage(number) || request!==navigation || signal.aborted)return false;
    if(mark)focusPdfAnnotation(container,pages,mark);else viewer.scrollPageIntoView({pageNumber:number});
    return true;
  };
  const setZoom=(value: number,at?: number[])=>{
    requestedZoom=clampZoom(value);origin=at;
    if(frame)return;
    frame=requestAnimationFrame(()=>{
      frame=0;if(signal.aborted || !viewer.pagesCount)return;
      zoom=requestedZoom;zooming=true;clearTimeout(settle);
      // PDFViewer subtracts offsetTop/Left, not the viewport rect (nested modals differ).
      const box=container.getBoundingClientRect();
      const anchor=origin && [origin[0]-box.left+container.offsetLeft,origin[1]-box.top+container.offsetTop];
      viewer.updateScale({scaleFactor:fit*zoom/viewer.currentScale,origin:anchor,drawingDelay:150});
      options.onZoom?.(zoom);
      settle=window.setTimeout(()=>{
        zooming=false;
        for(const number of new Set([...layers.keys(),...pendingText])) {
          const view=viewer.getPageView(number-1);
          if(view?.div.querySelector('canvas')) {sync(number);void ensureText(number);} else release(number);
        }
        pendingText.clear();
      },170);
    });
  };
  const resize=()=>{
    const first=viewer.getPageView(0)?.pdfPage;if(!first)return;
    fit=Math.max(.1,(container.clientWidth-24)/first.getViewport({scale:1}).width)/(96/72);
    viewer.currentScale=fit*zoom;
  };
  let width=container.clientWidth;
  const observer=new ResizeObserver(()=>{if(width!==container.clientWidth){width=container.clientWidth;resize();}});
  observer.observe(container);
  const detachSelection=attachPdfTextSelection(container,()=>!zooming && !options.readEditor?.()?.disabled && options.readEditor?.()?.tool!=='draw');
  container.addEventListener('wheel',event=>{
    if(!event.ctrlKey)return;
    event.preventDefault();
    const delta=event.deltaMode===0?event.deltaY/300:event.deltaY*.1;
    setZoom(requestedZoom*Math.exp(-delta),[event.clientX,event.clientY]);
  },{passive:false,signal});
  let distance=0, pinchZoom=1;
  const touchDistance=(touches: TouchList)=>Math.hypot(touches[0].clientX-touches[1].clientX,touches[0].clientY-touches[1].clientY);
  container.addEventListener('touchstart',event=>{
    if(event.touches.length===2){distance=touchDistance(event.touches);pinchZoom=requestedZoom;}
  },{passive:true,signal});
  container.addEventListener('touchmove',event=>{
    if(event.touches.length!==2 || !distance)return;
    event.preventDefault();setZoom(pinchZoom*touchDistance(event.touches)/distance,
      [(event.touches[0].clientX+event.touches[1].clientX)/2,(event.touches[0].clientY+event.touches[1].clientY)/2]);
  },{passive:false,signal});
  for(const type of ['touchend','touchcancel'])container.addEventListener(type,()=>{distance=0;},{passive:true,signal});
  const ready=new Promise<void>(resolve=>{
    signal.addEventListener('abort',()=>resolve(),{once:true});
    eventBus.on('pagesinit',()=>{
      if(signal.aborted)return;
      for(let number=1;number<=viewer.pagesCount;number++)sync(number);
      resize();updateAnnotations();resolve();
    });
  });
  eventBus.on('pagesloaded',()=>{
    if(!signal.aborted)for(let number=1;number<=viewer.pagesCount;number++)sync(number);
  });
  eventBus.on('scalechanging',()=>{if(!signal.aborted)for(const number of layers.keys())sync(number);});
  eventBus.on('pagechanging',({pageNumber}: {pageNumber:number})=>{if(!signal.aborted)options.onPage?.(pageNumber);});
  eventBus.on('pagerendered',({pageNumber,error,cssTransform}: {pageNumber:number;error?:unknown;cssTransform?:boolean})=>{
    if(signal.aborted)return;
    // PDF.js may evict another page while rendering this one. Release only detached layers.
    for(const [number,entry] of layers)if(!entry.holder.isConnected)release(number);
    sync(pageNumber);updateAnnotations(pageNumber);
    if(!error && !cssTransform) {if(zooming)pendingText.add(pageNumber);else void ensureText(pageNumber);}
    options.onRendered?.(pageNumber,error);
  });
  const destroy=()=>{
    if(disposed)return;disposed=true;abort.abort();navigation++;observer.disconnect();
    cancelAnimationFrame(frame);clearTimeout(settle);detachSelection();annotations?.destroy();
    for(const number of layers.keys())release(number);
    destroyViewer();options.signal.removeEventListener('abort',destroy);
  };
  options.signal.addEventListener('abort',destroy,{once:true});
  viewer.setDocument(pdf);void viewer.pagesPromise?.catch((error: unknown)=>{if(!signal.aborted)options.onError(error);});
  if(options.signal.aborted)destroy();
  return {viewer,pages,ready,preparePage,ensureText,navigate,setZoom,updateAnnotations,destroy,
    get zoom(){return requestedZoom;},
    focusAnnotation(mark: PdfAnnotation){return navigate(mark.fragments[0].pageNumber,mark);},
    refreshText(){for(const [number,entry] of layers)entry.layer.refresh(options.readText?.(number),options.readTextLoader?.());},
  };
}
export type PdfSession = ReturnType<typeof createPdfSession>;
