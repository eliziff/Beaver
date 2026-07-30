import Link from "next/link";
import { Modal } from "@/app/components/modals/Modal";
import { ApiKeySettings } from "./ApiKeySettings";
import { JurisdictionPreferenceEditor } from "./JurisdictionPreferenceEditor";
import { isAnonymousMode } from "@/app/lib/authMode";
import { AccountSection } from "@/app/(pages)/account/AccountSection";
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
            size="xl"
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
            <div className="space-y-8 pb-5">
                <section>
                    <h2 className="mb-2 font-serif text-2xl font-medium text-gray-900">
                        Jurisdiction preference
                    </h2>
                    <p className="mb-4 text-sm leading-5 text-gray-500">
                        This gives the assistant a standing assumption. A jurisdiction named in your message still takes priority.
                    </p>
                    <AccountSection className="p-4">
                        <JurisdictionPreferenceEditor />
                    </AccountSection>
                </section>
                <ApiKeySettings />
            </div>
        </Modal>
    );
}
