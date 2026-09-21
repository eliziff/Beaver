import { rectDistance, selectedPdfFragments, textLines } from "./pdfSelectionGeometry";

type Caret = { node: Node; offset: number };

/** Zotero-style line hit testing with native character carets; one band per line for every selection path. */
export function attachPdfTextSelection(scroller: HTMLElement, enabled: () => boolean) {
  let drag: { anchor: Caret; x: number; y: number; startX: number; startY: number; moved: boolean } | undefined;
  let frame = 0;
  let previewFrame = 0;
  const previews = new Map<HTMLElement, SVGSVGElement>();
  const clearPreview = () => {
    for (const svg of previews.values()) svg.remove();
    previews.clear(); scroller.classList.remove('pdf-line-selection');
  };
  const paintSelection = () => {
    previewFrame = 0;
    const selection = document.getSelection();
    if (!enabled() || !selection?.rangeCount || selection.isCollapsed ||
        !scroller.contains(selection.anchorNode) || !scroller.contains(selection.focusNode)) {
      clearPreview(); return;
    }
    const pages = [...scroller.querySelectorAll<HTMLElement>('.pdf-text-layer')]
      .map(layer => layer.closest<HTMLElement>('[data-page-number]')!);
    const byNumber = new Map(pages.map(page => [Number(page.dataset.pageNumber), page]));
    const fragments = selectedPdfFragments(pages, selection.getRangeAt(0));
    const retained = new Set<HTMLElement>();
    for (const fragment of fragments) {
      const page = byNumber.get(fragment.pageNumber);
      if (!page) continue;
      retained.add(page);
      let svg = previews.get(page);
      if (!svg) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('pdf-selection-overlay'); svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('viewBox', '0 0 1 1'); svg.setAttribute('preserveAspectRatio', 'none');
        svg.append(document.createElementNS(svg.namespaceURI, 'path'));
        page.append(svg); previews.set(page, svg);
      }
      const d = fragment.rects.map(([x0, y0, x1, y1]) => `M${x0} ${y0}H${x1}V${y1}H${x0}Z`).join('');
      if (svg.firstElementChild!.getAttribute('d') !== d) svg.firstElementChild!.setAttribute('d', d);
    }
    for (const [page, svg] of previews) if (!retained.has(page)) { svg.remove(); previews.delete(page); }
    // Leave native selection visible when geometry is not available (e.g. a still-loading page).
    scroller.classList.toggle('pdf-line-selection', !!fragments.length);
  };
  const preview = () => { if (!previewFrame) previewFrame = requestAnimationFrame(paintSelection); };
  const caret = (x: number, y: number, startPage?: HTMLElement): Caret | undefined => {
    let layer: HTMLElement | undefined, bounds: DOMRect | undefined, distance = Infinity;
    for (const candidate of scroller.querySelectorAll<HTMLElement>('.pdf-text-layer')) {
      const page = candidate.closest<HTMLElement>('[data-page-number]')!;
      if (startPage && page !== startPage) continue;
      const box = page.getBoundingClientRect();
      const score = rectDistance([box.left, box.top, box.right, box.bottom], x, y);
      if (score < distance) { distance = score; layer = candidate; bounds = box; }
    }
    if (!layer || !bounds) return;
    const px = x - bounds.left, py = y - bounds.top;
    // Choose a line before a run: whitespace within a line is not a collection of glyph hit targets.
    let line, score = Infinity;
    for (const candidate of textLines(layer, bounds)) {
      const distance = rectDistance(candidate.rect, px, py);
      if (distance < score) { score = distance; line = candidate; }
    }
    if (!line) return;
    let run = line.runs[0]; score = Infinity;
    for (const candidate of line.runs) {
      const distance = rectDistance(candidate.rect, px, py);
      if (distance < score) { score = distance; run = candidate; }
    }
    const [x0, y0, x1, y1] = run.rect;
    const cx = bounds.left + (line.vertical ? (x0 + x1) / 2 : Math.max(x0 + .1, Math.min(x1 - .1, px)));
    const cy = bounds.top + (line.vertical ? Math.max(y0 + .1, Math.min(y1 - .1, py)) : (y0 + y1) / 2);
    const doc = document as Document & {
      caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?(x: number, y: number): Range | null;
    };
    const position = doc.caretPositionFromPoint?.(cx, cy);
    const range = !position ? doc.caretRangeFromPoint?.(cx, cy) : undefined;
    const node = position?.offsetNode ?? range?.startContainer;
    if (node && run.element.contains(node)) return { node, offset: position?.offset ?? range!.startOffset };
    const before = line.vertical ? py < (y0 + y1) / 2 : px < (x0 + x1) / 2;
    return { node: run.element, offset: before !== (run.element.dir === 'rtl') ? 0 : run.element.childNodes.length };
  };
  const extend = () => {
    if (!drag || !enabled() || !drag.anchor.node.isConnected) { stop(); return; }
    const box = scroller.getBoundingClientRect();
    const end = caret(Math.max(box.left+2, Math.min(box.right-2, drag.x)),
      Math.max(box.top+2, Math.min(box.bottom-2, drag.y)));
    const selection = document.getSelection();
    if (end && selection && (selection.anchorNode !== drag.anchor.node || selection.anchorOffset !== drag.anchor.offset ||
        selection.focusNode !== end.node || selection.focusOffset !== end.offset))
      selection.setBaseAndExtent(drag.anchor.node, drag.anchor.offset, end.node, end.offset);
  };
  const tick = () => {
    frame = 0;
    if (!drag) return;
    const box = scroller.getBoundingClientRect();
    const dy = drag.y < box.top+24 ? -Math.min(24, box.top+24-drag.y)
      : drag.y > box.bottom-24 ? Math.min(24, drag.y-box.bottom+24) : 0;
    const dx = drag.x < box.left ? -16 : drag.x > box.right ? 16 : 0;
    const top = scroller.scrollTop, left = scroller.scrollLeft;
    if (dy || dx) scroller.scrollBy(dx, dy);
    extend();
    if (scroller.scrollTop !== top || scroller.scrollLeft !== left) frame = requestAnimationFrame(tick);
  };
  const stop = () => {
    drag = undefined;
    if (frame) cancelAnimationFrame(frame); frame = 0;
  };
  const down = (event: MouseEvent) => {
    if (!enabled() || event.button !== 0 || event.detail !== 1 || event.ctrlKey || event.metaKey || event.altKey ||
        !(event.target instanceof Element) || event.target.closest('a,button,input,textarea,select,[contenteditable=true]')) return;
    const page = event.target.closest<HTMLElement>('[data-page-number]');
    if (!page || !scroller.contains(page)) return;
    const at = caret(event.clientX, event.clientY, page), selection = document.getSelection();
    if (!at || !selection) return;
    const anchor = event.shiftKey && selection.anchorNode && scroller.contains(selection.anchorNode)
      ? { node: selection.anchorNode, offset: selection.anchorOffset } : at;
    event.preventDefault();
    scroller.focus({ preventScroll: true });
    drag = { anchor, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false }; extend();
  };
  const move = (event: PointerEvent) => {
    if (!drag) return;
    if (!(event.buttons & 1)) { stop(); return; }
    drag.moved ||= Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3;
    if (!drag.moved) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const up = (event: PointerEvent) => {
    if (!drag) return;
    // Mouse compatibility events round coordinates; a click must not become a one-character drag.
    if (drag.moved || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) {
      drag.x = event.clientX; drag.y = event.clientY; extend();
    }
    stop();
  };
  document.addEventListener('selectionchange', preview);
  scroller.addEventListener('mousedown', down);
  window.addEventListener('pointermove', move);
  // Commit the last endpoint before annotation capture handles the release.
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);
  return () => {
    stop(); clearPreview();
    if (previewFrame) cancelAnimationFrame(previewFrame);
    document.removeEventListener('selectionchange', preview);
    scroller.removeEventListener('mousedown', down);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', stop); window.removeEventListener('blur', stop);
  };
}
