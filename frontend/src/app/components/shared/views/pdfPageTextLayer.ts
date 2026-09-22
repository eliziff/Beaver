import type { PDFPageProxy, TextLayer } from 'pdfjs-dist';
import type { PdfRecognizedText } from '@/app/lib/api/documents';
import { renderRecognizedText } from './pdfRecognizedText';

type RecognizedPage = PdfRecognizedText['pages'][number];
export type PdfPageTextLoader = (page: number, signal: AbortSignal) => Promise<RecognizedPage | undefined>;
const hasText = (page?: RecognizedPage) => page?.lines.some(line => line.words.length || line.text?.trim());

/** One owner per resident page. Native readiness, OCR refresh and disposal are independent. */
export function createPdfPageTextLayer(options: {
  wrapper: HTMLElement; page: Promise<PDFPageProxy>; pageNumber: number; scale: number;
  TextLayer: typeof TextLayer; source?: RecognizedPage; loader?: PdfPageTextLoader;
  onReady(): void;
}) {
  let disposed = false, element: HTMLDivElement | undefined, native: TextLayer | undefined;
  let source = options.source, loader = options.loader, installed: RecognizedPage | undefined;
  let viewport: ReturnType<PDFPageProxy['getViewport']>;
  let cancelRefresh = () => {};
  const createElement = () => {
    const div = document.createElement('div');
    div.className = 'pdf-text-layer'; div.dataset.legalText = String(options.pageNumber);
    Object.assign(div.style, {position:'absolute',left:'0',top:'0',zIndex:'1',
      width:`${viewport.width}px`,height:`${viewport.height}px`});
    div.style.setProperty('--scale-factor', String(options.scale));
    return div;
  };
  const finish = (div: HTMLDivElement) => {
    const end = document.createElement('div'); end.className = 'endOfContent'; div.append(end);
    div.addEventListener('mousedown', () => div.classList.add('selecting'));
    options.onReady();
  };
  const install = (page: RecognizedPage) => {
    if (installed === page) return;
    const next = createElement();
    renderRecognizedText(next, page, viewport.width, viewport.height);
    native?.cancel?.(); native = undefined;
    if (element?.isConnected) element.replaceWith(next); else options.wrapper.append(next);
    element = next; installed = page; finish(next);
  };
  // This promise must not wait for an optional OCR response: quote navigation uses native text.
  const ready = options.page.then(async page => {
    if (disposed) return;
    viewport = page.getViewport({scale:options.scale});
    if (hasText(options.source)) { install(options.source!); return; }
    element = createElement(); options.wrapper.append(element);
    native = new options.TextLayer({textContentSource:page.streamTextContent(),container:element,viewport});
    await native.render();
    if (disposed) return;
    for (const div of native.textDivs) div.dataset.pdfTextRun = '';
    finish(element);
  }).catch(cause => {
    if (disposed) return;
    native?.cancel?.(); native = undefined; element?.remove();
    console.warn('PDF text selection unavailable', cause);
  });
  const refresh = (nextSource?: RecognizedPage, nextLoader?: PdfPageTextLoader, force = false) => {
    if (disposed || !force && nextSource === source && nextLoader === loader) return;
    source = nextSource; loader = nextLoader; cancelRefresh();
    const abort = new AbortController();
    let pending: RecognizedPage | undefined;
    const apply = () => {
      if (disposed || abort.signal.aborted || !pending) return;
      const selection = document.getSelection();
      // A late OCR response must not detach the text the user is currently selecting.
      if (element?.isConnected && selection && !selection.isCollapsed &&
          Array.from({length:selection.rangeCount}, (_, i) => selection.getRangeAt(i)).some(range => range.intersectsNode(element!))) {
        document.addEventListener('selectionchange', apply); return;
      }
      document.removeEventListener('selectionchange', apply);
      install(pending); pending = undefined;
    };
    cancelRefresh = () => { abort.abort(); pending = undefined; document.removeEventListener('selectionchange', apply); };
    // Turn synchronous adapter errors into the same handled rejection as fetch errors.
    void Promise.resolve().then(() => {
      if (disposed || abort.signal.aborted) return;
      return nextSource ?? nextLoader?.(options.pageNumber, abort.signal);
    }).then(async page => {
      await ready;
      if (disposed || abort.signal.aborted || !page || !hasText(page)) return;
      pending = page; apply();
    }).catch(cause => { if (!disposed && !abort.signal.aborted) console.warn('PDF text selection unavailable', cause); });
  };
  refresh(source, loader, true);
  return {ready, refresh, destroy() {
    if (disposed) return;
    disposed = true; cancelRefresh(); native?.cancel?.(); native = undefined; element?.remove();
  }};
}
