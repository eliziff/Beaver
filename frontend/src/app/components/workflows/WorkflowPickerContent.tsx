import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BookOpen, Building2, ChevronDown, FileCheck2, FilePenLine, Files,
    FolderSearch, Handshake, ListChecks, MessageSquare, Scale, SearchCheck,
    Table2, Workflow as WorkflowIcon, type LucideIcon } from "lucide-react";
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
    loading?: boolean; loadError?: boolean; onRetryLoad?: () => void;
    execution?: WorkflowVariant["execution"]; initialWorkflowId?: string;
    contextLabel?: string;
    disabledItem?: (workflow: Workflow, variant?: WorkflowVariant) => boolean;
    workflowAction?: (workflow: Workflow) => ReactNode;
    audienceTabVariant?: "segmented" | "dock";
}

export function WorkflowPickerContent({ workflows, onSelect, search,
    onSearchChange, audience, onAudienceChange, loading = false, execution,
    loadError = false, onRetryLoad, initialWorkflowId, contextLabel,
    disabledItem, workflowAction, audienceTabVariant = "segmented" }: Props) {
    const listRef = useRef<HTMLDivElement>(null);
    const groups = groupWorkflows(workflows, search, execution);
    const idPrefix = useId();
    const count = groups.reduce((total, { items }) => total + items.length, 0);
    const [expanded, setExpanded] = useState<string | null>(initialWorkflowId ?? null);

    useEffect(() => setExpanded(initialWorkflowId ?? null), [initialWorkflowId]);
    const toggle = (id: string, panelId: string, open: boolean) => {
        setExpanded(open ? id : null);
        if (open) requestAnimationFrame(() =>
            document.getElementById(panelId)?.scrollIntoView?.({ block: "nearest" }));
    };
    useEffect(() => {
        if (loading || !initialWorkflowId) return;
        const frame = requestAnimationFrame(() => {
            const target = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(
                "[data-workflow-id]") ?? []).find(({ dataset }) =>
                    dataset.workflowId === initialWorkflowId);
            target?.scrollIntoView?.({ block: "nearest" });
            target?.focus();
        });
        return () => cancelAnimationFrame(frame);
    }, [initialWorkflowId, loading]);

    const row = ({ workflow, variants, label }: (typeof groups)[number]["items"][number]) => {
        const Icon = WORKFLOW_ICONS[workflow.id] ?? WorkflowIcon;
        const directVariant = workflow.launcher.kind === "instructions" && variants.length === 1
            ? variants[0] : undefined;
        const direct = workflow.launcher.kind !== "instructions" || Boolean(directVariant);
        const action = workflowAction?.(workflow);
        if (direct) {
            const [destination, DestinationIcon] = workflowDestination(workflow, directVariant);
            const result = directVariant?.result?.trim();
            const launch = directVariant ? launchLabel(directVariant) : "Open";
            const details = directVariant?.description?.trim();
            const open = expanded === workflow.id;
            const panelId = `${idPrefix}-workflow-${workflow.id}-details`;
            const destinationInLabel = label.toLowerCase().includes(destination.toLowerCase());
            const description = result || workflow.metadata.description;
            return <div key={workflow.id}>
                <div className={`flex min-w-0 items-start ${APP_SURFACE_HOVER_CLASS}`}>
                    <button type="button" data-workflow-id={workflow.id}
                        data-workflow-variant-id={!details ? directVariant?.id : undefined}
                        disabled={!details && disabledItem?.(workflow, directVariant)}
                        aria-label={details ? `Details for ${label}` : `${launch}: ${label}`}
                        aria-expanded={details ? open : undefined}
                        aria-controls={details ? panelId : undefined}
                        onClick={() => details ? toggle(workflow.id, panelId, !open)
                            : directVariant ? onSelect(workflow, directVariant) : onSelect(workflow)}
                        className="flex min-h-14 min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gray-900 disabled:cursor-not-allowed disabled:opacity-45">
                        <Icon className="mt-0.5 size-4 shrink-0 text-gray-500" aria-hidden="true" />
                        <WorkflowText label={label} description={description} />
                        {details ? <ChevronDown className={`mt-0.5 size-4 shrink-0 text-gray-400 ${
                            open ? "rotate-180" : ""}`} aria-hidden="true" /> : <span title={destination}
                            className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs font-medium text-gray-500">
                            <DestinationIcon className="size-3.5" aria-hidden="true" />
                            {!destinationInLabel && <span>{destination}</span>}
                        </span>}
                    </button>
                    {details && directVariant && <button type="button" data-workflow-variant-id={directVariant.id}
                        disabled={disabledItem?.(workflow, directVariant)}
                        aria-label={`${launch}: ${label}`} onClick={() => onSelect(workflow, directVariant)}
                        className={`m-2 ${DESTINATION_BUTTON_CLASS}`}>
                        <DestinationIcon className="size-3.5" aria-hidden="true" />{destination}
                    </button>}
                    {action}
                </div>
                {details && open && <div id={panelId}
                    className="border-t border-gray-200 bg-gray-50 px-3 py-2.5 ps-10 text-xs leading-5 text-gray-700">
                    <p className="text-xs leading-5 text-gray-700">{details}</p>
                </div>}
            </div>;
        }
        const open = expanded === workflow.id;
        const panelId = `${idPrefix}-workflow-${workflow.id}-options`;
        return <div key={workflow.id}>
            <div className={`flex min-w-0 items-start ${APP_SURFACE_HOVER_CLASS}`}>
                <button type="button" data-workflow-id={workflow.id}
                    aria-expanded={open} aria-controls={panelId}
                    onClick={() => toggle(workflow.id, panelId, !open)}
                    className="flex min-h-14 min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gray-900">
                    <Icon className="mt-0.5 size-4 shrink-0 text-gray-500" aria-hidden="true" />
                    <WorkflowText label={label} description={workflow.metadata.description}
                        destinations={open ? [] : workflowDestinations(workflow, variants)} />
                    <ChevronDown className={`mt-0.5 size-4 shrink-0 text-gray-400 ${
                        open ? "rotate-180" : ""}`} aria-hidden="true" />
                </button>
                {action}
            </div>
            {open && <div id={panelId} className="border-t border-gray-200 bg-gray-50">
                <VariantChoices workflow={workflow} variants={variants}
                    disabledItem={disabledItem} onSelect={onSelect} />
            </div>}
        </div>;
    };

    return <Tabs value={audience} onValueChange={(value) =>
        onAudienceChange(value as AudienceFilter)}
        options={AUDIENCE_TABS.map(({ id, label }) => ({ value: id, label }))}
        ariaLabel="Workflow audience" variant={audienceTabVariant}
        className={`min-w-0 flex-1 ${audienceTabVariant === "dock" ? "max-[40rem]:flex-none" : ""}`}>
        <div className={`flex min-h-0 flex-1 flex-col pt-3 ${audienceTabVariant === "dock" ? "max-[40rem]:flex-none" : ""}`}>
            <SearchBar value={search} onValueChange={onSearchChange}
                placeholder="Search workflows" aria-label="Search workflows" />
            {contextLabel && <p className="mt-2 truncate text-xs text-gray-500"
                title={contextLabel}>Using {contextLabel}</p>}
            <div ref={listRef} className={`mt-4 min-h-0 flex-1 overflow-y-auto pb-10 ${audienceTabVariant === "dock" ? "max-[40rem]:overflow-visible" : ""}`}>
                <p role="status" className="sr-only">{loading
                    ? "Loading workflows" : `${count} workflow choices`}</p>
                {loading && !workflows.length ? <WorkflowSkeleton />
                    : loadError && !workflows.length ? <LoadError onRetry={onRetryLoad} />
                    : groups.length ? <div className="space-y-5">{groups.map((group) => {
                        const sectionId = `${idPrefix}-workflow-section-${slug(group.label)}`;
                        return <section key={`${audience}:${search}:${group.label}`}
                            aria-labelledby={sectionId}>
                            <h2 id={sectionId} title={group.label}
                                className="mb-1 truncate px-1 text-xs font-semibold text-gray-500">
                                {group.label}
                            </h2>
                            <div className="divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-200 bg-white">
                                {group.items.map(row)}
                            </div>
                        </section>;
                    })}</div> : <p className="py-10 text-center text-sm text-gray-500">{search.trim()
                        ? "No workflows match your search." : "No workflows are available."}</p>}
            </div>
        </div>
    </Tabs>;
}

