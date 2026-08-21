import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  createTabularReview,
  deleteProject,
  getProject,
  getProjectPeople,
  listProjectChats,
  updateProject,
} from "@/app/lib/beaverApi";
import type { Chat, ColumnConfig, Project } from "../shared/types";
import { PeopleModal } from "../modals/PeopleModal";
import { NewTRModal } from "../tabular/NewTRModal";
import { TableToolbar } from "../shared/TableToolbar";
import { useAuth } from "@/app/contexts/AuthContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { Modal } from "../modals/Modal";
import { ProjectDetailsModal } from "./ProjectDetailsModal";
import { projectBreadcrumbLabel, ProjectPageHeader, type ProjectWorkspaceSection } from "./ProjectPageParts";

type Context = {
  projectId: string;
  project: Project | null | undefined;
  setProject: React.Dispatch<React.SetStateAction<Project | null | undefined>>;
  refreshProject: () => Promise<void>;
  activeSection: ProjectWorkspaceSection;
  search: string;
  projectChats: Chat[] | null;
  setProjectChats: React.Dispatch<React.SetStateAction<Chat[] | null>>;
  ensureProjectChats: () => Promise<Chat[]>;
  creatingChat: boolean;
  creatingReview: boolean;
  createChat: () => Promise<void>;
  openNewReview: () => void;
  setAddDocumentsHeaderAction: (action: (() => void) | null) => void;
  setOwnerOnlyAction: React.Dispatch<React.SetStateAction<string | null>>;
};
type Dialog = "people" | "details" | "review" | "delete" | "deleting" | "deleted" | null;
const Workspace = createContext<Context | null>(null);
const sections = [
  { id: "documents", label: "Documents", path: "" },
  { id: "assistant", label: "Chats", path: "/assistant" },
  { id: "reviews", label: "Tabular Reviews", path: "/tabular-reviews" },
] as const;

export function useProjectWorkspace() {
  const value = useContext(Workspace);
  if (!value) throw new Error("useProjectWorkspace must be used inside ProjectWorkspaceProvider");
  return value;
}

