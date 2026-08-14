import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import {
    ArrowDown,
    CircleStop,
} from "lucide-react";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { automationRunKey } from "./AutomationRun";
import { ChatInput } from "./ChatInput";
import type { ChatInputHandle } from "./ChatInput";
import { AskInputPopup } from "./AskInputPopup";
import {
    AssistantSidePanel,
    type AssistantDocumentTab,
    type AssistantSidePanelTab,
} from "./AssistantSidePanel";
import { AssistantDock, type AssistantDockTab } from "./AssistantDock";
import { AssistantWorkflowDock } from "./AssistantWorkflowDock";
import { DocumentAutomation, type DocumentAutomationTarget } from "@/app/components/documents/DocumentAutomation";
import type {
    AssistantEvent,
    CaseCitation,
    Citation,
    Document,
    DocumentCitation,
    EditAnnotation,
    EditResolveError,
    EditResolveStart,
    EditResolved,
    Message,
    Workflow,
} from "../shared/types";
import { invalidateDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import type { RejectedAssistantTurn } from "@/app/hooks/useAssistantChat";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import {
    legalSourceLocatorFromUrl,
    normalizeLegalSourceLocator,
    LegalSourceViewer,
} from "@/app/components/legal/LegalSourceViewer";
import { LegalLibraryPage } from "@/app/components/legal/LegalLibrary";
import {
    LibraryCollectionPage,
    LibraryWorkspaceProvider,
} from "@/app/components/library/LibraryWorkspace";
import type { LibraryKind } from "@/app/lib/beaverApi";
import {
    type ReadSubagentPanel,
    type ReadSubagentSource,
} from "./ReadSubagentDock";
import { ReadSubagentTabs, type ReadSubagentGroup } from "./ReadSubagentTabs";
import { useReadSubagentPreference } from "./readSubagentPreferences";
interface Props {
    chatId?: string | null;
    messages: Message[];
    isResponseLoading: boolean;
    handleChat: (
        message: Message,
        opts?: {
            displayedDoc?: { filename: string; documentId: string } | null;
            askInputsResponse?: Extract<
                AssistantEvent,
                { type: "ask_inputs_response" }
            >;
        },
    ) => Promise<string | null>;
    cancel: () => void;
    rejectedTurn?: RejectedAssistantTurn | null;
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
    };
    onCitationClick?: (citation: Citation) => boolean | void;
    citationTitle?: (citation: Citation) => string;
}
export interface ChatViewHandle {
    attachDocument: (document: Document) => void;
    closeDocument: (documentId: string) => void;
    openDocument: (document: Document) => void;
}
const MOBILE_BREAKPOINT_PX = 768;
const DEFAULT_ASSISTANT_BOTTOM_PADDING = 116;
const LATEST_ASSISTANT_MIN_HEIGHT = "calc(100dvh - 16rem)";
const READ_SUBAGENT_PANELS_KEY = "beaver.readSubagentPanels.v1";
const READ_SUBAGENT_RUN_LIMIT = 9;

