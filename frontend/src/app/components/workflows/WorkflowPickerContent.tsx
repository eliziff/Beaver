import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BookOpen, Building2, ChevronDown, Info, FileCheck2, FilePenLine, Files,
    FolderSearch, Handshake, ListChecks, MessageSquare, Scale, SearchCheck,
    Table2, Workflow as WorkflowIcon, type LucideIcon } from "lucide-react";
import { SearchBar } from "@/app/components/ui/search-bar";
import { Tabs } from "@/app/components/ui/tabs";
import { Modal } from "@/app/components/modals/Modal";
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
type WorkflowInfo = { workflow: Workflow; label: string; variants: WorkflowVariant[] };

export function WorkflowPickerContent({ workflows, onSelect, search,
    onSearchChange, audience, onAudienceChange, loading = false, execution,
    loadError = false, onRetryLoad, initialWorkflowId, contextLabel,
    disabledItem, workflowAction, audienceTabVariant = "segmented" }: Props) {
    const listRef = useRef<HTMLDivElement>(null);
    const groups = groupWorkflows(workflows, search, execution);
    const idPrefix = useId();
    const count = groups.reduce((total, { items }) => total + items.length, 0);
    const [expanded, setExpanded] = useState<string | null>(initialWorkflowId ?? null);
    const [info, setInfo] = useState<WorkflowInfo | null>(null);

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
            const description = result || workflow.metadata.description;
            return <div key={workflow.id}
                className={`flex min-w-0 items-center @max-[25rem]:flex-col @max-[25rem]:items-stretch @max-[25rem]:pb-2 ${APP_SURFACE_HOVER_CLASS}`}>
                    <div className="flex min-h-14 min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left">
                        <Icon className="mt-0.5 size-4 shrink-0 text-gray-500" aria-hidden="true" />
                        <WorkflowText label={label} description={description} />
                    </div>
                    <ActionCluster label={label} extra={action}>
                        <ActionButton Icon={Info} text="Info" ariaLabel={`Info about ${label}`}
                            onClick={() => setInfo({ workflow, label,
                                variants: directVariant ? [directVariant] : [] })} />
                        <ActionButton Icon={DestinationIcon}
                            text={directVariant ? destination : "Open"}
                            ariaLabel={`${launch}: ${label}`}
                            workflowId={workflow.id} variantId={directVariant?.id}
                            disabled={disabledItem?.(workflow, directVariant)}
                            onClick={() => directVariant
                                ? onSelect(workflow, directVariant) : onSelect(workflow)} />
                    </ActionCluster>
            </div>;
        }
        const open = expanded === workflow.id;
        const panelId = `${idPrefix}-workflow-${workflow.id}-options`;
        return <div key={workflow.id}>
            <div className={`flex min-w-0 items-start ${APP_SURFACE_HOVER_CLASS}`}>
                <button type="button" data-workflow-id={workflow.id}
                    aria-label={`Details for ${label}`}
                    aria-expanded={open} aria-controls={panelId}
                    onClick={() => toggle(workflow.id, panelId, !open)}
                    className="flex min-h-14 min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gray-900">
                    <Icon className="mt-0.5 size-4 shrink-0 text-gray-500" aria-hidden="true" />
                    <WorkflowText label={label} description={workflow.metadata.description}
                        destinations={open ? [] : workflowDestinations(workflow, variants)} />
                    <ChevronDown className={`mt-0.5 size-4 shrink-0 text-gray-400 ${open ? "rotate-180" : ""}`}
                        aria-hidden="true" />
                </button>
                {action && <ActionCluster label={label} extra={action} />}
            </div>
            {open && <div id={panelId} className="border-t border-gray-200 bg-gray-50">
                <VariantChoices workflow={workflow} variants={variants}
                    disabledItem={disabledItem} onSelect={onSelect}
                    onInfo={(label, variants) => setInfo({ workflow, label, variants })} />
            </div>}
        </div>;
    };

    return <><div className="@container flex min-h-0 flex-1 flex-col"><Tabs value={audience} onValueChange={(value) =>
        onAudienceChange(value as AudienceFilter)}
        options={AUDIENCE_TABS.map(({ id, label }) => ({ value: id, label }))}
        ariaLabel="Workflow audience" variant={audienceTabVariant}
        className={`min-w-0 flex-1 ${audienceTabVariant === "dock" ? "@max-[40rem]:flex-none" : ""}`}>
        <div className={`flex min-h-0 flex-1 flex-col pt-3 ${audienceTabVariant === "dock" ? "@max-[40rem]:flex-none" : ""}`}>
            <SearchBar value={search} onValueChange={onSearchChange}
                placeholder="Search workflows" aria-label="Search workflows" />
            {contextLabel && <p className="mt-2 truncate text-xs text-gray-500"
                title={contextLabel}>Using {contextLabel}</p>}
            <div ref={listRef} className={`mt-4 min-h-0 flex-1 overflow-y-auto pb-10 ${audienceTabVariant === "dock" ? "@max-[40rem]:overflow-visible" : ""}`}>
                <p role="status" className="sr-only">{loading
                    ? "Loading workflows" : `${count} workflow choices`}</p>
                {loading && !workflows.length ? <WorkflowSkeleton />
                    : loadError && !workflows.length ? <LoadError onRetry={onRetryLoad} />
                    : groups.length ? <div className="space-y-5">{groups.map((group) => {
                        const sectionId = `${idPrefix}-workflow-section-${slug(group.label)}`;
                        return <section key={group.label}
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
    </Tabs></div><WorkflowInfoModal key={info
        ? `${info.workflow.id}:${info.variants.map(({ id }) => id).join(":")}` : "closed"} info={info}
        onClose={() => setInfo(null)} onSelect={onSelect} disabledItem={disabledItem} /></>;
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

function ActionCluster({ label, children, extra }: {
    label: string; children?: ReactNode; extra?: ReactNode;
}) {
    return <div role="group" aria-label={`${label} actions`}
        className="flex shrink-0 items-center gap-1 pe-2 @max-[25rem]:self-end">
        {children}{extra}
    </div>;
}

function ActionButton({ Icon, text, ariaLabel, onClick, disabled,
    workflowId, variantId }: {
    Icon: LucideIcon; text: string; ariaLabel: string; onClick: () => void;
    disabled?: boolean; workflowId?: string; variantId?: string;
}) {
    return <button type="button" aria-label={ariaLabel} onClick={onClick} disabled={disabled}
        data-workflow-id={workflowId} data-workflow-variant-id={variantId}
        className={`${DESTINATION_BUTTON_CLASS} ${Icon === Info
            ? "text-gray-600 hover:bg-gray-200" : "bg-gray-900 text-white hover:bg-gray-800"}`}>
        <Icon className="size-3.5" aria-hidden="true" />
        <span>{text}</span>
    </button>;
}

function VariantChoices({ workflow, variants, disabledItem, onSelect, onInfo }: {
    workflow: Workflow; variants: WorkflowVariant[];
    disabledItem?: Props["disabledItem"]; onSelect: Props["onSelect"];
    onInfo: (label: string, variants: WorkflowVariant[]) => void;
}) {
    const choices = new Map<string, WorkflowVariant[]>();
    for (const variant of variants) choices.set(variant.label,
        [...(choices.get(variant.label) ?? []), variant]);
    return <div className="divide-y divide-gray-200">{[...choices].map(([label, launchers]) =>
        <div key={label} className="min-w-0 py-2.5 pe-3 ps-10">
            <div className="flex min-w-0 items-start gap-2 @max-[25rem]:flex-col">
                <div className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-800">{label}</span>
                <span className="mt-0.5 block text-xs leading-5 text-gray-600">
                    {[...new Set(launchers.map(({ result, description }) => result?.trim()
                        || description?.trim()).filter(Boolean))].join(" · ")}
                </span>
                </div>
                <ActionCluster label={label}>
                    <ActionButton Icon={Info} text="Info" ariaLabel={`Info about ${label}`}
                        onClick={() => onInfo(label, launchers)} />
                    {launchers.map((variant) => {
                    const [destination, DestinationIcon] = workflowDestination(workflow, variant);
                    const action = launchLabel(variant);
                    return <ActionButton key={variant.id} Icon={DestinationIcon}
                        text={destination} ariaLabel={`${action}: ${label}`}
                        variantId={variant.id} disabled={disabledItem?.(workflow, variant)}
                        onClick={() => onSelect(workflow, variant)} />;
                })}</ActionCluster>
            </div>
        </div>)}</div>;
}

function WorkflowInfoModal({ info, onClose, onSelect, disabledItem }: {
    info: WorkflowInfo | null; onClose: () => void;
    onSelect: Props["onSelect"]; disabledItem?: Props["disabledItem"];
}) {
    if (!info) return null;
    const workflow = info.workflow;
    const detailed = workflow.launcher.kind === "instructions"
        ? info.variants : [];
    const directDestination = workflow.launcher.kind === "instructions"
        ? null : workflowDestination(workflow);
    const DirectDestinationIcon = directDestination?.[1];
    const metadata = [
        ["Category", workflow.metadata.category],
        ["Jurisdiction", workflow.metadata.jurisdictions
            ?.filter((value) => value.toLocaleLowerCase() !== "general").join(", ")],
        ["Language", workflow.metadata.language.toLocaleLowerCase() === "english"
            ? null : workflow.metadata.language],
        ["Contributors", workflow.metadata.contributors.map(({ name }) => name).join(", ")],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]));
    return <Modal open onClose={onClose} size="xl" breadcrumbs={[info.label]}
        footerStatus={(detailed.length ? detailed : [undefined]).map((variant) => {
            const [destination, Icon] = workflowDestination(workflow, variant);
            return <ActionButton key={variant?.id ?? workflow.id} Icon={Icon}
                text={variant ? destination : "Open"}
                ariaLabel={`${variant ? launchLabel(variant) : "Open"}: ${info.label}`}
                disabled={disabledItem?.(workflow, variant)}
                onClick={() => {
                    onClose();
                    if (variant) onSelect(workflow, variant);
                    else onSelect(workflow);
                }} />;
        })}>
        <div className="min-h-full space-y-6 pb-6 text-sm leading-6 text-gray-700">
            {!detailed.length && workflow.metadata.description && <p className="max-w-2xl text-gray-600">
                {workflow.metadata.description}
            </p>}
            {directDestination && DirectDestinationIcon && <h2
                className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                <DirectDestinationIcon className="size-4" aria-hidden="true" />
                Opens in {directDestination[0]}
            </h2>}
            {detailed.map((variant) => {
                const [destination, DestinationIcon] = workflowDestination(workflow, variant);
                return <section key={variant.id} className="space-y-4" aria-label={destination}>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                    <DestinationIcon className="size-4" aria-hidden="true" />{destination}
                </h2>
                <p>{variant.description || workflow.metadata.description || variant.result}</p>
                {!!variant.columns_config?.length && <div>
                    <h3 className="text-xs font-semibold text-gray-500">Table fields</h3>
                    <div className="mt-2 divide-y divide-gray-200 rounded-lg border border-gray-200">
                        {[...variant.columns_config].sort((a, b) => a.index - b.index).map((column) =>
                            <div key={column.index} className="px-3 py-2.5">
                                <div className="flex flex-wrap items-baseline justify-between gap-2">
                                    <h4 className="font-medium text-gray-900">{column.name}</h4>
                                    {column.format && <span className="text-xs text-gray-500">
                                        {column.format.replaceAll("_", " ")}
                                    </span>}
                                </div>
                                {!!column.tags?.length && <p className="mt-1 text-xs text-gray-500">
                                    {column.tags.join(" · ")}
                                </p>}
                            </div>)}
                    </div>
                </div>}
            </section>;})}
            {!!metadata.length && <dl
                className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-gray-200 pt-4 text-xs">
                {metadata.map(([label, value]) => <div key={label} className="contents">
                    <dt className="font-medium text-gray-500">{label}</dt>
                    <dd className="min-w-0 text-gray-700">{value}</dd>
                </div>)}
            </dl>}
        </div>
    </Modal>;
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
const DESTINATION_BUTTON_CLASS = "inline-flex min-h-9 w-16 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:cursor-not-allowed disabled:opacity-45";
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
