import type { ColumnConfig } from "@/app/lib/api/tabular";
import {
  pagePath,
  apiRequest,
  segment,
  post,
  patch,
  remove,
  apiBlobRequest,
  streamRequest,
} from "@/app/lib/api/client";

export type { WorkflowAudience } from "../../../../../backend/src/lib/systemWorkflows";
import type { WorkflowAudience } from "../../../../../backend/src/lib/systemWorkflows";
export interface WorkflowVariant {
  id: string;
  label: string;
  description?: string | null;
  result: string | null;
  execution: "assistant" | "tabular";
  skill_md: string | null;
  columns_config: ColumnConfig[] | null;
}
export type WorkflowLauncher =
  | { kind: "instructions"; variants: WorkflowVariant[] }
  | { kind: "authorities" }
  | { kind: "court_records" } | { kind: "fix_supras" } | { kind: "quote_check"; variants: WorkflowVariant[] };
export interface Workflow {
  id: string;
  user_id: string | null;
  metadata: {
    title: string;
    description: string | null;
    category: string;
    audiences: WorkflowAudience[];
    contributors: {
      name: string;
      organisation: string | null;
      role: string | null;
      linkedin: string | null;
    }[];
    language: string;
    version: string | null;
    jurisdictions: string[] | null;
  };
  launcher: WorkflowLauncher;
  is_system: boolean;
  created_at: string;
  shared_by_name?: string | null;
  allow_edit?: boolean;
  is_owner?: boolean;
  source_commit?: string;
  references?: Array<{ filename: string; sha256: string; size_bytes: number; variant_id?: string }>;
}
const workflowLists = new Map<string, Promise<Workflow[]>>();
export const listWorkflows = (options: {
  audience?: "general" | "solicitor" | "litigator" | "all";
  q?: string;
} = {}, signal?: AbortSignal) => {
  const path = pagePath("/workflows", options);
  if (signal) return apiRequest<Workflow[]>(path, { signal });
  const pending = workflowLists.get(path);
  if (pending) return pending;
  const request = apiRequest<Workflow[]>(path).finally(() => {
    // Deduplicate concurrent reads, but do not freeze an independently
    // installed catalogue (or another user's grants) for the whole session.
    if (workflowLists.get(path) === request) workflowLists.delete(path);
  });
  workflowLists.set(path, request);
  return request;
};
const refreshWorkflowLists = <T>(request: Promise<T>) => request.then((result) => {
  workflowLists.clear();
  return result;
});
export const getWorkflow = (workflowId: string) =>
  apiRequest<Workflow>(`/workflows/${segment(workflowId)}`);
export const exportWorkflow = (workflowId: string) =>
  apiBlobRequest(`/workflows/${segment(workflowId)}/export`);
export const downloadWorkflowReference = (workflowId: string, filename: string, sha256: string) =>
  apiBlobRequest(`/workflows/${segment(workflowId)}/references/${segment(filename)}?sha256=${segment(sha256)}`);
export const createWorkflow = (payload: {
  metadata: {
    title: string;
    category: string;
    audiences: Workflow["metadata"]["audiences"];
    language?: string | null;
    jurisdictions?: string[] | null;
  };
  launcher: {
    kind: "instructions";
    variants: Array<{
      label: string;
      result?: string | null;
      execution: "assistant" | "tabular";
      skill_md?: string | null;
      columns_config?: ColumnConfig[] | null;
    }>;
  };
}) => refreshWorkflowLists(post<Workflow>("/workflows", payload));
export const updateWorkflow = (
  workflowId: string,
  payload: {
    metadata?: Partial<Pick<
      Workflow["metadata"],
      "title" | "category" | "audiences" | "jurisdictions"
    >> & { language?: string | null };
    launcher?: Parameters<typeof createWorkflow>[0]["launcher"];
  },
) => refreshWorkflowLists(patch<Workflow>(`/workflows/${segment(workflowId)}`, payload));
export const deleteWorkflow = (workflowId: string) =>
  refreshWorkflowLists(remove<void>(`/workflows/${segment(workflowId)}`));
export const streamQuoteCheck = (documentId: string, versionId?: string | null) =>
  streamRequest("/quote-check", { documentId, ...(versionId && { versionId }) }, { accept: "text/event-stream" });
