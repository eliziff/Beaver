import { useSyncExternalStore } from "react";

const KEY = "beaver.citations.footnotes";
const EVENT = "beaver:citation-display";

function read() {
    return typeof window !== "undefined" && window.localStorage.getItem(KEY) === "1";
}

export function useFootnoteCitationPreference() {
    const enabled = useSyncExternalStore(
        (notify) => {
            window.addEventListener("storage", notify);
            window.addEventListener(EVENT, notify);
            return () => {
                window.removeEventListener("storage", notify);
                window.removeEventListener(EVENT, notify);
            };
        },
        read,
        () => false,
    );
    return {
        enabled,
        setEnabled(next: boolean) {
            window.localStorage.setItem(KEY, next ? "1" : "0");
            window.dispatchEvent(new Event(EVENT));
        },
    };
}
