import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { MessageSquarePlus, Upload } from "lucide-react";
import { stageNewChatDocuments } from "../assistant/assistantLaunch";
import {
    DocTable,
    type DocTableFolder,
    type DocTableSelectionActions,
} from "../documents/DocTable";
import { DocumentAutomation } from "../documents/DocumentAutomation";
import { FolderSvgIcon } from "../shared/FolderSvgIcon";
import { PageHeader } from "../shared/PageHeader";
import { TableToolbar } from "../shared/TableToolbar";
import type { Document } from "../shared/types";
import { TabPillButton } from "../ui/tab-pill-button";
import { usePagedDirectory } from "../../hooks/usePagedDirectory";
import {
    directoryResource,
    retryLibraryPdfParse,
    type LibraryKind,
} from "../../lib/beaverApi";

const LIBRARY_TABS = [
    { id: "files", label: "Files" },
    { id: "templates", label: "Templates" },
] as const;

export const libraryRoute = (tab: LibraryKind) =>
    tab === "files" ? "/library" : `/library/${tab}`;

type LibraryViews = Record<LibraryKind, { search: string }>;
const LibraryWorkspace = createContext<{
    views: LibraryViews;
    setSearch: (kind: LibraryKind, search: string) => void;
} | null>(null);

export function LibraryWorkspaceProvider({ children }: { children: ReactNode }) {
    const [views, setViews] = useState<LibraryViews>({
        files: { search: "" },
        templates: { search: "" },
    });
    const setSearch = useCallback((kind: LibraryKind, search: string) => {
        setViews((current) => ({
            ...current,
            [kind]: { ...current[kind], search },
        }));
    }, []);
    const value = useMemo(() => ({ views, setSearch }), [setSearch, views]);
    return (
        <LibraryWorkspace.Provider value={value}>
            {children}
        </LibraryWorkspace.Provider>
    );
}

function useStoredAction() {
    const [action, setAction] = useState<(() => void) | null>(null);
    return [
        action,
        useCallback((next: (() => void) | null) => setAction(() => next), []),
    ] as const;
}

export function LibraryCollectionPage({
    kind,
    onKindChange,
    onOpenInChat,
    embedded = false,
}: {
    kind: LibraryKind;
    onKindChange?: (kind: LibraryKind) => void;
    onOpenInChat?: (documents: Document[]) => void;
    embedded?: boolean;
}) {
    const navigate = useNavigate();
    const workspace = useContext(LibraryWorkspace);
    const [localSearch, setLocalSearch] = useState("");
    const search = workspace?.views[kind].search ?? localSearch;
    const setSearch = (value: string) =>
        workspace ? workspace.setSearch(kind, value) : setLocalSearch(value);
    const [selection, setSelection] =
        useState<DocTableSelectionActions | null>(null);
    const [upload, setUpload] = useStoredAction();
    const [createFolder, setCreateFolder] = useStoredAction();
    const title = kind === "files" ? "Files" : "Templates";
    const resource = useMemo(() => directoryResource({ library: kind }), [kind]);
    const directory = usePagedDirectory(
        (parentId, q, cursor, signal) =>
            resource.list({ parent_id: parentId, q, cursor }, signal),
        search,
        [resource, search],
    );
    const operations = useMemo(
        () => ({
            ...resource,
            refreshCollection: (parentId?: string | null) =>
                directory.reload(parentId),
            retryPdfParse: retryLibraryPdfParse.bind(null, kind),
        }),
        [directory.reload, kind, resource],
    );

    function openChat() {
        const documents = selection?.selectedDocuments ?? [];
        if (onOpenInChat) onOpenInChat(documents);
        else {
            stageNewChatDocuments(documents);
            navigate("/assistant");
        }
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            {!embedded && (
                <PageHeader
                    breadcrumbs={[{ label: "Library" }, { label: title }]}
                    actions={[
                        {
                            type: "search",
                            value: search,
                            onChange: setSearch,
                            placeholder: `Search ${title.toLowerCase()}…`,
                        },
                        {
                            icon: <Upload className="h-3.5 w-3.5" />,
                            label: <span className="hidden sm:inline">Upload</span>,
                            title: "Upload",
                            onClick: upload ?? undefined,
                            disabled: !upload || directory.loading,
                        },
                    ]}
                />
            )}
            {embedded && (
                <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2">
                    <label className="flex h-9 min-w-0 flex-1 items-center rounded-md border border-gray-300 bg-white px-3">
                        <span className="sr-only">Search {title.toLowerCase()}</span>
                        <input
                            type="search"
                            value={search}
                            onChange={(event) => setSearch(event.currentTarget.value)}
                            placeholder={`Search ${title.toLowerCase()}…`}
                            className="min-w-0 flex-1 bg-transparent text-base text-gray-800 outline-none placeholder:text-gray-400 sm:text-sm"
                        />
                    </label>
                    <button
                        type="button"
                        onClick={upload ?? undefined}
                        disabled={!upload || directory.loading}
                        className="grid size-9 shrink-0 place-items-center rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                        aria-label="Upload"
                        title="Upload"
                    >
                        <Upload className="size-4" aria-hidden="true" />
                    </button>
                </div>
            )}
            <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                <TableToolbar
                    items={LIBRARY_TABS}
                    active={kind}
                    onChange={(next) =>
                        onKindChange
                            ? onKindChange(next)
                            : navigate(libraryRoute(next))
                    }
                    actions={
                        <div className="flex items-center gap-1.5">
                            <TabPillButton
                                disabled={!selection?.selectedCount}
                                onClick={openChat}
                            >
                                <MessageSquarePlus className="h-3.5 w-3.5" />
                                <span
                                    className={
                                        embedded ? "sr-only" : "hidden sm:inline"
                                    }
                                >
                                    {onOpenInChat
                                        ? "Open in chat"
                                        : "Open in new chat"}
                                </span>
                            </TabPillButton>
                            {kind === "files" && (
                                <DocumentAutomation
                                    document={selection?.automationDocument ?? null}
                                    showWhenUnavailable
                                    onDocumentChanged={
                                        selection?.onAutomationDocumentChanged
                                    }
                                />
                            )}
                            <TabPillButton
                                onClick={createFolder ?? undefined}
                                disabled={!createFolder || directory.loading}
                            >
                                <FolderSvgIcon className="h-3.5 w-3.5" />
                                <span
                                    className={
                                        embedded ? "sr-only" : "hidden sm:inline"
                                    }
                                >
                                    Folder
                                </span>
                            </TabPillButton>
                        </div>
                    }
                />
                <DocTable
                    scopeKey={kind}
                    documents={directory.documents}
                    folders={directory.folders as DocTableFolder[]}
                    loading={directory.loading}
                    search={search}
                    operations={operations}
                    onAddDocumentsActionChange={setUpload}
                    onCreateFolderActionChange={setCreateFolder}
                    onSelectionActionsChange={setSelection}
                    selectionFirst
                    compact={embedded}
                    emptyDropLabel={
                        kind === "templates"
                            ? "Drop template files here"
                            : "Drop PDF, Word, Excel, or PowerPoint files here"
                    }
                    hasMoreParents={directory.hasMoreParents}
                    loadingParents={directory.loadingParents}
                    onFolderExpanded={directory.ensureParent}
                    onLoadMore={directory.loadMore}
                />
            </div>
        </div>
    );
}
