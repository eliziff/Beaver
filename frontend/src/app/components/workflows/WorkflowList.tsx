"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    Plus,
} from "lucide-react";
import {
    listWorkflows,
    deleteWorkflow,
    listHiddenWorkflows,
    hideWorkflow,
    unhideWorkflow,
} from "@/app/lib/beaverApi";
import type { Workflow } from "../shared/types";
import { UseWorkflowModal } from "./UseWorkflowModal";
import { NewWorkflowModal } from "./NewWorkflowModal";
import { TableToolbar } from "../shared/TableToolbar";
import { RowActions } from "../shared/RowActions";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { PillButton } from "@/app/components/ui/pill-button";
import { NativeActionSelect } from "@/app/components/ui/native-action-select";
import {
    WorkflowSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { workflowDetailPath } from "./workflowRoutes";
import { isAnonymousMode } from "@/app/lib/authMode";
import {
    SkeletonDot,
    SkeletonLine,
    TableBody,
    TableCell,
    TableEmptyState,
    TableHeaderCell,
    TableHeaderRow,
    TableFilters,
    type TableFilterOption,
    TablePrimaryCell,
    TableRow,
    TableScrollArea,
    TableSelectionPlaceholder,
    TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS,
    type TableSortDirection,
    TableStickyCell,
} from "../shared/TablePrimitive";
import { CheckboxControl } from "@/app/components/ui/checkbox";
type WorkflowSourceFilter = "system" | "user" | "shared";
type WorkflowListTab = "all" | "assistant" | "tabular" | "system";
type WorkflowSortKey = "name" | "type";
const WORKFLOW_TABS: { id: WorkflowListTab; label: string }[] = [
    { id: "all", label: "All" },
    { id: "assistant", label: "Assistant" },
    { id: "tabular", label: "Tabular" },
    { id: "system", label: "System" },
];
const SORT_OPTIONS: TableFilterOption<TableSortDirection>[] = [
    { value: "asc", label: "Ascending" },
    { value: "desc", label: "Descending" },
];
const WORKFLOW_COLUMN = {
    type: "hidden w-24 sm:flex",
    practice: "hidden w-32 lg:flex",
    jurisdiction: "hidden w-32 xl:flex",
    language: "hidden w-24 2xl:flex",
    source: "hidden w-28 lg:flex",
    actions: "w-8",
} as const;
export function WorkflowList() {
    const router = useRouter();
    const [workflows, setWorkflows] = useState<Workflow[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<Workflow | null>(null);
    const [newModalOpen, setNewModalOpen] = useState(false);
    const [editingWorkflow, setEditingWorkflow] = useState<Workflow | null>(
        null,
    );
    const [hiddenSystemIds, setHiddenSystemIds] = useState<string[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [activeTab, setActiveTab] = useState<WorkflowListTab>("all");
    const [practiceFilter, setPracticeFilter] = useState<string | null>(null);
    const [jurisdictionFilter, setJurisdictionFilter] = useState<string | null>(
        null,
    );
    const [languageFilter, setLanguageFilter] = useState<string | null>(null);
    const [sourceFilter, setSourceFilter] =
        useState<WorkflowSourceFilter | null>(null);
    const [sort, setSort] = useState<{
        key: WorkflowSortKey;
        direction: TableSortDirection;
    } | null>(null);
    const [search, setSearch] = useState("");
    useEffect(() => {
        Promise.all([
            listWorkflows("assistant"),
            listWorkflows("tabular"),
            listHiddenWorkflows(),
        ])
            .then(([assistant, tabular, hidden]) => {
                setWorkflows([...assistant, ...tabular]);
                setHiddenSystemIds(hidden);
            })
            .catch(() => {
                setWorkflows([]);
            })
            .finally(() => setLoading(false));
    }, []);
    const systemWorkflows = workflows.filter((wf) => wf.is_system);
    const userWorkflows = workflows.filter(
        (wf) => !wf.is_system && wf.is_owner !== false,
    );
    const sharedWorkflows = workflows.filter(
        (wf) => !wf.is_system && wf.is_owner === false,
    );
    const hiddenSystem = systemWorkflows.filter((wf) =>
        hiddenSystemIds.includes(wf.id),
    );
    const visibleSystem = systemWorkflows.filter(
        (wf) => !hiddenSystemIds.includes(wf.id),
    );
    const systemRows = [...visibleSystem, ...hiddenSystem];
    const activeRows = [...userWorkflows, ...sharedWorkflows, ...visibleSystem];
    const allRows = [...userWorkflows, ...sharedWorkflows, ...systemRows];
    const tabRows =
        activeTab === "all"
            ? activeRows
            : activeTab === "system"
              ? systemRows
              : activeRows.filter((workflow) => workflow.metadata.type === activeTab);
    const sourceRows =
        sourceFilter === null
            ? tabRows
            : tabRows.filter(
                  (workflow) => getWorkflowSource(workflow) === sourceFilter,
              );
    const practices = Array.from(
        new Set(
            sourceRows.map((wf) => wf.metadata.practice).filter((p): p is string => !!p),
        ),
    ).sort();
    const jurisdictions = Array.from(
        new Set(
            allRows
                .flatMap((wf) => wf.metadata.jurisdictions ?? [])
                .filter((jurisdiction): jurisdiction is string => !!jurisdiction),
        ),
    ).sort();
    const languages = Array.from(
        new Set(
            allRows
                .map((wf) => wf.metadata.language)
                .filter((language): language is string => !!language),
        ),
    ).sort();
    const q = search.toLowerCase();
    const filtered = sourceRows
        .filter((wf) => !practiceFilter || wf.metadata.practice === practiceFilter)
        .filter(
            (wf) =>
                !jurisdictionFilter ||
                wf.metadata.jurisdictions?.includes(jurisdictionFilter),
        )
        .filter((wf) => !languageFilter || wf.metadata.language === languageFilter)
        .filter((wf) => !q || wf.metadata.title.toLowerCase().includes(q))
        .sort((a, b) => compareWorkflows(a, b, sort));
    const allSelected =
        filtered.length > 0 &&
        filtered.every((wf) => selectedIds.includes(wf.id));
    const someSelected =
        !allSelected && filtered.some((wf) => selectedIds.includes(wf.id));
    function toggleAll() {
        if (allSelected) setSelectedIds([]);
        else setSelectedIds(filtered.map((wf) => wf.id));
    }
    function toggleOne(id: string) {
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    }
    function clearSelection() {
        setSelectedIds([]);
    }
    function handleTabChange(tab: WorkflowListTab) {
        setActiveTab(tab);
        clearSelection();
    }
    function handlePracticeFilterChange(value: string | null) {
        setPracticeFilter(value);
        clearSelection();
    }
    function handleJurisdictionFilterChange(value: string | null) {
        setJurisdictionFilter(value);
        clearSelection();
    }
    function handleLanguageFilterChange(value: string | null) {
        setLanguageFilter(value);
        clearSelection();
    }
    function handleSourceFilterChange(value: WorkflowSourceFilter | null) {
        setSourceFilter(value);
        clearSelection();
    }
    function handleSortChange(
        key: WorkflowSortKey,
        direction: TableSortDirection | null,
    ) {
        setSort(direction ? { key, direction } : null);
        clearSelection();
    }
    async function handleHideWorkflow(id: string) {
        setHiddenSystemIds((prev) => [...prev, id]);
        await hideWorkflow(id).catch(() => {
            setHiddenSystemIds((prev) => prev.filter((x) => x !== id));
        });
    }
    async function handleUnhideWorkflow(id: string) {
        setHiddenSystemIds((prev) => prev.filter((x) => x !== id));
        await unhideWorkflow(id).catch(() => {
            setHiddenSystemIds((prev) => [...prev, id]);
        });
    }
    async function handleBulkRemove() {
        const ids = [...selectedIds];
        setSelectedIds([]);
        const systemIds = ids.filter(
            (id) => workflows.find((workflow) => workflow.id === id)?.is_system,
        );
        const customIds = ids.filter((id) => !systemIds.includes(id));
        if (systemIds.length > 0) {
            setHiddenSystemIds((prev) => [
                ...prev,
                ...systemIds.filter((id) => !prev.includes(id)),
            ]);
            await Promise.all(
                systemIds.map((id) => hideWorkflow(id).catch(() => {})),
            );
        }
        if (customIds.length > 0) {
            await Promise.all(
                customIds.map((id) => deleteWorkflow(id).catch(() => {})),
            );
            setWorkflows((prev) =>
                prev.filter((w) => !customIds.includes(w.id)),
            );
        }
    }
    async function handleBulkUnhide() {
        const ids = [...selectedIds];
        setSelectedIds([]);
        setHiddenSystemIds((prev) => prev.filter((id) => !ids.includes(id)));
        await Promise.all(ids.map((id) => unhideWorkflow(id).catch(() => {})));
    }
    const nameSortDirection =
        sort?.key === "name" ? sort.direction : null;
    const typeSortDirection =
        sort?.key === "type" ? sort.direction : null;
    const nameFilterButton = (
        <TableFilters
            label="Sort by name"
            value={nameSortDirection}
            allLabel="Default Order"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("name", direction)}
        />
    );
    const typeFilterButton = (
        <TableFilters
            label="Sort by type"
            value={typeSortDirection}
            allLabel="Default Order"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("type", direction)}
        />
    );
    const practiceFilterButton = (
        <TableFilters
            label="Filter by practice"
            searchable
            value={practiceFilter}
            allLabel="All Practices"
            options={practices.map((practice) => ({
                value: practice,
                label: practice,
            }))}
            onChange={handlePracticeFilterChange}
        />
    );
    const jurisdictionFilterButton = (
        <TableFilters
            label="Filter by jurisdiction"
            searchable
            value={jurisdictionFilter}
            allLabel="All Jurisdictions"
            options={jurisdictions.map((jurisdiction) => ({
                value: jurisdiction,
                label: jurisdiction,
            }))}
            onChange={handleJurisdictionFilterChange}
        />
    );
    const languageFilterButton = (
        <TableFilters
            label="Filter by language"
            searchable
            value={languageFilter}
            allLabel="All Languages"
            options={languages.map((language) => ({
                value: language,
                label: language,
            }))}
            onChange={handleLanguageFilterChange}
        />
    );
    const sourceOptions: TableFilterOption<WorkflowSourceFilter>[] =
        isAnonymousMode
            ? [{ value: "system", label: "System" }]
            : [
                  { value: "system", label: "System" },
                  { value: "user", label: "User" },
                  { value: "shared", label: "Shared with me" },
              ];
    const sourceFilterButton = (
        <TableFilters
            label="Filter by source"
            value={sourceFilter}
            allLabel="All Sources"
            options={sourceOptions}
            onChange={handleSourceFilterChange}
        />
    );
    const selectedHiddenSystemIds = selectedIds.filter((id) =>
        hiddenSystemIds.includes(id),
    );
    const selectedSystemIds = selectedIds.filter(
        (id) => workflows.find((workflow) => workflow.id === id)?.is_system,
    );
    const selectedOnlySystem =
        selectedIds.length > 0 && selectedIds.length === selectedSystemIds.length;
    const selectedOnlyHiddenSystem =
        selectedIds.length > 0 &&
        selectedIds.length === selectedHiddenSystemIds.length;
    const toolbarActions = !isAnonymousMode ? (
        <span className="inline-flex h-8 w-28">
            {selectedIds.length > 0 && (
                <NativeActionSelect
                    label="Actions"
                    items={[
                        selectedOnlyHiddenSystem
                            ? {
                                  label: "Activate",
                                  onSelect: handleBulkUnhide,
                              }
                            : {
                                  label: selectedOnlySystem
                                      ? "Deactivate"
                                      : "Delete",
                                  onSelect: handleBulkRemove,
                              },
                    ]}
                    className="w-full"
                    triggerClassName="h-8 w-full items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-800 hover:bg-gray-100"
                >
                    Actions
                    <span aria-hidden="true">&#9662;</span>
                </NativeActionSelect>
            )}
        </span>
    ) : undefined;
    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            {/* Page header */}
            <PageHeader
                shrink
                loading={loading}
                actions={[
                    {
                        type: "search",
                        value: search,
                        onChange: setSearch,
                        placeholder: "Search workflows…",
                    },
                    isAnonymousMode
                        ? null
                        : {
                              type: "new",
                              onClick: () => setNewModalOpen(true),
                              title: "New workflow",
                          },
                ]}
            >
                <h1 className="text-2xl font-medium font-serif text-gray-900">
                    Workflows
                </h1>
            </PageHeader>
            <TableToolbar
                items={WORKFLOW_TABS}
                active={activeTab}
                onChange={handleTabChange}
                actions={toolbarActions}
            />
            {/* Table */}
            <TableScrollArea
                header={
                    <TableHeaderRow>
                        <TableStickyCell
                            header
                            widthClassName={TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}
                        >
                            {!isAnonymousMode &&
                                (loading ? (
                                    <TableSelectionPlaceholder />
                                ) : (
                                    <CheckboxControl
                                        checked={allSelected}
                                        ref={(el) => {
                                            if (el)
                                                el.indeterminate = someSelected;
                                        }}
                                        onChange={toggleAll}
                                        className="-ml-2 mr-1"
                                    />
                                ))}
                            <span className="mr-1">Name</span>
                            {nameFilterButton}
                        </TableStickyCell>
                        <TableHeaderCell
                            className={`ml-auto ${WORKFLOW_COLUMN.type}`}
                        >
                            <div className="flex items-center gap-1">
                                <span>Type</span>
                                {typeFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className={WORKFLOW_COLUMN.practice}>
                            <div className="flex items-center gap-1">
                                <span>Practice</span>
                                {practiceFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell
                            className={WORKFLOW_COLUMN.jurisdiction}
                        >
                            <div className="flex items-center gap-1">
                                <span>Jurisdiction</span>
                                {jurisdictionFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className={WORKFLOW_COLUMN.language}>
                            <div className="flex items-center gap-1">
                                <span>Language</span>
                                {languageFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className={WORKFLOW_COLUMN.source}>
                            <div className="flex items-center gap-1">
                                <span>Source</span>
                                {sourceFilterButton}
                            </div>
                        </TableHeaderCell>
                        {!isAnonymousMode && (
                            <TableHeaderCell
                                className={WORKFLOW_COLUMN.actions}
                            />
                        )}
                    </TableHeaderRow>
                }
            >
                    {loading ? (
                        <TableBody>
                            {[1, 2, 3].map((i) => (
                                <TableRow
                                    key={i}
                                    interactive={false}
                                >
                                    <TableStickyCell
                                        hover={false}
                                        widthClassName={TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}
                                    >
                                        <div className="flex items-center">
                                            {!isAnonymousMode && (
                                                <TableSelectionPlaceholder />
                                            )}
                                            <SkeletonLine className="h-3.5 w-48" />
                                        </div>
                                    </TableStickyCell>
                                    <TableCell
                                        className={`ml-auto ${WORKFLOW_COLUMN.type}`}
                                    >
                                        <SkeletonLine className="w-16" />
                                    </TableCell>
                                    <TableCell className={WORKFLOW_COLUMN.practice}>
                                        <div className="flex items-center gap-1.5">
                                            <SkeletonDot className="rounded-full" />
                                            <SkeletonLine className="w-24" />
                                        </div>
                                    </TableCell>
                                    <TableCell
                                        className={WORKFLOW_COLUMN.jurisdiction}
                                    >
                                        <SkeletonLine className="w-24" />
                                    </TableCell>
                                    <TableCell className={WORKFLOW_COLUMN.language}>
                                        <SkeletonLine className="w-16" />
                                    </TableCell>
                                    <TableCell className={WORKFLOW_COLUMN.source}>
                                        <SkeletonLine className="w-14" />
                                    </TableCell>
                                    {!isAnonymousMode && (
                                        <TableCell
                                            className={WORKFLOW_COLUMN.actions}
                                        />
                                    )}
                                </TableRow>
                            ))}
                        </TableBody>
                    ) : filtered.length === 0 ? (
                        <TableEmptyState>
                            {sourceFilter === "user" ? (
                                <>
                                    <WorkflowSkeuoIcon className="mb-4 h-8 w-8" />
                                    <p className="text-2xl font-medium font-serif text-gray-900">
                                        User Workflows
                                    </p>
                                    <p className="mt-1 text-xs text-gray-400 text-left">
                                        Build reusable prompts and tabular
                                        review templates tailored to your
                                        practice.
                                    </p>
                                    <PillButton
                                        tone="black"
                                        size="sm"
                                        onClick={() => setNewModalOpen(true)}
                                        className="mt-4 px-3"
                                    >
                                        <Plus className="h-3.5 w-3.5" />
                                        Create
                                    </PillButton>
                                </>
                            ) : sourceFilter === "shared" ? (
                                <>
                                    <WorkflowSkeuoIcon className="mb-4 h-8 w-8" />
                                    <p className="text-2xl font-medium font-serif text-gray-900">
                                        Shared Workflows
                                    </p>
                                    <p className="mt-1 text-xs text-gray-400 text-left">
                                        Workflows shared with you by other users
                                        will appear here.
                                    </p>
                                </>
                            ) : (
                                <>
                                    <WorkflowSkeuoIcon className="mb-4 h-8 w-8" />
                                    <p className="text-2xl font-medium font-serif text-gray-900">
                                        Workflows
                                    </p>
                                    <p className="mt-1 text-xs text-gray-400 text-left">
                                        Automate document analysis with reusable
                                        prompts and tabular review templates.
                                    </p>
                                </>
                            )}
                        </TableEmptyState>
                    ) : (
                        <TableBody>
                            {filtered.map((wf) => {
                            const isHiddenSystem = hiddenSystemIds.includes(wf.id);
                            return (
                            <TableRow
                                key={wf.id}
                                selected={selectedIds.includes(wf.id)}
                                className={isHiddenSystem ? "opacity-45" : undefined}
                                onClick={() => setSelected(wf)}
                            >
                                {isAnonymousMode ? (
                                    <TableStickyCell
                                        widthClassName={TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}
                                    >
                                        <span className="min-w-0 flex-1 truncate text-sm text-gray-900">
                                            {wf.metadata.title}
                                        </span>
                                    </TableStickyCell>
                                ) : (
                                    <TablePrimaryCell
                                        selected={selectedIds.includes(wf.id)}
                                        widthClassName={TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}
                                        onSelectionChange={() => toggleOne(wf.id)}
                                        label={wf.metadata.title}
                                    />
                                )}
                                <TableCell
                                    className={`ml-auto ${WORKFLOW_COLUMN.type}`}
                                >
                                    <span className="text-xs font-medium text-gray-700">
                                        {wf.metadata.type === "tabular"
                                            ? "Tabular"
                                            : "Assistant"}
                                    </span>
                                </TableCell>
                                <TableCell className={WORKFLOW_COLUMN.practice}>
                                    {wf.metadata.practice ? (
                                        <span className="text-xs font-medium text-gray-600">
                                            {wf.metadata.practice}
                                        </span>
                                    ) : (
                                        <span className="text-xs text-gray-300">
                                            —
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell
                                    className={WORKFLOW_COLUMN.jurisdiction}
                                >
                                    {wf.metadata.jurisdictions &&
                                    wf.metadata.jurisdictions.length > 0 ? (
                                        <span className="truncate max-w-full text-xs font-medium text-gray-600">
                                            {wf.metadata.jurisdictions.join(", ")}
                                        </span>
                                    ) : (
                                        <span className="text-xs text-gray-300">
                                            —
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell className={WORKFLOW_COLUMN.language}>
                                    {wf.metadata.language ? (
                                        <span className="text-xs font-medium text-gray-600">
                                            {wf.metadata.language}
                                        </span>
                                    ) : (
                                        <span className="text-xs text-gray-300">
                                            —
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell className={WORKFLOW_COLUMN.source}>
                                    {wf.is_system ? (
                                        <span className="text-xs font-medium text-gray-600">
                                            System
                                        </span>
                                    ) : wf.is_owner !== false ? (
                                        <span className="text-xs font-medium text-gray-600">
                                            User
                                        </span>
                                    ) : (
                                        <span className="block max-w-full truncate text-xs font-medium text-gray-600">
                                            {getSharedByLabel(wf)}
                                        </span>
                                    )}
                                </TableCell>
                                {!isAnonymousMode && (
                                    <div
                                        className={`${WORKFLOW_COLUMN.actions} shrink-0 justify-end`}
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {wf.is_system ? (
                                            isHiddenSystem ? (
                                                <RowActions
                                                    onUnhide={() =>
                                                        handleUnhideWorkflow(
                                                            wf.id,
                                                        )
                                                    }
                                                />
                                            ) : (
                                                <RowActions
                                                    onHide={() =>
                                                        handleHideWorkflow(
                                                            wf.id,
                                                        )
                                                    }
                                                />
                                            )
                                        ) : wf.is_owner === false ? null : (
                                            <RowActions
                                                onEditDetails={() =>
                                                    setEditingWorkflow(wf)
                                                }
                                                onDelete={async () => {
                                                    await deleteWorkflow(wf.id);
                                                    setWorkflows((prev) =>
                                                        prev.filter(
                                                            (w) =>
                                                                w.id !== wf.id,
                                                        ),
                                                    );
                                                }}
                                            />
                                        )}
                                    </div>
                                )}
                            </TableRow>
                            );
                        })}
                        </TableBody>
                    )}
            </TableScrollArea>
            <UseWorkflowModal
                workflows={allRows}
                workflow={selected}
                onClose={() => setSelected(null)}
            />
            <NewWorkflowModal
                open={newModalOpen}
                onClose={() => setNewModalOpen(false)}
                onCreated={(wf) => {
                    setWorkflows((prev) => [wf, ...prev]);
                    setNewModalOpen(false);
                    router.push(workflowDetailPath(wf));
                }}
            />
            <NewWorkflowModal
                open={!!editingWorkflow}
                onClose={() => setEditingWorkflow(null)}
                onCreated={() => undefined}
                editWorkflow={editingWorkflow ?? undefined}
                onUpdated={(updated) => {
                    setWorkflows((prev) =>
                        prev.map((workflow) =>
                            workflow.id === updated.id
                                ? { ...workflow, ...updated }
                                : workflow,
                        ),
                    );
                    setEditingWorkflow(null);
                }}
            />
        </div>
    );
}
function getSharedByLabel(workflow: Workflow) {
    return workflow.shared_by_name?.trim() || "Shared";
}
function getWorkflowSource(workflow: Workflow): WorkflowSourceFilter {
    if (workflow.is_system) return "system";
    return workflow.is_owner === false ? "shared" : "user";
}
function compareWorkflows(
    a: Workflow,
    b: Workflow,
    sort: { key: WorkflowSortKey; direction: TableSortDirection } | null,
) {
    if (!sort) return 0;
    const direction = sort.direction === "asc" ? 1 : -1;
    const aValue =
        sort.key === "name"
            ? a.metadata.title
            : a.metadata.type === "tabular"
              ? "Tabular"
              : "Assistant";
    const bValue =
        sort.key === "name"
            ? b.metadata.title
            : b.metadata.type === "tabular"
              ? "Tabular"
              : "Assistant";
    return aValue.localeCompare(bValue) * direction;
}
