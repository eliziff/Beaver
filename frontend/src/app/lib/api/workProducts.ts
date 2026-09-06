import type { WorkProductKind, WorkProduct, WorkProductMetadata, WorkProductResolution, WorkProductCreate, WorkProductPatch } from "@/app/lib/workProducts";
import { apiRequest, pagePath, segment, post, patch, remove } from "@/app/lib/api/client";

export const listWorkProducts = <State>(kind: WorkProductKind, projectId?: string) =>
  apiRequest<WorkProduct<State>[]>(pagePath("/work-products", {
    kind,
    project_id: projectId,
    limit: 100,
  }));
export const listWorkProductMetadata = (kind: WorkProductKind, projectId?: string, signal?: AbortSignal) =>
  apiRequest<WorkProductMetadata[]>(pagePath("/work-products", {
    kind, project_id: projectId, metadata: true,
  }), { signal });
export const getWorkProduct = <State>(id: string) =>
  apiRequest<WorkProduct<State>>(`/work-products/${segment(id)}`);
export const getWorkProductResolution = <State>(id: string) =>
  apiRequest<WorkProductResolution<State>>(`/work-products/${segment(id)}/resolution`);
export const createWorkProduct = <State>(input: WorkProductCreate<State>) =>
  post<WorkProduct<State>>("/work-products", {
    kind: input.kind,
    title: input.title,
    project_id: input.projectId,
    state: input.state,
  });
export const updateWorkProduct = <State>(id: string, input: WorkProductPatch<State>) =>
  patch<WorkProduct<State>>(`/work-products/${segment(id)}`, {
    ...input,
    project_id: input.projectId,
    projectId: undefined,
  });
export const duplicateWorkProduct = <State>(id: string,
  input: { title?: string; projectId?: string | null } = {}) =>
  post<WorkProduct<State>>(`/work-products/${segment(id)}/duplicate`, {
    title: input.title, project_id: input.projectId,
  });
export const deleteWorkProduct = (id: string) =>
  remove<void>(`/work-products/${segment(id)}`);
