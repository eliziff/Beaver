import { useSyncExternalStore } from "react";

const STORAGE_KEY = "beaver.readSubagents.v1";
const UPDATED_EVENT = "beaver:read-subagents-updated";
export const DEFAULT_READ_SUBAGENT_MODEL = "codex:gpt-5.6-luna";
export const DEFAULT_READ_SUBAGENT_EFFORT = "high";
const DEFAULT_PREFERENCE = {
    enabled: false,
    showDock: true,
    model: DEFAULT_READ_SUBAGENT_MODEL,
    effort: DEFAULT_READ_SUBAGENT_EFFORT,
} as const;

export type ReadSubagentPreference = {
    enabled: boolean;
    showDock: boolean;
    model: string;
    effort: string;
};

export function readReadSubagentPreference(): ReadSubagentPreference {
    if (typeof window === "undefined") return DEFAULT_PREFERENCE;
    try {
        const stored = JSON.parse(
            window.localStorage.getItem(STORAGE_KEY) ?? "null",
        ) as {
            enabled?: unknown;
            showDock?: unknown;
            model?: unknown;
            effort?: unknown;
        } | null;
        return {
            enabled: stored?.enabled === true,
            showDock: stored?.showDock !== false,
            model:
                typeof stored?.model === "string" &&
                stored.model.startsWith("codex:")
                    ? stored.model
                    : DEFAULT_READ_SUBAGENT_MODEL,
            effort:
                typeof stored?.effort === "string" && stored.effort.trim()
                    ? stored.effort
                    : DEFAULT_READ_SUBAGENT_EFFORT,
        };
    } catch {
        return DEFAULT_PREFERENCE;
    }
}

export function setReadSubagentPreference(enabled: boolean) {
    setReadSubagentPreferences({ enabled });
}

export function setReadSubagentPreferences(
    update: Partial<ReadSubagentPreference>,
) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...readReadSubagentPreference(), ...update }),
    );
    window.dispatchEvent(new Event(UPDATED_EVENT));
}

function subscribe(handleUpdate: () => void) {
    if (typeof window === "undefined") return () => {};
    window.addEventListener("storage", handleUpdate);
    window.addEventListener(UPDATED_EVENT, handleUpdate);
    return () => {
        window.removeEventListener("storage", handleUpdate);
        window.removeEventListener(UPDATED_EVENT, handleUpdate);
    };
}

export function useReadSubagentPreference() {
    const snapshot = useSyncExternalStore(
        subscribe,
        () => JSON.stringify(readReadSubagentPreference()),
        () => JSON.stringify(DEFAULT_PREFERENCE),
    );
    const preference = JSON.parse(snapshot) as ReadSubagentPreference;
    return {
        ...preference,
        setEnabled: setReadSubagentPreference,
        setShowDock: (showDock: boolean) =>
            setReadSubagentPreferences({ showDock }),
        setModel: (model: string) => setReadSubagentPreferences({ model }),
        setEffort: (effort: string) => setReadSubagentPreferences({ effort }),
    };
}
