"use client";

import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { ArrowDown } from "lucide-react";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { automationRunKey } from "./AutomationRun";
import { ChatInput } from "./ChatInput";
import type { ChatInputHandle } from "./ChatInput";
import { AskInputPopup } from "./AskInputPopup";
import {
    AssistantSidePanel,
    type AssistantSidePanelTab,
    type CitationTab,
    type DocumentTab,
    type EditTab,
} from "./AssistantSidePanel";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import type {
    AssistantEvent,
    Citation,
    Document,
    EditAnnotation,
    Message,
} from "../shared/types";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { invalidateDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import type { RejectedAssistantTurn } from "@/app/hooks/useAssistantChat";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";

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
    hideAddDocButton?: boolean;
    useDisplayedDocumentContext?: boolean;
    onDocumentsUploaded?: (documents: Document[]) => void;
    onActiveDocumentChange?: (documentId: string | null) => void;
}

export interface ChatViewHandle {
    attachDocument: (document: Document) => void;
    closeDocument: (documentId: string) => void;
    openDocument: (document: Document) => void;
}

const MOBILE_BREAKPOINT_PX = 768;
const DEFAULT_ASSISTANT_BOTTOM_PADDING = 116;
const SCROLL_BUTTON_INPUT_GAP = 16;
const CHAT_INPUT_BOTTOM_OFFSET = 12;

