import { MoreHorizontal } from "lucide-react";
import { ActionMenu, type ActionMenuItem } from "@/app/components/ui/action-menu";
import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
interface Props {
    label?: string;
    onDelete?: () => void;
    onHide?: () => void;
    onUnhide?: () => void;
    onDownload?: () => void;
    onRemoveFromFolder?: () => void;
    onUploadNewVersion?: () => void;
    onNewSubfolder?: () => void;
    deleting?: boolean;
    deleteDisabled?: boolean;
    onEditDetails?: () => void;
    onRename?: () => void;
    newSubfolderLabel?: string;
    renameLabel?: string;
    deleteLabel?: string;
}
export function RowActions({
    label = "More actions",
    onDelete,
    onHide,
    onUnhide,
    onDownload,
    onRemoveFromFolder,
    onUploadNewVersion,
    onNewSubfolder,
    deleting,
    deleteDisabled,
    onEditDetails,
    onRename,
    newSubfolderLabel = "New subfolder",
    renameLabel = "Rename",
    deleteLabel = "Delete",
}: Props) {
    const items: ActionMenuItem[] = [];
    const add = (
        label: string,
        onSelect?: () => void,
        disabled?: boolean,
    ) => {
        if (onSelect) items.push({ label, onSelect, disabled });
    };
    add(newSubfolderLabel, onNewSubfolder);
    add(renameLabel, onRename);
    add("Edit details", onEditDetails);
    add("Download", onDownload);
    add("Upload new version", onUploadNewVersion);
    add("Remove from subfolder", onRemoveFromFolder);
    add("Activate", onUnhide);
    add("Deactivate", onHide);
    add(deleteLabel, onDelete, deleting || deleteDisabled);
    return (
        <ActionMenu
            label={label}
            items={items}
            triggerClassName={`h-6 w-6 items-center justify-center rounded text-gray-700 hover:text-gray-900 ${APP_SURFACE_HOVER_CLASS}`}
        >
            <MoreHorizontal className="h-4 w-4" />
        </ActionMenu>
    );
}
