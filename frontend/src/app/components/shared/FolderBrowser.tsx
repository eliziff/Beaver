import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FolderPlus } from "lucide-react";
import { FolderSvgIcon } from "./FolderSvgIcon";
import type { Folder, DirectoryList } from "@/app/lib/api/documents";

import { usePagedQuery } from "@/app/hooks/usePagedQuery";

export type FolderList = DirectoryList;

export function FolderBrowser({ list, createFolder, rootLabel, onSelect, onBack, disabledIds, hideRoot = false }: {
    list: FolderList; createFolder: (name: string, parentId?: string | null) => Promise<Folder>; rootLabel: string;
    onSelect: (folder: Folder | null) => void; hideRoot?: boolean;
    onBack?: () => void; disabledIds?: Set<string>;
}) {
    const [path, setPath] = useState<Folder[]>([]), parent = path.at(-1) ?? null;
    const [name, setName] = useState<string | null>(null), [creating, setCreating] = useState(false),
        [error, setError] = useState("");
    const newFolder = useRef<HTMLButtonElement>(null);
    function cancelCreate() { setName(null); newFolder.current?.focus(); }
    const page = usePagedQuery((cursor, signal) => list({
        parent_id: parent?.id ?? null, cursor, limit: 100,
    }, signal), [list, parent?.id], true);
    const folders = page.items.flatMap((item) => item.kind === "folder" ? [item.folder] : []);
    function move(next: Folder[]) { setPath(next); onSelect(next.at(-1) ?? null); setName(null); setError(""); }
    async function create() {
        if (!name?.trim() || creating) return;
        setCreating(true); setError("");
        try { move([...path, await createFolder(name.trim(), parent?.id ?? null)]); }
        catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create folder. Try again."); }
        finally { setCreating(false); }
    }
    return <div role="region"
        className="min-h-0 flex-1 overflow-y-auto rounded-md border border-gray-300 p-1"
        aria-label="Choose destination folder" aria-busy={page.loading}>
        <div className="flex min-h-10 items-center gap-1 px-1">
            {(path.length > 0 || onBack) && <button type="button"
                disabled={creating}
                aria-label={`Back to ${path.length > 1 ? path.at(-2)?.name : onBack ? "projects" : rootLabel}`}
                onClick={() => path.length ? move(path.slice(0, -1)) : onBack?.()}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-gray-600 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900">
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>}
            <p className="min-w-0 break-words px-1 text-sm font-medium text-gray-800">
                {parent?.name ?? (!hideRoot ? rootLabel : "")}
            </p>
            <button ref={newFolder} type="button" disabled={creating} onClick={() => { setName(""); setError(""); }}
                className="ms-auto flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50">
                <FolderPlus className="size-4" aria-hidden="true" />New folder
            </button>
        </div>
        {name !== null && <div className="space-y-2 rounded-md bg-gray-50 p-2">
            <label className="grid gap-1 text-sm text-gray-700">Folder name
                <input autoFocus value={name} disabled={creating} onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") { event.preventDefault(); void create(); }
                        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!creating) cancelCreate(); }
                    }} className="h-9 min-w-0 rounded-md border border-gray-300 bg-white px-2" />
            </label>
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            <div className="flex justify-end gap-2">
                <button type="button" disabled={creating} onClick={cancelCreate}
                    className="min-h-9 rounded-md px-2 text-sm text-gray-600 hover:bg-gray-100">Cancel</button>
                <button type="button" disabled={creating || !name.trim()} onClick={() => void create()}
                    className="min-h-9 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-800 hover:bg-gray-100 disabled:opacity-50">
                    {creating ? "Creating…" : "Create"}
                </button>
            </div>
        </div>}
        {folders.map((folder) => <button type="button" key={folder.id}
            disabled={creating || disabledIds?.has(folder.id)}
            aria-label={`Open ${folder.name}`}
            onClick={() => move([...path, folder])}
            className="flex min-h-10 w-full items-center gap-2 rounded px-2 py-2 text-left text-sm text-gray-800 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gray-900 disabled:cursor-not-allowed disabled:opacity-40">
            <FolderSvgIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 break-words">{folder.name}</span>
            <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>)}
        {page.hasMore && <button type="button" disabled={page.loading}
            onClick={() => void page.loadMore()}
            className="min-h-10 w-full rounded px-2 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50">
            {page.loading ? "Loading…" : "Load more"}
        </button>}
        {page.loading && !folders.length && <p role="status"
            className="px-3 py-8 text-center text-sm text-gray-500">Loading folders…</p>}
        {page.error && !page.loading && <button type="button" onClick={() => void page.reload()}
            className="min-h-10 w-full rounded px-3 text-sm text-red-700 hover:bg-red-50">
            Unable to load folders. Try again
        </button>}
        {!page.loading && !page.error && !folders.length && <p className="px-3 py-8 text-center text-sm text-gray-500">
            {parent ? "No folders here" : "No folders yet"}
        </p>}
    </div>;
}
