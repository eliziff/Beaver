import { authoritiesOperation } from './runtimeClient';
import { decodeAnnotationSet, type AnnotationPreparation } from '../../../../shared/pdf-annotations.mjs';
export type { AnnotationPreparation } from '../../../../shared/pdf-annotations.mjs';
import type { AuthoritiesProduct } from './types';
/** The standalone host supplies local bytes, read when the preparation runs; embedded review
 *  uses its bound-document operation. */
export async function prepareAnnotations(product: AuthoritiesProduct, authorityId: string,
  bindingRole: string, file: Blob | (() => Promise<Blob>), signal?: AbortSignal): Promise<AnnotationPreparation> {
  const response = await authoritiesOperation('annotations', {
    draft: product.state, authorityId, bindingRole, files: [typeof file === 'function' ? await file() : file],
  }, { signal });
  const result = response.data as AnnotationPreparation;
  return { annotations: decodeAnnotationSet(result.annotations), pageMarked: result.pageMarked };
}
