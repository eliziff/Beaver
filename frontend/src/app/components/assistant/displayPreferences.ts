import { useSyncExternalStore } from "react";

const KEY = "beaver.showContextUsage";
const EVENT = "beaver:show-context-usage-updated";

export function readShowContextUsage() {
    return typeof window === "undefined" || window.localStorage.getItem(KEY) !== "false";
}

export function setShowContextUsage(show: boolean) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(KEY, String(show));
    window.dispatchEvent(new Event(EVENT));
}

function subscribe(update: () => void) {
    if (typeof window === "undefined") return () => {};
    window.addEventListener("storage", update);
    window.addEventListener(EVENT, update);
    return () => {
        window.removeEventListener("storage", update);
        window.removeEventListener(EVENT, update);
    };
}

export function useShowContextUsage() {
    return useSyncExternalStore(subscribe, readShowContextUsage, () => true);
}
