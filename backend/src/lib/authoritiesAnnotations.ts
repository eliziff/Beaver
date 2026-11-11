import type { PassageGeometry } from 'mike/shared/engine-types/PassageGeometry';
import type { AnnotationRect } from 'mike/shared/pdf-annotations.mjs';
export type { AnnotationPreparation } from 'mike/shared/pdf-annotations.mjs';

/** A cited locator as the book writes it: "s 33(1)", "art 49", "r 20.01", "para 12", "p 4". */
export const locatorLabel = (kind: string, value: string) =>
  `${({ paragraph: 'para', section: 's', article: 'art', rule: 'r' } as Record<string, string>)[kind] ?? 'p'} ${value}`;
export const normalizePassageRect = (rect: number[], width: number, height: number): AnnotationRect =>
  [rect[0] / width, rect[1] / height, rect[2] / width, rect[3] / height]
    .map(v => Math.min(1, Math.max(0, v))) as AnnotationRect;

/** A paragraph pinpoint is located only by its printed number, which the engine witnesses. */
export const hasPrintedParagraphLocator = (target: PassageGeometry['targets'][number]) =>
  target.locatorKind !== 'paragraph' || target.printed === true;
