import { useSyncExternalStore } from "react";

export type ActivityDetail = "standard" | "tools" | "trace";

const KEY = "beaver.activityDetail";
const EVENT = "beaver:activity-detail-updated";

export function readActivityDetail(): ActivityDetail {
    if (typeof window === "undefined") return "standard";
    const stored = window.localStorage.getItem(KEY);
    return stored === "tools" || stored === "trace" ? stored : "standard";
}

export function setActivityDetail(detail: ActivityDetail) {
    window.localStorage.setItem(KEY, detail);
    window.dispatchEvent(new Event(EVENT));
}

function subscribe(update: () => void) {
    window.addEventListener("storage", update);
    window.addEventListener(EVENT, update);
    return () => {
        window.removeEventListener("storage", update);
        window.removeEventListener(EVENT, update);
    };
}

export function useActivityDetail() {
    const detail = useSyncExternalStore(
        subscribe,
        readActivityDetail,
        () => "standard" as const,
    );
    return { detail, setDetail: setActivityDetail };
}
