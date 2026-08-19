import { useId, useLayoutEffect, useRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { X } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { cn } from "@/app/lib/utils";
type ModalSize = "sm" | "md" | "lg" | "xl";
export const MODAL_LABEL_CLASS = "mb-1 block text-sm font-medium text-gray-700";
export const MODAL_INPUT_CLASS =
    "block h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";
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
    role?: "dialog" | "alertdialog";
    breadcrumbs?: ReactNode[];
    headerAction?: ReactNode;
    size?: ModalSize;
    className?: string;
    footerStatus?: ReactNode;
    primaryAction?: ModalAction;
    secondaryAction?: ModalAction;
    cancelAction?: ModalAction | false;
    keepMounted?: boolean;
}
const sizeClassName: Record<ModalSize, string> = {
    sm: "max-w-md",
    md: "max-w-lg",
    lg: "max-w-xl",
    xl: "max-w-2xl",
};
export function Modal({
    open,
    onClose,
    children,
    role,
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
    const dialogRef = useRef<HTMLDialogElement>(null);
    const openerRef = useRef<HTMLElement | null>(null);
    const wasOpenRef = useRef(false);
    if (open && !wasOpenRef.current) {
        openerRef.current =
            typeof document !== "undefined" &&
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
    }
    wasOpenRef.current = open;
    const titleId = useId();
    const breadcrumbCount = breadcrumbs?.length ?? 0;
    const hasHeader = breadcrumbCount > 0;
    const hasFooter =
        footerStatus ||
        primaryAction ||
        secondaryAction ||
        cancelAction;
    useLayoutEffect(() => {
        const dialog = dialogRef.current;
        if (!open || !dialog) return;
        dialog.showModal();
        return () => {
            if (dialog.open) dialog.close();
            window.setTimeout(() => {
                if (dialog.open) return;
                const opener = openerRef.current;
                openerRef.current = null;
                if (opener?.isConnected) opener.focus({ preventScroll: true });
            }, 0);
        };
    }, [open]);
    if (!open && !keepMounted) return null;
    return (
        <dialog
            ref={dialogRef}
            role={role}
            aria-labelledby={hasHeader ? titleId : undefined}
            aria-label={hasHeader ? undefined : "Dialog"}
            data-shortcut-layer
            data-shortcut-open={open ? "true" : "false"}
            data-shortcut-close
            onCancel={(event) => {
                event.preventDefault();
                onClose();
            }}
            onKeyDown={(event) => {
                if (event.defaultPrevented || event.key !== "Escape") return;
                event.preventDefault();
                onClose();
            }}
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
            className={cn(
                "m-auto h-[min(600px,calc(100dvh-2rem))] w-[calc(100%-2rem)] flex-col overflow-hidden rounded-lg p-0 backdrop:bg-gray-950/20",
                open && "flex",
                sizeClassName[size],
                "border border-gray-300 bg-white",
                className,
            )}
        >
                {hasHeader && (
                    <div className="flex shrink-0 items-center justify-between gap-3 p-4 pl-5">
                        <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden text-sm leading-5 text-gray-400">
                                {breadcrumbs?.map((segment, index) => (
                                    <span
                                        key={index}
                                        className={cn(
                                            "min-w-0 items-center gap-1.5",
                                            index > 0 &&
                                                index < breadcrumbCount - 1
                                                ? "hidden sm:flex"
                                                : "flex",
                                            index === 0 && "shrink-0",
                                        )}
                                    >
                                        {index > 0 && <span>›</span>}
                                        <span
                                            id={
                                                index === breadcrumbCount - 1
                                                    ? titleId
                                                    : undefined
                                            }
                                            className={cn(
                                                "truncate",
                                                index === breadcrumbCount - 1 &&
                                                    "font-medium text-gray-900",
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
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                            aria-label="Close"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                )}
                <div className="modal-scroll-body flex min-h-0 flex-1 flex-col overflow-y-auto px-5 [scrollbar-gutter:stable]">
                    {children}
                </div>
                {hasFooter && (
                    <div
                        className={cn(
                            "flex shrink-0 flex-wrap items-center gap-3 border-t border-gray-200 bg-white p-3",
                            secondaryAction
                                ? "justify-between"
                                : "justify-end",
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
                            {cancelAction && (
                                <ModalActionButton
                                    action={cancelAction}
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
        </dialog>
    );
}
function ModalActionButton({
    action,
    fallbackVariant,
}: {
    action: ModalAction;
    fallbackVariant: "primary" | "secondary" | "cancel";
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
                className="px-2 py-1.5 text-sm text-gray-500 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
                {...props}
            >
                {label}
            </button>
        );
    }
    const tone =
        variant === "danger"
            ? "danger"
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
