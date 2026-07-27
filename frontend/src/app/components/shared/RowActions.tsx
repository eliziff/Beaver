"use client";

import { MoreHorizontal } from "lucide-react";
import {
    NativeActionSelect,
    type NativeAction,
} from "@/app/components/ui/native-action-select";
import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";

interface Props {
    onDelete?: () => void;
    onHide?: () => void;
    onUnhide?: () => void;
    onDownload?: () => void;
    onRemoveFromFolder?: () => void;
    onShowAllVersions?: () => void;
    onUploadNewVersion?: () => void;
    onNewSubfolder?: () => void;
    deleting?: boolean;
    deleteDisabled?: boolean;
    onEditDetails?: () => void;
    onRename?: () => void;
    onUpdateCmNumber?: () => void;
    newSubfolderLabel?: string;
    renameLabel?: string;
    deleteLabel?: string;
}

export function RowActions({
    onDelete,
    onHide,
    onUnhide,
    onDownload,
    onRemoveFromFolder,
    onShowAllVersions,
    onUploadNewVersion,
    onNewSubfolder,
    deleting,
    deleteDisabled,
    onEditDetails,
    onRename,
    onUpdateCmNumber,
    newSubfolderLabel = "New subfolder",
    renameLabel = "Rename",
    deleteLabel = "Delete",
}: Props) {
    const items: NativeAction[] = [];
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
    add("Edit CM No.", onUpdateCmNumber);
    add("Download", onDownload);
    add("Show all versions", onShowAllVersions);
    add("Upload new version", onUploadNewVersion);
    add("Remove from subfolder", onRemoveFromFolder);
    add("Activate", onUnhide);
    add("Deactivate", onHide);
    add(deleteLabel, onDelete, deleting || deleteDisabled);

    return (
        <NativeActionSelect
            label="More actions"
            items={items}
            triggerClassName={`h-6 w-6 items-center justify-center rounded text-gray-700 hover:text-gray-900 ${APP_SURFACE_HOVER_CLASS}`}
        >
            <MoreHorizontal className="h-4 w-4" />
        </NativeActionSelect>
    );
}
