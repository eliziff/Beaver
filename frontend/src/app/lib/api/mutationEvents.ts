type ApiMutation = { path: string; method: string; fields?: readonly string[] };
const listeners = new Set<(mutation: ApiMutation) => void>();
export function onApiMutation(listener: (mutation: ApiMutation) => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function notifyApiMutation(path: string, method: string, body?: BodyInit | null) {
    if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return;
    // Field names let consumers distinguish metadata changes from draft autosaves.
    // Never put request values or file contents on the invalidation bus.
    let fields: string[] | undefined;
    if (method.toUpperCase() === "PATCH" && typeof body === "string") {
        try {
            const value: unknown = JSON.parse(body);
            if (value && typeof value === "object" && !Array.isArray(value)) fields = Object.keys(value);
        } catch { /* Unknown writes are conservatively invalidated. */ }
    }
    for (const listener of listeners) {
        try { listener({ path, method, fields }); }
        catch { /* Observers must not change the outcome of a successful write. */ }
    }
}
