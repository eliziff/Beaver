import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    createChat,
    deleteChat,
    listChats,
    renameChat,
} from "@/app/lib/beaverApi";
import type { Chat, Message } from "@/app/components/shared/types";
interface ChatHistoryContextType {
    chats: Chat[] | null;
    hasMoreChats: boolean;
    loadChats: () => Promise<void>;
    loadMoreChats: () => void;
    saveChat: (projectId?: string) => Promise<string | null>;
    renameChat: (chatId: string, title: string) => Promise<void>;
    stagePendingChatMessage: (chatId: string, message: Message) => void;
    peekPendingChatMessage: (chatId: string) => Message | null;
    claimPendingChatMessage: (chatId: string) => Message | null;
    replaceChatId: (
        oldChatId: string,
        newChatId: string,
        title?: string,
    ) => void;
    setChatTurnInProgress: (chatId: string, active: boolean) => void;
    deleteChat: (chatId: string) => Promise<void>;
}
const ChatHistoryContext = createContext<ChatHistoryContextType | undefined>(
    undefined,
);
const INITIAL_CHAT_LIMIT = 20;
const CHAT_LIMIT_INCREMENT = 10;
export function ChatHistoryProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const pathname = usePathname();
    const displaysAssistantHistory =
        pathname === null ||
        pathname === "/assistant" ||
        pathname.startsWith("/assistant/");
    const [chats, setChats] = useState<Chat[] | null>(null);
    const [chatLimit, setChatLimit] = useState(INITIAL_CHAT_LIMIT);
    const [hasMoreChats, setHasMoreChats] = useState(false);
    const pendingChatMessageRef = useRef<{
        chatId: string;
        message: Message;
    } | null>(null);
    const actions = useMemo(() => {
        const loadChats = async () => {
            if (!user) {
                setChats([]);
                setHasMoreChats(false);
                return;
            }
            try {
                const data = await listChats({ limit: chatLimit + 1 });
                setChats(data.slice(0, chatLimit));
                setHasMoreChats(data.length > chatLimit);
            } catch {}
        };
        return {
            loadChats,
            loadMoreChats: () =>
                setChatLimit((prev) => prev + CHAT_LIMIT_INCREMENT),
            saveChat: async (projectId?: string): Promise<string | null> => {
                try {
                    const { id } = await createChat(
                        projectId ? { project_id: projectId } : undefined,
                    );
                    const newChat: Chat = {
                        id,
                        project_id: projectId ?? null,
                        tabular_review_id: null,
                        user_id: user?.id ?? "",
                        title: null,
                        created_at: new Date().toISOString(),
                    };
                    setChats((prev) => [newChat, ...(prev ?? [])]);
                    return id;
                } catch {
                    return null;
                }
            },
            renameChat: async (chatId: string, title: string) => {
                setChats((prev) =>
                    (prev ?? []).map((chat) =>
                        chat.id === chatId ? { ...chat, title } : chat,
                    ),
                );
                try {
                    await renameChat(chatId, title);
                } catch {
                    void loadChats();
                }
            },
            deleteChat: async (chatId: string) => {
                setChats((prev) =>
                    (prev ?? []).filter((chat) => chat.id !== chatId),
                );
                try {
                    await deleteChat(chatId);
                } catch {
                    void loadChats();
                }
            },
            replaceChatId: (
                oldChatId: string,
                newChatId: string,
                title?: string,
            ) => {
                if (!oldChatId || !newChatId || oldChatId === newChatId) return;
                setChats((prev) => {
                    if (!prev) return prev;
                    const seen = new Set<string>();
                    return prev
                        .map((chat) =>
                            chat.id === oldChatId
                                ? {
                                      ...chat,
                                      id: newChatId,
                                      title: title ?? chat.title,
                                  }
                                : chat,
                        )
                        .filter((chat) => {
                            if (seen.has(chat.id)) return false;
                            seen.add(chat.id);
                            return true;
                        });
                });
            },
            setChatTurnInProgress: (chatId: string, active: boolean) => {
                setChats((prev) =>
                    prev?.map((chat) =>
                        chat.id === chatId
                            ? { ...chat, turn_in_progress: active }
                            : chat,
                    ) ?? prev,
                );
            },
            stagePendingChatMessage: (chatId: string, message: Message) => {
                pendingChatMessageRef.current = { chatId, message };
            },
            peekPendingChatMessage: (chatId: string) =>
                pendingChatMessageRef.current?.chatId === chatId
                    ? pendingChatMessageRef.current.message
                    : null,
            claimPendingChatMessage: (chatId: string) => {
                if (pendingChatMessageRef.current?.chatId !== chatId) {
                    return null;
                }
                const { message } = pendingChatMessageRef.current;
                pendingChatMessageRef.current = null;
                return message;
            },
        };
    }, [chatLimit, user]);
    useEffect(() => {
        if (!user) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- clear chat state on logout inside the effect that loads chats
            setChats([]);
            setChatLimit(INITIAL_CHAT_LIMIT);
            setHasMoreChats(false);
            return;
        }
        if (!displaysAssistantHistory) return;
        void actions.loadChats();
    }, [actions, displaysAssistantHistory, user]);
    const value = useMemo(
        () => ({ chats, hasMoreChats, ...actions }),
        [actions, chats, hasMoreChats],
    );
    return (
        <ChatHistoryContext.Provider value={value}>
            {children}
        </ChatHistoryContext.Provider>
    );
}
export function useChatHistoryContext() {
    const context = useContext(ChatHistoryContext);
    if (!context) {
        throw new Error(
            "useChatHistoryContext must be used within a ChatHistoryProvider",
        );
    }
    return context;
}
