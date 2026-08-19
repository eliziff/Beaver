import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { createChat, deleteChat, listChats, renameChat } from "@/app/lib/beaverApi";
import type { Chat, Message } from "@/app/components/shared/types";
import { useAuth } from "./AuthContext";

type Context = {
  chats: Chat[] | null;
  hasMoreChats: boolean;
  loadChats: () => Promise<void>;
  loadMoreChats: () => void;
  saveChat: (projectId?: string) => Promise<string | null>;
  renameChat: (id: string, title: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  stagePendingChatMessage: (id: string, message: Message) => void;
  peekPendingChatMessage: (id: string) => Message | null;
  claimPendingChatMessage: (id: string) => Message | null;
  replaceChatId: (oldId: string, newId: string, title?: string) => void;
  setChatTurnInProgress: (id: string, active: boolean) => void;
};

const ChatHistoryContext = createContext<Context | null>(null);
const INITIAL_LIMIT = 20;

export function ChatHistoryProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [hasMoreChats, setHasMore] = useState(false);
  const pending = useRef<{ id: string; message: Message } | null>(null);

  const loadChats = useCallback(async () => {
    if (!user) {
      setChats([]);
      setHasMore(false);
      return;
    }
    try {
      const rows = await listChats({ limit: limit + 1 });
      setChats(rows.slice(0, limit));
      setHasMore(rows.length > limit);
    } catch {
      // Retain the last usable list on a transient refresh failure.
    }
  }, [limit, user]);

  useEffect(() => {
    if (!user) {
      setChats([]);
      setLimit(INITIAL_LIMIT);
      setHasMore(false);
    } else if (pathname === "/assistant" || pathname.startsWith("/assistant/")) {
      void loadChats();
    }
  }, [limit, pathname, user]);

  const saveChat = useCallback(async (projectId?: string) => {
    try {
      const { id } = await createChat(projectId ? { project_id: projectId } : undefined);
      setChats((current) => [{
        id,
        project_id: projectId ?? null,
        user_id: user?.id ?? "",
        title: null,
        created_at: new Date().toISOString(),
      }, ...(current ?? [])]);
      return id;
    } catch {
      return null;
    }
  }, [user?.id]);
  const claimPendingChatMessage = useCallback((id: string) => {
    if (pending.current?.id !== id) return null;
    const message = pending.current.message;
    pending.current = null;
    return message;
  }, []);
  const setChatTurnInProgress = useCallback((id: string, active: boolean) => setChats((current) =>
    current?.map((chat) => chat.id === id ? { ...chat, turn_in_progress: active } : chat) ?? null), []);

  const value: Context = {
    chats,
    hasMoreChats,
    loadChats,
    loadMoreChats: () => setLimit((current) => current + 10),
    saveChat,
    renameChat: async (id, title) => {
      setChats((current) => current?.map((chat) => chat.id === id ? { ...chat, title } : chat) ?? []);
      try { await renameChat(id, title); } catch { await loadChats(); }
    },
    deleteChat: async (id) => {
      setChats((current) => current?.filter((chat) => chat.id !== id) ?? []);
      try { await deleteChat(id); } catch { await loadChats(); }
    },
    stagePendingChatMessage: (id, message) => { pending.current = { id, message }; },
    peekPendingChatMessage: (id) => pending.current?.id === id ? pending.current.message : null,
    claimPendingChatMessage,
    replaceChatId: (oldId, newId, title) => setChats((current) => {
      const unique = new Map((current ?? []).map((chat) => {
        const next = chat.id === oldId ? { ...chat, id: newId, title: title ?? chat.title } : chat;
        return [next.id, next];
      }));
      return [...unique.values()];
    }),
    setChatTurnInProgress,
  };
  return <ChatHistoryContext.Provider value={value}>{children}</ChatHistoryContext.Provider>;
}

export function useChatHistoryContext() {
  const value = useContext(ChatHistoryContext);
  if (!value) throw new Error("useChatHistoryContext must be used within ChatHistoryProvider");
  return value;
}
