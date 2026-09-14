import { createCatalogCache, fetchCatalogJson } from "../catalogCache";
import { pickerModel, registerCatalogModels, type PickerModel } from "./models";
import { tierFamily } from "./modelsDev";

// OpenRouter publishes its whole catalogue from one public listing. The lane
// mirrors OpenCode Go: every live model appears, grouped by upstream vendor,
// and the wire is the OpenAI-compatible chat API OpenRouter documents.
const label = "OpenRouter";
const DEFAULT_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const OPENROUTER_CATALOG_SOURCE = "openrouter";

type OpenRouterModel = {
    id?: unknown; name?: unknown; created?: unknown; context_length?: unknown;
    expiration_date?: unknown; supported_parameters?: unknown;
    architecture?: { input_modalities?: unknown; output_modalities?: unknown };
};

type CatalogMetadata = { id: string; contextWindow?: number; imageInput?: boolean };
export type OpenRouterCatalog = { source: "live" | "unavailable"; models: PickerModel[] };

function catalogUrl(): string {
    const url = new URL(process.env.OPENROUTER_CATALOG_URL?.trim() || DEFAULT_URL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("OpenRouter requires an HTTP(S) endpoint without URL credentials.");
    }
    return url.toString();
}

function stringList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
}

function titleCase(value: string): string {
    return value.split(/[-_]/u).filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

/** Pure mapping from the OpenRouter listing to its picker lane. */
export function normalizeOpenRouterCatalog(payload: unknown): { models: PickerModel[]; metadata: CatalogMetadata[] } {
    const data = (payload as { data?: unknown } | null)?.data;
    const entries: { model: PickerModel; vendor: string; created: number }[] = [];
    const metadata: CatalogMetadata[] = [];
    for (const raw of Array.isArray(data) ? data : []) {
        const row = (raw ?? {}) as OpenRouterModel;
        const id = typeof row.id === "string" ? row.id.trim() : "";
        if (!id || !id.includes("/")) continue;
        if (typeof row.expiration_date === "string" && row.expiration_date.trim()) continue;
        // Chat/agent transports only; the listing also carries embedding and
        // media models this picker cannot drive.
        if (!stringList(row.supported_parameters).includes("tools")) continue;
        const output = stringList(row.architecture?.output_modalities);
        if (output.length && !output.includes("text")) continue;
        const full = typeof row.name === "string" ? row.name.trim() : "";
        const [vendorName, ...rest] = full.split(":");
        const vendor = vendorName?.trim() || titleCase(id.split("/")[0]);
        const modelLabel = rest.join(":").trim() || full || id.split("/").slice(1).join("/");
        const contextWindow = typeof row.context_length === "number" ? Math.floor(row.context_length) : undefined;
        const imageInput = row.architecture?.input_modalities === undefined
            ? undefined : stringList(row.architecture.input_modalities).includes("image");
        const created = typeof row.created === "number" ? row.created : 0;
        entries.push({
            // The vendor names the company, not a tier; derive the tier from the id.
            model: pickerModel({ id, label: modelLabel, group: label,
                family: tierFamily(id, undefined),
                ...(created ? { releasedAt: created * 1000 } : {}) }),
            vendor,
            created,
        });
        metadata.push({ id, ...(contextWindow ? { contextWindow } : {}),
            ...(typeof imageInput === "boolean" ? { imageInput } : {}) });
    }
    entries.sort((left, right) =>
        left.vendor.localeCompare(right.vendor) ||
        right.created - left.created ||
        left.model.label.localeCompare(right.model.label));
    return { models: entries.map(({ model }) => model), metadata };
}

async function probeOpenRouter(): Promise<OpenRouterCatalog> {
    const payload = await fetchCatalogJson<unknown>(catalogUrl(), {
        label: "OpenRouter listing",
        timeoutMs: Number(process.env.OPENROUTER_CATALOG_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
        maxBytes: MAX_CATALOG_BYTES,
    });
    const { models, metadata } = normalizeOpenRouterCatalog(payload);
    registerCatalogModels(metadata, OPENROUTER_CATALOG_SOURCE);
    return { source: "live", models };
}

const cache = createCatalogCache<OpenRouterCatalog>(probeOpenRouter, { source: "unavailable", models: [] }, {
    ttlMs: Number(process.env.OPENROUTER_CATALOG_TTL_MS) || DEFAULT_TTL_MS,
});

export const openRouterModelCatalogSnapshot = () => cache.snapshot();
