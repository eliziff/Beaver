import { useAuth } from "@/app/contexts/AuthContext";
import { useDebounced } from "@/app/hooks/useDebounced";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
import { chatsCollection } from "@/app/lib/collectionKeys";
import { listChats, type Chat, type ChatSearchOptions } from "@/app/lib/api/chat";

export function useChatSearch(options: ChatSearchOptions, enabled = true) {
    const { user } = useAuth();
    const search = useDebounced(options.search);
    const identity = chatsCollection({ ...options, search });
    const scope = JSON.stringify([user?.id, options.search_scope, options.search_context,
        options.created_from, options.created_to, options.sort]);
    const page = usePagedQuery<Chat>(async (cursor, signal) => {
        const offset = Number(cursor ?? 0);
        const rows = await listChats({ ...options, search, offset, limit: 21 }, signal);
        return { items: rows.slice(0, 20), next_cursor: rows.length > 20 ? String(offset + 20) : null };
    }, [identity.key, user?.id], enabled && (search === options.search || !!search), identity, { scope, query: search ?? "" });
    return { ...page, searchQuery: page.displayQuery ?? "",
        loading: page.loading || page.refreshing || enabled && search !== options.search };
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
