"use client";

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { X } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { cn } from "@/app/lib/utils";

type ModalSize = "sm" | "md" | "lg" | "xl";
type ModalAction = Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "className"
> & {
    label: ReactNode;
    icon?: ReactNode;
    variant?: "primary" | "secondary" | "danger";
};

interface ModalProps {
    open: boolean;
    onClose: () => void;
    children: ReactNode;
    breadcrumbs?: ReactNode[];
    headerAction?: ReactNode;
    size?: ModalSize;
    className?: string;
    footerStatus?: ReactNode;
    primaryAction?: ModalAction;
    secondaryAction?: ModalAction;
    cancelAction?: ModalAction | false;
    /**
     * Keep the modal (and its children's state) mounted while closed,
     * rendering it hidden instead of unmounting. Lets content like loaded
     * directory listings survive close/reopen cycles.
     */
    keepMounted?: boolean;
}

const sizeClassName: Record<ModalSize, string> = {
    sm: "max-w-md",
    md: "max-w-xl",
    lg: "max-w-2xl",
    xl: "max-w-4xl",
};

export function Modal({
    open,
    onClose,
    children,
    breadcrumbs,
    headerAction,
    size = "lg",
    className,
    footerStatus,
    primaryAction,
    secondaryAction,
    cancelAction,
    keepMounted = false,
}: ModalProps) {
    // Portals can't render during SSR, so a keep-mounted modal only renders
    // (hidden) after the first client mount.
    const [hasMounted, setHasMounted] = useState(false);
    const titleId = useId();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR portal gate: must flip after first client mount
    useEffect(() => setHasMounted(true), []);
    const hasHeader = breadcrumbs?.length;
    const hasFooter =
        footerStatus ||
        primaryAction ||
        secondaryAction ||
        cancelAction;
    const resolvedCancelAction = cancelAction;

    if (!open && (!keepMounted || !hasMounted)) return null;

    return createPortal(
        <div
            className={cn(
                "fixed inset-0 z-[200] flex items-center justify-center px-4",
                "bg-gray-950/20",
                !open && "hidden",
            )}
            onClick={onClose}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={hasHeader ? titleId : undefined}
                aria-label={hasHeader ? undefined : "Dialog"}
                className={cn(
                    "flex h-[min(600px,calc(100dvh-2rem))] w-full flex-col rounded-3xl",
                    sizeClassName[size],
                    "border border-gray-200 bg-gray-50 shadow-xl",
                    className,
                )}
                onClick={(e) => e.stopPropagation()}
            >
                {hasHeader && (
                    <div className="flex items-center justify-between gap-3 p-4 pl-5">
                        <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-none text-gray-400">
                                {breadcrumbs?.map((segment, index) => (
                                    <span
                                        key={index}
                                        className="flex items-center gap-1.5"
                                    >
                                        {index > 0 && <span>›</span>}
                                        <span
                                            id={
                                                index ===
                                                (breadcrumbs?.length ?? 0) - 1
                                                    ? titleId
                                                    : undefined
                                            }
                                            className={cn(
                                                "truncate",
                                                index ===
                                                    (breadcrumbs?.length ?? 0) -
                                                        1 && "text-gray-700",
                                            )}
                                        >
                                            {segment}
                                        </span>
                                    </span>
                                ))}
                            </div>
                            {headerAction}
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-700"
                            aria-label="Close"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                )}
                <div className="modal-scroll-body flex min-h-0 flex-1 flex-col px-5">
                    {children}
                </div>
                {hasFooter && (
                    <div
                        className={cn(
                            "flex flex-wrap items-center gap-3 p-3",
                            secondaryAction
                                ? "justify-between"
                                : "justify-end",
                            "border-t border-gray-200",
                        )}
                    >
                        {secondaryAction && (
                            <div className="flex min-w-0 items-center gap-2">
                                <ModalActionButton
                                    action={secondaryAction}
                                    fallbackVariant="secondary"
                                />
                            </div>
                        )}
                        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                            {footerStatus}
                            {resolvedCancelAction && (
                                <ModalActionButton
                                    action={resolvedCancelAction}
                                    fallbackVariant="cancel"
                                />
                            )}
                            {primaryAction && (
                                <ModalActionButton
                                    action={primaryAction}
                                    fallbackVariant="primary"
                                />
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>,
        document.body,
    );
}

function ModalActionButton({
    action,
    fallbackVariant,
}: {
    action: ModalAction;
    fallbackVariant: "primary" | "secondary" | "danger" | "cancel";
}) {
    const {
        label,
        icon,
        variant = fallbackVariant === "cancel" ? "secondary" : fallbackVariant,
        ...props
    } = action;

    if (fallbackVariant === "cancel") {
        return (
            <button
                type="button"
                className="px-2 py-1.5 text-sm text-gray-500 transition-colors hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
                {...props}
            >
                {label}
            </button>
        );
    }

    const tone =
        variant === "danger"
            ? "danger"
            : fallbackVariant === "secondary" && variant === "secondary"
              ? "blue"
              : variant === "primary"
                ? "black"
                : "white";

    return (
        <PillButton tone={tone} size="normal" {...props}>
            {icon}
            {label}
        </PillButton>
    );
}
