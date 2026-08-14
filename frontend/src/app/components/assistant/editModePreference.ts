import { useSyncExternalStore } from "react";

const KEY = "beaver.showAutoMode";
const EVENT = "beaver:show-auto-mode-updated";

export function readShowAutoMode() {
    return (
        typeof window !== "undefined" &&
        window.localStorage.getItem(KEY) === "true"
    );
}

export function setShowAutoMode(show: boolean) {
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

export function useShowAutoMode() {
    return useSyncExternalStore(subscribe, readShowAutoMode, () => false);
}
