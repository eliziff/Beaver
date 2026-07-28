"use client";

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
    confirmDisabled?: boolean;
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
    confirmDisabled = false,
    className,
}: ConfirmPopupProps) {
    const confirmBusy = confirmStatus === "loading";
    const resolvedConfirmDisabled = confirmDisabled || confirmStatus !== "idle";
    const normalizedConfirmLabel =
        typeof confirmLabel === "string" ? confirmLabel : "Confirm";
    const isDeleteAction = normalizedConfirmLabel
        .toLowerCase()
        .startsWith("delete");
    const resolvedConfirmLabel =
        confirmStatus === "loading" ? (
            <span className="inline-flex h-full items-center gap-1.5">
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                {progressiveLabel(normalizedConfirmLabel)}
            </span>
        ) : confirmStatus === "complete" ? (
            completedLabel(normalizedConfirmLabel)
        ) : isDeleteAction ? (
            <span className="inline-flex h-full items-center gap-1.5">
                <Trash2 className="h-3 w-3 shrink-0" />
                {confirmLabel}
            </span>
        ) : (
            confirmLabel
        );

    return (
        <Modal
            open={open}
            onClose={confirmBusy ? () => undefined : onCancel}
            role="alertdialog"
            size="sm"
            className={`!h-auto ${className ?? ""}`}
            breadcrumbs={[title ?? "Confirm"]}
            cancelAction={{
                label: cancelLabel,
                onClick: onCancel,
                disabled: confirmBusy,
            }}
            primaryAction={{
                label: resolvedConfirmLabel,
                onClick: onConfirm,
                disabled: resolvedConfirmDisabled,
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

function progressiveLabel(label: string) {
    return transformFirstWord(label, (word) =>
        word.toLowerCase().endsWith("e")
            ? `${word.slice(0, -1)}ing…`
            : `${word}ing…`,
    );
}

function completedLabel(label: string) {
    return transformFirstWord(label, (word) =>
        word.toLowerCase().endsWith("e") ? `${word}d` : `${word}ed`,
    );
}

function transformFirstWord(
    label: string,
    transform: (word: string) => string,
) {
    const [first = label, ...rest] = label.split(" ");
    return [transform(first), ...rest].join(" ");
}
