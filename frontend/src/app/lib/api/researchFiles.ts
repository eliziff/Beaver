import { apiRequest, segment, pagePath, post, type Page } from "@/app/lib/api/client";
import type { ResearchFile, ResearchAction, ResearchActionResult, ResearchPageItem, ResearchQueryInput, ResearchQueryResult, ResearchSelection } from "@/app/lib/researchFiles";
import type { GroundedAnswer, GroundedEvidence } from "@/app/lib/groundedAnswers";
import type { ColumnConfig, TabularReview } from "./tabular";


export const createResearchFile = (input: { title: string; projectId?: string | null; folderId?: string | null }) =>
  post<ResearchFile>("/source-workspaces", input);
export const getResearchFile = (id: string) =>
  apiRequest<ResearchFile>(`/source-workspaces/${segment(id)}`);
export const getResearchCitation = (id: string, sourceId: string, evidenceId?: string) =>
  apiRequest<{ href: string; label: string; markdown: string }>(pagePath(
    `/source-workspaces/${segment(id)}/citation`, { source_id: sourceId, evidence_id: evidenceId }));
export const actOnResearchFile = (id: string, versionId: string,
  workingRevision: number, action: ResearchAction) =>
  post<ResearchActionResult>(`/source-workspaces/${segment(id)}/actions`, {
    version_id: versionId, working_revision: workingRevision, action,
  });
export const getResearchItems = (id: string, input: { kind: "passages" | "evidence" | "queries" | "history";
  sourceId?: string; cursor?: string | null; limit?: number }, signal?: AbortSignal) =>
  apiRequest<Page<ResearchPageItem> & { total: number }>(pagePath(
    `/source-workspaces/${segment(id)}/items`, {
      kind: input.kind, source_id: input.sourceId, cursor: input.cursor, limit: input.limit,
    }), { signal });
export const runResearchFileQuery = (id: string,
  input: ResearchQueryInput & { versionId: string; workingRevision: number }) =>
  post<ResearchQueryResult>(`/source-workspaces/${segment(id)}/query`, {
    ...input, version_id: input.versionId, working_revision: input.workingRevision,
    versionId: undefined, workingRevision: undefined,
  });
export type ResearchFindingReference = { kind: "answer"; chatId: string; answerId: string; resource: string; claimIndices?: number[] }
  | { kind: "cell"; reviewId: string; rowId: string; columnIndex: number };
export type ResearchFinding = {
  reference: ResearchFindingReference;
  sourceId: string;
  resource: string;
  question: { id?: string; index?: number; title: string; prompt: string } & Pick<ColumnConfig, "format" | "tags">;
  answer: GroundedAnswer & { summary?: string; reasoning?: string; flag?: "green" | "grey" | "yellow" | "red";
    outcome?: "answered" | "not_found"; coverage?: "complete" | "partial" };
  evidence: GroundedEvidence[];
};
export type ResearchViews = { chats: { id: string; title: string | null }[]; tables: { id: string; title: string | null }[] };
export const getWorkspaceViews = (id: string) => apiRequest<ResearchViews>(`/source-workspaces/${segment(id)}/views`);
export const getWorkspaceFindings = (id: string, input: { sourceIds?: string[]; chatId?: string; messageId?: string; offset?: number; limit?: number }, signal?: AbortSignal) =>
  apiRequest<{ items: ResearchFinding[]; total: number; next_offset: number | null; is_running?: boolean }>(
    pagePath(`/source-workspaces/${segment(id)}/findings`, { source_ids: input.sourceIds?.join(","), chatId: input.chatId,
      message_id: input.messageId, offset: input.offset, limit: input.limit ?? 50 }), { signal });
export const ensureSourcesWorkspace = (input: { chatId?: string; tableId?: string; title?: string; projectId?: string }) =>
  post<ResearchFile>("/source-workspaces/ensure", input);
export const bindWorkspaceView = (id: string, input: { chatId?: string; tableId?: string; selection?: ResearchSelection }) =>
  post<ResearchFile>(`/source-workspaces/${segment(id)}/bind`, input);
export type ResearchTableInput = { labelId?: string; columnIndex?: number;
  selection?: ResearchSelection; findingRefs?: ResearchFindingReference[];
  chatId?: string; tableId?: string; fingerprint?: string; design?: ResearchTableDesign; request?: string; repropose?: boolean; model?: string; reasoningEffort?: string };
export type ResearchTableDesign = { title: string; columns: ColumnConfig[];
  cells: { rowId: string; columnIndex: number; itemIds: string[] }[] };
export type ResearchTablePreview = { fingerprint: string; design: ResearchTableDesign;
  question?: string | null; proposed?: boolean; fallback?: string;
  rows: { id: string; title: string; sourceId: string; evidenceIds?: string[] }[];
  stats: { index: number; reused: number; kinds: string[]; evidence: number; existing: boolean }[];
  samples: { rowId: string; columnIndex: number; text: string; kinds: string[] }[] };
export const previewWorkspaceTable = (id: string, input: ResearchTableInput) =>
  post<ResearchTablePreview>(`/source-workspaces/${segment(id)}/table/preview`, input);
export const openWorkspaceTable = (id: string, input: ResearchTableInput) =>
  post<TabularReview>(`/source-workspaces/${segment(id)}/table`, input);
export type ResearchLabelDesign = { title: string;
  labels: { key: string; name: string; parentKey?: string | null; color?: string | null; definition?: string; scope?: "source" | "highlight" }[];
  assignments: { labelKey: string; rowIds: string[]; itemIds?: string[] }[] };
export type ResearchLabelProposal = { title: string; target: "sources" | "passages"; propose: boolean;
  fingerprint: string; design: ResearchLabelDesign; unassigned: { id: string; title: string }[];
  labels: { key: string; name: string; path: string; parentKey: string | null; color: string | null;
    definition?: string; existing: boolean; rows: { id: string; title: string; support: string[] }[] }[] };
export const previewWorkspaceLabels = (id: string, input: Omit<ResearchTableInput, "design">) =>
  post<ResearchLabelProposal>(`/source-workspaces/${segment(id)}/labels/preview`, input);
export const applyWorkspaceLabels = (id: string, input: Omit<ResearchTableInput, "design"> & { design: ResearchLabelDesign }) =>
  post<ResearchFile>(`/source-workspaces/${segment(id)}/labels`, input);
