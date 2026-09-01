import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { stageNewChatDocuments } from "../assistant/assistantLaunch";
import { assistantWorkflowLaunch } from "../workflows/workflowRoutes";
import { DocTable, type DocTableFolder } from "../documents/DocTable";
import { DirectoryActions, type UploadActions } from "../documents/UploadAction";
import { PageHeader } from "../shared/PageHeader";
import type { Document } from "../shared/types";
import { Tabs } from "../ui/tabs";
import { SearchBar } from "../ui/search-bar";
import { usePagedDirectory } from "../../hooks/usePagedDirectory";
import {
    directoryResource,
    getDocumentParseStates,
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
    onOpenWorkflows,
    embedded = false,
}: {
    kind: LibraryKind;
    onKindChange?: (kind: LibraryKind) => void;
    onOpenInChat?: (documents: Document[]) => void;
    onOpenWorkflows?: (documents: Document[]) => void;
    embedded?: boolean;
}) {
    const navigate = useNavigate();
    const workspace = useContext(LibraryWorkspace);
    const [localSearch, setLocalSearch] = useState("");
    const search = workspace?.views[kind].search ?? localSearch;
    const setSearch = (value: string) =>
        workspace ? workspace.setSearch(kind, value) : setLocalSearch(value);
    const [uploadActions, setUploadActions] = useState<UploadActions | null>(null);
    const [createFolder, setCreateFolder] = useStoredAction();
    const title = kind === "files" ? "Files" : "Templates";
    const resource = useMemo(() => directoryResource({ library: kind }), [kind]);
    const directory = usePagedDirectory(
        (parentId, q, cursor, signal) =>
            resource.list({ parent_id: parentId, q, cursor }, signal),
        search,
        [resource, search],
    );
    const { reload, replaceDocumentParseStates } = directory;
    const operations = useMemo(
        () => ({
            ...resource,
            refreshCollection: (parentId?: string | null) =>
                reload(parentId),
            refreshDocumentParseStates: async (documentIds: string[]) =>
                replaceDocumentParseStates(await getDocumentParseStates(documentIds)),
            retryPdfParse: retryLibraryPdfParse.bind(null, kind),
        }),
        [kind, reload, replaceDocumentParseStates, resource],
    );

    function openChat(documents: Document[]) {
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
                    breadcrumbs={[{ label: "Library" }]}
                    actions={[
                        {
                            type: "search",
                            value: search,
                            onChange: setSearch,
                            placeholder: `Search ${title.toLowerCase()}…`,
                            booleanSearch: true,
                        },
                    ]}
                />
            )}
            {embedded && (
                <div className="border-b border-gray-200 px-3 py-2">
                    <SearchBar value={search} onValueChange={setSearch} booleanSearch
                        placeholder={`Search ${title.toLowerCase()}…`}
                        aria-label={`Search ${title.toLowerCase()}`} />
                </div>
            )}
            <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                <Tabs
                    options={LIBRARY_TABS.map(({ id, label }) => ({ value: id, label }))}
                    value={kind}
                    onValueChange={(next) =>
                        onKindChange
                            ? onKindChange(next as LibraryKind)
                            : navigate(libraryRoute(next as LibraryKind))
                    }
                    ariaLabel="Library sections"
                    variant="pill"
                    className="h-full"
                    railClassName="mx-4 mb-2 min-h-12 flex-col items-stretch gap-2 py-2 sm:flex-row sm:flex-wrap sm:items-center md:mx-6"
                    actions={
                        <DirectoryActions actions={uploadActions}
                            busy={directory.loading} compact={embedded}
                            onCreateFolder={createFolder} />
                    }
                >
                <DocTable
                    scopeKey={kind}
                    documents={directory.documents}
                    folders={directory.folders as DocTableFolder[]}
                    loading={directory.loading}
                    search={search}
                    operations={operations}
                    onUploadActionsChange={setUploadActions}
                    onCreateFolderActionChange={setCreateFolder}
                    onOpenSelectionInChat={openChat}
                    onOpenWorkflows={onOpenWorkflows}
                    onAssistantWorkflowSelect={(selection, documents) => {
                        stageNewChatDocuments(documents);
                        navigate("/assistant", { state: assistantWorkflowLaunch(selection) });
                    }}
                    openSelectionLabel={onOpenInChat ? "Open in chat" : "Open in new chat"}
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
                </Tabs>
            </div>
        </div>
    );
}
