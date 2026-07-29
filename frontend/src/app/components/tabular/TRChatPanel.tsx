import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import {
    streamTabularChat,
    getTabularChats,
    getTabularChatMessages,
    mapTRMessages,
    type TRChat,
    type TRCitationAnnotation,
} from "@/app/lib/beaverApi";
import { readSseData } from "@/app/lib/sse";
import type { AssistantEvent, Citation, Message } from "../shared/types";
import { AssistantMessage } from "../assistant/AssistantMessage";
import { ChatInput } from "../assistant/ChatInput";
import { UserMessage } from "../assistant/UserMessage";
import {
    APP_SURFACE_HOVER_CLASS,
    LIQUID_PANEL_SURFACE_CLASS,
} from "@/app/components/ui/liquid-surface";
import { SearchableChoiceModal } from "../modals/ModalSelect";
import { cn } from "@/app/lib/utils";
import {
    finishAssistantStreamEvents,
    reduceAssistantStreamEvent,
} from "@/app/lib/assistantStreamEvents";
interface TRMessage {
    role: "user" | "assistant";
    content: string;
    events?: AssistantEvent[];
    annotations?: TRCitationAnnotation[];
}

function toAssistantCitation(annotation: TRCitationAnnotation): Citation {
    const documentId = `tabular-row-${annotation.row_index}`;
    return {
        type: "citation_data",
        kind: "document",
        ref: annotation.ref,
        doc_id: documentId,
        document_id: documentId,
        filename: annotation.doc_name,
        quotes: [{ quote: annotation.quote }],
    };
}
interface Props {
    reviewId: string;
    reviewTitle?: string | null;
    projectName?: string | null;
    onCitationClick: (colIdx: number, rowIdx: number) => void;
    onClose: () => void;
    chatId?: string | null;
    onChatIdChange: (chatId: string | null) => void;
}

