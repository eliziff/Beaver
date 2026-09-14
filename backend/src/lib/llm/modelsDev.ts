import { createCatalogCache, fetchCatalogJson } from "../catalogCache";
import {
    pickerModel,
    providerForModel,
    registerCatalogModels,
    staticPickerModels,
    type PickerModel,
} from "./models";
import type { Provider } from "./types";

// Runtime source for the first-party cloud catalogue. The pinned seed in
// `models.ts` stays authoritative for flags and hand-tuned defaults; this
// overlay widens the picker and routing with newly published ids.
//
// The bare Meta ids need a credential this deployment does not hold, and
// OpenRouter has its own live source (`openRouter.ts`), so neither is overlaid
// here.
const FIRST_PARTY_PROVIDERS = [
    { key: "anthropic", group: "Anthropic" },
    { key: "google", group: "Google" },
    { key: "openai", group: "OpenAI" },
    { key: "deepseek", group: "DeepSeek" },
] as const;

const FIRST_PARTY_GROUPS = new Set<string>(FIRST_PARTY_PROVIDERS.map(({ group }) => group));

// Aggregator lanes have no reasoning metadata of their own; models.dev does, so
// these providers seed the OpenCode Go and OpenRouter effort controls.
const REASONING_PROVIDERS = [
    "anthropic", "google", "openai", "deepseek", "opencode", "opencode-go", "openrouter",
] as const;

const DEFAULT_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MODELS_DEV_CATALOG_SOURCE = "models.dev";

type ModelsDevModel = {
    id?: unknown;
    name?: unknown;
    family?: unknown;
    tool_call?: unknown;
    modalities?: { input?: unknown; output?: unknown };
    limit?: { context?: unknown };
    reasoning_options?: unknown;
    release_date?: unknown;
};

type CatalogMetadata = { id: string; contextWindow?: number; imageInput?: boolean };
type CloudEntry = PickerModel & { nameKey: string; releasedAt?: number; pinned?: boolean };
export type ModelsDevCatalog = { source: "live" | "unavailable"; models: PickerModel[] };

function modelsDevUrl(): string {
    const url = new URL(process.env.MODELS_DEV_URL?.trim() || "https://models.dev/api.json");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("models.dev requires an HTTP(S) endpoint without URL credentials.");
    }
    return url.toString();
}

function modelsDevModelsUrl(): string {
    const url = new URL(process.env.MODELS_DEV_MODELS_URL?.trim() || "https://models.dev/models.json");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("models.dev requires an HTTP(S) endpoint without URL credentials.");
    }
    return url.toString();
}

function stringList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
}

function canRoute(model: string): boolean {
    try { providerForModel(model); return true; }
    catch { return false; }
}

/** Chat transports only: text output, no image/audio generation, and tools. */
function chatCapable(model: ModelsDevModel): boolean {
    if (model.tool_call !== true) return false;
    const output = stringList(model.modalities?.output);
    return output.includes("text") && !output.includes("image") && !output.includes("audio");
}

function reasoningMetadata(model: ModelsDevModel): Pick<PickerModel, "reasoningEfforts" | "defaultReasoningEffort"> {
    const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
    const effort = options.find((option) =>
        !!option && typeof option === "object" && (option as { type?: unknown }).type === "effort");
    const values = stringList((effort as { values?: unknown } | undefined)?.values);
    if (!values.length) return {};
    return {
        reasoningEfforts: values,
        defaultReasoningEffort: values.includes("medium")
            ? "medium" : values[Math.floor((values.length - 1) / 2)],
    };
}

// Tiers map the catalogue's `family` onto the picker's subtabs. Known families
// are renamed for readability; anything new falls back to a tier inferred from
// the id, so a newly published family still lands somewhere sensible.
const FAMILY_ALIASES: Record<string, string> = {
    "claude-opus": "Opus", "claude-sonnet": "Sonnet", "claude-haiku": "Haiku", "claude-fable": "Fable",
    "gpt": "GPT", "gpt-pro": "GPT Pro", "gpt-mini": "GPT", "gpt-nano": "GPT Nano",
    "gpt-codex": "GPT Codex", "gpt-codex-spark": "GPT Codex",
    "gpt-sol": "GPT", "gpt-terra": "GPT", "gpt-luna": "GPT", "gpt-astra": "GPT",
    "gemini-pro": "Gemini Pro", "gemini-flash": "Gemini Flash", "gemini-flash-lite": "Gemini Flash Lite",
    "gemini": "Gemini",
    "deepseek-flash": "DeepSeek Flash", "deepseek-thinking": "DeepSeek Pro",
};

