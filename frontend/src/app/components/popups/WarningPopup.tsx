"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, type ReactNode } from "react";
import { AlertCircle, X } from "lucide-react";
import { cn } from "@/app/lib/utils";

interface WarningPopupAction {
    label: ReactNode;
    onClick: () => void;
    disabled?: boolean;
}

interface WarningPopupProps {
    open: boolean;
    onClose: () => void;
    title?: ReactNode;
    message?: ReactNode;
    children?: ReactNode;
    icon?: ReactNode;
    primaryAction?: WarningPopupAction;
    secondaryAction?: WarningPopupAction;
    className?: string;
}

export function WarningPopup({
    open,
    onClose,
    title,
    message,
    children,
    icon,
    primaryAction,
    secondaryAction,
    className,
}: WarningPopupProps) {
    const popupRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const restoreFocus =
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
        popupRef.current
            ?.querySelector<HTMLElement>("button:not(:disabled)")
            ?.focus();
        return () => {
            if (restoreFocus?.isConnected) restoreFocus.focus();
        };
    }, [open]);

    if (!open) return null;

    const warningIcon = icon ?? (
        <AlertCircle className="h-3 w-3 shrink-0 text-red-600" />
    );

    return createPortal(
        <div className="pointer-events-none fixed left-1/2 top-5 z-[220] w-[min(92vw,520px)] -translate-x-1/2 px-4">
            <div
                ref={popupRef}
                role="alertdialog"
                aria-modal="true"
                className={cn(
                    "pointer-events-auto flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-xs shadow-sm",
                    className,
                )}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        onClose();
                    }
                }}
            >
                <div className="min-w-0 flex-1 self-center text-red-600">
                    {title && (
                        <div className="flex items-center gap-1.5 font-medium mb-1">
                            {warningIcon}
                            {title}
                        </div>
                    )}
                    {message && (
                        <div
                            className={cn(!title && "flex items-start gap-1.5")}
                        >
                            {!title && warningIcon}
                            <span className="min-w-0">{message}</span>
                        </div>
                    )}
                    {children}
                    {(primaryAction || secondaryAction) && (
                        <div className="mt-2 flex items-center gap-2">
                            {secondaryAction && (
                                <WarningPopupButton action={secondaryAction} />
                            )}
                            {primaryAction && (
                                <WarningPopupButton
                                    action={primaryAction}
                                    primary
                                />
                            )}
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="shrink-0 text-red-700 hover:text-red-500"
                    aria-label="Dismiss warning"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>,
        document.body,
    );
}

function WarningPopupButton({
    action,
    primary = false,
}: {
    action: WarningPopupAction;
    primary?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={action.onClick}
            disabled={action.disabled}
            className={cn(
                "rounded-lg px-3 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40",
                primary
                    ? "bg-gray-900 text-white hover:bg-gray-700"
                    : "text-gray-700 hover:bg-white/70",
            )}
        >
            {action.label}
        </button>
    );
}
