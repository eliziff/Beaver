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
import { Upload } from "lucide-react";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { DocTable } from "@/app/components/documents/DocTable";
import { DocumentAutomation } from "@/app/components/documents/DocumentAutomation";
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
    uploadLibraryDocument,
    type LibraryKind,
} from "@/app/lib/beaverApi";
import type { Document } from "@/app/components/shared/types";
type LibraryViewCollection = {
    documents: Document[];
    folders: DocTableFolder[];
};
type LibraryWorkspaceContextValue = {
    collections: Record<LibraryKind, LibraryViewCollection | null>;
    searchByKind: Record<LibraryKind, string>;
    loadLibrary: (kind: LibraryKind) => Promise<void>;
    setSearchForKind: (kind: LibraryKind, value: string) => void;
    setDocumentsForKind: (
        kind: LibraryKind,
        update: SetStateAction<Document[]>,
    ) => void;
    setFoldersForKind: (
        kind: LibraryKind,
        update: SetStateAction<DocTableFolder[]>,
    ) => void;
};
export const LIBRARY_TABS = [
    { id: "files", label: "Files" },
    { id: "templates", label: "Templates" },
    { id: "legal", label: "Cases & Legislation" },
] as const;
export function libraryRoute(tab: (typeof LIBRARY_TABS)[number]["id"]) {
    return tab === "files" ? "/library" : `/library/${tab}`;
}
const EMPTY_COLLECTION: LibraryViewCollection = {
    documents: [],
    folders: [],
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
export function LibraryWorkspaceProvider({
    children,
}: {
    children: ReactNode;
}) {
    const [collections, setCollections] = useState<
        Record<LibraryKind, LibraryViewCollection | null>
    >({
        files: null,
        templates: null,
    });
    const [searchByKind, setSearchByKind] = useState<
        Record<LibraryKind, string>
    >({
        files: "",
        templates: "",
    });
    const loadLibrary = useCallback(async (kind: LibraryKind) => {
        try {
            const loaded = await getLibrary(kind);
            setCollections((prev) => ({
                ...prev,
                [kind]: {
                    documents: loaded.documents,
                    folders: loaded.folders,
                },
            }));
        } catch (error) {
            console.error("[library] failed to load", error);
            setCollections((prev) => ({
                ...prev,
                [kind]: EMPTY_COLLECTION,
            }));
        }
    }, []);
    const setSearchForKind = useCallback((kind: LibraryKind, value: string) => {
        setSearchByKind((prev) => ({ ...prev, [kind]: value }));
    }, []);
    const setDocumentsForKind = useCallback(
        (kind: LibraryKind, update: SetStateAction<Document[]>) => {
            setCollections((prev) => {
                const current = prev[kind] ?? EMPTY_COLLECTION;
                const nextDocuments =
                    typeof update === "function"
                        ? update(current.documents)
                        : update;
                return {
                    ...prev,
                    [kind]: {
                        ...current,
                        documents: nextDocuments,
                    },
                };
            });
        },
        [],
    );
    const setFoldersForKind = useCallback(
        (kind: LibraryKind, update: SetStateAction<DocTableFolder[]>) => {
            setCollections((prev) => {
                const current = prev[kind] ?? EMPTY_COLLECTION;
                const nextFolders =
                    typeof update === "function"
                        ? update(current.folders)
                        : update;
                return {
                    ...prev,
                    [kind]: {
                        ...current,
                        folders: nextFolders,
                    },
                };
            });
        },
        [],
    );
    const value = useMemo(
        () => ({
            collections,
            searchByKind,
            loadLibrary,
            setSearchForKind,
            setDocumentsForKind,
            setFoldersForKind,
        }),
        [
            collections,
            loadLibrary,
            searchByKind,
            setDocumentsForKind,
            setFoldersForKind,
            setSearchForKind,
        ],
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
export function LibraryCollectionPage({ kind }: { kind: LibraryKind }) {
    const router = useRouter();
    const {
        collections,
        searchByKind,
        loadLibrary,
        setSearchForKind,
        setDocumentsForKind,
        setFoldersForKind,
    } = useLibraryWorkspace();
    const collection = collections[kind];
    const search = searchByKind[kind];
    const title = kind === "files" ? "Files" : "Templates";
    useEffect(() => {
        if (collection) return;
        void loadLibrary(kind);
    }, [collection, kind, loadLibrary]);
    const setDocuments: Dispatch<SetStateAction<Document[]>> = useCallback(
        (update) => setDocumentsForKind(kind, update),
        [kind, setDocumentsForKind],
    );
    const setFolders: Dispatch<SetStateAction<DocTableFolder[]>> = useCallback(
        (update) => setFoldersForKind(kind, update),
        [kind, setFoldersForKind],
    );
    const [addDocumentsAction, setAddDocumentsAction] = useState<
        (() => void) | null
    >(null);
    const [createFolderAction, setCreateFolderAction] = useState<
        (() => void) | null
    >(null);
    const [selectionActions, setSelectionActions] =
        useState<DocTableSelectionActions | null>(null);
    const loading = !collection;
    const addCollectionLabel = kind === "templates" ? "Templates" : "Files";
    const handleAddDocumentsActionChange = useCallback(
        (action: (() => void) | null) => {
            setAddDocumentsAction(() => action);
        },
        [],
    );
    const handleCreateFolderActionChange = useCallback(
        (action: (() => void) | null) => {
            setCreateFolderAction(() => action);
        },
        [],
    );
    const operations = useMemo(
        () => ({
            uploadDocument: (file: File) => uploadLibraryDocument(kind, file),
            refreshCollection: () => loadLibrary(kind),
            createFolder: (name: string, parentFolderId?: string | null) =>
                createLibraryFolder(kind, name, parentFolderId),
            renameFolder: (folderId: string, name: string) =>
                renameLibraryFolder(kind, folderId, name),
            deleteFolder: (folderId: string) =>
                deleteLibraryFolder(kind, folderId),
            moveFolder: (folderId: string, parentFolderId: string | null) =>
                moveLibraryFolder(kind, folderId, parentFolderId),
            moveDocument: (documentId: string, folderId: string | null) =>
                moveLibraryDocument(kind, documentId, folderId),
            renameDocument: (documentId: string, filename: string) =>
                renameLibraryDocument(kind, documentId, filename),
        }),
        [kind, loadLibrary],
    );
    return (
        <>
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                breadcrumbs={[{ label: "Library" }, { label: title }]}
                actions={[
                    {
                        type: "search",
                        value: search,
                        onChange: (value) => setSearchForKind(kind, value),
                        placeholder: `Search ${title.toLowerCase()}...`,
                    },
                    {
                        icon: <Upload className="h-3.5 w-3.5" />,
                        label: (
                            <span className="hidden sm:inline">
                                {addCollectionLabel}
                            </span>
                        ),
                        title: `Add ${addCollectionLabel}`,
                        onClick: addDocumentsAction ?? undefined,
                        disabled: !addDocumentsAction || loading,
                    },
                ]}
            />
            <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                <TableToolbar
                    items={LIBRARY_TABS}
                    active={kind}
                    onChange={(next) => {
                        router.push(libraryRoute(next));
                    }}
                    actions={
                        <div className="flex items-center gap-1.5">
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
                                <span className="hidden sm:inline">Folder</span>
                            </TabPillButton>
                        </div>
                    }
                />
                <DocTable
                    scopeKey={kind}
                    documents={collection?.documents ?? []}
                    setDocuments={setDocuments}
                    folders={collection?.folders ?? []}
                    setFolders={setFolders}
                    loading={loading}
                    search={search}
                    operations={operations}
                    onAddDocumentsActionChange={handleAddDocumentsActionChange}
                    onCreateFolderActionChange={
                        handleCreateFolderActionChange
                    }
                    onSelectionActionsChange={setSelectionActions}
                    selectionFirst
                    emptyDropLabel={
                        kind === "templates"
                            ? "Drop template files here"
                            : "Drop PDF, Word, Excel, or PowerPoint files here"
                    }
                />
            </div>
        </div>
        </>
    );
}
