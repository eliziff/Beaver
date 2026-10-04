import { useSyncExternalStore } from "react";

type JurisdictionOption = readonly [id: string, label: string, promptLabel: string];
type JurisdictionGroup = { label: string; tabLabel: string; options: JurisdictionOption[] };

const regionOptions = (
    prefix: string,
    country: string,
    entries: readonly (readonly [code: string, label: string])[],
): JurisdictionOption[] => entries.map(([code, label]) => [
    `${prefix}-${code}`,
    label,
    code === "federal" ? `${country} (federal)` : `${label}, ${country}`,
]);

export const JURISDICTION_GROUPS: JurisdictionGroup[] = [
    { label: "Canada", tabLabel: "Canada", options: regionOptions("ca", "Canada", [
        ["federal", "Federal"], ["ab", "Alberta"], ["bc", "British Columbia"],
        ["mb", "Manitoba"], ["nb", "New Brunswick"], ["nl", "Newfoundland and Labrador"],
        ["ns", "Nova Scotia"], ["on", "Ontario"], ["pe", "Prince Edward Island"],
        ["qc", "Quebec"], ["sk", "Saskatchewan"], ["nt", "Northwest Territories"],
        ["nu", "Nunavut"], ["yt", "Yukon"],
    ]) },
    { label: "United States", tabLabel: "US", options: regionOptions("us", "United States", [
        ["federal", "Federal"], ["al", "Alabama"], ["ak", "Alaska"], ["az", "Arizona"],
        ["ar", "Arkansas"], ["ca", "California"], ["co", "Colorado"], ["ct", "Connecticut"],
        ["de", "Delaware"], ["dc", "District of Columbia"], ["fl", "Florida"], ["ga", "Georgia"],
        ["hi", "Hawaii"], ["id", "Idaho"], ["il", "Illinois"], ["in", "Indiana"],
        ["ia", "Iowa"], ["ks", "Kansas"], ["ky", "Kentucky"], ["la", "Louisiana"],
        ["me", "Maine"], ["md", "Maryland"], ["ma", "Massachusetts"], ["mi", "Michigan"],
        ["mn", "Minnesota"], ["ms", "Mississippi"], ["mo", "Missouri"], ["mt", "Montana"],
        ["ne", "Nebraska"], ["nv", "Nevada"], ["nh", "New Hampshire"], ["nj", "New Jersey"],
        ["nm", "New Mexico"], ["ny", "New York"], ["nc", "North Carolina"], ["nd", "North Dakota"],
        ["oh", "Ohio"], ["ok", "Oklahoma"], ["or", "Oregon"], ["pa", "Pennsylvania"],
        ["ri", "Rhode Island"], ["sc", "South Carolina"], ["sd", "South Dakota"], ["tn", "Tennessee"],
        ["tx", "Texas"], ["ut", "Utah"], ["vt", "Vermont"], ["va", "Virginia"],
        ["wa", "Washington"], ["wv", "West Virginia"], ["wi", "Wisconsin"], ["wy", "Wyoming"],
    ]) },
    { label: "United Kingdom", tabLabel: "UK", options: [
        ["uk", "United Kingdom", "United Kingdom"],
        ["uk-ew", "England and Wales", "England and Wales"],
        ["uk-sc", "Scotland", "Scotland, United Kingdom"],
        ["uk-ni", "Northern Ireland", "Northern Ireland, United Kingdom"],
    ] },
];

const jurisdictionOptions = JURISDICTION_GROUPS.flatMap((group) => group.options);
const jurisdictionById = new Map(jurisdictionOptions.map((option) => [option[0], option]));
const DEFAULT_READ_SUBAGENT_MODEL = "codex:gpt-5.6-luna";
const DEFAULT_READ_SUBAGENT_EFFORT = "high";

export type AssistantPreferences = {
    activityDetail: "auto" | "standard" | "tools" | "trace";
    showContextUsage: boolean;
    showAutoMode: boolean;
    editMode: "manual" | "auto";
    /** Providers hidden from every model picker. */
    disabledProviders: string[];
    readSubagents: { enabled: boolean; showDock: boolean;
        model: string; effort: string };
};
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
function parsePreferences(value: unknown): AssistantPreferences | null {
    if (!record(value) || !record(value.readSubagents) ||
        typeof value.activityDetail !== "string" ||
        !["auto", "standard", "tools", "trace"].includes(value.activityDetail) ||
        typeof value.editMode !== "string" || !["manual", "auto"].includes(value.editMode) ||
        typeof value.showContextUsage !== "boolean" || typeof value.showAutoMode !== "boolean" ||
        typeof value.readSubagents.enabled !== "boolean" ||
        typeof value.readSubagents.showDock !== "boolean" ||
        typeof value.readSubagents.model !== "string" ||
        typeof value.readSubagents.effort !== "string") return null;
    const disabledProviders = value.disabledProviders ?? [];
    if (!Array.isArray(disabledProviders) ||
        !disabledProviders.every((provider) => typeof provider === "string")) {
        return null;
    }
    return { ...value, disabledProviders } as AssistantPreferences;
}
const DEFAULTS: AssistantPreferences = {
    activityDetail: "auto", showContextUsage: true, showAutoMode: false, editMode: "manual",
    disabledProviders: [],
    readSubagents: { enabled: false, showDock: true, model: DEFAULT_READ_SUBAGENT_MODEL, effort: DEFAULT_READ_SUBAGENT_EFFORT },
};
const STORAGE_KEY = "beaver.assistant.preferences";
const UPDATED_EVENT = "beaver:assistant-preferences";
let cache: { raw: string | null; value: AssistantPreferences } = { raw: null, value: DEFAULTS };

export function readAssistantPreferences(): AssistantPreferences {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === cache.raw) return cache.value;
    try {
        cache = { raw, value: parsePreferences(raw ? JSON.parse(raw) : DEFAULTS) ?? DEFAULTS };
    } catch { cache = { raw, value: DEFAULTS }; }
    return cache.value;
}

export function updateAssistantPreferences(
    update: Partial<AssistantPreferences> | ((current: AssistantPreferences) => AssistantPreferences),
) {
    const current = readAssistantPreferences();
    const candidate = typeof update === "function" ? update(current) : { ...current, ...update };
    const raw = JSON.stringify(candidate);
    cache = { raw, value: candidate };
    window.localStorage.setItem(STORAGE_KEY, raw);
    window.dispatchEvent(new Event(UPDATED_EVENT));
}

function subscribe(update: () => void) {
    window.addEventListener("storage", update);
    window.addEventListener(UPDATED_EVENT, update);
    return () => {
        window.removeEventListener("storage", update);
        window.removeEventListener(UPDATED_EVENT, update);
    };
}

export function useAssistantPreferences() {
    const preferences = useSyncExternalStore(subscribe, readAssistantPreferences, () => DEFAULTS);
    return [preferences, updateAssistantPreferences] as const;
}

export type { JurisdictionPreference } from "../../../../../shared/user-preferences.mjs";
import type { JurisdictionPreference } from "../../../../../shared/user-preferences.mjs";

export function jurisdictionPreferenceForChat(preference: JurisdictionPreference) {
    if (preference.mode !== "presume" || preference.jurisdictions.length === 0) {
        return { mode: "ask" as const, jurisdictions: ["Canada"] };
    }
    return {
        mode: "presume" as const,
        jurisdictions: preference.jurisdictions.flatMap((id) => jurisdictionById.get(id)?.[2] ?? []),
    };
}
