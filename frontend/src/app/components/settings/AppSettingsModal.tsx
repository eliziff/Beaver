import Link from "next/link";
import { Modal } from "@/app/components/modals/Modal";
import { ApiKeySettings } from "./ApiKeySettings";
import { isAnonymousMode } from "@/app/lib/authMode";
export function AppSettingsModal({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={["Settings"]}
            size="md"
            headerAction={
                !isAnonymousMode ? (
                    <Link
                        href="/account"
                        onClick={onClose}
                        className="text-xs font-medium text-gray-600 hover:text-gray-900"
                    >
                        Account
                    </Link>
                ) : undefined
            }
        >
            <div className="pb-5">
                <ApiKeySettings />
            </div>
        </Modal>
    );
}
