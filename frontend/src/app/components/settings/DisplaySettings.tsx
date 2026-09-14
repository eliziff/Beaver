"use client";

import { Switch } from "@/app/components/ui/switch";
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
    const [preferences, savePreferences] = useAssistantPreferences();
    const disabled = new Set(preferences.disabledProviders);
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
        <div className="border-t border-gray-200 pt-4">
            <p className="text-sm font-medium text-gray-900">Model providers</p>
            <p className="mt-0.5 text-xs leading-5 text-gray-500">
                Turn off a provider to hide it from the model picker.
            </p>
            <div className="mt-3 space-y-2.5">
                {MODEL_PROVIDERS.map((provider) => (
                    <label key={provider} className="flex items-center justify-between gap-4">
                        <span className="flex min-w-0 items-center gap-2 text-sm text-gray-900">
                            {PROVIDER_LOGO[provider] && <img src={PROVIDER_LOGO[provider]}
                                alt="" aria-hidden="true" className="h-4 w-4 shrink-0" />}
                            <span className="truncate">{providerShortLabel(provider)}</span>
                        </span>
                        <Switch checked={!disabled.has(provider)}
                            onChange={(enabled) => savePreferences({ disabledProviders: enabled
                                ? preferences.disabledProviders.filter((item) => item !== provider)
                                : [...preferences.disabledProviders, provider] })}
                            size="md"
                            ariaLabel={`Show ${providerShortLabel(provider)} in the model picker`} />
                    </label>
                ))}
            </div>
        </div>
    </>;
}
