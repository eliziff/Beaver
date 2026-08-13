"use client";

import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useRouter, useSelectedLayoutSegments } from "next/navigation";
import {
    createTabularReview,
    deleteProject,
    getProject,
    getProjectPeople,
    listProjectChats,
    updateProject,
} from "@/app/lib/beaverApi";
import type {
    Chat,
    ColumnConfig,
    Project,
} from "@/app/components/shared/types";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { NewTRModal } from "@/app/components/tabular/NewTRModal";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { OwnerOnlyPopup } from "@/app/components/popups/OwnerOnlyPopup";
import { PeopleModal } from "@/app/components/modals/PeopleModal";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { isAnonymousMode } from "@/app/lib/authMode";
import { ProjectDetailsModal } from "./ProjectDetailsModal";
import {
    projectBreadcrumbLabel,
    ProjectPageHeader,
    type ProjectWorkspaceSection,
} from "./ProjectPageParts";
type ProjectWorkspaceValue = {
    projectId: string;
    project: Project | null | undefined;
    setProject: React.Dispatch<
        React.SetStateAction<Project | null | undefined>
    >;
    refreshProject: () => Promise<void>;
    activeSection: ProjectWorkspaceSection;
    search: string;
    projectChats: Chat[] | null;
    setProjectChats: React.Dispatch<React.SetStateAction<Chat[] | null>>;
    ensureProjectChats: () => Promise<Chat[]>;
    prefetchProjectSections: () => void;
    creatingChat: boolean;
    creatingReview: boolean;
    createChat: () => Promise<void>;
    openNewReview: () => void;
    setAddDocumentsHeaderAction: (action: (() => void) | null) => void;
    setOwnerOnlyAction: React.Dispatch<React.SetStateAction<string | null>>;
};
type ProjectDialog =
    | "people"
    | "details"
    | "review"
    | "delete"
    | "deleting"
    | "deleted"
    | null;
const PROJECT_SECTIONS = [
    { id: "documents", label: "Documents" },
    { id: "assistant", label: "Chats" },
    { id: "reviews", label: "Tabular Reviews" },
] satisfies { id: ProjectWorkspaceSection; label: string }[];
const PROJECT_SECTION_PATH: Record<ProjectWorkspaceSection, string> = {
    documents: "",
    assistant: "/assistant",
    reviews: "/tabular-reviews",
};
const ProjectWorkspaceContext =
    createContext<ProjectWorkspaceValue | null>(null);
