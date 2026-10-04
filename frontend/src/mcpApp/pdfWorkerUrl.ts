import worker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw";

/** PDF.js's worker, started from the copy this page carries: the page fetches nothing. */
let started: string | undefined;
export const pdfWorkerUrl = async () =>
  started ??= URL.createObjectURL(new Blob([worker], { type: "text/javascript" }));
