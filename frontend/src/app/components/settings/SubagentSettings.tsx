"use client";

import { useEffect } from "react";
import { AccountSection } from "@/app/(pages)/account/AccountSection";
import { ModelEffortToggle } from "@/app/components/assistant/ModelToggle";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useAssistantPreferences } from "@/app/components/assistant/assistantPreferences";
import {
    useModelCatalog,
    preloadModelCatalog,
} from "@/app/lib/modelCatalog";
import { Switch } from "@/app/components/ui/switch";

export function SubagentSettings() {
    const [preferences, savePreferences] = useAssistantPreferences();
    const preference = preferences.readSubagents;
    const update = (patch: Partial<typeof preference>) =>
        savePreferences({ readSubagents: { ...preference, ...patch } });
    const catalog = useModelCatalog(), { profile } = useUserProfile();
    useEffect(() => { void preloadModelCatalog(); }, []);

    const loading = !catalog;
    const serverEnabled = catalog?.readSubagents?.serverEnabled !== false;

    return (
        <section aria-labelledby="subagents-heading">
            <h2
                id="subagents-heading"
                className="mb-1 text-base font-semibold text-gray-900"
            >
                Subagents
            </h2>
            <p className="mb-4 max-w-2xl text-sm leading-6 text-gray-600">
                Delegate bounded source review when parallel research would materially help. Subagents cannot edit files.
            </p>
            <AccountSection className="divide-y divide-gray-200 p-0">
                <label className="flex min-h-16 cursor-pointer items-center justify-between gap-5 px-4 py-3">
                    <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-900">
                            Subagents
                        </span>
                    </span>
                    <span className="relative grid h-11 w-12 shrink-0 place-items-center">
                        <Switch checked={preference.enabled} size="lg"
                            disabled={!serverEnabled} ariaLabel="Subagents"
                            onChange={(on) => update({ enabled: on })} />
                    </span>
                </label>
                <div className="min-w-0 px-4 py-3">
                    <p className="mb-1 text-xs font-medium text-gray-600">
                        Model and effort
                    </p>
                    <ModelEffortToggle
                        model={preference.model}
                        effort={preference.effort}
                        onModelChange={(model) => update({ model })}
                        onEffortChange={(effort) => update({ effort })}
                        apiKeys={profile?.apiKeys}
                        includeSettingsModels
                        disabled={loading || !serverEnabled}
                    />
                </div>
                <label className="flex min-h-16 cursor-pointer items-center justify-between gap-5 px-4 py-3">
                    <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-900">
                            Show runs in dock
                        </span>
                        <span className="mt-0.5 block text-xs leading-5 text-gray-500">
                            Keep recent runs in the side gutter when space allows.
                        </span>
                    </span>
                    <span className="relative grid h-11 w-12 shrink-0 place-items-center">
                        <Switch checked={preference.showDock} size="lg" tone="dock"
                            onChange={(showDock) => update({ showDock })} />
                    </span>
                </label>
            </AccountSection>
        </section>
    );
}
