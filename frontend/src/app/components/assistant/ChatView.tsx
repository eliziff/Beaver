import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { workflowRunKey } from "./WorkflowRun";
import type { ChatInputHandle } from "./ChatInput";
import { ConversationView } from "./ConversationView";
import {
    AssistantSidePanel,
    type AssistantDocumentTab,
    type AssistantSidePanelTab,
} from "./AssistantSidePanel";
import { AssistantDock, type AssistantDockTab } from "./AssistantDock";
import type { WorkflowDocument } from "../workflows/ContextualWorkflowPicker";
import type {
    WorkflowRunEvent,
    Citation,
    Document,
    DocumentCitation,
    EditAnnotation,
    EditResolveError,
    EditResolveStart,
    EditResolved,
    Message,
} from "../shared/types";
import { workflowDocumentTab, workflowMessage,
    type AssistantWorkflowLaunch, type WorkflowSelection } from "../workflows/workflowRoutes";
import {
    safeAssistantUrl,
    type AssistantReaderRun,
    type AssistantSessionState,
    type AssistantTurnOptions,
} from "@/app/lib/assistantSession";
import { invalidateDocumentFile } from "@/app/hooks/useDocumentFile";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import {
    legalSourceLocatorFromUrl,
    normalizeLegalSourceLocator,
} from "@/app/components/legal/LegalSourceViewer";
import type { LibraryKind } from "@/app/lib/beaverApi";
import {
    type ReadSubagentPanel,
} from "./ReadSubagentDock";
import { ReadSubagentTabs, type ReadSubagentGroup } from "./ReadSubagentTabs";
import { useAssistantPreferences } from "./assistantPreferences";
import { ChatResearchSave } from "./ChatResearchSave";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { InitialDockPanel } from "./InitialDockPanel";
interface Props {
    chatId?: string | null;
    session: AssistantSessionState;
    handleChat: (
        message: Message,
        opts?: AssistantTurnOptions,
    ) => Promise<string | null>;
    cancel: () => void;
    onRejectedTurnRestored?: () => void;
    onRetryRejectedTurn?: () => void;
    projectName?: string | null;
    onProjectClick?: () => void;
    projectId?: string;
    projectCmNumber?: string | null;
    useDisplayedDocumentContext?: boolean;
    onActiveDocumentChange?: (documentId: string | null) => void;
    layout?: "page" | "panel";
    features?: {
        contextTools?: boolean;
        dock?: boolean;
        researchSave?: boolean;
    };
    onCitationClick?: (citation: Citation) => boolean | void;
    citationTitle?: (citation: Citation) => string;
    initialModel?: string | null;
    initialReasoningEffort?: string | null;
    editModeLabels?: { manual: string; auto: string };
    projectFiles?: ReactNode;
    projectFileActions?: ReactNode;
    initialDocuments?: Document[];
    initialWorkflow?: AssistantWorkflowLaunch;
    sendDisabled?: boolean;
}
export interface ChatViewHandle {
    attachDocument: (document: Document) => void;
    closeDocument: (documentId: string) => void;
    openDocument: (document: Document) => void;
}
const READ_SUBAGENT_PANELS_KEY = "beaver.readSubagentPanels.v1";
const READ_SUBAGENT_RUN_LIMIT = 9;
const isLegalCitation = (citation: Citation) =>
    citation.kind === "a2aj" || citation.kind === "public_legal";

