import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, X } from "lucide-react";
import {
  type Document,
  type Folder,
  type LibraryFolder,
  directoryResource,
  type DirectoryScope,
} from "@/app/lib/api/documents";
import { type Project, listProjects } from "@/app/lib/api/projects";
import { FileTypeIcon } from "./FileTypeIcon";
import { FolderSvgIcon } from "./FolderSvgIcon";
import { Tabs } from "@/app/components/ui/tabs";
import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
import { buildDocumentTree } from "@/app/components/documents/documentTree";


import { usePagedDirectory } from "@/app/hooks/usePagedDirectory";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
import { SearchBar } from "@/app/components/ui/search-bar";
import { InlineNameInput } from "./InlineNameInput";
import { errorMessage } from "@/app/lib/utils";

export type DirectoryTab = "files" | "templates" | "projects";
export type DirectoryLocation = DirectoryScope | { projectId: null };
const TABS: [DirectoryTab, string][] = [
    ["files", "Files"], ["templates", "Templates"], ["projects", "Projects"],
];
const EMPTY: Document[] = [];

interface Props {
    autoFocus?: boolean;
    documents?: Document[];
    projectId?: string;
    loading?: boolean;
    selectedDocuments: Document[];
    onChange: (documents: Document[]) => void;
    uploadingFilenames?: string[];
    showTabs: boolean;
    initialTab?: DirectoryTab;
    initialLocation?: DirectoryLocation;
    tabs?: [DirectoryTab, string][];
    noun?: string;
    multiple?: boolean;
    excludeProjectId?: string;
    documentFilter?: (document: Document) => boolean;
    onLocationChange?: (location: DirectoryLocation) => void;
    newDocument?: {
        label: string;
        filename: string;
        onCreate: (name: string, location: DirectoryScope, folderId: string | null) => Promise<Document>;
        onCancel: () => void;
    };
}

