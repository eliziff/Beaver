import {
  type PageQuery,
  type Page,
  apiRequest,
  pagePath,
  post,
  segment,
  patch,
  remove,
  apiBlobRequest,
} from "@/app/lib/api/client";

import type { Document } from "@/app/lib/api/documents";
import type { ProjectPeople } from "@/app/lib/api/projects";
import type { GroundedAnswer, GroundedEvidence } from "@/app/lib/groundedAnswers";
import type { ResearchChange, ResearchProposal, ResearchSelection, ResearchSourceReference } from "@/app/lib/researchFiles";

export type TabularResearchScope = { researchFileId: string; selection: ResearchSelection };
export type TabularScope = { research_file_id?: string; versionId?: string; workingRevision?: number; subjects: {
  rowId?: string; sourceId: string; resource: string; reference: ResearchSourceReference;
  evidence?: GroundedEvidence[];
}[] };
export type TabularDocument = Document & { resource?: string; reference?: ResearchSourceReference; group?: string[] };

export type ColumnFormat =
  | "text"
  | "bulleted_list"
  | "number"
  | "currency"
  | "yes_no"
  | "date"
  | "tag"
  | "percentage"
  | "monetary_amount";
export interface ColumnConfig {
  index: number;
  name: string;
  prompt: string;
  format?: ColumnFormat;
  tags?: string[];
}
export interface TabularReview {
  id: string;
  project_id: string | null;
  user_id: string;
  title: string | null;
  columns_config: ColumnConfig[] | null;
  workflow_id?: string | null;
  shared_with?: string[];
  is_owner?: boolean;
  is_running?: boolean;
  created_at: string;
  updated_at?: string;
  document_count?: number;
  project_name?: string | null;
  scope_config?: TabularScope | null;
  proposals?: ResearchProposal[];
  history_count?: number;
}
export interface TabularCell {
  id: string;
  document_id: string;
  column_index: number;
  content: GroundedAnswer & {
    summary: string;
    flag?: "green" | "grey" | "yellow" | "red";
    reasoning?: string;
    evidence: GroundedEvidence[];
    outcome: "answered" | "not_found";
    coverage: "complete" | "partial";
    resource?: string;
  } | null;
  status: "pending" | "generating" | "done" | "error";
}
export const listTabularReviews = (options: PageQuery & {
  project_id?: string | null;
  scope?: "all" | "in-project" | "standalone";
} = {}, signal?: AbortSignal) => apiRequest<Page<TabularReview>>(
  pagePath("/tabular-review", options), { signal },
);
export const createTabularReview = (payload: {
  title?: string;
  document_ids?: string[];
  columns_config: ColumnConfig[];
  workflow_id?: string;
  project_id?: string;
  research_file_id?: string;
  research_selection?: TabularResearchScope["selection"];
}) => post<TabularReview>("/tabular-review", payload);
export const getTabularReview = (reviewId: string) =>
  apiRequest<{ review: TabularReview; cells: TabularCell[]; documents: TabularDocument[] }>(
    `/tabular-review/${segment(reviewId)}`,
  );
export const updateTabularReview = (
  reviewId: string,
  payload: {
    title?: string;
    columns_config?: ColumnConfig[];
    document_ids?: string[];
    workflow_id?: string | null;
    project_id?: string | null;
    shared_with?: string[];
    research_file_id?: string;
    research_selection?: TabularResearchScope["selection"];
  },
) => patch<TabularReview>(`/tabular-review/${segment(reviewId)}`, payload);
export const getTabularReviewPeople = (reviewId: string) =>
  apiRequest<ProjectPeople>(`/tabular-review/${segment(reviewId)}/people`);
export const getTabularHistory = (reviewId: string, offset = 0, signal?: AbortSignal) =>
  apiRequest<{ items: ResearchChange[]; total: number; next_offset: number | null }>(
    pagePath(`/tabular-review/${segment(reviewId)}/history`, { offset, limit: 50 }), { signal });
export const actOnTabularChange = (review: Pick<TabularReview, "id" | "updated_at">, id: string, action: "accept" | "reject" | "undo") =>
  post<TabularReview>(`/tabular-review/${segment(review.id)}/changes`, { id, action, expected_version: review.updated_at });
export const generateTabularColumnPrompt = (
  title: string,
  options?: { format?: string; documentName?: string; tags?: string[] },
) => post<{ prompt: string }>(
  "/tabular-review/prompt",
  {
    title,
    format: options?.format,
    documentName: options?.documentName,
    tags: options?.tags,
  },
);
export const deleteTabularReview = (reviewId: string) =>
  remove<void>(`/tabular-review/${segment(reviewId)}`);
export const exportTabularReview = (reviewId: string) =>
  apiBlobRequest(`/tabular-review/${segment(reviewId)}/export`);
export const ensureTabularWorkspace = (reviewId: string) =>
  post<{ research_file_id: string }>(`/tabular-review/${segment(reviewId)}/workspace`);
export const startTabularGeneration = (
  reviewId: string,
  options?: { model?: string; reasoningEffort?: string },
) => post<{ job_ids: string[]; queued: number }>(
  `/tabular-review/${segment(reviewId)}/generate`, {
  model: options?.model,
  reasoning_effort: options?.reasoningEffort,
});
export const stopTabularGeneration = (reviewId: string) =>
  post<{ stopped: boolean }>(`/tabular-review/${segment(reviewId)}/stop`);
export const regenerateTabularCell = (
  reviewId: string,
  documentId: string,
  columnIndex: number,
  options?: { model?: string; reasoningEffort?: string },
): Promise<{ job_id: string; queued: true }> => post(
  `/tabular-review/${segment(reviewId)}/regenerate-cell`, {
  document_id: documentId,
  column_index: columnIndex,
  model: options?.model,
  reasoning_effort: options?.reasoningEffort,
});
export const clearTabularCells = (reviewId: string, documentIds: string[]) =>
  post<void>(`/tabular-review/${segment(reviewId)}/clear-cells`, {
    document_ids: documentIds,
  });
