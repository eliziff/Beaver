import manifest from "./systemWorkflows.json";

export const WORKFLOW_AUDIENCES = ["general", "solicitor", "litigator"] as const;
export type WorkflowAudience = typeof WORKFLOW_AUDIENCES[number];
export const WORKFLOW_CATEGORIES = [
  "Drafting and document preparation",
  "Document review and comparison",
  "Research and verification",
  "Agreements",
  "Due diligence",
  "Transactions and closing",
  "Corporate records",
  "Written submissions",
  "Evidence and discovery",
  "Court and hearing materials",
] as const;
export type WorkflowCategory = typeof WORKFLOW_CATEGORIES[number];
export type WorkflowExecution = "assistant" | "tabular";

export type WorkflowContributor = {
  name: string;
  organisation: string | null;
  role: string | null;
  linkedin: string | null;
};
export type InstructionVariant = {
  id: string;
  label: string;
  description?: string | null;
  result: string | null;
  execution: WorkflowExecution;
  skill_md: string | null;
  columns_config: {
    index: number;
    name: string;
    format?: string;
    prompt: string;
    tags?: string[];
  }[] | null;
};
export type WorkflowLauncher =
  | { kind: "instructions"; variants: InstructionVariant[] }
  | { kind: "authorities" }
  | { kind: "court_records" };
export type SystemWorkflow = {
  id: string;
  user_id: null;
  is_system: true;
  created_at: string;
  metadata: {
    title: string;
    description: string;
    category: WorkflowCategory;
    audiences: WorkflowAudience[];
    contributors: WorkflowContributor[];
    language: string;
    version: string;
    jurisdictions: string[];
  };
  launcher: WorkflowLauncher;
};

export const SYSTEM_WORKFLOWS = manifest as unknown as SystemWorkflow[];
export const SYSTEM_WORKFLOW_IDS = new Set(SYSTEM_WORKFLOWS.map(({ id }) => id));
export const SYSTEM_ASSISTANT_WORKFLOWS = SYSTEM_WORKFLOWS.flatMap((workflow) =>
  workflow.launcher.kind === "instructions"
    ? workflow.launcher.variants.flatMap((variant) =>
      variant.execution === "assistant" && variant.skill_md
        ? [{ id: workflow.id, variant_id: variant.id,
          title: workflow.metadata.title, skill_md: variant.skill_md }]
        : [])
    : []);

export function workflowVisibleTo(
  audiences: readonly WorkflowAudience[],
  audience: WorkflowAudience | "all",
) {
  return audience === "all" || audiences.includes("general") || audiences.includes(audience);
}
