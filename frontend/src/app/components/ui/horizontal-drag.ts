import type { PointerEvent as ReactPointerEvent } from "react";

export const HORIZONTAL_RESIZE_HANDLE_CLASS =
    "cursor-col-resize touch-none select-none bg-transparent hover:bg-gray-400";

export function horizontalDrag(onDelta: (deltaX: number) => void) {
    return (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const target = event.currentTarget;
        let lastX = event.clientX;
        const stop = () => {
            target.onpointermove = null;
            target.onpointerup = null;
            target.onpointercancel = null;
            target.onlostpointercapture = null;
        };
        target.setPointerCapture?.(event.pointerId);
        target.onpointermove = (move) => {
            const deltaX = move.clientX - lastX;
            lastX = move.clientX;
            if (deltaX) onDelta(deltaX);
        };
        target.onpointerup = stop;
        target.onpointercancel = stop;
        target.onlostpointercapture = stop;
    };
}
