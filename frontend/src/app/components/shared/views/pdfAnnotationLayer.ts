import { markContains, validRect, type AnnotationFragment, type AnnotationRect,
  type PdfAnnotation } from '../../../../../../shared/pdf-annotations.mjs';
export type AnnotationTool = 'select' | 'highlight' | 'draw';
export type PdfAnnotationEditorPort = {
  marks: PdfAnnotation[]; selectedId: string | null; tool: AnnotationTool; disabled?: boolean;
  focus?: { id: string; request: number };
  onSelect(id: string | null): void;
  onCreate(fragments: AnnotationFragment[], text: string): void;
};
const NS = 'http://www.w3.org/2000/svg';
const clamp = (v: number) => Math.min(1, Math.max(0, v));
function point(page: HTMLElement, x: number, y: number) {
  const b = page.getBoundingClientRect();
  return [clamp((x-b.left)/b.width), clamp((y-b.top)/b.height)] as const;
}
function rectangle(parent: SVGElement, r: AnnotationRect, color: string, opacity: number, selected = false) {
  const shape = document.createElementNS(NS, 'rect');
  for (const [key,value] of Object.entries({ x:r[0], y:r[1], width:r[2]-r[0], height:r[3]-r[1], 'fill-opacity':opacity }))
    shape.setAttribute(key, String(value));
  shape.setAttribute('fill', color);
  if(selected) { shape.setAttribute('stroke','#334155'); shape.setAttribute('stroke-width','1');
    shape.setAttribute('vector-effect','non-scaling-stroke'); }
  parent.appendChild(shape); return shape;
}
/** Individual text-node ranges avoid ancestor boxes that accidentally select an entire page. */
function selectedPdfFragments(pages: HTMLElement[], range: Range): AnnotationFragment[] {
  const fragments: AnnotationFragment[] = [];
  for(const page of pages) {
    const layer=page.querySelector<HTMLElement>('.pdf-text-layer'), b=page.getBoundingClientRect();
    if(!layer || !b.width || !b.height || !range.intersectsNode(layer)) continue;
    const walker=document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    const rects: AnnotationRect[]=[]; const seen=new Set<string>(); let node: Node | null;
    while((node=walker.nextNode())) {
      if(!node.textContent?.length || !range.intersectsNode(node)) continue;
      const part=document.createRange(); part.selectNodeContents(node);
      if(node===range.startContainer) part.setStart(node,range.startOffset);
      if(node===range.endContainer) part.setEnd(node,range.endOffset);
      if(part.collapsed) continue;
      for(const box of Array.from(part.getClientRects())) {
        if(box.width<.1 || box.height<.1) continue;
        const r: AnnotationRect=[clamp((box.left-b.left)/b.width),clamp((box.top-b.top)/b.height),
          clamp((box.right-b.left)/b.width),clamp((box.bottom-b.top)/b.height)];
        const key=r.map(v=>v.toFixed(7)).join(':');
        if(validRect(r) && !seen.has(key)) { seen.add(key); rects.push(r); }
      }
    }
    if(rects.length) fragments.push({pageNumber:Number(page.dataset.pageNumber),rects});
  }
  return fragments;
}
/** The renderer owns page DOM. Marks never paint the source canvas or modify its text. */
export function attachPdfAnnotationLayer(scroller: HTMLElement, pages: HTMLElement[], port: PdfAnnotationEditorPort) {
  const overlays=new Map<HTMLElement,SVGSVGElement>();
  for(const page of pages) {
    const svg=document.createElementNS(NS,'svg');
    svg.setAttribute('viewBox','0 0 1 1'); svg.setAttribute('preserveAspectRatio','none'); svg.setAttribute('aria-hidden','true');
    svg.dataset.pdfAnnotations='true';
    Object.assign(svg.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none',zIndex:'2',mixBlendMode:'multiply'});
    page.appendChild(svg); overlays.set(page,svg);
    for(const mark of port.marks) {
      const fragment=mark.fragments.find(f=>f.pageNumber===Number(page.dataset.pageNumber));
      if(!fragment) continue;
      const group=document.createElementNS(NS,'g'); group.dataset.annotationId=mark.id; svg.appendChild(group);
      for(const r of fragment.rects) rectangle(group,r,`rgb(${mark.rgb.map(v=>Math.round(v*255)).join(' ')})`,mark.opacity,mark.id===port.selectedId);
    }
  }
  const priorCursor=scroller.style.cursor;
  scroller.style.cursor=port.disabled ? 'default' : port.tool === 'draw' ? 'crosshair' : 'auto';
  let drag: {page:HTMLElement;x:number;y:number;clientX:number;clientY:number;pointerId:number;preview?:SVGRectElement}|undefined;
  const down=(event:PointerEvent)=>{
    if(port.disabled || event.button!==0 || !event.isPrimary) return;
    const page=event.target instanceof Element ? event.target.closest<HTMLElement>('[data-page-number]') : null;
    if(!page || !overlays.has(page)) return;
    const [x,y]=point(page,event.clientX,event.clientY);
    drag={page,x,y,clientX:event.clientX,clientY:event.clientY,pointerId:event.pointerId};
    if(port.tool === 'draw') {
      event.preventDefault(); window.getSelection()?.removeAllRanges(); scroller.setPointerCapture(event.pointerId);
    }
  };
  const area=(event:PointerEvent):AnnotationRect|null=>{
    if(!drag) return null; const [x,y]=point(drag.page,event.clientX,event.clientY);
    return [Math.min(x,drag.x),Math.min(y,drag.y),Math.max(x,drag.x),Math.max(y,drag.y)];
  };
  const move=(event:PointerEvent)=>{
    if(!drag || drag.pointerId!==event.pointerId || port.tool !== 'draw') return;
    const rect=area(event); drag.preview?.remove();
    if(rect && validRect(rect)) drag.preview=rectangle(overlays.get(drag.page)!,rect,'#ffe270',.35,true);
  };
  const cancel=()=>{
    if(!drag) return; drag.preview?.remove();
    if(scroller.hasPointerCapture(drag.pointerId)) scroller.releasePointerCapture(drag.pointerId);
    drag=undefined;
  };
  const up=(event:PointerEvent)=>{
    if(!drag || drag.pointerId!==event.pointerId) return;
    const start=drag, rect=area(event);
    const moved=Math.hypot(event.clientX-start.clientX,event.clientY-start.clientY)>3; cancel();
    if(port.tool==='draw') {
      if(!moved || !rect || !validRect(rect)) return;
      const fragments=[{pageNumber:Number(start.page.dataset.pageNumber),rects:[rect]}];
      port.onCreate(fragments,'');
      return;
    }
    const selection=window.getSelection();
    if(selection?.rangeCount && !selection.isCollapsed && port.tool==='highlight') {
      const range=selection.getRangeAt(0);
      if(!scroller.contains(range.startContainer) || !scroller.contains(range.endContainer)) return;
      const fragments=selectedPdfFragments(pages,range), text=selection.toString().replace(/\s+/gu,' ').trim().slice(0,2_000);
      selection.removeAllRanges();
      if(fragments.length) {
        port.onCreate(fragments,text);
      }
    } else if(!moved && (!selection || selection.isCollapsed)) {
      const [x,y]=point(start.page,event.clientX,event.clientY);
      const tolerance = 5 / start.page.getBoundingClientRect().width;
      const hits=port.marks.filter(mark=>markContains(mark,Number(start.page.dataset.pageNumber),x,y) ||
        mark.kind==='margin' && mark.fragments.some(fragment=>
          fragment.pageNumber===Number(start.page.dataset.pageNumber) && fragment.rects.some(r=>
            x>=r[0]-tolerance && x<=r[2]+tolerance && y>=r[1] && y<=r[3])));
      const index=hits.findIndex(mark=>mark.id===port.selectedId);
      // Cycle overlapping marks rather than making an inner quote impossible to select.
      scroller.focus({preventScroll:true});
      port.onSelect(hits.length ? hits[(index+1)%hits.length].id : null);
    }
  };
  scroller.addEventListener('pointerdown',down); scroller.addEventListener('pointermove',move);
  window.addEventListener('pointerup',up); scroller.addEventListener('pointercancel',cancel);
  return ()=>{
    cancel(); scroller.style.cursor=priorCursor;
    scroller.removeEventListener('pointerdown',down); scroller.removeEventListener('pointermove',move);
    window.removeEventListener('pointerup',up); scroller.removeEventListener('pointercancel',cancel);
    overlays.forEach(svg=>svg.remove());
  };
}
export function focusPdfAnnotation(scroller:HTMLElement,pages:HTMLElement[],mark:PdfAnnotation) {
  const fragment=mark.fragments[0],page=pages[fragment.pageNumber-1]; if(!page) return;
  const b=page.getBoundingClientRect(),c=scroller.getBoundingClientRect(),r=fragment.rects[0];
  scroller.scrollTo({top:Math.max(0,scroller.scrollTop+b.top-c.top+b.height*(r[1]+r[3])/2-scroller.clientHeight/2),
    left:Math.max(0,scroller.scrollLeft+b.left-c.left+b.width*(r[0]+r[2])/2-scroller.clientWidth/2),behavior:'instant'});
}
