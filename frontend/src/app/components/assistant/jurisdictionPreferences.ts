import { useSyncExternalStore } from "react";

export const JURISDICTION_GROUPS = [
    {
        label: "Canada",
        tabLabel: "Canada",
        options: [
            ["ca-federal", "Federal", "Canada (federal)"],
            ["ca-ab", "Alberta", "Alberta, Canada"],
            ["ca-bc", "British Columbia", "British Columbia, Canada"],
            ["ca-mb", "Manitoba", "Manitoba, Canada"],
            ["ca-nb", "New Brunswick", "New Brunswick, Canada"],
            ["ca-nl", "Newfoundland and Labrador", "Newfoundland and Labrador, Canada"],
            ["ca-ns", "Nova Scotia", "Nova Scotia, Canada"],
            ["ca-on", "Ontario", "Ontario, Canada"],
            ["ca-pe", "Prince Edward Island", "Prince Edward Island, Canada"],
            ["ca-qc", "Quebec", "Quebec, Canada"],
            ["ca-sk", "Saskatchewan", "Saskatchewan, Canada"],
            ["ca-nt", "Northwest Territories", "Northwest Territories, Canada"],
            ["ca-nu", "Nunavut", "Nunavut, Canada"],
            ["ca-yt", "Yukon", "Yukon, Canada"],
        ],
    },
    {
        label: "United States",
        tabLabel: "US",
        options: [
            ["us-federal", "Federal", "United States (federal)"],
            ["us-al", "Alabama", "Alabama, United States"],
            ["us-ak", "Alaska", "Alaska, United States"],
            ["us-az", "Arizona", "Arizona, United States"],
            ["us-ar", "Arkansas", "Arkansas, United States"],
            ["us-ca", "California", "California, United States"],
            ["us-co", "Colorado", "Colorado, United States"],
            ["us-ct", "Connecticut", "Connecticut, United States"],
            ["us-de", "Delaware", "Delaware, United States"],
            ["us-dc", "District of Columbia", "District of Columbia, United States"],
            ["us-fl", "Florida", "Florida, United States"],
            ["us-ga", "Georgia", "Georgia, United States"],
            ["us-hi", "Hawaii", "Hawaii, United States"],
            ["us-id", "Idaho", "Idaho, United States"],
            ["us-il", "Illinois", "Illinois, United States"],
            ["us-in", "Indiana", "Indiana, United States"],
            ["us-ia", "Iowa", "Iowa, United States"],
            ["us-ks", "Kansas", "Kansas, United States"],
            ["us-ky", "Kentucky", "Kentucky, United States"],
            ["us-la", "Louisiana", "Louisiana, United States"],
            ["us-me", "Maine", "Maine, United States"],
            ["us-md", "Maryland", "Maryland, United States"],
            ["us-ma", "Massachusetts", "Massachusetts, United States"],
            ["us-mi", "Michigan", "Michigan, United States"],
            ["us-mn", "Minnesota", "Minnesota, United States"],
            ["us-ms", "Mississippi", "Mississippi, United States"],
            ["us-mo", "Missouri", "Missouri, United States"],
            ["us-mt", "Montana", "Montana, United States"],
            ["us-ne", "Nebraska", "Nebraska, United States"],
            ["us-nv", "Nevada", "Nevada, United States"],
            ["us-nh", "New Hampshire", "New Hampshire, United States"],
            ["us-nj", "New Jersey", "New Jersey, United States"],
            ["us-nm", "New Mexico", "New Mexico, United States"],
            ["us-ny", "New York", "New York, United States"],
            ["us-nc", "North Carolina", "North Carolina, United States"],
            ["us-nd", "North Dakota", "North Dakota, United States"],
            ["us-oh", "Ohio", "Ohio, United States"],
            ["us-ok", "Oklahoma", "Oklahoma, United States"],
            ["us-or", "Oregon", "Oregon, United States"],
            ["us-pa", "Pennsylvania", "Pennsylvania, United States"],
            ["us-ri", "Rhode Island", "Rhode Island, United States"],
            ["us-sc", "South Carolina", "South Carolina, United States"],
            ["us-sd", "South Dakota", "South Dakota, United States"],
            ["us-tn", "Tennessee", "Tennessee, United States"],
            ["us-tx", "Texas", "Texas, United States"],
            ["us-ut", "Utah", "Utah, United States"],
            ["us-vt", "Vermont", "Vermont, United States"],
            ["us-va", "Virginia", "Virginia, United States"],
            ["us-wa", "Washington", "Washington, United States"],
            ["us-wv", "West Virginia", "West Virginia, United States"],
            ["us-wi", "Wisconsin", "Wisconsin, United States"],
            ["us-wy", "Wyoming", "Wyoming, United States"],
        ],
    },
    {
        label: "United Kingdom",
        tabLabel: "UK",
        options: [
            ["uk", "United Kingdom", "United Kingdom"],
            ["uk-ew", "England and Wales", "England and Wales"],
            ["uk-sc", "Scotland", "Scotland, United Kingdom"],
            ["uk-ni", "Northern Ireland", "Northern Ireland, United Kingdom"],
        ],
    },
] as const;

