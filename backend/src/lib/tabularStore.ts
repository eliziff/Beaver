export type TabularScope = {
  userId: string;
  userEmail?: string;
};

export type TabularColumn = {
  index: number;
  name: string;
  prompt: string;
  format?: string;
  tags?: string[];
};

export type TabularCellContent = {
  summary: string;
  flag?: string;
  reasoning?: string;
};

export type TabularReview = Record<string, unknown> & {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string | null;
  columns_config: TabularColumn[];
  document_ids: string[];
  workflow_id: string | null;
  shared_with: string[];
  is_owner: boolean;
};

export type TabularCell = Record<string, unknown> & {
  id: string;
  review_id: string;
  document_id: string;
  column_index: number;
  content: TabularCellContent | null;
  status: "pending" | "generating" | "done" | "error";
};

export type TabularDocument = Record<string, unknown> & {
  id: string;
  filename?: string | null;
};

export class TabularStoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type TabularStore = {
  page(scope: TabularScope, options: {
    projectId: string | null;
    scope: "all" | "in-project" | "standalone";
    q: string;
    limit: number;
    after: [string, string] | null;
  }): Promise<{
    items: Record<string, unknown>[];
    nextAfter: [string, string] | null;
  }>;
  create(scope: TabularScope, input: {
    title?: string;
    projectId: string | null;
    documentIds: string[];
    columns: TabularColumn[];
    workflowId?: string;
  }): Promise<TabularReview>;
  detail(scope: TabularScope, reviewId: string): Promise<{
    review: TabularReview;
    cells: TabularCell[];
    documents: TabularDocument[];
  } | null>;
  people(scope: TabularScope, reviewId: string): Promise<{
    owner: { user_id: string; email: string | null; display_name: string | null };
    members: { email: string; display_name: string | null }[];
  } | null>;
  update(scope: TabularScope, reviewId: string, input: {
    title?: string | null;
    projectId?: string | null;
    columns?: TabularColumn[];
    documentIds?: string[];
    sharedWith?: string[];
  }): Promise<TabularReview | null>;
  delete(scope: TabularScope, reviewId: string): Promise<boolean>;
  clearCells(
    scope: TabularScope,
    reviewId: string,
    documentIds: string[],
  ): Promise<boolean>;
  setCell(scope: TabularScope, input: {
    reviewId: string;
    documentId: string;
    columnIndex: number;
    content: TabularCellContent | null;
    status: TabularCell["status"];
  }): Promise<boolean>;
  recordGeneration(scope: TabularScope, input: {
    reviewId: string;
    title: string | null;
    projectId: string | null;
    model: string;
    failed: boolean;
  }): Promise<void>;
};
