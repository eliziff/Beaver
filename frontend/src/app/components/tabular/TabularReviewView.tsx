import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { BookOpen, MessageSquare, MessageSquareX, Play, Square, Upload, X } from "lucide-react";
import {
  clearTabularCells,
  deleteTabularReview,
  getTabularReview,
  getTabularReviewPeople,
  regenerateTabularCell,
  exportTabularReview,
  stopTabularGeneration,
  startTabularGeneration,
  updateTabularReview,
  proposeColumnLabels,
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



import { assistantIntent, type AssistantIntent } from "../assistant/assistantIntent";
import { errorMessage } from "@/app/lib/utils";
import { MoreActionsMenu } from "../shared/MoreActionsMenu";
import { ResearchSelectionLabels } from "../shared/ResearchSelectionLabels";
import { ResearchChanges } from "../legal/ResearchChanges";
import { SourcesWorkspace, useSourcesWorkspace } from "../legal/SourcesWorkspace";
import { ResearchCitationContent } from "../legal/ResearchCitationViewer";
import type { ResearchSelection, ResearchSourceReference } from "@/app/lib/researchFiles";
import { AssistantDock } from "../assistant/AssistantDock";
import { ResearchWorkspaceHost } from "../legal/ResearchWorkspaceHost";
import { PageHeader, type PageHeaderAction, type PageHeaderBreadcrumb } from "../shared/PageHeader";
import { AddDocumentsModal } from "../modals/AddDocumentsModal";
import { PeopleModal } from "../modals/PeopleModal";
import { ApiKeyMissingPopup } from "../popups/ApiKeyMissingPopup";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { OwnerOnlyPopup } from "../popups/OwnerOnlyPopup";
import { Button } from "../ui/button";
import { WorkflowPickerModal } from "../workflows/WorkflowPickerModal";
import type { WorkflowSelection } from "../workflows/workflowRoutes";
import { AddColumnModal } from "./AddColumnModal";
import type { Citation } from "@/app/lib/citations";
import { citedSourceReference } from "@/app/lib/groundedAnswers";
import { TabularReviewDetailsModal } from "./TabularReviewDetailsModal";
import { TRChatPanel } from "./TRChatPanel";
import { TRSidePanel } from "./TRSidePanel";
import { TRTable } from "./TRTable";

interface Props { reviewId: string; projectId?: string }
type Modal = "documents" | "details" | "people" | null;
type CellView = { cellId: string };
type DockTab = "chat" | "sources" | "reading" | null;
const cellKey = (documentId: string, columnIndex: number) => `${documentId}:${columnIndex}`;
const pendingCell = (documentId: string, columnIndex: number): TabularCell => ({
    id: `new-${documentId}-${columnIndex}`, document_id: documentId,
    column_index: columnIndex, content: null, status: "pending",
});

export function TRView(props: Props) {
    return <SourcesWorkspace key={props.reviewId} projectId={props.projectId}><TRViewContent {...props} /></SourcesWorkspace>;
}
function TRViewContent({ reviewId, projectId }: Props) {
    const workspace = useSourcesWorkspace();
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
        dockTab: (initialChat === null ? null : "chat") as DockTab,
        columnRun: null as { columnIndex: number; total: number; queue: string[] } | null,
    }));
    const setUi = useCallback((patch: Partial<typeof ui>) =>
        setUiState((current) => ({ ...current, ...patch })), []);
    useEffect(() => {
        setUi({ chatId: initialChat === "new" ? null : initialChat ?? undefined,
            ...(initialChat === null ? {} : { dockTab: "chat" as const }) });
    }, [initialChat, setUi]);
    const {
        loading, generating, columnModal, modal, workflowStatus, deleteStatus,
        ownerAction, cellView, selectedIds, search, dragOver, uploading, chatId,
        highlightedCell, missingProvider, columnRun, dockTab,
    } = ui;
    const columns = review?.columns_config ?? [];
    const workspaceId = review?.scope_config?.research_file_id;
    useEffect(() => { if (workspaceId) void workspace.open(workspaceId).catch(() => undefined); }, [workspaceId, workspace.open]);
    const project = projectId ? projects.find(({ id }) => id === projectId) ?? null : null;
    const chatOpen = chatId !== undefined;
    const [reading, setReading] = useState<{ citation: Citation; reference?: ResearchSourceReference } | null>(null);
    const expandedCell = cells.find(({ id }) => id === cellView?.cellId);
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
    // The reader opens as a dock tab beside the table, not a modal over it.
    const openCitation = useCallback((cell: TabularCell, citation: Citation) => {
        const receipt = cell.content?.evidence.find(({ span_text }) => span_text &&
            citation.quotes?.some(({ quote }) => quote === span_text));
        setReading({ citation, reference: receipt ? citedSourceReference(receipt) : undefined });
        setUi({ dockTab: "reading", cellView: null });
    }, [setUi]);

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
        await refreshReview();
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
    function patchCell(documentId: string, columnIndex: number, patch: Partial<TabularCell>) {
        setCells((current) => current.map((cell) => cell.document_id === documentId &&
            cell.column_index === columnIndex ? { ...cell, ...patch } : cell));
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
            await regenerateTabularCell(reviewId, documentId, columnIndex, { model, reasoningEffort });
        } catch (error) {
            console.error("Regeneration failed", error);
            patchCell(documentId, columnIndex, { status: "error" });
            setUi({ generating: false });
        }
    }
    // The API only regenerates one cell per request and refuses new work while
    // the review is running, so a column rerun queues its rows and sends the
    // next one each time the poll reports the review idle.
    function rerunColumn({ index }: ColumnConfig) {
        if (generating || columnRun || modelUnavailable()) return;
        const queue = documents.map(({ id }) => id);
        if (queue.length) setUi({ columnRun: { columnIndex: index, total: queue.length, queue } });
    }
    const advanceColumnRun = useEffectEvent(() => {
        if (!columnRun) return;
        const [documentId, ...queue] = columnRun.queue;
        setUi({ columnRun: queue.length ? { ...columnRun, queue } : null });
        if (documentId) void regenerateCell(documentId, columnRun.columnIndex);
    });
    useEffect(() => {
        if (!generating && columnRun) advanceColumnRun();
    }, [generating, columnRun]);
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
        setUi({ columnRun: null });
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
        const start = columns.reduce((max, column) => Math.max(max, column.index), -1) + 1;
        const added = incoming.map((column, index) => ({ ...column, index: start + index }));
        const next = [...columns, ...added];
        setColumns(next);
        setCells((current) => {
            const existing = new Set(current.map((cell) =>
                cellKey(cell.document_id, cell.column_index)));
            return [...current, ...documents.flatMap((document) => added
                .filter(({ index }) => !existing.has(cellKey(document.id, index)))
                .map(({ index }) => pendingCell(document.id, index)))];
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
        return commitColumns(columns.map((column) => column.index === updated.index ? updated : column),
            "Failed to update column");
    }
    function deleteColumn(index: number) {
        return commitColumns(columns.filter((column) => column.index !== index), "Failed to delete column");
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
    async function clearResults(documentIds: string[], columnIndex?: number) {
        if (!documentIds.length) return;
        const selected = new Set(documentIds);
        setCells((current) => current.map((cell) =>
            selected.has(cell.document_id) && (columnIndex === undefined || cell.column_index === columnIndex)
                ? { ...cell, content: null, status: "pending" } : cell));
        if (columnIndex === undefined) setUi({ selectedIds: [] });
        await clearTabularCells(reviewId, documentIds, columnIndex);
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
    const [discussion, setDiscussion] = useState<{ columnIndex: number; rowId?: string; intent?: AssistantIntent } | null>(null);
    const [interopError, setInteropError] = useState("");
    const rowSelection = (rows: TabularDocument[]): ResearchSelection => ({ target: "sources", members: rows.flatMap(({ selection }) =>
        selection?.members ?? selection?.sourceIds?.map((sourceId) => ({ sourceId,
            ...(selection.target === "passages" ? { evidenceIds: selection.evidenceIds ?? [] } : {}) })) ?? []) });
    const scopedRows = selected ? filteredDocuments.filter(({ id }) => selectedIds.includes(id)) : filteredDocuments;
    const discussedRows = discussion?.rowId ? scopedRows.filter(({ id }) => id === discussion.rowId) : scopedRows;
    const chatSelection = (rows: TabularDocument[]): ResearchSelection => ({ ...rowSelection(rows),
      findingRefs: rows.flatMap(({ id }) => cells.filter((cell) => cell.document_id === id &&
        (!discussion || cell.column_index === discussion.columnIndex) && cell.status === "done" && cell.content)
        .map((cell) => ({ kind: "cell" as const, reviewId, rowId: id, columnIndex: cell.column_index }))) });
    const selectedScopeKey = JSON.stringify(chatSelection(discussedRows));
    useEffect(() => {
        if (workspaceId && workspace.file?.document.id === workspaceId)
            workspace.setSelection(JSON.parse(selectedScopeKey) as ResearchSelection);
    }, [workspaceId, workspace.file?.document.id, workspace.setSelection, selectedScopeKey]);
    async function prepareRows() {
        const file = await workspace.ensure({ tableId: reviewId });
        const data = await getTabularReview(reviewId);
        setReview(data.review); setCells(data.cells); setDocuments(data.documents);
        const ids = new Set(scopedRows.map(({ id }) => id));
        const rows = data.documents.filter(({ id }) => ids.has(id));
        const selection = chatSelection(discussion?.rowId ? rows.filter(({ id }) => id === discussion.rowId) : rows);
        workspace.setSelection(selection);
        return { file, selection, rows };
    }
    const prepareChatWorkspace = useEffectEvent(() => { void prepareRows().catch(() => undefined); });
    useEffect(() => {
        if (chatOpen && review && !workspaceId) prepareChatWorkspace();
    }, [chatOpen, !!review, workspaceId]);
    async function openChat(focus?: { columnIndex: number; rowId?: string; text?: string }) {
        setInteropError("");
        try { await prepareRows(); } catch (reason) { setInteropError(errorMessage(reason, "Could not open research")); return; }
        setDiscussion(focus ? { ...focus, intent: focus.text ? assistantIntent(focus.text) : undefined } : null);
        setUi({ cellView: null });
        setSidebarOpen(false);
        setUi({ dockTab: "chat" });
        if (!chatOpen) setChatId(null);
    }
    async function openSources() {
        await prepareRows();
        setUi({ dockTab: "sources" });
    }
    function closeDock() {
        setUi({ dockTab: null });
        setReading(null);
        setChatId(undefined);
    }
    function closeReading() {
        setReading(null);
        setUi({ dockTab: chatOpen ? "chat" : null });
    }
    async function labelsFromColumn(column: ColumnConfig) {
        if (column.format !== "tag" && column.format !== "yes_no") return openChat({ columnIndex: column.index,
          text: `Propose a small source-label hierarchy from the selected ${column.name} results. Reuse the existing classifications where appropriate, explain ambiguous mappings, and submit a proposal for review rather than applying it.` });
        setInteropError("");
        try { const { file } = await prepareRows();
          workspace.accept(await proposeColumnLabels(file.document.id, reviewId, column.index, scopedRows.map(({ id }) => id)));
          setUi({ dockTab: "sources" });
        } catch (reason) { setInteropError(errorMessage(reason, "Could not propose labels")); }
    }
    const rowMembers = rowSelection(documents).members ?? [];
    const workspaceSources = Object.values(workspace.file?.state.sources ?? {})
        .filter(({ id }) => !rowMembers.some((member) => member.sourceId === id))
        .map(({ id, reference }) => ({ id, title: reference.title ?? reference.citation ?? id }));
    async function addSources(sourceIds: string[]) {
        await updateTabularReview(reviewId, { research_selection: { target: "sources",
            members: [...rowMembers, ...sourceIds.map((sourceId) => ({ sourceId }))] } });
        await refreshReview();
    }
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
    const finishedCells = cells.filter(({ status }) => status === "done" || status === "error").length;
    const progress = columnRun
        ? { done: columnRun.total - columnRun.queue.length - (generating ? 1 : 0), total: columnRun.total }
        : { done: finishedCells, total: cells.length };
    const menuItems = [
        { label: "History", onSelect: () => setUi({ historyOpen: true }) },
        ...(!projectId ? [{ label: "People", disabled: loading, onSelect: () => setUi({ modal: "people" as Modal }) }] : []),
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
        { label: "Export XLSX", disabled: !hasTable,
            onSelect: () => void exportTabularReview(reviewId).then(
                ({ blob, filename }) => downloadBlob(
                    blob,
                    filename ?? `${review?.title || "Tabular Review"}.xlsx`,
                )),
        },
        { label: "Clear results", disabled: !documents.length || generating,
            onSelect: () => void clearResults(
                documents.map(({ id }) => id)),
        },
        { label: "Delete",
            onSelect: () => ownerOnly(
                "delete this tabular review",
                () => setUi({ deleteStatus: "open" })),
        },
    ];
    const headerActions: (PageHeaderAction | false)[] = [
        { type: "search", value: search,
            onChange: (value) => setUi({ search: value }),
            placeholder: "Search documents\u2026",
        },
        {
            onClick: () => setUi({ modal: "documents" }),
            disabled: loading, title: "Add documents",
            icon: <Upload className="h-4 w-4" />,
            label: "Docs",
        },
        {
            onClick: () => setUi({ columnModal: null }),
            disabled: loading, title: "Add columns",
            label: "+ Column",
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
                if (dockTab === "chat") closeDock();
                else void openChat();
            },
            disabled: loading,
            title: dockTab === "chat" ? "Close chat" : "Open chat",
            icon: dockTab === "chat"
                ? <MessageSquareX className="h-4 w-4" />
                : <MessageSquare className="h-4 w-4" />,
            label: <span className="hidden sm:inline">Chat</span>,
        },
        { type: "custom",
            render: <MoreActionsMenu items={menuItems} />,
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
                        dockTab ? "max-md:hidden" : ""
                    }`}>
                        {!loading && (selected || generating) && <div className="mx-4 mb-2 flex min-h-8 flex-wrap items-center gap-2 md:mx-6">
                            {selected && <>
                                <span className="text-sm font-medium text-gray-800">{selectedIds.length} selected</span>
                                <ResearchSelectionLabels prepare={async () => (await prepareRows()).rows
                                    .flatMap(({ selection }) => selection ? [selection] : [])} />
                                <Button variant="outline" size="compact" disabled={generating}
                                    onClick={() => void clearResults(selectedIds)}>Clear results</Button>
                                <Button variant="outline" size="compact" onClick={() => void deleteDocuments()}>Remove</Button>
                            </>}
                            {generating && <div role="progressbar" aria-label="Run progress" aria-valuemin={0}
                                aria-valuemax={progress.total} aria-valuenow={progress.done}
                                className="ml-auto flex items-center gap-2 text-xs tabular-nums text-gray-600">
                                <span className="h-1.5 w-32 overflow-hidden rounded-full bg-gray-200">
                                    <span className="block h-full rounded-full bg-gray-800 transition-[width]"
                                        style={{ width: `${progress.total ? Math.round(100 * progress.done / progress.total) : 0}%` }} />
                                </span>
                                {progress.done}/{progress.total}
                            </div>}
                        </div>}
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
                                running={generating || !!columnRun}
                                onSelectionChange={(selectedIds) =>
                                    setUi({ selectedIds })}
                                onExpand={expandCell}
                                onCitationClick={openCitation}
                                onEditColumn={(columnModal) =>
                                    setUi({ columnModal })}
                                onRerunColumn={rerunColumn}
                                onClearColumn={({ index }) => void clearResults(documents.map(({ id }) => id), index)}
                                onDeleteColumn={({ index }) => void deleteColumn(index)}
                                onAddColumns={() => setUi({ columnModal: null })}
                                onAddDocuments={() => setUi({ modal: "documents" })}
                                onColumnLabels={(column) => void labelsFromColumn(column)}
                                onColumnDiscuss={(column) => void openChat({ columnIndex: column.index })}
                            />
                        </div>
                    </div>
                    {dockTab && <AssistantDock expanded showCollapsedButton={false}
                        defaultWidth={400} minWidth={320} maxWidth="40%"
                        activeTabId={dockTab} onActivateTab={(id) => {
                            setUi({ dockTab: id as DockTab });
                            if (id === "chat" && !chatOpen) void openChat();
                        }}
                        onExpandedChange={(open) => { if (!open) closeDock(); }}
                        tabs={[
                            { id: "chat", label: "Chat", icon: <MessageSquare aria-hidden className="size-4" />, content: chatOpen && <TRChatPanel
                                reviewId={reviewId} chatId={chatId ?? null}
                                workspaceReady={!!workspaceId && workspace.file?.document.id === workspaceId && JSON.stringify(workspace.selection) === selectedScopeKey}
                                initialIntent={discussion?.intent ?? location.state?.assistantIntent}
                                scopeLabel={discussion ? `${columns.find(({ index }) => index === discussion.columnIndex)?.name ?? "Results"} · ${discussedRows.length} row${discussedRows.length === 1 ? "" : "s"}` : undefined}
                                onClearScope={() => setDiscussion(null)}
                                onIntentSent={() => { setDiscussion((current) => current ? { ...current, intent: undefined } : null);
                                  navigate(`${location.pathname}${location.search}`, { replace: true, state: null }); }}
                                onUpdated={() => void Promise.all([refreshReview(), workspace.refresh()]).catch(() => undefined)}
                                searchMessageId={searchParams.get("message")}
                                onCitationClick={(colIdx, rowIdx) => {
                                    setUi({ search: "", highlightedCell: { colIdx, rowIdx } });
                                    setTimeout(() => setUi({ highlightedCell: null }), 3000);
                                }}
                                onChatIdChange={setChatId}
                            /> },
                            { id: "sources", label: "Sources", content: <ResearchWorkspaceHost embedded open
                                projectId={projectId} onOpenChange={() => undefined} /> },
                            ...(reading ? [{ id: "reading", readerExpansion: true, icon: <BookOpen aria-hidden className="size-4" />,
                                label: reading.citation.kind === "document" ? reading.citation.filename
                                    : reading.reference?.title ?? reading.reference?.citation ?? "Source",
                                actions: <Button variant="ghost" size="compact" onClick={closeReading} aria-label="Close source">
                                    <X className="size-3.5" aria-hidden /></Button>,
                                content: <ResearchCitationContent {...reading} onOpenResearch={() => setUi({ dockTab: "sources" })} /> }] : []),
                        ]} />}
                </div>
            </div>
            {interopError && <p role="alert" className="px-4 py-2 text-sm text-red-700">{interopError}</p>}
            {expandedCell && expandedDocument && expandedColumn && (
                <TRSidePanel
                    key={JSON.stringify(cellView)} cell={expandedCell}
                    document={expandedDocument} column={expandedColumn}
                    onDiscuss={() => void openChat({ rowId: expandedCell.document_id, columnIndex: expandedCell.column_index })}
                    onCitation={(citation) => openCitation(expandedCell, citation)}
                    onClose={() => setUi({ cellView: null })}
                    onRegenerate={() => regenerateCell(
                        expandedCell.document_id, expandedCell.column_index)}
                    running={generating || !!columnRun}
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
                sources={workspaceSources}
                onAddSources={addSources}
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
