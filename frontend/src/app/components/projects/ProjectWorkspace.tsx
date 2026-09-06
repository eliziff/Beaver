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
  deleteProject,
  getProject,
  getProjectPeople,
  updateProject,
  type Project,
} from "@/app/lib/api/projects";
import { listProjectChats, type Chat } from "@/app/lib/api/chat";

import type { ColumnConfig } from "@/app/lib/api/tabular";
import type { Document } from "@/app/lib/api/documents";

import { stageNewChatDocuments } from "../assistant/assistantLaunch";
import type { AssistantWorkflowLaunch } from "../workflows/workflowRoutes";
import { PeopleModal } from "../modals/PeopleModal";
import { NewTRModal } from "../tabular/NewTRModal";
import { createTabularReviewPath } from "../tabular/tabularReviewRoute";
import { Tabs } from "../ui/tabs";
import { useAuth } from "@/app/contexts/AuthContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { OwnerOnlyPopup } from "../popups/OwnerOnlyPopup";
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
  createChat: (documents?: Document[], workflow?: AssistantWorkflowLaunch) => Promise<void>;
  openNewReview: () => void;
  setOwnerOnlyAction: React.Dispatch<React.SetStateAction<string | null>>;
};
type Dialog = "people" | "details" | "review" | "delete" | "deleting" | "deleted" | null;
const Workspace = createContext<Context | null>(null);
const sections = [
  { id: "documents", label: "Documents", path: "" },
  { id: "assistant", label: "Chats", path: "/assistant" },
  { id: "reviews", label: "Reviews", path: "/tabular-reviews" },
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

  const createChat = useCallback(async (
    documents: Document[] = [], workflow?: AssistantWorkflowLaunch,
  ) => {
    setCreatingChat(true);
    try {
      const id = await saveChat(projectId);
      if (!id) return;
      stageNewChatDocuments(documents);
      setProjectChats((current) => current ? [{
        id,
        project_id: projectId,
        user_id: user?.id ?? "",
        creator_display_name: profile?.displayName ?? null,
        title: null,
        created_at: new Date().toISOString(),
      }, ...current] : current);
      navigate(`/projects/${projectId}/assistant/chat/${id}`,
        workflow ? { state: workflow } : undefined);
    } finally {
      setCreatingChat(false);
    }
  }, [navigate, profile?.displayName, projectId, saveChat, user?.id]);

  async function createReview(
    title: string,
    _ignored?: string,
    documentIds: string[] = [],
    columns: ColumnConfig[] | null = [],
    workflowId?: string,
  ) {
    setCreatingReview(true);
    try {
      navigate(await createTabularReviewPath({
        title: title || undefined,
        document_ids: documentIds,
        columns_config: columns ?? [],
        workflow_id: workflowId,
        project_id: projectId,
      }));
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
    setOwnerOnlyAction,
  };
  const ownerOnlyDialog = <OwnerOnlyPopup open={!!ownerOnlyAction}
    title="Owner access required" action={ownerOnlyAction ?? undefined}
    onClose={() => setOwnerOnlyAction(null)} />;
  if (project === null) return <Workspace.Provider value={value}>
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <ProjectPageHeader project={null} search="" isOwner={false}
        onBackToProjects={() => navigate("/projects")}
        onOpenDetails={() => {}} onDeleteProject={() => {}}
        onSearchChange={() => {}} onOpenPeople={() => {}} />
      <p className="grid min-h-0 flex-1 place-items-center px-6 text-sm text-gray-500"
        role="status">This project could not be found.</p>
    </div>
  </Workspace.Provider>;
  if (!showShell) return <Workspace.Provider value={value}>{children}{ownerOnlyDialog}</Workspace.Provider>;
  return (
    <Workspace.Provider value={value}>
      <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <ProjectPageHeader
          project={project}
          search={searches[activeSection]}
          isOwner={project?.is_owner !== false}
          booleanSearch={activeSection !== "assistant"}
          onBackToProjects={() => navigate("/projects")}
          onOpenDetails={() => setDialog("details")}
          onDeleteProject={() => project?.is_owner === false
            ? value.setOwnerOnlyAction("delete this project")
            : setDialog("delete")}
          onSearchChange={(search) => setSearches((current) => ({ ...current, [activeSection]: search }))}
          onOpenPeople={() => setDialog("people")}
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
        <ConfirmPopup
          open={dialog === "delete" || dialog === "deleting" || dialog === "deleted"}
          title="Delete project?"
          message="This will permanently delete the project and its related documents, chats, and tabular reviews."
          confirmLabel={dialog === "deleted" ? "Deleted" : "Delete project"}
          confirmStatus={dialog === "deleting" ? "loading" : dialog === "deleted" ? "complete" : "idle"}
          onCancel={() => { if (dialog !== "deleting") setDialog(null); }}
          onConfirm={() => void removeProject()} />
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

export function ProjectSectionTabs({ actions, children }: {
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { activeSection, projectId } = useProjectWorkspace();
  const navigate = useNavigate();
  const { state } = useLocation();
  const restoreFocus = Boolean((state as { focusProjectSectionTab?: boolean } | null)
    ?.focusProjectSectionTab);
  useEffect(() => {
    if (!restoreFocus) return;
    const frame = requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(
      '[role="tablist"][aria-label="Project sections"] [aria-selected="true"]')
      ?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [activeSection, restoreFocus]);
  return (
    <Tabs
      value={activeSection}
      onValueChange={(next) => navigate(
        `/projects/${projectId}${sections.find(({ id }) => id === next)?.path ?? ""}`,
        { state: { focusProjectSectionTab: true } },
      )}
      options={sections.map(({ id, label }) => ({ value: id, label }))}
      ariaLabel="Project sections"
      variant="dock"
      className="document-directory min-h-0 flex-1"
      railClassName="px-4 md:px-6"
    >
      {actions && <div data-project-section-actions
        className="flex min-h-10 shrink-0 items-center justify-end overflow-x-auto px-4 py-1 md:px-6">
        {actions}
      </div>}
      {children}
    </Tabs>
  );
}
