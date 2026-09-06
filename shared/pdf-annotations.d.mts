export type AnnotationRect = [number, number, number, number];
export type AnnotationFragment = { pageNumber: number; rects: AnnotationRect[] };
export type PdfAnnotation = {
  id: string; kind: 'highlight' | 'margin'; origin: 'automatic' | 'manual';
  label: string; excerpt: string; rgb: [number, number, number]; opacity: number;
  fragments: AnnotationFragment[];
};
export type PdfAnnotationSet = {
  schemaVersion: 'beaver.pdf-annotations.v1'; sourceSha256: string; marks: PdfAnnotation[];
};
export type PdfAnnotationSets = Record<string, PdfAnnotationSet>;
export const ANNOTATION_SCHEMA: 'beaver.pdf-annotations.v1';
export function validRect(rect: unknown): rect is AnnotationRect;
export function decodeAnnotationSet(value: unknown): PdfAnnotationSet;
export function emptyAnnotationSet(sourceSha256: string): PdfAnnotationSet;
export function annotationSetForSource(sets: PdfAnnotationSets | undefined, role: string, sourceSha256: string): PdfAnnotationSet | undefined;
export function subtractRect(rect: AnnotationRect, cut: AnnotationRect): AnnotationRect[];
export function eraseAnnotations(marks: PdfAnnotation[], cuts: AnnotationFragment[]): PdfAnnotation[];
export function markContains(mark: PdfAnnotation, pageNumber: number, x: number, y: number): boolean;
export function rectToPdfQuad(rect: AnnotationRect, crop: { x: number; y: number; width: number; height: number }, rotation: number): number[];
export function quadBounds(quads: number[][]): number[];
