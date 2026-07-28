"use client";

import {
    use,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useRouter } from "next/navigation";
import {
    ChevronLeft,
    ChevronRight,
    Loader2,
    Upload,
} from "lucide-react";
import {
    createProjectFolder,
    deleteChat,
    deleteProjectFolder,
    getChat,
    getProject,
    moveDocumentToFolder,
    moveSubfolderToFolder,
    removeProjectDocument,
    renameProjectFolder,
    updateChatProject,
    uploadProjectDocument,
} from "@/app/lib/beaverApi";
import { isAnonymousMode } from "@/app/lib/authMode";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import {
    ChatView,
    type ChatViewHandle,
} from "@/app/components/assistant/ChatView";
import { ProjectExplorer } from "@/app/components/projects/ProjectExplorer";
import { OwnerOnlyPopup } from "@/app/components/popups/OwnerOnlyPopup";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { SelectAssistantProjectModal } from "@/app/components/assistant/SelectAssistantProjectModal";
import { ChatDeleteWarning } from "@/app/components/assistant/ChatDeleteWarning";
import { BeaverIcon } from "@/app/components/chat/beaver-icon";
import {
    HORIZONTAL_RESIZE_HANDLE_CLASS,
    horizontalDrag,
} from "@/app/components/ui/horizontal-drag";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { cn } from "@/app/lib/utils";
import type {
    Document,
    Message,
    Project,
} from "@/app/components/shared/types";

interface Props {
    params: Promise<{ id: string; chatId: string }>;
}

const EXPLORER_MIN = 160;
const EXPLORER_DEFAULT = 280;

function AssistantGreeting({ username }: { username: string }) {
    return (
        <div className="flex items-center justify-center gap-3">
            <BeaverIcon size={28} />
            <h1 className="text-center font-serif text-3xl font-light text-gray-900">
                Hi, {username}
            </h1>
        </div>
    );
}

function Divider({ onDrag }: { onDrag: (dx: number) => void }) {
    const drag = horizontalDrag(onDrag);

    return (
        <div className="relative z-10 hidden w-0 shrink-0 md:block">
            <div
                onPointerDown={drag}
                className={cn(
                    "absolute inset-y-0 -left-2 -right-2",
                    HORIZONTAL_RESIZE_HANDLE_CLASS,
                )}
            />
        </div>
    );
}