type JurisdictionOption = {
    id: string;
    label: string;
    promptLabel: string;
};

export type JurisdictionPreference = {
    mode: "ask" | "presume";
    jurisdictions: string[];
    showChatControl: boolean;
};

const OPTIONS: JurisdictionOption[] = JURISDICTION_GROUPS.flatMap((group) =>
    group.options.map(([id, label, promptLabel]) => ({
        id,
        label,
        promptLabel,
    })),
);
const OPTION_BY_ID = new Map(OPTIONS.map((option) => [option.id, option]));
const DEFAULT_JURISDICTIONS = JURISDICTION_GROUPS[0].options.map(([id]) => id);
const DEFAULT_PREFERENCE: JurisdictionPreference = {
    mode: "presume",
    jurisdictions: DEFAULT_JURISDICTIONS,
    showChatControl: true,
};
const STORAGE_KEY = "mike.jurisdiction.preference";
const UPDATED_EVENT = "mike:jurisdiction-preference-updated";
let cachedRaw: string | null | undefined;
let cachedPreference = DEFAULT_PREFERENCE;

function normalizePreference(value: unknown): JurisdictionPreference {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return DEFAULT_PREFERENCE;
    }
    const row = value as Record<string, unknown>;
    const jurisdictions = Array.isArray(row.jurisdictions)
        ? [...new Set(
            row.jurisdictions.filter(
                (id): id is string =>
                    typeof id === "string" && OPTION_BY_ID.has(id),
            ),
        )]
        : [];
    return {
        mode: row.mode === "presume" ? "presume" : "ask",
        jurisdictions,
        showChatControl: row.showChatControl !== false,
    };
}

export function readJurisdictionPreference(): JurisdictionPreference {
    if (typeof window === "undefined") return DEFAULT_PREFERENCE;
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored === cachedRaw) return cachedPreference;
        cachedRaw = stored;
        cachedPreference = stored
            ? normalizePreference(JSON.parse(stored))
            : DEFAULT_PREFERENCE;
        return cachedPreference;
    } catch {
        return DEFAULT_PREFERENCE;
    }
}

export function setJurisdictionPreference(
    next:
        | JurisdictionPreference
        | ((current: JurisdictionPreference) => JurisdictionPreference),
) {
    if (typeof window === "undefined") return;
    const preference = normalizePreference(
        typeof next === "function"
            ? next(readJurisdictionPreference())
            : next,
    );
    const serialized = JSON.stringify(preference);
    cachedRaw = serialized;
    cachedPreference = preference;
    window.localStorage.setItem(STORAGE_KEY, serialized);
    window.dispatchEvent(new Event(UPDATED_EVENT));
}

function subscribe(handleUpdate: () => void) {
    if (typeof window === "undefined") return () => {};
    window.addEventListener("storage", handleUpdate);
    window.addEventListener(UPDATED_EVENT, handleUpdate);
    return () => {
        window.removeEventListener("storage", handleUpdate);
        window.removeEventListener(UPDATED_EVENT, handleUpdate);
    };
}

export function useJurisdictionPreference() {
    const preference = useSyncExternalStore(
        subscribe,
        readJurisdictionPreference,
        () => DEFAULT_PREFERENCE,
    );
    return { preference, setPreference: setJurisdictionPreference };
}

export function jurisdictionPreferenceForChat() {
    const preference = readJurisdictionPreference();
    const standing =
        preference.mode === "presume" &&
        preference.jurisdictions.length > 0;
    if (!standing) {
        return { mode: "ask" as const, jurisdictions: ["Canada"] };
    }
    return {
        mode: "presume" as const,
        jurisdictions: preference.jurisdictions.flatMap((id) => {
            const option = OPTION_BY_ID.get(id);
            return option ? [option.promptLabel] : [];
        }),
    };
}

export function jurisdictionPreferenceSummary(
    preference: JurisdictionPreference,
) {
    if (
        preference.mode !== "presume" ||
        preference.jurisdictions.length === 0
    ) {
        return "Ask when needed";
    }
    if (preference.jurisdictions.length === 1) {
        return OPTION_BY_ID.get(preference.jurisdictions[0])?.label ??
            "1 jurisdiction";
    }
    return `${preference.jurisdictions.length} jurisdictions`;
}
