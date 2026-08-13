import { useEffect, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { getChat, listChats } from "@/app/lib/beaverApi";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { ChatView } from "../assistant/ChatView";
import type { Chat, Citation } from "../shared/types";
import {
    APP_SURFACE_HOVER_CLASS,
    LIQUID_PANEL_SURFACE_CLASS,
} from "@/app/components/ui/liquid-surface";
import { SearchableChoiceModal } from "../modals/ModalSelect";
import { cn } from "@/app/lib/utils";

interface Props {
    reviewId: string;
    onCitationClick: (colIdx: number, rowIdx: number) => void;
    onClose: () => void;
    chatId?: string | null;
    onChatIdChange: (chatId: string | null) => void;
}

const HEADER_BUTTON_CLASS = `flex h-7 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-app-surface px-2 text-gray-600 hover:text-gray-900 ${APP_SURFACE_HOVER_CLASS}`;

export function TRChatPanel({
    reviewId,
    onCitationClick,
    onClose,
    chatId: currentChatId = null,
    onChatIdChange,
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

    useEffect(() => {
        listChats({ tabular_review_id: reviewId })
            .then(setChats)
            .catch(() => setChats([]));
    }, [reviewId]);

    useEffect(() => {
        if (!currentChatId || assistant.isResponseLoading) return;
        let cancelled = false;
        getChat(currentChatId).then(({ chat, messages }) => {
            if (!cancelled) {
                assistant.openChat(
                    chat.id,
                    messages,
                    chat.transcript_version ?? 0,
                );
                if (chat.turn_in_progress) {
                    assistant.resumeRunningTurn(
                        chat.id,
                        chat.transcript_version ?? 0,
                    );
                }
            }
        }).catch(() => {
            if (!cancelled) onChatIdChange(null);
        });
        return () => { cancelled = true; };
        // openChat and resumeRunningTurn intentionally follow the selected ID.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentChatId, assistant.isResponseLoading]);

    const currentTitle = chats.find(({ id }) => id === currentChatId)?.title;
    const openCitation = (citation: Citation) => {
        if (citation.kind !== "tabular" || citation.review_id !== reviewId) {
            return false;
        }
        onCitationClick(citation.col_index, citation.row_index);
        return true;
    };
    const newChat = () => {
        assistant.openChat();
        onChatIdChange(null);
    };

    return (
        <div className={cn(
            "relative flex min-w-0 flex-1 flex-col overflow-hidden",
            "mx-3 mb-3 md:ml-[-1rem] md:mr-6 md:mt-12 md:w-[380px] md:flex-none",
            LIQUID_PANEL_SURFACE_CLASS,
        )}>
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
                            assistant.cancel();
                            onChatIdChange(chatId);
                        }
                    }}
                />
                <div className="flex shrink-0 items-center gap-1.5">
                    {assistant.messages.length > 0 && (
                        <button
                            type="button"
                            onClick={newChat}
                            title="New chat"
                            className={HEADER_BUTTON_CLASS}
                        >
                            <Plus className="h-3.5 w-3.5" />
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onClose}
                        title="Close"
                        className={HEADER_BUTTON_CLASS}
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
            <ChatView
                chatId={assistant.chatId}
                messages={assistant.messages}
                isResponseLoading={assistant.isResponseLoading}
                handleChat={assistant.handleChat}
                cancel={assistant.cancel}
                rejectedTurn={assistant.rejectedTurn}
                onRejectedTurnRestored={assistant.clearRejectedTurn}
                onRetryRejectedTurn={() => void assistant.retryRejectedTurn()}
                layout="panel"
                features={{ contextTools: false, dock: false }}
                onCitationClick={openCitation}
                citationTitle={(citation) => citation.kind === "tabular"
                    ? `${citation.col_name} · ${citation.doc_name.replace(/\.[^.]+$/u, "")}`
                    : ""}
            />
        </div>
    );
}
