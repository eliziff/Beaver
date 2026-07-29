import {
    Loader2,
    Plus,
    Upload,
    Users,
} from "lucide-react";
import {
    PageHeader,
    type PageHeaderAction,
} from "@/app/components/shared/PageHeader";
import type { Project } from "@/app/components/shared/types";import { HeaderActionsMenu } from "@/app/components/shared/HeaderActionsMenu";
export type ProjectWorkspaceSection = "documents" | "assistant" | "reviews";
export const DOC_NAME_COL_W = "min-w-0 flex-1";
export const projectBreadcrumbLabel = (project: Project) =>
    `${project.name}${project.cm_number ? ` (${project.cm_number})` : ""}`;
const TREE_CONTROL_WIDTH_PX = 29;
const TREE_NAME_PADDING_PX = 16;
export function treeNameCellStyle(depth: number) {
    if (depth <= 0) return undefined;
    return {
        paddingLeft: TREE_NAME_PADDING_PX + depth * TREE_CONTROL_WIDTH_PX,
    };
}
export function ProjectPageHeader({    project,
    search,
    activeSection,
    creatingChat,
    creatingReview,
    docsCount,
    isOwner,
    onBackToProjects,
    onOpenDetails,
    onDeleteProject,
    onSearchChange,
    onOpenPeople,
    onNewChat,
    onNewReview,
    onAddDocuments,
}: {
    project: Project | null;
    search: string;
    activeSection: ProjectWorkspaceSection;
    creatingChat: boolean;
    creatingReview: boolean;
    docsCount: number;
    isOwner: boolean;
    onBackToProjects: () => void;
    onOpenDetails: () => void;
    onDeleteProject: () => void;
    onSearchChange: (search: string) => void;
    onOpenPeople: () => void;
    onNewChat: () => void;
    onNewReview: () => void;
    onAddDocuments?: (() => void) | null;
}) {
    const action =
        activeSection === "documents"
            ? {
                  label: <span className="hidden sm:inline">Documents</span>,
                  title: "Add documents",
                  onClick: onAddDocuments ?? undefined,
                  disabled: !onAddDocuments,
                  busy: false,
                  icon: Upload,
              }
            : activeSection === "assistant"
              ? {
                    label: <span className="hidden sm:inline">Chat</span>,
                    title: "Create chat",
                    onClick: onNewChat,
                    disabled: creatingChat,
                    busy: creatingChat,
                    icon: Plus,
                }
              : {
                    label: <span className="hidden sm:inline">Review</span>,
                    title: "Create review",
                    onClick: onNewReview,
                    disabled: docsCount === 0 || creatingReview,
                    busy: creatingReview,
                    icon: Plus,
                };
    const SectionIcon = action.busy ? Loader2 : action.icon;
    const sectionAction: PageHeaderAction = {
        ...action,
        icon: (
            <SectionIcon
                className={`h-4 w-4 ${action.busy ? "animate-spin" : ""}`}
            />
        ),
    };
    return (
        <PageHeader
            breadcrumbs={[
                {
                    label: "Projects",
                    onClick: onBackToProjects,
                    title: "Back to Projects",
                },
                project
                    ? { label: project.name }
                    : {
                          loading: true,
                          skeletonClassName: "w-40",
                      },
            ]}
            actions={[
                    {
                        type: "search",
                        value: search,
                        onChange: onSearchChange,
                        placeholder: "Search…",
                    },
                    {
                        onClick: onOpenPeople,
                        iconOnly: true,
                        title: "People with access",
                        icon: <Users className="h-4 w-4" />,
                    },
                    {
                        type: "custom",
                        render: (
                            <HeaderActionsMenu
                                items={[
                                    {
                                        label: isOwner
                                            ? "Edit details"
                                            : "View details",
                                        onSelect: onOpenDetails,
                                    },
                                    {
                                        label: "Delete",
                                        onSelect: onDeleteProject,
                                    },
                                ]}
                            />
                        ),
                    },
                sectionAction,
            ]}
        />
    );
}
