import { ChatLoadingState } from "@/app/components/assistant/ChatLoadingState";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ChatView, type ChatViewHandle } from "@/app/components/assistant/ChatView";
import { takeNewChatDocuments } from "@/app/components/assistant/assistantLaunch";
import { SelectAssistantProjectModal } from "@/app/components/assistant/SelectAssistantProjectModal";
import { ChatDeleteWarning } from "@/app/components/assistant/ChatDeleteWarning";
import { Modal } from "@/app/components/modals/Modal";
import { ModalTextInput } from "@/app/components/modals/ModalTextInput";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { BeaverIcon } from "@/app/components/chat/beaver-icon";
import { ProjectExplorer } from "@/app/components/projects/ProjectExplorer";
import { UploadAction, type UploadActions } from "@/app/components/documents/UploadAction";
import { DOCUMENT_DRAG_TYPE } from "@/app/components/documents/documentTree";
import { useProjectFiles } from "@/app/components/projects/useProjectFiles";
import { useProjectWorkspace } from "@/app/components/projects/ProjectWorkspace";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { useAuth } from "@/app/contexts/AuthContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useAssistantChatRoute } from "@/app/hooks/useAssistantChatRoute";
import { deleteChat } from "@/app/lib/api/chat";
import type { AssistantWorkflowLaunch } from "@/app/components/workflows/workflowRoutes";

export default function ProjectAssistantChatPage() {
  const { id = "", chatId = "" } = useParams<{ id: string; chatId: string }>();
  return <ProjectAssistantChat key={chatId} projectId={id} chatId={chatId} />;
}

function ProjectAssistantChat({ projectId, chatId }: { projectId: string; chatId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const { user } = useAuth();
  const { profile } = useUserProfile();
  const workspace = useProjectWorkspace();
  const files = useProjectFiles("");
  const history = useChatHistoryContext();
  const route = useAssistantChatRoute({ chatId, projectId });
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [chatActionBusy, setChatActionBusy] = useState(false);
  const [chatActionError, setChatActionError] = useState<string | null>(null);
  const [initialDocuments] = useState(takeNewChatDocuments);
  const [initialWorkflow] = useState(
    () => (location.state as AssistantWorkflowLaunch | null) ?? undefined,
  );
  const uploadInput = useRef<HTMLInputElement>(null);
  const directoryUploadInput = useRef<HTMLInputElement>(null);
  const chat = useRef<ChatViewHandle>(null);
  const { messages } = route.state;
  const { refreshProject } = workspace;
  const refreshProjectFiles = files.operations.refreshCollection;
  const username = profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";
  const documentRevision = messages.flatMap((message) =>
    message.role === "assistant" ? message.artifacts.map(({ versionId }) => versionId) : [],
  ).join("|");

  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);
  useEffect(() => {
    if (!documentRevision) return;
    void Promise.all([
      refreshProject().catch(() => undefined),
      refreshProjectFiles(null).catch(() => undefined),
    ]);
  }, [documentRevision, refreshProject, refreshProjectFiles]);

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

  async function upload(uploaded: File[], directory = false) {
    if (!uploaded.length) return;
    setUploading(true); setChatActionError(null);
    try {
      if (directory) await files.uploadDirectory(uploaded);
      else await files.uploadFiles(uploaded);
    } catch (error) {
      console.error("Upload failed", error);
      setChatActionError("Some files could not be uploaded. Try those files again.");
    } finally {
      setUploading(false);
      if (uploadInput.current) uploadInput.current.value = "";
      if (directoryUploadInput.current) directoryUploadInput.current.value = "";
    }
  }

  const projectPath = `/projects/${projectId}/assistant`;
  const uploadActions: UploadActions = {
    files: () => uploadInput.current?.click(),
    folder: () => directoryUploadInput.current?.click(),
  };
  const projectFiles = (
    <div
      className="flex h-full min-h-0 flex-col bg-white"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void upload(Array.from(event.dataTransfer.files));
      }}
    >
      <input
        ref={uploadInput}
        type="file"
        accept=".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt"
        multiple
        className="hidden"
        onChange={(event) => void upload(Array.from(event.currentTarget.files ?? []))}
      />
      <input
        ref={directoryUploadInput}
        type="file"
        accept=".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt"
        multiple
        className="hidden"
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(event) => void upload(
          Array.from(event.currentTarget.files ?? []), true,
        )}
      />
      <ProjectExplorer
        documents={files.documents}
        folders={files.folders}
        selectedDocId={selectedDocument}
        onDocClick={(document) => chat.current?.openDocument(document)}
        onCreateFolder={files.createFolder}
        onRenameFolder={files.renameFolder}
        onDeleteFolder={files.deleteFolder}
        onDeleteDoc={async (documentId) => {
          await files.deleteDocument(documentId);
          chat.current?.closeDocument(documentId);
        }}
        documentRemovalMode="detach"
        onMoveDoc={files.moveDocument}
        onMoveFolder={files.moveFolder}
      />
    </div>
  );
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
        <main
          className="relative min-w-0 flex-1"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const id = event.dataTransfer.getData(DOCUMENT_DRAG_TYPE);
            const document = files.documents.find((item) => item.id === id);
            if (document) chat.current?.attachDocument(document);
          }}
        >
          <div inert={route.chatLoaded ? undefined : true} className="h-full">
          <ChatView
            ref={chat}
            chatId={chatId}
            researchFileId={route.chatLoad.status === "loaded" ? route.chatLoad.chat?.research_file_id : undefined}
            ready={route.chatLoaded}
            researchSelection={route.chatLoad.status === "loaded" ? route.chatLoad.chat?.research_selection : undefined}
            searchMessageId={search.get("message")}
            session={route.state}
            handleChat={route.actions.handleChat}
            cancel={route.actions.cancel}
            onRejectedTurnRestored={route.actions.clearRejectedTurn}
            onRetryRejectedTurn={() => void route.actions.retryRejectedTurn()}
            projectId={projectId}
            projectName={workspace.project?.name}
            projectCmNumber={workspace.project?.cm_number}
            initialModel={route.chatModel}
            initialDraft={route.chatLoad.status === "loaded" ? route.chatLoad.chat?.draft ?? null : null}
            initialReasoningEffort={route.chatReasoningEffort}
            initialDocuments={initialDocuments}
            initialWorkflow={initialWorkflow}
            useDisplayedDocumentContext
            onActiveDocumentChange={setSelectedDocument}
            projectFiles={projectFiles}
            projectFileActions={<UploadAction actions={uploadActions}
              busy={uploading} compact />}
          />
          </div>
          {!route.chatLoaded ? (
            <ChatLoadingState load={route.chatLoad} onRetry={route.actions.retryLoad} />
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
        fit
        breadcrumbs={["Rename chat"]}
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
