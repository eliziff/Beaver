"use client";

import { useId, useState } from "react";
import { CheckboxInput } from "@/app/components/ui/checkbox";
import {
    JURISDICTION_GROUPS,
    useJurisdictionPreference,
} from "@/app/components/assistant/jurisdictionPreferences";
import { cn } from "@/app/lib/utils";

export function JurisdictionPreferenceEditor({
    compact = false,
    showPanelControl = true,
}: {
    compact?: boolean;
    showPanelControl?: boolean;
}) {
    const id = useId();
    const [query, setQuery] = useState("");
    const { preference, setPreference } = useJurisdictionPreference();
    const selected = new Set(preference.jurisdictions);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const disabled = preference.mode !== "presume";
    const groups = JURISDICTION_GROUPS.map((group) => ({
        ...group,
        options: group.options.filter(([, label, promptLabel]) =>
            !normalizedQuery ||
            `${label} ${promptLabel}`.toLocaleLowerCase().includes(normalizedQuery),
        ),
    })).filter((group) => group.options.length > 0);

    return (
        <div className={cn("min-w-0", compact ? "space-y-3" : "space-y-4")}>
            <fieldset className="grid gap-2">
                <legend className="sr-only">Default jurisdiction</legend>
                <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-gray-200 px-3 py-2.5 has-[:checked]:border-gray-400 has-[:checked]:bg-gray-50">
                    <input
                        id={`${id}-ask`}
                        type="radio"
                        name={`${id}-mode`}
                        checked={preference.mode === "ask"}
                        onChange={() =>
                            setPreference({ ...preference, mode: "ask" })
                        }
                        className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-red-700"
                    />
                    <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-900">
                            Ask when needed
                        </span>
                        <span className="mt-0.5 block text-sm leading-5 text-gray-500">
                            Use no standing default.
                        </span>
                    </span>
                </label>
                <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-gray-200 px-3 py-2.5 has-[:checked]:border-gray-400 has-[:checked]:bg-gray-50">
                    <input
                        id={`${id}-presume`}
                        type="radio"
                        name={`${id}-mode`}
                        checked={preference.mode === "presume"}
                        onChange={() =>
                            setPreference({ ...preference, mode: "presume" })
                        }
                        className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-red-700"
                    />
                    <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-900">
                            Use selected jurisdictions
                        </span>
                        <span className="mt-0.5 block text-sm leading-5 text-gray-500">
                            Presume these only when your request does not say otherwise.
                        </span>
                    </span>
                </label>
            </fieldset>

            <div
                aria-disabled={disabled}
                className={cn(disabled && "opacity-50")}
            >
                <label
                    htmlFor={`${id}-search`}
                    className="mb-1.5 block text-sm font-medium text-gray-700"
                >
                    Find a province or state
                </label>
                <input
                    id={`${id}-search`}
                    type="search"
                    value={query}
                    disabled={disabled}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    placeholder="Search jurisdictions"
                    className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-500 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-1 disabled:cursor-default"
                />
                <div
                    className={cn(
                        "mt-2 overflow-y-auto rounded-md border border-gray-200 [scrollbar-gutter:stable]",
                        compact ? "max-h-44" : "max-h-64",
                    )}
                >
                    {groups.length ? (
                        groups.map((group) => (
                            <fieldset
                                key={group.label}
                                className="border-b border-gray-200 p-2 last:border-b-0"
                            >
                                <legend className="px-1 text-xs font-medium text-gray-500">
                                    {group.label}
                                </legend>
                                <div className="mt-1 grid gap-0.5">
                                    {group.options.map(([optionId, label]) => (
                                        <label
                                            key={optionId}
                                            className="flex min-h-10 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-800 hover:bg-gray-100"
                                        >
                                            <CheckboxInput
                                                id={`${id}-${optionId}`}
                                                checked={selected.has(optionId)}
                                                disabled={disabled}
                                                onChange={(event) => {
                                                    const next = new Set(
                                                        preference.jurisdictions,
                                                    );
                                                    if (event.currentTarget.checked) {
                                                        next.add(optionId);
                                                    } else {
                                                        next.delete(optionId);
                                                    }
                                                    setPreference({
                                                        ...preference,
                                                        jurisdictions: [...next],
                                                    });
                                                }}
                                            />
                                            <span className="min-w-0 break-words">
                                                {label}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </fieldset>
                        ))
                    ) : (
                        <p className="px-3 py-4 text-sm text-gray-500">
                            No matching province or state.
                        </p>
                    )}
                </div>
                <p
                    className="mt-1.5 min-h-5 text-xs text-gray-500"
                    aria-live="polite"
                >
                    {preference.mode === "ask"
                        ? preference.jurisdictions.length
                            ? `${preference.jurisdictions.length} saved for later`
                            : "No standing jurisdiction"
                        : preference.jurisdictions.length === 0
                          ? "Select at least one jurisdiction or choose Ask when needed."
                          : `${preference.jurisdictions.length} selected`}
                </p>
            </div>

            {showPanelControl && (
                <label className="flex min-h-10 cursor-pointer items-start gap-3 border-t border-gray-200 pt-3">
                    <CheckboxInput
                        checked={preference.showAssistantPanel}
                        onChange={(event) =>
                            setPreference({
                                ...preference,
                                showAssistantPanel: event.currentTarget.checked,
                            })
                        }
                        className="mt-0.5"
                    />
                    <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-900">
                            Show in Assistant
                        </span>
                        <span className="mt-0.5 block text-sm leading-5 text-gray-500">
                            Keep a floating panel available for changing this preference.
                        </span>
                    </span>
                </label>
            )}
        </div>
    );
}
