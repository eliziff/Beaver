import manifest from "./systemWorkflows.json";

export type SystemWorkflowContributor = {
  name: string;
  organisation: string | null;
  role: string | null;
  linkedin: string | null;
};

export type SystemWorkflowMetadata = {
  title: string;
  description: string;
  type: "assistant" | "tabular";
  contributors: SystemWorkflowContributor[];
  language: string;
  version: string;
  practice: string | null;
  jurisdictions: string[] | null;
};

export type SystemWorkflow = {
  id: string;
  user_id: null;
  is_system: true;
  created_at: string;
  metadata: SystemWorkflowMetadata;
  skill_md: string | null;
  columns_config: {
    index: number;
    name: string;
    format?: string;
    prompt: string;
    tags?: string[];
  }[] | null;
};

export const SYSTEM_WORKFLOWS =
  manifest as unknown as SystemWorkflow[];
export const SYSTEM_WORKFLOW_IDS = new Set(
  SYSTEM_WORKFLOWS.map((workflow) => workflow.id),
);
export const SYSTEM_ASSISTANT_WORKFLOWS = SYSTEM_WORKFLOWS.flatMap(
  (workflow) =>
    workflow.metadata.type === "assistant"
      ? [{
          id: workflow.id,
          title: workflow.metadata.title,
          skill_md: workflow.skill_md ?? "",
        }]
      : [],
);
