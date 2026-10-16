"use client";

import { Switch } from "@/app/components/ui/switch";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { ModelToggle } from "@/app/components/assistant/ModelToggle";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { SettingRow } from "./AccountSection";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { readAppearance, saveAppearance, type Appearance } from "@/app/lib/appearance";
import { useAssistantPreferences } from "@/app/components/assistant/assistantPreferences";
import { providerShortLabel, type ModelProvider } from "@/app/lib/modelAvailability";
import { PROVIDER_LOGO } from "@/app/lib/providerLogos";

/** Chat display switches, in render order. */
const TOGGLES = [
    {
        key: "showContextUsage",
        title: "Context usage",
        detail: "Show the context window meter below the message field.",
        ariaLabel: "Show context usage",
    },
    {
        key: "showAutoMode",
        title: "Enable Auto mode",
        detail: "Adds Auto to the chat editing control. Manual remains the default.",
        ariaLabel: "Enable Auto mode",
    },
] as const;

// The providers a reader can hide from the model picker, in display order.
const MODEL_PROVIDERS: ModelProvider[] = [
    "claude", "claude-p", "openai", "codex", "gemini", "deepseek",
    "opencode-go", "openrouter", "meta", "ollama",
];

export function DisplaySettings() {
    const [appearance, setAppearance] = useState(readAppearance);
    const [preferences, savePreferences] = useAssistantPreferences();
    return <>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <label htmlFor="appearance" className="text-sm font-medium text-gray-900">Appearance</label>
            <div className="w-full sm:w-40"><ModalSelect id="appearance" ariaLabel="Appearance" value={appearance} placeholder={null}
                onChange={(value) => { setAppearance(value as Appearance); saveAppearance(value as Appearance); }}
                options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} /></div>
        </div>
        {TOGGLES.map(({ key, title, detail, ariaLabel }) => (
            <div key={key} className="flex items-center justify-between gap-4">
                <div>
                    <p className="text-sm font-medium text-gray-900">{title}</p>
                    <p className="mt-0.5 text-xs leading-5 text-gray-500">{detail}</p>
                </div>
                <Switch
                    checked={preferences[key]}
                    onChange={(checked) => savePreferences({ [key]: checked })}
                    size="md"
                    ariaLabel={ariaLabel}
                />
            </div>
        ))}
    </>;
}

export function ModelProviderSettings() {
    const [preferences, savePreferences] = useAssistantPreferences();
    const disabled = new Set(preferences.disabledProviders);
    return <div className="space-y-2.5">
        {MODEL_PROVIDERS.map((provider) => (
            <label key={provider} className="flex items-center justify-between gap-4">
                <span className="flex min-w-0 items-center gap-2 text-sm text-gray-900">
                    {PROVIDER_LOGO[provider] && <img src={PROVIDER_LOGO[provider]}
                        alt="" aria-hidden="true" className="h-4 w-4 shrink-0" />}
                    <span className="truncate">{providerShortLabel(provider)}</span>
                </span>
                <Switch checked={!disabled.has(provider)}
                    onChange={(enabled) => savePreferences((current) => ({ ...current, disabledProviders: enabled
                        ? current.disabledProviders.filter((item) => item !== provider)
                        : [...current.disabledProviders, provider] }))}
                    size="md" ariaLabel={`Show ${providerShortLabel(provider)} in the model picker`} />
            </label>
        ))}
    </div>;
}

/** Whether chat may search CourtListener and A2AJ. */
export function CaseLawSetting() {
    const { profile, updateProfile } = useUserProfile();
    const [pending, setPending] = useState<boolean | null>(null), [failed, setFailed] = useState(false);
    return <SettingRow title="US and Canadian case law"
        description={failed ? "Could not update. Try again." : "Lets the assistant search CourtListener for US cases and A2AJ for Canadian cases."}>
        <Switch checked={pending ?? profile?.legalResearchUs ?? true} disabled={pending !== null || !profile} size="md"
            ariaLabel="Enable case law research" onChange={async (enabled) => {
                setFailed(false); setPending(enabled);
                setFailed(!await updateProfile({ legalResearchUs: enabled }));
                setPending(null);
            }} />
    </SettingRow>;
}

const MODEL_PREFERENCES = [
    { field: "titleModel", label: "Title generation model", detail: "Names chats and other short titles.",
        fallback: "gemini-3.1-flash-lite-preview", includeSettingsModels: true },
    { field: "tabularModel", label: "Tabular review model", detail: "Fills tabular review cells. Smaller models usually cost less.",
        fallback: "gemini-3-flash-preview", includeSettingsModels: false },
] as const;

/** The models Beaver uses for chat titles and tabular reviews. */
export function ModelPreferenceSettings() {
    const { profile, updateProfile } = useUserProfile();
    const [pending, setPending] = useState<Partial<Record<(typeof MODEL_PREFERENCES)[number]["field"], string>>>({});
    return <div className="divide-y divide-gray-200">{MODEL_PREFERENCES.map(({ field, label, detail, fallback, includeSettingsModels }) =>
        <SettingRow key={field} title={label} description={detail}>
            <div className="flex w-full items-center gap-2 sm:w-auto">
                <ModelToggle value={pending[field] ?? profile?.[field] ?? fallback} disabled={!!pending[field]}
                    includeSettingsModels={includeSettingsModels} apiKeys={profile?.apiKeys} onChange={async (id) => {
                        setPending((current) => ({ ...current, [field]: id }));
                        await updateProfile({ [field]: id });
                        setPending(({ [field]: _, ...rest }) => rest);
                    }} />
                <span className="size-3.5 shrink-0">{pending[field] && <Loader2 className="size-3.5 animate-spin text-gray-500" />}</span>
            </div>
        </SettingRow>)}
    </div>;
}