function readStoredSubagentPanels(storageKey: string): ReadSubagentPanel[] {
    if (typeof window === "undefined") return [];
    try {
        const stored = JSON.parse(
            window.localStorage.getItem(storageKey) ?? "[]",
        ) as unknown;
        if (!Array.isArray(stored)) return [];
        return stored
            .filter(
                (panel): panel is ReadSubagentPanel =>
                    !!panel &&
                    typeof panel === "object" &&
                    (panel as ReadSubagentPanel).type === "subagent_run" &&
                    typeof (panel as ReadSubagentPanel).id === "string" &&
                    typeof (panel as ReadSubagentPanel).task === "string" &&
                    typeof (panel as ReadSubagentPanel).model === "string" &&
                    typeof (panel as ReadSubagentPanel).effort === "string" &&
                    ["running", "completed", "error"].includes(
                        (panel as ReadSubagentPanel).status,
                    ),
            )
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
        messages,
        isResponseLoading,
        handleChat,
        cancel,
        rejectedTurn,
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
    },
    ref,
) {
    const readSubagents = useReadSubagentPreference();
    const dockEnabled = features?.dock ?? true;
    const contextToolsEnabled = features?.contextTools ?? true;
    const latestContextUsage = messages
        .flatMap((message) => message.events ?? [])
        .findLast((event) => event.type === "context_usage");
    const latestCompaction = messages
        .flatMap((message) => message.events ?? [])
        .findLast((event) => event.type === "compaction");
    const readSubagentPanelStorageKey = `${READ_SUBAGENT_PANELS_KEY}:${chatId ?? "new"}`;
    const [tabs, setTabs] = useState<AssistantSidePanelTab[]>([]);
    const [readSubagentPanels, setReadSubagentPanels] = useState<
        ReadSubagentPanel[]
    >([]);
    const [readSubagentPanelLimitOpen, setReadSubagentPanelLimitOpen] =
        useState(false);
    const [dockOpen, setDockOpen] = useState(false);
    const [dockActivated, setDockActivated] = useState(false);
    const [activeDockTab, setActiveDockTab] = useState("sources");
    const [activeAgentSlot, setActiveAgentSlot] = useState<string | null>(null);
    const [agentInspectorOpen, setAgentInspectorOpen] = useState(false);
    const [agentInspectorTab, setAgentInspectorTab] = useState<
        Extract<AssistantSidePanelTab, { kind: "case" | "legal" }> | null
    >(null);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [workflowInitialId, setWorkflowInitialId] = useState<string>();
    const [libraryKind, setLibraryKind] = useState<LibraryKind>("files");
    const workflowSelectRef = useRef<(workflow: Workflow) => void>(() => {});
    const [automationDocument, setAutomationDocument] =
        useState<DocumentAutomationTarget | null>(null);
    const [hiddenAskInputKey, setHiddenAskInputKey] = useState<string | null>(
        null,
    );
    const [responseAnnouncement, setResponseAnnouncement] = useState("");
    const wasResponseLoadingRef = useRef(false);
    const dismissedReadSubagentIds = useRef(new Set<string>());
    const previousReadSubagentCount = useRef(0);
    const skipSubagentPanelPersist = useRef(true);
    const readSubagentPanelStorageKeyRef = useRef(
        readSubagentPanelStorageKey,
    );
    const readSubagentPanelsRef = useRef(readSubagentPanels);
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
            setDockOpen(true);
        },
        [],
    );
    const openCase = (
        citation:
            | CaseCitation
            | Extract<AssistantEvent, { type: "case_citation" }>,
        showQuotes = true,
    ) => {
        if (!citation.cluster_id || !chatId) return;
        const streamed = citation.type === "case_citation";
        upsertTab({
            kind: "case",
            id: `case:${citation.cluster_id}`,
            chatId,
            clusterId: citation.cluster_id,
            citationRef: streamed ? undefined : citation.ref,
            caseName: citation.case_name ?? null,
            citation: citation.citation ?? null,
            url: citation.url ?? null,
            dateFiled: citation.dateFiled ?? null,
            pdfUrl: citation.pdfUrl ?? null,
            quotes: !streamed && showQuotes ? citation.quotes : undefined,
            opinions: streamed ? citation.case?.opinions : undefined,
        });
    };
    const openCitation = (citation: Citation) => {
        if (onCitationClick?.(citation)) return;
        if (citation.kind === "tabular") return;
        const exactProviderUrl =
            citation.kind !== "document" &&
            !(citation.kind === "public_legal" && citation.provider === "journal") &&
            "url" in citation &&
            citation.url?.includes("#")
                ? citation.url
                : null;
        if (exactProviderUrl) {
            window.open(exactProviderUrl, "_blank", "noopener,noreferrer");
            return;
        }
        if (citation.kind === "case") return openCase(citation);
        if (citation.kind === "document" || !citation.kind) {
            return upsertTab(documentCitationTab(citation));
        }
        if (citation.kind === "a2aj" || citation.kind === "public_legal") {
            const tab = legalCitationTab(citation, true);
            if (tab) upsertTab(tab);
            else if ("url" in citation && citation.url)
                window.open(citation.url, "_blank", "noopener,noreferrer");
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
    let lastUserIndex = -1;
    let lastAssistantIndex = -1;
    let rawActiveInput: {
        key: string;
        event: Extract<AssistantEvent, { type: "ask_inputs" }>;
    } | null = null;
    const automationRuns = new Map<
        string,
        Extract<AssistantEvent, { type: "automation_run" }>
    >();
    for (const [messageIndex, message] of messages.entries()) {
        if (message.role === "user") {
            lastUserIndex = messageIndex;
            rawActiveInput = null;
        } else if (message.role === "assistant") {
            lastAssistantIndex = messageIndex;
        }
        for (const [eventIndex, event] of (message.events ?? []).entries()) {
            if (event.type === "ask_inputs") {
                rawActiveInput = {
                    key: `${chatId ?? "new"}:${messageIndex}-${eventIndex}`,
                    event,
                };
            } else if (event.type === "ask_inputs_response") {
                rawActiveInput = null;
            } else if (event.type === "automation_run") {
                const key = automationRunKey(event);
                automationRuns.set(key, {
                    ...automationRuns.get(key),
                    ...event,
                });
            }
        }
    }
    useEffect(() => {
        readSubagentPanelsRef.current = readSubagentPanels;
    }, [readSubagentPanels]);
    useEffect(() => {
        const wasLoading = wasResponseLoadingRef.current;
        if (isResponseLoading) {
            setResponseAnnouncement("Assistant is responding.");
        } else if (wasLoading) {
            const latestAssistant = messages[lastAssistantIndex];
            setResponseAnnouncement(
                latestAssistant?.error || latestAssistant?.turnStatus
                    ? ""
                    : "Response ready.",
            );
        }
        wasResponseLoadingRef.current = isResponseLoading;
    }, [isResponseLoading, lastAssistantIndex, messages]);
    const mergedAutomationRun = (
        run: Extract<AssistantEvent, { type: "automation_run" }>,
    ) => ({ ...run, ...automationRuns.get(automationRunKey(run)) });
    const openAutomation = (
        run: Extract<AssistantEvent, { type: "automation_run" }>,
    ) => {
        const merged = mergedAutomationRun(run);
        upsertTab({
            kind: "automation",
            id: `automation:${automationRunKey(merged)}`,
            run: merged,
        });
    };
    const visibleTabs = tabs.map((tab) =>
        tab.kind === "automation"
            ? { ...tab, run: mergedAutomationRun(tab.run) }
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
        invalidateDocxBytes(args.documentId);
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
    const [showScrollButton, setShowScrollButton] = useState(false);
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
    useEffect(() => {
        if (dockOpen) setDockActivated(true);
    }, [dockOpen]);
    useEffect(() => {
        if (dockOpen && window.innerWidth < MOBILE_BREAKPOINT_PX) {
            document.body.style.overflow = "hidden";
        } else {
            document.body.style.overflow = "unset";
        }
        return () => {
            document.body.style.overflow = "unset";
        };
    }, [dockOpen]);
    const activeInput =
        rawActiveInput?.key !== hiddenAskInputKey
            ? rawActiveInput
            : null;
    const activeDocument = tabs.find(
        (tab): tab is AssistantDocumentTab =>
            tab.id === activeTabId && isDocumentTab(tab),
    );
    useEffect(() => {
        onActiveDocumentChange?.(activeDocument?.documentId ?? null);
    }, [activeDocument?.documentId, onActiveDocumentChange]);
    const openAutomations = (document?: Document) => {
        const target = document
            ? {
                  id: document.id,
                  filename: document.filename,
                  file_type: document.file_type,
                  library_kind: document.library_kind,
                  project_id: document.project_id,
              }
            : activeDocument
              ? {
                    id: activeDocument.documentId,
                    filename: activeDocument.filename,
                    project_id: projectId ?? null,
                }
              : null;
        setAutomationDocument(target);
        setActiveDockTab("automations");
        setDockOpen(true);
    };
    const openWorkflows = (
        onSelect: (workflow: Workflow) => void,
        initialWorkflowId?: string,
    ) => {
        workflowSelectRef.current = onSelect;
        setWorkflowInitialId(initialWorkflowId);
        setActiveDockTab("workflows");
        setDockOpen(true);
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
        if (!activeDocument) {
            return handleChat(message);
        }
        if (useDisplayedDocumentContext) {
            return handleChat(message, {
                displayedDoc: {
                    filename: activeDocument.filename,
                    documentId: activeDocument.documentId,
                },
            });
        }
        if (
            message.files?.some(
                (file) => file.document_id === activeDocument.documentId,
            )
        )
            return handleChat(message);
        return handleChat({
            ...message,
            files: [
                ...(message.files ?? []),
                {
                    filename: activeDocument.filename,
                    document_id: activeDocument.documentId,
                },
            ],
        });
    };
    const openReadSubagentSource = (source: ReadSubagentSource) => {
        const initialLocator =
            normalizeLegalSourceLocator(source.locator) ??
            legalSourceLocatorFromUrl(source.url);
        const openSourceTab = (
            tab: Extract<AssistantSidePanelTab, { kind: "case" | "legal" }>,
        ) => {
            const inspectBesideAgent = activeDockTab === "agents";
            if (inspectBesideAgent) {
                setAgentInspectorTab(tab);
                setAgentInspectorOpen(true);
                setDockOpen(true);
                return;
            }
            upsertTab(tab);
        };
        if (source.clusterId && chatId) {
            openSourceTab({
                kind: "case",
                id: `case:${source.clusterId}`,
                chatId,
                clusterId: source.clusterId,
                caseName: source.name,
                citation: source.citation,
                url: source.url,
                dateFiled: null,
                pdfUrl: null,
                initialLocator,
                quotes: source.quote
                    ? [{
                        quote: source.quote,
                        opinionId: null,
                        type: null,
                        author: null,
                    }]
                    : undefined,
            });
            return;
        }
        if (
            source.citation &&
            (source.provider === "a2aj" ||
                source.provider === "citator" ||
                source.jurisdiction.toLocaleUpperCase().startsWith("CA"))
        ) {
            openSourceTab({
                kind: "legal",
                id: `legal:${source.dataset}:${source.citation}`,
                citation: source.citation,
                name: source.name,
                dataset: source.dataset || null,
                docType: "cases",
                language: "en",
                quotes: source.quote ? [{ quote: source.quote }] : undefined,
                initialLocator,
            });
            return;
        }
        if (source.url) window.open(source.url, "_blank", "noopener,noreferrer");
    };
    useEffect(() => {
        skipSubagentPanelPersist.current = true;
        dismissedReadSubagentIds.current.clear();
        const restored = readStoredSubagentPanels(
            readSubagentPanelStorageKey,
        );
        const movedFromNewChat =
            readSubagentPanelStorageKeyRef.current.endsWith(":new") &&
            !readSubagentPanelStorageKey.endsWith(":new");
        const next = movedFromNewChat
            ? [
                  ...new Map(
                      [...restored, ...readSubagentPanelsRef.current].map(
                          (panel) => [panel.id, panel],
                      ),
                  ).values(),
              ].slice(-READ_SUBAGENT_RUN_LIMIT)
            : restored;
        setReadSubagentPanels(next);
        if (movedFromNewChat) {
            try {
                window.localStorage.setItem(
                    readSubagentPanelStorageKey,
                    JSON.stringify(next),
                );
            } catch {
                // The server-persisted terminal event remains the fallback.
            }
        }
        readSubagentPanelStorageKeyRef.current = readSubagentPanelStorageKey;
    }, [readSubagentPanelStorageKey]);
    useEffect(() => {
        if (skipSubagentPanelPersist.current) {
            skipSubagentPanelPersist.current = false;
            return;
        }
        try {
            window.localStorage.setItem(
                readSubagentPanelStorageKey,
                JSON.stringify(readSubagentPanels),
            );
        } catch {
            // The server-persisted terminal event remains the fallback.
        }
    }, [readSubagentPanelStorageKey, readSubagentPanels]);
    useEffect(() => {
        if (!readSubagents.showDock) return;
        const latestById = new Map<string, ReadSubagentPanel>();
        for (const message of messages) {
            for (const event of message.events ?? []) {
                if (event.type === "subagent_run") latestById.set(event.id, event);
            }
        }
        setReadSubagentPanels((current) => {
            const next = current.map(
                (panel) => latestById.get(panel.id) ?? panel,
            );
            for (const panel of latestById.values()) {
                if (
                    !dismissedReadSubagentIds.current.has(panel.id) &&
                    !next.some((current) => current.id === panel.id)
                ) {
                    next.push(panel);
                }
            }
            return next.slice(-READ_SUBAGENT_RUN_LIMIT);
        });
    }, [messages, readSubagents.showDock]);
    useEffect(() => {
        if (
            readSubagents.showDock &&
            readSubagentPanels.length > previousReadSubagentCount.current
        ) {
            const latest = readSubagentPanels.at(-1);
            if (latest) {
                const slot = latest.id.match(/:(\d+)$/u)?.[1] ?? latest.id;
                setActiveAgentSlot(slot);
                setActiveDockTab("agents");
                setDockOpen(true);
            }
        }
        previousReadSubagentCount.current = readSubagentPanels.length;
    }, [readSubagentPanels, readSubagents.showDock]);
    const openReadSubagentPanel = (panel: ReadSubagentPanel) => {
        dismissedReadSubagentIds.current.delete(panel.id);
        const withoutCurrent = readSubagentPanels.filter(
            (candidate) => candidate.id !== panel.id,
        );
        if (
            withoutCurrent.length === readSubagentPanels.length &&
            readSubagentPanels.length >= READ_SUBAGENT_RUN_LIMIT
        ) {
            setReadSubagentPanelLimitOpen(true);
            return;
        }
        setReadSubagentPanels([...withoutCurrent, panel]);
        const slot = panel.id.match(/:(\d+)$/u)?.[1] ?? panel.id;
        setActiveAgentSlot(slot);
        setActiveDockTab("agents");
        setDockOpen(true);
    };
    const closeReadSubagentPanel = (id: string) => {
        dismissedReadSubagentIds.current.add(id);
        setReadSubagentPanels((current) =>
            current.filter((panel) => panel.id !== id),
        );
    };
    const assistantSideGutterVisible = dockEnabled && dockOpen;
    const readerPanel = (embedded = false) =>
        tabs.length ? (
            <AssistantSidePanel
                embedded={embedded}
                tabs={visibleTabs}
                activeTabId={activeTabId}
                projectId={projectId}
                onActivateTab={setActiveTabId}
                onCloseTab={closeTab}
                onCloseAll={closeAllTabs}
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
    const sourceContent = tabs.length ? (
        readerPanel(true)
    ) : activeDockTab === "sources" ? (
        <LegalLibraryPage embedded />
    ) : null;
    const agentInspectorContent = agentInspectorTab ? (
        agentInspectorTab.kind === "case" ? (
            <LegalSourceViewer caseTab={agentInspectorTab} compact />
        ) : (
            <LegalSourceViewer {...agentInspectorTab} compact />
        )
    ) : null;
    const closeAgentGroup = (slot: string) => {
        for (const panel of groupedAgents.get(slot) ?? []) {
            closeReadSubagentPanel(panel.id);
        }
        const remaining = agentGroups.find((group) => group.id !== slot);
        setActiveAgentSlot(remaining?.id ?? null);
        if (!remaining) setAgentInspectorOpen(false);
    };
    const dockTabs: AssistantDockTab[] = [
        {
            id: "library",
            label: "Library",
            content: (
                <LibraryWorkspaceProvider>
                    {activeDockTab === "library" && (
                        <LibraryCollectionPage
                            kind={libraryKind}
                            onKindChange={setLibraryKind}
                            onOpenInChat={(documents) => {
                                for (const document of documents) {
                                    chatInputRef.current?.addDoc(document);
                                }
                            }}
                            embedded
                        />
                    )}
                </LibraryWorkspaceProvider>
            ),
        },
        {
            id: "workflows",
            label: "Workflows",
            content: (
                <AssistantWorkflowDock
                    initialWorkflowId={workflowInitialId}
                    onSelect={(workflow) => workflowSelectRef.current(workflow)}
                />
            ),
        },
        {
            id: "automations",
            label: "Automation",
            content: automationDocument ? (
                <div className="h-full overflow-y-auto">
                    <DocumentAutomation document={automationDocument} embedded />
                </div>
            ) : (
                <div className="grid h-full place-items-center p-6 text-center text-sm text-gray-500">
                    Open a document to use its automations.
                </div>
            ),
        },
        {
            id: "sources",
            label: "Sources",
            content: sourceContent,
        },
        {
            id: "agents",
            label: "Agents",
            content: (
                <ReadSubagentTabs
                    groups={agentGroups}
                    activeId={activeAgentSlot}
                    onActivate={setActiveAgentSlot}
                    onClose={closeAgentGroup}
                    onSourceClick={openReadSubagentSource}
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
                {onProjectClick && (
                    <div className="flex h-9 shrink-0 items-center justify-center border-b border-gray-100 px-4">
                        <button
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
                        </button>
                    </div>
                )}
                <div
                    ref={messagesContainerRef}
                    className="flex-1 w-full overflow-y-auto"
                    style={{ scrollbarGutter: "stable both-edges" }}
                >
                    <div
                        className={`w-full min-h-full flex flex-col relative ${layout === "panel" ? "px-4 pt-12" : "px-6 pt-6 md:px-8 md:pt-8"} ${assistantSideGutterVisible ? "ms-auto me-0 max-w-5xl md:max-lg:pe-2" : "mx-auto max-w-4xl"}`}
                        style={{
                            paddingBottom: DEFAULT_ASSISTANT_BOTTOM_PADDING,
                        }}
                    >
                        <div className="space-y-6 md:space-y-8">
                            {messages.map((msg, i) => (
                                <div
                                    key={msg.id ?? `${msg.role}:${i}`}
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
                                            events={msg.events}
                                            isStreaming={
                                                i === messages.length - 1 &&
                                                isResponseLoading
                                            }
                                            isError={!!msg.error}
                                            errorMessage={
                                                typeof msg.error === "string"
                                                    ? msg.error
                                                    : undefined
                                            }
                                            citations={msg.citations}
                                            onCitationClick={openCitation}
                                            citationTitle={citationTitle}
                                            onCaseClick={openCase}
                                            onAutomationClick={openAutomation}
                                            onSubagentClick={
                                                readSubagents.showDock
                                                    ? openReadSubagentPanel
                                                    : undefined
                                            }
                                            onSubagentSourceClick={
                                                openReadSubagentSource
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
                                            onWorkflowClick={(id) => {
                                                openWorkflows(
                                                    (workflow) =>
                                                        chatInputRef.current?.startWorkflowDocumentSelection({
                                                            id: workflow.id,
                                                            title: workflow.metadata.title,
                                                        }),
                                                    id,
                                                );
                                            }}
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
                            contextUsage={
                                latestContextUsage || latestCompaction?.status === "running"
                                    ? {
                                          usedTokens:
                                              latestContextUsage?.type === "context_usage"
                                                  ? latestContextUsage.used_tokens
                                                  : 0,
                                          windowTokens:
                                              latestContextUsage?.type === "context_usage"
                                                  ? Math.max(
                                                        1,
                                                        latestContextUsage.window_tokens,
                                                    )
                                                  : 1,
                                          compacting:
                                              latestCompaction?.type === "compaction" &&
                                              latestCompaction.status === "running",
                                      }
                                    : undefined
                            }
                            showContextTools={contextToolsEnabled}
                            rows={layout === "panel" ? 2 : 1}
                            automationsAvailable={dockEnabled && !!activeDocument}
                            onOpenAutomations={dockEnabled ? openAutomations : undefined}
                            onOpenWorkflows={dockEnabled ? openWorkflows : undefined}
                            projectName={projectName ?? undefined}
                            projectCmNumber={projectCmNumber}
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
                    onActivateTab={(id) => {
                        setActiveDockTab(id);
                        if (id !== "agents") setAgentInspectorOpen(false);
                    }}
                    expanded={dockOpen}
                    onExpandedChange={setDockOpen}
                    inspectorContent={agentInspectorContent}
                    inspectorOpen={
                        resolvedDockTab === "agents" && agentInspectorOpen
                    }
                    onCloseInspector={() => {
                        setAgentInspectorOpen(false);
                        setAgentInspectorTab(null);
                    }}
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
            <WarningPopup
                open={readSubagentPanelLimitOpen}
                title="The recent-run view is full"
                message="Close the reading-agent history before opening an older run."
                onClose={() => setReadSubagentPanelLimitOpen(false)}
            />
        </div>
    );
});