function familyFallback(id: string): string | undefined {
    // Aggregator ids are namespaced (`openai/gpt-5.6-luna-pro`).
    const slug = id.toLowerCase().slice(id.lastIndexOf("/") + 1);
    if (!slug) return undefined;
    if (slug.startsWith("claude")) {
        for (const tier of ["opus", "sonnet", "haiku", "fable"]) {
            if (slug.includes(tier)) return tier[0].toUpperCase() + tier.slice(1);
        }
        return "Claude";
    }
    if (slug.startsWith("gpt-")) {
        if (slug.includes("codex")) return "GPT Codex";
        if (slug.includes("-pro")) return "GPT Pro";
        if (slug.includes("-nano")) return "GPT Nano";
        return "GPT";
    }
    if (slug.startsWith("gemini-")) {
        if (slug.includes("flash-lite")) return "Gemini Flash Lite";
        if (slug.includes("flash")) return "Gemini Flash";
        if (slug.includes("pro")) return "Gemini Pro";
        return "Gemini";
    }
    if (slug.startsWith("deepseek-")) return slug.includes("flash") ? "DeepSeek Flash" : "DeepSeek Pro";
    return undefined;
}

export function tierFamily(id: string, raw: unknown): string | undefined {
    const family = typeof raw === "string" ? raw.trim() : "";
    return FAMILY_ALIASES[family] ?? familyFallback(id);
}

/** Collapses aliases like "Claude Sonnet 4.5 (latest)" and its dated snapshot. */
export function nameKey(label: string): string {
    return label.toLowerCase().replace(/\([^)]*\)/gu, " ").replace(/[^a-z0-9]+/gu, " ").trim();
}

function releasedAt(value: unknown): number | undefined {
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
}

function preferEntry(left: CloudEntry, right: CloudEntry): CloudEntry {
    const score = (entry: CloudEntry) =>
        (entry.pinned ? 4 : 0) +
        (/\(latest\)/iu.test(entry.label) ? 2 : 0) +
        (/\([^)]*\)/u.test(entry.label) ? 0 : 1);
    if (score(left) !== score(right)) return score(left) > score(right) ? left : right;
    const leftAt = left.releasedAt ?? 0, rightAt = right.releasedAt ?? 0;
    if (leftAt !== rightAt) return leftAt > rightAt ? left : right;
    return left.id.length <= right.id.length ? left : right;
}

function dedupeByName(entries: CloudEntry[]): CloudEntry[] {
    const byName = new Map<string, CloudEntry>();
    for (const entry of entries) {
        const current = byName.get(entry.nameKey);
        byName.set(entry.nameKey, current ? preferEntry(current, entry) : entry);
    }
    return [...byName.values()];
}

/** Tier blocks ordered by their newest member; newest first inside each tier. */
function orderByFamily(entries: CloudEntry[]): CloudEntry[] {
    const newest = new Map<string, number>();
    for (const entry of entries) {
        newest.set(entry.family ?? "", Math.max(newest.get(entry.family ?? "") ?? -1, entry.releasedAt ?? 0));
    }
    const rank = new Map([...newest].sort((left, right) => right[1] - left[1]).map(([family], index) => [family, index]));
    return [...entries].sort((left, right) =>
        (rank.get(left.family ?? "")! - rank.get(right.family ?? "")!) ||
        ((right.releasedAt ?? 0) - (left.releasedAt ?? 0)) ||
        left.label.localeCompare(right.label));
}

