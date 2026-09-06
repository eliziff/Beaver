import { Link } from "react-router-dom";
import type { Chat } from "@/app/lib/api/chat";
import { HighlightedText } from "../ui/HighlightedText";
import { APP_SURFACE_ACTIVE_CLASS, APP_SURFACE_HOVER_CLASS } from "../ui/liquid-surface";
import { GfmMarkdown, MessageSearchHighlight } from "./message/MarkdownContent";
import { chatSearchPath } from "./chatSearch";
import { ChatSkeuoIcon, TabularReviewSkeuoIcon } from "../shared/AppSidebarSkeuoIcons";

export function ChatSearchResult({ chat, query, onNavigate, compact = false, isActive = false }: {
    chat: Chat; query: string; onNavigate?: () => void; compact?: boolean; isActive?: boolean;
}) {
    const date = chat.updated_at ?? chat.created_at;
    const Icon = chat.tabular_review_id ? TabularReviewSkeuoIcon : ChatSkeuoIcon;
    return <Link to={chatSearchPath(chat)} onClick={onNavigate}
        data-chat-id={chat.id} aria-label={chat.title ?? "Untitled chat"}
        aria-current={isActive ? "page" : undefined}
        className={`block min-w-0 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gray-900 ${APP_SURFACE_HOVER_CLASS} ${isActive ? APP_SURFACE_ACTIVE_CLASS : ""} ${compact ? "px-2 py-1" : "border-b border-gray-200 px-2 py-2 last:border-b-0"}`}>
        <div className="flex min-w-0 items-center gap-2">
        <Icon aria-label={chat.tabular_review_id ? "Tabular review" : "Chat"} className="size-3.5 shrink-0" />
        <span className={`min-w-0 flex-1 truncate font-medium text-gray-900 ${compact ? "text-xs" : "text-sm"}`}>
            <HighlightedText text={chat.title ?? "Untitled chat"} query={query} />
        </span>
        {!compact && <time className="shrink-0 text-[11px] text-gray-500" dateTime={date}>{new Date(date).toLocaleDateString(undefined, {
                month: "short", day: "numeric", year: "numeric",
            })}</time>}
        </div>
        {chat.search_hit?.snippet && (chat.search_hit.message_id || chat.search_hit.snippet !== chat.title) && <div className={`mt-0.5 break-words text-gray-600 ${compact ? "line-clamp-1 text-xs leading-4" : "line-clamp-2 text-[13px] leading-4"}`}>
            <MessageSearchHighlight value={query}>
                <GfmMarkdown allowedElements={["mark"]} unwrapDisallowed skipHtml>
                    {chat.search_hit.snippet}
                </GfmMarkdown>
            </MessageSearchHighlight>
        </div>}
    </Link>;
}
