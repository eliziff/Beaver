"use client";
import { useEffect, useState } from "react";import { useRouter } from "next/navigation";
import { deleteChat, renameChat } from "@/app/lib/beaverApi";
import { ProjectAssistantTable } from "@/app/components/projects/ProjectAssistantTable";
import {
    ProjectSectionToolbar,
    useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";
import type { Chat } from "@/app/components/shared/types";
import { useAuth } from "@/app/contexts/AuthContext";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { ChatDeleteWarning } from "@/app/components/assistant/ChatDeleteWarning";
export default function ProjectAssistantPage() {
    const router = useRouter();
    const { user } = useAuth();
    const {
        createChat,
        ensureProjectChats,
        projectChats,
        projectId,
        search,
        setProjectChats,
        setOwnerOnlyAction,
    } = useProjectWorkspace();
    const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
    const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
    const [renameChatValue, setRenameChatValue] = useState("");
    const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([]);
    const [deleteBusy, setDeleteBusy] = useState(false);
    const chats = projectChats ?? [];    const loading = projectChats === null;
    useEffect(() => {
        void ensureProjectChats();
    }, [ensureProjectChats]);
    const q = search.toLowerCase();
    const filteredChats = q
        ? chats.filter((c) => (c.title ?? "").toLowerCase().includes(q))
        : chats;
    async function submitChatRename(chatId: string) {
        const trimmed = renameChatValue.trim();
        setRenamingChatId(null);
        if (!trimmed) return;
        await renameChat(chatId, trimmed);
        setProjectChats((prev) =>
            (prev ?? []).map((chat) =>
                chat.id === chatId ? { ...chat, title: trimmed } : chat,
            ),
        );
    }
    function handleDeleteChatRow(chat: Chat) {
        if (user?.id && chat.user_id !== user.id) {
            setOwnerOnlyAction("delete this chat");
            return;
        }
        setPendingDeleteIds([chat.id]);
    }
    function handleDeleteSelectedChats() {
        const ids = [...selectedChatIds];
        const owned = ids.filter((id) => {
            const chat = chats.find((c) => c.id === id);
            return !chat || chat.user_id === user?.id;
        });
        const blocked = ids.length - owned.length;
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected chats - only the chat creator can delete a chat`,
            );
        }
        if (owned.length > 0) setPendingDeleteIds(owned);
    }
    async function confirmDeleteChats() {
        const ids = [...pendingDeleteIds];
        setDeleteBusy(true);
        try {
            await Promise.all(ids.map((id) => deleteChat(id)));
            setProjectChats((prev) =>
                (prev ?? []).filter((chat) => !ids.includes(chat.id)),
            );
            setSelectedChatIds((selected) =>
                selected.filter((id) => !ids.includes(id)),
            );
            setPendingDeleteIds([]);
        } finally {
            setDeleteBusy(false);
        }
    }
    return (
        <>
            <ProjectSectionToolbar
                actions={
                    <TabPillButton
                        onClick={handleDeleteSelectedChats}
                        disabled={selectedChatIds.length === 0}
                        className={`w-28 text-red-700 ${
                            selectedChatIds.length === 0 ? "invisible" : ""
                        }`}
                    >
                        Delete selected
                    </TabPillButton>
                }
            />
            <ProjectAssistantTable
                chats={chats}
                filteredChats={filteredChats}
                selectedChatIds={selectedChatIds}
                renamingChatId={renamingChatId}
                renameChatValue={renameChatValue}
                currentUserId={user?.id}
                loading={loading}
                onCreateChat={() => void createChat()}
                onOpenChat={(chatId) =>
                    router.push(
                        `/projects/${projectId}/assistant/chat/${chatId}`,
                    )
                }
                onDeleteChat={handleDeleteChatRow}
                onOwnerOnlyAction={setOwnerOnlyAction}
                submitChatRename={submitChatRename}
                setSelectedChatIds={setSelectedChatIds}
                setRenamingChatId={setRenamingChatId}
                setRenameChatValue={setRenameChatValue}
            />
            <ChatDeleteWarning
                open={pendingDeleteIds.length > 0}
                count={pendingDeleteIds.length}
                busy={deleteBusy}
                onCancel={() => setPendingDeleteIds([])}
                onConfirm={() => void confirmDeleteChats()}
            />
        </>
    );
}
