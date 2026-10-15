import type { ApplicationScope } from "./applicationError";
import type { WorkflowStore } from "./chat/types";
import type { WorkflowCategory, WorkflowExecution } from "./systemWorkflows";
import type { WorkflowAudience } from "mike/shared/runtime/clientContracts.mjs";

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
  documents(workflowId: string): Promise<Array<{ id: string; filename: string; current_version_id: string;
    current_working_revision: number; source_sha256: string; size_bytes: number }>>;
  list(options: WorkflowListOptions): Promise<WorkflowRecord[]>;
  create(input: WorkflowValues): Promise<WorkflowRecord>;
  get(workflowId: string): Promise<WorkflowAccess | null>;
  update(workflowId: string, input: WorkflowUpdate): Promise<WorkflowAccess | null>;
  remove(workflowId: string): Promise<boolean>;
  assistants(): Promise<WorkflowStore>;
};
export type CreateWorkflowRepository = (scope: ApplicationScope) => WorkflowRepository;
