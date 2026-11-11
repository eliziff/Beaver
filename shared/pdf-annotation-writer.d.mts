import type { PdfAnnotationSet } from './pdf-annotations.mjs';
import type { EngineOperations } from './engine-types/operations';
export function annotatePdf(engine: Pick<EngineOperations, 'pdfWriteAnnotations'>,
  bytes: Uint8Array, set: PdfAnnotationSet, namespace: string, options?: { disarm?: boolean }): Uint8Array;
