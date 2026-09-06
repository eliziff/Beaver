import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
import { listChats, type Chat, type ChatSearchOptions } from "@/app/lib/api/chat";

export function useChatSearch(options: ChatSearchOptions, enabled = true) {
    const { chats } = useChatHistoryContext();
    const [search, setSearch] = useState(options.search);
    useEffect(() => {
        const timer = setTimeout(() => setSearch(options.search), 250);
        return () => clearTimeout(timer);
    }, [options.search]);
    const page = usePagedQuery<Chat>(async (cursor, signal) => {
        const offset = Number(cursor ?? 0);
        const rows = await listChats({ ...options, search, offset, limit: 21 }, signal);
        return { items: rows.slice(0, 20), next_cursor: rows.length > 20 ? String(offset + 20) : null };
    }, [search, options.search_scope, options.search_context, options.created_from, options.created_to, options.sort, chats], enabled);
    return { ...page, searchQuery: search ?? "", loading: page.loading || enabled && search !== options.search };
}

export function chatSearchPath(chat: Chat) {
    const base = chat.tabular_review_id ? `/tabular-reviews/${chat.tabular_review_id}` : `/assistant/chat/${chat.id}`;
    const params = new URLSearchParams();
    if (chat.tabular_review_id) params.set("chat", chat.id);
    if (chat.search_hit?.message_id) {
        params.set("message", chat.search_hit.message_id);
    }
    return `${base}${params.size ? `?${params}` : ""}`;
}
import { useEffect, useState } from "react";
