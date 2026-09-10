import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";

export function WarningPopup({ open, onClose, title, message, icon, primaryAction }: {
    open: boolean; onClose: () => void; title?: ReactNode; message?: ReactNode;
    icon?: ReactNode; primaryAction?: { label: ReactNode; onClick: () => void };
}) {
    return <Modal open={open} onClose={onClose} role="alertdialog" size="sm"
        className="!h-auto max-h-[calc(100dvh-2rem)] border-red-200 bg-red-50"
        breadcrumbs={[<span className="flex items-center gap-2" key="warning">
            {icon ?? <AlertCircle aria-hidden className="size-4 text-red-600" />}
            {title ?? "Warning"}
        </span>]}
        primaryAction={primaryAction}>
        <div className="pb-5 text-sm text-gray-700">
            {message && <div>{message}</div>}
        </div>
    </Modal>;
}
