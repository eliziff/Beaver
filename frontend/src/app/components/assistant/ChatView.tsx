import { safeAssistantUrl } from "@/app/lib/safeAssistantUrl";
import { useLocation, useNavigate } from "react-router-dom";
import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
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
import type { WorkflowRunEvent, Message } from "@/app/lib/api/chat";
import type { Citation, DocumentCitation } from "@/app/lib/citations";
import type {
  Document,
  EditAnnotation,
  EditResolveError,
  EditResolveStart,
  EditResolved,
  LibraryKind,
} from "@/app/lib/api/documents";
import { workflowDocumentTab, workflowMessage,
    type AssistantWorkflowLaunch, type WorkflowSelection } from "../workflows/workflowRoutes";
import {
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

import {
    type ReadSubagentPanel,
} from "./ReadSubagentDock";
import { ReadSubagentTabs, type ReadSubagentGroup } from "./ReadSubagentTabs";
import { useAssistantPreferences } from "./assistantPreferences";
import { ChatResearchSave } from "./ChatResearchSave";
import { ChatFindingActions } from "./ChatFindingActions";
import type { ResearchSelection } from "@/app/lib/researchFiles";
import { SourcesWorkspace, useSourcesWorkspace } from "../legal/SourcesWorkspace";
import type { AssistantIntent } from "./assistantIntent";
import { InitialDockPanel } from "./InitialDockPanel";
interface Props {
    initialDraft?: import("@/app/lib/api/chat").ChatDraft | null;
    chatId?: string | null;
    researchFileId?: string | null;
    researchSelection?: ResearchSelection | null;
    ready?: boolean;
    initialIntent?: AssistantIntent;
    onIntentSent?: () => void;
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
    searchMessageId?: string | null;
    onUseAnswer?: (messageId: string) => Promise<void>;
}
export interface ChatViewHandle {
    attachDocument: (document: Document) => void;
    closeDocument: (documentId: string) => void;
    openDocument: (document: Document) => void;
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
export function legalCitationTab(
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
export const ChatView = forwardRef<ChatViewHandle, Props>(function ChatView(props, ref) {
    const latest = props.session.messages.findLast((message) => message.role === "assistant");
    const refreshKey = props.session.run || !latest?.contentFinal ? null : latest.id;
    return <SourcesWorkspace fileId={props.researchFileId} projectId={props.projectId}
        selection={props.researchSelection} refreshKey={refreshKey}>
        <ChatViewContent {...props} ref={ref} />
    </SourcesWorkspace>;
});
const ChatViewContent = forwardRef<ChatViewHandle, Props>(function ChatViewContent(
    {
        chatId,
        researchFileId,
        ready = true, initialIntent, onIntentSent,
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
        initialDraft,
        initialModel,
        initialReasoningEffort,
        editModeLabels,
        projectFiles,
        projectFileActions,
        initialDocuments,
        initialWorkflow,
        sendDisabled, searchMessageId, onUseAnswer,
    },
    ref,
) {
    const { messages } = session;
    const location = useLocation(), navigate = useNavigate();
    const [{ readSubagents }] = useAssistantPreferences();
    const dockEnabled = features?.dock ?? true;
    const contextToolsEnabled = features?.contextTools ?? true;
    const researchSaveEnabled = features?.researchSave ?? true;
    const [tabs, setTabs] = useState<AssistantSidePanelTab[]>([]);
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
    const { file: activeResearchFile, selection: researchSelection, loading: researchLoading, accept: acceptResearchFile } = useSourcesWorkspace();
    const [workflowInitialId, setWorkflowInitialId] = useState(
        initialWorkflow?.workflow.id,
    );
    const [libraryKind, setLibraryKind] = useState<LibraryKind>("files");
    const [workflowDocuments, setWorkflowDocuments] = useState<WorkflowDocument[]>(
        initialDocuments ?? [],
    );
    const previousReaderId = useRef<string | undefined>(undefined);
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
        if (citation.kind === "document") {
            return upsertTab(documentCitationTab(citation));
        }
        // The reader opens at the chip's own pinpoint; the provider's page is
        // the fallback for sources the reader cannot render.
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
    const hasResearchSources = !!researchFileId || messages.some((message) => message.role === "assistant" &&
        (message.citations.some((citation) => citation.kind !== "tabular") || message.activities.some(({ citations }) =>
            citations?.some((citation) => citation.kind !== "tabular"))));
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
        initialDocuments.forEach((document) => {
            conversationRef.current?.addDoc(document);
            if (!initialWorkflow) openDocument({ documentId: document.id, filename: document.filename,
                versionId: document.current_version_id ?? null, versionNumber: null });
        });
    }, [initialDocuments, initialWorkflow, openDocument]);
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
        const contextualMessage = activeResearchFile ? { ...message,
            research_file_id: activeResearchFile.document.id, research_selection: researchSelection } : message;
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
    const latestReaderId = readSubagents.showDock ? session.readers.at(-1)?.id : undefined;
    useEffect(() => {
        if (latestReaderId && latestReaderId !== previousReaderId.current) {
            setActiveAgentSlot(latestReaderId.match(/:(\d+)$/u)?.[1] ?? latestReaderId);
            setActiveDockTab("agents");
            setDockExpanded(true);
            previousReaderId.current = latestReaderId;
        }
    }, [latestReaderId, setDockExpanded]);
    const openReadSubagentPanel = (panel: AssistantReaderRun) => {
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
                    researchFileId={researchFileId}
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
        session.readers.forEach((panel, index) => {
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
            onRun={(message, document) => {
                if (session.run) throw new Error("Wait for the current response to finish, then try again.");
                openDocument({ documentId: document.id, filename: document.filename,
                    versionId: document.current_version_id ?? null, versionNumber: null });
                void handleChat(message);
            }}
            projectId={projectId ?? undefined}
            researchFileId={researchFileId} researchRefreshKey={researchRefreshKey} onOpenSource={upsertTab} />;
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
            readerExpansion: Boolean(tabs.length) && (tabs.find((tab) => tab.id === activeTabId) ?? tabs[0])?.kind !== "legal",
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
        <div className="flex min-h-9 shrink-0 items-center justify-end gap-2 px-4 pe-12">
            {chatId && researchSaveEnabled && hasResearchSources &&
                <ChatResearchSave chatId={chatId} projectId={projectId}
                    question={messages.findLast((message) => message.role === "user")?.content} />}
            {onProjectClick ? <button
                type="button"
                onClick={onProjectClick}
                aria-label={projectName ? "Change project: " + projectName : "Add chat to project"}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800"
            >
                <FolderSvgIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{projectName ?? "Add to project"}</span>
            </button> : null}
        </div>
    ) : undefined;
    const intent = initialIntent ?? (layout === "page" ? location.state?.assistantIntent as AssistantIntent | undefined : undefined);
    const submittedIntent = useRef<string | null>(null);
    useEffect(() => {
        if (!ready || researchLoading || session.run || !intent?.text || !intent.id || submittedIntent.current === intent.id ||
            researchFileId && activeResearchFile?.document.id !== researchFileId) return;
        let active = true;
        queueMicrotask(() => {
            if (!active || submittedIntent.current === intent.id) return;
            submittedIntent.current = intent.id;
            if (onIntentSent) onIntentSent();
            else navigate(`${location.pathname}${location.search}`, { replace: true, state: { ...location.state, assistantIntent: undefined } });
            void submitMessage({ role: "user", content: intent.text });
        });
        return () => { active = false; };
    }, [ready, researchLoading, session.run, intent, researchFileId, activeResearchFile, onIntentSent, navigate, location, submitMessage]);
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
        messageActions={activeResearchFile && chatId ? (messageId) => <ChatFindingActions
            file={activeResearchFile} chatId={chatId} messageId={messageId} onFiled={acceptResearchFile}
            onUseAnswer={onUseAnswer && messageId === session.messages.findLast(({ role }) => role === "assistant")?.id
                ? () => onUseAnswer(messageId) : undefined} /> : undefined}
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
        initialDraft={initialDraft}
        initialModel={initialModel}
        initialReasoningEffort={initialReasoningEffort}
        editModeLabels={editModeLabels}
        sendDisabled={sendDisabled}
        searchMessageId={searchMessageId}
    />;
});
