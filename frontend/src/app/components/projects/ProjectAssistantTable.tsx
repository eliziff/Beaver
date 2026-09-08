import { type Dispatch, type SetStateAction } from "react";
import { RowActions } from "@/app/components/shared/RowActions";
import {
    TableBody,
    TableCell,
    TableEmptyState,
    TableHeaderCell,
    TableLoadingState,
    TablePrimaryCell,
    TableRow,
    TableScrollArea,
    TableSelectionHeader,
    TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS,
    useTableSelection,
} from "@/app/components/shared/TablePrimitive";
import { ChatSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import type { Chat } from "@/app/lib/api/chat";
import { formatDate } from "@/app/lib/utils";
export function ProjectAssistantTable({
    chats,
    filteredChats,
    selectedChatIds,
    renamingChatId,
    renameChatValue,
    currentUserId,
    onOpenChat,
    onDeleteChat,
    onDeleteSelected,
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
    onOpenChat: (chatId: string) => void;
    onDeleteChat: (chat: Chat) => Promise<void> | void;
    onDeleteSelected: () => void;
    onOwnerOnlyAction: (action: string) => void;
    submitChatRename: (chatId: string) => Promise<void> | void;
    setSelectedChatIds: Dispatch<SetStateAction<string[]>>;
    setRenamingChatId: Dispatch<SetStateAction<string | null>>;
    setRenameChatValue: Dispatch<SetStateAction<string>>;
    loading?: boolean;
}) {
    const selection = useTableSelection(
        filteredChats, selectedChatIds, setSelectedChatIds);
    return (
        <TableScrollArea
            header={<TableSelectionHeader className="pr-8 md:pr-8"
                widthClassName={TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}
                selection={selection}
                selectionLabel="Select loaded chats"
                loading={loading}
                label={selectedChatIds.length
                    ? <span className="text-sm font-medium text-gray-800">
                        {selectedChatIds.length} selected
                    </span>
                    : "Chats"}>
                {selectedChatIds.length ? (
                    <RowActions toolbar label="Actions" onDelete={onDeleteSelected} />
                ) : (
                <>
                    <TableHeaderCell className="ml-auto hidden w-28 sm:flex md:w-32">
                        Creator
                    </TableHeaderCell>
                    <TableHeaderCell className="hidden w-28 sm:flex md:w-32">
                        Created
                    </TableHeaderCell>
                    <TableHeaderCell className="w-7 sm:w-8" />
                </>
            )}
            </TableSelectionHeader>}
        >
            {loading ? (
                <TableLoadingState />
            ) : chats.length === 0 ? (
                <TableEmptyState>
                    <ChatSkeuoIcon className="mb-4 h-8 w-8" />
                    <p className="text-2xl font-medium font-serif text-gray-900">
                        No chats yet
                    </p>
                    <p className="mt-1 max-w-xs text-xs text-gray-600">
                        Ask questions and get answers grounded in the documents
                        in this project.
                    </p>
                </TableEmptyState>
            ) : (
                <TableBody>
                    {filteredChats.map((chat) => (
                        <TableRow
                            key={chat.id}
                            selected={selection.selected.has(chat.id)}
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
                                selected={selection.selected.has(chat.id)}
                                onSelectionChange={() => selection.toggle(chat.id)}
                                label={renamingChatId === chat.id
                                    ? chat.title ?? "Untitled Chat"
                                    : <button type="button"
                                        onClick={(event) => { event.stopPropagation(); onOpenChat(chat.id); }}
                                        className="w-full truncate rounded-sm text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
                                        {chat.title ?? "Untitled Chat"}
                                    </button>}
                                editing={renamingChatId === chat.id}
                                editValue={renameChatValue}
                                onEditValueChange={setRenameChatValue}
                                onEditCommit={() =>
                                    void submitChatRename(chat.id)
                                }
                                onEditCancel={() => setRenamingChatId(null)}
                            />
                            <TableCell className="ml-auto hidden w-28 sm:block md:w-32">
                                {currentUserId && chat.user_id === currentUserId
                                    ? "Me" : chat.creator_display_name?.trim() || "Shared"}
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
