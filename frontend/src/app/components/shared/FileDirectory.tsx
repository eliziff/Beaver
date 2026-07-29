import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import type { Document, LibraryFolder, Project } from "./types";
import type { DirectoryTab } from "./useDirectoryData";
import { useDirectoryData } from "./useDirectoryData";
import { FileTypeIcon } from "./FileTypeIcon";
import { FolderSvgIcon } from "./FolderSvgIcon";
import { SearchBar } from "@/app/components/ui/search-bar";
import { CheckboxInput } from "@/app/components/ui/checkbox";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
const TABS: {
    value: DirectoryTab;
    label: string;
}[] = [{ value: "files", label: "Files" }, { value: "templates", label: "Templates" }, { value: "projects", label: "Projects" },];
const EMPTY_DOCS: Document[] = [];
interface Props {
    documents?: Document[];
    loading?: boolean;
    selectedDocuments: Document[];
    onChange: (documents: Document[]) => void;
    uploadingFilenames?: string[];
    showTabs: boolean;
    initialTab?: DirectoryTab;
    excludeProjectId?: string;
}
function docFolderId(document: Document) { return document.folder_id ?? document.library_folder_id ?? null; }
function uniqueDocuments(documents: Document[]) { return [...new Map(documents.map((doc) => [doc.id, doc])).values()]; }
function folderPath(folders: LibraryFolder[], id: string | null) { if (!id)
    return null; const names: string[] = []; let current = folders.find((folder) => folder.id === id); while (current) {
    names.unshift(current.name);
    current = current.parent_folder_id ? folders.find((folder) => folder.id === current?.parent_folder_id) : undefined;
} return names.join(" / "); }
function projectDocuments(projects: Project[], query: string) { return projects.flatMap((project) => { const projectMatch = !query || project.name.toLowerCase().includes(query); return (project.documents ?? []).filter((doc) => projectMatch || doc.filename.toLowerCase().includes(query)).map((doc) => ({ doc, group: project.name })); }); }
type DirectoryRow = { doc: Document; group: string | null };
function groupedRows(rows: DirectoryRow[]) { const groups = new Map<string, DirectoryRow[]>(); for (const row of rows) { const key = row.group ?? ""; (groups.get(key) ?? groups.set(key, []).get(key)!).push(row); } return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)); }
export function FileDirectory({ documents = EMPTY_DOCS, loading: externalLoading = false, selectedDocuments, onChange, uploadingFilenames = [], showTabs, initialTab = "files", excludeProjectId, }: Props) { const [tab, setTab] = useState<DirectoryTab>(initialTab); const [search, setSearch] = useState(""); const { loadingTabs, standaloneDocuments, templateDocuments, fileFolders, templateFolders, projects, loadTab } = useDirectoryData(showTabs, initialTab); useEffect(() => { if (showTabs && initialTab !== "templates")
    void loadTab("templates"); }, [initialTab, loadTab, showTabs]); const activeTab = showTabs ? tab : "files"; const query = search.trim().toLowerCase(); const selectedIds = useMemo(() => new Set(selectedDocuments.map((doc) => doc.id)), [selectedDocuments]); const source = activeTab === "templates" ? templateDocuments : standaloneDocuments; const folders = activeTab === "templates" ? templateFolders : fileFolders; const rows = useMemo(() => { if (activeTab === "projects") {
    return projectDocuments(projects.filter((project) => project.id !== excludeProjectId), query);
} const docs = uniqueDocuments(showTabs ? [...documents, ...source] : documents); return docs.filter((doc) => !query || doc.filename.toLowerCase().includes(query)).map((doc) => ({ doc, group: folderPath(folders, docFolderId(doc)) })); }, [activeTab, documents, excludeProjectId, folders, projects, query, showTabs, source]); const groups = useMemo(() => query ? [["", rows] as [string, DirectoryRow[]]] : groupedRows(rows), [query, rows]); const loading = showTabs ? loadingTabs[activeTab] : externalLoading; function toggle(doc: Document) { const next = new Map(selectedDocuments.map((item) => [item.id, item])); if (next.has(doc.id))
    next.delete(doc.id);
else
    next.set(doc.id, doc); onChange([...next.values()]); } function changeTab(next: DirectoryTab) { setTab(next); void loadTab(next); } return (<div className="flex min-h-0 flex-1 flex-col gap-2">            <SearchBar value={search} onValueChange={setSearch} placeholder="Search files" autoFocus/>            <div className="flex min-h-8 items-center justify-between gap-3">                {showTabs ? (<div className="flex gap-1.5">                        {TABS.map((item) => (<TabPillButton key={item.value} active={item.value === activeTab} onClick={() => changeTab(item.value)}>                                {item.label}                            </TabPillButton>))}                    </div>) : <span />}                {selectedIds.size > 0 && <span className="text-xs text-gray-500">{selectedIds.size} selected</span>}            </div>            <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">                {loading ? <LoadingRows /> : rows.length || uploadingFilenames.length ? (<>                        {uploadingFilenames.map((name) => <div className="flex h-10 items-center gap-2 px-2 text-sm text-gray-500" key={`upload-${name}`}><Loader2 className="h-4 w-4 animate-spin"/>{name}</div>)}                        {groups.map(([group, groupRows]) => { const files = groupRows.map(({ doc }) => (<label key={doc.id} className={`flex min-h-10 cursor-pointer items-center gap-2 rounded px-2 text-sm ${group ? "pl-8" : ""} ${APP_SURFACE_HOVER_CLASS}`}>                                <CheckboxInput checked={selectedIds.has(doc.id)} aria-label={`Select ${doc.filename}`} onChange={() => toggle(doc)}/>                                <FileTypeIcon fileType={doc.file_type} className="h-4 w-4 shrink-0"/>                                <span className="min-w-0 flex-1 truncate">{doc.filename}</span>                            </label>)); return group ? (<details key={group} className="group mb-2 last:mb-0">                            <summary className="flex h-8 cursor-pointer list-none items-center gap-2 px-2 text-xs font-semibold text-gray-700 [&::-webkit-details-marker]:hidden">                                <ChevronRight className="h-4 w-4 shrink-0 group-open:rotate-90"/>                                <FolderSvgIcon className="h-4 w-4 shrink-0"/>{group}                            </summary>{files}                        </details>) : <section key="unfiled" className="mb-2 last:mb-0">{files}</section>; })}                    </>) : <EmptyState hasQuery={!!query}/>}            </div>        </div>); }
function LoadingRows() { return <div className="space-y-1">{[1, 2, 3, 4, 5].map((id) => <div className="h-10 animate-pulse rounded bg-gray-100" key={id}/>)}</div>; }
function EmptyState({ hasQuery }: {
    hasQuery: boolean;
}) { return <div className="flex flex-col items-center py-10 text-center text-sm text-gray-500"><FolderSvgIcon className="mb-2 h-6 w-6"/>{hasQuery ? "No matches found" : "No documents available"}</div>; }
