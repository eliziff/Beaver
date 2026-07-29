"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { deleteWorkflow, hideWorkflow, listHiddenWorkflows, listWorkflows, unhideWorkflow } from "@/app/lib/beaverApi";
import { isAnonymousMode } from "@/app/lib/authMode";
import type { Workflow } from "../shared/types";
import { NewWorkflowModal } from "./NewWorkflowModal";
import { UseWorkflowModal } from "./UseWorkflowModal";
import { workflowDetailPath } from "./workflowRoutes";
import { PageHeader } from "../shared/PageHeader";
import { RowActions } from "../shared/RowActions";
import { TableToolbar } from "../shared/TableToolbar";
import {
    SkeletonLine, TableBody, TableCell, TableEmptyState, TableHeaderCell,
    TableHeaderRow, TableRow, TableScrollArea, TableSelectionPlaceholder,
    TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS, TableStickyCell,
} from "../shared/TablePrimitive";
import { CheckboxControl } from "../ui/checkbox";
import { PillButton } from "../ui/pill-button";

type WorkflowListTab = "all" | "assistant" | "tabular" | "system";
const TABS: { id: WorkflowListTab; label: string }[] = [
    { id: "all", label: "All" },
    { id: "assistant", label: "Assistant" },
    { id: "tabular", label: "Tabular" },
    { id: "system", label: "System" },
];
type WorkflowColumn = readonly [
    label: string, className: string, skeleton: string,
    value: (workflow: Workflow) => string | null | undefined,
];
const COLUMNS: WorkflowColumn[] = [
    ["Type", "ml-auto hidden w-24 sm:flex", "w-16",
        ({ metadata }) => metadata.type === "tabular" ? "Tabular" : "Assistant"],
    ["Practice", "hidden w-32 lg:flex", "w-24", ({ metadata }) => metadata.practice],
    ["Jurisdiction", "hidden w-32 xl:flex", "w-24", ({ metadata }) =>
        metadata.jurisdictions?.join(", ")],
    ["Language", "hidden w-24 2xl:flex", "w-16", ({ metadata }) => metadata.language],
    ["Source", "hidden w-28 lg:flex", "w-14", (workflow) =>
        workflow.is_system ? "System" : workflow.is_owner !== false
            ? "User" : workflow.shared_by_name?.trim() || "Shared"],
];
const ACTION_COLUMN = "w-8";
const rank = (workflow: Workflow, hidden: Set<string>) =>
    workflow.is_system
        ? 2 + Number(hidden.has(workflow.id))
        : Number(workflow.is_owner === false);

