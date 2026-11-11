import type { AnnotationMark } from './engine-types/AnnotationMark';
export type { AnnotationFragment } from './engine-types/AnnotationFragment';
export type AnnotationRect = [number, number, number, number];
/** A mark as the engine places and writes it. */
export type PdfAnnotation = AnnotationMark;
export type PdfAnnotationSet = {
  schemaVersion: 'beaver.pdf-annotations.v1'; sourceSha256: string; marks: PdfAnnotation[];
};
export type PdfAnnotationSets = Record<string, PdfAnnotationSet>;
export type AnnotationPreparation = { annotations: PdfAnnotationSet; pageMarked: string[] };
export const ANNOTATION_SCHEMA: 'beaver.pdf-annotations.v1';
export function validRect(rect: unknown): rect is AnnotationRect;
export function decodeAnnotationSet(value: unknown): PdfAnnotationSet;
export function emptyAnnotationSet(sourceSha256: string): PdfAnnotationSet;
export function annotationSetForSource(sets: PdfAnnotationSets | undefined, role: string, sourceSha256: string): PdfAnnotationSet | undefined;
export function markContains(mark: PdfAnnotation, pageNumber: number, x: number, y: number): boolean;
