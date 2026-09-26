import { useEffect, useEffectEvent, useRef, useState,
    type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { GripHorizontal, X } from "lucide-react";
import { LegalSourceViewer, type LegalSourceTab } from "./LegalSourceViewer";

type Box = { left: number; top: number; width: number; height: number };
const EDGE = 16;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 240;
const DEFAULT_WIDTH = 720;

const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), Math.max(min, max));

/** A source opened from a dock workspace floats beside it in its own resizable window. */
export function LegalSourcePopout({ tab, onClose }: { tab: LegalSourceTab; onClose: () => void }) {
    const [box, setBox] = useState<Box>(() => {
        const dock = document.querySelector<HTMLElement>("[data-assistant-dock]");
        const beside = dock?.getBoundingClientRect();
        const viewportWidth = window.innerWidth, viewportHeight = window.innerHeight;
        const width = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, (beside?.left ?? viewportWidth) - EDGE * 2));
        const height = Math.max(MIN_HEIGHT, Math.min(beside?.height ?? viewportHeight - EDGE * 2, viewportHeight - EDGE * 2));
        const left = beside ? beside.left - EDGE - width : (viewportWidth - width) / 2;
        const top = beside ? beside.top : (viewportHeight - height) / 2;
        return {
            width, height,
            left: clamp(left, EDGE, viewportWidth - width - EDGE),
            top: clamp(top, EDGE, viewportHeight - height - EDGE),
        };
    });
    const gesture = useRef<{ mode: "move" | "resize"; x: number; y: number; box: Box } | null>(null);
    const dismiss = useEffectEvent(() => onClose());

    useEffect(() => {
        const move = (event: PointerEvent) => {
            const active = gesture.current;
            if (!active) return;
            const dx = event.clientX - active.x, dy = event.clientY - active.y;
            const width = window.innerWidth, height = window.innerHeight;
            setBox(active.mode === "move" ? { ...active.box,
                left: clamp(active.box.left + dx, EDGE, width - active.box.width - EDGE),
                top: clamp(active.box.top + dy, EDGE, height - active.box.height - EDGE),
            } : { ...active.box,
                width: clamp(active.box.width + dx, MIN_WIDTH, width - active.box.left - EDGE),
                height: clamp(active.box.height + dy, MIN_HEIGHT, height - active.box.top - EDGE),
            });
        };
        const end = () => { gesture.current = null; document.body.style.userSelect = ""; };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
        return () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
        };
    }, []);

    useEffect(() => {
        const fit = () => setBox((current) => ({ ...current,
            left: clamp(current.left, EDGE, window.innerWidth - current.width - EDGE),
            top: clamp(current.top, EDGE, window.innerHeight - current.height - EDGE),
        }));
        window.addEventListener("resize", fit);
        return () => window.removeEventListener("resize", fit);
    }, []);

    useEffect(() => {
        const escape = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || document.fullscreenElement || event.defaultPrevented) return;
            const nested = event.target instanceof Element
                ? event.target.closest('dialog, [role="dialog"], [role="alertdialog"]') : null;
            if (nested) return;
            event.preventDefault();
            dismiss();
        };
        window.addEventListener("keydown", escape);
        return () => window.removeEventListener("keydown", escape);
    }, []);

    function begin(mode: "move" | "resize", event: ReactPointerEvent) {
        if (event.button !== 0) return;
        gesture.current = { mode, x: event.clientX, y: event.clientY, box };
        document.body.style.userSelect = "none";
    }

    function resizeByKey(event: ReactKeyboardEvent) {
        if (!event.key.startsWith("Arrow")) return;
        const step = 24, width = window.innerWidth, height = window.innerHeight;
        event.preventDefault();
        if (event.key === "ArrowLeft") setBox({ ...box, width: clamp(box.width - step, MIN_WIDTH, width - box.left - EDGE) });
        if (event.key === "ArrowRight") setBox({ ...box, width: clamp(box.width + step, MIN_WIDTH, width - box.left - EDGE) });
        if (event.key === "ArrowUp") setBox({ ...box, height: clamp(box.height - step, MIN_HEIGHT, height - box.top - EDGE) });
        if (event.key === "ArrowDown") setBox({ ...box, height: clamp(box.height + step, MIN_HEIGHT, height - box.top - EDGE) });
    }

    return createPortal(
        <section aria-label="Source reader" data-floating-reader
            className="fixed z-[220] flex flex-col overflow-hidden rounded-lg border border-gray-300 bg-app-surface shadow-xl"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
            <div data-reader-titlebar onPointerDown={(event) => begin("move", event)}
                className="flex min-h-8 shrink-0 cursor-move touch-none items-center gap-2 border-b border-gray-200 bg-gray-50 px-2">
                <GripHorizontal aria-hidden className="size-3.5 shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1" />
                <button type="button" aria-label="Close source reader" onClick={() => onClose()}
                    onPointerDown={(event) => event.stopPropagation()}
                    className="grid size-7 shrink-0 place-items-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
                    <X className="size-3.5" aria-hidden />
                </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <LegalSourceViewer {...tab} navigationRequest={tab} compact />
            </div>
            <div role="separator" tabIndex={0} aria-label="Resize source reader" aria-orientation="vertical"
                onPointerDown={(event) => { event.stopPropagation(); begin("resize", event); }}
                onKeyDown={resizeByKey}
                className="absolute right-0 bottom-0 z-10 size-4 cursor-nwse-resize touch-none focus-visible:bg-gray-300 focus-visible:outline-none" />
        </section>, document.body);
}
