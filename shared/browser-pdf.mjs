/** Browser PDF mechanics. Hosts supply their own packaged assets and PDF.js imports. */
export function createPdfRuntime(lib, { workerUrl, decoders = {}, fileOrigin = globalThis.location?.protocol === 'file:' }) {
  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  const port = fileOrigin ? new Worker(workerUrl, { type: 'module' }) : undefined;
  const worker = new lib.PDFWorker(port ? { port } : {});
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
    options: { worker, BinaryDataFactory, useWorkerFetch: false, useWasm: true, isEvalSupported: false, enableHWA: true },
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
    maxCanvasPixels: (globalThis.devicePixelRatio || 1) > 2 ? 2_000_000 : undefined,
    enableHWA: true, enableDetailCanvas: (globalThis.devicePixelRatio || 1) <= 2, abortSignal: signal });
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
