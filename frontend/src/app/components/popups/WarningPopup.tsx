import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";

type Action = { label: ReactNode; onClick: () => void; disabled?: boolean };
export function WarningPopup({ open, onClose, title, message, children, icon,
    primaryAction, secondaryAction, className }: {
    open: boolean; onClose: () => void; title?: ReactNode; message?: ReactNode;
    children?: ReactNode; icon?: ReactNode; primaryAction?: Action;
    secondaryAction?: Action; className?: string;
}) {
    return <Modal open={open} onClose={onClose} role="alertdialog" size="sm"
        className={`!h-auto max-h-[calc(100dvh-2rem)] border-red-200 bg-red-50 ${className ?? ""}`}
        breadcrumbs={[<span className="flex items-center gap-2" key="warning">
            {icon ?? <AlertCircle aria-hidden className="size-4 text-red-600" />}
            {title ?? "Warning"}
        </span>]}
        primaryAction={primaryAction} secondaryAction={secondaryAction}>
        <div className="pb-5 text-sm text-gray-700">
            {message && <div>{message}</div>}
            {children}
        </div>
    </Modal>;
}
