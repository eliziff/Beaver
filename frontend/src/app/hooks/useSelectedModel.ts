import { useEffect, useState } from "react";
import {
    DEFAULT_MODEL_ID,
} from "../components/assistant/ModelToggle";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

const modelOrDefault = (value: string | null | undefined) => value?.trim() || DEFAULT_MODEL_ID;
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
