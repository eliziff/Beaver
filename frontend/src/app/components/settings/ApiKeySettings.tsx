"use client";
import { useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/app/components/ui/input";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useMfaAction } from "@/app/components/account/useMfaAction";
import { isAnonymousMode } from "@/app/lib/authMode";
import type { ApiKeyProvider, ApiKeyState } from "@/app/lib/beaverApi";
import {
    accountGlassIconButtonClassName,
    accountGlassInputClassName,
} from "@/app/(pages)/account/accountStyles";
import { AccountSection } from "@/app/(pages)/account/AccountSection";
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
        <div>
            <h2 className="mb-3 font-serif text-2xl font-medium text-gray-900">
                API keys
            </h2>
            <p className="mb-4 text-sm text-gray-500">
                {isAnonymousMode
                    ? "Read from the server environment."
                    : "Stored keys are encrypted. Server environment keys take precedence."}
            </p>
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
            {!isAnonymousMode && mfaPopup}
        </div>
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
    update: (provider: ApiKeyProvider, value: string | null) => Promise<boolean>;
    runMfa: ReturnType<typeof useMfaAction>["runMfa"];
}) {
    const [reveal, setReveal] = useState(false);
    const [saving, setSaving] = useState(false);
    const description =
        "description" in field ? field.description : undefined;
    if (isAnonymousMode)
        return (
            <div className="flex items-start justify-between gap-4 px-4 py-5">
                <div>
                    <p className="text-sm font-medium text-gray-700">
                        {field.label}
                    </p>
                    {description && (
                        <p className="mt-1 text-sm text-gray-500">
                            {description}
                        </p>
                    )}
                </div>
                <span className="shrink-0 text-sm text-gray-500">
                    {state === undefined
                        ? "Checking..."
                        : state.configured
                          ? "Configured"
                          : "Not configured"}
                </span>
            </div>
        );
    const isServerConfigured = state?.source === "env";
    const mutate = (
        action: "save" | "remove",
        value: string | null = null,
        form?: HTMLFormElement,
    ) => {
        void runMfa(
            async () => {
                setSaving(true);
                try {
                    const ok = await update(
                        field.provider,
                        action === "save" ? value! : null,
                    );
                    if (!ok) throw new Error();
                    form?.reset();
                    setReveal(false);
                } finally {
                    setSaving(false);
                }
            },
            {
                onError: () =>
                    alert(`Failed to ${action} ${field.label}.`),
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
            <label className="mb-2 block text-sm font-medium text-gray-700">
                {field.label}
            </label>
            {description && (
                <p className="mb-3 text-sm text-gray-500">{description}</p>
            )}
            <div className="space-y-2">
                <div className="relative flex-1">
                    <Input
                        name="key"
                        type={reveal ? "text" : "password"}
                        placeholder={
                            isServerConfigured
                                ? "Server .env key configured"
                                : state?.configured
                                  ? "Saved key hidden"
                                  : field.placeholder
                        }
                        className={`pr-10 ${accountGlassInputClassName}`}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={isServerConfigured}
                        required
                    />
                    {!isServerConfigured && (
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
                        disabled={isServerConfigured || saving}
                        className="text-xs font-medium text-gray-700 hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                    >
                        {saving ? "Saving..." : "Save"}
                    </button>
                    {state?.configured && !isServerConfigured && (
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
            </div>
        </form>
    );
}
