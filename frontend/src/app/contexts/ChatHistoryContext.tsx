import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import {
  createChat,
  deleteChat,
  getChat,
  listChats,
  renameChat,
  updateChatProject,
  type ChatDetail,
  type Chat,
  type Message,
} from "@/app/lib/api/chat";

import { useAuth } from "./AuthContext";

type PreparedChat = { id: string; at: number; result: Promise<ChatDetail>; detail: ChatDetail | null };
type ProjectMoveListener = (chatId: string, projectId: string | null) => void;

type Context = {
  chats: Chat[] | null;
  onProjectMove: (listener: ProjectMoveListener) => () => void;
  moveChat: (id: string, projectId: string | null) => Promise<void>;
  hasMoreChats: boolean;
  prepareChat: (id: string) => void;
  takePreparedChat: (id: string) => PreparedChat | null;
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
  const prepared = useRef<PreparedChat | null>(null);
  useEffect(() => { prepared.current = null; }, [user]);
  const projectMoveListeners = useRef(new Set<ProjectMoveListener>());
  const onProjectMove = useCallback((listener: ProjectMoveListener) => {
    projectMoveListeners.current.add(listener);
    return () => { projectMoveListeners.current.delete(listener); };
  }, []);
  const pending = useRef<{ id: string; message: Message } | null>(null);
  const listRequest = useRef(0);

  const loadChats = useCallback(async () => {
    const request = ++listRequest.current;
    if (!user) {
      setChats([]);
      setHasMore(false);
      return;
    }
    try {
      const rows = await listChats({ limit: limit + 1 });
      if (request !== listRequest.current) return;
      const next = rows.slice(0, limit);
      setChats((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
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
    } else {
      void loadChats();
    }
  }, [loadChats, pathname, user]);

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

  const value = useMemo<Context>(() => ({
    chats,
    onProjectMove,
    moveChat: async (id, projectId) => {
      const updated = await updateChatProject(id, projectId);
      setChats((current) => current?.map((chat) => chat.id === id
        ? { ...chat, project_id: updated.project_id } : chat) ?? null);
      if (prepared.current?.id === id) prepared.current = null;
      for (const listener of projectMoveListeners.current) listener(id, updated.project_id);
    },
    hasMoreChats,
    prepareChat: (id) => {
      if (prepared.current?.id === id && Date.now() - prepared.current.at < 5_000) return;
      const result = getChat(id);
      const entry: PreparedChat = { id, at: Date.now(), result, detail: null };
      prepared.current = entry;
      void result.then((detail) => { entry.detail = detail; })
        .catch(() => { if (prepared.current === entry) prepared.current = null; });
    },
    takePreparedChat: (id) => {
      const entry = prepared.current;
      prepared.current = null;
      return entry?.id === id && Date.now() - entry.at < 5_000 ? { ...entry } : null;
    },
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
  }), [chats, onProjectMove, hasMoreChats, loadChats, saveChat, claimPendingChatMessage, setChatTurnInProgress]);
  return <ChatHistoryContext.Provider value={value}>{children}</ChatHistoryContext.Provider>;
}

export function useChatHistoryContext() {
  const value = useContext(ChatHistoryContext);
  if (!value) throw new Error("useChatHistoryContext must be used within ChatHistoryProvider");
  return value;
}
