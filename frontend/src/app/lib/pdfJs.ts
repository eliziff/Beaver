import jbig2 from "pdfjs-dist/wasm/jbig2.wasm?url";
import openjpeg from "pdfjs-dist/wasm/openjpeg.wasm?url";
import qcms from "pdfjs-dist/wasm/qcms_bg.wasm?url";

import { createPdfRuntime } from '../../../../shared/browser-pdf.mjs';
import { pdfWorkerUrl } from './pdfWorkerUrl';
export { openPdfDocument } from '../../../../shared/browser-pdf.mjs';

const decoders: Record<string, string> = { "jbig2.wasm": jbig2, "openjpeg.wasm": openjpeg, "qcms_bg.wasm": qcms };
export const PDF_DOCUMENT_OPTIONS = {} as ReturnType<typeof createPdfRuntime>['options'];
let pending: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;
export function getPdfJs() {
  return pending ??= import("pdfjs-dist/legacy/build/pdf.mjs").then(async lib => {
    const runtime = createPdfRuntime(lib, {workerUrl: await pdfWorkerUrl(), decoders});
    try { await runtime.options.worker.promise; }
    catch (error) { runtime.destroy(); throw error; }
    Object.assign(PDF_DOCUMENT_OPTIONS, runtime.options);
    return lib;
  }).catch((error: unknown) => { pending = null; throw error; });
}