function WorkflowText({ label, description, destinations = [] }: {
    label: string; description?: string | null;
    destinations?: Array<{ label: string; Icon: LucideIcon }>;
}) {
    return <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-5 text-gray-900">{label}</span>
        {description && <span className="mt-0.5 block max-w-2xl text-xs leading-5 text-gray-600">
            {description}
        </span>}
        {!!destinations.length && <span
            className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium text-gray-500">
            {destinations.map(({ label: destination, Icon }) => <span key={destination}
                className="inline-flex items-center gap-1">
                <Icon className="size-3" aria-hidden="true" />{destination}
            </span>)}
        </span>}
    </span>;
}

function VariantChoices({ workflow, variants, disabledItem, onSelect }: {
    workflow: Workflow; variants: WorkflowVariant[];
    disabledItem?: Props["disabledItem"]; onSelect: Props["onSelect"];
}) {
    const choices = new Map<string, WorkflowVariant[]>();
    for (const variant of variants) choices.set(variant.label,
        [...(choices.get(variant.label) ?? []), variant]);
    return <div className="divide-y divide-gray-200">{[...choices].map(([label, launchers]) =>
        <div key={label} className="min-w-0 py-2.5 pe-3 ps-10">
            <div className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-800">{label}</span>
                <div className="mt-1 divide-y divide-gray-200/80">{launchers.map((variant) => {
                    const [destination, DestinationIcon] = workflowDestination(workflow, variant);
                    const action = launchLabel(variant);
                    return <div key={variant.id}
                        className="flex min-w-0 items-start gap-2 py-1.5 first:pt-0 last:pb-0">
                        <WorkflowDetails label={label} destination={launchers.length > 1
                            ? destination : undefined} result={variant.result}
                            description={variant.description} />
                        <button type="button" disabled={disabledItem?.(workflow, variant)}
                            data-workflow-variant-id={variant.id}
                            aria-label={`${action}: ${label}`} onClick={() => onSelect(workflow, variant)}
                            className={DESTINATION_BUTTON_CLASS}>
                            <DestinationIcon className="size-3.5" aria-hidden="true" />{destination}
                        </button>
                    </div>;
                })}</div>
            </div>
        </div>)}</div>;
}

