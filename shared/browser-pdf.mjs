/** Browser PDF mechanics. Hosts supply their own packaged assets and PDF.js imports. */
export function createPdfRuntime(lib, { workerUrl, decoders = {}, fileOrigin = globalThis.location?.protocol === 'file:' }) {
  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  const port = fileOrigin ? new Worker(workerUrl, { type: 'module' }) : undefined;
  const worker = new lib.PDFWorker(port ? { port } : {});
  // Preloading may never open a document; its task reports startup failures when used.
  void worker.promise.catch(() => {});
  class BinaryDataFactory {
    constructor(urls) { this.urls = urls; }
    async fetch({ kind, filename }) {
      const url = kind === 'wasmUrl' ? decoders[filename] : `${this.urls[kind]}${filename}`;
      if (!url) throw new Error(`Unknown PDF decoder: ${filename}`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`PDF asset could not be loaded: ${filename}`);
      return new Uint8Array(await response.arrayBuffer());
    }
  }
  return {
    // A page opened from disk may load no font file: standard fonts come as data through fetch, not as system fonts
    // whose fallback is a file URL.
    options: { worker, BinaryDataFactory, useWorkerFetch: false, useWasm: true, isEvalSupported: false, enableHWA: true,
      ...(fileOrigin && { useSystemFonts: false }) },
    destroy() { worker?.destroy(); port?.terminate(); },
  };
}

/** PDF.js transfers byte ownership to its worker; callers keep their original bytes. */
export function openPdfDocument(lib, input, options) {
  return lib.getDocument({ ...input, ...options, ...(input.data && { data: input.data.slice() }) });
}

/** PDF.js owns raster scheduling, page retention and zoom previews in every host. */
export function createPdfViewer({ PDFViewer, EventBus }, container, element, signal) {
  // Keep page movement on the compositor while PDF painting occupies the main thread.
  const previousWillChange = container.style.willChange;
  container.style.willChange = 'transform';
  const eventBus = new EventBus();
  const viewer = new PDFViewer({ container, viewer: element, eventBus,
    removePageBorders: true, // Page, canvas and selection coordinates must share the same box.
    textLayerMode: 0, annotationMode: 0, annotationEditorMode: -1,
    // PDF.js's own canvas limit and detail canvas on every screen: a page past the limit renders whole at
    // reduced size, its visible area sharp.
    enableHWA: true, abortSignal: signal,
    // Without one, every viewer parses PDF.js's whole Fluent bundle and translates each page as it
    // is added; the page names it would give are set where the pages are made (pdf/viewer.ts).
    l10n: { translate() {}, pause() {}, resume() {} } });
  // A stamp or signature applied as an annotation is part of the page: the canvas draws each annotation's
  // appearance (AnnotationMode.ENABLE) while PDF.js builds no annotation layer, whose per-page work slowed
  // drawing by a fifth. Page views exist at pagesinit, before any is drawn.
  eventBus.on('pagesinit', () => { for (let i = 0; i < viewer.pagesCount; i++) {
    const view = viewer.getPageView(i), context = view._getRenderingContext.bind(view);
    view._getRenderingContext = (...args) => ({ ...context(...args), annotationMode: 1 });
  }});
  eventBus.on('pagerendered', ({pageNumber, error}) => {
    if (!error || signal.aborted) return;
    const page = viewer.getPageView(pageNumber - 1).div;
    if (page.querySelector('[data-pdf-error]')) return;
    const message = document.createElement('p'); message.setAttribute('role', 'alert'); message.dataset.pdfError = '';
    message.textContent = `Unable to render page ${pageNumber}.`; page.append(message);
  });
  return { viewer, eventBus, destroy() {
    for (let i = 0; i < viewer.pagesCount; i++) viewer.getPageView(i).destroy();
    viewer.setDocument(null);
    container.style.willChange = previousWillChange;
  }};
}
