type Caret = { node: Node; offset: number };
type Run = { element: HTMLElement; left: number; right: number; top: number; bottom: number };

/** A drag follows the nearest text run, including inter-word/line gaps, not PDF drawing order. */
export function attachPdfTextSelection(scroller: HTMLElement, enabled: () => boolean) {
  let drag: { anchor: Caret; x: number; y: number } | undefined;
  let frame = 0;
  let runs = new WeakMap<HTMLElement, Run[]>();
  const caret = (x: number, y: number, starting = false): Caret | undefined => {
    let best: Run | undefined, score = Infinity, bounds: DOMRect | undefined;
    for (const layer of scroller.querySelectorAll<HTMLElement>('.pdf-text-layer')) {
      const box = layer.getBoundingClientRect();
      if (starting && (x < box.left || x > box.right || y < box.top || y > box.bottom)) continue;
      let items = runs.get(layer);
      if (!items) {
        items = Array.from(layer.querySelectorAll<HTMLElement>('[data-pdf-text-run]'), element => {
          const r = element.getBoundingClientRect();
          return { element, left: r.left-box.left, right: r.right-box.left,
            top: r.top-box.top, bottom: r.bottom-box.top };
        }).filter(r => r.right > r.left && r.bottom > r.top);
        runs.set(layer, items);
      }
      for (const item of items) {
        const dx = Math.max(box.left+item.left-x, x-box.left-item.right, 0);
        const dy = Math.max(box.top+item.top-y, y-box.top-item.bottom, 0);
        const distance = dx*dx + dy*dy;
        if (distance < score) { score = distance; best = item; bounds = box; }
      }
    }
    if (!best || !bounds || starting && score > Math.max(12, best.bottom-best.top)**2) return;
    const px = Math.max(bounds.left+best.left+.1, Math.min(bounds.left+best.right-.1, x));
    const py = bounds.top+(best.top+best.bottom)/2;
    const doc = document as Document & {
      caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?(x: number, y: number): Range | null;
    };
    const position = doc.caretPositionFromPoint?.(px, py);
    const range = !position ? doc.caretRangeFromPoint?.(px, py) : undefined;
    const node = position?.offsetNode ?? range?.startContainer;
    if (node && best.element.contains(node)) return { node, offset: position?.offset ?? range!.startOffset };
    return { node: best.element, offset: x < bounds.left+(best.left+best.right)/2 ? 0 : best.element.childNodes.length };
  };
  const extend = () => {
    if (!drag || !drag.anchor.node.isConnected) return;
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
    drag = undefined; runs = new WeakMap();
    if (frame) cancelAnimationFrame(frame); frame = 0;
  };
  const down = (event: MouseEvent) => {
    if (!enabled() || event.button !== 0 || event.detail !== 1 || event.ctrlKey || event.metaKey || event.altKey ||
        !(event.target instanceof Element) || !event.target.closest('.pdf-text-layer')) return;
    runs = new WeakMap();
    const at = caret(event.clientX, event.clientY, true), selection = document.getSelection();
    if (!at || !selection) return;
    const anchor = event.shiftKey && selection.anchorNode && scroller.contains(selection.anchorNode)
      ? { node: selection.anchorNode, offset: selection.anchorOffset } : at;
    event.preventDefault();
    scroller.focus({ preventScroll: true });
    drag = { anchor, x: event.clientX, y: event.clientY }; extend();
  };
  const move = (event: PointerEvent) => {
    if (!drag || !(event.buttons & 1)) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const up = (event: PointerEvent) => {
    if (!drag) return;
    drag.x = event.clientX; drag.y = event.clientY; extend(); stop();
  };
  scroller.addEventListener('mousedown', down);
  window.addEventListener('pointermove', move);
  // Commit the last endpoint before annotation capture handles the release.
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);
  return () => {
    stop(); scroller.removeEventListener('mousedown', down);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', stop); window.removeEventListener('blur', stop);
  };
}
