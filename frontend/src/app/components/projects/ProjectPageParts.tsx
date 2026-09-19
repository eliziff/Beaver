import { Users } from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import type { Project } from "@/app/lib/api/projects";
import { MoreActionsMenu } from "@/app/components/shared/MoreActionsMenu";

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
export function ProjectPageHeader({
    project,
    search,
    isOwner,
    onBackToProjects,
    onOpenDetails,
    onDeleteProject,
    onSearchChange,
    onOpenPeople,
    booleanSearch, onOpenMemory, onExport, exporting,
}: {
    project: Project | null | undefined;
    search: string;
    isOwner: boolean;
    onBackToProjects: () => void;
    onOpenDetails: () => void;
    onDeleteProject: () => void;
    onSearchChange: (search: string) => void;
    onOpenPeople: () => void;
    booleanSearch?: boolean; onOpenMemory?: () => void;
    onExport?: () => void; exporting?: boolean;
}) {
    return (
        <PageHeader
            breadcrumbs={[
                {
                    label: "Projects",
                    onClick: onBackToProjects,
                    title: "Back to Projects",
                },
                project === undefined
                    ? {
                          loading: true,
                          skeletonClassName: "w-40",
                      }
                    : project
                    ? { label: project.name }
                    : { label: "Project not found" },
            ]}
            actions={project === null ? undefined : [
                {
                    type: "search",
                    value: search,
                    onChange: onSearchChange,
                    placeholder: "Search…",
                    booleanSearch,
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
                        <MoreActionsMenu
                            items={[
                                ...(onOpenMemory ? [{ label: "Memory", onSelect: onOpenMemory, disabled: !project }] : []),
                                ...(onExport ? [{ label: exporting ? "Exporting manifest..." : "Export manifest", onSelect: onExport, disabled: !project || exporting }] : []),
                                {
                                    label: isOwner
                                        ? "Edit details"
                                        : "View details",
                                    onSelect: onOpenDetails,
                                    disabled: !project,
                                },
                                {
                                    label: "Delete",
                                    onSelect: onDeleteProject,
                                    disabled: !project,
                                },
                            ]}
                        />
                    ),
                },
            ]}
        />
    );
}
