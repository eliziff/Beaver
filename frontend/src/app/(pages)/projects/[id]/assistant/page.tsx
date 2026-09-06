import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { deleteChat, renameChat, type Chat } from "@/app/lib/api/chat";
import { ProjectAssistantTable } from "@/app/components/projects/ProjectAssistantTable";
import {
    ProjectSectionTabs,
    useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";

import { useAuth } from "@/app/contexts/AuthContext";
import { Button } from "@/app/components/ui/button";
import { ChatDeleteWarning } from "@/app/components/assistant/ChatDeleteWarning";
import { Loader2, Plus } from "lucide-react";
export default function ProjectAssistantPage() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const {
        createChat,
        creatingChat,
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
    const chats = projectChats ?? [];
    const loading = projectChats === null;
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
            <ProjectSectionTabs
                actions={
                    <Button variant="outline" className="h-8 py-0"
                        onClick={() => void createChat()}
                        disabled={creatingChat}
                    >
                        {creatingChat ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Plus className="h-3.5 w-3.5" />}
                        Create chat
                    </Button>
                }
            >
                <ProjectAssistantTable
                    chats={chats}
                    filteredChats={filteredChats}
                    selectedChatIds={selectedChatIds}
                    renamingChatId={renamingChatId}
                    renameChatValue={renameChatValue}
                    currentUserId={user?.id}
                    loading={loading}
                    onOpenChat={(chatId) =>
                        navigate(
                            `/projects/${projectId}/assistant/chat/${chatId}`,
                        )
                    }
                    onDeleteChat={handleDeleteChatRow}
                    onDeleteSelected={handleDeleteSelectedChats}
                    onOwnerOnlyAction={setOwnerOnlyAction}
                    submitChatRename={submitChatRename}
                    setSelectedChatIds={setSelectedChatIds}
                    setRenamingChatId={setRenamingChatId}
                    setRenameChatValue={setRenameChatValue}
                />
            </ProjectSectionTabs>
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
