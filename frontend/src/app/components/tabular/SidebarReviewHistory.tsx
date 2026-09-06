import { tabularReviewsCollection } from "@/app/lib/collectionKeys";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { SquarePen } from "lucide-react";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
import { listTabularReviews, type TabularReview } from "@/app/lib/api/tabular";
import { NewTRModal } from "./NewTRModal";
import { createTabularReviewPath } from "./tabularReviewRoute";
import { useAuth } from "@/app/contexts/AuthContext";
import { useChatSearch } from "../assistant/chatSearch";
import { ChatSearchResult } from "../assistant/ChatSearchResult";
import { HighlightedText } from "../ui/HighlightedText";

export function SidebarReviewHistory({ collapsed, search, onNavigate }: { collapsed: boolean; search: string; onNavigate?: () => void }) {
    const { pathname } = useLocation();
    const { user } = useAuth();
    const navigate = useNavigate();
    const [creating, setCreating] = useState(false);
    const q = search.trim();
    const conversations = useChatSearch({ search: q, search_context: "reviews" }, !!q);
    const page = usePagedQuery<TabularReview>((cursor, signal) =>
        listTabularReviews({ scope: "standalone", q, limit: 20, cursor }, signal), [user?.id, q], !!user, tabularReviewsCollection({ scope: "standalone", q, limit: 20 }));
    const lastPath = useRef(pathname);
    useEffect(() => {
        const previous = lastPath.current;
        lastPath.current = pathname;
        if (previous !== pathname && (previous.startsWith("/tabular-reviews") || pathname.startsWith("/tabular-reviews"))) void page.reload();
    }, [pathname, page.reload]);
    return <section aria-label="Tabular review history" className="mb-2">
        <button type="button" onClick={() => setCreating(true)} className="flex h-8 w-[calc(100%-2rem)] items-center gap-2 rounded-md px-2 text-xs font-medium text-gray-800 hover:bg-gray-100"><SquarePen className="size-3.5" />New review</button>
        {!collapsed && <>
            <div className="h-[clamp(2rem,calc(100dvh-33rem),10rem)] overflow-y-auto overscroll-contain ps-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {page.items.map((review) => <Link key={review.id} to={`/tabular-reviews/${review.id}`} onClick={onNavigate}
                    aria-current={pathname === `/tabular-reviews/${review.id}` ? "page" : undefined}
                    className={`block h-8 truncate rounded-md px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100 ${pathname === `/tabular-reviews/${review.id}` ? "bg-gray-100" : ""}`}><HighlightedText text={review.title || "Untitled review"} query={q} /></Link>)}
                {!page.items.length && !conversations.items.length && !page.error && !conversations.error && <p role="status" className="px-2 py-2 text-xs text-gray-500">{page.loading || q && conversations.loading ? "Searching…" : q ? "0 results" : "No reviews yet"}</p>}
                {!!page.error && <button type="button" onClick={() => void page.reload()} className="h-8 px-2 text-xs text-gray-600 hover:underline">Could not load reviews. Retry</button>}
                {page.hasMore && !page.error && <button type="button" disabled={page.loading} onClick={() => void page.loadMore()} className="h-8 px-2 text-xs text-gray-600 hover:underline disabled:opacity-50">{page.loading ? "Loading…" : "Load more"}</button>}
                {!!q && conversations.items.length > 0 && <>
                    <p className="px-2 pt-2 text-[11px] font-medium text-gray-500">Conversations</p>
                    {conversations.items.map((chat) => <ChatSearchResult key={chat.id} chat={chat} query={q} compact onNavigate={onNavigate} />)}
                    {conversations.hasMore && <button type="button" disabled={conversations.loading} onClick={() => void conversations.loadMore()} className="h-8 px-2 text-xs text-gray-600 hover:underline">More conversations</button>}
                </>}
                {!!q && !!conversations.error && <button type="button" onClick={() => void conversations.reload()} className="h-8 px-2 text-xs text-gray-600 hover:underline">Could not search conversations. Retry</button>}
            </div>
        </>}
        <NewTRModal open={creating} onClose={() => setCreating(false)} onAdd={async (title, projectId, documentIds, columnsConfig, workflowId) => {
            const path = await createTabularReviewPath({ title, project_id: projectId, document_ids: documentIds ?? [], columns_config: columnsConfig ?? [], workflow_id: workflowId });
            setCreating(false);
            navigate(path);
            onNavigate?.();
        }} />
    </section>;
}
