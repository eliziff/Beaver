"use client";

import { useEffect, useState } from "react";
import { AccountSection } from "@/app/(pages)/account/AccountSection";
import { ModelPicker } from "@/app/components/assistant/ModelPicker";
import { ReasoningEffortToggle } from "@/app/components/assistant/ModelToggle";
import { useAssistantPreferences } from "@/app/components/assistant/assistantPreferences";
import {
    getSessionModelCatalog,
    preloadModelCatalog,
} from "@/app/lib/modelCatalog";
import type { ModelCatalog } from "@/app/lib/api/account";
import { Switch } from "@/app/components/ui/switch";
import { ModalSelect } from "@/app/components/modals/ModalSelect";

export function SubagentSettings() {
    const [preferences, savePreferences] = useAssistantPreferences();
    const preference = preferences.readSubagents;
    const update = (patch: Partial<typeof preference>) =>
        savePreferences({ readSubagents: { ...preference, ...patch } });
    const [catalog, setCatalog] = useState<ModelCatalog | null>(
        getSessionModelCatalog,
    );

    useEffect(() => {
        let active = true;
        void preloadModelCatalog().then((next) => {
            if (active) setCatalog(next);
        });
        return () => {
            active = false;
        };
    }, []);

    const capability = catalog?.readSubagents;
    const loading = !catalog;
    const models = (catalog?.models ?? [])
        .map((model) => ({
            id: `codex:${model.slug}`,
            label: model.displayName,
            group: "Codex" as const,
        }));
    const serverEnabled = capability?.serverEnabled !== false;

    return (
        <section aria-labelledby="reading-agents-heading">
            <h2
                id="reading-agents-heading"
                className="mb-1 text-base font-semibold text-gray-900"
            >
                Reading agents
            </h2>
            <p className="mb-4 max-w-2xl text-sm leading-6 text-gray-600">
                Delegate bounded source review when parallel research would materially help. Agents cannot edit files.
            </p>
            <AccountSection className="divide-y divide-gray-200 p-0">
                <label className="grid min-w-0 gap-2 px-4 py-3 text-sm text-gray-900 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-center">
                    <span className="font-medium">Agent mode</span>
                    <ModalSelect
                        id="reading-agent-mode" value={preference.mode} placeholder={null}
                        onChange={(mode) => update({ mode: mode as typeof preference.mode })}
                        options={[
                            { value: "none", label: "None" },
                            { value: "beaver", label: "Beaver" },
                            { value: "native", label: "Native Codex" },
                        ]} />
                </label>
                <div className="grid min-w-0 gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-end">
                    <div className="min-w-0">
                        <p className="mb-1 text-xs font-medium text-gray-600">
                            Model
                        </p>
                        <ModelPicker
                            value={preference.model}
                            models={models}
                            onChange={(model) => update({ model })}
                            disabled={loading || !serverEnabled}
                        />
                    </div>
                    <ReasoningEffortToggle
                        model={preference.model}
                        value={preference.effort}
                        onChange={(effort) => update({ effort })}
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
                <p
                    id="reading-agents-consequence"
                    className="px-4 py-3 text-xs leading-5 text-gray-500"
                >
                    Beaver runs use the model and effort above and appear in chat
                    activity. Native runs are managed by Codex.
                </p>
            </AccountSection>
        </section>
    );
}