function WorkflowDetails({ label, destination, result, description }: {
    label: string; destination?: string; result?: string | null; description?: string | null;
}) {
    const summary = result?.trim() || description?.trim();
    if (!summary) return <span className="min-w-0 flex-1" />;
    if (!description?.trim() || description.trim() === summary)
        return <span className="min-w-0 flex-1 text-xs leading-5 text-gray-600">{summary}</span>;
    return <details className="group min-w-0 flex-1 text-xs leading-5 text-gray-700">
        <summary aria-label={`Details for ${label}${destination ? ` (${destination})` : ""}`}
            className="flex cursor-pointer list-none items-start gap-1 rounded-sm text-gray-600 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
            <span className="min-w-0 flex-1">{summary}</span>
            <ChevronDown className="mt-1 size-3.5 shrink-0 text-gray-400 group-open:rotate-180"
                aria-hidden="true" />
        </summary>
        <p className="mt-1 max-w-2xl pe-4 text-gray-700">{description}</p>
    </details>;
}

function LoadError({ onRetry }: { onRetry?: () => void }) {
    return <div role="alert" className="py-10 text-center text-sm text-gray-600">
        <p>Workflows could not be loaded.</p>
        <button type="button" onClick={onRetry}
            className="mt-2 min-h-9 rounded-md border border-gray-300 bg-white px-3 font-medium text-gray-800 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
            Retry
        </button>
    </div>;
}

function workflowDestination(workflow: Workflow, variant?: WorkflowVariant): readonly [string, LucideIcon] {
    if (workflow.launcher.kind === "court_records") return ["Court Records", Files];
    if (workflow.launcher.kind === "authorities") return ["Authorities", Scale];
    return variant?.execution === "tabular"
        ? ["Tab", Table2] : ["Chat", MessageSquare];
}

function workflowDestinations(workflow: Workflow, variants: WorkflowVariant[]) {
    const destinations = new Map<string, { label: string; Icon: LucideIcon }>();
    for (const variant of variants) {
        const [label, Icon] = workflowDestination(workflow, variant);
        destinations.set(label, { label, Icon });
    }
    return [...destinations.values()];
}

const launchLabel = (variant: WorkflowVariant) => variant.execution === "tabular"
    ? "Start Tabular Review" : "Open chat";
const DESTINATION_BUTTON_CLASS = "inline-flex min-h-9 w-16 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-gray-600 hover:bg-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:cursor-not-allowed disabled:opacity-45";
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
const WorkflowSkeleton = () => <div aria-hidden="true" className="space-y-2">
    {[1, 2, 3, 4, 5].map((item) =>
        <div key={item} className="h-14 rounded-lg bg-gray-100 motion-safe:animate-pulse" />)}
</div>;

const WORKFLOW_ICONS: Record<string, LucideIcon> = {
    drafting: FilePenLine,
    "document-review": FileCheck2, "legal-research": SearchCheck,
    "quote-checking": BookOpen, "agreement-work": Handshake,
    "due-diligence": FolderSearch, "transaction-management": ListChecks,
    "corporate-approvals": Building2, "submission-drafting": FilePenLine,
    "evidence-review": Files, "court-records": Scale, authorities: BookOpen,
};
