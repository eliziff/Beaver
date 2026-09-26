import { forwardRef, useEffect, useImperativeHandle,
    useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, CircleStop } from "lucide-react";
import { invalidateDocumentFile } from "@/app/hooks/useDocumentFile";
import {
    type AssistantSessionState,
    type AssistantTurnOptions,
} from "@/app/lib/assistantSession";
import { Button } from "@/app/components/ui/button";
import type { WorkflowDocument } from "../workflows/ContextualWorkflowPicker";
import type { Citation } from "@/app/lib/citations";
import type {
  Document,
  EditAnnotation,
  EditResolveError,
  EditResolveStart,
  EditResolved,
} from "@/app/lib/api/documents";
import type { Message, WorkflowRunEvent } from "@/app/lib/api/chat";
import { AskInputPopup } from "./AskInputPopup";
import { AssistantMessage } from "./AssistantMessage";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { CHAT_COLUMN_CLASS } from "./chatLayout";
import { UserMessage } from "./UserMessage";

type OpenDocument = (args: { documentId: string; filename: string; versionId: string | null;
    versionNumber: number | null }) => void;

interface Props {
    chatId?: string | null; session: AssistantSessionState;
    handleChat: (message: Message, options?: AssistantTurnOptions) => Promise<string | null>;
    cancel(): void; onSubmit?: (message: Message) => unknown;
    onRejectedTurnRestored?(): void; onRetryRejectedTurn?(): void;
    onCitationClick?: (citation: Citation) => void; citationTitle?: (citation: Citation) => string;
    onWorkflowRunClick?: (run: WorkflowRunEvent) => void; onReaderClick?: (readerId: string) => void;
    onEditViewClick?: (annotation: EditAnnotation, filename: string, changeNumber?: number) => void;
    onOpenDocument?: OpenDocument; onEditResolveStart?: (args: EditResolveStart) => void;
    onEditResolved?: (args: EditResolved) => void; onEditError?: (args: EditResolveError) => void;
    isDocReloading?: (documentId: string) => boolean; isEditReloading?: (editId: string) => boolean;
    resolvedEditStatuses?: Record<string, "accepted" | "rejected">;
    layout?: "page" | "panel"; gutterVisible?: boolean; dock?: ReactNode;
    showContextTools?: boolean;
    onOpenWorkflows?: (initialWorkflowId?: string, documents?: WorkflowDocument[]) => void;
    onOrganize?: () => void;
    projectName?: string; projectCmNumber?: string | null;
    initialDraft?: import("@/app/lib/api/chat").ChatDraft | null;
    initialModel?: string | null; initialReasoningEffort?: string | null;
    editModeLabels?: { manual: string; auto: string };
    sendDisabled?: boolean;
    searchMessageId?: string | null;
    /** Fetches the page of messages before the first one loaded. */
    onLoadEarlier?: () => Promise<void> | void;
    messageActions?: (messageId: string) => ReactNode;
    afterMessages?: ReactNode;
}

function without<T>(items: Set<T>, item: T) {
    if (!items.has(item)) return items;
    const next = new Set(items);
    next.delete(item); return next;
}

/** How many messages mount at once: the latest when a chat opens, and each batch above them. */
const MOUNTED_MESSAGES = 40;

