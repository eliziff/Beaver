import { directoryResource } from "@/app/lib/api/documents";
import { researchMarkdown, newResearchState } from "@/app/lib/researchFiles";
import { apiRequest, segment, pagePath, post, type Page } from "@/app/lib/api/client";
import type { ResearchFile, ResearchAction, ResearchActionResult, ResearchPageItem, ResearchQueryInput, ResearchQueryResult } from "@/app/lib/researchFiles";


export async function createResearchFile(input: { title: string; projectId?: string | null; folderId?: string | null }) {
  const title = input.title.trim().replace(/\.research\.md$/iu, "") || "Research";
  const document = await directoryResource(input.projectId
    ? { projectId: input.projectId } : { library: "files" }).uploadDocument(
      new File([researchMarkdown(title)], `${title}.research.md`, { type: "text/markdown" }), input.folderId);
  return { document, versionId: document.current_version_id!, workingRevision: 0,
    state: newResearchState() };
}
export const getResearchFile = (id: string) =>
  apiRequest<ResearchFile>(`/single-documents/${segment(id)}/research`);
export const getResearchCitation = (id: string, sourceId: string, evidenceId?: string) =>
  apiRequest<{ href: string; label: string; markdown: string }>(pagePath(
    `/single-documents/${segment(id)}/research/citation`, { source_id: sourceId, evidence_id: evidenceId }));
export const actOnResearchFile = (id: string, versionId: string,
  workingRevision: number, action: ResearchAction) =>
  post<ResearchActionResult>(`/single-documents/${segment(id)}/research/actions`, {
    version_id: versionId, working_revision: workingRevision, action,
  });
export const getResearchItems = (id: string, input: { kind: "passages" | "queries" | "history";
  sourceId?: string; cursor?: string | null; limit?: number }, signal?: AbortSignal) =>
  apiRequest<Page<ResearchPageItem> & { total: number }>(pagePath(
    `/single-documents/${segment(id)}/research/items`, {
      kind: input.kind, source_id: input.sourceId, cursor: input.cursor, limit: input.limit,
    }), { signal });
export const runResearchFileQuery = (id: string,
  input: ResearchQueryInput & { versionId: string; workingRevision: number }) =>
  post<ResearchQueryResult>(`/single-documents/${segment(id)}/research/query`, {
    ...input, version_id: input.versionId, working_revision: input.workingRevision,
    versionId: undefined, workingRevision: undefined,
  });
export const promoteChatResearch = ({ chatId, researchFileId, versionId,
  workingRevision, includeQueries }: {
  chatId: string; researchFileId: string; versionId: string; workingRevision: number;
  includeQueries: boolean;
}) => post<{ document_id: string; version_id: string }>(
  `/chat/${segment(chatId)}/research-files/${segment(researchFileId)}/promote`, {
    version_id: versionId, working_revision: workingRevision, includeQueries,
  });
