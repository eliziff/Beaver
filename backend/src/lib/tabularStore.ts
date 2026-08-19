import type { ApplicationScope } from "./applicationError";

export type TabularScope = ApplicationScope;

export type TabularColumn = { index: number; name: string; prompt: string;
  format?: string; tags?: string[] };
export type TabularCellContent = { summary: string; flag?: string; reasoning?: string };

export type TabularReview = Record<string, unknown> & {
  id: string; user_id: string; project_id: string | null; title: string | null;
  columns_config: TabularColumn[]; document_ids: string[]; workflow_id: string | null;
  shared_with: string[]; is_owner: boolean; updated_at: string;
};

export type TabularCell = Record<string, unknown> & {
  id: string; review_id: string; document_id: string; column_index: number;
  content: TabularCellContent | null;
  status: "pending" | "generating" | "done" | "error";
};

export type WriteResult<T> = { status: "committed"; value: T }
  | { status: "conflict"; value: T }
  | { status: "missing" };

export type ReviewInput = { title?: string | null; projectId?: string | null;
  columns?: TabularColumn[]; documentIds?: string[]; workflowId?: string | null;
  sharedWith?: string[] };

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
  setCell(scope: TabularScope, input: {
    reviewId: string; documentId: string; columnIndex: number;
    expected: Pick<TabularCell, "status" | "content">;
    content: TabularCellContent | null; status: TabularCell["status"];
  }): Promise<WriteResult<TabularCell>>;
  recordGeneration(scope: TabularScope, input: { reviewId: string; title: string | null;
    projectId: string | null; model: string; failed: boolean }): Promise<void>;
};