function isSmallScreen() {
    return (
        typeof window !== "undefined" &&
        window.innerWidth < MOBILE_BREAKPOINT_PX
    );
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
        hideAddDocButton,
        useDisplayedDocumentContext,
        onDocumentsUploaded,
        onActiveDocumentChange,
    },
    ref,
) {
    const [tabs, setTabs] = useState<AssistantSidePanelTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [workflowModalInitialId, setWorkflowModalInitialId] = useState<
        string | undefined
    >();
    const [hiddenAskInputKeys, setHiddenAskInputKeys] = useState<Set<string>>(
        () => new Set(),
    );
    const [reloadingDocIds, setReloadingDocIds] = useState<Set<string>>(
        () => new Set(),
    );
    // Per-edit in-flight set — disables Accept/Reject on only the one
    // edit currently being resolved, so sibling edits in the same message
    // (and their twins in DocPanel) stay clickable.
    const [reloadingEditIds, setReloadingEditIds] = useState<Set<string>>(
        () => new Set(),
    );
    const { setSidebarOpen } = useSidebar();

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reset per-chat UI state when switching chats
        setHiddenAskInputKeys(new Set());
    }, [chatId]);

    const restoreSidebarAfterPanelClose = useCallback(() => {
        if (!isSmallScreen()) setSidebarOpen(true);
    }, [setSidebarOpen]);

    const closeAllTabs = useCallback(() => {
        setTabs([]);
        setActiveTabId(null);
        restoreSidebarAfterPanelClose();
    }, [restoreSidebarAfterPanelClose]);

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

    /**
     * One tab per document. If a tab for `tab.documentId` already exists,
     * the panel stays mounted and only the header-relevant fields swap
     * (kind, citation/edit, version, filename). Per-tab UI state — the
     * dismissable warning and the saved scroll position — is preserved
     * so switching headers doesn't blow away viewer state. If no tab
     * exists for the document, a new one is appended.
     */
    const upsertTab = useCallback(
        (tab: AssistantSidePanelTab) => {
            setTabs((prev) => {
                const idx = prev.findIndex((t) => {
                    if (
                        tab.kind === "case" ||
                        tab.kind === "legal" ||
                        tab.kind === "automation"
                    ) {
                        return t.kind === tab.kind && t.id === tab.id;
                    }
                    return (
                        t.kind !== "automation" &&
                        t.kind !== "case" &&
                        t.kind !== "legal" &&
                        t.documentId === tab.documentId
                    );
                });
                if (idx >= 0) {
                    const existing = prev[idx];
                    const copy = prev.slice();
                    copy[idx] =
                        tab.kind === "case" ||
                        tab.kind === "legal" ||
                        tab.kind === "automation" ||
                        existing.kind === "case" ||
                        existing.kind === "legal" ||
                        existing.kind === "automation"
                            ? tab
                            : {
                                  ...tab,
                                  id: existing.id,
                                  warning: existing.warning,
                                  initialScrollTop: existing.initialScrollTop,
                              };
                    return copy;
                }
                return [...prev, tab];
            });
            setActiveTabId(tab.id);
            setSidebarOpen(false);
        },
        [setSidebarOpen],
    );

    /**
     * Open a tab showing a single citation quote. Called from
     * AssistantMessage when the user clicks a numbered citation pill.
     */
    const openCitation = useCallback(
        (citation: Citation, options?: { showQuotes?: boolean }) => {
            const showQuotes = options?.showQuotes ?? true;
            if (citation.kind === "a2aj") {
                if (citation.citation) {
                    upsertTab({
                        kind: "legal",
                        id: `legal:${citation.dataset ?? ""}:${citation.citation}`,
                        citation: citation.citation,
                        name: citation.name ?? null,
                        dataset: citation.dataset ?? null,
                        docType: "auto",
                        language: "en",
                        citationRef: citation.ref,
                        quotes: showQuotes ? citation.quotes : undefined,
                    });
                } else if (citation.url) {
                    window.open(citation.url, "_blank", "noopener,noreferrer");
                }
                return;
            }
            if (citation.kind === "public_legal") {
                if (citation.provider === "journal") {
                    upsertTab({
                        kind: "legal",
                        id: `legal:journal:${citation.identifier}`,
                        provider: "journal",
                        sourceId: citation.identifier,
                        citation: citation.title ?? citation.identifier,
                        name: citation.title ?? null,
                        dataset: null,
                        docType: "articles",
                        language: "en",
                        citationRef: citation.ref,
                        quotes: showQuotes ? citation.quotes : undefined,
                    });
                } else if (citation.url) {
                    window.open(citation.url, "_blank", "noopener,noreferrer");
                }
                return;
            }
            if (citation.kind === "case") {
                if (!chatId) return;
                upsertTab({
                    kind: "case",
                    id: `case:${citation.cluster_id}`,
                    chatId,
                    clusterId: citation.cluster_id,
                    citationRef: citation.ref,
                    caseName: citation.case_name ?? null,
                    citation: citation.citation ?? null,
                    url: citation.url ?? null,
                    dateFiled: citation.dateFiled ?? null,
                    pdfUrl: citation.pdfUrl ?? null,
                    quotes: showQuotes ? citation.quotes : undefined,
                    opinions: undefined,
                });
                return;
            }
            if (!showQuotes) {
                upsertTab({
                    kind: "document",
                    id: citation.document_id,
                    documentId: citation.document_id,
                    filename: citation.filename,
                    versionId: citation.version_id ?? null,
                    versionNumber: citation.version_number ?? null,
                });
                return;
            }
            upsertTab({
                kind: "citation",
                id: citation.document_id,
                documentId: citation.document_id,
                filename: citation.filename,
                versionId: citation.version_id ?? null,
                versionNumber: citation.version_number ?? null,
                citation,
            });
        },
        [chatId, upsertTab],
    );

    const openCase = useCallback(
        (citation: Extract<AssistantEvent, { type: "case_citation" }>) => {
            if (!citation.cluster_id) return;
            if (!chatId) return;
            upsertTab({
                kind: "case",
                id: `case:${citation.cluster_id}`,
                chatId,
                clusterId: citation.cluster_id,
                citationRef: undefined,
                caseName: citation.case_name,
                citation: citation.citation,
                url: citation.url,
                dateFiled: citation.dateFiled ?? null,
                pdfUrl: citation.pdfUrl ?? null,
                quotes: undefined,
                opinions: citation.case?.opinions,
            });
        },
        [chatId, upsertTab],
    );

    /**
     * Open a tab showing a single tracked change. Called from
     * AssistantMessage when the user clicks an EditCard's View button.
     */
    const openEditor = useCallback(
        (ann: EditAnnotation, filename: string, changeNumber?: number) => {
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
        },
        [upsertTab],
    );

    /**
     * Open a tab showing a document without targeting a specific
     * citation/edit — used by the download-card click.
     */
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

    const mergedAutomationRun = useCallback(
        (run: Extract<AssistantEvent, { type: "automation_run" }>) => {
            const key = automationRunKey(run);
            let merged = run;
            for (const message of messages) {
                for (const event of message.events ?? []) {
                    if (
                        event.type === "automation_run" &&
                        automationRunKey(event) === key
                    ) {
                        merged = { ...merged, ...event };
                    }
                }
            }
            return merged;
        },
        [messages],
    );

    const openAutomation = useCallback(
        (run: Extract<AssistantEvent, { type: "automation_run" }>) => {
            const merged = mergedAutomationRun(run);
            upsertTab({
                kind: "automation",
                id: `automation:${automationRunKey(merged)}`,
                run: merged,
            });
        },
        [mergedAutomationRun, upsertTab],
    );

    useEffect(() => {
        const latest = new Map<
            string,
            Extract<AssistantEvent, { type: "automation_run" }>
        >();
        for (const message of messages) {
            for (const event of message.events ?? []) {
                if (event.type === "automation_run") {
                    const key = `automation:${automationRunKey(event)}`;
                    latest.set(key, {
                        ...(latest.get(key) ?? {}),
                        ...event,
                    });
                }
            }
        }
        if (!latest.size) return;
        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled) return;
            setTabs((current) => {
                let changed = false;
                const next = current.map((tab) => {
                    if (tab.kind !== "automation") return tab;
                    const run = latest.get(tab.id);
                    if (!run || run === tab.run) return tab;
                    changed = true;
                    return { ...tab, run };
                });
                return changed ? next : current;
            });
        });
        return () => {
            cancelled = true;
        };
    }, [messages]);

    const [resolvedEditStatuses, setResolvedEditStatuses] = useState<
        Record<string, "accepted" | "rejected">
    >({});

    const handleEditResolveStart = useCallback(
        (args: {
            editId: string;
            documentId: string;
            verb: "accept" | "reject";
        }) => {
            setReloadingDocIds((prev) => {
                if (prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.add(args.documentId);
                return next;
            });
            setReloadingEditIds((prev) => {
                if (prev.has(args.editId)) return prev;
                const next = new Set(prev);
                next.add(args.editId);
                return next;
            });
        },
        [],
    );

    const handleEditResolved = useCallback(
        (args: {
            editId: string;
            documentId: string;
            status: "accepted" | "rejected";
            versionId: string | null;
            downloadUrl: string | null;
        }) => {
            setResolvedEditStatuses((prev) => ({
                ...prev,
                [args.editId]: args.status,
            }));
            setReloadingDocIds((prev) => {
                if (!prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.delete(args.documentId);
                return next;
            });
            setReloadingEditIds((prev) => {
                if (!prev.has(args.editId)) return prev;
                const next = new Set(prev);
                next.delete(args.editId);
                return next;
            });
            // Propagate the new status onto any open edit-tab for this
            // edit so DocPanel's Accept/Reject buttons flip and disable
            // (their sync effect keys off edit.status). Without this, a
            // resolve triggered from the inline EditCard or BulkEditActions
            // leaves the panel buttons looking live.
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
            // Accept/reject mutates bytes for this document's current
            // version; drop the cache so the next DocxView render (or an
            // explicit re-open) fetches the fresh file.
            invalidateDocxBytes(args.documentId);
        },
        [],
    );

    const patchTab = useCallback(
        (
            tabId: string,
            patch: {
                warning?: string | null;
                initialScrollTop?: number | null;
            },
        ) => {
            setTabs((prev) => {
                const idx = prev.findIndex((t) => t.id === tabId);
                if (idx < 0) return prev;
                if (
                    prev[idx].kind === "automation" ||
                    prev[idx].kind === "case" ||
                    prev[idx].kind === "legal"
                ) {
                    return prev;
                }
                const copy = prev.slice();
                copy[idx] = { ...copy[idx], ...patch };
                return copy;
            });
        },
        [],
    );

    const handleEditError = useCallback(
        (args: {
            editId?: string;
            documentId: string;
            versionId?: string | null;
            message: string;
        }) => {
            // Surface the warning on every tab tied to this document.
            setTabs((prev) =>
                prev.map((t) =>
                    t.kind !== "automation" &&
                    t.kind !== "case" &&
                    t.kind !== "legal" &&
                    t.documentId === args.documentId
                        ? { ...t, warning: args.message }
                        : t,
                ),
            );
            setReloadingDocIds((prev) => {
                if (!prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.delete(args.documentId);
                return next;
            });
            if (args.editId) {
                setReloadingEditIds((prev) => {
                    if (!prev.has(args.editId!)) return prev;
                    const next = new Set(prev);
                    next.delete(args.editId!);
                    return next;
                });
            }
        },
        [],
    );

    const handleWarningDismiss = useCallback(
        (tabId: string) => {
            patchTab(tabId, { warning: null });
        },
        [patchTab],
    );

    const handleScrollChange = useCallback(
        (tabId: string, scrollTop: number) => {
            patchTab(tabId, { initialScrollTop: scrollTop });
        },
        [patchTab],
    );

    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const chatInputRef = useRef<ChatInputHandle | null>(null);
    const measuredInputRef = useRef<HTMLDivElement>(null);
    const [showScrollButton, setShowScrollButton] = useState(false);
    const [inputHeight, setInputHeight] = useState(0);
    const [minHeight, setMinHeight] = useState("0px");

    useEffect(() => {
        const el = measuredInputRef.current;
        if (!el) return;
        const update = () => setInputHeight(el.offsetHeight);
        const observer = new ResizeObserver(update);
        observer.observe(el);
        update();
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (latestUserMessageRef.current) {
            const headerHeight = window.innerWidth < 768 ? 56 : 0;
            const messageGap = window.innerWidth < 768 ? 24 : 32;
            const paddingBottom = DEFAULT_ASSISTANT_BOTTOM_PADDING;
            const userMessageHeight = latestUserMessageRef.current.offsetHeight;
            setMinHeight(
                `calc(100dvh - ${headerHeight + messageGap * 3 + userMessageHeight + paddingBottom}px)`,
            );
        }
    }, [messages.length]);

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
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initial scroll-button state must be measured from the live DOM
        updateScrollButton();
        return () => c.removeEventListener("scroll", updateScrollButton);
    }, [messages, updateScrollButton]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
    }, [chatId, isResponseLoading, messages.length, scrollLatestUserToTop]);

    useEffect(() => {
        if (tabs.length > 0 && window.innerWidth < 768) {
            document.body.style.overflow = "hidden";
        } else {
            document.body.style.overflow = "unset";
        }
        return () => {
            document.body.style.overflow = "unset";
        };
    }, [tabs.length]);

    const rawActiveInput = (() => {
        for (
            let messageIndex = messages.length - 1;
            messageIndex >= 0;
            messageIndex--
        ) {
            const message = messages[messageIndex];
            if (message.role === "user") return null;
            if (message.role !== "assistant" || !message.events) continue;
            for (
                let eventIndex = message.events.length - 1;
                eventIndex >= 0;
                eventIndex--
            ) {
                const event = message.events[eventIndex];
                if (event.type === "ask_inputs_response") {
                    return null;
                }
                if (event.type === "ask_inputs") {
                    return {
                        key: `${messageIndex}-${eventIndex}`,
                        event,
                    };
                }
            }
        }
        return null;
    })();
    const activeInput =
        rawActiveInput && !hiddenAskInputKeys.has(rawActiveInput.key)
            ? rawActiveInput
            : null;
    const activeDocument = tabs.find(
        (tab): tab is DocumentTab | CitationTab | EditTab =>
            tab.id === activeTabId &&
            tab.kind !== "automation" &&
            tab.kind !== "case" &&
            tab.kind !== "legal",
    );
    useEffect(() => {
        onActiveDocumentChange?.(activeDocument?.documentId ?? null);
    }, [activeDocument?.documentId, onActiveDocumentChange]);
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

    const messagesBottomPadding = DEFAULT_ASSISTANT_BOTTOM_PADDING;
    const lastUserIndex = messages.findLastIndex(
        (message) => message.role === "user",
    );
    const lastAssistantIndex = messages.findLastIndex(
        (message) => message.role === "assistant",
    );

    return (
        <div className="h-full w-full flex relative">
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
                        className="w-full max-w-4xl mx-auto px-6 pt-6 md:px-8 md:pt-8 min-h-full flex flex-col relative"
                        style={{ paddingBottom: messagesBottomPadding }}
                    >
                        <div className="space-y-6 md:space-y-8">
                            {messages.map((msg, i) => (
                                <div
                                    key={i}
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
                                            citationStatus={msg.citationStatus}
                                            onCitationClick={openCitation}
                                            onOpenCitationSource={(citation) =>
                                                openCitation(citation, {
                                                    showQuotes: false,
                                                })
                                            }
                                            onCaseClick={openCase}
                                            onAutomationClick={openAutomation}
                                            minHeight={
                                                i === lastAssistantIndex
                                                    ? minHeight
                                                    : "0px"
                                            }
                                            onWorkflowClick={(id) => {
                                                setWorkflowModalInitialId(id);
                                                setWorkflowModalOpen(true);
                                            }}
                                            onEditViewClick={openEditor}
                                            onOpenDocument={openDocument}
                                            onEditResolveStart={
                                                handleEditResolveStart
                                            }
                                            onEditResolved={handleEditResolved}
                                            onEditError={handleEditError}
                                            isDocReloading={(docId) =>
                                                reloadingDocIds.has(docId)
                                            }
                                            isEditReloading={(editId) =>
                                                reloadingEditIds.has(editId)
                                            }
                                            resolvedEditStatuses={
                                                resolvedEditStatuses
                                            }
                                        />
                                    )}
                                </div>
                            ))}
                            <div ref={messagesEndRef} />
                        </div>
                    </div>
                </div>

                {showScrollButton && (
                    <div
                        className="absolute left-1/2 -translate-x-1/2 z-19"
                        style={{
                            bottom:
                                inputHeight +
                                CHAT_INPUT_BOTTOM_OFFSET +
                                SCROLL_BUTTON_INPUT_GAP,
                        }}
                    >
                        <button
                            onClick={scrollToBottom}
                            className="cursor-pointer rounded-full border border-gray-300 bg-white p-2 hover:bg-gray-100"
                        >
                            <ArrowDown className="h-6 w-6 text-gray-500" />
                        </button>
                    </div>
                )}

                <div className="absolute bottom-3 left-0 right-0 w-full z-30">
                    <div
                        ref={measuredInputRef}
                        className="relative mx-auto w-full max-w-4xl px-4 md:px-6"
                    >
                        {activeInput && (
                            <div
                                data-ask-input-dock
                                className="absolute inset-x-4 bottom-[calc(100%+0.5rem)] md:inset-x-6"
                            >
                                <AskInputPopup
                                    key={activeInput.key}
                                    event={activeInput.event}
                                    onSubmit={(response, content, files) => {
                                        setHiddenAskInputKeys((prev) => {
                                            const next = new Set(prev);
                                            next.add(activeInput.key);
                                            return next;
                                        });
                                        void handleChat(
                                            { role: "user", content, files },
                                            { askInputsResponse: response },
                                        );
                                    }}
                                    onDismiss={() => {
                                        setHiddenAskInputKeys((prev) => {
                                            const next = new Set(prev);
                                            next.add(activeInput.key);
                                            return next;
                                        });
                                        cancel();
                                    }}
                                />
                            </div>
                        )}
                        <ChatInput
                            ref={chatInputRef}
                            onSubmit={submitMessage}
                            onCancel={() => {
                                if (activeInput) {
                                    setHiddenAskInputKeys((prev) => {
                                        const next = new Set(prev);
                                        next.add(activeInput.key);
                                        return next;
                                    });
                                }
                                cancel();
                            }}
                            isLoading={isResponseLoading || !!activeInput}
                            hideAddDocButton={hideAddDocButton}
                            projectId={projectId}
                            projectName={projectName ?? undefined}
                            projectCmNumber={projectCmNumber}
                            onDocumentsUploaded={onDocumentsUploaded}
                            restoreDraft={
                                rejectedTurn?.options?.askInputsResponse
                                    ? null
                                    : rejectedTurn?.message
                            }
                        />
                    </div>
                </div>
            </div>

            <AssistantWorkflowModal
                open={workflowModalOpen}
                onClose={() => setWorkflowModalOpen(false)}
                onSelect={() => setWorkflowModalOpen(false)}
                initialWorkflowId={workflowModalInitialId}
            />

            {tabs.length > 0 && (
                <div className="fixed inset-0 z-40 flex justify-center p-3 md:relative md:inset-auto md:z-auto md:block md:h-full md:min-w-0 md:flex-shrink-0 md:p-0">
                    <AssistantSidePanel
                        tabs={tabs}
                        activeTabId={activeTabId}
                        projectId={projectId}
                        onActivateTab={setActiveTabId}
                        onCloseTab={closeTab}
                        onCloseAll={closeAllTabs}
                        isEditorReloading={(documentId) =>
                            reloadingDocIds.has(documentId)
                        }
                        isEditReloading={(editId) =>
                            reloadingEditIds.has(editId)
                        }
                        onEditResolveStart={handleEditResolveStart}
                        onEditResolved={handleEditResolved}
                        onEditError={handleEditError}
                        onWarningDismiss={handleWarningDismiss}
                        onScrollChange={handleScrollChange}
                    />
                </div>
            )}
            <WarningPopup
                open={!!rejectedTurn}
                title={
                    rejectedTurn?.options?.askInputsResponse
                        ? "Inputs not sent"
                        : "Response interrupted"
                }
                message={
                    rejectedTurn?.options?.askInputsResponse
                        ? "Your selections were kept. Retry them after reviewing the latest response."
                        : "Retry the original request, or dismiss this notice to edit the restored draft."
                }
                onClose={() => onRejectedTurnRestored?.()}
                primaryAction={
                    onRetryRejectedTurn
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
