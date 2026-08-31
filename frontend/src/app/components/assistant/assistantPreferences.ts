import { useSyncExternalStore } from "react";

export const QUICK_ACTIONS = [
    { id: "proofread", label: "Proofread" },
    { id: "compareDocuments", label: "Compare documents" },
    { id: "extractKeyTerms", label: "Extract key terms" },
    { id: "draftFromTemplate", label: "Draft from template" },
    { id: "newProject", label: "New project" },
    { id: "newTabularReview", label: "New tabular review" },
    { id: "projectChat", label: "Start chat in project" },
] as const;
export type QuickActionId = (typeof QUICK_ACTIONS)[number]["id"];
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
const quickActionDefaults = Object.fromEntries(QUICK_ACTIONS.map(({ id }) => [id, !["newProject", "newTabularReview"].includes(id)])) as Record<QuickActionId, boolean>;
const DEFAULT_READ_SUBAGENT_MODEL = "codex:gpt-5.6-luna";
const DEFAULT_READ_SUBAGENT_EFFORT = "high";

export type AssistantPreferences = {
    activityDetail: "auto" | "standard" | "tools" | "trace";
    showContextUsage: boolean;
    showAutoMode: boolean;
    editMode: "manual" | "auto";
    quickActions: Record<QuickActionId, boolean>;
    readSubagents: { mode: "none" | "beaver" | "native"; showDock: boolean;
        model: string; effort: string };
};
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(value).length === keys.length && keys.every((key) => key in value);
function parsePreferences(value: unknown): AssistantPreferences | null {
    if (!record(value) || !record(value.quickActions) || !record(value.readSubagents) ||
        !exact(value, ["activityDetail", "showContextUsage", "showAutoMode", "editMode", "quickActions", "readSubagents"]) ||
        !exact(value.quickActions, QUICK_ACTIONS.map(({ id }) => id)) ||
        !exact(value.readSubagents, ["mode", "showDock", "model", "effort"]) ||
        !["auto", "standard", "tools", "trace"].includes(String(value.activityDetail)) ||
        !["manual", "auto"].includes(String(value.editMode)) ||
        typeof value.showContextUsage !== "boolean" || typeof value.showAutoMode !== "boolean" ||
        !Object.values(value.quickActions).every((item) => typeof item === "boolean") ||
        !["none", "beaver", "native"].includes(String(value.readSubagents.mode)) ||
        typeof value.readSubagents.showDock !== "boolean" ||
        typeof value.readSubagents.model !== "string" || value.readSubagents.model.length > 200 ||
        typeof value.readSubagents.effort !== "string" || value.readSubagents.effort.length > 100) return null;
    return value as AssistantPreferences;
}
const DEFAULTS: AssistantPreferences = {
    activityDetail: "auto", showContextUsage: true, showAutoMode: false, editMode: "manual",
    quickActions: quickActionDefaults,
    readSubagents: { mode: "none", showDock: true, model: DEFAULT_READ_SUBAGENT_MODEL, effort: DEFAULT_READ_SUBAGENT_EFFORT },
};
const STORAGE_KEY = "beaver.assistant.preferences";
const UPDATED_EVENT = "beaver:assistant-preferences";
let cache: { raw: string | null; value: AssistantPreferences } = { raw: null, value: DEFAULTS };

export function readAssistantPreferences(): AssistantPreferences {
    if (typeof window === "undefined") return DEFAULTS;
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
    if (typeof window === "undefined") return;
    const current = readAssistantPreferences();
    const candidate = typeof update === "function" ? update(current) : { ...current, ...update };
    const parsed = parsePreferences(candidate);
    if (!parsed) return;
    const raw = JSON.stringify(parsed);
    cache = { raw, value: parsed };
    window.localStorage.setItem(STORAGE_KEY, raw);
    window.dispatchEvent(new Event(UPDATED_EVENT));
}

function subscribe(update: () => void) {
    if (typeof window === "undefined") return () => {};
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

export type JurisdictionPreference = {
    mode: "ask" | "presume";
    jurisdictions: string[];
};

export function jurisdictionPreferenceForChat(preference: JurisdictionPreference) {
    if (preference.mode !== "presume" || preference.jurisdictions.length === 0) {
        return { mode: "ask" as const, jurisdictions: ["Canada"] };
    }
    return {
        mode: "presume" as const,
        jurisdictions: preference.jurisdictions.flatMap((id) => jurisdictionById.get(id)?.[2] ?? []),
    };
}
