import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2, Upload } from "lucide-react";
import { ChatView, type ChatViewHandle } from "@/app/components/assistant/ChatView";
import { SelectAssistantProjectModal } from "@/app/components/assistant/SelectAssistantProjectModal";
import { ChatDeleteWarning } from "@/app/components/assistant/ChatDeleteWarning";
import { Modal } from "@/app/components/modals/Modal";
import { ModalTextInput } from "@/app/components/modals/ModalTextInput";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { BeaverIcon } from "@/app/components/chat/beaver-icon";
import { ProjectExplorer } from "@/app/components/projects/ProjectExplorer";
import { DOCUMENT_DRAG_TYPE } from "@/app/components/documents/documentTree";
import { useProjectFiles } from "@/app/components/projects/useProjectFiles";
import { useProjectWorkspace } from "@/app/components/projects/ProjectWorkspace";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { useAuth } from "@/app/contexts/AuthContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useAssistantChatRoute } from "@/app/hooks/useAssistantChatRoute";
import { isLocalMode } from "@/app/lib/authMode";
import { deleteChat } from "@/app/lib/beaverApi";

export default function ProjectAssistantChatPage() {
  const { id = "", chatId = "" } = useParams<{ id: string; chatId: string }>();
  return <ProjectAssistantChat key={chatId} projectId={id} chatId={chatId} />;
}

