import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Play, Plus, Users } from "lucide-react";
import {
    apiBlobRequest, deleteWorkflow, deleteWorkflowShare, getWorkflow, listWorkflowShares,
    lookupUserByEmail, shareWorkflow, updateWorkflow, type ProjectPeople,
} from "@/app/lib/beaverApi";
import type { ColumnConfig, Workflow } from "../shared/types";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { isLocalMode } from "@/app/lib/authMode";
import { downloadBlob } from "@/app/lib/download";
import { AddColumnModal } from "../tabular/AddColumnModal";
import { formatLabel } from "../tabular/columnFormat";
import { PeopleModal } from "../modals/PeopleModal";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { HeaderActionsMenu, type HeaderActionsMenuItem } from "../shared/HeaderActionsMenu";
import { PageHeader, type PageHeaderAction } from "../shared/PageHeader";
import {
    SkeletonLine, TableBody, TableCell, TableEmptyState, TableHeaderCell,
    TableHeaderRow, TablePrimaryCell, TableRow, TableScrollArea,
    TableStickyCell,
} from "../shared/TablePrimitive";
import { TableToolbar } from "../shared/TableToolbar";
import { CheckboxControl } from "../ui/checkbox";
import { LIQUID_TABLE_SURFACE_CLASS } from "../ui/liquid-surface";
import { PillButton } from "../ui/pill-button";
import { TabPillButton } from "../ui/tab-pill-button";
import { NewWorkflowModal } from "./NewWorkflowModal";
import { UseWorkflowModal } from "./UseWorkflowModal";
import { WFColumnViewModal } from "./WFColumnViewModal";

