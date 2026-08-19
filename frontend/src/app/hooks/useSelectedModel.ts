import { useState } from "react";import {
    ALLOWED_MODEL_IDS,
    DEFAULT_MODEL_ID,
} from "../components/assistant/ModelToggle";
const STORAGE_KEY = "beaver.selectedModel";
const isDynamicModel = (id: string) => /^(codex|ollama):.+/u.test(id);
export function readSelectedModel(): string {
    if (typeof window === "undefined") return DEFAULT_MODEL_ID;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (
        raw &&
        (ALLOWED_MODEL_IDS.has(raw) || isDynamicModel(raw))
    ) {
        window.localStorage.setItem(STORAGE_KEY, raw);
        return raw;
    }
    return DEFAULT_MODEL_ID;
}
export function useSelectedModel(): [string, (id: string) => void] {
    const [model, setModelState] = useState<string>(readSelectedModel);
    const setModel = (id: string) => {        const next =            ALLOWED_MODEL_IDS.has(id) || isDynamicModel(id)                ? id
                : DEFAULT_MODEL_ID;
        setModelState(next);
        if (typeof window !== "undefined") {            window.localStorage.setItem(STORAGE_KEY, next);        }    };    return [model, setModel];
}
const EFFORT_STORAGE_KEY = "beaver.reasoningEffort";
const VALID_EFFORT = /^[a-z0-9_-]{1,32}$/i;
export function readSelectedReasoningEffort(): string | undefined {
    if (typeof window === "undefined") return undefined;
    const stored = window.localStorage.getItem(EFFORT_STORAGE_KEY);
    if (!stored || !VALID_EFFORT.test(stored)) return undefined;
    window.localStorage.setItem(EFFORT_STORAGE_KEY, stored);
    return stored;
}
export function useSelectedReasoningEffort(): [
    string | undefined,
    (value: string) => void,
] {
    const [effort, setEffortState] = useState<string | undefined>(
        readSelectedReasoningEffort,
    );
    const setEffort = (value: string) => {        const next = value.trim();        if (!VALID_EFFORT.test(next)) return;        setEffortState(next);        window.localStorage.setItem(EFFORT_STORAGE_KEY, next);    };    return [effort, setEffort];
}
