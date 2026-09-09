import { getModelCatalog, type ModelCatalog } from "@/app/lib/api/account";
import { useSyncExternalStore } from "react";
const STORAGE_KEY = "beaver.modelCatalog.v1";
const REFRESH_MS = 30_000;
let catalog: ModelCatalog | null = null;
let refreshedAt = 0;
let pending: Promise<ModelCatalog> | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};
export const useModelCatalog = () => useSyncExternalStore(subscribe, getSessionModelCatalog, () => null);
function readCachedCatalog() {
    if (typeof window === "undefined") return null;
    try {
        const value = JSON.parse(
            window.localStorage.getItem(STORAGE_KEY) ?? "null",
        ) as { catalog?: unknown } | null;
        const cached = value?.catalog as ModelCatalog | undefined;
        return Array.isArray(cached?.models) && cached.models.every(model =>
            typeof model?.id === "string" && typeof model.label === "string" &&
            typeof model.group === "string" && (model.reasoningEfforts === undefined ||
                Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.every(level => typeof level === "string")))
            ? cached : null;
    } catch {
        return null;
    }
}
function cacheCatalog(value: ModelCatalog) {
    if (typeof window === "undefined" || !value.models.length) return;
    try {
        window.localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ catalog: value }),
        );
    } catch {
        // Storage can be unavailable in private browsing or hardened contexts.
    }
}
function getSessionModelCatalog() {
    return catalog ??= readCachedCatalog();
}
export function preloadModelCatalog() {
    catalog ??= readCachedCatalog();
    const refreshMs =
        catalog?.models.some(model => model.available === false) ? 5_000 : REFRESH_MS;
    if (catalog && Date.now() - refreshedAt < refreshMs) {
        return Promise.resolve(catalog);
    }
    pending ??= getModelCatalog()
        .then((next) => {
            refreshedAt = Date.now();
            const unavailable = new Set<string>(next.unavailableProviders);
            next.models = [...next.models, ...(catalog?.models ?? [])
                .filter(model => unavailable.has(model.provider ?? "") &&
                    !next.models.some(current => current.id === model.id))
                .map(model => ({ ...model, available: false }))];
            catalog = next;
            cacheCatalog(next);
            return catalog;
        })
        .catch(() => {
            refreshedAt = Date.now();
            catalog = { ...catalog, models: (catalog?.models ?? []).map(model => ({ ...model, available: false })) };
            return catalog;
        })
        .finally(() => {
            pending = null;
            listeners.forEach(notify => notify());
        });
    return pending;
}
