"use client";
import { type Dispatch, type SetStateAction } from "react";
import { Plus } from "lucide-react";
import { RowActions } from "@/app/components/shared/RowActions";
import {
    SkeletonLine,
    TableBody,
    TableCell,
    TableEmptyState,
    TableHeaderCell,
    TableHeaderRow,
    TablePrimaryCell,
    TableRow,
    TableScrollArea,
    TableSelectionPlaceholder,
    TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS,
    TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { CheckboxControl } from "@/app/components/ui/checkbox";
import { PillButton } from "@/app/components/ui/pill-button";
import { ChatSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import type { Chat } from "@/app/components/shared/types";
import { formatDate } from "@/app/lib/utils";function creatorLabel(chat: Chat, currentUserId?: string | null) {
    if (currentUserId && chat.user_id === currentUserId) return "Me";
    return chat.creator_display_name?.trim() || "Shared";
}
export function ProjectAssistantTable({
    chats,
    filteredChats,
    selectedChatIds,
    renamingChatId,
    renameChatValue,
    currentUserId,
    onCreateChat,
    onOpenChat,
    onDeleteChat,
    onOwnerOnlyAction,
    submitChatRename,
    setSelectedChatIds,
    setRenamingChatId,
    setRenameChatValue,
    loading = false,
}: {
    chats: Chat[];
    filteredChats: Chat[];
    selectedChatIds: string[];
    renamingChatId: string | null;
    renameChatValue: string;
    currentUserId?: string | null;
    onCreateChat: () => void;
    onOpenChat: (chatId: string) => void;
    onDeleteChat: (chat: Chat) => Promise<void> | void;
    onOwnerOnlyAction: (action: string) => void;
    submitChatRename: (chatId: string) => Promise<void> | void;
    setSelectedChatIds: Dispatch<SetStateAction<string[]>>;
    setRenamingChatId: Dispatch<SetStateAction<string | null>>;
    setRenameChatValue: Dispatch<SetStateAction<string>>;
    loading?: boolean;
}) {
    const visibleChats = filteredChats;
    const allVisibleChatsSelected =
        visibleChats.length > 0 &&
        visibleChats.every((chat) => selectedChatIds.includes(chat.id));
    const someVisibleChatsSelected =
        !allVisibleChatsSelected &&
        visibleChats.some((chat) => selectedChatIds.includes(chat.id));
    return (
        <TableScrollArea
            header={
                <TableHeaderRow className="pr-8 md:pr-8">
                    <TableStickyCell
                        header
                        widthClassName={TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}
                    >
                        {loading ? (
                            <TableSelectionPlaceholder />
                        ) : (
                            <CheckboxControl
                                checked={allVisibleChatsSelected}
                                ref={(el) => {
                                    if (el)
                                        el.indeterminate =
                                            someVisibleChatsSelected;
                                }}
                                onChange={() => {
                                    if (allVisibleChatsSelected)
                                        setSelectedChatIds([]);
                                    else
                                        setSelectedChatIds(
                                            visibleChats.map((c) => c.id),
                                        );
                                }}
                                className="-ml-2 mr-1"
                            />
                        )}
                        <span className="mr-1">Chats</span>
                    </TableStickyCell>
                    <TableHeaderCell className="ml-auto hidden w-28 sm:flex md:w-32">
                        <div className="flex items-center gap-1">
                            <span>Creator</span>
                        </div>
                    </TableHeaderCell>
                    <TableHeaderCell className="hidden w-28 sm:flex md:w-32">
                        <div className="flex items-center gap-1">
                            <span>Created</span>
                        </div>
                    </TableHeaderCell>
                    <TableHeaderCell className="w-7 sm:w-8" />
                </TableHeaderRow>
            }
        >
            {loading ? (
                <ProjectAssistantLoadingRows />
            ) : chats.length === 0 ? (
                <TableEmptyState>
                    <ChatSkeuoIcon className="mb-4 h-8 w-8" />
                    <p className="text-2xl font-medium font-serif text-gray-900">
                        Assistant
                    </p>
                    <p className="mt-1 text-xs text-gray-400 max-w-xs">
                        Ask questions and get answers grounded in the documents
                        in this project.
                    </p>
                    <PillButton
                        tone="black"
                        size="sm"
                        onClick={onCreateChat}
                        className="mt-4 px-3"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Create
                    </PillButton>
                </TableEmptyState>
            ) : (
                <TableBody>
                    {visibleChats.map((chat) => (
                        <TableRow
                            key={chat.id}
                            selected={selectedChatIds.includes(chat.id)}
                            onClick={() => {
                                if (renamingChatId === chat.id) return;
                                onOpenChat(chat.id);
                            }}
                            className="pr-8 md:pr-8"
                        >
                            <TablePrimaryCell
                                widthClassName={
                                    TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS
                                }
                                selected={selectedChatIds.includes(chat.id)}
                                onSelectionChange={() =>
                                    setSelectedChatIds((prev) =>
                                        prev.includes(chat.id)
                                            ? prev.filter((x) => x !== chat.id)
                                            : [...prev, chat.id],
                                    )
                                }
                                label={chat.title ?? "Untitled Chat"}
                                editing={renamingChatId === chat.id}
                                editValue={renameChatValue}
                                onEditValueChange={setRenameChatValue}
                                onEditCommit={() =>
                                    void submitChatRename(chat.id)
                                }
                                onEditCancel={() => setRenamingChatId(null)}
                            />
                            <TableCell className="ml-auto hidden w-28 sm:block md:w-32">
                                {creatorLabel(chat, currentUserId)}
                            </TableCell>
                            <TableCell className="hidden w-28 sm:block md:w-32">
                                {formatDate(chat.created_at)}
                            </TableCell>
                            <div
                                className="flex w-7 shrink-0 justify-end sm:w-8"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <RowActions
                                    onRename={() => {
                                        if (
                                            currentUserId &&
                                            chat.user_id !== currentUserId
                                        ) {
                                            onOwnerOnlyAction("rename this chat");
                                            return;
                                        }
                                        setRenameChatValue(
                                            chat.title ?? "Untitled Chat",
                                        );
                                        setRenamingChatId(chat.id);
                                    }}
                                    onDelete={() => onDeleteChat(chat)}
                                />
                            </div>
                        </TableRow>
                    ))}
                </TableBody>
            )}
        </TableScrollArea>
    );
}
function ProjectAssistantLoadingRows() {
    const titleWidths = ["w-36", "w-40", "w-44", "w-48", "w-52"];
    return (
        <TableBody>
            {[1, 2, 3, 4, 5].map((i) => (
                <TableRow
                    key={i}
                    interactive={false}
                    className="pr-8 md:pr-8"
                >
                    <TableStickyCell
                        hover={false}
                        widthClassName={TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}
                    >
                        <div className="flex min-w-0 items-center">
                            <TableSelectionPlaceholder />
                            <SkeletonLine
                                className={`h-3.5 ${titleWidths[i - 1]}`}
                            />
                        </div>
                    </TableStickyCell>
                    <TableCell className="ml-auto hidden w-28 sm:block md:w-32">
                        <SkeletonLine className="w-16" />
                    </TableCell>
                    <TableCell className="hidden w-28 sm:block md:w-32">
                        <SkeletonLine className="w-16" />
                    </TableCell>
                    <TableCell className="w-7 sm:w-8" />
                </TableRow>
            ))}
        </TableBody>
    );
}
