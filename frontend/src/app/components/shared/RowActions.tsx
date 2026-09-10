import { MoreActionsMenu, type MoreActionsMenuItem } from "@/app/components/shared/MoreActionsMenu";
import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
interface Props {
    label?: string;
    onDelete?: () => void;
    onDownload?: () => void;
    onMove?: () => void;
    onUploadNewVersion?: () => void;
    onNewSubfolder?: () => void;
    deleteDisabled?: boolean;
    onEditDetails?: () => void;
    onRename?: () => void;
    newSubfolderLabel?: string;
    renameLabel?: string;
    deleteLabel?: string;
    toolbar?: boolean;
    additionalItems?: MoreActionsMenuItem[];
}
export function RowActions({
    label = "More actions",
    onDelete,
    onDownload,
    onMove,
    onUploadNewVersion,
    onNewSubfolder,
    deleteDisabled,
    onEditDetails,
    onRename,
    newSubfolderLabel = "New subfolder",
    renameLabel = "Rename",
    deleteLabel = "Delete",
    toolbar = false,
    additionalItems = [],
}: Props) {
    const items: MoreActionsMenuItem[] = [...additionalItems];
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
    add("Move…", onMove);
    add(deleteLabel, onDelete, deleteDisabled);
    return (
        <MoreActionsMenu
            label={label}
            items={items}
            triggerClassName={toolbar
                ? "h-8 w-8 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-100"
                : `h-6 w-6 items-center justify-center rounded text-gray-700 hover:text-gray-900 ${APP_SURFACE_HOVER_CLASS}`}
        />
    );
}