export function useProjectWorkspace() {
    const value = useContext(ProjectWorkspaceContext);
    if (!value) {
        throw new Error(
            "useProjectWorkspace must be used inside ProjectWorkspaceProvider",
        );
    }
    return value;
}
function useLazyProjectList<T>(
    projectId: string,
    load: (projectId: string) => Promise<T[]>,
    errorLabel: string,
) {
    const [items, setItems] = useState<T[] | null>(null);
    const pending = useRef<Promise<T[]> | null>(null);
    const ensure = useCallback(() => {
        if (items) return Promise.resolve(items);
        if (pending.current) return pending.current;
        pending.current = load(projectId)
            .then((loaded) => {
                setItems(loaded);
                return loaded;
            })
            .catch((error) => {
                console.error(errorLabel, error);
                setItems([]);
                return [];
            })
            .finally(() => {
                pending.current = null;
            });
        return pending.current;
    }, [errorLabel, items, load, projectId]);
    return [items, setItems, ensure] as const;
}
export function ProjectWorkspaceProvider({
    projectId,
    children,
}: {
    projectId: string;
    children: ReactNode;
}) {
    const [project, setProject] = useState<Project | null>();
    const [searchBySection, setSearchBySection] = useState<
        Record<ProjectWorkspaceSection, string>
    >({ documents: "", assistant: "", reviews: "" });
    const [projectChats, setProjectChats, ensureProjectChats] =
        useLazyProjectList<Chat>(
            projectId,
            listProjectChats,
            "[project assistant] failed to load",
        );
    const [dialog, setDialog] = useState<ProjectDialog>(null);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const [creatingChat, setCreatingChat] = useState(false);
    const [creatingReview, setCreatingReview] = useState(false);
    const [addDocumentsHeaderAction, setAddDocumentsHeaderActionState] =
        useState<{ action: (() => void) | null }>({ action: null });
    const segments = useSelectedLayoutSegments();
    const activeSection: ProjectWorkspaceSection =
        segments[0] === "assistant"
            ? "assistant"
            : segments[0] === "tabular-reviews"
              ? "reviews"
              : "documents";
    const showShell =
        segments.length === 0 ||
        (segments.length === 1 && activeSection !== "documents");
    const router = useRouter();
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const { saveChat } = useChatHistoryContext();
    const setAddDocumentsHeaderAction = useCallback(
        (action: (() => void) | null) => {
            setAddDocumentsHeaderActionState({ action });
        },
        [],
    );
    useEffect(() => {
        let cancelled = false;
        getProject(projectId)
            .then((loaded) => {
                if (cancelled) return;
                setProject(loaded);
            })
            .catch((error) => {
                console.error("[project workspace] failed to load project", error);
                if (!cancelled) setProject(null);
            });
        return () => {
            cancelled = true;
        };
    }, [projectId]);
    const refreshProject = useCallback(async () => {
        const loaded = await getProject(projectId);
        setProject(loaded);
    }, [projectId]);
    const search = searchBySection[activeSection];
    const setSearch = useCallback(
        (value: string) =>
            setSearchBySection((prev) => ({
                ...prev,
                [activeSection]: value,
            })),
        [activeSection],
    );
    const prefetchProjectSections = useCallback(() => {
        void ensureProjectChats();
    }, [ensureProjectChats]);
    const createChat = useCallback(async () => {
        setCreatingChat(true);
        try {
            const id = await saveChat(projectId);
            if (id) {
                const now = new Date().toISOString();
                setProjectChats((prev) =>
                    prev
                        ? [
                              {
                                  id,
                                  project_id: projectId,
                                  user_id: user?.id ?? "",
                                  creator_display_name:
                                      profile?.displayName ?? null,
                                  title: null,
                                  created_at: now,
                              },
                              ...prev,
                          ]
                        : prev,
                );
                router.push(`/projects/${projectId}/assistant/chat/${id}`);
            }
        } finally {
            setCreatingChat(false);
        }
    }, [profile?.displayName, projectId, router, saveChat, user?.id]);
    const openNewReview = useCallback(() => {
        setDialog("review");
    }, []);
    async function handleCreateReview(
        title: string,
        _projectId?: string,
        documentIds?: string[],
        columnsConfig?: ColumnConfig[] | null,
    ) {
        setCreatingReview(true);
        try {
            const review = await createTabularReview({
                title: title || undefined,
                document_ids: documentIds ?? [],
                columns_config: columnsConfig ?? [],
                project_id: projectId,
            });
            router.push(`/projects/${projectId}/tabular-reviews/${review.id}`);
        } finally {
            setCreatingReview(false);
        }
    }
    async function handleProjectDetailsSave(values: {
        name: string;
        cmNumber: string;
        practice: string;
    }) {
        const updated = await updateProject(projectId, {
            name: values.name,
            cm_number: values.cmNumber,
            practice: values.practice || null,
        });
        setProject(updated);
    }
    function requestProjectDelete() {
        if (project?.is_owner === false) {
            setOwnerOnlyAction("delete this project");
            return;
        }
        setDialog("delete");
    }
    async function confirmProjectDelete() {
        if (dialog === "deleting") return;
        setDialog("deleting");
        try {
            await deleteProject(projectId);
            setDialog("deleted");
            window.setTimeout(() => router.push("/projects"), 500);
        } catch (error) {
            console.error("deleteProject failed", error);
            setDialog("delete");
        }
    }
    const value = useMemo<ProjectWorkspaceValue>(
        () => ({
            projectId,
            project,
            setProject,
            refreshProject,
            activeSection,
            search,
            projectChats,
            setProjectChats,
            ensureProjectChats,
            prefetchProjectSections,
            creatingChat,
            creatingReview,
            createChat,
            openNewReview,
            setAddDocumentsHeaderAction,
            setOwnerOnlyAction,
        }),
        [
            projectId,
            project,
            refreshProject,
            activeSection,
            search,
            projectChats,
            ensureProjectChats,
            prefetchProjectSections,
            creatingChat,
            creatingReview,
            createChat,
            openNewReview,
            setAddDocumentsHeaderAction,
        ],
    );
    const ownerOnlyPopup = (
        <OwnerOnlyPopup
            open={!!ownerOnlyAction}
            action={ownerOnlyAction ?? undefined}
            onClose={() => setOwnerOnlyAction(null)}
        />
    );
    if (!showShell) {
        return (
            <ProjectWorkspaceContext.Provider value={value}>
                {children}
                {ownerOnlyPopup}
            </ProjectWorkspaceContext.Provider>
        );
    }
    return (
        <ProjectWorkspaceContext.Provider value={value}>
            <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                <ProjectPageHeader
                    project={project ?? null}
                    search={search}
                    activeSection={activeSection}
                    creatingChat={creatingChat}
                    creatingReview={creatingReview}
                    isOwner={project?.is_owner !== false}
                    onBackToProjects={() => router.push("/projects")}
                    onOpenDetails={() => setDialog("details")}
                    onDeleteProject={requestProjectDelete}
                    onSearchChange={setSearch}
                    onOpenPeople={() => setDialog("people")}
                    onNewChat={() => void createChat()}
                    onNewReview={openNewReview}
                    onAddDocuments={addDocumentsHeaderAction.action}
                />
                {children}
                <NewTRModal
                    open={dialog === "review"}
                    onClose={() => setDialog(null)}
                    onAdd={handleCreateReview}
                    projectId={projectId}
                    projectName={project?.name}
                    projectCmNumber={project?.cm_number}
                />
                {ownerOnlyPopup}
                <ProjectDetailsModal
                    open={dialog === "details"}
                    project={project ?? null}
                    canEdit={project?.is_owner !== false}
                    onClose={() => setDialog(null)}
                    onSave={handleProjectDetailsSave}
                    onShareProject={() => setDialog("people")}
                />
                <ConfirmPopup
                    open={
                        dialog === "delete" ||
                        dialog === "deleting" ||
                        dialog === "deleted"
                    }
                    title="Delete project?"
                    message={
                        isAnonymousMode
                            ? "This will delete the project and its chats. Library files and their links in other projects will be kept."
                            : "This will permanently delete the project and its related documents, chats, and tabular reviews."
                    }
                    confirmLabel="Delete"
                    confirmStatus={
                        dialog === "deleting"
                            ? "loading"
                            : dialog === "deleted"
                              ? "complete"
                              : "idle"
                    }
                    cancelLabel="Cancel"
                    onCancel={() => {
                        if (dialog !== "deleting") setDialog(null);
                    }}
                    onConfirm={() => void confirmProjectDelete()}
                />
                {project && (
                    <PeopleModal
                        open={dialog === "people"}
                        onClose={() => setDialog(null)}
                        resource={project}
                        fetchPeople={getProjectPeople}
                        currentUserEmail={user?.email ?? null}
                        breadcrumb={[
                            "Projects",
                            projectBreadcrumbLabel(project),
                            "People",
                        ]}
                        onSharedWithChange={
                            project.is_owner === false
                                ? undefined
                                : async (next) => {
                                      const updated = await updateProject(
                                          projectId,
                                          { shared_with: next },
                                      );
                                      setProject(updated);
                                  }
                        }
                    />
                )}
            </div>
        </ProjectWorkspaceContext.Provider>
    );
}
export function ProjectSectionToolbar({
    actions,
}: {
    actions?: ReactNode;
}) {
    const { activeSection, projectId } = useProjectWorkspace();
    const router = useRouter();
    return (
        <TableToolbar
            items={PROJECT_SECTIONS}
            active={activeSection}
            onChange={(next) =>
                router.push(`/projects/${projectId}${PROJECT_SECTION_PATH[next]}`)
            }
            actions={actions}
        />
    );
}
