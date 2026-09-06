import type { Workflow, WorkflowAudience, WorkflowVariant } from "@/app/lib/api/workflows";

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
    ["Corporate records", "Corporate records"],
    ["Written submissions", "Written submissions"],
    ["Evidence and discovery", "Evidence & discovery"],
    ["Court and hearing materials", "Court materials"],
] as const;

interface CatalogItem {
    workflow: Workflow;
    variants: WorkflowVariant[];
    label: string;
}

function item(workflow: Workflow, query: string,
    execution?: WorkflowVariant["execution"]): CatalogItem | null {
    const label = workflow.metadata.title;
    const workflowText = [label, workflow.metadata.description,
        workflow.metadata.category].filter(Boolean).join(" ").toLowerCase();
    if (workflow.launcher.kind !== "instructions" && !(execution === "assistant" && workflow.launcher.kind === "quote_check")) {
        return execution === "tabular" || query && !workflowText.includes(query)
            ? null : { workflow, variants: [], label };
    }
    if (!("variants" in workflow.launcher)) return null;
    let variants = workflow.launcher.variants.filter((variant) =>
        !execution || variant.execution === execution);
    if (query) {
        const matches = variants.filter(({ label, result, description }) =>
            [label, result, description].filter(Boolean).join(" ").toLowerCase().includes(query));
        variants = matches.length ? matches : workflowText.includes(query) ? variants : [];
    }
    return variants.length ? { workflow, variants, label } : null;
}

export function groupWorkflows(workflows: Workflow[], search = "",
    execution?: WorkflowVariant["execution"]) {
    const query = search.trim().toLowerCase();
    const items = [...new Map(workflows.map((workflow) => [workflow.id, workflow])).values()]
        .flatMap((workflow) => item(workflow, query, execution) ?? []);
    const labels = new Map<string, string>(WORKFLOW_CATEGORIES);
    const groups = new Map<string, CatalogItem[]>();
    for (const entry of items) {
        const category = entry.workflow.metadata.category?.trim() || "Other workflows";
        groups.set(category, [...(groups.get(category) ?? []), entry]);
    }
    return [
        ...WORKFLOW_CATEGORIES.flatMap(([category, label]) =>
            groups.has(category) ? [{ label, items: groups.get(category)! }] : []),
        ...[...groups].flatMap(([category, entries]) =>
            labels.has(category) ? [] : [{ label: category, items: entries }]),
    ];
}
