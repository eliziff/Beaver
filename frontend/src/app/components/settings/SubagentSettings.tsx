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
    const selectedModel = catalog?.models.find(
        (model) => `codex:${model.slug}` === preference.model,
    );
    const selectionAvailable = selectedModel?.supportedReasoningLevels.some(
        (level) => level.effort === preference.effort,
    );
    const serverEnabled = capability?.serverEnabled !== false;
    const available = serverEnabled && selectionAvailable === true;
    const disabled = loading || !available;

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
                <label
                    className={`flex min-h-16 items-center justify-between gap-5 px-4 py-3 ${
                        disabled ? "cursor-not-allowed" : "cursor-pointer"
                    }`}
                >
                    <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-900">
                            Let Assistant use reading agents
                        </span>
                        <span
                            className="mt-0.5 block text-xs leading-5 text-gray-500"
                            aria-live="polite"
                        >
                            {loading
                                ? "Checking available models..."
                                : available
                                  ? "Available for new messages"
                                  : !serverEnabled
                                    ? capability?.reason
                                    : "Choose an available model and effort."}
                        </span>
                    </span>
                    <span className="relative grid h-11 w-12 shrink-0 place-items-center">
                        <input
                            type="checkbox"
                            role="switch"
                            checked={preference.enabled}
                            disabled={disabled}
                            onChange={(event) =>
                                preference.setEnabled(event.currentTarget.checked)
                            }
                            className="peer sr-only"
                            aria-describedby="reading-agents-consequence"
                        />
                        <span className="h-6 w-10 rounded-full bg-gray-300 transition-colors peer-checked:bg-gray-900 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-gray-900 peer-disabled:bg-gray-200" />
                        <span className="pointer-events-none absolute left-2 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4 peer-disabled:bg-gray-50" />
                    </span>
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
                            Keep up to three runs in the side gutter when space
                            allows.
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
                    Each delegated task starts another model run. Findings must
                    pass exact-passage grounding; the main Assistant verifies
                    controlling text before relying on them. Completed results
                    are also recorded in the chat activity.
                </p>
            </AccountSection>
        </section>
    );
}
