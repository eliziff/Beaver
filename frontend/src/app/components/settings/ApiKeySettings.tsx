"use client";
import { useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/app/components/ui/input";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useMfaAction } from "@/app/components/account/useMfaAction";
import { errorMessage } from "@/app/lib/utils";
import type { ApiKeyProvider, ApiKeyState } from "@/app/lib/api/account";
import { AccountSection, accountGlassIconButtonClassName, accountGlassInputClassName } from "./AccountSection";
const API_KEY_FIELDS = [
    {
        provider: "claude",
        label: "Anthropic (Claude)",
        placeholder: "sk-ant-...",
    },
    {
        provider: "gemini",
        label: "Google (Gemini)",
        placeholder: "AI...",
    },
    {
        provider: "openai",
        label: "OpenAI",
        placeholder: "sk-...",
    },
    {
        provider: "deepseek",
        label: "DeepSeek",
        placeholder: "sk-...",
    },
    {
        provider: "openrouter",
        label: "OpenRouter",
        placeholder: "sk-or-...",
    },
    {
        provider: "opencode-go",
        label: "OpenCode Go",
        placeholder: "OpenCode Go key",
        description:
            "Uses your OpenCode Go subscription across its supported model catalog.",
    },
    {
        provider: "meta",
        label: "Meta (Muse Spark)",
        placeholder: "LLM_...",
    },
    {
        provider: "courtlistener",
        label: "CourtListener",
        placeholder: "Token...",
        description:
            "Adds current data beyond Beaver's local bulk corpus.",
    },
] as const;
export function ApiKeySettings() {
    const { profile, updateApiKey } = useUserProfile();
    const { runMfa, mfaPopup } = useMfaAction();
    return (
        <>
            <AccountSection className="divide-y divide-gray-200">
                {API_KEY_FIELDS.map((field) => (
                    <ApiKeyField
                        key={field.provider}
                        field={field}
                        state={profile?.apiKeys[field.provider]}
                        update={updateApiKey}
                        runMfa={runMfa}
                    />
                ))}
            </AccountSection>
            {mfaPopup}
        </>
    );
}
function ApiKeyField({
    field,
    state,
    update,
    runMfa,
}: {
    field: (typeof API_KEY_FIELDS)[number];
    state?: ApiKeyState[ApiKeyProvider];
    update: (provider: ApiKeyProvider, value: string | null) => Promise<void>;
    runMfa: ReturnType<typeof useMfaAction>["runMfa"];
}) {
    const [reveal, setReveal] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const description =
        "description" in field ? field.description : undefined;
    const isServerConfigured = state?.source === "env";
    const mutate = (
        action: "save" | "remove",
        value: string | null = null,
        form?: HTMLFormElement,
    ) => {
        void runMfa(
            async () => {
                setError(null);
                setSaving(true);
                try {
                    await update(field.provider, action === "save" ? value! : null);
                    form?.reset();
                    setReveal(false);
                } finally {
                    setSaving(false);
                }
            },
            {
                onError: (caught) =>
                    setError(errorMessage(caught, `Failed to ${action} ${field.label}.`)),
            },
        );
    };
    return (
        <form
            className="px-4 py-5"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const value = String(new FormData(event.currentTarget).get("key") ?? "").trim();
                if (value) mutate("save", value, event.currentTarget);
            }}
        >
            <label htmlFor={`api-key-${field.provider}`} className="mb-2 block text-sm font-medium text-gray-700">
                {field.label}
            </label>
            {description && (
                <p className="mb-3 text-sm text-gray-500">{description}</p>
            )}
            <div className="space-y-2">
                <div className="relative flex-1">
                    <Input
                        id={`api-key-${field.provider}`}
                        name="key"
                        type={reveal ? "text" : "password"}
                        placeholder={
                            isServerConfigured
                                ? "Using shared key; add your own"
                                : state?.configured
                                  ? "Saved key hidden"
                                  : field.placeholder
                        }
                        className={`pr-10 ${accountGlassInputClassName}`}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={saving}
                        required
                    />
                    {(
                        <button
                            type="button"
                            onClick={() => setReveal((r) => !r)}
                            className={`absolute inset-y-1 right-1.5 flex items-center ${accountGlassIconButtonClassName}`}
                            aria-label={reveal ? "Hide key" : "Show key"}
                        >
                            {reveal ? (
                                <EyeOff className="h-4 w-4" />
                            ) : (
                                <Eye className="h-4 w-4" />
                            )}
                        </button>
                    )}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                    <button
                        type="submit"
                        disabled={saving}
                        className="text-xs font-medium text-gray-700 hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                    >
                        {saving ? "Saving..." : "Save"}
                    </button>
                    {state?.source === "user" && (
                        <button
                            type="button"
                            onClick={() => mutate("remove")}
                            disabled={saving}
                            className="text-xs font-medium text-red-600 hover:text-red-700 disabled:cursor-not-allowed disabled:text-red-300"
                        >
                            Remove
                        </button>
                    )}
                </div>
                {error && (
                    <p role="alert" className="text-xs text-red-700">
                        {error}
                    </p>
                )}
            </div>
        </form>
    );
}
