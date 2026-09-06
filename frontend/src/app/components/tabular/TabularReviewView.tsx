import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { MessageSquare, MessageSquareX, Play, Plus, Square, Upload, Users } from "lucide-react";
import {
  clearTabularCells,
  deleteTabularReview,
  getTabularReview,
  getTabularReviewPeople,
  regenerateTabularCell,
  exportTabularReview,
  ensureTabularWorkspace,
  stopTabularGeneration,
  startTabularGeneration,
  updateTabularReview,
  type ColumnConfig,
  type TabularCell,
  type TabularReview,
  type TabularDocument,
} from "@/app/lib/api/tabular";
import { getProject, type Project } from "@/app/lib/api/projects";
import {
  directoryResource,
  uploadDocuments,
  uploadStandaloneDocument,
  type Document,
} from "@/app/lib/api/documents";
import { BeaverApiError } from "@/app/lib/api/client";
import { downloadBlob } from "@/app/lib/download";
import { useAuth } from "@/app/contexts/AuthContext";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useSelectedModel, useSelectedReasoningEffort } from "@/app/hooks/useSelectedModel";
import { getModelProvider, isModelAvailable, type ModelProvider } from "@/app/lib/modelAvailability";



import { MoreActionsMenu } from "../shared/MoreActionsMenu";
import { ResearchViews } from "../shared/ResearchViews";
import { ResearchSelectionLabels } from "../shared/ResearchSelectionLabels";
import { ResearchChanges } from "../legal/ResearchChanges";
import { getResearchFile } from "@/app/lib/api/researchFiles";
import { researchSourceKey } from "@/app/lib/researchFiles";
import { PageHeader, type PageHeaderAction, type PageHeaderBreadcrumb } from "../shared/PageHeader";
import { TableToolbar } from "../shared/TableToolbar";
import { AddDocumentsModal } from "../modals/AddDocumentsModal";
import { PeopleModal } from "../modals/PeopleModal";
import { ApiKeyMissingPopup } from "../popups/ApiKeyMissingPopup";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { OwnerOnlyPopup } from "../popups/OwnerOnlyPopup";
import { ActionMenu } from "../ui/action-menu";
import { Button } from "../ui/button";
import { WorkflowPickerModal } from "../workflows/WorkflowPickerModal";
import type { WorkflowSelection } from "../workflows/workflowRoutes";
import { AddColumnModal } from "./AddColumnModal";
import type { Citation } from "@/app/lib/citations";
import { TabularReviewDetailsModal } from "./TabularReviewDetailsModal";
import { TRChatPanel } from "./TRChatPanel";
import { TRSidePanel } from "./TRSidePanel";
import { TRTable } from "./TRTable";

interface Props { reviewId: string; projectId?: string }
type Modal = "documents" | "details" | "people" | null;
type CellView = { cellId: string; citation?: Citation };
const cellKey = (documentId: string, columnIndex: number) =>
    `${documentId}:${columnIndex}`;
const pendingCell = (
    documentId: string, columnIndex: number,
): TabularCell => ({
    id: `new-${documentId}-${columnIndex}`,
    document_id: documentId,
    column_index: columnIndex,
    content: null,
    status: "pending",
});

