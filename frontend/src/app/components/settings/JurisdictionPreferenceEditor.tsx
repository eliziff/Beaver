"use client";

import { useId, useState } from "react";
import { CheckboxInput } from "@/app/components/ui/checkbox";
import { Tabs } from "@/app/components/ui/tabs";
import {
    JURISDICTION_GROUPS,
} from "@/app/components/assistant/assistantPreferences";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { cn } from "@/app/lib/utils";

const MODES = [
    { value: "ask" as const, title: "Ask when needed", detail: "Use no standing default." },
    { value: "presume" as const, title: "Use selected jurisdictions",
        detail: "Presume these only when your request does not say otherwise." },
];

export function JurisdictionPreferenceEditor({
    compact = false,
}: {
    compact?: boolean;
}) {
    const id = useId();
    const [query, setQuery] = useState("");
    const [countryIndex, setCountryIndex] = useState(0);
    const { profile, updateProfile } = useUserProfile();
    const preference = profile?.jurisdictionPreference ?? {
        mode: "ask" as const, jurisdictions: [],
    };
    const setPreference = (jurisdiction: typeof preference) =>
        void updateProfile({ jurisdictionPreference: jurisdiction });
    const selected = new Set(preference.jurisdictions);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const disabled = preference.mode !== "presume";
    const activeGroup = JURISDICTION_GROUPS[countryIndex];
    const options = activeGroup.options.filter(([, label, promptLabel]) =>
            !normalizedQuery ||
            `${label} ${promptLabel}`.toLocaleLowerCase().includes(normalizedQuery),
        );
    const allSelected = (group: (typeof JURISDICTION_GROUPS)[number]) =>
        group.options.every(([optionId]) => selected.has(optionId));
    const toggle = (ids: typeof preference.jurisdictions, checked: boolean) => {
        const next = new Set(preference.jurisdictions);
        for (const optionId of ids) {
            if (checked) next.add(optionId);
            else next.delete(optionId);
        }
        setPreference({ ...preference, jurisdictions: [...next] });
    };

    return (
        <div className={cn("min-w-0", compact ? "space-y-3" : "space-y-4")}>
            <fieldset className="grid gap-2">
                <legend className="sr-only">Default jurisdiction</legend>
                {MODES.map((mode) => (
                    <label key={mode.value} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-gray-200 px-3 py-2.5 has-[:checked]:border-gray-400 has-[:checked]:bg-gray-50">
                        <input
                            id={`${id}-${mode.value}`}
                            type="radio"
                            name={`${id}-mode`}
                            checked={preference.mode === mode.value}
                            onChange={() =>
                                setPreference({ ...preference, mode: mode.value })
                            }
                            className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-red-700"
                        />
                        <span className="min-w-0">
                            <span className="block text-sm font-medium text-gray-900">
                                {mode.title}
                            </span>
                            <span className="mt-0.5 block text-sm leading-5 text-gray-500">
                                {mode.detail}
                            </span>
                        </span>
                    </label>
                ))}
            </fieldset>

            <div
                aria-disabled={disabled}
                className={cn(disabled && "opacity-50")}
            >
                <Tabs value={String(countryIndex)}
                    onValueChange={(value) => { setCountryIndex(Number(value)); setQuery(""); }}
                    options={JURISDICTION_GROUPS.map((group, index) => ({
                        value: String(index), label: group.tabLabel,
                    }))} ariaLabel="Countries">
                <div className="pt-3">
                <label className="mb-3 flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-gray-800 hover:bg-gray-100">
                    <CheckboxInput
                        checked={allSelected(activeGroup)}
                        disabled={disabled}
                        onChange={(event) => toggle(
                            activeGroup.options.map(([optionId]) => optionId),
                            event.currentTarget.checked,
                        )}
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
                    type="search" autoComplete="off"
                    value={query}
                    disabled={disabled}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    placeholder="Search jurisdictions"
                    className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-500 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-1 disabled:cursor-default"
                />
                <div
                    className="mt-2 rounded-md border border-gray-200"
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
                                                onChange={(event) =>
                                                    toggle([optionId], event.currentTarget.checked)
                                                }
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
                </Tabs>
            </div>
        </div>
    );
}
