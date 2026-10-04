import { createPdfRuntime } from '../../../../shared/browser-pdf.mjs';
import { pdfDecoders } from './pdfDecoders';
import { pdfWorkerUrl } from './pdfWorkerUrl';
export { openPdfDocument } from '../../../../shared/browser-pdf.mjs';

export const PDF_DOCUMENT_OPTIONS = {} as ReturnType<typeof createPdfRuntime>['options'];
let pending: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;
export function getPdfJs() {
  return pending ??= import("pdfjs-dist/legacy/build/pdf.mjs").then(async lib => {
    const [workerUrl, decoders] = await Promise.all([pdfWorkerUrl(), pdfDecoders()]);
    const runtime = createPdfRuntime(lib, {workerUrl, decoders});
    try { await runtime.options.worker.promise; }
    catch (error) { runtime.destroy(); throw error; }
    Object.assign(PDF_DOCUMENT_OPTIONS, runtime.options);
    return lib;
  }).catch((error: unknown) => { pending = null; throw error; });
}
