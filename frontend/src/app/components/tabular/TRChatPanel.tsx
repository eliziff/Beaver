"use client";
import {
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    MoreHorizontal,
    Plus,
    Search,
    Square,
    ArrowRight,
    ChevronDown,
    X,
} from "lucide-react";
import {
    streamTabularChat,
    getTabularChats,
    getTabularChatMessages,
    deleteTabularChat,
    renameTabularChat,
    mapTRMessages,
    type TRChat,
    type TRCitationAnnotation,
} from "@/app/lib/beaverApi";
import { readSseData } from "@/app/lib/sse";
import type { AssistantEvent } from "../shared/types";
import {
    ModelToggle,
    ReasoningEffortToggle,
} from "../assistant/ModelToggle";
import { ApiKeyMissingPopup } from "../popups/ApiKeyMissingPopup";
import { PreResponseWrapper } from "../assistant/PreResponseWrapper";
import {
    DocReadBlock,
    EventBlock,
    ReasoningBlock,
} from "../assistant/message/EventBlocks";
import {
    activityLabel,
    dedupeActivityEntries,
} from "../assistant/message/eventUtils";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    useSelectedModel,
    useSelectedReasoningEffort,
} from "@/app/hooks/useSelectedModel";
import {
    getModelProvider,
    isModelAvailable,
    type ModelProvider,
} from "@/app/lib/modelAvailability";
import type { ApiKeyState } from "@/app/lib/beaverApi";
import {
    APP_SURFACE_ACTIVE_CLASS,
    APP_SURFACE_HOVER_CLASS,
    LIQUID_PANEL_SURFACE_CLASS,
} from "@/app/components/ui/liquid-surface";
import {
    HORIZONTAL_RESIZE_HANDLE_CLASS,
    horizontalDrag,
} from "@/app/components/ui/horizontal-drag";
import { NativeActionSelect } from "@/app/components/ui/native-action-select";
import { cn } from "@/app/lib/utils";
import {
    isStreamingPlaceholder,
    reduceAssistantStreamEvent,
} from "@/app/lib/assistantStreamEvents";
interface TRMessage {
    role: "user" | "assistant";
    content: string;
    events?: AssistantEvent[];
    annotations?: TRCitationAnnotation[];
    isStreaming?: boolean;
}
interface Props {
    reviewId: string;
    reviewTitle?: string | null;
    projectName?: string | null;
    onCitationClick: (colIdx: number, rowIdx: number) => void;
    onClose: () => void;
    initialChatId?: string | null;
    onChatIdChange?: (chatId: string | null) => void;
}
function preprocessTRCitations(
    text: string,
    annotations: TRCitationAnnotation[],
    citationsList: TRCitationAnnotation[],
): string {
    return text.replace(/\[(\d+(?:,\s*\d+)*)\]/g, (full, refsStr) => {
        const refs = (refsStr as string)
            .split(",")
            .map((s: string) => parseInt(s.trim(), 10));
        const tokens = refs.flatMap((ref: number) => {
            const ann = annotations.find((a) => a.ref === ref);
            if (!ann) return [];
            const idx = citationsList.length;
            citationsList.push(ann);
            return [`\`§${idx}§\`\u200B`];
        });
        return tokens.length > 0 ? tokens.join("") : full;
    });
}
function TRAssistantMessage({
    msg,
    onCitationClick,
}: {
    msg: TRMessage;
    onCitationClick: (colIdx: number, rowIdx: number) => void;
}) {
    const annotations = msg.annotations ?? [];
    const citationsList: TRCitationAnnotation[] = [];
    const processedTexts: string[] = (msg.events ?? []).map((e) =>
        e.type === "content"
            ? preprocessTRCitations(e.text, annotations, citationsList)
            : "",
    );
    const events = msg.events ?? [];
    const rawActivityEntries = events.flatMap((event, index) =>
        event.type === "reasoning" ||
        event.type === "doc_read" ||
        event.type === "thinking"
            ? [{ event, index }]
            : [],
    );
    const activityEntries = dedupeActivityEntries(rawActivityEntries);
    const activityEvents = activityEntries.map(({ event }) => event);
    const contentEntries = events.flatMap((event, index) =>
        event.type === "content" ? [{ event, index }] : [],
    );
    const latestActivityLabel = [...activityEvents]
        .reverse()
        .map(activityLabel)
        .find((label): label is string => !!label);
    const renderPreEvent = (
        event: AssistantEvent,
        index: number,
        allEvents: AssistantEvent[],
        key: number,
    ) => {
        const nextEvent = allEvents[index + 1];
        const showConnector =
            nextEvent !== undefined && nextEvent.type !== "content";
        if (event.type === "reasoning") {
            return (
                <ReasoningBlock
                    key={key}
                    text={event.text}
                    isStreaming={!!event.isStreaming && !!msg.isStreaming}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_read") {
            return (
                <DocReadBlock
                    key={key}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    showConnector={showConnector}
                    showFileIcon={false}
                />
            );
        }
        if (event.type === "thinking") {
            return (
                <EventBlock
                    key={key}
                    showConnector={showConnector}
                    isStreaming
                >
                    <span>Thinking...</span>
                </EventBlock>
            );
        }
        return null;
    };
    const renderContent = (text: string, key: number) => (
        <div
            key={key}
            className="prose prose-sm max-w-none text-sm leading-relaxed"
        >
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    p: ({ node, ...props }) => (
                        <p className="mb-2 leading-6" {...props} />
                    ),
                    ul: ({ node, ...props }) => (
                        <ul
                            className="list-disc list-outside mb-2 pl-4"
                            {...props}
                        />
                    ),
                    ol: ({ node, ...props }) => (
                        <ol
                            className="list-decimal list-outside mb-2 pl-4"
                            {...props}
                        />
                    ),
                    li: ({ node, ...props }) => (
                        <li className="mb-0.5 leading-6" {...props} />
                    ),
                    strong: ({ node, ...props }) => (
                        <strong className="font-semibold" {...props} />
                    ),
                    code: ({ children }) => {
                        const codeText = String(children);
                        const citMatch = codeText.match(/^§(\d+)§$/);
                        if (citMatch) {
                            const idx = parseInt(citMatch[1]);
                            const cit = citationsList[idx];
                            if (cit) {
                                return (
                                    <button
                                        onClick={() =>
                                            onCitationClick(
                                                cit.col_index,
                                                cit.row_index,
                                            )
                                        }
                                        title={`${cit.col_name} · ${cit.doc_name.replace(/\.[^.]+$/, "")}`}
                                        className="mx-0.5 inline-flex items-center justify-center rounded-full w-4 h-4 text-[10px] font-medium bg-gray-100 text-gray-900 hover:bg-gray-200 align-super font-serif"
                                    >
                                        {cit.ref}
                                    </button>
                                );
                            }
                        }
                        return (
                            <code className="bg-gray-100 px-1 py-0.5 rounded text-xs font-mono">
                                {children}
                            </code>
                        );
                    },
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
    return (
        <div className="text-gray-900 font-serif">
            {(activityEntries.length > 0 ||
                contentEntries.length > 0 ||
                msg.isStreaming) && (
                <div className="flex flex-col gap-2.5">
                    {(activityEntries.length > 0 || msg.isStreaming) && (
                        <PreResponseWrapper
                            isStreaming={
                                !!msg.isStreaming ||
                                activityEvents.some(
                                    (event) =>
                                        "isStreaming" in event &&
                                        !!event.isStreaming,
                                )
                            }
                            compact
                            label={latestActivityLabel ?? "Thinking"}
                        >
                            {activityEntries.length > 0
                                ? activityEntries.map(
                                      ({ event, index }, i) =>
                                          renderPreEvent(
                                              event,
                                              i,
                                              activityEvents,
                                              index,
                                          ),
                                  )
                                : undefined}
                        </PreResponseWrapper>
                    )}
                    {contentEntries.map(({ index }) =>
                        renderContent(
                            processedTexts[index],
                            index,
                        ),
                    )}
                </div>
            )}
        </div>
    );
}
function TRChatInput({
    isLoading,
    onSubmit,
    onCancel,
    apiKeys,
    onHeightChange,
}: {
    isLoading: boolean;
    onSubmit: (value: string, model: string, effort?: string) => void;
    onCancel: () => void;
    apiKeys?: ApiKeyState;
    onHeightChange: (height: number) => void;
}) {
    const [value, setValue] = useState("");
    const [model, setModel] = useSelectedModel();
    const [reasoningEffort, setReasoningEffort] = useSelectedReasoningEffort();
    const rootRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        const notify = () => {
            onHeightChange(root.getBoundingClientRect().height);
        };
        notify();
        const observer = new ResizeObserver(notify);
        observer.observe(root);
        return () => {
            observer.disconnect();
        };
    }, [onHeightChange]);
    function resizeTextarea(el: HTMLTextAreaElement) {
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
        el.style.overflowY = el.scrollHeight > 192 ? "auto" : "hidden";
    }
    function resetTextarea() {
        if (!textareaRef.current) return;
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.overflowY = "hidden";
    }
    function handleAction() {
        if (isLoading) {
            onCancel();
            return;
        }
        const trimmed = value.trim();
        if (!trimmed) return;
        setValue("");
        resetTextarea();
        onSubmit(trimmed, model, reasoningEffort);
    }
    return (
        <div
            ref={rootRef}
            className="absolute bottom-0 left-0 right-0 z-10 bg-transparent px-3 pb-3"
        >
            <div className="flex flex-col gap-1 rounded-xl border border-gray-200 bg-white pt-2 pb-1.5 shadow-sm">
                <textarea
                    ref={textareaRef}
                    rows={2}
                    placeholder="How can I help?"
                    value={value}
                    onChange={(e) => {
                        setValue(e.target.value);
                        resizeTextarea(e.target);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleAction();
                        }
                    }}
                    className="w-full resize-none text-sm bg-transparent outline-none placeholder:text-gray-400 leading-6 max-h-48 overflow-hidden border-0 p-0 pl-3 pr-2 pt-0.5"
                />
                <div className="flex items-center justify-end gap-1.5 pl-1 pr-2">
                    <ReasoningEffortToggle
                        model={model}
                        value={reasoningEffort}
                        onChange={setReasoningEffort}
                    />
                    <ModelToggle
                        value={model}
                        onChange={setModel}
                        apiKeys={apiKeys}
                    />
                    <button
                        type="button"
                        onClick={handleAction}
                        disabled={!isLoading && !value.trim()}
                        className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] bg-brand text-white shadow-sm hover:bg-brand-dark disabled:cursor-default disabled:bg-gray-300 active:enabled:scale-95"
                    >
                        {isLoading ? (
                            <Square
                                className="h-3.5 w-3.5"
                                fill="currentColor"
                                strokeWidth={0}
                            />
                        ) : (
                            <ArrowRight className="h-3.5 w-3.5" />
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
function HistoryDropdown({
    chats,
    currentChatId,
    popoverId,
    onLoad,
    onRename,
    onDelete,
}: {
    chats: TRChat[];
    currentChatId: string | null;
    popoverId: string;
    onLoad: (chatId: string) => void;
    onRename: (chatId: string, title: string) => void;
    onDelete: (chatId: string) => void;
}) {
    const [query, setQuery] = useState("");
    const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const filtered = chats
        .filter((c) => c.id !== currentChatId)
        .filter((c) => {
            const label = c.title ?? "";
            return label.toLowerCase().includes(query.toLowerCase());
        });
    function commitRename(chatId: string) {
        const trimmed = renameValue.trim();
        setRenamingChatId(null);
        if (trimmed) onRename(chatId, trimmed);
    }
    return (
        <>
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/40">
                <Search className="h-3 w-3 text-gray-400 shrink-0" />
                <input
                    type="text"
                    placeholder="Search chats…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="flex-1 text-xs bg-transparent outline-none placeholder:text-gray-400 text-gray-700"
                />
            </div>
            <div className="max-h-48 overflow-y-auto p-1">
                {filtered.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-gray-400">
                        {chats.filter((c) => c.id !== currentChatId).length ===
                        0
                            ? "No previous chats."
                            : "No matches."}
                    </p>
                ) : (
                    filtered.map((chat) => {
                        const label = chat.title ?? "Chat";
                        if (renamingChatId === chat.id) {
                            return (
                                <input
                                    key={chat.id}
                                    autoFocus
                                    type="text"
                                    value={renameValue}
                                    onChange={(e) =>
                                        setRenameValue(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter")
                                            commitRename(chat.id);
                                        if (e.key === "Escape")
                                            setRenamingChatId(null);
                                    }}
                                    onBlur={() => commitRename(chat.id)}
                                    className={`w-full rounded-lg px-2 py-1.5 text-xs text-gray-700 outline-none ${APP_SURFACE_ACTIVE_CLASS}`}
                                />
                            );
                        }
                        return (
                            <div
                                key={chat.id}
                                className="group relative flex items-center"
                            >
                                <button
                                    onClick={() => onLoad(chat.id)}
                                    popoverTarget={popoverId}
                                    popoverTargetAction="hide"
                                    className="w-full min-w-0 rounded-lg px-2 py-1.5 pr-7 text-left truncate"
                                >
                                    {label}
                                </button>
                                <NativeActionSelect
                                    label={`Actions for ${label}`}
                                    items={[
                                        {
                                            label: "Rename",
                                            onSelect: () => {
                                                setRenameValue(
                                                    chat.title ?? "",
                                                );
                                                setRenamingChatId(chat.id);
                                            },
                                        },
                                        {
                                            label: "Delete",
                                            onSelect: () => onDelete(chat.id),
                                        },
                                    ]}
                                    className="absolute right-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                                    triggerClassName={`h-5 w-5 items-center justify-center rounded-md text-gray-500 hover:text-gray-800 ${APP_SURFACE_HOVER_CLASS}`}
                                >
                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                </NativeActionSelect>
                            </div>
                        );
                    })
                )}
            </div>
        </>
    );
}
const HEADER_PILL_CLASS =
    "flex shrink-0 items-center gap-1 rounded-full border border-gray-200 bg-app-surface px-1 py-0.5 shadow-sm";
const HEADER_PILL_BUTTON_CLASS = `flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-gray-500 hover:text-gray-900 ${APP_SURFACE_HOVER_CLASS}`;
export function TRChatPanel({
    reviewId,
    reviewTitle,
    projectName,
    onCitationClick,
    onClose,
    initialChatId,
    onChatIdChange,
}: Props) {
    const { profile } = useUserProfile();
    const apiKeys = profile?.apiKeys;
    const [apiKeyModalProvider, setApiKeyModalProvider] =
        useState<ModelProvider | null>(null);
    const [chats, setChats] = useState<TRChat[]>([]);
    const [currentChatId, setCurrentChatId] = useState<string | null>(
        initialChatId ?? null,
    );
    const currentChatTitle = chats.find(
        (chat) => chat.id === currentChatId,
    )?.title;
    const [messages, setMessages] = useState<TRMessage[]>([]);
    const historyPopoverId = useId();
    const [isLoading, setIsLoading] = useState(false);
    const [minHeight, setMinHeight] = useState("0px");
    const [panelWidth, setPanelWidth] = useState(380);
    const [inputHeight, setInputHeight] = useState(120);
    const resizePanel = horizontalDrag((deltaX) =>
        setPanelWidth((width) =>
            Math.min(800, Math.max(280, width - deltaX)),
        ),
    );
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    const eventsRef = useRef<AssistantEvent[]>([]);
    useEffect(() => {
        getTabularChats(reviewId)
            .then(setChats)
            .catch(() => {});
    }, [reviewId]);
    useEffect(() => {
        if (!initialChatId) return;
        getTabularChatMessages(reviewId, initialChatId)
            .then((raw) => setMessages(mapTRMessages(raw) as TRMessage[]))
            .catch(() => {});
    }, [reviewId]); // eslint-disable-line react-hooks/exhaustive-deps
    const onChatIdChangeRef = useRef(onChatIdChange);
    useEffect(() => {
        onChatIdChangeRef.current = onChatIdChange;
    });
    useEffect(() => {
        onChatIdChangeRef.current?.(currentChatId);
    }, [currentChatId]);
    useLayoutEffect(() => {
        const container = messagesContainerRef.current;
        const element = latestUserMessageRef.current;
        if (container && element) {
            container.scrollTop = Math.max(0, element.offsetTop - 44);
        }
    }, [messages.length]);
    useEffect(() => {
        const userEl = latestUserMessageRef.current;
        const containerEl = messagesContainerRef.current;
        if (!userEl || !containerEl) return;
        const BOTTOM_PAD = 96;
        const messageContainerTopPadding = 16;
        const messageGap = 16;
        setMinHeight(
            `${Math.max(0, containerEl.clientHeight - BOTTOM_PAD - userEl.offsetHeight - messageContainerTopPadding - messageGap)}px`,
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages.length, latestUserMessageRef.current]);
    function updateLatestAssistantMessage(
        updater: (message: TRMessage) => TRMessage,
    ) {
        setMessages((prev) => {
            const lastIndex = prev.length - 1;
            const last = prev[lastIndex];
            if (last?.role !== "assistant") return prev;
            const updated = [...prev];
            updated[lastIndex] = updater(last);
            return updated;
        });
    }
    function finishStreamingEvents() {
        const before = eventsRef.current;
        let changed = false;
        const after = before.flatMap((event) => {
            if (isStreamingPlaceholder(event)) {
                changed = true;
                return [];
            }
            if (event.type === "content" && event.isStreaming) {
                changed = true;
                return [{ type: "content" as const, text: event.text }];
            }
            return [event];
        });
        if (!changed) return;
        eventsRef.current = after;
        const snapshot = [...after];
        updateLatestAssistantMessage((message) => ({
            ...message,
            events: snapshot,
        }));
    }
    function handleNewChat() {
        setCurrentChatId(null);
        setMessages([]);
    }
    async function handleDeleteChat(chatId: string) {
        setChats((prev) => prev.filter((c) => c.id !== chatId));
        if (chatId === currentChatId) {
            setCurrentChatId(null);
            setMessages([]);
        }
        try {
            await deleteTabularChat(reviewId, chatId);
        } catch {
        }
    }
    async function handleRenameChat(chatId: string, title: string) {
        setChats((prev) =>
            prev.map((c) => (c.id === chatId ? { ...c, title } : c)),
        );
        try {
            await renameTabularChat(reviewId, chatId, title);
        } catch {
        }
    }
    async function handleLoadChat(chatId: string) {
        setCurrentChatId(chatId);
        setMessages([]);
        try {
            const raw = await getTabularChatMessages(reviewId, chatId);
            setMessages(mapTRMessages(raw) as TRMessage[]);
        } catch {
        }
    }
    function handleCancel() {
        abortRef.current?.abort();
    }
    async function handleSubmit(trimmed: string, model: string, effort?: string) {
        if (!trimmed || isLoading) return;
        if (apiKeys && !isModelAvailable(model, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(model));
            return;
        }
        const history: { role: string; content: string }[] = messages.map(
            (m) => ({
                role: m.role,
                content: m.content,
            }),
        );
        const allMessages = [...history, { role: "user", content: trimmed }];
        const userMsg: TRMessage = { role: "user", content: trimmed };
        const assistantMsg: TRMessage = {
            role: "assistant",
            content: "",
            events: [],
            isStreaming: true,
        };
        setMessages((prev) => [...prev, userMsg, assistantMsg]);
        setIsLoading(true);
        eventsRef.current = [];
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const response = await streamTabularChat(
                reviewId,
                allMessages,
                currentChatId,
                controller.signal,
                {
                    reviewTitle,
                    projectName,
                    model,
                    reasoningEffort: effort,
                },
            );
            if (!response.body) throw new Error("No response body");
            for await (const dataStr of readSseData(response.body)) {
                if (dataStr === "[DONE]") continue;
                try {
                    const data = JSON.parse(dataStr);
                        if (data.type === "chat_id") {
                            const newId = data.chatId as string;
                            setCurrentChatId(newId);
                            setChats((prev) =>
                                prev.some((c) => c.id === newId)
                                    ? prev
                                    : [
                                          {
                                              id: newId,
                                              title: null,
                                              created_at:
                                                  new Date().toISOString(),
                                              updated_at:
                                                  new Date().toISOString(),
                                          },
                                          ...prev,
                                      ],
                            );
                            continue;
                        }
                        if (data.type === "chat_title") {
                            const { chatId, title } = data as {
                                chatId: string;
                                title: string;
                            };
                            setChats((prev) =>
                                prev.map((c) =>
                                    c.id === chatId ? { ...c, title } : c,
                                ),
                            );
                            continue;
                        }
                        const reduction = reduceAssistantStreamEvent(
                            eventsRef.current,
                            data,
                        );
                        if (reduction) {
                            eventsRef.current = reduction.events;
                            const snapshot = [...reduction.events];
                            updateLatestAssistantMessage((message) => ({
                                ...message,
                                events: snapshot,
                            }));
                            continue;
                        }
                        if (data.type === "citations") {
                            finishStreamingEvents();
                            const incoming = (data.citations ??
                                []) as TRCitationAnnotation[];
                            updateLatestAssistantMessage((message) => ({
                                ...message,
                                annotations: incoming,
                            }));
                            continue;
                        }
                } catch {
                }
            }
            finishStreamingEvents();
            updateLatestAssistantMessage((message) => ({
                ...message,
                isStreaming: false,
            }));
        } catch (err: unknown) {
            const isAbort = err instanceof Error && err.name === "AbortError";
            finishStreamingEvents();
            updateLatestAssistantMessage((last) => {
                const hasContent = (last.events ?? []).some(
                    (event) =>
                        event.type === "content" &&
                        (event as { type: "content"; text: string }).text,
                );
                if (hasContent) return { ...last, isStreaming: false };
                return {
                    ...last,
                    isStreaming: false,
                    events: [
                        ...(last.events ?? []),
                        {
                            type: "content" as const,
                            text: isAbort
                                ? ""
                                : "An error occurred. Please try again.",
                        },
                    ],
                };
            });
        } finally {
            setIsLoading(false);
            abortRef.current = null;
        }
    }
    const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
    const lastAssistantIdx = messages.findLastIndex(
        (m) => m.role === "assistant",
    );
    return (
        <div
            style={
                {
                    "--tr-chat-panel-width": `${panelWidth}px`,
                } as CSSProperties
            }
            className={cn(
                "flex flex-col relative",
                "flex-1 min-w-0 mx-3 mb-3 md:flex-none md:w-[var(--tr-chat-panel-width)] md:mt-12 md:-ml-4 md:mr-6",
                LIQUID_PANEL_SURFACE_CLASS,
                "overflow-hidden",
            )}
        >
            <div
                onPointerDown={resizePanel}
                className={cn(
                    "absolute left-0 top-0 z-20 hidden h-full w-1 md:block",
                    HORIZONTAL_RESIZE_HANDLE_CLASS,
                )}
            />
            {/* Header — fixed, overlaid on top of the messages */}
            <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between gap-2 px-2 py-2">
                {/* Title pill — opens chat history */}
                <div className="relative shrink min-w-0">
                    <div className={cn(HEADER_PILL_CLASS, "min-w-0")}>
                        <button
                            popoverTarget={historyPopoverId}
                            title="Chat history"
                            className={`flex h-5 min-w-0 items-center gap-1 rounded-full px-1.5 text-gray-700 ${APP_SURFACE_HOVER_CLASS}`}
                        >
                            <span className="min-w-0 truncate text-xs font-medium">
                                {currentChatTitle ?? "New chat"}
                            </span>
                            <ChevronDown className="h-3 w-3 shrink-0 text-gray-500" />
                        </button>
                    </div>
                    <div
                        id={historyPopoverId}
                        popover="auto"
                        className="fixed inset-0 m-auto h-fit max-h-[80vh] w-64 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-gray-300 bg-white"
                    >
                        <HistoryDropdown
                            chats={chats}
                            currentChatId={currentChatId}
                            popoverId={historyPopoverId}
                            onLoad={handleLoadChat}
                            onRename={handleRenameChat}
                            onDelete={handleDeleteChat}
                        />
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    {/* New chat circle — only once a chat has started */}
                    {messages.length > 0 && (
                        <div className={cn(HEADER_PILL_CLASS, "px-0.5")}>
                            <button
                                onClick={handleNewChat}
                                title="New chat"
                                className={HEADER_PILL_BUTTON_CLASS}
                            >
                                <Plus className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    )}
                    {/* Close circle */}
                    <div className={cn(HEADER_PILL_CLASS, "px-0.5")}>
                        <button
                            onClick={onClose}
                            title="Close"
                            className={HEADER_PILL_BUTTON_CLASS}
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>
            </div>
            {/* Messages */}
            <div
                ref={messagesContainerRef}
                className="flex-1 overflow-y-auto px-4 pt-12 flex flex-col"
                style={{ paddingBottom: Math.ceil(inputHeight + 16) }}
            >
                {messages.length > 0 && (
                    <div className="flex flex-col gap-4">
                        {messages.map((msg, i) => (
                            <div
                                key={i}
                                ref={
                                    i === lastUserIdx
                                        ? latestUserMessageRef
                                        : null
                                }
                                style={
                                    i === lastAssistantIdx
                                        ? { minHeight }
                                        : undefined
                                }
                            >
                                {msg.role === "user" ? (
                                    <div className="flex justify-end">
                                        <div className="max-w-[90%] rounded-md bg-gray-100 px-3 py-2 text-xs text-gray-800 whitespace-pre-wrap">
                                            {msg.content}
                                        </div>
                                    </div>
                                ) : (
                                    <TRAssistantMessage
                                        msg={msg}
                                        onCitationClick={onCitationClick}
                                    />
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            {/* Input */}
            <TRChatInput
                isLoading={isLoading}
                onSubmit={handleSubmit}
                onCancel={handleCancel}
                apiKeys={apiKeys}
                onHeightChange={setInputHeight}
            />
            <ApiKeyMissingPopup
                open={apiKeyModalProvider !== null}
                provider={apiKeyModalProvider}
                onClose={() => setApiKeyModalProvider(null)}
            />
        </div>
    );
}
