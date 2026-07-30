import {
    useState,
    useRef,
    useEffect,
    type DragEvent,
    type MouseEvent,
} from "react";
import Link from "next/link";
import { Pencil, Trash2, Check, X, FolderInput } from "lucide-react";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useAuth } from "@/app/contexts/AuthContext";
import { OwnerOnlyPopup } from "@/app/components/popups/OwnerOnlyPopup";
import { ChatDeleteWarning } from "@/app/components/assistant/ChatDeleteWarning";
import type { Chat } from "@/app/components/shared/types";
import { ChatSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { cn } from "@/app/lib/utils";
import {
    APP_SURFACE_ACTIVE_CLASS,
    APP_SURFACE_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";
interface Props {
    chat: Chat;
    isActive: boolean;
    isSelected?: boolean;
    selectedCount?: number;
    isSelectionActionOwner?: boolean;
    href: string;
    onNavigate?: () => void;
    onClearSelection?: () => void;
    onSelect?: (
        modifiers: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "metaKey">,
    ) => void;
    onDragChat?: (event: DragEvent<HTMLDivElement>) => void;
    projectName?: string;
    onMoveToProject?: () => void;
    onDeleteSelection?: () => Promise<void>;
}
export function SidebarChatItem({
    chat,
    isActive,
    isSelected = false,
    selectedCount = 0,
    isSelectionActionOwner = false,
    href,
    onNavigate,
    onClearSelection,
    onSelect,
    onDragChat,
    projectName,
    onMoveToProject,
    onDeleteSelection,
}: Props) {
    const { renameChat, deleteChat } = useChatHistoryContext();
    const { user } = useAuth();
    const [isRenaming, setIsRenaming] = useState(false);
    const [editTitle, setEditTitle] = useState(chat.title ?? "");
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const editInputRef = useRef<HTMLInputElement>(null);
    const isChatOwner = !!user?.id && chat.user_id === user.id;
    useEffect(() => {
        if (isRenaming) editInputRef.current?.focus();
    }, [isRenaming]);
    const handleRenameSave = async () => {
        const trimmed = editTitle.trim();
        if (trimmed) await renameChat(chat.id, trimmed);
        setIsRenaming(false);
    };
    const handleRenameCancel = () => {
        setIsRenaming(false);
        setEditTitle(chat.title ?? "");
    };
    return (
        <div
            data-chat-id={chat.id}
            draggable={!isRenaming && isChatOwner}
            onDragStart={onDragChat}
            data-selected={isSelected || undefined}
            className={cn(
                "group relative flex h-8 w-full items-center rounded-md pr-1 [content-visibility:auto] [contain-intrinsic-size:32px]",
                isSelected
                    ? "bg-red-50 text-red-900 ring-1 ring-inset ring-red-200"
                    : isActive
                    ? APP_SURFACE_ACTIVE_CLASS
                    : APP_SURFACE_HOVER_CLASS,
            )}
        >
            {isRenaming ? (
                <div className="flex items-center w-full px-2 py-1">
                    <input
                        ref={editInputRef}
                        type="text"
                        aria-label="Chat title"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") void handleRenameSave();
                            if (e.key === "Escape") handleRenameCancel();
                        }}
                        className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-1 py-0.5 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-red-500"                    />
                    <button
                        type="button"
                        aria-label="Save rename"
                        onClick={() => void handleRenameSave()}
                        className="ml-1.5 py-2 hover:bg-gray-200 rounded text-green-600"
                    >
                        <Check className="h-3 w-3" />
                    </button>
                    <button
                        type="button"
                        aria-label="Cancel rename"
                        onClick={handleRenameCancel}
                        className="ml-1 py-2 hover:bg-gray-200 rounded text-red-600"
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            ) : (
                <>
                    <ChatSkeuoIcon className="ml-2.5 h-3.5 w-3.5 shrink-0" />
                    <Link
                        href={href}
                        onClick={(event) => {
                            if (
                                isChatOwner &&
                                onSelect &&
                                (event.shiftKey ||
                                    event.ctrlKey ||
                                    event.metaKey)
                            ) {
                                event.preventDefault();
                                onSelect(event);
                                return;
                            }
                            onClearSelection?.();
                            onNavigate?.();
                        }}
                        onKeyDown={(event) => {
                            if (
                                isChatOwner &&
                                onSelect &&
                                event.key === " " &&
                                (event.shiftKey ||
                                    event.ctrlKey ||
                                    event.metaKey)
                            ) {
                                event.preventDefault();
                                onSelect(event);
                            }
                        }}
                        aria-current={isActive ? "page" : undefined}
                        aria-label={`${projectName ? `${projectName}: ` : ""}${chat.title ?? "Untitled chat"}${isSelected ? ", selected" : ""}`}
                        aria-keyshortcuts="Control+Space Meta+Space Shift+Space"
                        className={cn(
                            "min-w-0 flex-1 truncate py-1 pl-2 pr-1 text-left text-xs",
                            isActive
                                ? "text-gray-900"
                                : "text-gray-700",
                        )}
                        title={projectName ? `${projectName}: ${chat.title ?? "Untitled chat"}` : (chat.title ?? "Untitled chat")}
                    >
                        {projectName && (
                            <span className="text-gray-400 font-normal">{projectName}: </span>
                        )}
                        {chat.title ?? "Untitled chat"}
                    </Link>
                    <div
                        className={`flex shrink-0 items-center ${onMoveToProject ? "w-[72px]" : "w-12"} ${
                            selectedCount
                                ? isSelectionActionOwner
                                    ? "opacity-100"
                                    : "pointer-events-none opacity-0"
                                : isActive
                                ? "opacity-100"
                                : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                        }`}
                    >
                        {onMoveToProject && (
                            <button
                                type="button"
                                aria-label={`Move ${chat.title ?? "chat"} to project`}
                                title="Move to project"
                                onClick={() => {
                                    if (!isChatOwner) {
                                        setOwnerOnlyAction("move this chat");
                                        return;
                                    }
                                    onMoveToProject();
                                }}
                                className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                            >
                                <FolderInput className="h-3 w-3" />
                            </button>
                        )}
                        <button
                            type="button"
                            aria-label={`Rename ${chat.title ?? "chat"}`}
                            title="Rename"
                            onClick={() => {
                                if (!isChatOwner) {
                                    setOwnerOnlyAction("rename this chat");
                                    return;
                                }
                                setEditTitle(chat.title ?? "");
                                setIsRenaming(true);
                            }}
                            className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                        >
                            <Pencil className="h-3 w-3" />
                        </button>
                        <button
                            type="button"
                            aria-label={
                                isSelectionActionOwner && selectedCount > 1
                                    ? `Delete ${selectedCount} selected chats`
                                    : `Delete ${chat.title ?? "chat"}`
                            }
                            title={
                                isSelectionActionOwner && selectedCount > 1
                                    ? "Delete selected chats"
                                    : "Delete"
                            }
                            onClick={() => {
                                if (!isChatOwner) {
                                    setOwnerOnlyAction("delete this chat");
                                    return;
                                }
                                setConfirmDeleteOpen(true);
                            }}
                            className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-red-50 hover:text-red-700"
                        >
                            <Trash2 className="h-3 w-3" />
                        </button>
                    </div>
                </>
            )}
            <OwnerOnlyPopup
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
            <ChatDeleteWarning
                open={confirmDeleteOpen}
                count={
                    isSelectionActionOwner && selectedCount
                        ? selectedCount
                        : 1
                }
                busy={isDeleting}
                onCancel={() => setConfirmDeleteOpen(false)}
                onConfirm={() => {
                    setIsDeleting(true);
                    const remove =
                        isSelectionActionOwner && onDeleteSelection
                            ? onDeleteSelection()
                            : deleteChat(chat.id);
                    void remove.finally(() => {
                        setIsDeleting(false);
                        setConfirmDeleteOpen(false);
                    });
                }}
            />
        </div>
    );
}
