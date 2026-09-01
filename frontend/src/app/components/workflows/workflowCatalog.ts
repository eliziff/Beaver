import type { Workflow, WorkflowAudience, WorkflowVariant } from "../shared/types";

export type AudienceFilter = WorkflowAudience | "all";
export const AUDIENCE_TABS: { id: AudienceFilter; label: string }[] = [
    { id: "general", label: "General" },
    { id: "solicitor", label: "Solicitor" },
    { id: "litigator", label: "Litigator" },
    { id: "all", label: "All" },
];

export const WORKFLOW_CATEGORIES = [
    ["Drafting and document preparation", "Drafting"],
    ["Document review and comparison", "Review & compare"],
    ["Research and verification", "Research & verify"],
    ["Agreements", "Agreements"],
    ["Due diligence", "Due diligence"],
    ["Transactions and closing", "Transactions & closing"],
    ["Corporate records", "Corporate approvals"],
    ["Written submissions", "Written submissions"],
    ["Evidence and discovery", "Evidence & discovery"],
    ["Court and hearing materials", "Court materials"],
    ["Templates", "Templates"],
] as const;

const LABELS: Record<string, string> = {
    drafting: "Draft, revise or proofread",
    "document-review": "Analyze documents",
    "legal-research": "Research a legal issue",
    "quote-checking": "Check quotations",
    "agreement-work": "Review an agreement",
    "due-diligence": "Due diligence",
    "transaction-management": "Prepare a conditions checklist",
    "corporate-approvals": "Review corporate approvals",
    "submission-drafting": "Draft or revise submissions",
    "evidence-review": "Review evidence",
    authorities: "Create table/book of authorities",
    "court-records": "Court Records",
};
const START_IDS = new Set(["legal-research", "court-records", "authorities"]);

interface CatalogItem {
    workflow: Workflow;
    variants: WorkflowVariant[];
    label: string;
}

function item(workflow: Workflow, query: string,
    execution?: WorkflowVariant["execution"]): CatalogItem | null {
    const label = LABELS[workflow.id] ?? workflow.metadata.title;
    const workflowText = [label, workflow.metadata.title, workflow.metadata.description,
        workflow.metadata.category].filter(Boolean).join(" ").toLowerCase();
    if (workflow.launcher.kind !== "instructions") {
        return execution === "tabular" || query && !workflowText.includes(query)
            ? null : { workflow, variants: [], label };
    }
    let variants = workflow.launcher.variants.filter((variant) =>
        !execution || variant.execution === execution);
    if (query && !workflowText.includes(query)) variants = variants.filter(({ label, result }) =>
        [label, result].filter(Boolean).join(" ").toLowerCase().includes(query));
    return variants.length ? { workflow, variants, label } : null;
}

export function groupWorkflows(workflows: Workflow[], search = "",
    execution?: WorkflowVariant["execution"], contextLabel?: string) {
    const query = search.trim().toLowerCase();
    const items = [...new Map(workflows.map((workflow) => [workflow.id, workflow])).values()]
        .flatMap((workflow) => item(workflow, query, execution) ?? []);
    const context = contextLabel?.trim();
    const documentGroup = { label: context ? `With ${context}` : "Use documents",
        items: items.filter(({ workflow }) => !START_IDS.has(workflow.id)) };
    const startGroup = { label: "Start something",
        items: items.filter(({ workflow }) => START_IDS.has(workflow.id)) };
    return (context ? [documentGroup, startGroup] : [startGroup, documentGroup])
        .filter(({ items }) => items.length);
}
