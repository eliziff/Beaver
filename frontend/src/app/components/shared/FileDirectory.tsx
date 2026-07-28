"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Document, LibraryFolder } from "./types";
import { FileTypeIcon } from "./FileTypeIcon";
import { FolderSvgIcon } from "./FolderSvgIcon";
import { SearchBar } from "@/app/components/ui/search-bar";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { SkeletonLine } from "./TablePrimitive";
import { useDirectoryData, type DirectoryTab } from "./useDirectoryData";
import {
    CheckboxControl,
    CheckboxInput,
} from "@/app/components/ui/checkbox";
import {
    APP_SURFACE_ACTIVE_CLASS,
    APP_SURFACE_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";
import { formatBytes, formatDate } from "@/app/lib/utils";

const DIRECTORY_GRID_CLASS =
    "grid grid-cols-[36px_18px_minmax(0,1fr)_48px] items-center gap-2 sm:grid-cols-[36px_18px_minmax(0,1fr)_48px_84px] md:grid-cols-[36px_18px_minmax(0,1fr)_48px_84px_64px]";
const DIRECTORY_FOLDER_CONTENT_CLASS =
    "col-span-3 grid min-w-0 grid-cols-[18px_minmax(0,1fr)_48px] items-center gap-2 sm:col-span-4 sm:grid-cols-[18px_minmax(0,1fr)_48px_84px] md:col-span-5 md:grid-cols-[18px_minmax(0,1fr)_48px_84px_64px]";

const DIRECTORY_TABS: { value: DirectoryTab; label: string }[] = [
    { value: "files", label: "Files" },
    { value: "templates", label: "Templates" },
    { value: "projects", label: "Projects" },
];

const EMPTY_DOCUMENTS: Document[] = [];
const EMPTY_FOLDERS: LibraryFolder[] = [];

function versionLabel(doc: Document) {
    const n = doc.active_version_number;
    return typeof n === "number" && Number.isFinite(n) && n >= 1
        ? `${n}`
        : null;
}

export function DocFileIcon({ fileType }: { fileType: string | null }) {
    return <FileTypeIcon fileType={fileType} className="h-3.5 w-3.5" />;
}

interface FileDirectoryProps {
    documents?: Document[];
    loading?: boolean;
    selectedDocuments: Document[];
    onChange: (documents: Document[]) => void;
    uploadingFilenames?: string[];
    showTabs: boolean;
    initialTab?: DirectoryTab;
    excludeProjectId?: string;
}

export function FileDirectory({
    documents = EMPTY_DOCUMENTS,
    loading: externalLoading = false,
    selectedDocuments,
    onChange,
    uploadingFilenames = [],
    showTabs,
    initialTab = "files",
    excludeProjectId,
}: FileDirectoryProps) {
    const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
        new Set(),
    );
    const [expandedLibraryFolders, setExpandedLibraryFolders] = useState<
        Set<string>
    >(new Set());
    const [selectedTab, setSelectedTab] = useState<DirectoryTab>(initialTab);

    // Follow initialTab changes so keep-mounted parents (which never remount
    // this component) can still steer the starting tab per open.
    useEffect(() => {
        setSelectedTab(initialTab);
    }, [initialTab]);
    const [search, setSearch] = useState("");
    const {
        loadingTabs,
        standaloneDocuments,
        templateDocuments,
        fileFolders: loadedFileFolders,
        templateFolders: loadedTemplateFolders,
        projects,
        loadTab,
    } = useDirectoryData(showTabs, initialTab);

    useEffect(() => {
        if (!showTabs || initialTab === "templates") return;
        void loadTab("templates");
    }, [initialTab, showTabs, loadTab]);
    const directoryStandaloneDocs = useMemo(
        () =>
            showTabs
                ? [
                      ...documents.filter(
                          (doc) =>
                              !standaloneDocuments.some(
                                  (loadedDoc) => loadedDoc.id === doc.id,
                              ),
                      ),
                      ...standaloneDocuments,
                  ]
                : documents,
        [documents, showTabs, standaloneDocuments],
    );
    const directoryTemplateDocs = showTabs
        ? templateDocuments
        : EMPTY_DOCUMENTS;
    const directoryFileFolders = showTabs
        ? loadedFileFolders
        : EMPTY_FOLDERS;
    const directoryTemplateFolders = showTabs
        ? loadedTemplateFolders
        : EMPTY_FOLDERS;
    const localDirectoryProjects = useMemo(
        () =>
            showTabs
                ? projects.filter(
                      (project) => project.id !== excludeProjectId,
                  )
                : [],
        [excludeProjectId, projects, showTabs],
    );
    const selectedIds = useMemo(
        () => new Set(selectedDocuments.map((document) => document.id)),
        [selectedDocuments],
    );

    const q = search.trim().toLowerCase();
    const visibleStandaloneDocs = q
        ? directoryStandaloneDocs.filter((doc) =>
              doc.filename.toLowerCase().includes(q),
          )
        : directoryStandaloneDocs;
    const visibleUploadingFilenames = q
        ? uploadingFilenames.filter((filename) =>
              filename.toLowerCase().includes(q),
          )
        : uploadingFilenames;
    const visibleTemplateDocs = q
        ? directoryTemplateDocs.filter((doc) =>
              doc.filename.toLowerCase().includes(q),
          )
        : directoryTemplateDocs;
    const visibleDirectoryProjects = q
        ? localDirectoryProjects
              .map((project) => {
                  const docs = project.documents ?? [];
                  const projectMatches =
                      project.name.toLowerCase().includes(q) ||
                      (project.cm_number ?? "").toLowerCase().includes(q);
                  return {
                      ...project,
                      documents: projectMatches
                          ? docs
                          : docs.filter((doc) =>
                                doc.filename.toLowerCase().includes(q),
                            ),
                  };
              })
              .filter((project) => {
                  const docs = project.documents ?? [];
                  return (
                      docs.length > 0 ||
                      project.name.toLowerCase().includes(q) ||
                      (project.cm_number ?? "").toLowerCase().includes(q)
                  );
              })
        : localDirectoryProjects;
    const activeTab = showTabs ? selectedTab : "files";
    const activeLoading = showTabs
        ? !!loadingTabs[activeTab]
        : externalLoading;
    const hasVisibleFiles =
        visibleStandaloneDocs.length > 0 ||
        visibleUploadingFilenames.length > 0;
    const hasVisibleProjects = visibleDirectoryProjects.length > 0;
    const hasVisibleTemplates = visibleTemplateDocs.length > 0;
    const activeTabHasNoResults =
        q &&
        ((activeTab === "files" && !hasVisibleFiles) ||
            (activeTab === "projects" && !hasVisibleProjects) ||
            (activeTab === "templates" && !hasVisibleTemplates));

    function toggle(doc: Document) {
        const next = new Map(
            selectedDocuments.map((document) => [document.id, document]),
        );
        if (next.has(doc.id)) {
            next.delete(doc.id);
        } else {
            next.set(doc.id, doc);
        }
        onChange([...next.values()]);
    }

    function toggleFolder(projectId: string) {
        setExpandedProjects((prev) => {
            const next = new Set(prev);
            if (next.has(projectId)) {
                next.delete(projectId);
            } else {
                next.add(projectId);
            }
            return next;
        });
    }

    function toggleDocuments(docs: Document[]) {
        if (docs.length === 0) return;

        const allSelected = docs.every((doc) => selectedIds.has(doc.id));
        const next = new Map(
            selectedDocuments.map((document) => [document.id, document]),
        );
        if (allSelected) {
            docs.forEach((doc) => next.delete(doc.id));
        } else {
            docs.forEach((doc) => next.set(doc.id, doc));
        }
        onChange([...next.values()]);
    }

    function documentFolderId(doc: Document) {
        return doc.folder_id ?? doc.library_folder_id ?? null;
    }

    function childFolders(
        folders: LibraryFolder[],
        parentFolderId: string | null,
    ) {
        return folders.filter(
            (folder) => (folder.parent_folder_id ?? null) === parentFolderId,
        );
    }

    function folderDocuments(docs: Document[], folderId: string | null) {
        return docs.filter((doc) => documentFolderId(doc) === folderId);
    }

    function collectFolderDocuments(
        folders: LibraryFolder[],
        docs: Document[],
        folderId: string,
    ): Document[] {
        const directDocs = folderDocuments(docs, folderId);
        const nestedDocs = childFolders(folders, folderId).flatMap((folder) =>
            collectFolderDocuments(folders, docs, folder.id),
        );
        return [...directDocs, ...nestedDocs];
    }

    function toggleLibraryFolder(folderId: string) {
        setExpandedLibraryFolders((prev) => {
            const next = new Set(prev);
            if (next.has(folderId)) {
                next.delete(folderId);
            } else {
                next.add(folderId);
            }
            return next;
        });
    }

    function handleTabChange(tab: DirectoryTab) {
        setSelectedTab(tab);
        void loadTab(tab);
    }

    function indentedRowPadding(depth: number) {
        if (depth <= 0) return 8;
        return 4 + depth * 20;
    }

    function renderDocumentRow(doc: Document, paddingLeft = 8) {
        const selected = selectedIds.has(doc.id);
        return (
            <label
                key={doc.id}
                style={{ paddingLeft }}
                className={`min-h-10 w-full cursor-pointer rounded-md ${DIRECTORY_GRID_CLASS} pr-2 text-left text-xs ${
                    selected
                        ? APP_SURFACE_ACTIVE_CLASS
                        : APP_SURFACE_HOVER_CLASS
                }`}
            >
                <span className="flex min-h-9 min-w-9 items-center justify-center">
                    <CheckboxInput
                        checked={selected}
                        aria-label={`Select ${doc.filename}`}
                        onChange={() => toggle(doc)}
                    />
                </span>
                <DocFileIcon fileType={doc.file_type} />
                <span
                    className={`min-w-0 truncate ${
                        selected ? "text-gray-900" : "text-gray-700"
                    }`}
                >
                    {doc.filename}
                </span>
                <FileDirectoryMetaCells
                    version={versionLabel(doc)}
                    created={formatDate(doc.created_at)}
                    size={formatBytes(doc.size_bytes)}
                />
            </label>
        );
    }

    function renderLibraryFolderRows(
        folders: LibraryFolder[],
        docs: Document[],
        parentFolderId: string | null,
        depth = 0,
    ): ReactNode {
        return childFolders(folders, parentFolderId).map((folder) => {
            const docsInFolder = collectFolderDocuments(folders, docs, folder.id);
            const allSelected =
                docsInFolder.length > 0 &&
                docsInFolder.every((doc) => selectedIds.has(doc.id));
            const someSelected =
                docsInFolder.some((doc) => selectedIds.has(doc.id)) &&
                !allSelected;
            const isExpanded = !!q || expandedLibraryFolders.has(folder.id);
            return (
                <div key={folder.id}>
                    <div
                        style={{ paddingLeft: indentedRowPadding(depth) }}
                        className={`min-h-10 w-full rounded-md ${DIRECTORY_GRID_CLASS} pr-2 text-left text-xs ${APP_SURFACE_HOVER_CLASS}`}
                    >
                        <CheckboxControl
                            ref={(input) => {
                                if (input) input.indeterminate = someSelected;
                            }}
                            checked={allSelected}
                            aria-checked={someSelected ? "mixed" : allSelected}
                            aria-label={`Select all files in ${folder.name}`}
                            disabled={docsInFolder.length === 0}
                            onChange={() => toggleDocuments(docsInFolder)}
                        />
                        <button
                            type="button"
                            aria-expanded={isExpanded}
                            onClick={() => toggleLibraryFolder(folder.id)}
                            className={`${DIRECTORY_FOLDER_CONTENT_CLASS} rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600`}
                        >
                            <FolderSvgIcon
                                open={isExpanded}
                                className="h-[18px] w-[18px] shrink-0"
                            />
                            <span className="min-w-0 truncate font-medium text-gray-700">
                                {folder.name}
                            </span>
                            <span className="truncate text-gray-400">-</span>
                            <span className="hidden truncate text-gray-400 sm:block">
                                {formatDate(folder.created_at) ?? "--"}
                            </span>
                            <span className="hidden truncate text-right text-gray-400 md:block">
                                {docsInFolder.length}{" "}
                                {docsInFolder.length === 1 ? "file" : "files"}
                            </span>
                        </button>
                    </div>
                    {isExpanded && (
                        <div>
                            {renderLibraryFolderRows(
                                folders,
                                docs,
                                folder.id,
                                depth + 1,
                            )}
                            {folderDocuments(docs, folder.id).map((doc) =>
                                renderDocumentRow(
                                    doc,
                                    indentedRowPadding(depth + 1),
                                ),
                            )}
                            {docsInFolder.length === 0 && (
                                <p
                                    className="py-1 text-xs text-gray-400"
                                    style={{
                                        paddingLeft:
                                            indentedRowPadding(depth + 1),
                                    }}
                                >
                                    Empty
                                </p>
                            )}
                        </div>
                    )}
                </div>
            );
        });
    }

    if (activeLoading) {
        return (
            <div className="flex min-h-0 flex-1 flex-col space-y-2">
                <SearchBar
                    value={search}
                    onValueChange={setSearch}
                    placeholder="Search..."
                    autoFocus
                    wrapperClassName={showTabs ? "mb-4" : "mb-3"}
                />
                {(showTabs || selectedIds.size > 0) && (
                    <FileDirectoryControls
                        activeTab={activeTab}
                        onChange={handleTabChange}
                        selectedCount={selectedIds.size}
                        showTabs={showTabs}
                    />
                )}
                <div className="flex min-h-0 flex-1 flex-col">
                    <FileDirectoryHeader />
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {[60, 45, 75, 55, 40].map((w, i) => (
                            <div
                                key={i}
                                className={`${DIRECTORY_GRID_CLASS} min-h-10 rounded-md px-2`}
                            >
                                <div className="flex min-h-9 min-w-9 items-center justify-center">
                                    <div className="h-[18px] w-[18px] shrink-0 rounded border border-gray-200" />
                                </div>
                                <div className="h-[18px] w-[18px] shrink-0 rounded bg-gray-100" />
                                <div
                                    className="h-3 rounded bg-gray-100"
                                    style={{ width: `${w}%` }}
                                />
                                <SkeletonLine className="w-8" />
                                <SkeletonLine className="hidden w-14 sm:block" />
                                <SkeletonLine className="ml-auto hidden w-10 md:block" />
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    if (
        !showTabs &&
        directoryStandaloneDocs.length === 0 &&
        uploadingFilenames.length === 0
    ) {
        return (
            <div className="flex min-h-0 flex-1 flex-col space-y-2">
                <SearchBar
                    value={search}
                    onValueChange={setSearch}
                    placeholder="Search..."
                    autoFocus
                    wrapperClassName={showTabs ? "mb-4" : "mb-3"}
                />
                {(showTabs || selectedIds.size > 0) && (
                    <FileDirectoryControls
                        activeTab={activeTab}
                        onChange={handleTabChange}
                        selectedCount={selectedIds.size}
                        showTabs={showTabs}
                    />
                )}
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <DirectoryEmpty>
                        {q ? "No matches found" : "No documents available"}
                    </DirectoryEmpty>
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col space-y-2 rounded-sm">
            <SearchBar
                value={search}
                onValueChange={setSearch}
                placeholder="Search..."
                autoFocus
                wrapperClassName={showTabs ? "mb-4" : "mb-3"}
            />
            {(showTabs || selectedIds.size > 0) && (
                <FileDirectoryControls
                    activeTab={activeTab}
                    onChange={handleTabChange}
                    selectedCount={selectedIds.size}
                    showTabs={showTabs}
                />
            )}
            {activeTabHasNoResults ? (
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <p className="text-center text-sm text-gray-400 py-8">
                        No matches found
                    </p>
                </div>
            ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                    <FileDirectoryHeader />
                    <div className="min-h-0 flex-1 overflow-y-auto">
                    {activeTab === "files" && (
                        <>
                            {visibleUploadingFilenames.map((filename) => (
                                <div
                                    key={`uploading-${filename}`}
                                    className={`min-h-10 w-full ${DIRECTORY_GRID_CLASS} pl-2 pr-2 text-left text-xs`}
                                >
                                    <span className="flex min-h-9 min-w-9 items-center justify-center">
                                        <span className="h-[18px] w-[18px] rounded border border-gray-300" />
                                    </span>
                                    <Loader2 className="h-[18px] w-[18px] shrink-0 animate-spin text-gray-400" />
                                    <span className="flex-1 truncate text-gray-400">
                                        {filename}
                                    </span>
                                    <FileDirectoryMetaCells
                                        version={null}
                                        created="Uploading"
                                        size={null}
                                    />
                                </div>
                            ))}
                            {!q &&
                                renderLibraryFolderRows(
                                    directoryFileFolders,
                                    directoryStandaloneDocs,
                                    null,
                                )}
                            {(q
                                ? visibleStandaloneDocs
                                : folderDocuments(directoryStandaloneDocs, null)
                            ).map((doc) => renderDocumentRow(doc))}
                            {!q &&
                                visibleStandaloneDocs.length === 0 &&
                                directoryFileFolders.length === 0 &&
                                visibleUploadingFilenames.length === 0 && (
                                    <DirectoryEmpty>
                                        No documents available
                                    </DirectoryEmpty>
                                )}
                        </>
                    )}

                    {activeTab === "templates" && (
                        <>
                            {!q &&
                                renderLibraryFolderRows(
                                    directoryTemplateFolders,
                                    directoryTemplateDocs,
                                    null,
                                )}
                            {(q
                                ? visibleTemplateDocs
                                : folderDocuments(directoryTemplateDocs, null)
                            ).map((doc) => renderDocumentRow(doc))}
                            {!q &&
                                visibleTemplateDocs.length === 0 &&
                                directoryTemplateFolders.length === 0 && (
                                    <DirectoryEmpty>No templates yet</DirectoryEmpty>
                                )}
                        </>
                    )}

                    {activeTab === "projects" &&
                        visibleDirectoryProjects.map((project) => {
                            const isExpanded =
                                !!q || expandedProjects.has(project.id);
                            const docs = project.documents ?? [];
                            const projectDocIds = docs.map((doc) => doc.id);
                            const allProjectDocsSelected =
                                projectDocIds.length > 0 &&
                                projectDocIds.every((id) =>
                                    selectedIds.has(id),
                                );
                            const someProjectDocsSelected =
                                projectDocIds.some((id) =>
                                    selectedIds.has(id),
                                ) && !allProjectDocsSelected;
                            return (
                                <div key={project.id}>
                                    <div
                                        className={`min-h-10 w-full rounded-md ${DIRECTORY_GRID_CLASS} px-2 text-left text-xs ${APP_SURFACE_HOVER_CLASS}`}
                                    >
                                        <CheckboxControl
                                            ref={(input) => {
                                                if (input) {
                                                    input.indeterminate =
                                                        someProjectDocsSelected;
                                                }
                                            }}
                                            checked={allProjectDocsSelected}
                                            aria-checked={
                                                someProjectDocsSelected
                                                    ? "mixed"
                                                    : allProjectDocsSelected
                                            }
                                            aria-label={`Select all files in ${project.name}`}
                                            disabled={docs.length === 0}
                                            onChange={() =>
                                                toggleDocuments(docs)
                                            }
                                        />
                                        <button
                                            type="button"
                                            aria-expanded={isExpanded}
                                            onClick={() =>
                                                toggleFolder(project.id)
                                            }
                                            className={`${DIRECTORY_FOLDER_CONTENT_CLASS} rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600`}
                                        >
                                            <FolderSvgIcon
                                                open={isExpanded}
                                                className="h-[18px] w-[18px] shrink-0"
                                            />
                                            <span className="min-w-0 truncate font-medium text-gray-700">
                                                {project.name}
                                                {project.cm_number && (
                                                    <span className="ml-1 font-normal text-gray-400">
                                                        (#{project.cm_number})
                                                    </span>
                                                )}
                                            </span>
                                            <span className="truncate text-gray-400">
                                                -
                                            </span>
                                            <span className="hidden truncate text-gray-400 sm:block">
                                                {formatDate(
                                                    project.created_at,
                                                ) ?? "--"}
                                            </span>
                                            <span className="hidden truncate text-right text-gray-400 md:block">
                                                {docs.length}{" "}
                                                {docs.length === 1
                                                    ? "file"
                                                    : "files"}
                                            </span>
                                        </button>
                                    </div>
                                    {isExpanded && (
                                        <div>
                                            {docs.length === 0 ? (
                                                <p className="pl-7 py-1 text-xs text-gray-400">
                                                    Empty
                                                </p>
                                            ) : (
                                                docs.map((doc) =>
                                                    renderDocumentRow(doc, 28),
                                                )
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    {activeTab === "projects" &&
                        !q &&
                        visibleDirectoryProjects.length === 0 && (
                            <DirectoryEmpty>No projects yet</DirectoryEmpty>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function DirectoryEmpty({ children }: { children: ReactNode }) {
    return (
        <div className="flex flex-col items-center py-8 text-center text-sm text-gray-400">
            <FolderSvgIcon className="mb-2 h-6 w-6" />
            {children}
        </div>
    );
}

function FileDirectoryHeader({ indented = false }: { indented?: boolean }) {
    return (
        <div
            className={`${DIRECTORY_GRID_CLASS} ${
                indented ? "pl-7 pr-2" : "px-2"
            } pb-1 pt-0.5 text-[11px] font-medium text-gray-400`}
        >
            <span />
            <span className="col-span-2">Name</span>
            <span>Version</span>
            <span className="hidden sm:block">Created</span>
            <span className="hidden text-right md:block">Size</span>
        </div>
    );
}

function FileDirectoryMetaCells({
    version,
    created,
    size,
}: {
    version: string | null;
    created: string | null;
    size: string | null;
}) {
    return (
        <>
            <span className="truncate text-gray-400">{version ?? "--"}</span>
            <span className="hidden truncate text-gray-400 sm:block">
                {created ?? "--"}
            </span>
            <span className="hidden truncate text-right text-gray-400 md:block">
                {size ?? "--"}
            </span>
        </>
    );
}

function FileDirectoryControls({
    activeTab,
    onChange,
    selectedCount,
    showTabs,
}: {
    activeTab: DirectoryTab;
    onChange: (tab: DirectoryTab) => void;
    selectedCount: number;
    showTabs: boolean;
}) {
    return (
        <div className="flex items-center justify-between gap-3 pr-2">
            {showTabs ? (
                <div className="flex items-center gap-1.5">
                    {DIRECTORY_TABS.map((tab) => {
                        const active = activeTab === tab.value;
                        return (
                            <TabPillButton
                                key={tab.value}
                                active={active}
                                onClick={() => onChange(tab.value)}
                            >
                                {tab.label}
                            </TabPillButton>
                        );
                    })}
                </div>
            ) : (
                <span />
            )}
            {selectedCount > 0 && (
                <span className="shrink-0 text-xs text-gray-400">
                    {selectedCount} selected
                </span>
            )}
        </div>
    );
}
