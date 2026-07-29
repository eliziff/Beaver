import {
    getModelCatalog,
    type ModelCatalog,
} from "@/app/lib/beaverApi";
const STORAGE_KEY = "beaver.modelCatalog.v1";
const REFRESH_MS = 30_000;
let catalog: ModelCatalog | null = null;
let refreshedAt = 0;
let pending: Promise<ModelCatalog> | null = null;
const hasModels = (value: ModelCatalog) =>
    value.models.length > 0 || !!value.ollama?.models.length;
function readCachedCatalog() {
    if (typeof window === "undefined") return null;
    try {
        const value = JSON.parse(
            window.localStorage.getItem(STORAGE_KEY) ?? "null",
        ) as { catalog?: unknown } | null;
        const cached = value?.catalog as ModelCatalog | undefined;
        return Array.isArray(cached?.models) &&
            cached.models.every(
                (model) =>
                    typeof model?.slug === "string" &&
                    typeof model.displayName === "string" &&
                    Array.isArray(model.supportedReasoningLevels),
            ) &&
            (!cached.ollama ||
                (Array.isArray(cached.ollama.models) &&
                    cached.ollama.models.every(
                        (model) =>
                            typeof model?.name === "string" &&
                            typeof model.displayName === "string",
                    )))
            ? cached
            : null;
    } catch {
        return null;
    }
}
function cacheCatalog(value: ModelCatalog) {
    if (typeof window === "undefined" || !hasModels(value)) return;
    try {
        window.localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ catalog: value }),
        );
    } catch {}
}
export function getSessionModelCatalog() {
    return catalog;
}
export function preloadModelCatalog() {
    catalog ??= readCachedCatalog();
    const refreshMs =
        catalog?.ollama?.source === "unavailable" ? 5_000 : REFRESH_MS;
    if (catalog && Date.now() - refreshedAt < refreshMs) {
        return Promise.resolve(catalog);
    }
    pending ??= getModelCatalog()
        .then((next) => {
            refreshedAt = Date.now();
            if (hasModels(next)) {
                catalog = next;
                cacheCatalog(next);
            } else {
                catalog ??= next;
            }
            return catalog;
        })
        .catch((error: unknown) => {
            refreshedAt = Date.now();
            catalog ??= {
                source: "unavailable",
                models: [],
                error: error instanceof Error ? error.message : String(error),
            };
            return catalog;
        })
        .finally(() => {
            pending = null;
        });
    return pending;
}
export function resetModelCatalogSession() {
    catalog = null;
    refreshedAt = 0;
    pending = null;
}
