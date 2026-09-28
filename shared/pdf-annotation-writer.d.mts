import type { PdfAnnotationSet } from './pdf-annotations.mjs';
export function writeAuthorityAnnotations(pdf: typeof import('pdf-lib'), document: import('pdf-lib').PDFDocument,
  set: PdfAnnotationSet, namespace: string, metadata?: {author?: string | null; comments?: boolean}): void;
