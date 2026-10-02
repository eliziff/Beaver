/** Where PDF.js starts its worker from. The standalone page replaces this module with one that
 *  hands over the worker it carries gzipped (AuthoritiesHelper/modern/html/standalone-pdf-worker.mjs). */
export const pdfWorkerUrl = async () =>
  new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
