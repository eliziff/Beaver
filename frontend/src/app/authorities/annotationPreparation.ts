import { apiResponse } from '@/app/lib/api/client';
import { decodeAnnotationSet, type AnnotationPreparation } from '../../../../shared/pdf-annotations.mjs';
export type { AnnotationPreparation } from '../../../../shared/pdf-annotations.mjs';
import type { AuthoritiesProduct } from './types';
/** The same stateless runtime operation serves the local and integrated hosts. */
export async function prepareAnnotations(product: AuthoritiesProduct, authorityId: string,
  bindingRole: string, file: Blob, signal?: AbortSignal): Promise<AnnotationPreparation> {
  const form = new FormData();
  form.append('draft', JSON.stringify(product.state));
  form.append('authorityId', authorityId); form.append('bindingRole', bindingRole);
  form.append('file', file, 'authority.pdf');
  const response = await apiResponse('/authorities-runtime/annotations', { method: 'POST', body: form, signal });
  const result = await response.json() as AnnotationPreparation;
  return { annotations: decodeAnnotationSet(result.annotations), pageMarked: result.pageMarked };
}