export function FileDirectory({ documents = EMPTY, projectId, autoFocus = true,
    loading: externalLoading = false, selectedDocuments, onChange,
    uploadingFilenames = [], showTabs, initialTab = "files", initialLocation, tabs = TABS, noun = "files", multiple = true, excludeProjectId, documentFilter, onLocationChange, newDocument }: Props) {
    const [tab, setTab] = useState<DirectoryTab>(initialLocation
        ? "projectId" in initialLocation ? "projects" : initialLocation.library : initialTab);
    const [search, setSearch] = useState("");
    const [expanded, setExpanded] = useState(new Set<string>());
    const [selectedProjectId, setSelectedProjectId] = useState(projectId ??
        (initialLocation && "projectId" in initialLocation ? initialLocation.projectId : "") ?? "");
    const [draftParent, setDraftParent] = useState<string | null>(null);
    const [createdDocuments, setCreatedDocuments] = useState<Document[]>([]);
    const [creating, setCreating] = useState(false), [createError, setCreateError] = useState("");
    const committing = useRef(false);
    const naming = !!newDocument;
    useEffect(() => { if (naming) { setSearch(""); setCreateError(""); } }, [naming]);
    const activeTab = showTabs ? tab : "files";
    const query = search.trim();
    const libraryKind = activeTab === "templates" ? "templates" : "files";
    const activeProjectId = projectId ?? selectedProjectId;
    const reportLocation = useEffectEvent((location: DirectoryLocation) => onLocationChange?.(location));
    useEffect(() => reportLocation(!showTabs && projectId ? { projectId }
        : activeTab === "projects" ? { projectId: selectedProjectId || null }
            : { library: libraryKind }), [activeTab, libraryKind, projectId, selectedProjectId, showTabs]);
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
        ...(!query ? createdDocuments.filter((doc) => (doc.project_id ?? null) ===
            (activeTab === "projects" || !showTabs ? activeProjectId || null : null)) : []),
    ].map((doc) => [doc.id, doc])).values()].filter((document) => !documentFilter || documentFilter(document)),
    [activeProjectId, activeTab, createdDocuments, directory?.documents, documentFilter, documents, query, showTabs]);
    const tree = buildDocumentTree(allDocuments,
        (directory?.folders ?? []) as (Folder | LibraryFolder)[], expanded,
        newDocument ? draftParent : undefined, query, true, directory?.hasMoreParents ?? new Set());
    const selected = useMemo(() => new Set(selectedDocuments.map(({ id }) => id)),
        [selectedDocuments]);

    function toggleDocument(document: Document) {
        if (!multiple) return onChange(selected.has(document.id) ? [] : [document]);
        const next = new Map(selectedDocuments.map((item) => [item.id, item]));
        if (next.has(document.id)) next.delete(document.id);
        else next.set(document.id, document);
        onChange([...next.values()]);
    }
    function toggleFolder(id: string) {
        setDraftParent(expanded.has(id) ? null : id);
        if (!expanded.has(id)) directory?.ensureParent(id);
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }
    async function createDocument(value: string) {
        const name = value.trim();
        if (!name || !newDocument || committing.current) return;
        committing.current = true; setCreating(true); setCreateError("");
        try {
            const location: DirectoryScope = activeProjectId && (!showTabs || activeTab === "projects")
                ? { projectId: activeProjectId } : { library: libraryKind };
            const doc = await newDocument.onCreate(name, location, draftParent);
            setCreatedDocuments((items) => [...items, doc]);
            onChange([doc]); newDocument.onCancel();
        } catch (reason) { setCreateError(errorMessage(reason, "Could not create file")); }
        finally { committing.current = false; setCreating(false); }
    }
    const loading = externalLoading || !!directory?.loading;
    const projectList = showTabs && activeTab === "projects" && !selectedProjectId;
    const listing = <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
                {showTabs && activeTab === "projects" && selectedProjectId &&
                    <button type="button" onClick={() => {
                        setSelectedProjectId(""); setSearch(""); if (selected.size) onChange([]);
                    }}
                        className="mb-1 min-h-9 px-2 text-sm text-gray-600 hover:text-gray-900">← Projects</button>}
            {projectList ? <>
                {projects.loading && !projects.items.length && <Skeleton />}
                {projects.items.filter(({ id }) => id !== excludeProjectId).map((item) =>
                    <button type="button" key={item.id} onClick={() => {
                        setSelectedProjectId(item.id); setSearch(""); if (selected.size) onChange([]);
                    }}
                        className={`flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-sm ${APP_SURFACE_HOVER_CLASS}`}>
                        <FolderSvgIcon className="h-4 w-4" /><span className="truncate">{item.name}</span>
                        <ChevronRight className="ml-auto h-4 w-4" />
                    </button>)}
                {projects.hasMore && <More loading={projects.loading} onClick={projects.loadMore} />}
                {!projects.loading && !projects.items.length && <Empty query={query} noun={noun} />}
            </> : loading && !tree.rows.length ? <Skeleton /> : tree.rows.length || uploadingFilenames.length ? <>
                
                {uploadingFilenames.map((name) => <div key={name}
                    className="flex h-10 items-center gap-2 px-2 text-sm text-gray-500">
                    <Loader2 className="h-4 w-4 animate-spin" />{name}</div>)}
                {tree.rows.map((row) => {
                    const style = { paddingLeft: 8 + row.depth * 16 };
                    if (row.kind === "editor") return newDocument && <div key="new-document" style={style}
                        className="flex min-h-10 items-center gap-2 rounded bg-gray-50 px-2 text-sm">
                        {creating ? <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
                            : <FileTypeIcon fileType={newDocument.filename.split(".").at(-1) ?? "md"}
                                filename={newDocument.filename} className="size-4 shrink-0" />}
                        <InlineNameInput kind="new-document" label={newDocument.label} disabled={creating}
                            onCommit={(name) => void createDocument(name)} onCancel={newDocument.onCancel} />
                        <button type="button" aria-label="Cancel new file" disabled={creating}
                            onPointerDown={(event) => event.preventDefault()} onClick={newDocument.onCancel}
                            className="grid size-8 shrink-0 place-items-center rounded text-gray-500 hover:bg-gray-200 focus-visible:outline focus-visible:outline-2">
                            <X aria-hidden className="size-3.5" />
                        </button>
                    </div>;
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
                        <input type={multiple ? "checkbox" : "radio"} checked={selected.has(doc.id)} aria-label={`Select ${name}`}
                            onChange={() => toggleDocument(doc)}
                            className="h-[18px] w-[18px] shrink-0 cursor-pointer rounded border-gray-500 accent-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2" />
                        <FileTypeIcon fileType={doc.file_type} filename={doc.filename} className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{name}</span></label>;
                })}
            </> : <Empty query={query} noun={noun} />}
        </div>;

    return <div className="flex min-h-0 flex-1 flex-col gap-2">
        {createError && <p role="alert" className="text-sm text-red-700">{createError}</p>}
        <SearchBar autoFocus={autoFocus} value={search} onValueChange={setSearch} booleanSearch
            placeholder={`Search ${noun}`} aria-label={`Search ${noun}`} />
        {showTabs ? <Tabs value={activeTab} variant="segmented" ariaLabel="File source"
            options={tabs.map(([value, label]) => ({ value, label }))}
            onValueChange={(value) => {
                setTab(value as DirectoryTab); setSelectedProjectId(""); setExpanded(new Set()); setDraftParent(null);
                newDocument?.onCancel(); if (selected.size) onChange([]);
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
const Empty = ({ query, noun }: { query: string; noun: string }) => <div
    className="flex flex-col items-center py-10 text-center text-sm text-gray-500">
    <FolderSvgIcon className="mb-2 h-6 w-6" />{query ? "No matches found" : `No ${noun} available`}</div>;


