import type { Message, Workflow, WorkflowVariant } from "../shared/types";

export type WorkflowSelection = { workflow: Workflow; variant: WorkflowVariant };

export function workflowPath(workflow: Workflow) {
    switch (workflow.launcher.kind) {
        case "authorities": return "/table-of-authorities";
        case "court_records": return "/court-records";
        case "instructions": return `/workflows/${workflow.id}`;
    }
}

export const workflowVariants = (workflow: Workflow, execution?: WorkflowVariant["execution"]) =>
    workflow.launcher.kind === "instructions"
    ? workflow.launcher.variants.filter((variant) => !execution || variant.execution === execution)
    : [];

export const workflowDocumentTab = ({ variant }: WorkflowSelection) =>
    variant.id === "builtin-draft-from-template" ? "templates" as const : "files" as const;

export const workflowMessage = ({ workflow, variant }: WorkflowSelection):
    NonNullable<Message["workflow"]> => ({
        id: workflow.id, variant_id: variant.id, title: workflow.metadata.title,
    });

export const assistantWorkflowLaunch = (selection: WorkflowSelection) => ({
    workflow: workflowMessage(selection), documentTab: workflowDocumentTab(selection),
});
export type AssistantWorkflowLaunch = ReturnType<typeof assistantWorkflowLaunch>;
