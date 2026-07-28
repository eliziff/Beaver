"use client";

import { WarningPopup } from "@/app/components/popups/WarningPopup";

export function ChatDeleteWarning({
    open,
    count = 1,
    permanent = false,
    busy = false,
    onCancel,
    onConfirm,
}: {
    open: boolean;
    count?: number;
    permanent?: boolean;
    busy?: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const plural = count === 1 ? "chat" : `${count} chats`;
    return (
        <WarningPopup
            open={open}
            onClose={onCancel}
            title={
                permanent
                    ? `Permanently delete ${plural}?`
                    : `Move ${plural} to Recycling bin?`
            }
            message={
                permanent
                    ? "This cannot be undone."
                    : `You can restore ${count === 1 ? "it" : "them"} from Assistant for 30 days.`
            }
            secondaryAction={{
                label: "Cancel",
                onClick: onCancel,
                disabled: busy,
            }}
            primaryAction={{
                label: permanent ? "Delete permanently" : "Move",
                onClick: onConfirm,
                disabled: busy,
            }}
        />
    );
}
