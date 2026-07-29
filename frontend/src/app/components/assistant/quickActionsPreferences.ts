import { useSyncExternalStore } from "react";
export const QUICK_ACTIONS = [
    { id: "proofread", label: "Proofread" },
    { id: "compareDocuments", label: "Compare documents" },
    { id: "extractKeyTerms", label: "Extract key terms" },
    { id: "draftFromTemplate", label: "Draft from template" },
    { id: "newProject", label: "New project" },
    { id: "newTabularReview", label: "New tabular review" },
    { id: "projectChat", label: "Start chat in project" },
] as const;
export type QuickActionId = (typeof QUICK_ACTIONS)[number]["id"];
type QuickActionPreferences = Record<QuickActionId, boolean>;
type QuickActionPreferenceUpdate =
    | QuickActionPreferences
    | ((previous: QuickActionPreferences) => QuickActionPreferences);
const DEFAULT_QUICK_ACTIONS: QuickActionPreferences = {
    projectChat: true,
    proofread: true,
    compareDocuments: true,
    extractKeyTerms: true,
    draftFromTemplate: true,
    newProject: false,
    newTabularReview: false,
};
const QUICK_ACTIONS_STORAGE_KEY = "mike.quickActions.visible";
const QUICK_ACTIONS_UPDATED_EVENT = "mike:quick-actions-updated";
let cachedRawPreference: string | null | undefined;
let cachedPreference: QuickActionPreferences = DEFAULT_QUICK_ACTIONS;
function normalizeQuickActions(value: unknown): QuickActionPreferences {
    if (!value || typeof value !== "object") return DEFAULT_QUICK_ACTIONS;
    const record = value as Partial<Record<QuickActionId, unknown>>;
    return Object.fromEntries(
        QUICK_ACTIONS.map(({ id }) => {
            const storedValue = record[id];
            return [
                id,
                typeof storedValue === "boolean"
                    ? storedValue
                    : DEFAULT_QUICK_ACTIONS[id],
            ];
        }),
    ) as QuickActionPreferences;
}
function readQuickActionsPreference(): QuickActionPreferences {
    if (typeof window === "undefined") return DEFAULT_QUICK_ACTIONS;
    try {
        const stored = window.localStorage.getItem(QUICK_ACTIONS_STORAGE_KEY);
        if (stored === cachedRawPreference) return cachedPreference;
        cachedRawPreference = stored;
        cachedPreference = stored
            ? normalizeQuickActions(JSON.parse(stored))
            : DEFAULT_QUICK_ACTIONS;
        return cachedPreference;
    } catch {
        return DEFAULT_QUICK_ACTIONS;
    }
}
function persistQuickActionsPreference(
    value: QuickActionPreferences,
) {
    if (typeof window === "undefined") return;
    const serialized = JSON.stringify(value);
    cachedRawPreference = serialized;
    cachedPreference = value;
    window.localStorage.setItem(QUICK_ACTIONS_STORAGE_KEY, serialized);
    window.dispatchEvent(new Event(QUICK_ACTIONS_UPDATED_EVENT));
}
export function useQuickActionsPreference() {
    const visibleActions = useSyncExternalStore(
        (handleQuickActionsUpdated) => {
            if (typeof window === "undefined") return () => {};
            window.addEventListener("storage", handleQuickActionsUpdated);
            window.addEventListener(
                QUICK_ACTIONS_UPDATED_EVENT,
                handleQuickActionsUpdated,
            );
            return () => {
                window.removeEventListener(
                    "storage",
                    handleQuickActionsUpdated,
                );
                window.removeEventListener(
                    QUICK_ACTIONS_UPDATED_EVENT,
                    handleQuickActionsUpdated,
                );
            };
        },
        readQuickActionsPreference,
        () => DEFAULT_QUICK_ACTIONS,
    );
    const setVisibleActions = (next: QuickActionPreferenceUpdate) => {
        const previous = readQuickActionsPreference();
        persistQuickActionsPreference(
            normalizeQuickActions(
                typeof next === "function" ? next(previous) : next,
            ),
        );
    };
    return {
        visibleActions,
        setVisibleActions,
        showAllQuickActions: () => setVisibleActions(DEFAULT_QUICK_ACTIONS),
        hideAllQuickActions: () =>
            setVisibleActions(
                Object.fromEntries(
                    QUICK_ACTIONS.map(({ id }) => [id, false]),
                ) as QuickActionPreferences,
            ),
    };
}
