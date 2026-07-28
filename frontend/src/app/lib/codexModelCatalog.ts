import {
    getCodexModelCatalog,
    type CodexModelCatalog,
} from "@/app/lib/beaverApi";

const STORAGE_KEY = "mike.codexModelCatalog.v1";
const REFRESH_MS = 30_000;
let catalog: CodexModelCatalog | null = null;
let refreshedAt = 0;
let pending: Promise<CodexModelCatalog> | null = null;

function readCachedCatalog() {
    if (typeof window === "undefined") return null;
    try {
        const value = JSON.parse(
            window.localStorage.getItem(STORAGE_KEY) ?? "null",
        ) as { catalog?: unknown } | null;
        const cached = value?.catalog as CodexModelCatalog | undefined;
        return Array.isArray(cached?.models) &&
            cached.models.every(
                (model) =>
                    typeof model?.slug === "string" &&
                    typeof model.displayName === "string" &&
                    Array.isArray(model.supportedReasoningLevels),
            )
            ? cached
            : null;
    } catch {
        return null;
    }
}

function cacheCatalog(value: CodexModelCatalog) {
    if (typeof window === "undefined" || value.models.length === 0) return;
    try {
        window.localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ catalog: value }),
        );
    } catch {}
}

export function getSessionCodexModelCatalog() {
    return catalog;
}

export function preloadCodexModelCatalog() {
    catalog ??= readCachedCatalog();
    if (catalog && Date.now() - refreshedAt < REFRESH_MS) {
        return Promise.resolve(catalog);
    }
    pending ??= getCodexModelCatalog()
        .then((next) => {
            refreshedAt = Date.now();
            if (next.models.length > 0) {
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

export function resetCodexModelCatalogSession() {
    catalog = null;
    refreshedAt = 0;
    pending = null;
}
