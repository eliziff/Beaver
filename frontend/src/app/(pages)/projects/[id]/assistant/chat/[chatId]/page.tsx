"use client";
import {
    use,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { deleteChat } from "@/app/lib/beaverApi";
import { isAnonymousMode } from "@/app/lib/authMode";
import { useAssistantChatRoute } from "@/app/hooks/useAssistantChatRoute";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import {
    ChatView,
    type ChatViewHandle,
} from "@/app/components/assistant/ChatView";
import { ProjectExplorer } from "@/app/components/projects/ProjectExplorer";
import { useProjectWorkspace } from "@/app/components/projects/ProjectWorkspace";
import { useProjectFiles } from "@/app/components/projects/useProjectFiles";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { SelectAssistantProjectModal } from "@/app/components/assistant/SelectAssistantProjectModal";
import { ChatDeleteWarning } from "@/app/components/assistant/ChatDeleteWarning";
import { BeaverIcon } from "@/app/components/chat/beaver-icon";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useSidebar } from "@/app/contexts/SidebarContext";
interface Props {
    params: Promise<{ id: string; chatId: string }>;
}
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
export default function ProjectAssistantChatPage({ params }: Props) {
    const { id: projectId, chatId } = use(params);
    return (
        <ProjectAssistantChat key={chatId} projectId={projectId} chatId={chatId} />
    );
}
function ProjectAssistantChat({
    projectId,
    chatId,
}: {
    projectId: string;
    chatId: string;
}) {
    const router = useRouter();
    const { setSidebarOpen } = useSidebar();
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const {
        createChat,
        creatingChat,
        project,
        refreshProject,
        setOwnerOnlyAction,
    } = useProjectWorkspace();
    const projectFiles = useProjectFiles();
    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";
    const [deletingChat, setDeletingChat] = useState(false);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [projectModalOpen, setProjectModalOpen] = useState(false);
    const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const chatViewRef = useRef<ChatViewHandle>(null);
    const { renameChat: renameChatInHistory } = useChatHistoryContext();
    const {
        messages,
        isResponseLoading,
        handleChat,
        rejectedTurn,
        clearRejectedTurn,
        retryRejectedTurn,
        cancel,
        chatTitle,
        chatOwnerId,
        chatLoaded,
        changeProject,
    } = useAssistantChatRoute({ chatId, projectId });
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
        if (projectMutationSignature) void refreshProject().catch(() => {});
    }, [projectMutationSignature, refreshProject]);
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
        await renameChatInHistory(chatId, trimmed);
    }
    async function uploadFiles(files: File[]) {
        if (files.length === 0) return;
        setUploading(true);
        try {
            await projectFiles.uploadFiles(files);
        } catch (error) {
            console.error("Upload failed:", error);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }
    async function handleDeleteDoc(documentId: string) {
        await projectFiles.deleteDocument(documentId);
        chatViewRef.current?.closeDocument(documentId);
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
    function openProjectPicker() {
        if (chatOwnerId && user?.id && chatOwnerId !== user.id) {
            setOwnerOnlyAction("change this chat's project");
            return;
        }
        setProjectModalOpen(true);
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
                        onClick: openProjectPicker,
                        icon: (
                            <FolderSvgIcon className="h-3.5 w-3.5 shrink-0" />
                        ),
                        label: (
                            <span className="hidden max-w-40 truncate sm:inline">
                                {project?.name ?? "Project"}
                            </span>
                        ),
                        title: "Change project",
                    },
                    {
                        type: "new",
                        onClick: () => void createChat(),
                        loading: creatingChat,
                        title: "New chat",
                    },
                    {
                        onClick: () => void handleRenameChat(),
                        label: "Rename",
                        title: "Rename chat",
                    },
                    {
                        onClick: handleDeleteChat,
                        disabled: deletingChat,
                        label: deletingChat ? "Deleting\u2026" : "Delete",
                        title: "Delete chat",
                    },
                ]}
            />
            <div className="relative flex min-h-0 flex-1 overflow-hidden border-t border-gray-200">
                <div
                    id="project-chat-explorer"
                    className={`absolute inset-y-0 left-0 z-40 w-64 flex-col border-r border-gray-200 bg-white shadow-lg ${mobileExplorerOpen ? "flex" : "hidden"} md:relative md:z-auto md:flex md:shadow-none`}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
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
                                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40"                            >
                                {uploading ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Upload className="h-3.5 w-3.5" />
                                )}
                            </button>
                            <button type="button" onClick={() => setMobileExplorerOpen(false)} title="Close explorer" className="rounded px-1 text-lg leading-none text-gray-400 hover:bg-gray-100 hover:text-gray-700 md:hidden">×</button>
                        </div>
                    </div>
                    <div className="relative h-full flex-1 overflow-y-auto">
                        <ProjectExplorer
                            documents={project?.documents ?? []}
                            folders={project?.folders ?? []}
                            selectedDocId={selectedDocId}
                            onDocClick={(document) => {
                                chatViewRef.current?.openDocument(document);
                                setMobileExplorerOpen(false);
                            }}
                            onCreateFolder={projectFiles.createFolder}
                            onRenameFolder={projectFiles.renameFolder}
                            onDeleteFolder={projectFiles.deleteFolder}
                            onDeleteDoc={handleDeleteDoc}
                            documentRemovalMode={
                                isAnonymousMode ? "detach" : "delete"
                            }
                            onMoveDoc={projectFiles.moveDocument}
                            onMoveFolder={projectFiles.moveFolder}
                        />
                    </div>
                </div>
                <div
                    className="relative min-w-0 flex-1"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={handleChatDrop}
                >
                    <button
                        type="button"
                        aria-controls="project-chat-explorer"
                        aria-expanded={mobileExplorerOpen}
                        onClick={() => setMobileExplorerOpen(true)}
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
                        useDisplayedDocumentContext
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
