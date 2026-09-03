import {
    forwardRef,
    lazy,
    Suspense,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import {
    ArrowDown,
    CircleStop,
    Loader2,
} from "lucide-react";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { workflowRunKey } from "./WorkflowRun";
import { ChatInput } from "./ChatInput";
import type { ChatInputHandle } from "./ChatInput";
import { AskInputPopup } from "./AskInputPopup";
import type {
    AssistantDocumentTab,
    AssistantSidePanelTab,
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
import { WarningPopup } from "@/app/components/popups/WarningPopup";
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
const loadAssistantSidePanel = () => import("./AssistantSidePanel");
const preloadAssistantSidePanel = () =>
    void loadAssistantSidePanel().catch(() => undefined);
const LazyAssistantSidePanel = lazy(async () => ({
    default: (await loadAssistantSidePanel()).AssistantSidePanel,
}));
const InitialDockPanel = lazy(() => import("./InitialDockPanel")
    .then(({ InitialDockPanel }) => ({ default: InitialDockPanel })));
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
const DEFAULT_ASSISTANT_BOTTOM_PADDING = 116;
const LATEST_ASSISTANT_MIN_HEIGHT = "calc(100dvh - 16rem)";
const READ_SUBAGENT_PANELS_KEY = "beaver.readSubagentPanels.v1";
const READ_SUBAGENT_RUN_LIMIT = 9;

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
    const { messages, rejectedTurn } = session;
    const isResponseLoading = session.run !== null;
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
    const [hiddenAskInputKey, setHiddenAskInputKey] = useState<string | null>(
        null,
    );
    const previousReadSubagentCount = useRef(0);
    const editFocusKey = useRef(0);
    const [editState, setEditState] = useState(() => ({
        docIds: new Set<string>(),
        editIds: new Set<string>(),
        statuses: {} as Record<string, "accepted" | "rejected">,
    }));
    useEffect(() => {
        if (typeof window.requestIdleCallback === "function") {
            const idle = window.requestIdleCallback(preloadAssistantSidePanel,
                { timeout: 1_500 });
            return () => window.cancelIdleCallback(idle);
        }
        const timeout = window.setTimeout(preloadAssistantSidePanel, 500);
        return () => window.clearTimeout(timeout);
    }, []);
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
            preloadAssistantSidePanel();
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
    const lastUserIndex = messages.findLastIndex(({ role }) => role === "user");
    const lastAssistantIndex = messages.findLastIndex(({ role }) => role === "assistant");
    const workflowRuns = messages.flatMap((message) => message.role === "assistant" ? message.workflowRuns : []);
    const latestAssistant = messages[lastAssistantIndex];
    const responseInProgress = session.run?.status === "running" &&
        !(latestAssistant?.role === "assistant" && latestAssistant.contentFinal);
    const responseAnnouncement = responseInProgress
        ? "Assistant is responding."
        : latestAssistant?.role === "assistant" &&
            !latestAssistant.error &&
            !latestAssistant.turnStatus
          ? "Response ready."
          : "";
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
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const chatInputRef = useRef<ChatInputHandle | null>(null);
    const attachedInitialDocuments = useRef(false);
    const startedInitialWorkflow = useRef(false);
    const [showScrollButton, setShowScrollButton] = useState(false);
    useEffect(() => {
        if (attachedInitialDocuments.current || !initialDocuments?.length) return;
        attachedInitialDocuments.current = true;
        initialDocuments.forEach((document) => chatInputRef.current?.addDoc(document));
    }, [initialDocuments]);
    useEffect(() => {
        if (startedInitialWorkflow.current || !initialWorkflow) return;
        startedInitialWorkflow.current = true;
        const tab = initialWorkflow.documentTab;
        const hasDocument = tab === "templates"
            ? initialDocuments?.some(({ library_kind }) => library_kind === "template")
            : !!initialDocuments?.length;
        chatInputRef.current?.startWorkflowDocumentSelection(
            initialWorkflow.workflow, undefined,
            { initialDocumentTab: tab, openDocumentPicker: !hasDocument },
        );
    }, [initialDocuments, initialWorkflow]);
    const updateScrollButton = useCallback(() => {
        const c = messagesContainerRef.current;
        if (!c) return;
        const isScrolledUp = c.scrollHeight - c.scrollTop - c.clientHeight > 10;
        setShowScrollButton(isScrolledUp && c.scrollHeight > c.clientHeight);
    }, []);
    useEffect(() => {
        const c = messagesContainerRef.current;
        if (!c) return;
        c.addEventListener("scroll", updateScrollButton);
        const content = messagesEndRef.current?.parentElement;
        const observer = new ResizeObserver(updateScrollButton);
        if (content) observer.observe(content);
        const frame = requestAnimationFrame(updateScrollButton);
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            c.removeEventListener("scroll", updateScrollButton);
        };
    }, [updateScrollButton]);
    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    };
    const scrollLatestUserToTop = useCallback(() => {
        const container = messagesContainerRef.current;
        const element = latestUserMessageRef.current;
        if (!container || !element) return;
        container.scrollTo({
            top: element.offsetTop - 24,
            behavior: "auto",
        });
    }, []);
    useLayoutEffect(() => {
        if (messages.length > 0) scrollLatestUserToTop();
    }, [chatId, messages.length, scrollLatestUserToTop]);
    const activeInput =
        session.pendingInput?.key !== hiddenAskInputKey
            ? session.pendingInput
            : null;
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
        for (const document of documents) chatInputRef.current?.addDoc({
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
        chatInputRef.current?.startWorkflowDocumentSelection(
            workflowMessage(selection), undefined,
            { initialDocumentTab: tab, openDocumentPicker: tab === "templates" },
        );
    };
    useImperativeHandle(
        ref,
        () => ({
            attachDocument: (document) =>
                chatInputRef.current?.addDoc(document),
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
            <Suspense fallback={<div role="status"
                className="grid h-full place-items-center text-gray-500">
                <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />
                <span className="sr-only">Loading source</span>
            </div>}>
                <LazyAssistantSidePanel
                    embedded={embedded}
                    tabs={visibleTabs}
                    activeTabId={activeTabId}
                    projectId={projectId}
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
            </Suspense>
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
            workflowDocuments={workflowDocuments}
            onLibraryKindChange={setLibraryKind}
            onOpenInChat={(documents) => {
                for (const document of documents) chatInputRef.current?.addDoc(document);
            }}
            onOpenWorkflows={(documents) => openWorkflows(undefined, documents)}
            onWorkflowSelect={selectWorkflow} initialWorkflowId={workflowInitialId}
            projectId={projectId ?? undefined} onResearchFileChange={setActiveResearchFile}
            onOpenSource={upsertTab} />;
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
    return (
        <div className="h-full w-full flex relative">
            <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="sr-only"
            >
                {responseAnnouncement}
            </div>
            <div className="flex min-w-0 flex-col h-full flex-1 relative">
                {(onProjectClick || (chatId && researchSaveEnabled)) && (
                    <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-gray-100 px-4 pe-12">
                        {onProjectClick ? <button
                            type="button"
                            onClick={onProjectClick}
                            aria-label={
                                projectName
                                    ? `Change project: ${projectName}`
                                    : "Add chat to project"
                            }
                            className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                        >
                            <FolderSvgIcon className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">
                                {projectName ?? "Add to project"}
                            </span>
                        </button> : <span />}
                        {chatId && researchSaveEnabled && <ChatResearchSave
                            chatId={chatId} projectId={projectId} />}
                    </div>
                )}
                <div
                    ref={messagesContainerRef}
                    className="flex-1 w-full overflow-y-auto"
                    style={{ scrollbarGutter: "stable both-edges" }}
                >
                    <div
                        className={`w-full min-h-full flex flex-col relative ${layout === "panel" ? "px-4 pt-4" : "px-6 pt-6 md:px-8 md:pt-8"} ${assistantSideGutterVisible ? "ms-auto me-0 max-w-5xl md:max-lg:pe-2" : "mx-auto max-w-4xl"}`}
                        style={{
                            paddingBottom: DEFAULT_ASSISTANT_BOTTOM_PADDING,
                        }}
                    >
                        <div className="space-y-6 md:space-y-8">
                            {messages.map((msg, i) => (
                                <div
                                    key={msg.id}
                                    ref={
                                        i === lastUserIndex
                                            ? latestUserMessageRef
                                            : null
                                    }
                                >
                                    {msg.role === "user" ? (
                                        <UserMessage
                                            content={msg.content ?? ""}
                                            files={msg.files}
                                            workflow={msg.workflow}
                                        />
                                    ) : (
                                        <AssistantMessage
                                            message={msg}
                                            isStreaming={
                                                i === messages.length - 1 &&
                                                responseInProgress &&
                                                !msg.contentFinal
                                            }
                                            onCitationClick={openCitation}
                                            citationTitle={citationTitle}
                                            onWorkflowRunClick={openWorkflowRun}
                                            onReaderClick={
                                                readSubagents.showDock
                                                    ? (readerId) => {
                                                          const reader = session.readers.find(
                                                              (candidate) => candidate.id === readerId,
                                                          );
                                                          if (reader) openReadSubagentPanel(reader);
                                                      }
                                                    : undefined
                                            }
                                            minHeight={
                                                msg.turnStatus
                                                    ? "0px"
                                                    : i === lastAssistantIndex
                                                    ? layout === "panel"
                                                        ? "min(50vh, 28rem)"
                                                        : LATEST_ASSISTANT_MIN_HEIGHT
                                                    : "0px"
                                            }
                                            onEditViewClick={openEditor}
                                            onOpenDocument={openDocument}
                                            onEditResolveStart={
                                                handleEditResolveStart
                                            }
                                            onEditResolved={handleEditResolved}
                                            onEditError={handleEditError}
                                            isDocReloading={(docId) =>
                                                editState.docIds.has(docId)
                                            }
                                            isEditReloading={(editId) =>
                                                editState.editIds.has(editId)
                                            }
                                            resolvedEditStatuses={editState.statuses}
                                        />
                                    )}
                                    {msg.role === "assistant" && msg.turnStatus && (
                                        <div
                                            role="status"
                                            className={`mt-2 flex items-center gap-1.5 text-xs ${
                                                msg.turnStatus === "interrupted"
                                                    ? "text-red-700"
                                                    : "text-gray-500"
                                            }`}
                                        >
                                            <CircleStop className="size-3.5" aria-hidden="true" />
                                            <span>
                                                {msg.turnStatus === "cancelled"
                                                    ? "Response stopped"
                                                    : "Response interrupted"}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            ))}
                            <div ref={messagesEndRef} />
                        </div>
                    </div>
                </div>
                <div className="absolute bottom-3 left-0 right-0 w-full z-30">
                    <div
                        className={`relative w-full px-4 md:px-6 ${assistantSideGutterVisible ? "ms-auto me-0 max-w-5xl md:max-lg:pe-2" : "mx-auto max-w-4xl"}`}
                    >
                        {showScrollButton && !activeInput && (
                            <button
                                type="button"
                                aria-label="Scroll to latest message"
                                onClick={scrollToBottom}
                                className="absolute bottom-[calc(100%+1rem)] left-1/2 z-20 -translate-x-1/2 cursor-pointer rounded-full border border-gray-300 bg-white p-2 text-gray-500 hover:bg-gray-100"
                            >
                                <ArrowDown className="h-6 w-6" />
                            </button>
                        )}
                        {activeInput && (
                            <div
                                data-ask-input-dock
                                className="absolute inset-x-4 bottom-[calc(100%+0.5rem)] md:inset-x-6"
                            >
                                <AskInputPopup
                                    key={activeInput.key}
                                    event={activeInput.event}
                                    onSubmit={(response, content, files) => {
                                        setHiddenAskInputKey(activeInput.key);
                                        void handleChat(
                                            { role: "user", content, files },
                                            { askInputsResponse: response },
                                        );
                                    }}
                                    onDismiss={() => {
                                        setHiddenAskInputKey(activeInput.key);
                                        cancel();
                                    }}
                                />
                            </div>
                        )}
                        <ChatInput
                            ref={chatInputRef}
                            onSubmit={submitMessage}
                            promptHistory={messages.flatMap((message) =>
                                message.role === "user" &&
                                (message.content ?? "").trim()
                                    ? [message.content ?? ""]
                                    : [],
                            )}
                            onCancel={() => {
                                if (activeInput)
                                    setHiddenAskInputKey(activeInput.key);
                                cancel();
                            }}
                            isLoading={isResponseLoading || !!activeInput}
                            disabled={sendDisabled}
                            contextUsage={
                                session.contextUsage || session.compaction === "running"
                                    ? {
                                          usedTokens: session.contextUsage?.usedTokens ?? 0,
                                          windowTokens: session.contextUsage?.windowTokens ?? 1,
                                          compacting: session.compaction === "running",
                                      }
                                    : undefined
                            }
                            showContextTools={contextToolsEnabled}
                            rows={layout === "panel" ? 2 : 1}
                            onOpenWorkflows={dockEnabled ? openWorkflows : undefined}
                            projectName={projectName ?? undefined}
                            projectCmNumber={projectCmNumber}
                            initialModel={initialModel}
                            initialReasoningEffort={initialReasoningEffort}
                            editModeLabels={editModeLabels}
                            restoreDraft={
                                rejectedTurn?.options?.askInputsResponse
                                    ? null
                                    : rejectedTurn?.message
                            }
                        />
                    </div>
                </div>
            </div>
            {dockEnabled && (dockActivated || dockOpen) && (
                <AssistantDock
                    tabs={dockTabs}
                    activeTabId={resolvedDockTab}
                    onActivateTab={setActiveDockTab}
                    expanded={dockOpen}
                    onExpandedChange={setDockExpanded}
                />
            )}
            <WarningPopup
                open={!!rejectedTurn}
                title={
                    rejectedTurn?.options?.askInputsResponse
                        ? "Inputs not sent"
                        : "Response interrupted"
                }
                message={
                    rejectedTurn?.detail ?? (rejectedTurn?.options?.askInputsResponse
                        ? "Your selections were kept. Retry them after reviewing the latest response."
                        : "Retry the original request, or dismiss this notice to edit the restored draft.")
                }
                onClose={() => onRejectedTurnRestored?.()}
                primaryAction={
                    onRetryRejectedTurn && rejectedTurn?.retryable !== false
                        ? {
                              label: "Retry",
                              onClick: () => {
                                  if (
                                      !rejectedTurn?.options
                                          ?.askInputsResponse
                                  ) {
                                      chatInputRef.current?.clearDraft();
                                  }
                                  onRetryRejectedTurn();
                              },
                          }
                        : undefined
                }
            />
        </div>
    );
});
