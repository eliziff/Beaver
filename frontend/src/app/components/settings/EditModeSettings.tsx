"use client";

import { useAssistantPreferences } from "@/app/components/assistant/assistantPreferences";
import { AccountToggle } from "@/app/(pages)/account/AccountToggle";

export function EditModeSettings() {
    const [preferences, savePreferences] = useAssistantPreferences();
    return (
        <div className="flex items-center justify-between gap-4">
            <div>
                <p className="text-sm font-medium text-gray-900">
                    Enable Auto mode
                </p>
                <p className="mt-0.5 text-xs leading-5 text-gray-500">
                    Adds Auto to the chat editing control. Manual remains the
                    default.
                </p>
            </div>
            <AccountToggle
                checked={preferences.showAutoMode}
                onChange={(showAutoMode) => savePreferences({ showAutoMode })}
                size="md"
                ariaLabel="Enable Auto mode"
            />
        </div>
    );
}
