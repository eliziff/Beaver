import { FolderPlus, Loader2, MessageSquarePlus, Upload } from "lucide-react";
import { ActionMenu } from "@/app/components/ui/action-menu";
import { MoreActionsMenu } from "@/app/components/shared/MoreActionsMenu";
import type { Document } from "@/app/components/shared/types";
import { Button } from "@/app/components/ui/button";
import { ContextualWorkflowLauncher } from "@/app/components/workflows/ContextualWorkflowPicker";
import type { WorkflowSelection } from "@/app/components/workflows/workflowRoutes";

export type UploadActions = { files: () => void; folder: () => void };
export type DocumentSelectionActions = {
    documents: Document[];
    onWorkflowDocumentChanged: () => Promise<void>;
    onDownload: () => Promise<void>;
    onMove: () => void;
    onRemove: () => Promise<void>;
    removeLabel: "Delete" | "Remove";
};

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
            triggerClassName="directory-action-button h-8 items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white text-sm font-medium text-gray-800 hover:bg-gray-100 hover:text-gray-950 disabled:opacity-40"
        >
            {busy ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                : <Upload className="size-3.5" aria-hidden="true" />}
            <span className={compact ? "sr-only" : "directory-action-shared"}>Upload</span>
        </ActionMenu>
    );
}

export function DirectoryActions({ actions, onCreateFolder, selection,
    onOpenSelectionInChat, onOpenWorkflows, onAssistantWorkflowSelect,
    openSelectionLabel = "Open in new chat", busy = false, compact = false }: {
    actions: UploadActions | null;
    onCreateFolder: (() => void) | null;
    selection?: DocumentSelectionActions | null;
    onOpenSelectionInChat?: (documents: Document[]) => void;
    onOpenWorkflows?: (documents: Document[]) => void;
    onAssistantWorkflowSelect?: (selection: WorkflowSelection, documents: Document[]) => void;
    openSelectionLabel?: string;
    busy?: boolean;
    compact?: boolean;
}) {
    const documents = selection?.documents ?? [];
    const unavailable = busy || !documents.length;
    const labelClass = compact ? "sr-only" : "directory-action-shared";
    return <div role="group" aria-label="Document actions"
        className="directory-actions flex items-center gap-1.5">
        <UploadAction actions={actions} busy={busy} compact={compact} />
        <Button variant="outline" className="directory-action-button h-8 py-0"
            aria-label="New folder"
            onClick={() => onCreateFolder?.()} disabled={busy || !onCreateFolder}>
            <FolderPlus className="size-3.5" aria-hidden="true" />
            <span className={compact ? "sr-only" : "directory-action-full"}>New folder</span>
            {!compact && <span className="directory-action-short">+ Folder</span>}
        </Button>
        <Button variant="outline" className="directory-action-button h-8 py-0"
            aria-label={openSelectionLabel} disabled={unavailable || !onOpenSelectionInChat}
            onClick={() => onOpenSelectionInChat?.(documents)}>
            <MessageSquarePlus className="size-3.5" aria-hidden="true" />
            <span className={compact ? "sr-only" : "directory-action-full"}>
                {openSelectionLabel}
            </span>
            {!compact && <span className="directory-action-short">+ Chat</span>}
        </Button>
        <ContextualWorkflowLauncher documents={documents}
            onOpen={onOpenWorkflows ? () => onOpenWorkflows(documents) : undefined}
            onAssistantSelect={onAssistantWorkflowSelect
                ? (workflow) => onAssistantWorkflowSelect(workflow, documents)
                : undefined}
            onDocumentChanged={selection?.onWorkflowDocumentChanged}
            className="directory-action-button" labelClassName={labelClass}
            disabled={busy} showDisabled />
        <MoreActionsMenu label="More actions" items={[
            { label: "Download", disabled: unavailable,
                onSelect: () => void selection?.onDownload() },
            { label: "Move…", disabled: unavailable, onSelect: () => selection?.onMove() },
            { label: selection?.removeLabel ?? "Delete", disabled: unavailable,
                onSelect: () => void selection?.onRemove() },
        ]} triggerClassName="h-8 w-8 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 hover:text-gray-950 disabled:opacity-40" />
    </div>;
}
