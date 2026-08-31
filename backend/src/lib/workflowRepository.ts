import type { ApplicationScope } from "./applicationError";
import type { WorkflowStore } from "./chat/types";
import type {
  WorkflowAudience,
  WorkflowCategory,
  WorkflowExecution,
} from "./systemWorkflows";

export type WorkflowRecord = Record<string, unknown> & {
  id: string;
  user_id: string | null;
  title: string;
  execution: WorkflowExecution;
  variant_label: string;
  variant_result: string | null;
  prompt_md: string | null;
  columns_config: unknown[] | null;
  language: string | null;
  version: string | null;
  category: WorkflowCategory;
  audiences: WorkflowAudience[];
  jurisdictions: string[] | null;
  contributors: unknown;
  created_at: string;
};
export type WorkflowAccess = {
  workflow: WorkflowRecord;
  allowEdit: boolean;
  isOwner: boolean;
  sharedByName?: string | null;
};
export type WorkflowValues = {
  title: string;
  execution: WorkflowExecution;
  variantLabel: string;
  variantResult: string | null;
  promptMd: string | null;
  columns: unknown[] | null;
  language: string | null;
  category: WorkflowCategory;
  audiences: WorkflowAudience[];
  jurisdictions: string[] | null;
};
export type WorkflowUpdate = Partial<WorkflowValues>;
export type WorkflowListOptions = {
  q: string;
  audience: WorkflowAudience | "all";
};
export type WorkflowRepository = {
  list(options: WorkflowListOptions): Promise<WorkflowRecord[]>;
  create(input: WorkflowValues): Promise<WorkflowRecord>;
  get(workflowId: string): Promise<WorkflowAccess | null>;
  update(workflowId: string, input: WorkflowUpdate): Promise<WorkflowAccess | null>;
  remove(workflowId: string): Promise<boolean>;
  assistants(): Promise<WorkflowStore>;
};
export type CreateWorkflowRepository = (scope: ApplicationScope) => WorkflowRepository;

export type WorkflowShare = {
  id: string;
  shared_with_email: string;
  allow_edit: boolean;
  created_at: string;
};
export type WorkflowSubmission = {
  id: string;
  status: string;
  submitted_at: string;
  updated_at: string;
  reviewed_at: string | null;
};
export type WorkflowCollaboration = {
  shares(scope: ApplicationScope, workflowId: string): Promise<WorkflowShare[] | null>;
  removeShare(scope: ApplicationScope, workflowId: string, shareId: string): Promise<boolean>;
  share(scope: ApplicationScope, workflowId: string, emails: string[], allowEdit: boolean):
    Promise<"ok" | "missing" | { missingEmail: string }>;
  latestSubmission(scope: ApplicationScope, workflowId: string): Promise<WorkflowSubmission | null>;
  submit(scope: ApplicationScope, workflow: WorkflowRecord, input: {
    contributorMode: "named" | "anonymous";
    contributor?: Record<string, string | null>;
    metadata: Record<string, unknown>;
  }): Promise<WorkflowSubmission & { mode: "created" | "updated" }>;
};