interface Props { id: string; workflowType: Workflow["metadata"]["type"] }
type WorkflowModal = "details" | "share" | "use" | "delete" | null;
const NAME_COLUMN = "w-[332px] shrink-0";
const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function WorkflowDetailPage({ id, workflowType }: Props) {
    const navigate = useNavigate();
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const [workflow, setWorkflow] = useState<Workflow | null>();
    const [ui, setUiState] = useState({
        save: "idle" as "idle" | "saving" | "saved",
        selectedColumns: [] as number[],
        columnModal: null as ColumnConfig | "new" | null,
        modal: null as WorkflowModal,
        sharedWith: [] as string[],
        deleting: "idle" as "idle" | "loading" | "complete",
    });
    const promptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const setUi = (patch: Partial<typeof ui>) =>
        setUiState((current) => ({ ...current, ...patch }));
    const { save, selectedColumns, columnModal, modal, sharedWith, deleting } = ui;
    const readOnly = (workflow?.is_system ?? false) || workflow?.allow_edit === false;
    const canShare = !isLocalMode && !readOnly && (workflow?.is_owner ?? true);
    const prompt = workflow?.skill_md ?? "";
    const columns = workflow?.columns_config ?? [];
    const activeColumn = columnModal === "new" ? null : columnModal;

    useEffect(() => {
        getWorkflow(id)
            .then((loaded) => setWorkflow(
                loaded.metadata.type !== workflowType ? null : {
                    ...loaded,
                    columns_config: (loaded.columns_config ?? [])
                        .slice().sort((a, b) => a.index - b.index),
                },
            ))
            .catch(() => setWorkflow(null));
    }, [id, workflowType]);

    const fetchPeople = useCallback(async (): Promise<ProjectPeople> => {
        const shares = await listWorkflowShares(id);
        setUiState((current) => ({ ...current,
            sharedWith: shares.map(({ shared_with_email }) =>
                normalizeEmail(shared_with_email)),
        }));
        const members = await Promise.all(shares.map(async (share) => {
            const email = normalizeEmail(share.shared_with_email);
            const found = await lookupUserByEmail(email).catch(() => null);
            return { email,
                display_name: found?.exists === true ? found.display_name : null };
        }));
        return { owner: {
                email: user?.email ?? null,
                display_name: profile?.displayName ?? null,
            }, members };
    }, [id, profile?.displayName, user?.email]);

    async function changeSharedWith(next: string[]) {
        const emails = [...new Set(next.map(normalizeEmail).filter(Boolean))];
        const current = await listWorkflowShares(id);
        const currentByEmail = new Map(current.map((share) =>
            [normalizeEmail(share.shared_with_email), share]));
        const nextSet = new Set(emails);
        const added = emails.filter((email) => !currentByEmail.has(email));
        const removed = current.filter(({ shared_with_email }) =>
            !nextSet.has(normalizeEmail(shared_with_email)));
        await Promise.all([
            ...removed.map((share) => deleteWorkflowShare(id, share.id)),
            ...(added.length
                ? [shareWorkflow(id, { emails: added, allow_edit: false })]
                : []),
        ]);
        setUi({ sharedWith: emails });
    }
    async function persist(payload: Parameters<typeof updateWorkflow>[1]) {
        try {
            await updateWorkflow(id, payload);
            setUi({ save: "saved" });
            setTimeout(() => setUi({ save: "idle" }), 2000);
        } catch {
            setUi({ save: "idle" });
        }
    }
    function savePrompt(next: string) {
        setWorkflow((current) =>
            current ? { ...current, skill_md: next } : current);
        void persist({ skill_md: next });
    }
    function changePrompt(next: string) {
        if (promptTimer.current) clearTimeout(promptTimer.current);
        if (save !== "saving") setUi({ save: "saving" });
        promptTimer.current = setTimeout(() => savePrompt(next), 800);
    }
    function blurPrompt(next: string) {
        if (promptTimer.current) clearTimeout(promptTimer.current);
        if (next !== prompt) savePrompt(next);
    }
    function saveColumns(next: ColumnConfig[]) {
        if (readOnly) return;
        setWorkflow((current) =>
            current ? { ...current, columns_config: next } : current);
        setUi({ save: "saving" });
        void persist({ columns_config: next });
    }
    function addColumns(added: ColumnConfig[]) {
        saveColumns([...columns,
            ...added.map((column, index) => ({
                ...column, index: columns.length + index,
            })),
        ]);
        setUi({ columnModal: null });
    }
    function removeColumns(indices: number[]) {
        saveColumns(columns
            .filter(({ index }) => !indices.includes(index))
            .map((column, index) => ({ ...column, index })));
        setUi({ selectedColumns: [], columnModal: null });
    }
    function saveColumn(updated: ColumnConfig) {
        saveColumns(columns.map((column) =>
            column.index === updated.index ? updated : column));
        setUi({ columnModal: null });
    }
    function toggleColumn(index: number) {
        setUi({ selectedColumns: selectedColumns.includes(index)
            ? selectedColumns.filter((selected) => selected !== index)
            : [...selectedColumns, index] });
    }
    async function removeWorkflow() {
        if (!workflow || readOnly || workflow.is_owner === false) return;
        setUi({ deleting: "loading" });
        try {
            await deleteWorkflow(id);
            setUi({ deleting: "complete" });
            setTimeout(() => navigate("/workflows"), 600);
        } catch {
            setUi({ deleting: "idle" });
        }
    }

    if (workflow === null) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <p className="text-gray-400 font-serif">Workflow not found.</p></div>
        );
    }

    const menuItems: HeaderActionsMenuItem[] = workflow ? [
        { label: "Download workflow",
            onSelect: () => void apiBlobRequest(
                `/workflows/${encodeURIComponent(workflow.id)}/export`,
            ).then(({ blob, filename }) =>
                downloadBlob(blob, filename ?? "workflow.zip")),
        },
        { label: "View and Edit details", onSelect: () => setUi({ modal: "details" }) },
        ...(!readOnly ? [{
            label: "Delete",
            disabled: workflow.is_owner === false,
            onSelect: () => setUi({ deleting: "idle", modal: "delete" }),
        }] : []),
    ] : [];
    const actions: (PageHeaderAction | null)[] | undefined = workflow ? [
        { type: "custom", render: (
                <span
                    aria-live="polite"
                    className={`inline-flex h-7 w-24 items-center justify-center rounded-full text-sm text-gray-500 ${
                        save === "idle" ? "invisible" : ""
                    }`}
                >
                    {save === "saving" ? "Saving\u2026" : "Saved"}
                </span>
            ),
        },
        canShare ? {
            onClick: () => setUi({ modal: "share" }),
            title: "Open workflow people",
            iconOnly: true,
            icon: <Users className="h-4 w-4" />,
        } : null,
        { type: "custom",
            render: <HeaderActionsMenu title="Workflow actions" items={menuItems} />,
        },
        { label: "Use",
            icon: <Play className="h-3.5 w-3.5" />,
            onClick: () => setUi({ modal: "use" }),
        },
    ] : undefined;

    return (
        <div className="flex h-full flex-col">
            <PageHeader shrink breadcrumbs={[
                    { label: "Workflows",
                        onClick: () => navigate("/workflows"),
                        title: "Back to Workflows",
                    },
                    workflow
                        ? { label: workflow.metadata.title }
                        : { loading: true, skeletonClassName: "w-40" },
                ]} actions={actions} />
            {workflow && (
                <>
                    <UseWorkflowModal workflow={modal === "use" ? workflow : null}
                        onClose={() => setUi({ modal: null })} />
                    <NewWorkflowModal
                        open={modal === "details"} editWorkflow={workflow}
                        readOnly={readOnly}
                        onClose={() => setUi({ modal: null })}
                        onCreated={() => undefined}
                        onUpdated={(updated) => {
                            setWorkflow((current) => current ? {
                                ...current,
                                ...updated,
                                shared_by_name: updated.shared_by_name ??
                                    current.shared_by_name ?? null,
                            } : updated);
                            setUi({ modal: null });
                        }}
                    />
                    <PeopleModal
                        open={modal === "share"} fetchPeople={fetchPeople}
                        onClose={() => setUi({ modal: null })}
                        resource={{ id, shared_with: sharedWith }}
                        currentUserEmail={user?.email ?? null}
                        breadcrumb={["Workflows", workflow.metadata.title, "People"]}
                        onSharedWithChange={changeSharedWith}
                    />
                    <ConfirmPopup
                        open={modal === "delete"} title="Delete workflow?"
                        message="This workflow will be permanently deleted."
                        confirmLabel="Delete" confirmStatus={deleting}
                        onConfirm={() => void removeWorkflow()}
                        onCancel={() => {
                            if (deleting !== "loading")
                                setUi({ modal: null, deleting: "idle" });
                        }}
                    />
                </>
            )}
            <div className="flex min-h-0 flex-1 flex-col">
                {!workflow ? (
                    workflowType === "tabular" ? (
                        <div className="flex min-h-0 flex-1 flex-col pt-2">
                            <TableToolbar actions={
                                <SkeletonLine className="h-7 w-24 rounded-full" />} />
                            <div aria-hidden="true"
                                className={`min-h-0 flex-1 ${LIQUID_TABLE_SURFACE_CLASS}`} />
                        </div>
                    ) : (
                        <div className="min-h-0 flex-1 px-4 pb-2 pt-4 md:px-6 md:pb-3">
                            <div aria-hidden="true"
                                className={`h-full ${LIQUID_TABLE_SURFACE_CLASS}`} />
                        </div>
                    )
                ) : workflow.metadata.type === "assistant" ? (
                    <div className="flex-1 min-h-0 px-4 pb-2 pt-4 md:px-6 md:pb-3">
                        <textarea
                            key={id} aria-label="Workflow prompt"
                            defaultValue={prompt} readOnly={readOnly}
                            onChange={(event) => changePrompt(event.target.value)}
                            onBlur={(event) => blurPrompt(event.target.value)}
                            placeholder="Write the workflow prompt in Markdown." spellCheck
                            className="min-h-80 w-full resize-y rounded-md border border-gray-300 bg-white p-4 font-mono text-sm leading-6 text-gray-900 outline-none focus:border-gray-600 read-only:resize-none read-only:bg-gray-50"
                        />
                    </div>
                ) : (
                    <div className="flex flex-col flex-1 min-h-0 pt-2">
                        {!readOnly && (
                            <TableToolbar actions={
                                <div className="flex items-center gap-2">
                                    <TabPillButton onClick={() =>
                                        removeColumns(selectedColumns)}
                                        disabled={!selectedColumns.length}
                                        className={`w-28 text-red-700 ${
                                            selectedColumns.length
                                                ? "" : "invisible"
                                        }`}
                                    >
                                        Delete selected
                                    </TabPillButton>
                                    <TabPillButton onClick={() =>
                                        setUi({ columnModal: "new" })}>
                                        <Plus className="h-3.5 w-3.5" />
                                        Add Column
                                    </TabPillButton>
                                </div>
                            } />
                        )}
                        <TableScrollArea header={
                            <TableHeaderRow className="md:pr-10">
                                <TableStickyCell header widthClassName={NAME_COLUMN}>
                                    {columns.length ? (
                                        <CheckboxControl
                                            checked={selectedColumns.length ===
                                                columns.length}
                                            ref={(element) => {
                                                if (element)
                                                    element.indeterminate =
                                                        !!selectedColumns.length &&
                                                        selectedColumns.length <
                                                            columns.length;
                                            }}
                                            onChange={() => setUi({
                                                selectedColumns:
                                                    selectedColumns.length ===
                                                    columns.length
                                                        ? []
                                                        : columns.map(
                                                            ({ index }) => index),
                                            })}
                                            className="-ml-2 mr-1"
                                        />
                                    ) : (
                                        <span className="-ml-2 mr-1 h-9 w-9 shrink-0"
                                            aria-hidden="true" />
                                    )}
                                    <span>Column Title</span>
                                </TableStickyCell>
                                <TableHeaderCell className="ml-auto w-36">Format</TableHeaderCell>
                                <TableHeaderCell className="min-w-[240px] flex-1">Prompt</TableHeaderCell>
                            </TableHeaderRow>
                        }>
                            {!columns.length ? (
                                <TableEmptyState>
                                    <p className="font-serif text-2xl font-medium text-gray-900">
                                        No columns</p>
                                    {!readOnly && (
                                        <PillButton tone="black" size="sm"
                                            onClick={() =>
                                                setUi({ columnModal: "new" })}
                                            className="mt-4 px-3"
                                        >
                                            <Plus className="h-3.5 w-3.5" />
                                            Add Column
                                        </PillButton>
                                    )}
                                </TableEmptyState>
                            ) : (
                                <TableBody>
                                    {columns.map((column) => {
                                        const selected =
                                            selectedColumns.includes(column.index);
                                        return (
                                            <TableRow
                                                key={column.index} selected={selected}
                                                onClick={() => setUi({
                                                    columnModal: column,
                                                })}
                                                className="md:pr-10"
                                            >
                                                <TablePrimaryCell
                                                    widthClassName={NAME_COLUMN} selected={selected}
                                                    onSelectionChange={() =>
                                                        toggleColumn(column.index)}
                                                    label={column.name}
                                                />
                                                <TableCell className="ml-auto w-36">
                                                    {formatLabel(
                                                        column.format ?? "text")}
                                                </TableCell>
                                                <TableCell className="min-w-[240px] flex-1 pr-4 text-xs">
                                                    {column.prompt}
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            )}
                        </TableScrollArea>
                    </div>
                )}
            </div>
            {workflow && readOnly && activeColumn && (
                <WFColumnViewModal col={activeColumn}
                    onClose={() => setUi({ columnModal: null })} />
            )}
            {workflow && (
                <AddColumnModal
                    open={!readOnly && columnModal !== null}
                    existingCount={columns.length}
                    editingColumn={activeColumn ?? undefined}
                    onClose={() => setUi({ columnModal: null })}
                    onAdd={addColumns} onSave={saveColumn}
                    onDelete={() => {
                        if (activeColumn) removeColumns([activeColumn.index]);
                    }}
                />
            )}
        </div>
    );
}
