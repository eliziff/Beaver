import { useLayoutEffect, useState, type RefObject } from "react";

// The dock shares layout space with its sibling at every viewport width.
// Keep it in flow: overlays prevent concurrent use of chat and workspace.
export const ASSISTANT_DOCK_CLASS =
    "relative my-3 me-3 h-[calc(100%-1.5rem)] min-w-0 w-[min(var(--assistant-dock-width),var(--assistant-dock-max-width))] rounded-2xl";
export const ASSISTANT_DOCK_DEFAULT_WIDTH = 520;
export const ASSISTANT_DOCK_MIN_WIDTH = 360;
// Two spellings of one rule — the cap the dock honours, and the cap a sibling has to predict from it
// while the dock is shut and has no layout of its own to measure. Change them together.
export const ASSISTANT_DOCK_MAX_WIDTH = "max(45%, calc(100% - 36rem))";
const dockCap = (row: number, rem: number) => Math.max(0.45 * row, row - 36 * rem);
const DOCK_GAP = 0.75; // rem: the me-3 between the dock and the column beside it

/** How wide the reading column is laid out, dock open or shut: always the room left beside the dock.
 *  Holding that width while the dock is shut is what keeps opening it from re-wrapping a single line,
 *  so the column only slides. Null until measured — the caller keeps its own cap until then. */
export function useDockedColumnWidth(box: RefObject<HTMLElement | null>, dockOpen: boolean) {
    const [width, setWidth] = useState<number | null>(null);
    useLayoutEffect(() => {
        const element = box.current;
        if (!element) return;
        const measure = () => {
            const dock = element.closest("[data-dock-host]")?.querySelector<HTMLElement>("[data-assistant-dock]");
            // Shut, this box spans the whole row, so its own width is the base the dock would cap against.
            const row = element.getBoundingClientRect().width;
            const asked = dock ? Number.parseFloat(
                getComputedStyle(dock).getPropertyValue("--assistant-dock-width")) : Number.NaN;
            const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            const reserve = !dock || dockOpen ? 0 : Math.min(
                Number.isFinite(asked) ? asked : ASSISTANT_DOCK_DEFAULT_WIDTH, dockCap(row, rem))
                + DOCK_GAP * rem;
            // The column lives inside this box's padding, so the padding is not room it can use.
            const style = getComputedStyle(element);
            const inside = element.clientWidth
                - Number.parseFloat(style.paddingInlineStart) - Number.parseFloat(style.paddingInlineEnd);
            // Whole pixels: the predicted reserve lands a fraction off the room the dock really takes,
            // and a fraction is enough to break a line differently on one side of the change.
            setWidth(Math.max(0, Math.round(inside - reserve)));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [box, dockOpen]);
    return width;
}

/** The cap to put on that column: its own maximum measure, never wider than the room beside the dock. */
export const dockedColumnStyle = (width: number | null, max = "56rem") =>
    width === null ? undefined : { maxWidth: `min(${max}, ${width}px)` };
