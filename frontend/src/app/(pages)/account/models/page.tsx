"use client";
import { useState } from "react";
import { Info, Loader2 } from "lucide-react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type { ApiKeyState } from "@/app/lib/beaverApi";
import {
    MODELS,
    ModelToggle,
    SETTINGS_MODELS,
    type ModelOption,
} from "@/app/components/assistant/ModelToggle";
import { AccountSection } from "../AccountSection";
type ModelPreferenceField = "titleModel" | "tabularModel";
export default function ModelPreferencesPage() {
    const { profile, updateModelPreference } = useUserProfile();
    const [savingField, setSavingField] = useState<ModelPreferenceField | null>(
        null,
    );
    const [optimisticValues, setOptimisticValues] = useState<
        Partial<Record<ModelPreferenceField, string>>
    >({});
    const handleModelChange = async (
        field: ModelPreferenceField,
        id: string,
    ) => {
        setOptimisticValues((current) => ({ ...current, [field]: id }));
        setSavingField(field);
        const ok = await updateModelPreference(field, id);
        setSavingField((current) => (current === field ? null : current));
        if (!ok) {
            setOptimisticValues((current) => {
                const next = { ...current };
                delete next[field];
                return next;
            });
        }
    };
    return (
        <AccountSection heading="Model preferences">
                <div className="px-4 py-5">
                    <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-700">
                        Title generation model
                        <InfoButton text="Names chats and other short titles." />
                    </div>
                    <ModelPreferenceDropdown
                        value={
                            optimisticValues.titleModel ??
                            profile?.titleModel ??
                            "gemini-3.1-flash-lite-preview"
                        }
                        options={SETTINGS_MODELS}
                        apiKeys={profile?.apiKeys}
                        isSaving={savingField === "titleModel"}
                        onChange={(id) => handleModelChange("titleModel", id)}
                    />
                </div>
                <div className="mx-4 h-px bg-gray-200" />
                <div className="px-4 py-5">
                    <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-700">
                        Tabular review model
                        <InfoButton text="Smaller models usually cost less for tabular reviews." />
                    </div>
                    <ModelPreferenceDropdown
                        value={
                            optimisticValues.tabularModel ??
                            profile?.tabularModel ??
                            "gemini-3-flash-preview"
                        }
                        options={MODELS}
                        apiKeys={profile?.apiKeys}
                        isSaving={savingField === "tabularModel"}
                        onChange={(id) => handleModelChange("tabularModel", id)}
                    />
                </div>
        </AccountSection>
    );
}
function ModelPreferenceDropdown({
    value,
    onChange,
    apiKeys,
    options,
    isSaving,
}: {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    options: ModelOption[];
    isSaving?: boolean;
}) {
    return (
        <div className="flex w-full max-w-xs items-center gap-2">
            <ModelToggle
                value={value}
                disabled={isSaving}
                models={options}
                apiKeys={apiKeys}
                onChange={onChange}
                className="max-w-xs"
            />
            <span className="h-3.5 w-3.5 shrink-0">
                {isSaving && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-500" />
                )}
            </span>
        </div>
    );
}
function InfoButton({ text }: { text: string }) {
    return (
        <span
            title={text}
            aria-label={text}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-gray-400 hover:text-gray-700 focus-visible:text-gray-700"
        >
            <Info className="h-3.5 w-3.5" />
        </span>
    );
}
