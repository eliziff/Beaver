import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { Document, Folder, LibraryFolder, Project } from "./types";
import { FileTypeIcon } from "./FileTypeIcon";
import { FolderSvgIcon } from "./FolderSvgIcon";
import { Tabs } from "@/app/components/ui/tabs";
import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
import { buildDocumentTree } from "@/app/components/documents/documentTree";
import { directoryResource, listProjects } from "@/app/lib/beaverApi";
import { usePagedDirectory } from "@/app/hooks/usePagedDirectory";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
import { SearchBar } from "@/app/components/ui/search-bar";

export type DirectoryTab = "files" | "templates" | "projects";
const TABS: [DirectoryTab, string][] = [
    ["files", "Files"], ["templates", "Templates"], ["projects", "Projects"],
];
const EMPTY: Document[] = [];

interface Props {
    documents?: Document[];
    projectId?: string;
    loading?: boolean;
    selectedDocuments: Document[];
    onChange: (documents: Document[]) => void;
    uploadingFilenames?: string[];
    showTabs: boolean;
    initialTab?: DirectoryTab;
    excludeProjectId?: string;
}

export function FileDirectory({ documents = EMPTY, projectId,
    loading: externalLoading = false, selectedDocuments, onChange,
    uploadingFilenames = [], showTabs, initialTab = "files", excludeProjectId }: Props) {
    const [tab, setTab] = useState<DirectoryTab>(initialTab);
    const [search, setSearch] = useState("");
    const [expanded, setExpanded] = useState(new Set<string>());
    const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? "");
    const activeTab = showTabs ? tab : "files";
    const query = search.trim();
    const libraryKind = activeTab === "templates" ? "templates" : "files";
    const activeProjectId = projectId ?? selectedProjectId;
    const libraryResource = useMemo(
        () => directoryResource({ library: libraryKind }),
        [libraryKind],
    );
    const projectResource = useMemo(
        () => directoryResource({ projectId: activeProjectId }),
        [activeProjectId],
    );
    const library = usePagedDirectory(
        (parentId, q, cursor, signal) => libraryResource.list(
            { parent_id: parentId, q, cursor }, signal),
        query, [libraryResource, query], showTabs && activeTab !== "projects",
    );
    const projects = usePagedQuery<Project>(
        (cursor, signal) => listProjects({ q: selectedProjectId ? "" : query, cursor }, signal),
        [query, selectedProjectId], showTabs && activeTab === "projects" && !selectedProjectId,
    );
    const project = usePagedDirectory(
        (parentId, q, cursor, signal) => projectResource.list(
            { parent_id: parentId, q, cursor }, signal),
        query, [projectResource, query],
        !!activeProjectId && (!showTabs || activeTab === "projects"),
    );
    const directory = !showTabs ? (projectId ? project : null)
        : activeTab === "projects" ? (selectedProjectId ? project : null) : library;
    const allDocuments = useMemo(() => [...new Map([
        ...(activeTab === "files" || !showTabs ? documents : []),
        ...(directory?.documents ?? []),
    ].map((doc) => [doc.id, doc])).values()],
    [activeTab, directory?.documents, documents, showTabs]);
    const tree = buildDocumentTree(allDocuments,
        (directory?.folders ?? []) as (Folder | LibraryFolder)[], expanded,
        undefined, query, true, directory?.hasMoreParents ?? new Set());
    const selected = useMemo(() => new Set(selectedDocuments.map(({ id }) => id)),
        [selectedDocuments]);

    function toggleDocument(document: Document) {
        const next = new Map(selectedDocuments.map((item) => [item.id, item]));
        if (next.has(document.id)) next.delete(document.id);
        else next.set(document.id, document);
        onChange([...next.values()]);
    }
    function toggleFolder(id: string) {
        if (!expanded.has(id)) directory?.ensureParent(id);
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }
    const loading = externalLoading || !!directory?.loading;
    const projectList = showTabs && activeTab === "projects" && !selectedProjectId;
    const listing = <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
            {projectList ? <>
                {projects.loading && !projects.items.length && <Skeleton />}
                {projects.items.filter(({ id }) => id !== excludeProjectId).map((item) =>
                    <button type="button" key={item.id} onClick={() => {
                        setSelectedProjectId(item.id); setSearch("");
                    }}
                        className={`flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-sm ${APP_SURFACE_HOVER_CLASS}`}>
                        <FolderSvgIcon className="h-4 w-4" /><span className="truncate">{item.name}</span>
                        <ChevronRight className="ml-auto h-4 w-4" />
                    </button>)}
                {projects.hasMore && <More loading={projects.loading} onClick={projects.loadMore} />}
                {!projects.loading && !projects.items.length && <Empty query={query} />}
            </> : loading && !tree.rows.length ? <Skeleton /> : tree.rows.length || uploadingFilenames.length ? <>
                {showTabs && activeTab === "projects" && selectedProjectId &&
                    <button type="button" onClick={() => {
                        setSelectedProjectId(""); setSearch("");
                    }}
                        className="mb-1 min-h-9 px-2 text-sm text-gray-600 hover:text-gray-900">← Projects</button>}
                {uploadingFilenames.map((name) => <div key={name}
                    className="flex h-10 items-center gap-2 px-2 text-sm text-gray-500">
                    <Loader2 className="h-4 w-4 animate-spin" />{name}</div>)}
                {tree.rows.map((row) => {
                    const style = { paddingLeft: 8 + row.depth * 16 };
                    if (row.kind === "editor") return null;
                    if (row.kind === "more") return <More key={`more-${row.parentId}`}
                        loading={!!directory?.loadingParents.has(row.parentId)}
                        onClick={() => directory?.loadMore(row.parentId)} style={style} />;
                    if (row.kind === "folder") {
                        const open = expanded.has(row.folder.id);
                        return <button type="button" key={row.folder.id} onClick={() => toggleFolder(row.folder.id)}
                            className={`flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-sm ${APP_SURFACE_HOVER_CLASS}`} style={style}>
                            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            <FolderSvgIcon open={open} className="h-4 w-4" />
                            <span className="truncate">{row.folder.name}</span></button>;
                    }
                    const doc = row.document;
                    const name = doc.filename.replace(/\.research\.md$/iu, "");
                    return <label key={doc.id} style={style}
                        className={`flex min-h-10 cursor-pointer items-center gap-2 rounded px-2 text-sm ${APP_SURFACE_HOVER_CLASS}`}>
                        <input type="checkbox" checked={selected.has(doc.id)} aria-label={`Select ${name}`}
                            onChange={() => toggleDocument(doc)}
                            className="h-[18px] w-[18px] shrink-0 cursor-pointer rounded border-gray-500 accent-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2" />
                        <FileTypeIcon fileType={doc.file_type} className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{name}</span></label>;
                })}
            </> : <Empty query={query} />}
        </div>;

    return <div className="flex min-h-0 flex-1 flex-col gap-2">
        <SearchBar autoFocus value={search} onValueChange={setSearch} booleanSearch
            placeholder="Search files" aria-label="Search files" />
        {showTabs ? <Tabs value={activeTab} variant="pill" ariaLabel="File source"
            options={TABS.map(([value, label]) => ({ value, label }))}
            onValueChange={(value) => {
                setTab(value as DirectoryTab); setSelectedProjectId(""); setExpanded(new Set());
            }} actions={selected.size ? <span className="text-xs text-gray-500">
                {selected.size} selected
            </span> : null} className="min-h-0 flex-1">
            {listing}
        </Tabs> : <>
            {!!selected.size && <span className="text-end text-xs text-gray-500">
                {selected.size} selected
            </span>}
            {listing}
        </>}
    </div>;
}

function More({ loading, onClick, style }: { loading: boolean; onClick: () => void; style?: React.CSSProperties }) {
    return <button type="button" disabled={loading} onClick={onClick} style={style}
        className="min-h-10 px-2 text-sm text-gray-600 disabled:opacity-50">
        {loading ? "Loading..." : "Load more"}</button>;
}
const Skeleton = () => <div className="space-y-1">{[1, 2, 3, 4, 5].map((id) =>
    <div className="h-10 animate-pulse rounded bg-gray-100" key={id} />)}</div>;
const Empty = ({ query }: { query: string }) => <div
    className="flex flex-col items-center py-10 text-center text-sm text-gray-500">
    <FolderSvgIcon className="mb-2 h-6 w-6" />{query ? "No matches found" : "No documents available"}</div>;
