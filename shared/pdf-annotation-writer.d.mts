import type { PdfAnnotationSet } from './pdf-annotations.mjs';
export function annotatePdf(engine: { pdfWriteAnnotations(bytes: Uint8Array, marks: unknown[], namespace: string, disarm?: boolean): { bytes: Uint8Array } },
  bytes: Uint8Array, set: PdfAnnotationSet, namespace: string, options?: { disarm?: boolean }): Uint8Array;