export const ConversationView = forwardRef<ChatInputHandle, Props>(function ConversationView(
    {
        chatId, session, handleChat, cancel, onSubmit = handleChat,
        onRejectedTurnRestored, onRetryRejectedTurn,
        onCitationClick, citationTitle, onWorkflowRunClick, onReaderClick,
        onEditViewClick, onOpenDocument, onEditResolveStart, onEditResolved, onEditError,
        isDocReloading, isEditReloading, resolvedEditStatuses,
        layout = "page", gutterVisible = false, dock, showContextTools = true,
        onOpenWorkflows, onOrganize, projectName, projectCmNumber, initialDraft, initialModel, initialReasoningEffort,
        editModeLabels, sendDisabled, searchMessageId, messageActions, afterMessages, onLoadEarlier,
    }, ref) {
    const { messages, rejectedTurn } = session;
    const messagesContainerRef = useRef<HTMLDivElement>(null),
        messagesEndRef = useRef<HTMLDivElement>(null), latestUserMessageRef = useRef<HTMLDivElement>(null),
        chatInputRef = useRef<ChatInputHandle>(null);
    const [hiddenAskInputKey, setHiddenAskInputKey] = useState<string | null>(null),
        [showScrollButton, setShowScrollButton] = useState(false);
    const [editState, setEditState] = useState(() => ({ docIds: new Set<string>(),
        editIds: new Set<string>(), statuses: {} as Record<string, "accepted" | "rejected"> }));
    const scrolledSearch = useRef<string | null>(null);
    type Anchor = { element: HTMLElement; fraction: number; offset: number } | null;
    const anchor = useRef<Anchor>(null),
        reanchor = useRef(() => undefined as void);
    useImperativeHandle(ref, () => ({
        getModelPreferences: () => chatInputRef.current?.getModelPreferences(),
        addDoc: (document: Document) => chatInputRef.current?.addDoc(document),
        clearDraft: () => chatInputRef.current?.clearDraft(),
        startWorkflowDocumentSelection: (...args) => chatInputRef.current
            ?.startWorkflowDocumentSelection(...args),
    }), []);

    // Only recent messages are mounted, so a chat of any length opens, updates and holds memory
    // like a short one. Earlier messages mount in batches as the reader scrolls up to them (the
    // scroll anchor below keeps their place), and are fetched from the server once all loaded
    // ones are mounted. A message opened from search is always mounted, fetching back to it.
    // The first mounted message is held by id: an earlier page shifts every index.
    const [earliest, setEarliest] = useState<{ chatId?: string | null; id: string } | null>(null);
    const heldIndex = earliest && earliest.chatId === chatId
        ? messages.findIndex(({ id }) => id === earliest.id) : -1;
    const searchIndex = searchMessageId ? messages.findIndex(({ id }) => id === searchMessageId) : -1;
    const shownFrom = Math.min(heldIndex >= 0 ? heldIndex : Math.max(0, messages.length - MOUNTED_MESSAGES),
        searchIndex < 0 ? Infinity : searchIndex);
    const moreAbove = shownFrom > 0 || !!session.hasEarlier;
    const earlierRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const sentinel = earlierRef.current, container = messagesContainerRef.current;
        if (!sentinel || !container) return;
        const observer = new IntersectionObserver(([entry]) => {
            if (!entry?.isIntersecting) return;
            if (shownFrom > 0) setEarliest({ chatId, id: messages[Math.max(0, shownFrom - MOUNTED_MESSAGES)].id });
            else { if (messages[0]) setEarliest({ chatId, id: messages[0].id }); void onLoadEarlier?.(); }
        }, { root: container, rootMargin: "1200px 0px 0px 0px" });
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [chatId, shownFrom, messages, onLoadEarlier]);
    useEffect(() => {
        if (searchMessageId && searchIndex < 0 && session.hasEarlier) void onLoadEarlier?.();
    }, [searchMessageId, searchIndex, session.hasEarlier, messages, onLoadEarlier]);
    const lastUserIndex = messages.findLastIndex(({ role }) => role === "user");
    const lastAssistantIndex = messages.findLastIndex(({ role }) => role === "assistant");
    const latestAssistant = messages[lastAssistantIndex];
    const responseInProgress = session.run?.status === "running" &&
        !(latestAssistant?.role === "assistant" && latestAssistant.contentFinal);
    const responseAnnouncement = responseInProgress ? "Assistant is responding."
        : latestAssistant?.role === "assistant" && !latestAssistant.error && !latestAssistant.turnStatus
          ? "Response ready." : "";
    const activeInput = session.pendingInput?.key !== hiddenAskInputKey
        ? session.pendingInput : null;
    useEffect(() => {
        const container = messagesContainerRef.current;
        if (!container) return;
        // The message at the top of the viewport and how far down it sits: what stays put when a
        // message grows (streaming text, an edit accepted or rejected) or the window is resized.
        /** A place in the log: how far down a message, and where that sat in the viewport. The message
         *  survives re-rendering where the words inside it do not, so it is what the position is kept by. */
        const at = (element: HTMLElement, y: number): Anchor => { const rect = element.getBoundingClientRect();
            return { element, fraction: rect.height ? (y - rect.top) / rect.height : 0,
                offset: y - container.getBoundingClientRect().top }; };
        const update = () => {
            setShowScrollButton(container.scrollHeight - container.scrollTop - container.clientHeight > 10);
            const top = container.getBoundingClientRect().top;
            const element = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]"))
                .find((candidate) => candidate.getBoundingClientRect().bottom > top);
            anchor.current = element ? at(element, Math.max(element.getBoundingClientRect().top, top)) : null;
        };
        reanchor.current = update;
        container.addEventListener("scroll", update);
        const observer = new ResizeObserver(() => {
            const held = anchor.current;
            if (held?.element.isConnected) { const rect = held.element.getBoundingClientRect();
                container.scrollTop += rect.top + held.fraction * rect.height
                    - container.getBoundingClientRect().top - held.offset; }
            update();
        });
        const content = messagesEndRef.current?.parentElement;
        if (content) observer.observe(content);
        observer.observe(container);
        const frame = requestAnimationFrame(update);
        return () => {
            cancelAnimationFrame(frame); observer.disconnect();
            container.removeEventListener("scroll", update);
        };
    }, []);
    useLayoutEffect(() => {
        const container = messagesContainerRef.current;
        const searchKey = searchMessageId ? JSON.stringify([chatId, searchMessageId]) : null;
        if (searchKey !== scrolledSearch.current && searchMessageId && container) {
            const target = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]"))
                .find((element) => element.dataset.messageId === searchMessageId);
            if (target) {
                target
                    .scrollIntoView({ block: "center", behavior: "auto" });
                scrolledSearch.current = searchKey; reanchor.current();
                return;
            }
        }
        if (!searchKey) scrolledSearch.current = null;
        const element = latestUserMessageRef.current;
        if (messages.length && container && element) {
            container.scrollTo({ top: element.offsetTop - 24, behavior: "auto" });
            reanchor.current();
        }
    }, [chatId, messages.length, searchMessageId]);

    const handleEditResolveStart = (args: EditResolveStart) => {
        setEditState((state) => ({ ...state,
            docIds: new Set(state.docIds).add(args.documentId),
            editIds: new Set(state.editIds).add(args.editId) }));
        onEditResolveStart?.(args);
    };
    const handleEditResolved = (args: EditResolved) => {
        setEditState((state) => ({
            docIds: without(state.docIds, args.documentId),
            editIds: without(state.editIds, args.editId),
            statuses: { ...state.statuses, [args.editId]: args.status },
        }));
        if (onEditResolved) onEditResolved(args);
        else invalidateDocumentFile(args.documentId);
    };
    const handleEditError = (args: EditResolveError) => {
        setEditState((state) => ({ ...state,
            docIds: without(state.docIds, args.documentId),
            editIds: without(state.editIds, args.editId) }));
        onEditError?.(args);
    };
    const mergedStatuses = { ...resolvedEditStatuses, ...editState.statuses };
    // Defined here rather than inline in the loop, so each message receives the same
    // functions from one render to the next and finished messages are not re-rendered.
    const docReloading = (id: string) => editState.docIds.has(id) || !!isDocReloading?.(id);
    const editReloading = (id: string) => editState.editIds.has(id) || !!isEditReloading?.(id);
    // The reading column is a plain CSS measure: side panels take their space, the column is
    // never wider than the room it has, and its width never depends on the dock's state.
    const columnClass = gutterVisible ? "ms-auto me-0" : "mx-auto";

    return (
        <div data-dock-host className="h-full w-full flex relative">
            <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                {responseAnnouncement}
            </div>
            <div className="flex min-w-0 flex-col h-full flex-1 relative">
                <div ref={messagesContainerRef}
                    className="flex-1 w-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                    style={{ scrollbarGutter: "auto" }}>
                    <div className={`${CHAT_COLUMN_CLASS} min-h-full flex flex-col relative ${layout === "panel" ? "px-4 pt-4" : "px-4 pt-6 md:px-8 md:pt-8"} ${columnClass}`}
                        style={{ paddingBottom: 116 }}>
                        <div className="space-y-6 md:space-y-8">
                            {moreAbove && <div ref={earlierRef} aria-hidden="true" className="h-px" />}
                            {messages.slice(shownFrom).map((message, offset) => { const index = shownFrom + offset; return (
                                <div key={message.id} data-message-id={message.id}
                                    style={index < lastUserIndex && message.id !== searchMessageId ? {
                                        contentVisibility: "auto",
                                        containIntrinsicBlockSize: message.role === "user" ? "auto 80px" : "auto 400px",
                                    } : undefined}
                                    ref={index === lastUserIndex ? latestUserMessageRef : null}>
                                    {message.role === "user" ? (
                                        <UserMessage content={message.content ?? ""} files={message.files}
                                            workflow={message.workflow} />
                                    ) : (
                                        <AssistantMessage
                                            actions={message.contentFinal && !session.run ? messageActions?.(message.id) : undefined}
                                            message={message} isStreaming={index === messages.length - 1 &&
                                                responseInProgress && !message.contentFinal}
                                            onCitationClick={onCitationClick} citationTitle={citationTitle}
                                            onWorkflowRunClick={onWorkflowRunClick} onReaderClick={onReaderClick}
                                            minHeight={message.turnStatus ? "0px"
                                                : index === lastAssistantIndex
                                                  ? layout === "panel" ? "0px"
                                                    : "calc(100dvh - 16rem)"
                                                  : "0px"}
                                            onEditViewClick={onEditViewClick} onOpenDocument={onOpenDocument}
                                            onEditResolveStart={handleEditResolveStart}
                                            onEditResolved={handleEditResolved} onEditError={handleEditError}
                                            isDocReloading={docReloading}
                                            isEditReloading={editReloading}
                                            resolvedEditStatuses={mergedStatuses} />
                                    )}
                                    {message.role === "assistant" && message.turnStatus && (
                                        <div role="status" className={`mt-2 flex items-center gap-1.5 text-xs ${message.turnStatus === "interrupted" ? "text-red-700" : "text-gray-500"}`}>
                                            <CircleStop className="size-3.5" aria-hidden="true" />
                                            <span>{message.turnStatus === "cancelled"
                                                ? "Response stopped" : "Response interrupted"}</span>
                                        </div>
                                    )}
                                </div>
                            ); })}
                            {afterMessages}
                            <div ref={messagesEndRef} />
                        </div>
                    </div>
                </div>
                <div className="absolute bottom-3 left-0 right-0 w-full z-30">
                    <div className={`relative ${CHAT_COLUMN_CLASS} px-2 md:px-6 ${columnClass}`}>
                        {showScrollButton && !activeInput && (
                            <button type="button" aria-label="Scroll to latest message" onClick={() =>
                                { messagesEndRef.current?.scrollIntoView({ behavior: "auto" }); reanchor.current(); }}
                                className="absolute bottom-[calc(100%+1rem)] left-1/2 z-20 -translate-x-1/2 cursor-pointer rounded-full border border-gray-300 bg-white p-2 text-gray-500 hover:bg-gray-100">
                                <ArrowDown className="h-6 w-6" />
                            </button>
                        )}
                        {activeInput && (
                            <div data-ask-input-dock className="absolute inset-x-4 bottom-[calc(100%+0.5rem)] md:inset-x-6">
                                <AskInputPopup key={activeInput.key} event={activeInput.event}
                                    onSubmit={(response, content, files) => {
                                        setHiddenAskInputKey(activeInput.key);
                                        void handleChat({ role: "user", content, files }, { askInputsResponse: response });
                                    }}
                                    onDismiss={() => { setHiddenAskInputKey(activeInput.key); cancel(); }} />
                            </div>
                        )}
                        {rejectedTurn && <div role="status" className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700">
                            <span className="min-w-0 flex-1">{rejectedTurn.detail ?? (rejectedTurn.options?.askInputsResponse
                                ? "Inputs not sent. Your selections were kept." : "Response interrupted. Your draft is ready to edit.")}</span>
                            {onRetryRejectedTurn && rejectedTurn.retryable !== false && <Button variant="outline" size="compact" onClick={() => {
                                if (!rejectedTurn.options?.askInputsResponse) chatInputRef.current?.clearDraft();
                                onRetryRejectedTurn();
                            }}>Retry</Button>}
                            <Button variant="ghost" size="compact" onClick={() => onRejectedTurnRestored?.()}>Dismiss</Button>
                        </div>}
                        <ChatInput
                            key={chatId} draftChatId={chatId} initialDraft={initialDraft}
                            ref={chatInputRef} onSubmit={onSubmit}
                            promptHistory={messages.flatMap((message) =>
                                message.role === "user" && (message.content ?? "").trim()
                                    ? [message.content ?? ""] : [])}
                            onCancel={() => {
                                if (activeInput) setHiddenAskInputKey(activeInput.key);
                                cancel();
                            }}
                            isLoading={session.run !== null || !!activeInput} disabled={sendDisabled}
                            contextUsage={session.contextUsage || session.compaction === "running" ? {
                                usedTokens: session.contextUsage?.usedTokens ?? 0,
                                windowTokens: session.contextUsage?.windowTokens ?? 1,
                                compacting: session.compaction === "running",
                            } : undefined}
                            showContextTools={showContextTools} rows={layout === "panel" ? 2 : 1}
                            onOpenWorkflows={onOpenWorkflows} onOrganize={onOrganize} projectName={projectName}
                            projectCmNumber={projectCmNumber} initialModel={initialModel}
                            initialReasoningEffort={initialReasoningEffort}
                            editModeLabels={editModeLabels} restoreDraft={rejectedTurn?.options?.askInputsResponse
                                ? null : rejectedTurn?.message} />
                    </div>
                </div>
            </div>
            {dock}
        </div>
    );
});
