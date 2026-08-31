import { useEffect, useRef, useState, type ReactNode } from "react";
import { Building2, ChevronDown, FileCheck2, FilePenLine, Files, FolderSearch,
    Handshake, Info, LayoutTemplate, ListChecks, MessageSquare, Play, Scale,
    SearchCheck, Table2, Workflow as WorkflowIcon, type LucideIcon } from "lucide-react";
import { SearchBar } from "@/app/components/ui/search-bar";
import { Tabs } from "@/app/components/ui/tabs";
import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
import type { Workflow, WorkflowVariant } from "../shared/types";
import { AUDIENCE_TABS, groupWorkflows, type AudienceFilter } from "./workflowCatalog";

interface Props {
    workflows: Workflow[]; search: string; audience: AudienceFilter;
    onSelect: (workflow: Workflow, variant?: WorkflowVariant) => void;
    onSearchChange: (value: string) => void;
    onAudienceChange: (audience: AudienceFilter) => void;
    loading?: boolean; execution?: WorkflowVariant["execution"]; initialWorkflowId?: string;
    disabledItem?: (workflow: Workflow, variant?: WorkflowVariant) => boolean;
    workflowAction?: (workflow: Workflow) => ReactNode;
}

export function WorkflowPickerContent({ workflows, onSelect, search,
    onSearchChange, audience, onAudienceChange, loading = false, execution,
    initialWorkflowId, disabledItem, workflowAction }: Props) {
    const listRef = useRef<HTMLDivElement>(null);
    const query = search.trim();
    const groups = groupWorkflows(workflows, query, execution);
    const count = groups.reduce((total, { items }) => total + items.length, 0);
    const [details, setDetails] = useState<string | null>(null);
    useEffect(() => {
        if (loading || !initialWorkflowId) return;
        const frame = requestAnimationFrame(() => {
            const target = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(
                "[data-workflow-id]") ?? []).find(({ dataset }) =>
                    dataset.workflowId === initialWorkflowId);
            target?.scrollIntoView({ block: "nearest" });
            target?.focus();
        });
        return () => cancelAnimationFrame(frame);
    }, [initialWorkflowId, loading]);

    const row = ({ workflow, variants, label }: (typeof groups)[number]["items"][number]) => {
        const launchers = variants.length ? variants : [undefined];
        const key = `${workflow.id}:${launchers.map((variant) =>
            variant?.id ?? workflow.launcher.kind).join(":")}`;
        const description = workflow.metadata.description?.trim();
        const jurisdictions = (workflow.metadata.jurisdictions ?? []).filter(
            (item) => item.toLowerCase() !== "general");
        const language = workflow.metadata.language?.toLowerCase() !== "english"
            ? workflow.metadata.language : null;
        const hasDetails = Boolean(description || jurisdictions.length || language);
        const launch = (variant?: WorkflowVariant, compact = false) => {
            const [destination, DestinationIcon] = workflowDestination(workflow, variant);
            return <button key={variant?.id ?? workflow.launcher.kind} type="button"
                disabled={disabledItem?.(workflow, variant)} data-workflow-id={workflow.id}
                data-workflow-variant-id={variant?.id}
                aria-label={`Start ${label} in ${destination}`}
                onClick={() => onSelect(workflow, variant)}
                className={compact
                    ? "flex min-h-8 shrink-0 items-center gap-1 rounded-md border border-gray-200 bg-white px-2 text-xs font-normal text-gray-600 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:cursor-not-allowed disabled:opacity-45"
                    : `flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:cursor-not-allowed disabled:opacity-45 ${APP_SURFACE_HOVER_CLASS}`}>
                {compact ? <><DestinationIcon className="size-3.5" aria-hidden="true" />
                    {destination}</> : <>
                    <Play className="size-3.5 shrink-0 text-gray-500" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <span className="flex shrink-0 items-center gap-1 text-xs font-normal text-gray-500">
                        <DestinationIcon className="size-3.5" aria-hidden="true" />
                        {destination}
                    </span>
                </>}
            </button>;
        };
        return <div key={key} className="min-w-0 border-b border-gray-100 last:border-b-0">
            <div className="flex min-w-0 items-center gap-1">
                {launchers.length === 1 ? launch(launchers[0])
                    : <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sm font-medium text-gray-800">
                        <Play className="size-3.5 shrink-0 text-gray-500" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        {launchers.map((variant) => launch(variant, true))}
                    </div>}
                {hasDetails && <button type="button" aria-label={`Details for ${label}`}
                    aria-expanded={details === key} aria-controls={`${key}-details`}
                    onClick={() => setDetails((current) => current === key ? null : key)}
                    className="grid size-9 shrink-0 place-items-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
                    <Info className="size-4" aria-hidden="true" />
                </button>}
                {workflowAction?.(workflow)}
            </div>
            {hasDetails && details === key && <div id={`${key}-details`}
                className="space-y-0.5 pb-2 ps-8 pe-2 text-xs leading-5 text-gray-600">
                {description && <p>{description}</p>}
                {!!jurisdictions.length && <p>Jurisdictions: {jurisdictions.join(", ")}</p>}
                {language && <p>Language: {language}</p>}
            </div>}
        </div>;
    };
    return <Tabs value={audience} onValueChange={(value) =>
        onAudienceChange(value as AudienceFilter)}
        options={AUDIENCE_TABS.map(({ id, label }) => ({ value: id, label }))}
        ariaLabel="Workflow audience" variant="segmented" className="min-w-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col pt-3">
            <SearchBar value={search} onValueChange={onSearchChange}
                placeholder="Search workflows" aria-label="Search workflows" />
            <div ref={listRef} className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto">
                <p role="status" className="sr-only">{loading
                    ? "Loading workflows" : `${count} workflow choices`}</p>
                {loading ? <WorkflowSkeleton /> : groups.length ? groups.map((group) =>
                    group.branch ? <WorkflowBranch key={`${audience}:${query}:${group.label}`}
                        label={group.label} initiallyOpen={Boolean(query) || group.items.some(
                            ({ workflow }) => workflow.id === initialWorkflowId)}>
                        <div className="ms-3 border-s-2 border-gray-200 py-1 ps-2">
                            {group.items.map(row)}
                        </div>
                    </WorkflowBranch> : <div key={group.label}
                        data-workflow-category={group.label}>{row(group.items[0])}</div>,
                ) : <p className="py-10 text-center text-sm text-gray-500">{query
                    ? "No workflows match your search." : "No workflows are available."}</p>}
            </div>
        </div>
    </Tabs>;
}

