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
    type AssistantDocumentTab,
    type AssistantSidePanelTab,
} from "./AssistantSidePanel";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
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
} from "../shared/types";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { invalidateDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import type { RejectedAssistantTurn } from "@/app/hooks/useAssistantChat";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { legalSourceLocatorFromUrl } from "@/app/components/legal/LegalSourceViewer";
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
}
export interface ChatViewHandle {
    attachDocument: (document: Document) => void;
    closeDocument: (documentId: string) => void;
    openDocument: (document: Document) => void;
}
const MOBILE_BREAKPOINT_PX = 768;
const DEFAULT_ASSISTANT_BOTTOM_PADDING = 116;
const LATEST_ASSISTANT_MIN_HEIGHT = "calc(100dvh - 16rem)";
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
                citation.locator ?? legalSourceLocatorFromUrl(citation.url),
        };
    }
    if (citation.kind === "public_legal" && citation.provider === "journal") {
        return {
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
            quotes,
            initialLocator: citation.locator ?? null,
        };
    }
    return null;
}
function documentCitationTab(
    citation: DocumentCitation,
    showQuotes: boolean,
): AssistantDocumentTab {
    const tab = {
        id: citation.document_id,
        documentId: citation.document_id,
        filename: citation.filename,
        versionId: citation.version_id ?? null,
        versionNumber: citation.version_number ?? null,
    };
    return showQuotes
        ? { ...tab, kind: "citation", citation }
        : { ...tab, kind: "document" };
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
    },
    ref,
) {
    const [tabs, setTabs] = useState<AssistantSidePanelTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [workflowModalId, setWorkflowModalId] = useState<string | null>(null);
    const [hiddenAskInputKey, setHiddenAskInputKey] = useState<string | null>(
        null,
    );
    const [responseAnnouncement, setResponseAnnouncement] = useState("");
    const wasResponseLoadingRef = useRef(false);
    const [editState, setEditState] = useState(() => ({
        docIds: new Set<string>(),
        editIds: new Set<string>(),
        statuses: {} as Record<string, "accepted" | "rejected">,
    }));
    const { setSidebarOpen } = useSidebar();
    const closeAllTabs = useCallback(() => {
        setTabs([]);
        setActiveTabId(null);
        if (window.innerWidth >= MOBILE_BREAKPOINT_PX) setSidebarOpen(true);
    }, [setSidebarOpen]);
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
        (tab: AssistantSidePanelTab) => {
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
            setSidebarOpen(false);
        },
        [setSidebarOpen],
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
    const openCitation = (
        citation: Citation,
        showQuotes = true,
    ) => {
        if (citation.kind === "case") return openCase(citation, showQuotes);
        if (citation.kind === "document" || !citation.kind) {
            return upsertTab(documentCitationTab(citation, showQuotes));
        }
        if (citation.kind === "a2aj" || citation.kind === "public_legal") {
            const tab = legalCitationTab(citation, showQuotes);
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
        const wasLoading = wasResponseLoadingRef.current;
        if (isResponseLoading) {
            setResponseAnnouncement("Assistant is responding.");
        } else if (wasLoading) {
            const latestAssistant = messages[lastAssistantIndex];
            const wasCancelled = latestAssistant?.events?.some(
                (event) =>
                    event.type === "content" &&
                    event.text.trim() === "Cancelled by user.",
            );
            setResponseAnnouncement(
                latestAssistant?.error || wasCancelled
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
        if (tabs.length > 0 && window.innerWidth < MOBILE_BREAKPOINT_PX) {
            document.body.style.overflow = "hidden";
        } else {
            document.body.style.overflow = "unset";
        }
        return () => {
            document.body.style.overflow = "unset";
        };
    }, [tabs.length]);
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
                        className="w-full max-w-4xl mx-auto px-6 pt-6 md:px-8 md:pt-8 min-h-full flex flex-col relative"
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
                                            citationStatus={msg.citationStatus}
                                            onCitationClick={openCitation}
                                            onOpenCitationSource={(citation) =>
                                                openCitation(citation, false)
                                            }
                                            onCaseClick={openCase}
                                            onAutomationClick={openAutomation}
                                            minHeight={
                                                i === lastAssistantIndex
                                                    ? LATEST_ASSISTANT_MIN_HEIGHT
                                                    : "0px"
                                            }
                                            onWorkflowClick={(id) => {
                                                setWorkflowModalId(id);
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
                                </div>
                            ))}
                            <div ref={messagesEndRef} />
                        </div>
                    </div>
                </div>
                <div className="absolute bottom-3 left-0 right-0 w-full z-30">
                    <div className="relative mx-auto w-full max-w-4xl px-4 md:px-6">
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
            <AssistantWorkflowModal
                open={workflowModalId !== null}
                onClose={() => setWorkflowModalId(null)}
                onSelect={() => setWorkflowModalId(null)}
                initialWorkflowId={workflowModalId ?? undefined}
            />
            {tabs.length > 0 && (
                <div className="fixed inset-0 z-40 flex justify-center p-3 md:relative md:inset-auto md:z-auto md:block md:h-full md:min-w-0 md:flex-shrink-0 md:p-0">
                    <AssistantSidePanel
                        tabs={visibleTabs}
                        activeTabId={activeTabId}
                        projectId={projectId}
                        onActivateTab={setActiveTabId}
                        onCloseTab={closeTab}
                        onCloseAll={closeAllTabs}
                        isEditorReloading={(documentId) =>
                            editState.docIds.has(documentId)
                        }
                        isEditReloading={(editId) =>
                            editState.editIds.has(editId)
                        }
                        onEditResolveStart={handleEditResolveStart}
                        onEditResolved={handleEditResolved}
                        onEditError={handleEditError}
                        onWarningDismiss={(tabId) =>
                            patchTab(tabId, { warning: null })
                        }
                        onScrollChange={(tabId, initialScrollTop) =>
                            patchTab(tabId, { initialScrollTop })
                        }
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
