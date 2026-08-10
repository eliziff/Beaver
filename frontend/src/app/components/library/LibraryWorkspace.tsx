"use client";
import {
    createContext,
    type Dispatch,
    type ReactNode,
    type SetStateAction,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import { useRouter } from "next/navigation";
import { MessageSquarePlus, Upload } from "lucide-react";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { DocTable } from "@/app/components/documents/DocTable";
import { DocumentAutomation } from "@/app/components/documents/DocumentAutomation";
import { stageNewChatDocuments } from "@/app/components/assistant/assistantLaunch";
import type {
    DocTableFolder,
    DocTableSelectionActions,
} from "@/app/components/documents/DocTable";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import {
    createLibraryFolder,
    deleteLibraryFolder,
    getLibrary,
    moveLibraryDocument,
    moveLibraryFolder,
    renameLibraryDocument,
    renameLibraryFolder,
    retryLibraryPdfParse,
    uploadLibraryDocument,
    type LibraryKind,
} from "@/app/lib/beaverApi";
import type { Document } from "@/app/components/shared/types";
type LibraryViewCollection = {
    documents: Document[];
    folders: DocTableFolder[];
};
type LibraryView = LibraryViewCollection & {
    search: string;
    loaded: boolean;
};
type LibraryViews = Record<LibraryKind, LibraryView>;
type LibraryViewPatch =
    | Partial<LibraryView>
    | ((view: LibraryView) => Partial<LibraryView>);
type LibraryWorkspaceContextValue = {
    views: LibraryViews;
    loadLibrary: (kind: LibraryKind) => Promise<void>;
    updateView: (kind: LibraryKind, patch: LibraryViewPatch) => void;
};
export const LIBRARY_TABS = [
    { id: "files", label: "Files" },
    { id: "templates", label: "Templates" },
] as const;
export function libraryRoute(tab: (typeof LIBRARY_TABS)[number]["id"]) {
    return tab === "files" ? "/library" : `/library/${tab}`;
}
const EMPTY_COLLECTION = {
    documents: [],
    folders: [],
} satisfies LibraryViewCollection;
const INITIAL_VIEWS: LibraryViews = {
    files: { ...EMPTY_COLLECTION, search: "", loaded: false },
    templates: { ...EMPTY_COLLECTION, search: "", loaded: false },
};
const LibraryWorkspaceContext =
    createContext<LibraryWorkspaceContextValue | null>(null);
function useLibraryWorkspace() {
    const context = useContext(LibraryWorkspaceContext);
    if (!context) {
        throw new Error(
            "useLibraryWorkspace must be used inside LibraryWorkspaceProvider",
        );
    }
    return context;
}
function useStoredAction() {
    const [action, setAction] = useState<(() => void) | null>(null);
    const onChange = useCallback(
        (next: (() => void) | null) => setAction(() => next),
        [],
    );
    return [action, onChange] as const;
}
export function LibraryWorkspaceProvider({
    children,
}: {
    children: ReactNode;
}) {
    const [views, setViews] = useState(INITIAL_VIEWS);
    const loadLibrary = useCallback(async (kind: LibraryKind) => {
        let data: LibraryViewCollection;
        try {
            data = await getLibrary(kind);
        } catch (error) {
            console.error("[library] failed to load", error);
            data = EMPTY_COLLECTION;
        }
        setViews((prev) => ({
            ...prev,
            [kind]: { ...prev[kind], ...data, loaded: true },
        }));
    }, []);
    const updateView = useCallback((kind: LibraryKind, patch: LibraryViewPatch) => {
        setViews((prev) => {
            const current = prev[kind];
            return {
                ...prev,
                [kind]: {
                    ...current,
                    ...(typeof patch === "function" ? patch(current) : patch),
                },
            };
        });
    }, []);
    const value = useMemo(
        () => ({ views, loadLibrary, updateView }),
        [views, loadLibrary, updateView],
    );
    return (
        <LibraryWorkspaceContext.Provider value={value}>
            {children}
        </LibraryWorkspaceContext.Provider>
    );
}
export function LibraryWorkspaceLayout({ children }: { children: ReactNode }) {
    const router = useRouter();
    useEffect(() => {
        for (const tab of LIBRARY_TABS) {
            router.prefetch(libraryRoute(tab.id));
        }
    }, [router]);
    return <LibraryWorkspaceProvider>{children}</LibraryWorkspaceProvider>;
}
export function LibraryCollectionPage({
    kind,
    onKindChange,
    embedded = false,
}: {
    kind: LibraryKind;
    onKindChange?: (kind: LibraryKind) => void;
    embedded?: boolean;
}) {
    const router = useRouter();
    const { views, loadLibrary, updateView } = useLibraryWorkspace();
    const view = views[kind];
    const title = kind === "files" ? "Files" : "Templates";
    useEffect(() => {
        if (view.loaded) return;
        void loadLibrary(kind);
    }, [kind, loadLibrary, view.loaded]);
    const setDocuments: Dispatch<SetStateAction<Document[]>> = useCallback(
        (update) =>
            updateView(kind, ({ documents }) => ({
                documents:
                    typeof update === "function"
                        ? update(documents)
                        : update,
            })),
        [kind, updateView],
    );
    const setFolders: Dispatch<SetStateAction<DocTableFolder[]>> = useCallback(
        (update) =>
            updateView(kind, ({ folders }) => ({
                folders:
                    typeof update === "function" ? update(folders) : update,
            })),
        [kind, updateView],
    );
    const [addDocumentsAction, handleAddDocumentsActionChange] =
        useStoredAction();
    const [createFolderAction, handleCreateFolderActionChange] =
        useStoredAction();
    const [selectionActions, setSelectionActions] =
        useState<DocTableSelectionActions | null>(null);
    const loading = !view.loaded;
    const operations = useMemo(
        () => ({
            uploadDocument: uploadLibraryDocument.bind(null, kind),
            refreshCollection: loadLibrary.bind(null, kind),
            createFolder: createLibraryFolder.bind(null, kind),
            renameFolder: renameLibraryFolder.bind(null, kind),
            deleteFolder: deleteLibraryFolder.bind(null, kind),
            moveFolder: moveLibraryFolder.bind(null, kind),
            moveDocument: moveLibraryDocument.bind(null, kind),
            renameDocument: renameLibraryDocument.bind(null, kind),
            retryPdfParse: retryLibraryPdfParse.bind(null, kind),
        }),
        [kind, loadLibrary],
    );
    return (
        <div className="flex h-full min-h-0 flex-col">
            {!embedded && <PageHeader
                breadcrumbs={[{ label: "Library" }, { label: title }]}
                actions={[
                    {
                        type: "search",
                        value: view.search,
                        onChange: (search) => updateView(kind, { search }),
                        placeholder: `Search ${title.toLowerCase()}...`,
                    },
                    {
                        icon: <Upload className="h-3.5 w-3.5" />,
                        label: (
                            <span className="hidden sm:inline">
                                {title}
                            </span>
                        ),
                        title: `Add ${title}`,
                        onClick: addDocumentsAction ?? undefined,
                        disabled: !addDocumentsAction || loading,
                    },
                ]}
            />}
            {embedded && (
                <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2">
                    <label className="flex h-9 min-w-0 flex-1 items-center rounded-md border border-gray-300 bg-white px-3">
                        <span className="sr-only">Search {title.toLowerCase()}</span>
                        <input
                            type="search"
                            value={view.search}
                            onChange={(event) => updateView(kind, { search: event.currentTarget.value })}
                            placeholder={`Search ${title.toLowerCase()}...`}
                            className="min-w-0 flex-1 bg-transparent text-base text-gray-800 outline-none placeholder:text-gray-400 sm:text-sm"
                        />
                    </label>
                    <button
                        type="button"
                        onClick={addDocumentsAction ?? undefined}
                        disabled={!addDocumentsAction || loading}
                        className="grid size-9 shrink-0 place-items-center rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                        aria-label={`Add ${title}`}
                        title={`Add ${title}`}
                    >
                        <Upload className="size-4" aria-hidden="true" />
                    </button>
                </div>
            )}
            <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                <TableToolbar
                    items={LIBRARY_TABS}
                    active={kind}
                    onChange={(next) => {
                        if (onKindChange) onKindChange(next);
                        else router.push(libraryRoute(next));
                    }}
                    actions={
                        <div className="flex items-center gap-1.5">
                            <TabPillButton
                                disabled={!selectionActions?.selectedCount}
                                onClick={() => {
                                    stageNewChatDocuments(
                                        selectionActions?.selectedDocuments ?? [],
                                    );
                                    router.push("/assistant");
                                }}
                            >
                                <MessageSquarePlus className="h-3.5 w-3.5" />
                                <span className={embedded ? "sr-only" : "hidden sm:inline"}>Open in new chat</span>
                            </TabPillButton>
                            {kind === "files" && (
                                <DocumentAutomation
                                    document={
                                        selectionActions?.automationDocument ??
                                        null
                                    }
                                    showWhenUnavailable
                                    onDocumentChanged={
                                        selectionActions?.onAutomationDocumentChanged
                                    }
                                />
                            )}
                            <TabPillButton
                                onClick={createFolderAction ?? undefined}
                                disabled={!createFolderAction || loading}
                            >
                                <FolderSvgIcon className="h-3.5 w-3.5" />
                                <span className={embedded ? "sr-only" : "hidden sm:inline"}>Folder</span>
                            </TabPillButton>
                        </div>
                    }
                />
                <DocTable
                    scopeKey={kind}
                    documents={view.documents}
                    setDocuments={setDocuments}
                    folders={view.folders}
                    setFolders={setFolders}
                    loading={loading}
                    search={view.search}
                    operations={operations}
                    onAddDocumentsActionChange={handleAddDocumentsActionChange}
                    onCreateFolderActionChange={
                        handleCreateFolderActionChange
                    }
                    onSelectionActionsChange={setSelectionActions}
                    selectionFirst
                    compact={embedded}
                    emptyDropLabel={
                        kind === "templates"
                            ? "Drop template files here"
                            : "Drop PDF, Word, Excel, or PowerPoint files here"
                    }
                />
            </div>
        </div>
    );
}
