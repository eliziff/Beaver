import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, FileText, Loader2, RefreshCw, X } from "lucide-react";
import type { ColumnConfig, TabularCell, TabularDocument } from "@/app/lib/api/tabular";
import { TabularResultDetails } from "./TabularResultDetails";
import { Button } from "../ui/button";
import { cn } from "@/app/lib/utils";
import { LIQUID_PANEL_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
interface Props {
    cell: TabularCell;
    document: TabularDocument;
    column: ColumnConfig;
    onClose: () => void;
    onRegenerate?: () => Promise<void>;
    onDiscuss?: () => void;
    running?: boolean;
}
const COMPACT_PANEL = "(max-width: 767px)";
const ICON_BUTTON = "h-7 w-7 text-gray-500 hover:text-gray-800";
export function TRSidePanel({
    cell,
    document: doc,
    column,
    onClose,
    onRegenerate, onDiscuss,
    running = false,
}: Props) {
    const [regenerating, setRegenerating] = useState(false);
    const [error, setError] = useState("");
    const panelRef = useRef<HTMLDialogElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    const openerRef = useRef(
        document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
    );
    useLayoutEffect(() => {
        const panel = panelRef.current, media = window.matchMedia?.(COMPACT_PANEL);
        const opener = openerRef.current;
        if (!panel) return;
        const update = () => {
            if (panel.open) panel.close();
            if (media?.matches) {
                panel.setAttribute("aria-modal", "true");
                panel.showModal();
                closeRef.current?.focus();
            } else {
                panel.removeAttribute("aria-modal");
                panel.setAttribute("open", "");
            }
        };
        update();
        media?.addEventListener?.("change", update);
        return () => {
            media?.removeEventListener?.("change", update);
            if (panel.open) panel.close();
            if (opener?.isConnected) opener.focus();
        };
    }, []);
    useEffect(() => {
        // Closing on click, not pointerdown, lets the click also reach the control
        // it landed on: dismissing on pointerdown replaced that control mid-gesture
        // and swallowed the activation.
        const handleOutsideClick = ({ target }: MouseEvent) => {
            if (window.matchMedia?.(COMPACT_PANEL).matches) return;
            if (target instanceof Node && !panelRef.current?.contains(target)) onClose();
        };
        const frame = requestAnimationFrame(() =>
            document.addEventListener("click", handleOutsideClick));
        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener("click", handleOutsideClick);
        };
    }, [onClose]);
    const SourceIcon = doc.reference && doc.reference.kind !== "document" ? BookOpen : FileText;
    return (
        // Sits below the page header so the review's own toolbar stays clickable while a result is open.
        <dialog
            ref={panelRef}
            aria-label={`${column.name} result`}
            onCancel={(event) => {
                event.preventDefault();
                onClose();
            }}
            className={cn(
                "fixed h-[calc(100dvh-5.25rem)] max-h-[calc(100dvh-5.25rem)] min-h-0 bottom-3 left-auto right-3 top-[4.5rem] z-100 m-0 flex w-[360px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden p-0 text-inherit backdrop:bg-gray-950/20",
                LIQUID_PANEL_SURFACE_CLASS,
                "max-md:inset-0 max-md:h-dvh max-md:max-h-none max-md:w-screen max-md:max-w-none max-md:rounded-none max-md:border-0",
            )}
        >
            <div className="mb-2 flex min-h-11 shrink-0 items-center gap-1 border-b border-white/30 px-3">
                <Button ref={closeRef} variant="ghost" size="icon-sm" className={cn(ICON_BUTTON, "ml-auto")} onClick={onClose} aria-label="Close">
                    <X className="h-4 w-4" />
                </Button>
            </div>
            <div role="region" aria-label="Result details" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className="px-5 pb-3">
                    <div className="mb-1 flex items-center gap-1.5 text-xs text-gray-600">
                        <SourceIcon aria-hidden className="h-3.5 w-3.5 text-gray-500" />
                        <span className="truncate" title={doc.filename}>{doc.filename}</span>
                    </div>
                    <h2 className="text-sm font-semibold leading-5 text-gray-900 [overflow-wrap:anywhere]">{column.name}</h2>
                    <div className="mt-3">
                        {cell.content && <TabularResultDetails answer={cell.content} column={column} />}
                        {!cell.content && <p role="status" className="text-sm text-gray-500">{cell.status === "error" ? "This result failed. Regenerate to try again."
                            : cell.status === "generating" ? "Running…" : "This question has not run yet."}</p>}
                    </div>
                </div>
            </div>
            {(onRegenerate || onDiscuss) && <div className="flex shrink-0 items-center justify-between gap-2 border-t border-gray-200 px-3 py-2">
                {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
                {onDiscuss && <Button variant="ghost" size="compact" onClick={onDiscuss}>Chat</Button>}
                {onRegenerate && <Button variant="outline" size="compact" disabled={regenerating || running} aria-label="Regenerate" title="Regenerate"
                    onClick={async () => { setRegenerating(true); setError("");
                        try { await onRegenerate(); } catch { setError("Could not regenerate. Try again."); }
                        finally { setRegenerating(false); } }}>
                    {regenerating ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}Regenerate
                </Button>}
            </div>}
        </dialog>
    );
}
