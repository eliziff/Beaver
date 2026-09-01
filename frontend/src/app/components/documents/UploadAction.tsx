import { Loader2, Upload } from "lucide-react";
import { ActionMenu } from "@/app/components/ui/action-menu";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { Button } from "@/app/components/ui/button";

export type UploadActions = { files: () => void; folder: () => void };

export function UploadAction({ actions, busy = false, compact = false }: {
    actions: UploadActions | null;
    busy?: boolean;
    compact?: boolean;
}) {
    const disabled = busy || !actions;
    return (
        <ActionMenu
            label="Upload"
            items={[
                { label: "Files", onSelect: () => actions?.files(), disabled },
                { label: "Folder", onSelect: () => actions?.folder(), disabled },
            ]}
            triggerClassName="h-8 items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-800 hover:bg-gray-100 hover:text-gray-950 disabled:opacity-40"
        >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Upload className="h-3.5 w-3.5" />}
            <span className={compact ? "sr-only" : "hidden sm:inline"}>Upload</span>
        </ActionMenu>
    );
}

export function DirectoryActions({ actions, onCreateFolder, busy = false, compact = false }: {
    actions: UploadActions | null;
    onCreateFolder: (() => void) | null;
    busy?: boolean;
    compact?: boolean;
}) {
    return <div className="flex items-center gap-1.5">
        <UploadAction actions={actions} busy={busy} compact={compact} />
        <Button variant="white" size="normal" className="h-8 py-0" aria-label="New folder"
            onClick={() => onCreateFolder?.()} disabled={busy || !onCreateFolder}>
            <FolderSvgIcon className="h-3.5 w-3.5" />
            <span className={compact ? "sr-only" : "hidden sm:inline"}>New folder</span>
        </Button>
    </div>;
}
