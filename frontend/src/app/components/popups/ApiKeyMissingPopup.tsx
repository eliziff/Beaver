import { useNavigate } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { providerLabel, type ModelProvider } from "@/app/lib/modelAvailability";
import { WarningPopup } from "../popups/WarningPopup";
interface Props {
    open: boolean;
    onClose: () => void;
    provider: ModelProvider | null;
}
export function ApiKeyMissingPopup({ open, onClose, provider }: Props) {
    const navigate = useNavigate();
    const providerName = provider ? providerLabel(provider) : "this provider";
    return (
        <WarningPopup
            open={open}
            onClose={onClose}
            title="API key required"
            message={`You haven't added a ${providerName} API key yet. Add one in your account settings to use this model.`}
            icon={
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
            }
            primaryAction={{
                label: "Go to account settings",
                onClick: () => { onClose(); navigate("/account/models"); },
            }}
        />
    );
}
