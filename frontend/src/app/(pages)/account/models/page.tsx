"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Info, Loader2 } from "lucide-react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type { ApiKeyState } from "@/app/lib/beaverApi";
import {
    MODELS,
    SETTINGS_MODELS,
    type ModelOption,
} from "@/app/components/assistant/ModelToggle";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import {
    accountGlassInputClassName,
} from "../accountStyles";
import { AccountSection } from "../AccountSection";

type ModelPreferenceField = "titleModel" | "tabularModel";

export default function ModelPreferencesPage() {
    const { profile, updateModelPreference } = useUserProfile();
    const [savingField, setSavingField] = useState<ModelPreferenceField | null>(
        null,
    );
    const [savedField, setSavedField] = useState<ModelPreferenceField | null>(
        null,
    );
    const [optimisticValues, setOptimisticValues] = useState<
        Partial<Record<ModelPreferenceField, string>>
    >({});
    const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        };
    }, []);

    const handleModelChange = async (
        field: ModelPreferenceField,
        id: string,
    ) => {
        setOptimisticValues((current) => ({ ...current, [field]: id }));
        setSavedField(null);
        setSavingField(field);
        const ok = await updateModelPreference(field, id);
        setSavingField((current) => (current === field ? null : current));
        if (ok) {
            setSavedField(field);
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
            savedTimerRef.current = setTimeout(() => {
                setSavedField((current) => (current === field ? null : current));
            }, 1600);
        } else {
            setOptimisticValues((current) => {
                const next = { ...current };
                delete next[field];
                return next;
            });
        }
    };

    return (
        <div>
            <div className="flex items-center gap-2 mb-4">
                <h2 className="text-2xl font-medium font-serif">
                    Model preferences
                </h2>
            </div>
            <AccountSection>
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
                        isSaved={savedField === "titleModel"}
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
                        isSaved={savedField === "tabularModel"}
                        onChange={(id) => handleModelChange("tabularModel", id)}
                    />
                </div>
            </AccountSection>
        </div>
    );
}

function ModelPreferenceDropdown({
    value,
    onChange,
    apiKeys,
    options,
    isSaving,
    isSaved,
}: {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    options: ModelOption[];
    isSaving?: boolean;
    isSaved?: boolean;
}) {
    const selected = options.find((m) => m.id === value);
    const selectedAvailable = apiKeys ? isModelAvailable(value, apiKeys) : true;
    const groups = [...new Set(options.map((model) => model.group))];

    return (
        <div className="flex w-full max-w-xs items-center gap-2">
            {!selectedAvailable && (
                <AlertCircle
                    className="h-3.5 w-3.5 shrink-0 text-red-500"
                    aria-label="API key missing"
                />
            )}
            <select
                value={value}
                disabled={isSaving}
                onChange={(event) => onChange(event.currentTarget.value)}
                title={selected?.label ?? "Select a model"}
                aria-label="Model"
                className={`h-9 min-w-0 flex-1 px-3 text-sm ${accountGlassInputClassName}`}
            >
                {groups.map((group) => {
                    const items = options.filter((m) => m.group === group);
                    return (
                        <optgroup key={group} label={group}>
                            {items.map((m) => {
                                const available = apiKeys
                                    ? isModelAvailable(m.id, apiKeys)
                                    : true;
                                return (
                                    <option key={m.id} value={m.id}>
                                        {m.label}
                                        {available ? "" : " (API key missing)"}
                                    </option>
                                );
                            })}
                        </optgroup>
                    );
                })}
            </select>
            {isSaving ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-500" />
            ) : isSaved ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-green-600" />
            ) : null}
        </div>
    );
}

function InfoButton({ text }: { text: string }) {
    return (
        <button
            type="button"
            title={text}
            aria-label={text}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-gray-400 hover:text-gray-700 focus-visible:text-gray-700"
        >
            <Info className="h-3.5 w-3.5" />
        </button>
    );
}
