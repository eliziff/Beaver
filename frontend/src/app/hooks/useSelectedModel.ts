import { useEffect, useState } from "react";
import {
    ALLOWED_MODEL_IDS,
    DEFAULT_MODEL_ID,
} from "../components/assistant/ModelToggle";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

const isDynamicModel = (id: string) =>
    /^(?:codex|ollama):.+/u.test(id) || /^opencode-go\/.+/u.test(id);
const modelOrDefault = (value: string | null | undefined) =>
    value && (ALLOWED_MODEL_IDS.has(value) || isDynamicModel(value))
        ? value : DEFAULT_MODEL_ID;
const validEffort = (value: string | null | undefined) =>
    !!value && /^[a-z0-9_-]{1,32}$/iu.test(value);

export function useSelectedModel(initial?: string | null): [string, (id: string) => void] {
    const { profile, updateProfile } = useUserProfile();
    const persisted = modelOrDefault(initial ?? profile?.lastSelectedChatModel);
    const [model, setModel] = useState(persisted);
    useEffect(() => setModel(persisted), [persisted]);
    return [model, (id) => {
        const next = modelOrDefault(id);
        setModel(next);
        void updateProfile({ lastSelectedChatModel: next });
    }];
}

export function useSelectedReasoningEffort(initial?: string | null): [
    string | undefined,
    (value: string) => void,
] {
    const { profile, updateProfile } = useUserProfile();
    const preferred = initial ?? profile?.lastSelectedReasoningEffort;
    const persisted = validEffort(preferred) ? preferred! : undefined;
    const [effort, setEffort] = useState<string | undefined>(persisted);
    useEffect(() => setEffort(persisted), [persisted]);
    return [effort, (value) => {
        const next = value.trim();
        if (!validEffort(next)) return;
        setEffort(next);
        void updateProfile({ lastSelectedReasoningEffort: next });
    }];
}
