"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
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
    const [countryIndex, setCountryIndex] = useState(0);
    const countryTabRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const { preference, setPreference } = useJurisdictionPreference();
    const selected = new Set(preference.jurisdictions);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const disabled = preference.mode !== "presume";
    const activeGroup = JURISDICTION_GROUPS[countryIndex];
    const options = activeGroup.options.filter(([, label, promptLabel]) =>
            !normalizedQuery ||
            `${label} ${promptLabel}`.toLocaleLowerCase().includes(normalizedQuery),
        );
    const selectCountry = (index: number) => {
        const next = (index + JURISDICTION_GROUPS.length) % JURISDICTION_GROUPS.length;
        setCountryIndex(next);
        setQuery("");
        countryTabRefs.current[next]?.focus();
    };
    const handleCountryKeyDown = (
        event: KeyboardEvent<HTMLButtonElement>,
        index: number,
    ) => {
        if (event.key === "ArrowRight") selectCountry(index + 1);
        else if (event.key === "ArrowLeft") selectCountry(index - 1);
        else if (event.key === "Home") selectCountry(0);
        else if (event.key === "End") selectCountry(JURISDICTION_GROUPS.length - 1);
        else return;
        event.preventDefault();
    };
    const allSelected = (group: (typeof JURISDICTION_GROUPS)[number]) =>
        group.options.every(([optionId]) => selected.has(optionId));
    const setAllSelected = (
        group: (typeof JURISDICTION_GROUPS)[number],
        checked: boolean,
    ) => {
        const next = new Set(preference.jurisdictions);
        for (const [optionId] of group.options) {
            if (checked) next.add(optionId);
            else next.delete(optionId);
        }
        setPreference({ ...preference, jurisdictions: [...next] });
    };

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
                <div
                    role="tablist"
                    aria-label="Countries"
                    className="mb-3 grid grid-cols-3 gap-1 rounded-lg bg-gray-100 p-1"
                >
                    {JURISDICTION_GROUPS.map((group, index) => {
                        const active = index === countryIndex;
                        return (
                            <button
                                key={group.label}
                                ref={(node) => {
                                    countryTabRefs.current[index] = node;
                                }}
                                type="button"
                                role="tab"
                                id={`${id}-country-tab-${index}`}
                                aria-selected={active}
                                aria-controls={`${id}-country-panel`}
                                tabIndex={active ? 0 : -1}
                                onClick={() => selectCountry(index)}
                                onKeyDown={(event) =>
                                    handleCountryKeyDown(event, index)
                                }
                                className={cn(
                                    "min-h-10 min-w-0 truncate rounded-md border px-2 text-sm font-medium hover:text-gray-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900",
                                    active
                                        ? "border-gray-300 bg-white text-gray-950 shadow-sm"
                                        : "border-transparent text-gray-600 hover:text-gray-950",
                                )}
                            >
                                {group.tabLabel}
                            </button>
                        );
                    })}
                </div>
                <div
                    role="tabpanel"
                    id={`${id}-country-panel`}
                    aria-labelledby={`${id}-country-tab-${countryIndex}`}
                >
                <label className="mb-3 flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-gray-800 hover:bg-gray-100">
                    <CheckboxInput
                        role="switch"
                        checked={allSelected(activeGroup)}
                        disabled={disabled}
                        onChange={(event) =>
                            setAllSelected(
                                activeGroup,
                                event.currentTarget.checked,
                            )
                        }
                    />
                    <span>All of {activeGroup.tabLabel}</span>
                </label>
                <label
                    htmlFor={`${id}-search`}
                    className="mb-1.5 block text-sm font-medium text-gray-700"
                >
                    Find a jurisdiction
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
                    {options.length ? (
                            <fieldset className="p-2">
                                <legend className="sr-only">
                                    {activeGroup.label} jurisdictions
                                </legend>
                                <div className="grid gap-0.5">
                                    {options.map(([optionId, label]) => (
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
                    ) : (
                        <p className="px-3 py-4 text-sm text-gray-500">
                            No matching jurisdictions.
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
                            Keep a side panel available for changing this preference.
                        </span>
                    </span>
                </label>
            )}
        </div>
    );
}
