import type { ApplicationScope } from "./applicationError";
import type { WorkflowStore } from "./chat/types";

export type WorkflowType = "assistant" | "tabular";
export type WorkflowRecord = Record<string, unknown> & {
  id: string;
  user_id: string | null;
  title: string;
  type: WorkflowType;
  prompt_md: string | null;
  columns_config: unknown[] | null;
  language: string | null;
  version: string | null;
  practice: string | null;
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
  type: WorkflowType;
  promptMd: string | null;
  columns: unknown[] | null;
  language: string | null;
  practice: string | null;
  jurisdictions: string[] | null;
};
export type WorkflowUpdate = Partial<Omit<WorkflowValues, "type">>;
export type WorkflowPageOptions = {
  q: string;
  type: WorkflowType | null;
  limit: number;
  after: [string, string] | null;
};
export type WorkflowRepository = {
  page(options: WorkflowPageOptions): Promise<{
    items: WorkflowRecord[];
    nextAfter: [string, string] | null;
  }>;
  hidden(): Promise<string[]>;
  hide(workflowId: string): Promise<void>;
  unhide(workflowId: string): Promise<void>;
  create(input: WorkflowValues): Promise<WorkflowRecord>;
  get(workflowId: string): Promise<WorkflowAccess | null>;
  update(workflowId: string, input: WorkflowUpdate): Promise<WorkflowAccess | null>;
  remove(workflowId: string): Promise<boolean>;
  assistants(): Promise<WorkflowStore>;
};
export type CreateWorkflowRepository = (
  scope: ApplicationScope,
) => WorkflowRepository;

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
