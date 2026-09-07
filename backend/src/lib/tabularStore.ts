import type { ApplicationScope } from "./applicationError";
import type { GroundedResult, GroundedAnswerFlag } from "./groundedAnswer";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import { parseResourceReference } from "./resourceReferences";
import type { ResearchChange, ResearchChangeSummary } from "./researchHistory";
import type { ResearchArrangement } from "./tabular/researchArrangement";
import type { ResearchSelection, ResearchSubject } from "./researchSelection";
import type { ResearchFindingReference } from "./researchFindingReference";

export type TabularScope = ApplicationScope;

export type TabularColumn = { index: number; name: string; prompt: string;
  format?: string; tags?: string[] };
export type TabularCellContent = GroundedResult & {
  summary: string; flag?: GroundedAnswerFlag; reasoning?: string;
  evidence: LegalEvidenceReceipt[]; query_ids?: string[]; outcome: "answered" | "not_found";
  coverage: "complete" | "partial"; resource: string;
  origin?: { chatId?: string; messageId?: string; researchFileId?: string; versionId?: string;
    workingRevision?: number; items?: ResearchArrangement["cells"][number]["items"] };
};
export type TabularSelection = { research_file_id?: string; versionId?: string;
  workingRevision?: number; subjects: ResearchSubject[]; arrangement?: ResearchArrangement;
  frozen?: boolean;
  selection?: ResearchSelection;
  findings?: { chatId?: string; answerIds?: string[]; sourceIds: string[]; references?: ResearchFindingReference[] } };
export const tabularSubjectId = (subject: Pick<ResearchSubject, "resource" | "rowId">) => {
  if (subject.rowId) return subject.rowId;
  const reference = parseResourceReference(subject.resource);
  return reference?.kind === "document" ? reference.documentId : subject.resource;
};

export type TabularReview = Record<string, unknown> & {
  id: string; user_id: string; project_id: string | null; title: string | null;
  columns_config: TabularColumn[]; document_ids: string[]; workflow_id: string | null;
  shared_with: string[]; is_owner: boolean; updated_at: string;
  scope_config?: TabularSelection;
  proposals?: ResearchChangeSummary[]; history_count?: number;
};

export type TabularCell = Record<string, unknown> & {
  id: string; review_id: string; document_id: string; column_index: number;
  content: TabularCellContent | null;
  status: "pending" | "generating" | "done" | "error";
};

export type WriteResult<T> = { status: "committed"; value: T }
  | { status: "conflict"; value: T }
  | { status: "missing" };
export type TabularOperation = { executor: "human" | "assistant"; model?: string;
  title?: string; changeKey?: string; propose?: boolean };

export type ReviewInput = { title?: string | null; projectId?: string | null;
  columns?: TabularColumn[]; documentIds?: string[]; workflowId?: string | null;
  sharedWith?: string[]; scopeConfig?: TabularSelection; operation?: TabularOperation;
  seedCells?: Pick<TabularCell, "document_id" | "column_index" | "content" | "status">[] };

export type TabularRepository = {
  page(scope: TabularScope, options: {
    projectId: string | null; scope: "all" | "in-project" | "standalone";
    q: string; limit: number; after: [string, string] | null;
  }): Promise<{ items: Record<string, unknown>[]; nextAfter: [string, string] | null }>;
  create(scope: TabularScope, input: Required<Pick<ReviewInput,
    "projectId" | "columns" | "documentIds">> & ReviewInput):
    Promise<WriteResult<TabularReview>>;
  detail(scope: TabularScope, reviewId: string): Promise<{ review: TabularReview;
    cells: TabularCell[] } | null>;
  people(scope: TabularScope, reviewId: string): Promise<{
    owner: { user_id: string; email: string | null; display_name: string | null };
    members: { email: string; display_name: string | null }[];
  } | null>;
  missingRecipient(scope: TabularScope, emails: string[]): Promise<string | null>;
  update(scope: TabularScope, reviewId: string, expectedVersion: string,
    input: ReviewInput): Promise<WriteResult<TabularReview>>;
  delete(scope: TabularScope, reviewId: string, expectedVersion: string):
    Promise<WriteResult<null>>;
  deleteAll(scope: TabularScope): Promise<number>;
  history(scope: TabularScope, reviewId: string, input: { offset: number; limit: number }): Promise<{
    items: ResearchChange[]; total: number; next_offset: number | null;
  } | null>;
  change(scope: TabularScope, reviewId: string, changeId: string,
    action: "accept" | "reject" | "undo", expectedVersion: string, operation?: TabularOperation): Promise<WriteResult<TabularReview>>;
  setCell(scope: TabularScope, input: {
    reviewId: string; documentId: string; columnIndex: number;
    expected: Pick<TabularCell, "status" | "content"> & { updated_at?: string };
    expectedReviewVersion?: string;
    operation?: TabularOperation;
    content: TabularCellContent | null; status: TabularCell["status"];
  }): Promise<WriteResult<TabularCell>>;
  recordGeneration(scope: TabularScope, input: { reviewId: string; title: string | null;
    projectId: string | null; model: string; failed: boolean }): Promise<void>;
};
