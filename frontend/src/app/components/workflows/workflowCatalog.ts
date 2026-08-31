import type { Workflow, WorkflowAudience, WorkflowVariant } from "../shared/types";

export type AudienceFilter = WorkflowAudience | "all";
export const AUDIENCE_TABS: { id: AudienceFilter; label: string }[] = [
    { id: "general", label: "General" },
    { id: "solicitor", label: "Solicitor" },
    { id: "litigator", label: "Litigator" },
    { id: "all", label: "All" },
];
const CATEGORIES = [
    ["Drafting and document preparation", "Drafting", [["drafting", "Drafting"]]],
    ["Document review and comparison", "Review & compare", [["document-review", "Document review"], ["document-comparison", "Compare documents"]]],
    ["Research and verification", "Research & verify", [["legal-research", "Legal research"], ["quote-checking", "Check quotes"]]],
    ["Templates", "Templates", [["templates", "Templates"]]],
    ["Agreements", "Agreements", [["agreement-work", "Agreements"]]],
    ["Due diligence", "Due diligence", [["due-diligence", "Due diligence"]]],
    ["Transactions and closing", "Transactions & closing", [["transaction-management", "Transactions & closing"]]],
    ["Corporate records", "Corporate approvals", [["corporate-approvals", "Corporate approvals"]]],
    ["Written submissions", "Written submissions", [["submission-drafting", "Written submissions"]]],
    ["Evidence and discovery", "Evidence & discovery", [["evidence-review", "Evidence & discovery"]]],
    ["Court and hearing materials", "Court materials", [["court-records", "Court records"], ["authorities", "Authorities"]]],
] as const;
export const WORKFLOW_CATEGORIES = CATEGORIES.map(([value, label]) => [value, label] as const);

interface CatalogGroup {
    label: string;
    branch: boolean;
    items: Array<{ workflow: Workflow; variants: WorkflowVariant[]; label: string }>;
}

export function groupWorkflows(workflows: Workflow[], search = "",
    execution?: WorkflowVariant["execution"]) {
    const query = search.trim().toLowerCase();
    const unique = [...new Map(workflows.map((item) => [item.id, item])).values()];
    const byId = new Map(unique.filter(({ is_system }) => is_system)
        .map((item) => [item.id, item]));
    const matches = (workflow: Workflow, ...labels: Array<string | null>) => !query ||
        [...labels, workflow.metadata.title, workflow.metadata.description,
            workflow.metadata.category].filter(Boolean).join(" ").toLowerCase().includes(query);
    const terminals = (workflow: Workflow, label: string): CatalogGroup["items"] => {
        if (workflow.launcher.kind !== "instructions")
            return execution === "tabular" ? [] : [{ workflow, variants: [], label }];
        const variants = workflow.launcher.variants.filter((variant) =>
            !execution || variant.execution === execution);
        const choices = new Map<string, WorkflowVariant[]>();
        for (const variant of variants) choices.set(variant.label,
            [...(choices.get(variant.label) ?? []), variant]);
        return [...choices].map(([label, variants]) => ({ workflow, variants, label }));
    };
    const known = new Set<string>(CATEGORIES.flatMap(([, , items]) => items.map(([id]) => id)));
    const groups: CatalogGroup[] = CATEGORIES.flatMap(([, label, definitions]) => {
        const all = definitions.flatMap(([id, itemLabel]) => {
            const workflow = byId.get(id);
            return workflow ? terminals(workflow, itemLabel) : [];
        });
        const items = query && !label.toLowerCase().includes(query)
            ? all.filter(({ workflow, variants, label: itemLabel }) => matches(workflow,
                itemLabel, ...variants.flatMap(({ label: variantLabel, result }) =>
                    [variantLabel, result]))) : all;
        return items.length ? [{ label, branch: items.length > 1, items }] : [];
    });
    groups.push(...unique.filter(({ id, is_system }) => is_system && !known.has(id))
        .filter((workflow) => matches(workflow, workflow.metadata.title))
        .flatMap((workflow) => {
            const items = terminals(workflow, workflow.metadata.title);
            return items.length ? [{ label: workflow.metadata.title,
                branch: items.length > 1, items }] : [];
        }));
    const custom = unique.filter(({ is_system }) => !is_system)
        .filter((workflow) => matches(workflow, "My workflows"))
        .sort((a, b) => a.metadata.title.localeCompare(b.metadata.title))
        .flatMap((workflow) => terminals(workflow, workflow.metadata.title));
    if (custom.length) groups.push({ label: custom.length > 1
        ? "My workflows" : custom[0].label, branch: custom.length > 1, items: custom });
    return groups;
}
