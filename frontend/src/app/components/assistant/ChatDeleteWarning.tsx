import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
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
        <ConfirmPopup
            open={open}
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
            cancelLabel="Cancel"
            onCancel={onCancel}
            confirmLabel={permanent ? "Delete permanently" : "Move"}
            confirmStatus={busy ? "loading" : "idle"}
            onConfirm={onConfirm}
        />
    );
}
