import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { listChats, type Chat } from "@/app/lib/api/chat";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { ChatView } from "../assistant/ChatView";
import type { AssistantIntent } from "../assistant/assistantIntent";

import type { Citation } from "@/app/lib/citations";
import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
import { SearchableChoiceModal } from "../modals/ModalSelect";
import { cn } from "@/app/lib/utils";

interface Props {
    reviewId: string;
    onCitationClick: (colIdx: number, rowIdx: number) => void;
    chatId?: string | null;
    onChatIdChange: (chatId: string | null) => void;
    searchMessageId?: string | null;
    initialIntent?: AssistantIntent;
    workspaceReady?: boolean;
    onIntentSent?: () => void;
    onUpdated?: () => void;
}

const HEADER_BUTTON_CLASS = `flex h-7 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-app-surface px-2 text-gray-600 hover:text-gray-900 ${APP_SURFACE_HOVER_CLASS}`;

export function TRChatPanel({
    reviewId,
    onCitationClick,
    chatId: currentChatId = null,
    onChatIdChange, searchMessageId, initialIntent, workspaceReady = true, onIntentSent, onUpdated,
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
    const openCitation = (citation: Citation) => {
        if (citation.kind !== "tabular" || citation.review_id !== reviewId) {
            return false;
        }
        onCitationClick(citation.col_index, citation.row_index);
        return true;
    };
    const newChat = () => {
        onChatIdChange(null);
    };

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
                <div className="flex shrink-0 items-center gap-1.5">
                    {assistant.state.messages.length > 0 && (
                        <button
                            type="button"
                            onClick={newChat}
                            title="New chat"
                            className={HEADER_BUTTON_CLASS}
                        >
                            <Plus className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
            </div>
            <ChatView
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
                onCitationClick={openCitation}
                citationTitle={(citation) => citation.kind === "tabular"
                    ? `${citation.col_name} · ${citation.doc_name.replace(/\.[^.]+$/u, "")}`
                    : ""}
            />
        </div>
    );
}