export function TRView({ reviewId, projectId }: Props) {
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const { user } = useAuth();
    const { setSidebarOpen } = useSidebar();
    const { profile } = useUserProfile();
    const [model] = useSelectedModel();
    const [reasoningEffort] = useSelectedReasoningEffort();
    const [review, setReview] = useState<TabularReview | null>(null);
    const [projects, setProjects] = useState<Project[]>([]);
    const [cells, setCells] = useState<TabularCell[]>([]);
    const [documents, setDocuments] = useState<TabularDocument[]>([]);
    const initialChat = searchParams.get("chat");
    const [ui, setUiState] = useState(() => ({
        loading: true,
        generating: false,
        columnModal: undefined as ColumnConfig | null | undefined,
        modal: null as Modal,
        historyOpen: false,
        workflowStatus: null as "open" | "applying" | null,
        deleteStatus: null as "open" | "deleting" | null,
        ownerAction: null as string | null,
        cellView: null as CellView | null,
        selectedIds: [] as string[],
        search: "",
        dragOver: false,
        uploading: [] as string[],
        chatId: initialChat === "new" ? null : initialChat ?? undefined,
        highlightedCell: null as { colIdx: number; rowIdx: number } | null,
        missingProvider: null as ModelProvider | null,
    }));
    const setUi = useCallback((patch: Partial<typeof ui>) =>
        setUiState((current) => ({ ...current, ...patch })), []);
    useEffect(() => {
        setUi({ chatId: initialChat === "new" ? null : initialChat ?? undefined });
    }, [initialChat, setUi]);
    const {
        loading, generating, columnModal, modal, workflowStatus, deleteStatus,
        ownerAction, cellView, selectedIds, search, dragOver, uploading, chatId,
        highlightedCell, missingProvider,
    } = ui;
    const columns = review?.columns_config ?? [];
    const project = projectId ? projects.find(({ id }) => id === projectId) ?? null : null;
    const chatOpen = chatId !== undefined;
    const expandedCell = cells.find(({ id }) => id === cellView?.cellId);
    const expandedCitation = cellView?.citation;
    const refreshReview = useCallback(async () => {
        const data = await getTabularReview(reviewId);
        setReview(data.review); setCells(data.cells); setDocuments(data.documents);
        setUi({ generating: data.review.is_running === true });
    }, [reviewId, setUi]);

    useEffect(() => {
        let active = true;
        setUi({ loading: true });
        void getTabularReview(reviewId).then((data) => {
            if (!active) return;
            setReview(data.review);
            setCells(data.cells);
            setDocuments(data.documents);
            setUi({ loading: false, generating: data.review.is_running === true });
            const linkedProjectId = projectId ?? data.review.project_id;
            if (linkedProjectId) void getProject(linkedProjectId).then((loaded) => {
                if (active) setProjects([loaded]);
            }).catch(() => undefined);
            else setProjects([]);
        }).catch(() => { if (active) setUi({ loading: false }); });
        return () => { active = false; };
    }, [projectId, reviewId, setUi]);

    useEffect(() => {
        if (!generating) return;
        let active = true;
        let timer: number;
        const refresh = async () => {
            try {
                const data = await getTabularReview(reviewId);
                if (!active) return;
                setReview((current) => ({ ...data.review,
                    columns_config: JSON.stringify(current?.columns_config) === JSON.stringify(data.review.columns_config)
                        ? current!.columns_config : data.review.columns_config,
                }));
                setCells((current) => {
                    const previous = new Map(current.map((cell) => [cell.id, cell]));
                    return data.cells.map((cell) => {
                        const old = previous.get(cell.id);
                        return JSON.stringify(old) === JSON.stringify(cell) ? old! : cell;
                    });
                });
                if (!data.review.is_running) return setUi({ generating: false });
            } catch { /* Keep the existing results while a refresh is unavailable. */ }
            if (active) timer = window.setTimeout(refresh, 2_000);
        };
        timer = window.setTimeout(refresh, 2_000);
        return () => { active = false; window.clearTimeout(timer); };
    }, [generating, reviewId, setUi]);

    const expandCell = useCallback(({ id }: TabularCell) => setUi({ cellView: { cellId: id } }), [setUi]);
    const openCitation = useCallback((cell: TabularCell, citation: Citation) => setUi({ cellView: {
            cellId: cell.id, citation,
        } }), [setUi]);

    function setChatId(next: string | null | undefined) {
        setUi({ chatId: next });
        const params = new URLSearchParams(searchParams);
        if (next === undefined) params.delete("chat");
        else params.set("chat", next ?? "new");
        if (next !== chatId) { params.delete("message"); params.delete("highlight"); }
        setSearchParams(params, { replace: true });
    }
    function setColumns(next: ColumnConfig[]) {
        setReview((current) =>
            current ? { ...current, columns_config: next } : current);
    }
    async function saveColumns(next: ColumnConfig[], workflowId?: string) {
        const updated = await updateTabularReview(reviewId, {
            columns_config: next,
            document_ids: documents.map(({ id }) => id),
            ...(workflowId && { workflow_id: workflowId }),
        });
        setReview({ ...updated, columns_config: updated.columns_config || next });
    }
    async function addDocuments(incoming: Document[]) {
        const added = incoming.filter(({ id }) =>
            !documents.some((document) => document.id === id));
        if (!added.length) return;
        await updateTabularReview(reviewId, {
            document_ids: [...documents, ...added].map(({ id }) => id),
            columns_config: columns,
        });
        setDocuments((current) => [...current, ...added]);
        if (columns.length) {
            setCells((current) => [
                ...current,
                ...added.flatMap((document) => columns.map((column) =>
                    pendingCell(document.id, column.index))),
            ]);
        }
    }
    async function dropFiles(files: File[]) {
        if (!files.length) return;
        setUi({ uploading: files.map(({ name }) => name) });
        try {
            const upload = projectId
                ? directoryResource({ projectId }).uploadDocument
                : uploadStandaloneDocument;
            const uploaded = await uploadDocuments(files, upload);
            await addDocuments(uploaded);
        } catch (error) {
            console.error("Tabular review document drop upload failed", error);
        } finally {
            setUi({ uploading: [] });
        }
    }
    function patchCell(documentId: string, columnIndex: number,
        patch: Partial<TabularCell>) {
        setCells((current) => current.map((cell) =>
            cell.document_id === documentId &&
            cell.column_index === columnIndex
                ? { ...cell, ...patch } : cell));
    }
    function modelUnavailable() {
        if (profile?.apiKeys && !isModelAvailable(model, profile.apiKeys)) {
            setUi({ missingProvider: getModelProvider(model) });
            return true;
        }
        return false;
    }
    async function regenerateCell(documentId: string, columnIndex: number) {
        if (generating || modelUnavailable()) return;
        setUi({ generating: true });
        patchCell(documentId, columnIndex, { status: "generating", content: null });
        try {
            await regenerateTabularCell(
                reviewId, documentId, columnIndex, { model, reasoningEffort });
        } catch (error) {
            console.error("Regeneration failed", error);
            patchCell(documentId, columnIndex, { status: "error" });
            setUi({ generating: false });
        }
    }
    async function generate() {
        if (!review || generating || !columns.length || modelUnavailable()) return;
        setUi({ generating: true });
        try {
            const { queued } = await startTabularGeneration(
                reviewId, { model, reasoningEffort });
            if (!queued) {
                setUi({ generating: false });
                return;
            }
            setCells((current) => {
                const existing = new Map(current.map((cell) =>
                    [cellKey(cell.document_id, cell.column_index), cell]));
                return documents.flatMap((document) => columns.map((column) => {
                    const cell = existing.get(cellKey(
                        document.id, column.index)) ?? {
                        ...pendingCell(document.id, column.index),
                        id: `${document.id}-${column.index}`,
                    };
                    return cell.status === "done" && cell.content
                        ? cell
                        : { ...cell, status: "generating", content: null };
                }));
            });
        } catch (error) {
            if (error instanceof BeaverApiError &&
                error.code === "missing_api_key") {
                setUi({ missingProvider: getModelProvider(model) });
            }
            console.error("Generation failed", error);
            setUi({ generating: false });
        }
    }
    async function stopGeneration() {
        try {
            await stopTabularGeneration(reviewId);
            const data = await getTabularReview(reviewId);
            setReview(data.review);
            setCells(data.cells);
            setUi({ generating: data.review.is_running === true });
        } catch (error) {
            console.error("Failed to stop generation", error);
        }
    }
    async function addColumns(incoming: ColumnConfig[]) {
        const start = columns.reduce(
            (max, column) => Math.max(max, column.index), -1) + 1;
        const added = incoming.map((column, index) => ({
            ...column, index: start + index,
        }));
        const next = [...columns, ...added];
        setColumns(next);
        setCells((current) => {
            const existing = new Set(current.map((cell) =>
                cellKey(cell.document_id, cell.column_index)));
            return [
                ...current,
                ...documents.flatMap((document) => added
                    .filter(({ index }) =>
                        !existing.has(cellKey(document.id, index)))
                    .map(({ index }) =>
                        pendingCell(document.id, index))),
            ];
        });
        try {
            await saveColumns(next);
        } catch (error) {
            const addedIndices = new Set(added.map(({ index }) => index));
            setColumns(columns);
            setCells((current) => current.filter(
                ({ column_index }) => !addedIndices.has(column_index)));
            console.error("Failed to save column", error);
        }
    }
    async function commitColumns(next: ColumnConfig[], message: string) {
        const previous = columns;
        setColumns(next);
        try {
            await saveColumns(next);
        } catch (error) {
            setColumns(previous);
            console.error(message, error);
        }
    }
    function updateColumn(updated: ColumnConfig) {
        return commitColumns(columns.map((column) =>
            column.index === updated.index ? updated : column),
        "Failed to update column");
    }
    function deleteColumn(index: number) {
        return commitColumns(
            columns.filter((column) => column.index !== index),
            "Failed to delete column",
        );
    }
    async function deleteDocuments() {
        if (!selectedIds.length) return;
        const previousDocuments = documents;
        const previousCells = cells;
        const selected = new Set(selectedIds);
        const remaining = documents.filter(({ id }) => !selected.has(id));
        setDocuments(remaining);
        setCells((current) =>
            current.filter(({ document_id }) => !selected.has(document_id)));
        setUi({ selectedIds: [] });
        try {
            await updateTabularReview(reviewId, {
                document_ids: remaining.map(({ id }) => id),
                columns_config: columns,
            });
        } catch (error) {
            setDocuments(previousDocuments);
            setCells(previousCells);
            setUi({ selectedIds: [...selected] });
            console.error("Failed to delete tabular review documents", error);
        }
    }
    async function clearResults(documentIds: string[]) {
        if (!documentIds.length) return;
        const selected = new Set(documentIds);
        setCells((current) => current.map((cell) =>
            selected.has(cell.document_id)
                ? { ...cell, content: null, status: "pending" } : cell));
        setUi({ selectedIds: [] });
        await clearTabularCells(reviewId, documentIds);
    }
    function ownerOnly(action: string, run: () => void) {
        if (review?.is_owner === false) setUi({ ownerAction: action });
        else run();
    }
    async function saveDetails(values: { title: string; projectId?: string | null }) {
        if (!review || review.is_owner === false) {
            setUi({ ownerAction: "edit tabular review details" });
            return;
        }
        const updated = await updateTabularReview(reviewId, {
            title: values.title, project_id: values.projectId ?? null,
        });
        setReview(updated);
        if (!projectId && updated.project_id) {
            setUi({ modal: null });
            navigate(
                `/projects/${updated.project_id}/tabular-reviews/${reviewId}`);
        }
    }
    async function removeReview() {
        if (deleteStatus === "deleting") return;
        setUi({ deleteStatus: "deleting" });
        try {
            await deleteTabularReview(reviewId);
            navigate(projectId
                ? `/projects/${projectId}/tabular-reviews`
                : "/tabular-reviews");
        } catch (error) {
            setUi({ deleteStatus: "open" });
            console.error("Failed to delete tabular review", error);
        }
    }
    async function applyWorkflow({ workflow, variant }: WorkflowSelection) {
        if (!variant.columns_config?.length) return;
        const next = variant.columns_config.map((column, index) =>
            ({ ...column, index }));
        const previousColumns = columns;
        const previousCells = cells;
        setUi({ workflowStatus: "applying" });
        setColumns(next);
        setCells([]);
        try {
            await saveColumns(next, workflow.id);
            if (documents.length) {
                try {
                    await clearTabularCells(
                        reviewId, documents.map(({ id }) => id));
                } catch (error) {
                    console.error("Failed to clear old tabular cells", error);
                }
            }
            setUi({ workflowStatus: null });
        } catch (error) {
            setColumns(previousColumns);
            setCells(previousCells);
            setUi({ workflowStatus: "open" });
            console.error("Failed to apply workflow", error);
        }
    }

    const filteredDocuments = documents.filter(({ filename }) =>
        filename.toLowerCase().includes(search.toLowerCase()));
    const addedDocumentIds = new Set(documents.map(({ id }) => id));
    const selected = !!selectedIds.length;
    const hasTable = !!columns.length && !!documents.length;
    const reviewTitle = review?.title || "Untitled Review";
    const reviewListHref = projectId
        ? `/projects/${projectId}/tabular-reviews` : "/tabular-reviews";
    const projectCrumbs = project ? [
        "Projects",
        `${project.name}${project.cm_number ? ` (#${project.cm_number})` : ""}`,
    ] : [];
    const modalCrumbs = [...projectCrumbs, "Tabular Reviews", reviewTitle];
    const expandedDocument = expandedCell &&
        documents.find(({ id }) => id === expandedCell.document_id);
    const expandedColumn = expandedCell &&
        columns.find(({ index }) => index === expandedCell.column_index);
    const breadcrumbs: PageHeaderBreadcrumb[] = [
        ...(projectId ? [{
            label: "Projects", onClick: () => navigate("/projects"),
        }, {
            ...(loading
                ? { loading: true, skeletonClassName: "w-32" }
                : { label: project?.name ?? "" }),
            onClick: () => navigate(reviewListHref),
            title: "Back to project",
        }] : [{
            label: "Tabular Reviews",
            onClick: () => navigate(reviewListHref),
            title: "Back to Tabular Reviews",
        }]),
        loading
            ? { loading: true, skeletonClassName: "w-40" }
            : { label: reviewTitle },
    ];
    const menuItems = [
        { label: "History", onSelect: () => setUi({ historyOpen: true }) },
        { label: "Edit details",
            onSelect: () => ownerOnly(
                "edit tabular review details",
                () => setUi({ modal: "details" })),
        },
        { label: "Apply workflow",
            onSelect: () => ownerOnly(
                "apply a workflow",
                () => setUi({ workflowStatus: "open" })),
        },
        { label: "Export", disabled: !hasTable,
            onSelect: () => void exportTabularReview(reviewId).then(
                ({ blob, filename }) => downloadBlob(
                    blob,
                    filename ?? `${review?.title || "Tabular Review"}.xlsx`,
                )),
        },
        { label: "Clear results", disabled: !documents.length,
            onSelect: () => void clearResults(
                documents.map(({ id }) => id)),
        },
        { label: "Delete",
            onSelect: () => ownerOnly(
                "delete this tabular review",
                () => setUi({ deleteStatus: "open" })),
        },
    ];
    const headerActions: PageHeaderAction[] = [
        { type: "custom", render: <ResearchViews workspace={async () => {
            const { research_file_id } = await ensureTabularWorkspace(reviewId);
            navigate(`/sources?research_file=${encodeURIComponent(research_file_id)}`);
        }} chat={() => { if (!chatOpen) { setSidebarOpen(false); setChatId(null); } }} /> },
        { type: "search", value: search,
            onChange: (value) => setUi({ search: value }),
            placeholder: "Search documents\u2026",
        },
        ...(!projectId ? [{
            onClick: () => setUi({ modal: "people" }),
            disabled: loading, iconOnly: true,
            title: "People with access",
            icon: <Users className="h-4 w-4" />,
        } satisfies PageHeaderAction] : []),
        { type: "custom",
            render: <MoreActionsMenu items={menuItems} />,
        },
        {
            onClick: () => setUi({ modal: "documents" }),
            disabled: loading, title: "Add documents",
            icon: <Upload className="h-4 w-4" />,
            label: <span className="hidden sm:inline">Documents</span>,
        },
        {
            onClick: generating ? stopGeneration : generate, disabled: !hasTable,
            icon: generating
                ? <Square className="h-4 w-4" fill="currentColor" />
                : <Play className="h-4 w-4" />,
            label: <span className="hidden sm:inline">
                {generating ? "Stop" : "Run"}
            </span>,
        },
        {
            onClick: () => {
                if (!chatOpen) setSidebarOpen(false);
                setChatId(chatOpen ? undefined : null);
            },
            disabled: loading,
            title: chatOpen ? "Close chat" : "Open chat",
            icon: chatOpen
                ? <MessageSquareX className="h-4 w-4" />
                : <MessageSquare className="h-4 w-4" />,
            label: <span className="hidden sm:inline">Chat</span>,
        },
    ];

    return (
        <div className="flex h-full overflow-hidden">
            <div className="flex flex-1 flex-col overflow-hidden">
                <PageHeader shrink breadcrumbs={breadcrumbs} actions={headerActions} />
                {review && <ResearchChanges review={review} documents={documents} onChanged={refreshReview}
                    historyOpen={ui.historyOpen} onCloseHistory={() => setUi({ historyOpen: false })} />}
                <div className="flex flex-1 overflow-hidden">
                    <div className={`flex flex-1 flex-col overflow-hidden ${
                        chatOpen ? "max-md:hidden" : ""
                    }`}>
                        <TableToolbar actions={
                            <div className="flex items-center gap-1.5">
                                {loading ? (
                                    <div className="h-8 w-24 rounded-md bg-gray-100" />
                                ) : (
                                    <ActionMenu
                                        label="Selected document actions"
                                        items={[
                                            { label: "Clear results",
                                                disabled: !selected,
                                                onSelect: () => void clearResults(
                                                    selectedIds),
                                            },
                                            { label: "Delete",
                                                disabled: !selected,
                                                onSelect: deleteDocuments,
                                            },
                                        ]}
                                        className={`w-24 ${
                                            selected ? "" : "invisible"
                                        }`}
                                        triggerClassName="h-8 w-24 items-center justify-center rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-800 hover:bg-gray-100"
                                    >
                                        Actions
                                        <span aria-hidden="true">&#9662;</span>
                                    </ActionMenu>
                                )}
                                {!loading && (
                                    <Button variant="outline"
                                        className="h-8 py-0" onClick={() =>
                                        setUi({ columnModal: null })}>
                                        <Plus className="h-3.5 w-3.5" />
                                        Add Columns
                                    </Button>
                                )}
                                {selected && <ResearchSelectionLabels prepare={async () => {
                                    const { research_file_id } = await ensureTabularWorkspace(reviewId);
                                    const file = await getResearchFile(research_file_id);
                                    const selected = new Set(selectedIds), resources = new Set(documents
                                        .filter(({ id }) => selected.has(id)).map(({ resource }) => resource));
                                    return { file, selection: { target: "sources", sourceIds: Object.values(file.state.sources)
                                        .filter(({ reference }) => resources.has(researchSourceKey(reference)) ||
                                            reference.kind === "document" && selected.has(reference.id)).map(({ id }) => id) } };
                                }} />}
                            </div>
                        } />
                        <div
                            className="relative flex flex-1 overflow-hidden"
                            onDragOver={(event) => {
                                if (!Array.from(event.dataTransfer.types)
                                    .includes("Files"))
                                    return;
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "copy";
                                setUi({ dragOver: true });
                            }}
                            onDragLeave={(event) => {
                                if (!event.currentTarget.contains(
                                    event.relatedTarget as Node))
                                    setUi({ dragOver: false });
                            }}
                            onDrop={(event) => {
                                if (!Array.from(event.dataTransfer.types)
                                    .includes("Files"))
                                    return;
                                event.preventDefault();
                                event.stopPropagation();
                                setUi({ dragOver: false });
                                void dropFiles(Array.from(event.dataTransfer.files));
                            }}
                        >
                            <TRTable
                                loading={loading} columns={columns}
                                documents={filteredDocuments} cells={cells}
                                highlightedCell={highlightedCell}
                                savingColumnsConfig={false}
                                selectedDocIds={selectedIds}
                                uploadingFilenames={uploading}
                                dragOverFiles={dragOver}
                                onSelectionChange={(selectedIds) =>
                                    setUi({ selectedIds })}
                                onExpand={expandCell}
                                onCitationClick={openCitation}
                                onEditColumn={(columnModal) =>
                                    setUi({ columnModal })}
                            />
                        </div>
                    </div>
                    {chatOpen && (
                        <TRChatPanel
                            reviewId={reviewId} chatId={chatId ?? null}
                            initialMessage={typeof location.state?.tableIntent === "string" ? location.state.tableIntent : undefined}
                            onInitialMessageSent={() => navigate(`${location.pathname}${location.search}`, { replace: true, state: null })}
                            onUpdated={() => void refreshReview().catch(() => undefined)}
                            searchMessageId={searchParams.get("message")}
                            onCitationClick={(colIdx, rowIdx) => {
                                setUi({
                                    search: "",
                                    highlightedCell: { colIdx, rowIdx },
                                });
                                setTimeout(() =>
                                    setUi({ highlightedCell: null }), 3000);
                            }}
                            onClose={() => setChatId(undefined)}
                            onChatIdChange={setChatId}
                        />
                    )}
                </div>
            </div>
            {expandedCell && expandedDocument && expandedColumn && (
                <TRSidePanel
                    key={JSON.stringify(cellView)} cell={expandedCell}
                    document={expandedDocument} column={expandedColumn}
                    onClose={() => setUi({ cellView: null })}
                    onRegenerate={generating ? undefined : () => regenerateCell(
                        expandedCell.document_id, expandedCell.column_index)}
                    displayDocument={expandedCitation !== undefined}
                    citation={expandedCitation}
                />
            )}
            <AddColumnModal
                open={columnModal !== undefined} existingCount={columns.length}
                editingColumn={columnModal ?? undefined}
                onClose={() => setUi({ columnModal: undefined })}
                onAdd={addColumns} onSave={updateColumn}
                onDelete={columnModal
                    ? () => deleteColumn(columnModal.index)
                    : undefined}
            />
            <AddDocumentsModal
                open={modal === "documents"}
                onClose={() => setUi({ modal: null })}
                onSelect={addDocuments} projectId={projectId}
                breadcrumb={[...modalCrumbs, "Add Documents"]}
                documents={projectId
                    ? (project?.documents ?? []).filter(
                        ({ id }) => !addedDocumentIds.has(id))
                    : undefined}
                showTabs={!projectId}
                accept={projectId
                    ? ".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt"
                    : undefined}
            />
            <TabularReviewDetailsModal
                open={modal === "details"} review={review} projects={projects}
                canEdit={review?.is_owner !== false}
                lockProject={Boolean(projectId)}
                onClose={() => setUi({ modal: null })}
                onSave={saveDetails}
            />
            <PeopleModal
                open={modal === "people"}
                onClose={() => setUi({ modal: null })}
                resource={review} fetchPeople={getTabularReviewPeople}
                currentUserEmail={user?.email ?? null}
                breadcrumb={["Tabular Reviews", reviewTitle, "People"]}
                onSharedWithChange={review?.is_owner === false
                    ? undefined
                    : async (shared_with) => setReview(
                        await updateTabularReview(reviewId, { shared_with }))}
            />
            <WorkflowPickerModal
                open={workflowStatus !== null} onSelect={applyWorkflow}
                onClose={() => {
                    if (workflowStatus !== "applying")
                        setUi({ workflowStatus: null });
                }}
                execution="tabular"
                breadcrumbs={[...modalCrumbs, "Add workflow"]}
                selecting={workflowStatus === "applying"}
                closeOnSelect={false}
                disabledWorkflow={({ variant }) =>
                    !variant.columns_config?.length}
            />
            <ConfirmPopup
                open={deleteStatus !== null} title="Delete tabular review?"
                message="This will permanently delete the tabular review and its generated cells."
                confirmLabel="Delete" cancelLabel="Cancel"
                confirmStatus={deleteStatus === "deleting" ? "loading" : "idle"}
                onCancel={() => {
                    if (deleteStatus !== "deleting")
                        setUi({ deleteStatus: null });
                }}
                onConfirm={() => void removeReview()}
            />
            <OwnerOnlyPopup
                open={!!ownerAction} action={ownerAction ?? undefined}
                onClose={() => setUi({ ownerAction: null })}
            />
            <ApiKeyMissingPopup
                open={missingProvider !== null} provider={missingProvider}
                onClose={() => setUi({ missingProvider: null })}
            />
        </div>
    );
}
