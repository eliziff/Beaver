import { useId, useLayoutEffect, useRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
export type ModalSize = "sm" | "md" | "lg" | "xl" | "2xl";
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
    onEscape?: () => void;
    children: ReactNode;
    role?: "dialog" | "alertdialog";
    breadcrumbs?: ReactNode[];
    headerAction?: ReactNode;
    headerStart?: ReactNode;
    size?: ModalSize;
    className?: string;
    fit?: boolean;
    footerStatus?: ReactNode;
    primaryAction?: ModalAction;
    secondaryAction?: ModalAction;
    keepMounted?: boolean;
}
const sizeClassName: Record<ModalSize, string> = {
    sm: "max-w-md",
    md: "max-w-lg",
    lg: "max-w-xl",
    xl: "max-w-2xl",
    "2xl": "max-w-4xl",
};
export function Modal({
    open,
    onClose,
    onEscape = onClose,
    children,
    role,
    breadcrumbs,
    headerAction,
    headerStart,
    size = "lg",
    className,
    fit = false,
    footerStatus,
    primaryAction,
    secondaryAction,
    keepMounted = false,
}: ModalProps) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const pointerStartedOnBackdrop = useRef(false);
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
    const hasFooter = footerStatus || primaryAction || secondaryAction;
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
                onEscape();
            }}
            onKeyDown={(event) => {
                if (event.defaultPrevented || event.key !== "Escape") return;
                event.preventDefault();
                onEscape();
            }}
            onPointerDownCapture={(event) => {
                pointerStartedOnBackdrop.current = event.target === event.currentTarget;
            }}
            onClick={(event) => {
                if (pointerStartedOnBackdrop.current && event.target === event.currentTarget) onClose();
                pointerStartedOnBackdrop.current = false;
            }}
            className={cn(
                "m-auto w-[calc(100%-2rem)] flex-col overflow-hidden rounded-lg p-0 backdrop:bg-gray-950/20",
                fit
                    ? "h-fit max-h-[calc(100dvh-2rem)]"
                    : "h-[min(600px,calc(100dvh-2rem))]",
                open && "flex",
                sizeClassName[size],
                "border border-gray-300 bg-white",
                className,
            )}
        >
                {hasHeader && (
                    <div className="flex shrink-0 items-center justify-between gap-3 p-4 pl-5">
                        {headerStart}
                        <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden text-sm leading-5 text-gray-400">
                                {breadcrumbs?.map((segment, index) => (
                                    <span
                                        key={index}
                                        className={cn(
                                            "min-w-0 items-center gap-1.5",
                                            index < breadcrumbCount - 1
                                                ? "hidden sm:flex" : "flex",
                                            index === breadcrumbCount - 1 && "flex-1",
                                        )}
                                    >
                                        {index > 0 && <span className="hidden sm:inline">›</span>}
                                        <span
                                            id={
                                                index === breadcrumbCount - 1
                                                    ? titleId
                                                    : undefined
                                            }
                                            className={cn(
                                                "min-w-0 flex-1 truncate",
                                                index === breadcrumbCount - 1 &&
                                                    "text-lg font-semibold leading-6 text-gray-900",
                                            )}
                                        >
                                            {segment}
                                        </span>
                                    </span>
                                ))}
                            </div>
                            {headerAction}
                        </div>
                        <Button
                            onClick={onClose}
                            variant="outline"
                            size="icon-sm"
                            className="text-gray-600 hover:text-gray-900"
                            aria-label="Close"
                        >
                            <X aria-hidden="true" className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                )}
                <div className="modal-scroll-body flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-1 [scrollbar-gutter:stable]">
                    {children}
                </div>
                {hasFooter && (
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-gray-200 bg-white p-3">
                        {footerStatus}
                        {secondaryAction && (
                            <ModalActionButton
                                action={secondaryAction}
                                fallbackVariant="secondary"
                            />
                        )}
                        {primaryAction && (
                            <ModalActionButton
                                action={primaryAction}
                                fallbackVariant="primary"
                            />
                        )}
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
    fallbackVariant: "primary" | "secondary";
}) {
    const { label, icon, variant = fallbackVariant, ...props } = action;
    const tone =
        variant === "danger"
            ? "danger"
            : variant === "primary"
                ? "default"
                : "outline";
    return (
        <Button variant={tone} {...props}>
            {icon}
            {label}
        </Button>
    );
}