function workflowDestination(workflow: Workflow, variant?: WorkflowVariant): readonly [string, LucideIcon] {
    if (workflow.launcher.kind === "court_records") return ["Court Records", Files];
    if (workflow.launcher.kind === "authorities") return ["Authorities", Scale];
    return variant?.execution === "tabular"
        ? ["Table", Table2] : ["Chat", MessageSquare];
}

const WorkflowSkeleton = () => <div aria-hidden="true" className="space-y-1">
    {[1, 2, 3, 4, 5].map((item) =>
        <div key={item} className="h-10 animate-pulse rounded-md bg-gray-100" />)}
</div>;

function WorkflowBranch({ label, initiallyOpen, children }: {
    label: string; initiallyOpen: boolean; children: ReactNode;
}) {
    const [open, setOpen] = useState(initiallyOpen);
    const Icon = CATEGORY_ICONS[label] ?? WorkflowIcon;
    return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group"
        data-workflow-category={label}>
        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-900 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
            <Icon aria-hidden="true" className="size-4 shrink-0 text-gray-500" />
            <span className="min-w-0 flex-1">{label}</span>
            <ChevronDown aria-hidden="true"
                className="h-4 w-4 shrink-0 text-gray-400 group-open:rotate-180" />
        </summary>
        {children}
    </details>;
}

const CATEGORY_ICONS: Record<string, LucideIcon> = {
    "Drafting": FilePenLine, "Review & compare": FileCheck2,
    "Research & verify": SearchCheck, "Templates": LayoutTemplate,
    "Agreements": Handshake, "Due diligence": ListChecks,
    "Transactions & closing": ListChecks, "Corporate approvals": Building2,
    "Written submissions": FilePenLine, "Evidence & discovery": FolderSearch,
    "Court materials": Scale,
};
