import type { Message } from "@/app/lib/api/chat";
import type { Workflow, WorkflowVariant } from "@/app/lib/api/workflows";

export type WorkflowSelection = { workflow: Workflow; variant: WorkflowVariant };

export function workflowPath(workflow: Workflow) {
    switch (workflow.launcher.kind) {
        case "authorities": return "/table-of-authorities";
        case "court_records": return "/court-records";
        case "quote_check": return "/workflows?workflow=quote-checking";
        case "fix_supras": return "/workflows?workflow=fix-supras";
        case "instructions": return `/workflows/${workflow.id}`;
    }
}

export const workflowDocumentTab = ({ variant }: WorkflowSelection) =>
    variant.id === "builtin-draft-from-template" ? "templates" as const : "files" as const;

export const workflowMessage = ({ workflow, variant }: WorkflowSelection):
    NonNullable<Message["workflow"]> => ({
        id: workflow.id, variant_id: variant.id, title: variant.label,
    });

export const assistantWorkflowLaunch = (selection: WorkflowSelection) => ({
    workflow: workflowMessage(selection), documentTab: workflowDocumentTab(selection),
});
export type AssistantWorkflowLaunch = ReturnType<typeof assistantWorkflowLaunch>;