function toPicker(entry: CloudEntry): PickerModel {
    return {
        id: entry.id, label: entry.label, group: entry.group, provider: entry.provider,
        ...(entry.settingsOnly ? { settingsOnly: true } : {}),
        ...(entry.available !== undefined ? { available: entry.available } : {}),
        ...(entry.family ? { family: entry.family } : {}),
        ...(entry.releasedAt ? { releasedAt: entry.releasedAt } : {}),
        ...(entry.reasoningEfforts ? { reasoningEfforts: entry.reasoningEfforts } : {}),
        ...(entry.defaultReasoningEffort ? { defaultReasoningEffort: entry.defaultReasoningEffort } : {}),
    };
}

/** Pure mapping from a models.dev payload to the first-party cloud catalogue. */
export function normalizeModelsDevCatalog(payload: unknown): { models: CloudEntry[]; metadata: CatalogMetadata[] } {
    if (!payload || typeof payload !== "object") return { models: [], metadata: [] };
    const providers = payload as Record<string, { models?: unknown }>;
    const models: CloudEntry[] = [], metadata: CatalogMetadata[] = [];
    for (const { key, group } of FIRST_PARTY_PROVIDERS) {
        const rawModels = providers[key]?.models;
        if (!rawModels || typeof rawModels !== "object") continue;
        const entries: CloudEntry[] = [];
        for (const raw of Object.values(rawModels as Record<string, unknown>)) {
            const model = (raw ?? {}) as ModelsDevModel;
            const id = typeof model.id === "string" ? model.id.trim() : "";
            if (!id || !canRoute(id) || !chatCapable(model)) continue;
            const label = typeof model.name === "string" && model.name.trim() ? model.name.trim() : id;
            const contextWindow = typeof model.limit?.context === "number" ? Math.floor(model.limit.context) : undefined;
            const imageInput = model.modalities?.input === undefined
                ? undefined : stringList(model.modalities.input).includes("image");
            entries.push({
                ...pickerModel({ id, label, group, family: tierFamily(id, model.family),
                    ...reasoningMetadata(model) }),
                nameKey: nameKey(label), releasedAt: releasedAt(model.release_date),
            });
            metadata.push({ id, ...(contextWindow ? { contextWindow } : {}),
                ...(typeof imageInput === "boolean" ? { imageInput } : {}) });
        }
        models.push(...orderByFamily(dedupeByName(entries)));
    }
    return { models, metadata };
}

// Canonical model ids from models.json (`creator/model`), used to recognize the
// same model served by several providers so the picker can show one row.
const canonicalBySuffix = new Map<string, string[]>();

const lastSegment = (id: string) => id.slice(id.lastIndexOf("/") + 1);
// Providers spell versions with dots or dashes (`claude-opus-4.8` vs
// `claude-opus-4-8`); normalize before matching so they resolve to one model.
const normalizeId = (id: string) => id.toLowerCase().replace(/\./gu, "-");

const CREATOR_BY_PROVIDER: Partial<Record<Provider, string>> = {
    claude: "anthropic", "claude-p": "anthropic", openai: "openai", codex: "openai",
    gemini: "google", deepseek: "deepseek", meta: "meta", ollama: "ollama",
};

/** Canonical identity shared by every provider serving this model. */
export function canonicalKeyFor(provider: Provider, nativeId: string): string {
    const matches = canonicalBySuffix.get(normalizeId(lastSegment(nativeId)));
    if (matches?.length === 1) return matches[0];
    if (provider === "openrouter") return nativeId;
    const creator = CREATOR_BY_PROVIDER[provider];
    return `${creator ?? provider}/${nativeId}`;
}

function rememberCanonicalModels(payload: unknown): void {
    canonicalBySuffix.clear();
    if (!payload || typeof payload !== "object") return;
    for (const key of Object.keys(payload as Record<string, unknown>)) {
        const segment = normalizeId(lastSegment(key));
        canonicalBySuffix.set(segment, [...(canonicalBySuffix.get(segment) ?? []), key]);
    }
}

const reasoningById = new Map<string, Pick<PickerModel, "reasoningEfforts" | "defaultReasoningEffort">>();
const nameById = new Map<string, string>();
const releaseById = new Map<string, number>();