function readStoredSubagentPanelIds(storageKey: string): string[] {
    if (typeof window === "undefined") return [];
    try {
        const stored = JSON.parse(
            window.localStorage.getItem(storageKey) ?? "[]",
        ) as unknown;
        if (!Array.isArray(stored)) return [];
        return stored
            .filter((id): id is string => typeof id === "string" && id.length <= 512)
            .slice(-READ_SUBAGENT_RUN_LIMIT);
    } catch {
        return [];
    }
}
function without<T>(items: Set<T>, item: T) {
    if (!items.has(item)) return items;
    const next = new Set(items);
    next.delete(item);
    return next;
}
function isDocumentTab(
    tab: AssistantSidePanelTab,
): tab is AssistantDocumentTab {
    return "documentId" in tab;
}
type LegalTab = Extract<AssistantSidePanelTab, { kind: "legal" }>;
function legalCitationTab(
    citation: Citation,
    showQuotes: boolean,
): LegalTab | null {
    const quotes = showQuotes ? citation.quotes : undefined;
    if (citation.kind === "a2aj" && citation.citation) {
        return {
            kind: "legal",
            id: `legal:${citation.dataset ?? ""}:${citation.citation}`,
            citation: citation.citation,
            name: citation.name ?? null,
            dataset: citation.dataset ?? null,
            docType: "auto",
            language: "en",
            citationRef: citation.ref,
            quotes,
            initialLocator:
                normalizeLegalSourceLocator(citation.locator) ??
                legalSourceLocatorFromUrl(citation.url),
        };
    }
    if (citation.kind === "public_legal" && citation.provider === "journal") {
        return {
            kind: "legal",
            id: `legal:journal:${citation.identifier}`,
            provider: "journal",
            sourceId: citation.identifier,
            citation:
                citation.citation ?? citation.title ?? citation.identifier,
            name: citation.title ?? null,
            dataset: null,
            docType: "articles",
            language: "en",
            citationRef: citation.ref,
            quotes,
            initialLocator: citation.locator ?? null,
        };
    }
    return null;
}
function documentCitationTab(citation: DocumentCitation): AssistantDocumentTab {
    return {
        id: citation.document_id,
        documentId: citation.document_id,
        filename: citation.filename,
        versionId: citation.version_id ?? null,
        versionNumber: citation.version_number ?? null,
        kind: "citation",
        citation,
    };
}
export const ChatView = forwardRef<ChatViewHandle, Props>(function ChatView(
    {
        chatId,
        session,
        handleChat,
        cancel,
        onRejectedTurnRestored,
        onRetryRejectedTurn,
        projectName,
        onProjectClick,
        projectId,
        projectCmNumber,
        useDisplayedDocumentContext,
        onActiveDocumentChange,
        layout = "page",
        features,
        onCitationClick,
        citationTitle,
        initialModel,
        initialReasoningEffort,
        editModeLabels,
        projectFiles,
        projectFileActions,
        initialDocuments,
        initialWorkflow,
        sendDisabled,
    },
    ref,
) {
    const { messages } = session;
    const [{ readSubagents }] = useAssistantPreferences();
    const dockEnabled = features?.dock ?? true;
    const contextToolsEnabled = features?.contextTools ?? true;
    const researchSaveEnabled = features?.researchSave ?? true;
    const readSubagentPanelStorageKey = `${READ_SUBAGENT_PANELS_KEY}:${chatId ?? "new"}`;
    const [tabs, setTabs] = useState<AssistantSidePanelTab[]>([]);
    const [readSubagentPanelState, setReadSubagentPanels] = useState(() => ({
        key: readSubagentPanelStorageKey,
        ids: readStoredSubagentPanelIds(readSubagentPanelStorageKey),
    }));
    const [dockOpen, setDockOpen] = useState(!!initialWorkflow);
    const [dockActivated, setDockActivated] = useState(!!projectFiles || !!initialWorkflow);
    const setDockExpanded = useCallback((expanded: boolean) => {
        setDockOpen(expanded);
        if (expanded) setDockActivated(true);
    }, []);
    const [activeDockTab, setActiveDockTab] = useState(
        initialWorkflow ? "workflows" : projectFiles ? "project-files" : "sources",
    );
    const [activeAgentSlot, setActiveAgentSlot] = useState<string | null>(null);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [activeResearchFile, setActiveResearchFile] = useState<ResearchFile | null>(null);
    const [workflowInitialId, setWorkflowInitialId] = useState(
        initialWorkflow?.workflow.id,
    );
    const [libraryKind, setLibraryKind] = useState<LibraryKind>("files");
    const [workflowDocuments, setWorkflowDocuments] = useState<WorkflowDocument[]>(
        initialDocuments ?? [],
    );
    const previousReadSubagentCount = useRef(0);
    const editFocusKey = useRef(0);
    const [editState, setEditState] = useState(() => ({
        docIds: new Set<string>(),
        editIds: new Set<string>(),
        statuses: {} as Record<string, "accepted" | "rejected">,
    }));
    const closeAllTabs = useCallback(() => {
        setTabs([]);
        setActiveTabId(null);
    }, []);
    const closeTab = useCallback(
        (id: string) => {
            const next = tabs.filter((tab) => tab.id !== id);
            if (next.length === 0) {
                closeAllTabs();
                return;
            }
            if (activeTabId === id) {
                const index = tabs.findIndex((tab) => tab.id === id);
                setActiveTabId((next[index] ?? next[index - 1] ?? next[0]).id);
            }
            setTabs(next);
        },
        [activeTabId, closeAllTabs, tabs],
    );
    const upsertTab = useCallback(
        (tab: AssistantSidePanelTab, activateDock = true) => {
            setTabs((prev) => {
                const idx = prev.findIndex((current) =>
                    isDocumentTab(tab)
                        ? isDocumentTab(current) &&
                          current.documentId === tab.documentId
                        : current.kind === tab.kind && current.id === tab.id,
                );
                if (idx >= 0) {
                    const existing = prev[idx];
                    const copy = prev.slice();
                    copy[idx] =
                        isDocumentTab(tab) && isDocumentTab(existing)
                            ? {
                                  ...tab,
                                  id: existing.id,
                                  warning: existing.warning,
                                  initialScrollTop: existing.initialScrollTop,
                              }
                            : tab;
                    return copy;
                }
                return [...prev, tab];
            });
            setActiveTabId(tab.id);
            if (activateDock) setActiveDockTab("sources");
            setDockExpanded(true);
        },
        [setDockExpanded],
    );
    const openCitation = (citation: Citation) => {
        if (onCitationClick?.(citation)) return;
        if (citation.kind === "tabular") return;
        const exactProviderUrl = safeAssistantUrl(
            citation.kind !== "document" &&
            !(citation.kind === "public_legal" && citation.provider === "journal") &&
            "url" in citation &&
            citation.url?.includes("#")
                ? citation.url
                : null,
            { relative: false },
        );
        if (exactProviderUrl) {
            window.open(exactProviderUrl, "_blank", "noopener,noreferrer");
            return;
        }
        if (citation.kind === "document") {
            return upsertTab(documentCitationTab(citation));
        }
        const tab = legalCitationTab(citation, true);
        if (tab) upsertTab(tab);
        else if (citation.url) {
            const href = safeAssistantUrl(citation.url, { relative: false });
            if (href) window.open(href, "_blank", "noopener,noreferrer");
        }
    };
    const openEditor = (
        ann: EditAnnotation,
        filename: string,
        changeNumber?: number,
    ) => {
        upsertTab({
            kind: "edit",
            id: ann.document_id,
            documentId: ann.document_id,
            filename,
            versionId: ann.version_id ?? null,
            versionNumber: ann.version_number ?? null,
            edit: ann,
            focusKey: ++editFocusKey.current,
            changeNumber,
        });
    };
    const openDocument = useCallback(
        (args: {
            documentId: string;
            filename: string;
            versionId: string | null;
            versionNumber: number | null;
        }) => {
            upsertTab({
                kind: "document",
                id: args.documentId,
                documentId: args.documentId,
                filename: args.filename,
                versionId: args.versionId,
                versionNumber: args.versionNumber,
            });
        },
        [upsertTab],
    );
    const workflowRuns = messages.flatMap((message) => message.role === "assistant" ? message.workflowRuns : []);
    const latestAssistant = messages.findLast((message) => message.role === "assistant");
    const hasResearchSources = messages.some((message) => message.role === "assistant" &&
        (message.citations.some(isLegalCitation) || message.activities.some(({ citations }) =>
            citations?.some(isLegalCitation))));
    const researchRefreshKey = session.run || latestAssistant?.role !== "assistant" ||
        !latestAssistant.contentFinal ? null : latestAssistant.id;
    const latestWorkflowRun = (run: WorkflowRunEvent) =>
        workflowRuns.findLast((candidate) => workflowRunKey(candidate) === workflowRunKey(run)) ?? run;
    const openWorkflowRun = (run: WorkflowRunEvent) => {
        upsertTab({
            kind: "workflow-run",
            id: `workflow:${workflowRunKey(run)}`,
            run,
        });
    };
    const visibleTabs = tabs.map((tab) =>
        tab.kind === "workflow-run"
            ? { ...tab, run: latestWorkflowRun(tab.run) }
            : tab,
    );
    const handleEditResolveStart = (args: EditResolveStart) => {
        setEditState((state) => ({
            ...state,
            docIds: new Set(state.docIds).add(args.documentId),
            editIds: new Set(state.editIds).add(args.editId),
        }));
    };
    const handleEditResolved = (args: EditResolved) => {
        setEditState((state) => ({
            docIds: without(state.docIds, args.documentId),
            editIds: without(state.editIds, args.editId),
            statuses: { ...state.statuses, [args.editId]: args.status },
        }));
        setTabs((prev) =>
            prev.map((t) =>
                t.kind === "edit" && t.edit.edit_id === args.editId
                    ? {
                          ...t,
                          edit: { ...t.edit, status: args.status },
                      }
                    : t,
            ),
        );
        invalidateDocumentFile(args.documentId);
    };
    const patchTab = (
        tabId: string,
        patch: {
            warning?: string | null;
            initialScrollTop?: number | null;
        },
    ) => {
        setTabs((prev) => {
            const idx = prev.findIndex((t) => t.id === tabId);
            if (idx < 0) return prev;
            if (!isDocumentTab(prev[idx])) return prev;
            const copy = prev.slice();
            copy[idx] = { ...copy[idx], ...patch };
            return copy;
        });
    };
    const handleEditError = (args: EditResolveError) => {
        setTabs((prev) =>
            prev.map((t) =>
                isDocumentTab(t) && t.documentId === args.documentId
                    ? { ...t, warning: args.message }
                    : t,
            ),
        );
        setEditState((state) => ({
            ...state,
            docIds: without(state.docIds, args.documentId),
            editIds: without(state.editIds, args.editId),
        }));
    };
    const conversationRef = useRef<ChatInputHandle>(null);
    const attachedInitialDocuments = useRef(false);
    const startedInitialWorkflow = useRef(false);
    useEffect(() => {
        if (attachedInitialDocuments.current || !initialDocuments?.length) return;
        attachedInitialDocuments.current = true;
        initialDocuments.forEach((document) => conversationRef.current?.addDoc(document));
    }, [initialDocuments]);
    useEffect(() => {
        if (startedInitialWorkflow.current || !initialWorkflow) return;
        startedInitialWorkflow.current = true;
        const tab = initialWorkflow.documentTab;
        const hasDocument = tab === "templates"
            ? initialDocuments?.some(({ library_kind }) => library_kind === "template")
            : !!initialDocuments?.length;
        conversationRef.current?.startWorkflowDocumentSelection(
            initialWorkflow.workflow, undefined,
            { initialDocumentTab: tab, openDocumentPicker: !hasDocument },
        );
    }, [initialDocuments, initialWorkflow]);
    const activeDocument = tabs.find(
        (tab): tab is AssistantDocumentTab =>
            tab.id === activeTabId && isDocumentTab(tab),
    );
    useEffect(() => {
        onActiveDocumentChange?.(activeDocument?.documentId ?? null);
    }, [activeDocument?.documentId, onActiveDocumentChange]);
    const openWorkflows = (
        initialWorkflowId?: string,
        documents: WorkflowDocument[] = [],
    ) => {
        for (const document of documents) conversationRef.current?.addDoc({
            id: document.id, filename: document.filename,
            project_id: document.project_id ?? null,
            file_type: document.file_type ?? null,
            library_kind: document.library_kind,
            pdf_storage_path: null, size_bytes: null, page_count: null, created_at: null,
        });
        setWorkflowDocuments(documents);
        setWorkflowInitialId(initialWorkflowId);
        setActiveDockTab("workflows");
        setDockExpanded(true);
    };
    const selectWorkflow = (selection: WorkflowSelection) => {
        const tab = workflowDocumentTab(selection);
        conversationRef.current?.startWorkflowDocumentSelection(
            workflowMessage(selection), undefined,
            { initialDocumentTab: tab, openDocumentPicker: tab === "templates" },
        );
    };
    useImperativeHandle(
        ref,
        () => ({
            attachDocument: (document) =>
                conversationRef.current?.addDoc(document),
            closeDocument: closeTab,
            openDocument: (document) =>
                openDocument({
                    documentId: document.id,
                    filename: document.filename,
                    versionId: document.current_version_id ?? null,
                    versionNumber: document.active_version_number ?? null,
                }),
        }),
        [closeTab, openDocument],
    );
    const submitMessage = (message: Message) => {
        const contextualMessage = activeResearchFile && !message.files?.some(
            ({ document_id }) => document_id === activeResearchFile.document.id,
        ) ? { ...message, files: [...(message.files ?? []), {
            filename: activeResearchFile.document.filename,
            document_id: activeResearchFile.document.id,
        }] } : message;
        if (!activeDocument) {
            return handleChat(contextualMessage);
        }
        if (useDisplayedDocumentContext) {
            return handleChat(contextualMessage, {
                displayedDoc: {
                    documentId: activeDocument.documentId,
                },
            });
        }
        if (
            contextualMessage.files?.some(
                (file) => file.document_id === activeDocument.documentId,
            )
        )
            return handleChat(contextualMessage);
        return handleChat({
            ...contextualMessage,
            files: [
                ...(contextualMessage.files ?? []),
                {
                    filename: activeDocument.filename,
                    document_id: activeDocument.documentId,
                },
            ],
        });
    };
    const readSubagentPanelIds =
        readSubagentPanelState.key === readSubagentPanelStorageKey
            ? readSubagentPanelState.ids
            : readStoredSubagentPanelIds(readSubagentPanelStorageKey);
    const setReadSubagentPanelIds = useCallback(
        (update: string[] | ((current: string[]) => string[])) => {
            setReadSubagentPanels((current) => {
                const ids = current.key === readSubagentPanelStorageKey
                    ? current.ids
                    : readStoredSubagentPanelIds(readSubagentPanelStorageKey);
                return {
                    key: readSubagentPanelStorageKey,
                    ids: typeof update === "function" ? update(ids) : update,
                };
            });
        },
        [readSubagentPanelStorageKey],
    );
    useEffect(() => {
        try {
            window.localStorage.setItem(
                readSubagentPanelStorageKey,
                JSON.stringify(readSubagentPanelIds),
            );
        } catch {
            // The server-persisted terminal event remains the fallback.
        }
    }, [readSubagentPanelStorageKey, readSubagentPanelIds]);
    useEffect(() => {
        if (!readSubagents.showDock) return;
        setReadSubagentPanelIds((current) => {
            const next = [...current];
            for (const panel of session.readers) {
                if (
                    !next.includes(panel.id)
                ) {
                    next.push(panel.id);
                }
            }
            return next.slice(-READ_SUBAGENT_RUN_LIMIT);
        });
    }, [readSubagents.showDock, session.readers, setReadSubagentPanelIds]);
    const readSubagentPanels = useMemo(() => readSubagentPanelIds.flatMap((id) =>
        session.readers.find((reader) => reader.id === id) ?? []
    ), [readSubagentPanelIds, session.readers]);
    useEffect(() => {
        if (
            readSubagents.showDock &&
            readSubagentPanels.length > previousReadSubagentCount.current
        ) {
            const latest = readSubagentPanels.at(-1);
            if (latest) {
                const slot = latest.id.match(/:(\d+)$/u)?.[1] ?? latest.id;
                // A newly materialized reader is an external session event that intentionally opens its panel.
                setActiveAgentSlot(slot);
                setActiveDockTab("agents");
                setDockExpanded(true);
            }
        }
        previousReadSubagentCount.current = readSubagentPanels.length;
    }, [readSubagentPanels, readSubagents.showDock, setDockExpanded]);
    const openReadSubagentPanel = (panel: AssistantReaderRun) => {
        const withoutCurrent = readSubagentPanelIds.filter(
            (id) => id !== panel.id,
        );
        setReadSubagentPanelIds(
            [...withoutCurrent, panel.id].slice(-READ_SUBAGENT_RUN_LIMIT),
        );
        const slot = panel.id.match(/:(\d+)$/u)?.[1] ?? panel.id;
        setActiveAgentSlot(slot);
        setActiveDockTab("agents");
        setDockExpanded(true);
    };
    const assistantSideGutterVisible = dockEnabled && dockOpen;
    const readerPanel = (embedded = false) =>
        tabs.length ? (
            <AssistantSidePanel
                    embedded={embedded}
                    tabs={visibleTabs}
                    activeTabId={activeTabId}
                    projectId={projectId}
                    researchRefreshKey={researchRefreshKey}
                    onResearchFileChange={setActiveResearchFile}
                    onActivateTab={setActiveTabId}
                    onCloseTab={closeTab}
                    onCloseAll={closeAllTabs}
                    onOpenWorkflows={(documents) => openWorkflows(undefined, documents)}
                    isEditorReloading={(documentId) =>
                        editState.docIds.has(documentId)
                    }
                    isEditReloading={(editId) => editState.editIds.has(editId)}
                    onEditResolveStart={handleEditResolveStart}
                    onEditResolved={handleEditResolved}
                    onEditError={handleEditError}
                    onWarningDismiss={(tabId) => patchTab(tabId, { warning: null })}
                    onScrollChange={(tabId, initialScrollTop) =>
                        patchTab(tabId, { initialScrollTop })
                    }
                />
        ) : null;
    const groupedAgents = new Map<string, ReadSubagentPanel[]>();
    if (readSubagents.showDock) {
        readSubagentPanels.forEach((panel, index) => {
            const slot = panel.id.match(/:(\d+)$/u)?.[1] ?? String(index + 1);
            groupedAgents.set(slot, [...(groupedAgents.get(slot) ?? []), panel]);
        });
    }
    const agentGroups: ReadSubagentGroup[] = [...groupedAgents.entries()].map(
        ([slot, panels]) => ({ id: slot, label: `Agent ${slot}`, panels }),
    );
    const dockPanel = (tab: "library" | "workflows" | "sources") =>
        <InitialDockPanel tab={tab} libraryKind={libraryKind}
            active={dockOpen && activeDockTab === tab}
            workflowDocuments={workflowDocuments}
            onLibraryKindChange={setLibraryKind}
            onOpenInChat={(documents) => {
                for (const document of documents) conversationRef.current?.addDoc(document);
            }}
            onOpenWorkflows={(documents) => openWorkflows(undefined, documents)}
            onWorkflowSelect={selectWorkflow} initialWorkflowId={workflowInitialId}
            projectId={projectId ?? undefined} onResearchFileChange={setActiveResearchFile}
            researchRefreshKey={researchRefreshKey} onOpenSource={upsertTab} />;
    const dockTabs: AssistantDockTab[] = [
        ...(projectFiles ? [{
            id: "project-files",
            label: "Project files",
            actions: projectFileActions,
            content: projectFiles,
        }] : []),
        {
            id: "library",
            label: "Library",
            content: dockPanel("library"),
        },
        {
            id: "workflows",
            label: "Workflows",
            content: dockPanel("workflows"),
        },
        {
            id: "sources",
            label: "Sources",
            content: tabs.length ? readerPanel(true) : dockPanel("sources"),
        },
        {
            id: "agents",
            label: "Agents",
            content: (
                <ReadSubagentTabs
                    groups={agentGroups}
                    activeId={activeAgentSlot}
                    onActivate={setActiveAgentSlot}
                    onCitationClick={openCitation}
                />
            ),
        },
    ];
    const resolvedDockTab = dockTabs.some((tab) => tab.id === activeDockTab)
        ? activeDockTab
        : "sources";
    const header = (onProjectClick ||
        (chatId && researchSaveEnabled && hasResearchSources)) ? (
        <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-gray-100 px-4 pe-12">
            {onProjectClick ? <button
                type="button"
                onClick={onProjectClick}
                aria-label={projectName ? "Change project: " + projectName : "Add chat to project"}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800"
            >
                <FolderSvgIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{projectName ?? "Add to project"}</span>
            </button> : <span />}
            {chatId && researchSaveEnabled && hasResearchSources &&
                <ChatResearchSave chatId={chatId} projectId={projectId} />}
        </div>
    ) : undefined;
    const dock = dockEnabled && (dockActivated || dockOpen) ? (
        <AssistantDock
            tabs={dockTabs}
            activeTabId={resolvedDockTab}
            onActivateTab={setActiveDockTab}
            expanded={dockOpen}
            onExpandedChange={setDockExpanded}
        />
    ) : undefined;
    return <ConversationView
        ref={conversationRef}
        chatId={chatId}
        session={session}
        handleChat={handleChat}
        cancel={cancel}
        onSubmit={submitMessage}
        onRejectedTurnRestored={onRejectedTurnRestored}
        onRetryRejectedTurn={onRetryRejectedTurn}
        onCitationClick={openCitation}
        citationTitle={citationTitle}
        onWorkflowRunClick={openWorkflowRun}
        onReaderClick={readSubagents.showDock ? (readerId) => {
            const reader = session.readers.find((candidate) => candidate.id === readerId);
            if (reader) openReadSubagentPanel(reader);
        } : undefined}
        onEditViewClick={openEditor}
        onOpenDocument={openDocument}
        onEditResolveStart={handleEditResolveStart}
        onEditResolved={handleEditResolved}
        onEditError={handleEditError}
        isDocReloading={(documentId) => editState.docIds.has(documentId)}
        isEditReloading={(editId) => editState.editIds.has(editId)}
        resolvedEditStatuses={editState.statuses}
        layout={layout}
        gutterVisible={assistantSideGutterVisible}
        header={header}
        dock={dock}
        showContextTools={contextToolsEnabled}
        onOpenWorkflows={dockEnabled ? openWorkflows : undefined}
        projectName={projectName ?? undefined}
        projectCmNumber={projectCmNumber}
        initialModel={initialModel}
        initialReasoningEffort={initialReasoningEffort}
        editModeLabels={editModeLabels}
        sendDisabled={sendDisabled}
    />;
});
