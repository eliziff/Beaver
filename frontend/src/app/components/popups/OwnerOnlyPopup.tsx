import { Lock } from "lucide-react";
import { WarningPopup } from "../popups/WarningPopup";
interface Props {
    open: boolean;
    onClose: () => void;
    title?: string;
    action?: string;
    ownerEmail?: string | null;
    message?: string;
}
export function OwnerOnlyPopup({
    open,
    onClose,
    title = "Owner-only action",
    action,
    ownerEmail,
    message,
}: Props) {
    if (!open) return null;
    const body =
        message ??
        (action
            ? `Only the project owner can ${action}.`
            : "Only the project owner can perform this action.");
    return (
        <WarningPopup
            open={open}
            onClose={onClose}
            title={title}
            message={body}
            icon={<Lock className="h-3.5 w-3.5 shrink-0 text-red-600" />}
        >
            {ownerEmail && (
                <p className="mt-1 text-xs text-gray-600">
                    Ask <span className="text-gray-600">{ownerEmail}</span> if
                    you need access.
                </p>
            )}
        </WarningPopup>
    );
}