export function ProjectWorkspaceProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user } = useAuth();
  const { profile } = useUserProfile();
  const { saveChat } = useChatHistoryContext();
  const [project, setProject] = useState<Project | null>();
  const [projectChats, setProjectChats] = useState<Chat[] | null>(null);
  const [searches, setSearches] = useState<Record<ProjectWorkspaceSection, string>>({
    documents: "", assistant: "", reviews: "",
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [creatingReview, setCreatingReview] = useState(false);
  const [addDocuments, setAddDocuments] = useState<(() => void) | null>(null);
  const chatRequest = useRef<Promise<Chat[]> | null>(null);
  const tail = pathname.split("/").filter(Boolean).slice(2);
  const activeSection: ProjectWorkspaceSection = tail[0] === "assistant"
    ? "assistant"
    : tail[0] === "tabular-reviews" ? "reviews" : "documents";
  const showShell = !tail.length || tail.length === 1;

  const refreshProject = useCallback(async () => {
    setProject(await getProject(projectId));
  }, [projectId]);
  useEffect(() => {
    let current = true;
    void getProject(projectId)
      .then((loaded) => { if (current) setProject(loaded); })
      .catch(() => { if (current) setProject(null); });
    return () => { current = false; };
  }, [projectId]);

  const ensureProjectChats = useCallback(async () => {
    if (projectChats) return projectChats;
    chatRequest.current ??= listProjectChats(projectId)
      .then((rows) => { setProjectChats(rows); return rows; })
      .catch(() => { setProjectChats([]); return []; })
      .finally(() => { chatRequest.current = null; });
    return chatRequest.current;
  }, [projectChats, projectId]);

  const createChat = useCallback(async () => {
    setCreatingChat(true);
    try {
      const id = await saveChat(projectId);
      if (!id) return;
      setProjectChats((current) => current ? [{
        id,
        project_id: projectId,
        user_id: user?.id ?? "",
        creator_display_name: profile?.displayName ?? null,
        title: null,
        created_at: new Date().toISOString(),
      }, ...current] : current);
      navigate(`/projects/${projectId}/assistant/chat/${id}`);
    } finally {
      setCreatingChat(false);
    }
  }, [navigate, profile?.displayName, projectId, saveChat, user?.id]);

  const setAddDocumentsHeaderAction = useCallback((action: (() => void) | null) => {
    setAddDocuments(() => action);
  }, []);

  async function createReview(
    title: string,
    _ignored?: string,
    documentIds: string[] = [],
    columns: ColumnConfig[] | null = [],
  ) {
    setCreatingReview(true);
    try {
      const review = await createTabularReview({
        title: title || undefined,
        document_ids: documentIds,
        columns_config: columns ?? [],
        project_id: projectId,
      });
      navigate(`/projects/${projectId}/tabular-reviews/${review.id}`);
    } finally {
      setCreatingReview(false);
    }
  }

  async function removeProject() {
    if (dialog === "deleting") return;
    setDialog("deleting");
    try {
      await deleteProject(projectId);
      setDialog("deleted");
      window.setTimeout(() => navigate("/projects"), 500);
    } catch {
      setDialog("delete");
    }
  }

  const value: Context = {
    projectId,
    project,
    setProject,
    refreshProject,
    activeSection,
    search: searches[activeSection],
    projectChats,
    setProjectChats,
    ensureProjectChats,
    creatingChat,
    creatingReview,
    createChat,
    openNewReview: () => setDialog("review"),
    setAddDocumentsHeaderAction,
    setOwnerOnlyAction,
  };
  const ownerOnlyDialog = (
    <Modal
      open={!!ownerOnlyAction}
      onClose={() => setOwnerOnlyAction(null)}
      role="alertdialog"
      size="sm"
      className="h-auto min-h-48"
      breadcrumbs={["Owner access required"]}
      cancelAction={{ label: "Dismiss", onClick: () => setOwnerOnlyAction(null) }}
    >
      <p className="pb-3 text-sm text-gray-700">
        Only the project owner can {ownerOnlyAction}.
      </p>
    </Modal>
  );
  if (!showShell) return <Workspace.Provider value={value}>{children}{ownerOnlyDialog}</Workspace.Provider>;
  return (
    <Workspace.Provider value={value}>
      <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <ProjectPageHeader
          project={project ?? null}
          search={searches[activeSection]}
          activeSection={activeSection}
          creatingChat={creatingChat}
          creatingReview={creatingReview}
          isOwner={project?.is_owner !== false}
          onBackToProjects={() => navigate("/projects")}
          onOpenDetails={() => setDialog("details")}
          onDeleteProject={() => project?.is_owner === false
            ? value.setOwnerOnlyAction("delete this project")
            : setDialog("delete")}
          onSearchChange={(search) => setSearches((current) => ({ ...current, [activeSection]: search }))}
          onOpenPeople={() => setDialog("people")}
          onNewChat={() => void createChat()}
          onNewReview={() => setDialog("review")}
          onAddDocuments={addDocuments ?? undefined}
        />
        {children}
        {ownerOnlyDialog}
        <NewTRModal
          open={dialog === "review"}
          onClose={() => setDialog(null)}
          onAdd={createReview}
          projectId={projectId}
          projectName={project?.name}
          projectCmNumber={project?.cm_number}
        />
        <ProjectDetailsModal
          open={dialog === "details"}
          project={project ?? null}
          canEdit={project?.is_owner !== false}
          onClose={() => setDialog(null)}
          onShareProject={() => setDialog("people")}
          onSave={async ({ name, cmNumber, practice }) => setProject(await updateProject(projectId, {
            name, cm_number: cmNumber, practice: practice || null,
          }))}
        />
        <Modal
          open={dialog === "delete" || dialog === "deleting" || dialog === "deleted"}
          onClose={() => { if (dialog !== "deleting") setDialog(null); }}
          role="alertdialog"
          size="sm"
          className="h-auto min-h-48"
          breadcrumbs={["Delete project?"]}
          cancelAction={dialog === "deleted" ? false : {
            label: "Cancel",
            onClick: () => setDialog(null),
            disabled: dialog === "deleting",
          }}
          primaryAction={{
            label: dialog === "deleted" ? "Deleted" : dialog === "deleting" ? "Deleting…" : "Delete",
            onClick: () => void removeProject(),
            disabled: dialog === "deleting" || dialog === "deleted",
            variant: "danger",
          }}
        >
          <p className="pb-3 text-sm text-gray-700">
            This will permanently delete the project and its related documents, chats, and tabular reviews.
          </p>
        </Modal>
        {project && (
          <PeopleModal
            open={dialog === "people"}
            onClose={() => setDialog(null)}
            resource={project}
            fetchPeople={getProjectPeople}
            currentUserEmail={user?.email ?? null}
            breadcrumb={["Projects", projectBreadcrumbLabel(project), "People"]}
            onSharedWithChange={project.is_owner === false ? undefined : async (shared_with) =>
              setProject(await updateProject(projectId, { shared_with }))}
          />
        )}
      </div>
    </Workspace.Provider>
  );
}

export function ProjectSectionToolbar({ actions }: { actions?: ReactNode }) {
  const { activeSection, projectId } = useProjectWorkspace();
  const navigate = useNavigate();
  return (
    <TableToolbar
      items={sections}
      active={activeSection}
      onChange={(next) => navigate(`/projects/${projectId}${sections.find(({ id }) => id === next)?.path ?? ""}`)}
      actions={actions}
    />
  );
}
