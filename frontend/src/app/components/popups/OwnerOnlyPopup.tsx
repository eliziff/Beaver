import { Lock } from "lucide-react";
import { WarningPopup } from "../popups/WarningPopup";
interface Props {
    open: boolean;
    onClose: () => void;
    title?: string;
    action?: string;
}
export function OwnerOnlyPopup({
    open,
    onClose,
    title = "Owner-only action",
    action,
}: Props) {
    return (
        <WarningPopup
            open={open}
            onClose={onClose}
            title={title}
            message={action
                ? `Only the project owner can ${action}.`
                : "Only the project owner can perform this action."}
            icon={<Lock className="h-3.5 w-3.5 shrink-0 text-red-600" />}
        />
    );
}