const HEADER_BUTTON_CLASS = `flex h-7 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-app-surface px-2 text-gray-600 hover:text-gray-900 ${APP_SURFACE_HOVER_CLASS}`;
export function TRChatPanel({
    reviewId,
    reviewTitle,
    projectName,
    onCitationClick,
    onClose,
    chatId: currentChatId = null,
    onChatIdChange,
}: Props) {
    const [chats, setChats] = useState<TRChat[]>([]);
    const currentChatTitle = chats.find(
        (chat) => chat.id === currentChatId,
    )?.title;
    const [messages, setMessages] = useState<TRMessage[]>([]);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
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
        if (!currentChatId || abortRef.current) return;
        let cancelled = false;
        getTabularChatMessages(reviewId, currentChatId)
            .then((raw) => {
                if (!cancelled) {
                    setMessages(mapTRMessages(raw) as TRMessage[]);
                }
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [reviewId, currentChatId]);
    useLayoutEffect(() => {
        const container = messagesContainerRef.current;
        const element = latestUserMessageRef.current;
        if (container && element) {
            container.scrollTop = Math.max(0, element.offsetTop - 44);
        }
    }, [messages.length]);
    function updateLatestAssistantMessage(update: Partial<TRMessage>) {
        setMessages((prev) => {
            const last = prev.at(-1);
            if (last?.role !== "assistant") return prev;
            return [...prev.slice(0, -1), { ...last, ...update }];
        });
    }
    function publishFinishedEvents(annotations?: TRCitationAnnotation[]) {
        const events = finishAssistantStreamEvents(eventsRef.current);
        if (events === eventsRef.current && annotations === undefined) return;
        eventsRef.current = events;
        updateLatestAssistantMessage({
            events,
            ...(annotations === undefined ? {} : { annotations }),
        });
    }
    function handleLoadChat(chatId: string) {
        if (chatId === currentChatId) return;
        setMessages([]);
        onChatIdChange(chatId);
    }
    async function handleSubmit(message: Message) {
        const trimmed = message.content.trim();
        if (!trimmed || isLoading) return;
        const allMessages = [
            ...messages.map(({ role, content }) => ({ role, content })),
            { role: "user", content: trimmed },
        ];
        setMessages((prev) => [
            ...prev,
            { role: "user", content: trimmed },
            { role: "assistant", content: "", events: [] },
        ]);
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
                    model: message.model,
                    reasoningEffort: message.reasoningEffort,
                },
            );
            if (!response.body) throw new Error("No response body");
            for await (const dataStr of readSseData(response.body)) {
                if (dataStr === "[DONE]") continue;
                let data: Record<string, unknown>;
                try {
                    data = JSON.parse(dataStr) as Record<string, unknown>;
                } catch {
                    continue;
                }
                if (data.type === "chat_id") {
                    const id = data.chatId as string;
                    onChatIdChange(id);
                    setChats((prev) => {
                        if (prev.some((chat) => chat.id === id)) return prev;
                        const now = new Date().toISOString();
                        return [{ id, title: null, created_at: now, updated_at: now }, ...prev];
                    });
                    continue;
                }
                if (data.type === "chat_title") {
                    const id = data.chatId as string;
                    setChats((prev) =>
                        prev.map((chat) =>
                            chat.id === id ? { ...chat, title: data.title as string } : chat,
                        ),
                    );
                    continue;
                }
                if (data.type === "citations") {
                    publishFinishedEvents((data.citations ?? []) as TRCitationAnnotation[]);
                    continue;
                }
                const reduction = reduceAssistantStreamEvent(eventsRef.current, data);
                if (reduction) {
                    eventsRef.current = reduction.events;
                    updateLatestAssistantMessage({ events: [...reduction.events] });
                }
            }
            publishFinishedEvents();
        } catch (err: unknown) {
            const isAbort = err instanceof Error && err.name === "AbortError";
            let events = finishAssistantStreamEvents(eventsRef.current);
            if (!events.some((event) => event.type === "content" && event.text)) {
                events = [
                    ...events,
                    {
                        type: "content",
                        text: isAbort ? "" : "An error occurred. Please try again.",
                    },
                ];
            }
            if (events !== eventsRef.current) {
                eventsRef.current = events;
                updateLatestAssistantMessage({ events });
            }
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
            className={cn(
                "flex flex-col relative",
                "flex-1 min-w-0 mx-3 mb-3 md:flex-none md:w-[380px] md:mt-12 md:-ml-4 md:mr-6",
                LIQUID_PANEL_SURFACE_CLASS,
                "overflow-hidden",
            )}
        >
            <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between gap-2 px-2 py-2">
                <div className="min-w-0">
                    <button
                        type="button"
                        onClick={() => setHistoryOpen(true)}
                        title="Chat history"
                        className={cn(HEADER_BUTTON_CLASS, "min-w-0 max-w-48 gap-1")}
                    >
                        <span className="truncate text-xs font-medium">
                            {currentChatTitle ?? "New chat"}
                        </span>
                        <ChevronDown className="h-3 w-3" />
                    </button>
                    <SearchableChoiceModal
                        open={historyOpen}
                        onClose={() => setHistoryOpen(false)}
                        title="Chat history"
                        searchLabel="Search chats"
                        value={currentChatId}
                        options={chats.map(({ id, title }) => ({
                            value: id,
                            label: title ?? "Chat",
                        }))}
                        onChange={(chatId) => {
                            if (chatId) handleLoadChat(chatId);
                        }}
                    />
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    {messages.length > 0 && (
                        <button
                            onClick={() => {
                                onChatIdChange(null);
                                setMessages([]);
                            }}
                            title="New chat"
                            className={HEADER_BUTTON_CLASS}
                        >
                            <Plus className="h-3.5 w-3.5" />
                        </button>
                    )}
                    <button onClick={onClose} title="Close" className={HEADER_BUTTON_CLASS}>
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
            <div
                ref={messagesContainerRef}
                className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4 pt-12"
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
                            >
                                {msg.role === "user" ? (
                                    <UserMessage content={msg.content} />
                                ) : (
                                    <AssistantMessage
                                        events={msg.events}
                                        isStreaming={
                                            isLoading &&
                                            i === lastAssistantIdx
                                        }
                                        citations={(msg.annotations ?? []).map(
                                            toAssistantCitation,
                                        )}
                                        showCitationList={false}
                                        showCopyAction={false}
                                        minHeight={
                                            i === lastAssistantIdx
                                                ? "min(50vh, 28rem)"
                                                : "0px"
                                        }
                                        citationTitle={(citation) => {
                                            const annotation =
                                                msg.annotations?.find(
                                                    ({ ref }) =>
                                                        ref === citation.ref,
                                                );
                                            return annotation
                                                ? `${annotation.col_name} · ${annotation.doc_name.replace(/\.[^.]+$/, "")}`
                                                : "";
                                        }}
                                        onCitationClick={(citation) => {
                                            const annotation =
                                                msg.annotations?.find(
                                                    ({ ref }) =>
                                                        ref === citation.ref,
                                                );
                                            if (annotation) {
                                                onCitationClick(
                                                    annotation.col_index,
                                                    annotation.row_index,
                                                );
                                            }
                                        }}
                                    />
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            <div className="shrink-0 px-3 pb-3">
                <ChatInput
                    isLoading={isLoading}
                    onSubmit={(message) => void handleSubmit(message)}
                    onCancel={() => abortRef.current?.abort()}
                    showContextTools={false}
                    rows={2}
                />
            </div>
        </div>
    );
}
