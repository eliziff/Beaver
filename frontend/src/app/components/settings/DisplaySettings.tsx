"use client";

import { Switch } from "@/app/components/ui/switch";
import { useAssistantPreferences } from "@/app/components/assistant/assistantPreferences";
import { MODEL_PROVIDERS, providerLabel } from "@/app/lib/modelAvailability";

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

export function DisplaySettings() {
    const [preferences, savePreferences] = useAssistantPreferences();
    return <>
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
                <span className="truncate text-sm text-gray-900">{providerLabel(provider)}</span>
                <Switch checked={!disabled.has(provider)}
                    onChange={(enabled) => savePreferences((current) => ({ ...current, disabledProviders: enabled
                        ? current.disabledProviders.filter((item) => item !== provider)
                        : [...current.disabledProviders, provider] }))}
                    size="md" ariaLabel={`Show ${providerLabel(provider)} in the model picker`} />
            </label>
        ))}
    </div>;
}
