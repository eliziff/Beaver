"use client";

import { useEffect, useState } from "react";
import { AccountSection } from "@/app/(pages)/account/AccountSection";
import { ModelPicker } from "@/app/components/assistant/ModelPicker";
import { ReasoningEffortToggle } from "@/app/components/assistant/ModelToggle";
import { useReadSubagentPreference } from "@/app/components/assistant/readSubagentPreferences";
import {
    getSessionModelCatalog,
    preloadModelCatalog,
} from "@/app/lib/modelCatalog";
import type { ModelCatalog } from "@/app/lib/beaverApi";

export function SubagentSettings() {
    const preference = useReadSubagentPreference();
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
        .filter((model) => model.supportedInApi !== false)
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
                    <select
                        value={preference.mode}
                        onChange={(event) =>
                            preference.setMode(
                                event.currentTarget.value as typeof preference.mode,
                            )
                        }
                        className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                    >
                        <option value="none">None</option>
                        <option value="beaver">Beaver</option>
                        <option value="native">Native Codex</option>
                    </select>
                </label>
                <div className="grid min-w-0 gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-end">
                    <div className="min-w-0">
                        <p className="mb-1 text-xs font-medium text-gray-600">
                            Model
                        </p>
                        <ModelPicker
                            value={preference.model}
                            models={models}
                            onChange={preference.setModel}
                            disabled={loading || !serverEnabled}
                        />
                    </div>
                    <ReasoningEffortToggle
                        model={preference.model}
                        value={preference.effort}
                        onChange={preference.setEffort}
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
                        <input
                            type="checkbox"
                            role="switch"
                            checked={preference.showDock}
                            onChange={(event) =>
                                preference.setShowDock(event.currentTarget.checked)
                            }
                            className="peer sr-only"
                        />
                        <span className="h-6 w-10 rounded-full bg-gray-300 transition-colors peer-checked:bg-gray-900 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-gray-900" />
                        <span className="pointer-events-none absolute left-2 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
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
