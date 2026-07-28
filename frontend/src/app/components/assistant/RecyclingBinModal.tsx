"use client";

import { useEffect, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ChatDeleteWarning } from "./ChatDeleteWarning";
import {
    listDeletedChats,
    permanentlyDeleteChat,
    restoreChat,
} from "@/app/lib/beaverApi";
import type { Chat } from "@/app/components/shared/types";

const RETENTION_DAYS = 30;

function daysRemaining(chat: Chat) {
    const deleted = Date.parse(chat.deleted_at ?? "");
    if (!Number.isFinite(deleted)) return RETENTION_DAYS;
    const elapsed = Math.max(0, Date.now() - deleted);
    return Math.max(
        0,
        RETENTION_DAYS - Math.floor(elapsed / (24 * 60 * 60 * 1000)),
    );
}

export function RecyclingBinModal({
    open,
    onClose,
    onRestored,
}: {
    open: boolean;
    onClose: () => void;
    onRestored: () => Promise<void>;
}) {
    const [chats, setChats] = useState<Chat[] | null>(null);
    const [error, setError] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [pendingPermanent, setPendingPermanent] = useState<Chat | null>(null);

    useEffect(() => {
        if (!open) return;
        let active = true;
        setChats(null);
        setError(false);
        void listDeletedChats()
            .then((items) => {
                if (active) setChats(items);
            })
            .catch(() => {
                if (active) {
                    setChats([]);
                    setError(true);
                }
            });
        return () => {
            active = false;
        };
    }, [open]);

    async function handleRestore(chatId: string) {
        setBusyId(chatId);
        try {
            await restoreChat(chatId);
            setChats((current) =>
                (current ?? []).filter((chat) => chat.id !== chatId),
            );
            await onRestored();
        } finally {
            setBusyId(null);
        }
    }

    async function handlePermanentDelete() {
        if (!pendingPermanent) return;
        const chatId = pendingPermanent.id;
        setBusyId(chatId);
        try {
            await permanentlyDeleteChat(chatId);
            setChats((current) =>
                (current ?? []).filter((chat) => chat.id !== chatId),
            );
            setPendingPermanent(null);
        } finally {
            setBusyId(null);
        }
    }

    return (
        <>
            <Modal
                open={open}
                onClose={onClose}
                breadcrumbs={["Recycling bin"]}
                size="md"
                className="!h-[min(34rem,calc(100dvh-2rem))]"
            >
                <p className="pb-4 text-sm text-gray-600">
                    Deleted chats remain here for 30 days.
                </p>
                <div className="min-h-0 flex-1 overflow-y-auto border-y border-gray-200">
                    {chats === null ? (
                        <p className="px-1 py-5 text-sm text-gray-500">
                            Loading…
                        </p>
                    ) : error ? (
                        <p className="px-1 py-5 text-sm text-red-700">
                            Could not load deleted chats.
                        </p>
                    ) : chats.length === 0 ? (
                        <p className="px-1 py-5 text-sm text-gray-500">
                            The Recycling bin is empty.
                        </p>
                    ) : (
                        <ul className="divide-y divide-gray-200">
                            {chats.map((chat) => (
                                <li
                                    key={chat.id}
                                    className="flex items-center gap-3 py-3"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium text-gray-900">
                                            {chat.title ?? "Untitled chat"}
                                        </p>
                                        <p className="mt-0.5 text-xs text-gray-500">
                                            {chat.project_id
                                                ? "Project chat"
                                                : "Assistant"}{" "}
                                            · {daysRemaining(chat)} days left
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={busyId === chat.id}
                                        onClick={() =>
                                            void handleRestore(chat.id)
                                        }
                                        className="flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                                    >
                                        <RotateCcw className="h-4 w-4" />
                                        Restore
                                    </button>
                                    <button
                                        type="button"
                                        disabled={busyId === chat.id}
                                        onClick={() =>
                                            setPendingPermanent(chat)
                                        }
                                        aria-label={`Permanently delete ${chat.title ?? "chat"}`}
                                        className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </Modal>
            <ChatDeleteWarning
                open={!!pendingPermanent}
                permanent
                busy={!!busyId}
                onCancel={() => setPendingPermanent(null)}
                onConfirm={() => void handlePermanentDelete()}
            />
        </>
    );
}