export function WorkflowList() {
    const router = useRouter();
    const mutationsEnabled = !isAnonymousMode;
    const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
    const [selected, setSelected] = useState<Workflow | null>(null);
    const [creating, setCreating] = useState(false);
    const [hiddenSystemIds, setHiddenSystemIds] = useState<string[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [activeTab, setActiveTab] = useState<WorkflowListTab>("all");
    const [search, setSearch] = useState("");

    useEffect(() => {
        Promise.all([listWorkflows(), listHiddenWorkflows().catch(() => [])])
            .then(([loaded, hidden]) => {
                setWorkflows(loaded);
                setHiddenSystemIds(hidden);
            })
            .catch(() => setWorkflows([]));
    }, []);

    const loading = workflows === null;
    const rows = workflows ?? [];
    const hidden = new Set(hiddenSystemIds);
    const selectedSet = new Set(selectedIds);
    const selectedRows = rows.filter(({ id }) => selectedSet.has(id));
    const canSelect = (workflow: Workflow) =>
        mutationsEnabled && (workflow.is_system || workflow.is_owner !== false);
    const visible = [...rows]
        .sort((a, b) => rank(a, hidden) - rank(b, hidden))
        .filter((workflow) => {
            if (activeTab === "system") return workflow.is_system;
            if (workflow.is_system && hidden.has(workflow.id)) return false;
            return activeTab === "all" || workflow.metadata.type === activeTab;
        })
        .filter((workflow) =>
            workflow.metadata.title.toLowerCase().includes(search.toLowerCase()),
        );
    const selectable = visible.filter(canSelect);
    const allSelected = !!selectable.length && selectable.every(
        ({ id }) => selectedSet.has(id));
    const someSelected = !allSelected && selectable.some(
        ({ id }) => selectedSet.has(id));
    const onlySystem = !!selectedRows.length &&
        selectedRows.every((workflow) => workflow.is_system);
    const onlyHiddenSystem = !!selectedRows.length &&
        selectedRows.every(({ id }) => hidden.has(id));
    const bulkLabel = onlyHiddenSystem ? "Activate"
        : onlySystem ? "Deactivate" : "Delete";

    function toggleAll() {
        setSelectedIds(allSelected ? [] : selectable.map(({ id }) => id));
    }
    function toggleOne(id: string) {
        setSelectedIds((current) =>
            current.includes(id)
                ? current.filter((selectedId) => selectedId !== id)
                : [...current, id],
        );
    }
    function updateHidden(ids: string[], shouldHide: boolean) {
        setHiddenSystemIds((current) => shouldHide
            ? [...new Set([...current, ...ids])]
            : current.filter((id) => !ids.includes(id)));
    }
    async function changeHidden(id: string, shouldHide: boolean) {
        updateHidden([id], shouldHide);
        await (shouldHide ? hideWorkflow(id) : unhideWorkflow(id))
            .catch(() => updateHidden([id], !shouldHide));
    }
    async function remove(id: string) {
        await deleteWorkflow(id);
        setWorkflows((current) =>
            current?.filter((workflow) => workflow.id !== id) ?? current);
    }
    async function runBulkAction() {
        setSelectedIds([]);
        await Promise.allSettled(selectedRows.map((workflow) =>
            workflow.is_system
                ? changeHidden(workflow.id, !onlyHiddenSystem)
                : remove(workflow.id)));
    }

    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <PageHeader shrink loading={loading} actions={[
                {
                    type: "search", value: search, onChange: setSearch,
                    placeholder: "Search workflows\u2026",
                },
                mutationsEnabled ? {
                    type: "new", onClick: () => setCreating(true),
                    title: "New workflow",
                } : null,
            ]}>
                <h1 className="text-2xl font-medium font-serif text-gray-900">Workflows</h1>
            </PageHeader>
            <TableToolbar items={TABS} active={activeTab}
                onChange={(tab) => {
                    setActiveTab(tab);
                    setSelectedIds([]);
                }}
                actions={mutationsEnabled ? (
                    <span className="inline-flex h-8 w-28">
                        {selectedIds.length > 0 && (
                            <PillButton tone="white" size="sm"
                                onClick={() => void runBulkAction()}
                                className="h-8 w-full px-4 text-sm"
                            >
                                {bulkLabel}
                            </PillButton>
                        )}
                    </span>
                ) : undefined}
            />
            <TableScrollArea header={
                <TableHeaderRow>
                    <TableStickyCell header
                        widthClassName={TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}>
                        {mutationsEnabled && (loading
                            ? <TableSelectionPlaceholder />
                            : (
                                <CheckboxControl checked={allSelected}
                                    ref={(element) => {
                                        if (element)
                                            element.indeterminate = someSelected;
                                    }}
                                    onChange={toggleAll} className="-ml-2 mr-1"
                                />
                            ))}
                        <span className="mr-1">Name</span>
                    </TableStickyCell>
                    {COLUMNS.map(([label, className]) => (
                        <TableHeaderCell key={label} className={className}>{label}</TableHeaderCell>
                    ))}
                    <TableHeaderCell className={ACTION_COLUMN} />
                </TableHeaderRow>
            }>
                {loading ? (
                    <TableBody>
                        {[1, 2, 3].map((key) => (
                            <TableRow key={key} interactive={false}>
                                <TableStickyCell widthClassName={
                                    TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}>
                                    <div className="flex items-center">
                                        {mutationsEnabled && <TableSelectionPlaceholder />}
                                        <SkeletonLine className="h-3.5 w-48" />
                                    </div>
                                </TableStickyCell>
                                {COLUMNS.map(([label, className, width]) => (
                                    <TableCell key={label} className={className}>
                                        <SkeletonLine className={width} /></TableCell>
                                ))}
                                <TableCell className={ACTION_COLUMN} />
                            </TableRow>
                        ))}
                    </TableBody>
                ) : visible.length === 0 ? (
                    <TableEmptyState>
                        <p className="text-sm text-gray-500">
                            {search ? "No matching workflows." : "No workflows yet."}</p>
                        {!search && mutationsEnabled && (
                            <PillButton tone="black" size="sm"
                                onClick={() => setCreating(true)}
                                className="mt-4 px-3"
                            >
                                <Plus className="h-3.5 w-3.5" />
                                Create
                            </PillButton>
                        )}
                    </TableEmptyState>
                ) : (
                    <TableBody>
                        {visible.map((workflow) => {
                            const isHidden = hidden.has(workflow.id);
                            const isSelected = selectedSet.has(workflow.id);
                            const selectable = canSelect(workflow);
                            const canHide = mutationsEnabled && workflow.is_system;
                            const canEdit = mutationsEnabled &&
                                !workflow.is_system &&
                                workflow.allow_edit !== false;
                            const canDelete = mutationsEnabled &&
                                !workflow.is_system &&
                                workflow.is_owner !== false;
                            return (
                                <TableRow key={workflow.id}
                                    selected={selectable && isSelected}
                                    className={isHidden ? "opacity-45" : undefined}
                                    onClick={() => setSelected(workflow)}
                                >
                                    <TableStickyCell widthClassName={
                                        TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}>
                                        <div className="flex min-w-0 items-center">
                                            {selectable && (
                                                <CheckboxControl checked={isSelected}
                                                    onChange={() =>
                                                        toggleOne(workflow.id)}
                                                    onClick={(event) =>
                                                        event.stopPropagation()}
                                                    className="-ml-2 mr-1"
                                                />
                                            )}
                                            <span className="min-w-0 flex-1 truncate text-sm text-gray-900">
                                                {workflow.metadata.title}
                                            </span>
                                        </div>
                                    </TableStickyCell>
                                    {COLUMNS.map(
                                        ([label, className, , valueFor]) => {
                                            const value = valueFor(workflow);
                                            return (
                                                <TableCell key={label}
                                                    className={className}>
                                                    {value && (
                                                        <span className="block max-w-full truncate text-xs font-medium text-gray-600">
                                                            {value}
                                                        </span>
                                                    )}
                                                </TableCell>
                                            );
                                        },
                                    )}
                                    <div
                                        className={`${ACTION_COLUMN} shrink-0 justify-end`}
                                        onClick={(event) => event.stopPropagation()}
                                    >
                                        {(canHide || canEdit || canDelete) && (
                                            <RowActions
                                                onUnhide={canHide && isHidden
                                                    ? () => changeHidden(
                                                        workflow.id, false)
                                                    : undefined}
                                                onHide={canHide && !isHidden
                                                    ? () => changeHidden(
                                                        workflow.id, true)
                                                    : undefined}
                                                onEditDetails={canEdit
                                                    ? () => router.push(
                                                        workflowDetailPath(
                                                            workflow))
                                                    : undefined}
                                                onDelete={canDelete
                                                    ? () => remove(workflow.id)
                                                    : undefined}
                                            />
                                        )}
                                    </div>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                )}
            </TableScrollArea>
            <UseWorkflowModal workflow={selected} onClose={() => setSelected(null)} />
            <NewWorkflowModal open={creating}
                onClose={() => setCreating(false)}
                onCreated={(workflow) => {
                    setWorkflows((current) => [workflow, ...(current ?? [])]);
                    setCreating(false);
                    router.push(workflowDetailPath(workflow));
                }}
            />
        </div>
    );
}
