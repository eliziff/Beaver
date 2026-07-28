"use client";

import { type CSSProperties } from "react";
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
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import type { Project } from "@/app/components/shared/types";
import { HeaderActionsMenu } from "@/app/components/shared/HeaderActionsMenu";
import { TABLE_PRIMARY_CELL_WIDTH_CLASS } from "@/app/components/shared/TablePrimitive";

export type ProjectWorkspaceSection = "documents" | "assistant" | "reviews";

export const NAME_COL_W = TABLE_PRIMARY_CELL_WIDTH_CLASS;
export const DOC_NAME_COL_W = "min-w-0 flex-1";

const TREE_CONTROL_WIDTH_PX = 29;
const TREE_NAME_PADDING_PX = 16;

export function treeNameCellStyle(depth: number): CSSProperties | undefined {
    if (depth <= 0) return undefined;
    return {
        paddingLeft: TREE_NAME_PADDING_PX + depth * TREE_CONTROL_WIDTH_PX,
    };
}

export function DocIcon({
    fileType,
    muted = false,
}: {
    fileType: string | null;
    muted?: boolean;
}) {
    return <FileTypeIcon fileType={fileType} className="h-4 w-4" muted={muted} />;
}

export function ProjectPageHeader({
    project,
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
    const sectionAction: PageHeaderAction =
        activeSection === "documents"
            ? {
                  onClick: onAddDocuments ?? undefined,
                  disabled: !onAddDocuments,
                  icon: <Upload className="h-4 w-4" />,
                  label: <span className="hidden sm:inline">Documents</span>,
                  title: "Add documents",
              }
            : activeSection === "assistant"
              ? {
                    onClick: onNewChat,
                    disabled: creatingChat,
                    icon: creatingChat ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Plus className="h-4 w-4" />
                    ),
                    label: <span className="hidden sm:inline">Chat</span>,
                    title: "Create chat",
                }
              : {
                    onClick: onNewReview,
                    disabled: docsCount === 0 || creatingReview,
                    icon: creatingReview ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Plus className="h-4 w-4" />
                    ),
                    label: <span className="hidden sm:inline">Review</span>,
                    title: "Create review",
                };

    return (
        <PageHeader
            breadcrumbs={[
                {
                    label: "Projects",
                    onClick: onBackToProjects,
                    title: "Back to Projects",
                },
                {
                    ...(project
                        ? {
                              label: project.name,
                          }
                        : {
                              loading: true,
                              skeletonClassName: "w-40",
                          }),
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
