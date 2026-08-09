import type { ReactNode } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
type ConfirmStatus = "idle" | "loading" | "complete";
interface ConfirmPopupProps {
    open: boolean;
    title?: ReactNode;
    message?: ReactNode;
    confirmLabel?: ReactNode;
    confirmStatus?: ConfirmStatus;
    cancelLabel?: ReactNode;
    onConfirm: () => void;
    onCancel: () => void;
    className?: string;
}
export function ConfirmPopup({
    open,
    title,
    message,
    confirmLabel = "Confirm",
    confirmStatus = "idle",
    cancelLabel = "Cancel",
    onConfirm,
    onCancel,
    className,
}: ConfirmPopupProps) {
    const confirmBusy = confirmStatus === "loading";
    const normalizedConfirmLabel =
        typeof confirmLabel === "string" ? confirmLabel : "Confirm";
    const isDeleteAction = normalizedConfirmLabel
        .toLowerCase()
        .startsWith("delete");
    const resolvedConfirmLabel = (
        <span className="inline-flex h-full items-center gap-1.5">
            {confirmBusy ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            ) : isDeleteAction ? (
                <Trash2 className="h-3 w-3 shrink-0" />
            ) : (
                <span className="h-3 w-3 shrink-0" aria-hidden="true" />
            )}
            {confirmLabel}
        </span>
    );
    return (
        <Modal
            open={open}
            onClose={confirmBusy ? () => undefined : onCancel}
            role="alertdialog"
            size="sm"
            className={`!h-fit max-h-[calc(100dvh-2rem)] ${className ?? ""}`}
            breadcrumbs={[title ?? "Confirm"]}
            cancelAction={{
                label: cancelLabel,
                onClick: onCancel,
                disabled: confirmBusy,
            }}
            primaryAction={{
                label: resolvedConfirmLabel,
                onClick: onConfirm,
                disabled: confirmStatus !== "idle",
                variant: isDeleteAction ? "danger" : "primary",
                "aria-busy": confirmBusy,
            }}
        >
            {message ? (
                <div className="pb-5 text-sm text-gray-700">{message}</div>
            ) : null}
        </Modal>
    );
}
