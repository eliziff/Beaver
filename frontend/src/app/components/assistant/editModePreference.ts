import { useSyncExternalStore } from "react";

const SHOW_AUTO_KEY = "beaver.showAutoMode";
const MODE_KEY = "beaver.editMode";
const EVENT = "beaver:edit-mode-preference-updated";
type EditMode = "manual" | "auto";

export function readShowAutoMode() {
    return (
        typeof window !== "undefined" &&
        window.localStorage.getItem(SHOW_AUTO_KEY) === "true"
    );
}

export function setShowAutoMode(show: boolean) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SHOW_AUTO_KEY, String(show));
    window.dispatchEvent(new Event(EVENT));
}

function readEditMode(): EditMode {
    return typeof window !== "undefined" &&
        window.localStorage.getItem(MODE_KEY) === "auto"
        ? "auto"
        : "manual";
}

function setEditMode(mode: EditMode) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(MODE_KEY, mode);
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

export function useEditMode() {
    return [
        useSyncExternalStore<EditMode>(subscribe, readEditMode, () => "manual"),
        setEditMode,
    ] as const;
}
