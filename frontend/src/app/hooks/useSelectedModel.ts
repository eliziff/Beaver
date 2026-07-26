"use client";

import { useCallback, useEffect, useState } from "react";
import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID } from "../components/assistant/ModelToggle";

const STORAGE_KEY = "mike.selectedModel";

function readStored(): string {
    if (typeof window === "undefined") return DEFAULT_MODEL_ID;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && (ALLOWED_MODEL_IDS.has(raw) || raw.startsWith("codex:"))) {
        return raw;
    }
    return DEFAULT_MODEL_ID;
}

export function useSelectedModel(): [string, (id: string) => void] {
    const [model, setModelState] = useState<string>(DEFAULT_MODEL_ID);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe localStorage read; SSR must render the default model
        setModelState(readStored());
    }, []);

    const setModel = useCallback((id: string) => {
        const next =
            ALLOWED_MODEL_IDS.has(id) || id.startsWith("codex:")
                ? id
                : DEFAULT_MODEL_ID;
        setModelState(next);
        if (typeof window !== "undefined") {
            window.localStorage.setItem(STORAGE_KEY, next);
        }
    }, []);

    return [model, setModel];
}

const EFFORT_STORAGE_KEY = "mike.codexReasoningEffort";

export function useSelectedReasoningEffort(): [
    string | undefined,
    (value: string) => void,
] {
    const [effort, setEffortState] = useState<string | undefined>(undefined);

    useEffect(() => {
        const stored = window.localStorage.getItem(EFFORT_STORAGE_KEY);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe localStorage read; SSR must render the default effort
        if (stored) setEffortState(stored);
    }, []);

    const setEffort = useCallback((value: string) => {
        const next = value.trim();
        if (!next) return;
        setEffortState(next);
        window.localStorage.setItem(EFFORT_STORAGE_KEY, next);
    }, []);

    return [effort, setEffort];
}
