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
    TablePrimaryCell,
    TableRow,
    TableScrollArea,
    TableSelectionPlaceholder,
    TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS,
    TableStickyCell,
} from "../shared/TablePrimitive";
import { CheckboxControl } from "@/app/components/ui/checkbox";
type WorkflowListTab = "all" | "assistant" | "tabular" | "system";
const WORKFLOW_TABS: { id: WorkflowListTab; label: string }[] = [
    { id: "all", label: "All" },
    { id: "assistant", label: "Assistant" },
    { id: "tabular", label: "Tabular" },
    { id: "system", label: "System" },
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
    const q = search.toLowerCase();
    const filtered = tabRows.filter(
        (wf) => !q || wf.metadata.title.toLowerCase().includes(q),
    );
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
                        </TableStickyCell>
                        <TableHeaderCell
                            className={`ml-auto ${WORKFLOW_COLUMN.type}`}
                        >
                            Type
                        </TableHeaderCell>
                        <TableHeaderCell className={WORKFLOW_COLUMN.practice}>
                            Practice
                        </TableHeaderCell>
                        <TableHeaderCell
                            className={WORKFLOW_COLUMN.jurisdiction}
                        >
                            Jurisdiction
                        </TableHeaderCell>
                        <TableHeaderCell className={WORKFLOW_COLUMN.language}>
                            Language
                        </TableHeaderCell>
                        <TableHeaderCell className={WORKFLOW_COLUMN.source}>
                            Source
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
                            <WorkflowSkeuoIcon className="mb-4 h-8 w-8" />
                            <p className="text-2xl font-medium font-serif text-gray-900">
                                Workflows
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
                                    {wf.metadata.practice && (
                                        <span className="text-xs font-medium text-gray-600">
                                            {wf.metadata.practice}
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell
                                    className={WORKFLOW_COLUMN.jurisdiction}
                                >
                                    {wf.metadata.jurisdictions?.length ? (
                                        <span className="truncate max-w-full text-xs font-medium text-gray-600">
                                            {wf.metadata.jurisdictions.join(", ")}
                                        </span>
                                    ) : null}
                                </TableCell>
                                <TableCell className={WORKFLOW_COLUMN.language}>
                                    {wf.metadata.language && (
                                        <span className="text-xs font-medium text-gray-600">
                                            {wf.metadata.language}
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
