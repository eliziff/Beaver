import { useState } from "react";
import type { ChatSearchOptions } from "@/app/lib/api/chat";
import { Modal } from "../modals/Modal";
import { FormField } from "../modals/ModalFieldLabel";
import { ModalSelect } from "../modals/ModalSelect";
import { ModalTextInput } from "../modals/ModalTextInput";
import { SearchBar } from "../ui/search-bar";
import { Button } from "../ui/button";
import { useChatSearch } from "./chatSearch";
import { ChatSearchResult } from "./ChatSearchResult";

function dateBoundary(value: string, afterDay = false) {
    if (!value) return undefined;
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return undefined;
    if (afterDay) date.setDate(date.getDate() + 1);
    return date.toISOString();
}

export function AdvancedHistorySearch({ initialQuery, initialContext, onClose }: {
    initialQuery: string;
    initialContext: "assistant" | "reviews";
    onClose: () => void;
}) {
    const [query, setQuery] = useState(initialQuery);
    const [context, setContext] = useState<NonNullable<ChatSearchOptions["search_context"]>>(initialContext);
    const [scope, setScope] = useState<NonNullable<ChatSearchOptions["search_scope"]>>("all");
    const [sort, setSort] = useState<NonNullable<ChatSearchOptions["sort"]>>("newest");
    const [from, setFrom] = useState("");
    const [through, setThrough] = useState("");
    const invalidDates = !!from && !!through && from > through;
    const page = useChatSearch({ search: query.trim(), search_scope: scope,
        search_context: context, sort, created_from: dateBoundary(from), created_to: dateBoundary(through, true) }, !invalidDates);
    return <Modal open onClose={onClose} breadcrumbs={["Advanced search"]} size="xl"
        >
        <SearchBar autoFocus aria-label="Search conversations" value={query} onValueChange={setQuery}
            placeholder={scope === "all" ? "Search conversations" : `Search ${scope}`} maxLength={200} wrapperClassName="shrink-0" />
        <div className="my-3 grid shrink-0 grid-cols-2 gap-x-3 gap-y-2 border-b border-gray-200 pb-3 sm:grid-cols-3">
            <FormField label="Conversations" htmlFor="history-context"><ModalSelect id="history-context" value={context} placeholder={null}
                options={[{ value: "all", label: "All" }, { value: "assistant", label: "Assistant" }, { value: "reviews", label: "Review chats" }]}
                onChange={(value) => setContext(value as typeof context)} /></FormField>
            <FormField label="Search in" htmlFor="history-scope"><ModalSelect id="history-scope" value={scope} placeholder={null}
                options={[{ value: "all", label: "Both" }, { value: "titles", label: "Titles" }, { value: "transcripts", label: "Transcripts" }]}
                onChange={(value) => setScope(value as typeof scope)} /></FormField>
            <FormField label="Sort by" htmlFor="history-sort"><ModalSelect id="history-sort" value={sort} placeholder={null}
                options={[{ value: "newest", label: "Newest" }, { value: "oldest", label: "Oldest" }]}
                onChange={(value) => setSort(value as typeof sort)} /></FormField>
            <div className="col-span-2 sm:col-span-1"><FormField label="Created from" htmlFor="history-from"><ModalTextInput id="history-from" type="date" value={from} max={through || undefined} onChange={(event) => setFrom(event.target.value)} /></FormField></div>
            <div className="col-span-2 sm:col-span-1"><FormField label="Created through" htmlFor="history-through"><ModalTextInput id="history-through" type="date" value={through} min={from || undefined} onChange={(event) => setThrough(event.target.value)} /></FormField></div>
        </div>
        {invalidDates && <p role="alert" className="mb-2 text-sm text-red-700">Choose an end date on or after the start date.</p>}
        <p role="status" className="mb-2 shrink-0 text-xs text-gray-500">{page.loading ? "Searching…" : `${page.items.length}${page.hasMore ? "+" : ""} ${page.items.length === 1 ? "result" : "results"}`}</p>
        <div aria-busy={page.loading} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
            {page.items.map((chat) => <ChatSearchResult key={chat.id} chat={chat} query={page.searchQuery} onNavigate={onClose} />)}
            {!page.items.length && !invalidDates && <p role="status" className="py-5 text-center text-sm text-gray-500">{page.loading ? "Searching…" : page.error ? "Could not load results." : "No matching conversations."}</p>}
            {!!page.error && <Button variant="ghost" size="compact" onClick={() => void page.reload()}>Try again</Button>}
            {page.hasMore && <Button variant="ghost" size="compact" disabled={page.loading} onClick={() => void page.loadMore()}>Load more</Button>}
        </div>
    </Modal>;
}