function ProjectAssistantChat({ projectId, chatId }: { projectId: string; chatId: string }) {
  const navigate = useNavigate();
  const { setSidebarOpen } = useSidebar();
  const { user } = useAuth();
  const { profile } = useUserProfile();
  const workspace = useProjectWorkspace();
  const files = useProjectFiles();
  const history = useChatHistoryContext();
  const route = useAssistantChatRoute({ chatId, projectId });
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [chatActionBusy, setChatActionBusy] = useState(false);
  const [chatActionError, setChatActionError] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const chat = useRef<ChatViewHandle>(null);
  const { messages } = route.state;
  const username = profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";
  const documentRevision = messages.flatMap((message) =>
    message.role === "assistant" ? message.artifacts.map(({ versionId }) => versionId) : [],
  ).join("|");

  useEffect(() => setSidebarOpen(false), [setSidebarOpen]);
  useEffect(() => {
    if (documentRevision) void workspace.refreshProject().catch(() => undefined);
  }, [documentRevision, workspace.refreshProject]);

  function requireOwner(action: string) {
    if (!route.chatOwnerId || !user?.id || route.chatOwnerId === user.id) return true;
    workspace.setOwnerOnlyAction(action);
    return false;
  }

  async function removeChat() {
    setChatActionBusy(true);
    setChatActionError(null);
    try {
      await deleteChat(chatId);
      navigate(`/projects/${projectId}/assistant`);
    } catch {
      setChatActionError("The chat could not be moved to the Recycling bin.");
    } finally {
      setChatActionBusy(false);
    }
  }

  async function submitRename() {
    const title = renameValue.trim();
    if (!title || title === route.chatTitle) return setRenameOpen(false);
    setChatActionBusy(true);
    setChatActionError(null);
    try {
      await history.renameChat(chatId, title);
      setRenameOpen(false);
    } catch {
      setChatActionError("The chat could not be renamed.");
    } finally {
      setChatActionBusy(false);
    }
  }

  async function upload(uploaded: File[]) {
    if (!uploaded.length) return;
    setUploading(true);
    try {
      await files.uploadFiles(uploaded);
    } catch (error) {
      console.error("Upload failed", error);
    } finally {
      setUploading(false);
      if (uploadInput.current) uploadInput.current.value = "";
    }
  }

  const projectPath = `/projects/${projectId}/assistant`;
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        shrink
        breadcrumbs={[
          { label: "Projects", onClick: () => navigate("/projects") },
          workspace.project
            ? { label: workspace.project.name, onClick: () => navigate(projectPath), title: "Back to project" }
            : { loading: true, skeletonClassName: "w-32", onClick: () => navigate(projectPath) },
          route.chatLoaded
            ? { label: route.chatTitle ?? "Untitled New Chat" }
            : { loading: true, skeletonClassName: "w-40" },
        ]}
        actions={[
          {
            onClick: () => requireOwner("change this chat's project") && setProjectDialogOpen(true),
            icon: <FolderSvgIcon className="size-3.5" />,
            label: <span className="hidden max-w-40 truncate sm:inline">{workspace.project?.name ?? "Project"}</span>,
            title: "Change project",
          },
          { type: "new", onClick: () => void workspace.createChat(), loading: workspace.creatingChat, title: "New chat" },
          {
            onClick: () => {
              if (!requireOwner("rename this chat")) return;
              setRenameValue(route.chatTitle ?? "Untitled New Chat");
              setRenameOpen(true);
            },
            label: "Rename",
            title: "Rename chat",
          },
          {
            onClick: () => requireOwner("delete this chat") && setDeleteOpen(true),
            label: "Delete",
            title: "Delete chat",
          },
        ]}
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden border-t">
        <aside
          id="project-chat-explorer"
          className={`absolute inset-y-0 left-0 z-40 w-64 flex-col border-r bg-white shadow-lg ${explorerOpen ? "flex" : "hidden"} md:relative md:z-auto md:flex md:shadow-none`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void upload(Array.from(event.dataTransfer.files));
          }}
        >
          <header className="flex h-10 items-center justify-between border-b px-3 text-xs">
            Explorer
            <span className="flex gap-1">
              <input
                ref={uploadInput}
                type="file"
                accept=".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt"
                multiple
                className="hidden"
                onChange={(event) => void upload(Array.from(event.currentTarget.files ?? []))}
              />
              <button type="button" disabled={uploading} onClick={() => uploadInput.current?.click()} aria-label="Upload documents" className="rounded p-1">
                {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              </button>
              <button type="button" onClick={() => setExplorerOpen(false)} aria-label="Close explorer" className="rounded px-1 text-lg md:hidden">×</button>
            </span>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ProjectExplorer
              documents={workspace.project?.documents ?? []}
              folders={workspace.project?.folders ?? []}
              selectedDocId={selectedDocument}
              onDocClick={(document) => {
                chat.current?.openDocument(document);
                setExplorerOpen(false);
              }}
              onCreateFolder={files.createFolder}
              onRenameFolder={files.renameFolder}
              onDeleteFolder={files.deleteFolder}
              onDeleteDoc={async (id) => {
                await files.deleteDocument(id);
                chat.current?.closeDocument(id);
              }}
              documentRemovalMode={isLocalMode ? "detach" : "delete"}
              onMoveDoc={files.moveDocument}
              onMoveFolder={files.moveFolder}
            />
          </div>
        </aside>
        <main
          className="relative min-w-0 flex-1"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const id = event.dataTransfer.getData(DOCUMENT_DRAG_TYPE);
            const document = workspace.project?.documents?.find((item) => item.id === id);
            if (document) chat.current?.attachDocument(document);
          }}
        >
          <button
            type="button"
            aria-controls="project-chat-explorer"
            aria-expanded={explorerOpen}
            onClick={() => setExplorerOpen(true)}
            className="absolute left-2 top-2 z-20 flex h-8 items-center gap-1 rounded border bg-white px-2 text-xs md:hidden"
          >
            <FolderSvgIcon className="size-3.5" /> Files
          </button>
          <ChatView
            ref={chat}
            chatId={chatId}
            session={route.state}
            handleChat={route.actions.handleChat}
            cancel={route.actions.cancel}
            onRejectedTurnRestored={route.actions.clearRejectedTurn}
            onRetryRejectedTurn={() => void route.actions.retryRejectedTurn()}
            projectId={projectId}
            projectName={workspace.project?.name}
            projectCmNumber={workspace.project?.cm_number}
            useDisplayedDocumentContext
            onActiveDocumentChange={setSelectedDocument}
          />
          {!route.chatLoaded ? (
            <p role="status" className="absolute inset-0 z-40 grid place-items-center bg-white text-sm text-gray-500">Loading conversation…</p>
          ) : !messages.length ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-3 pb-24">
              <BeaverIcon size={28} /><h1 className="font-serif text-3xl font-light">Hi, {username}</h1>
            </div>
          ) : null}
        </main>
      </div>
      <SelectAssistantProjectModal
        open={projectDialogOpen}
        onClose={() => setProjectDialogOpen(false)}
        chatTitle={route.chatTitle}
        currentLocation={workspace.project?.name}
        currentProjectId={projectId}
        onSelectProject={route.changeProject}
      />
      <Modal
        open={renameOpen}
        onClose={() => { if (!chatActionBusy) setRenameOpen(false); }}
        size="sm"
        className="!h-fit"
        breadcrumbs={["Rename chat"]}
        cancelAction={{
          label: "Cancel",
          onClick: () => setRenameOpen(false),
          disabled: chatActionBusy,
        }}
        primaryAction={{
          label: chatActionBusy ? "Saving…" : "Save",
          onClick: () => void submitRename(),
          disabled: chatActionBusy || !renameValue.trim(),
        }}
      >
        <form
          className="pb-5"
          onSubmit={(event) => { event.preventDefault(); void submitRename(); }}
        >
          <label className="mb-2 block text-sm font-medium text-gray-700" htmlFor="project-chat-title">
            Chat name
          </label>
          <ModalTextInput
            id="project-chat-title"
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
          />
        </form>
      </Modal>
      <ChatDeleteWarning
        open={deleteOpen}
        busy={chatActionBusy}
        onCancel={() => { if (!chatActionBusy) setDeleteOpen(false); }}
        onConfirm={() => void removeChat()}
      />
      <WarningPopup
        open={!!chatActionError}
        message={chatActionError}
        onClose={() => setChatActionError(null)}
      />
    </div>
  );
}
