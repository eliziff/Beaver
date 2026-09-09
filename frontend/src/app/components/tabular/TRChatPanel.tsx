import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { listChats, type Chat } from "@/app/lib/api/chat";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { ChatView } from "../assistant/ChatView";
import type { AssistantIntent } from "../assistant/assistantIntent";

import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
import { SearchableChoiceModal } from "../modals/ModalSelect";
import { cn } from "@/app/lib/utils";

interface Props {
    reviewId: string;
    chatId?: string | null;
    onChatIdChange: (chatId: string | null) => void;
    searchMessageId?: string | null;
    initialIntent?: AssistantIntent;
    workspaceReady?: boolean;
    scopeLabel?: string; onClearScope?: () => void;
    onIntentSent?: () => void;
    onUpdated?: () => void;
    onUseAnswer?: (chatId: string, messageId: string) => Promise<void>;
}

const HEADER_BUTTON_CLASS = `flex h-7 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-app-surface px-2 text-gray-600 hover:text-gray-900 ${APP_SURFACE_HOVER_CLASS}`;

export function TRChatPanel({
    reviewId,
    chatId: currentChatId = null,
    onChatIdChange, searchMessageId, initialIntent, workspaceReady = true, scopeLabel, onClearScope, onIntentSent, onUpdated, onUseAnswer,
}: Props) {
    const [chats, setChats] = useState<Chat[]>([]);
    const [historyOpen, setHistoryOpen] = useState(false);
    const assistant = useAssistantChat({
        chatId: currentChatId ?? undefined,
        tabularReviewId: reviewId,
        onChatIdChange,
        onTitleChange: (chatId, title) => setChats((current) =>
            current.map((chat) => chat.id === chatId ? { ...chat, title } : chat)),
    });
    const wasRunning = useRef(false);
    useEffect(() => {
        if (wasRunning.current && !assistant.state.run) onUpdated?.();
        wasRunning.current = !!assistant.state.run;
    }, [assistant.state.run, onUpdated]);

    useEffect(() => {
        listChats({ tabular_review_id: reviewId })
            .then(setChats)
            .catch(() => setChats([]));
    }, [reviewId]);

    useEffect(() => {
        if (currentChatId && assistant.chatLoad.status === "error" && assistant.chatLoad.chatId === currentChatId) {
            onChatIdChange(null);
        }
    }, [assistant.chatLoad, currentChatId, onChatIdChange]);

    const currentTitle = chats.find(({ id }) => id === currentChatId)?.title;

    return (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="absolute inset-x-0 top-0 z-40 flex items-center justify-between gap-2 px-2 py-2">
                <button
                    type="button"
                    onClick={() => setHistoryOpen(true)}
                    title="Chat history"
                    className={cn(HEADER_BUTTON_CLASS, "min-w-0 max-w-48 gap-1")}
                >
                    <span className="truncate text-xs font-medium">
                        {currentTitle ?? "New chat"}
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
                        if (chatId && chatId !== currentChatId) {
                            assistant.actions.cancel();
                            onChatIdChange(chatId);
                        }
                    }}
                />
                    {assistant.state.messages.length > 0 && (
                        <button
                            type="button"
                            onClick={() => onChatIdChange(null)}
                            title="New chat"
                            className={HEADER_BUTTON_CLASS}
                        >
                            <Plus className="h-3.5 w-3.5" />
                        </button>
                    )}
            </div>
            {scopeLabel && <div className="mt-11 flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-1 text-xs text-gray-600">
                <span className="min-w-0 flex-1 truncate" title={scopeLabel}>{scopeLabel}</span>
                <button type="button" onClick={onClearScope} aria-label="Discuss all columns" className="shrink-0 underline">All columns</button>
            </div>}
            <ChatView
                onUseAnswer={onUseAnswer && assistant.state.chatId ? (messageId) => onUseAnswer(assistant.state.chatId!, messageId) : undefined}
                chatId={assistant.state.chatId}
                ready={workspaceReady && assistant.chatLoad.status === "loaded"}
                initialIntent={initialIntent} onIntentSent={onIntentSent}
                searchMessageId={searchMessageId}
                session={assistant.state}
                handleChat={assistant.actions.handleChat}
                cancel={assistant.actions.cancel}
                onRejectedTurnRestored={assistant.actions.clearRejectedTurn}
                onRetryRejectedTurn={() => void assistant.actions.retryRejectedTurn()}
                layout="panel"
                features={{ contextTools: false, dock: false, researchSave: false }}
                citationTitle={(citation) => citation.kind === "tabular"
                    ? `${citation.col_name} · ${citation.doc_name.replace(/\.[^.]+$/u, "")}`
                    : ""}
            />
        </div>
    );
}