export default function ProjectAssistantChatPage({ params }: Props) {
    const { id: projectId, chatId } = use(params);
    const router = useRouter();
    const { setSidebarOpen } = useSidebar();
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";

    const [project, setProject] = useState<Project | null>(null);
    const [chatTitle, setChatTitle] = useState<string | null>(null);
    const [chatOwnerId, setChatOwnerId] = useState<string | null>(null);
    const [chatLoaded, setChatLoaded] = useState(false);
    const [creatingChat, setCreatingChat] = useState(false);
    const [deletingChat, setDeletingChat] = useState(false);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const [projectModalOpen, setProjectModalOpen] = useState(false);
    const [explorerWidth, setExplorerWidth] = useState(EXPLORER_DEFAULT);
    const [explorerCollapsed, setExplorerCollapsed] = useState(false);
    const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);
    const [explorerDragOver, setExplorerDragOver] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const chatViewRef = useRef<ChatViewHandle>(null);
    const mobileExplorerRef = useRef<HTMLDivElement>(null);
    const mobileExplorerButtonRef = useRef<HTMLButtonElement>(null);

    const {
        setCurrentChatId,
        newChatMessages,
        setNewChatMessages,
        chats,
        saveChat,
        renameChat: renameChatInHistory,
    } = useChatHistoryContext();
    const [initialMessages] = useState<Message[]>(newChatMessages ?? []);
    const {
        messages,
        isResponseLoading,
        handleChat,
        setMessages,
        setTranscriptVersion,
        rejectedTurn,
        clearRejectedTurn,
        retryRejectedTurn,
        cancel,
    } = useAssistantChat({ initialMessages, chatId, projectId });

    const responseLoadingRef = useRef(isResponseLoading);
    const pendingProjectRouteRef = useRef<{ projectId: string | null } | null>(
        null,
    );
    const pendingInitialUserMessageRef = useRef<Message | null>(
        initialMessages.length === 1 && initialMessages[0].role === "user"
            ? initialMessages[0]
            : null,
    );
    const hasLoaded = useRef(false);
    const hasAutoSent = useRef(false);

    const refreshProject = useCallback(
        () =>
            getProject(projectId)
                .then(setProject)
                .catch(() => {}),
        [projectId],
    );

    const projectMutationSignature = useMemo(() => {
        const created: string[] = [];
        const editedPerDoc: Record<string, number> = {};
        for (const message of messages) {
            for (const event of message.events ?? []) {
                if ("isStreaming" in event && event.isStreaming) continue;
                if (event.type === "doc_created" && event.document_id) {
                    created.push(
                        `${event.document_id}:${event.version_id ?? ""}:${event.filename}`,
                    );
                } else if (event.type === "doc_edited") {
                    editedPerDoc[event.document_id] = Math.max(
                        editedPerDoc[event.document_id] ?? 0,
                        event.version_number ?? 0,
                    );
                }
            }
        }
        if (created.length === 0 && Object.keys(editedPerDoc).length === 0) {
            return "";
        }
        return [
            `created=${created.sort().join(",")}`,
            `edited=${Object.entries(editedPerDoc)
                .map(([id, version]) => `${id}=${version}`)
                .sort()
                .join(",")}`,
        ].join("|");
    }, [messages]);

    useEffect(() => {
        setSidebarOpen(false);
    }, [setSidebarOpen]);

    useEffect(() => {
        void refreshProject();
    }, [refreshProject]);

    useEffect(() => {
        if (projectMutationSignature) void refreshProject();
    }, [projectMutationSignature, refreshProject]);

    useEffect(() => {
        responseLoadingRef.current = isResponseLoading;
    }, [isResponseLoading]);

    useEffect(() => {
        setCurrentChatId(chatId);
    }, [chatId, setCurrentChatId]);

    useEffect(() => {
        if (hasLoaded.current) return;
        hasLoaded.current = true;
        if (initialMessages.length > 0) {
            setChatLoaded(true);
            return;
        }
        getChat(chatId)
            .then(({ chat, messages: loaded }) => {
                setChatTitle(chat.title);
                setChatOwnerId(chat.user_id ?? null);
                setTranscriptVersion(chat.transcript_version ?? 0);
                if (loaded.length > 0) setMessages(loaded);
            })
            .catch(() => router.replace(`/projects/${projectId}/assistant`))
            .finally(() => setChatLoaded(true));
    }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (isResponseLoading || !pendingProjectRouteRef.current) return;
        const { projectId: nextProjectId } = pendingProjectRouteRef.current;
        pendingProjectRouteRef.current = null;
        router.replace(
            nextProjectId
                ? `/projects/${nextProjectId}/assistant/chat/${chatId}`
                : `/assistant/chat/${chatId}`,
        );
    }, [chatId, isResponseLoading, router]);

    useEffect(() => {
        const match = chats?.find((chat) => chat.id === chatId);
        if (match?.title) setChatTitle(match.title);
    }, [chats, chatId]);

    useEffect(() => {
        const pendingMessage = pendingInitialUserMessageRef.current;
        if (
            pendingMessage &&
            !hasAutoSent.current &&
            !isResponseLoading &&
            messages.length === 1
        ) {
            hasAutoSent.current = true;
            pendingInitialUserMessageRef.current = null;
            setNewChatMessages(null);
            void handleChat(pendingMessage);
        }
    }, [handleChat, isResponseLoading, messages.length, setNewChatMessages]);

    const addDocuments = useCallback((documents: Document[]) => {
        setProject((current) =>
            current
                ? {
                      ...current,
                      documents: [
                          ...(current.documents ?? []),
                          ...documents,
                      ],
                  }
                : current,
        );
    }, []);

    async function handleNewChat() {
        setCreatingChat(true);
        try {
            const id = await saveChat(projectId);
            if (id) router.push(`/projects/${projectId}/assistant/chat/${id}`);
        } finally {
            setCreatingChat(false);
        }
    }

    function handleDeleteChat() {
        if (chatOwnerId && user?.id && chatOwnerId !== user.id) {
            setOwnerOnlyAction("delete this chat");
            return;
        }
        setDeleteConfirmOpen(true);
    }

    async function confirmDeleteChat() {
        setDeletingChat(true);
        try {
            await deleteChat(chatId);
            setDeleteConfirmOpen(false);
            router.push(`/projects/${projectId}/assistant`);
        } finally {
            setDeletingChat(false);
        }
    }

    async function handleRenameChat() {
        if (chatOwnerId && user?.id && chatOwnerId !== user.id) {
            setOwnerOnlyAction("rename this chat");
            return;
        }
        const nextTitle = window.prompt(
            "Rename chat",
            chatTitle ?? "Untitled New Chat",
        );
        const trimmed = nextTitle?.trim();
        if (!trimmed || trimmed === chatTitle) return;
        setChatTitle(trimmed);
        await renameChatInHistory(chatId, trimmed);
    }

    async function uploadFiles(files: File[]) {
        if (files.length === 0) return;
        setUploading(true);
        try {
            addDocuments(
                await Promise.all(
                    files.map((file) =>
                        uploadProjectDocument(projectId, file),
                    ),
                ),
            );
        } catch (error) {
            console.error("Upload failed:", error);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    async function handleCreateFolder(
        parentId: string | null,
        name: string,
    ) {
        const folder = await createProjectFolder(
            projectId,
            name,
            parentId ?? undefined,
        );
        setProject((current) =>
            current
                ? {
                      ...current,
                      folders: [...(current.folders ?? []), folder],
                  }
                : current,
        );
    }

    async function handleRenameFolder(folderId: string, name: string) {
        await renameProjectFolder(projectId, folderId, name);
        setProject((current) =>
            current
                ? {
                      ...current,
                      folders: (current.folders ?? []).map((folder) =>
                          folder.id === folderId
                              ? { ...folder, name }
                              : folder,
                      ),
                  }
                : current,
        );
    }

    async function handleDeleteFolder(folderId: string) {
        const toDelete = new Set<string>();
        function collectIds(id: string) {
            toDelete.add(id);
            (project?.folders ?? [])
                .filter((folder) => folder.parent_folder_id === id)
                .forEach((folder) => collectIds(folder.id));
        }
        collectIds(folderId);
        await deleteProjectFolder(projectId, folderId);
        setProject((current) =>
            current
                ? {
                      ...current,
                      folders: (current.folders ?? []).filter(
                          (folder) => !toDelete.has(folder.id),
                      ),
                      documents: (current.documents ?? []).map((document) =>
                          document.folder_id &&
                          toDelete.has(document.folder_id)
                              ? { ...document, folder_id: null }
                              : document,
                      ),
                  }
                : current,
        );
    }

    async function handleMoveDoc(
        documentId: string,
        targetFolderId: string | null,
    ) {
        setProject((current) =>
            current
                ? {
                      ...current,
                      documents: (current.documents ?? []).map((document) =>
                          document.id === documentId
                              ? { ...document, folder_id: targetFolderId }
                              : document,
                      ),
                  }
                : current,
        );
        await moveDocumentToFolder(projectId, documentId, targetFolderId);
    }

    async function handleMoveFolder(
        folderId: string,
        targetFolderId: string | null,
    ) {
        setProject((current) =>
            current
                ? {
                      ...current,
                      folders: (current.folders ?? []).map((folder) =>
                          folder.id === folderId
                              ? {
                                    ...folder,
                                    parent_folder_id: targetFolderId,
                                }
                              : folder,
                      ),
                  }
                : current,
        );
        await moveSubfolderToFolder(projectId, folderId, targetFolderId);
    }

    async function handleDeleteDoc(documentId: string) {
        await removeProjectDocument(projectId, documentId);
        chatViewRef.current?.closeDocument(documentId);
        setProject((current) =>
            current
                ? {
                      ...current,
                      documents: (current.documents ?? []).filter(
                          (document) => document.id !== documentId,
                      ),
                  }
                : current,
        );
    }

    function handleChatDrop(event: React.DragEvent) {
        event.preventDefault();
        const documentId = event.dataTransfer.getData(
            "application/mike-doc",
        );
        const document = project?.documents?.find(
            (item) => item.id === documentId,
        );
        if (document) chatViewRef.current?.attachDocument(document);
    }

    const resizeExplorer = useCallback((dx: number) => {
        setExplorerWidth((width) => Math.max(EXPLORER_MIN, width + dx));
    }, []);

    const closeMobileExplorer = useCallback(() => {
        setMobileExplorerOpen(false);
        requestAnimationFrame(() => mobileExplorerButtonRef.current?.focus());
    }, []);

    const openMobileExplorer = useCallback(() => {
        setMobileExplorerOpen(true);
        requestAnimationFrame(() => mobileExplorerRef.current?.focus());
    }, []);

    async function changeProject(nextProjectId: string | null) {
        const updated = await updateChatProject(chatId, nextProjectId);
        if (responseLoadingRef.current) {
            pendingProjectRouteRef.current = {
                projectId: updated.project_id,
            };
            return;
        }
        router.replace(
            updated.project_id
                ? `/projects/${updated.project_id}/assistant/chat/${chatId}`
                : `/assistant/chat/${chatId}`,
        );
    }

    return (
        <div className="flex h-full flex-col">
            <PageHeader
                shrink
                breadcrumbs={[
                    {
                        label: "Projects",
                        onClick: () => router.push("/projects"),
                    },
                    project
                        ? {
                              label: project.name,
                              onClick: () =>
                                  router.push(`/projects/${projectId}/assistant`),
                              title: "Back to project",
                          }
                        : {
                              loading: true,
                              skeletonClassName: "w-32",
                              onClick: () =>
                                  router.push(`/projects/${projectId}/assistant`),
                              title: "Back to project",
                          },
                    chatLoaded
                        ? { label: chatTitle ?? "Untitled New Chat" }
                        : {
                              loading: true,
                              skeletonClassName: "w-40",
                          },
                ]}
                actions={[
                    {
                        type: "custom",
                        render: (
                            <button
                                type="button"
                                onClick={() => {
                                    if (
                                        chatOwnerId &&
                                        user?.id &&
                                        chatOwnerId !== user.id
                                    ) {
                                        setOwnerOnlyAction(
                                            "change this chat's project",
                                        );
                                        return;
                                    }
                                    setProjectModalOpen(true);
                                }}
                                aria-label={`Change project: ${project?.name ?? "current project"}`}
                                className="inline-flex max-w-48 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
                            >
                                <FolderSvgIcon className="h-3.5 w-3.5 shrink-0" />
                                <span className="hidden truncate sm:inline">
                                    {project?.name ?? "Project"}
                                </span>
                            </button>
                        ),
                    },
                    {
                        type: "new",
                        onClick: handleNewChat,
                        loading: creatingChat,
                        title: "New chat",
                    },
                    {
                        type: "custom",
                        render: (
                            <button
                                type="button"
                                onClick={() => void handleRenameChat()}
                                className="inline-flex h-8 items-center rounded-md border border-gray-300 bg-white px-3 text-xs font-medium text-gray-800 hover:bg-gray-50"
                            >
                                Rename
                            </button>
                        ),
                    },
                    {
                        type: "custom",
                        render: (
                            <button
                                type="button"
                                onClick={handleDeleteChat}
                                disabled={deletingChat}
                                className="inline-flex h-8 items-center rounded-md border border-red-300 bg-white px-3 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {deletingChat ? "Deleting..." : "Delete"}
                            </button>
                        ),
                    },
                ]}
            />

            <div className="relative flex min-h-0 flex-1 overflow-hidden border-t border-gray-200">
                <div
                    ref={mobileExplorerRef}
                    id="project-chat-explorer"
                    tabIndex={-1}
                    style={{ width: explorerWidth }}
                    className={`shrink-0 flex-col border-r border-gray-200 bg-white ${
                        mobileExplorerOpen
                            ? "absolute inset-y-0 left-0 z-40 flex shadow-lg"
                            : "hidden"
                    } ${
                        explorerCollapsed
                            ? "md:hidden"
                            : "md:relative md:inset-auto md:z-auto md:flex md:shadow-none"
                    }`}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") closeMobileExplorer();
                    }}
                    onDragOver={(event) => {
                        event.preventDefault();
                        const types = Array.from(event.dataTransfer.types);
                        if (
                            !types.includes("application/mike-doc") &&
                            !types.includes("application/mike-folder")
                        ) {
                            setExplorerDragOver(true);
                        }
                    }}
                    onDragLeave={(event) => {
                        if (
                            !event.currentTarget.contains(
                                event.relatedTarget as Node,
                            )
                        ) {
                            setExplorerDragOver(false);
                        }
                    }}
                    onDrop={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setExplorerDragOver(false);
                        void uploadFiles(Array.from(event.dataTransfer.files));
                    }}
                >
                    <div className="flex h-10 shrink-0 items-center justify-between border-b border-gray-200 px-3">
                        <span className="text-xs text-gray-700">Explorer</span>
                        <div className="flex items-center gap-1">
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt"
                                multiple
                                className="hidden"
                                onChange={(event) =>
                                    void uploadFiles(
                                        Array.from(event.target.files ?? []),
                                    )
                                }
                            />
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={uploading}
                                title="Upload documents"
                                className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40"
                            >
                                {uploading ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Upload className="h-3.5 w-3.5" />
                                )}
                            </button>
                            <button
                                type="button"
                                onClick={closeMobileExplorer}
                                title="Close explorer"
                                className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 md:hidden"
                            >
                                <ChevronLeft className="h-3.5 w-3.5" />
                            </button>
                            <button
                                type="button"
                                onClick={() => setExplorerCollapsed(true)}
                                title="Collapse explorer"
                                className="hidden rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 md:block"
                            >
                                <ChevronLeft className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </div>
                    <div
                        className={`relative h-full flex-1 overflow-y-auto ${
                            explorerDragOver ? "bg-blue-50" : ""
                        }`}
                    >
                        {explorerDragOver && (
                            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                                <p className="text-xs font-medium text-blue-500">
                                    Drop to upload
                                </p>
                            </div>
                        )}
                        <ProjectExplorer
                            documents={project?.documents ?? []}
                            folders={project?.folders ?? []}
                            selectedDocId={selectedDocId}
                            onDocClick={(document) => {
                                chatViewRef.current?.openDocument(document);
                                setMobileExplorerOpen(false);
                            }}
                            onCreateFolder={handleCreateFolder}
                            onRenameFolder={handleRenameFolder}
                            onDeleteFolder={handleDeleteFolder}
                            onDeleteDoc={handleDeleteDoc}
                            documentRemovalMode={
                                isAnonymousMode ? "detach" : "delete"
                            }
                            onMoveDoc={handleMoveDoc}
                            onMoveFolder={handleMoveFolder}
                        />
                    </div>
                </div>
                {!explorerCollapsed && <Divider onDrag={resizeExplorer} />}
                {explorerCollapsed && (
                    <div className="hidden shrink-0 flex-col border-r border-gray-200 md:flex">
                        <div className="flex h-10 shrink-0 items-center justify-center border-b border-gray-200 px-1">
                            <button
                                type="button"
                                onClick={() => setExplorerCollapsed(false)}
                                title="Expand explorer"
                                className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                            >
                                <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </div>
                )}

                <div
                    className="relative min-w-0 flex-1"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={handleChatDrop}
                >
                    <button
                        ref={mobileExplorerButtonRef}
                        type="button"
                        aria-controls="project-chat-explorer"
                        aria-expanded={mobileExplorerOpen}
                        onClick={openMobileExplorer}
                        className="absolute left-2 top-2 z-20 inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-600 shadow-sm md:hidden"
                    >
                        <FolderSvgIcon className="h-3.5 w-3.5" />
                        Files
                    </button>
                    <ChatView
                        ref={chatViewRef}
                        chatId={chatId}
                        messages={messages}
                        isResponseLoading={isResponseLoading}
                        handleChat={handleChat}
                        cancel={cancel}
                        rejectedTurn={rejectedTurn}
                        onRejectedTurnRestored={clearRejectedTurn}
                        onRetryRejectedTurn={() => void retryRejectedTurn()}
                        projectId={projectId}
                        projectName={project?.name}
                        projectCmNumber={project?.cm_number}
                        hideAddDocButton
                        useDisplayedDocumentContext
                        onDocumentsUploaded={addDocuments}
                        onActiveDocumentChange={setSelectedDocId}
                    />
                    {!chatLoaded ? (
                        <div className="absolute inset-0 z-40 space-y-4 bg-white px-8 py-8">
                            <div className="ml-auto h-12 w-3/5 rounded-2xl bg-gray-100" />
                            <div className="h-3 w-full rounded bg-gray-200" />
                            <div className="h-3 w-4/6 rounded bg-gray-200" />
                        </div>
                    ) : messages.length === 0 ? (
                        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center pb-24">
                            <AssistantGreeting username={username} />
                        </div>
                    ) : null}
                </div>
            </div>

            <OwnerOnlyPopup
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
            <ChatDeleteWarning
                open={deleteConfirmOpen}
                busy={deletingChat}
                onCancel={() => setDeleteConfirmOpen(false)}
                onConfirm={() => void confirmDeleteChat()}
            />
            <SelectAssistantProjectModal
                open={projectModalOpen}
                onClose={() => setProjectModalOpen(false)}
                chatTitle={chatTitle}
                currentLocation={project?.name}
                currentProjectId={projectId}
                onSelectProject={changeProject}
            />
        </div>
    );
}
