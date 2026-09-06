import { apiRequest, pagePath, post, segment } from "@/app/lib/api/client";
import type { ResearchFile } from "@/app/lib/researchFiles";

export type OntologyWorkspaceMembership = Record<string, {
  workspaces: Array<{ id: string; title: string; sourceId: string }>;
  labels: Array<{ id: string; name: string; color: string | null; workspaceId: string }>;
}>;

export const getOntologyWorkspace = (projectId?: string | null) =>
  apiRequest<ResearchFile | null>(pagePath("/source-workspaces/ontology",
    { project_id: projectId ?? undefined }));
export const ensureOntologyWorkspace = (projectId?: string | null) =>
  post<ResearchFile>(`/source-workspaces/ontology`, { projectId: projectId ?? null });
export const getWorkspaceMembership = (documentIds: string[], projectId?: string | null,
  signal?: AbortSignal) =>
  apiRequest<OntologyWorkspaceMembership>(pagePath("/source-workspaces/membership",
    { project_id: projectId ?? undefined, document_ids: documentIds.join(",") }), { signal });