/** Effort controls for an aggregator model, from the catalogue's own metadata. */
export function reasoningForModel(id: string) {
    return reasoningById.get(id);
}

/** Display name for a model whose own listing publishes none (OpenCode Go). */
export function catalogNameForModel(id: string) {
    return nameById.get(id);
}

/** First release date for an aggregator model, from the catalogue's records. */
export function releaseForModel(id: string) {
    return releaseById.get(id);
}

function rememberAggregatorMetadata(payload: unknown): void {
    reasoningById.clear();
    nameById.clear();
    releaseById.clear();
    if (!payload || typeof payload !== "object") return;
    const providers = payload as Record<string, { models?: unknown }>;
    for (const key of REASONING_PROVIDERS) {
        const rawModels = providers[key]?.models;
        if (!rawModels || typeof rawModels !== "object") continue;
        for (const raw of Object.values(rawModels as Record<string, unknown>)) {
            const model = (raw ?? {}) as ModelsDevModel;
            const id = typeof model.id === "string" ? model.id.trim() : "";
            if (!id) continue;
            const name = typeof model.name === "string" ? model.name.trim() : "";
            if (name) nameById.set(id, name);
            const release = releasedAt(model.release_date);
            if (release) releaseById.set(id, release);
            const reasoning = reasoningMetadata(model);
            if (reasoning.reasoningEfforts) reasoningById.set(id, reasoning);
        }
    }
}

/** Overlays the live catalogue on the pinned seed, filling tiers for shared ids. */
export function mergeCloudCatalog(seed: PickerModel[], live: CloudEntry[]): PickerModel[] {
    const remembered = new Map(live.map((entry) => [entry.id, entry]));
    const entries: CloudEntry[] = seed.map((model) => {
        const match = remembered.get(model.id);
        const isFirstParty = FIRST_PARTY_GROUPS.has(model.group);
        return {
            ...model,
            ...(isFirstParty && !model.family
                ? { family: match?.family ?? familyFallback(model.id) } : {}),
            nameKey: nameKey(model.label), releasedAt: match?.releasedAt, pinned: true,
        };
    });
    const seen = new Set(entries.map((entry) => entry.id));
    for (const entry of live) {
        if (seen.has(entry.id)) continue;
        entries.push(entry);
        seen.add(entry.id);
    }
    const groups = new Map<string, CloudEntry[]>();
    for (const entry of entries) {
        groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
    }
    return [...groups.values()].flatMap((group) => {
        const deduped = dedupeByName(group);
        const ordered = deduped.some((entry) => entry.family) ? orderByFamily(deduped) : deduped;
        return ordered.map(toPicker);
    });
}

/** The pinned seed: also the offline fallback before the first probe lands. */
function seedCatalog(): ModelsDevCatalog {
    return { source: "unavailable", models: staticPickerModels() };
}

async function probeModelsDev(): Promise<ModelsDevCatalog> {
    const timeoutMs = Number(process.env.MODELS_DEV_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    // Both documents are independent; fetch them together. Canonical ids are
    // optional metadata, so their failure must not drop the catalogue.
    const [payload, canonical] = await Promise.all([
        fetchCatalogJson<unknown>(modelsDevUrl(), {
            label: "models.dev listing", timeoutMs, maxBytes: MAX_CATALOG_BYTES,
        }),
        fetchCatalogJson<unknown>(modelsDevModelsUrl(), {
            label: "models.dev model metadata", timeoutMs, maxBytes: MAX_CATALOG_BYTES,
        }).catch(() => undefined),
    ]);
    const { models, metadata } = normalizeModelsDevCatalog(payload);
    registerCatalogModels(metadata, MODELS_DEV_CATALOG_SOURCE);
    rememberAggregatorMetadata(payload);
    if (canonical) rememberCanonicalModels(canonical);
    return { source: "live", models: mergeCloudCatalog(seedCatalog().models, models) };
}

const cache = createCatalogCache<ModelsDevCatalog>(probeModelsDev, seedCatalog(), {
    ttlMs: Number(process.env.MODELS_DEV_TTL_MS) || DEFAULT_TTL_MS,
});

export const modelsDevCatalogSnapshot = () => cache.snapshot();
