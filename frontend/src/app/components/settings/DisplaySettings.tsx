"use client";

import { AccountToggle } from "@/app/(pages)/account/AccountToggle";
import { useAssistantPreferences } from "@/app/components/assistant/assistantPreferences";

export function DisplaySettings() {
    const [preferences, savePreferences] = useAssistantPreferences();
    return (
        <div className="flex items-center justify-between gap-4">
            <div>
                <p className="text-sm font-medium text-gray-900">Context usage</p>
                <p className="mt-0.5 text-xs leading-5 text-gray-500">
                    Show the context window meter below the message field.
                </p>
            </div>
            <AccountToggle
                checked={preferences.showContextUsage}
                onChange={(showContextUsage) => savePreferences({ showContextUsage })}
                size="md"
                ariaLabel="Show context usage"
            />
        </div>
    );
}
