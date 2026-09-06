import type { Page } from "./api/client";

export type CollectionSpec = { key: string; tags: readonly string[] };
export type PageChain<T> = {
    items: T[]; nextCursor: string | null; loading: boolean; error: unknown;
    revision?: string; loaded?: boolean; refreshing?: boolean;
};
export type Chains<T> = Record<string, PageChain<T>>;
export type CollectionLoader<T> = (key: string, cursor: string | null, signal: AbortSignal) => Promise<Page<T>>;
let accessOrder = 0;
type Update<T> = Chains<T> | ((current: Chains<T>) => Chains<T>);

// One entry represents one exact query/scope and owns its cursor chains. React
// subscribers share both snapshots and in-flight work, not just response bytes.
export class PagedCollection<T> {
    private state: Chains<T> = {};
    private listeners = new Set<() => void>();
    private consumers = new Map<symbol, CollectionLoader<T>>();
    private requests = new Map<string, { controller: AbortController; promise: Promise<void>; append: boolean }>();
    private revisions: Readonly<Record<string, string>> | undefined;
    private initialKey = "query";
    private automatic = true;
    private queued = false;
    private dirty = false;
    private disposed = false;
    lastUsed = Date.now();
    order = ++accessOrder;
    constructor(readonly spec?: CollectionSpec, private changed: () => void = () => {},
        private denied?: (error: unknown, status: number) => void) {}
    get active() { return this.consumers.size > 0; }
    get weight() {
        // Only evaluated during retention/eviction, never during a React render.
        return JSON.stringify(this.state).length * 2;
    }
    get itemCount() { return Object.values(this.state).reduce((sum, chain) => sum + chain.items.length, 0); }
    snapshot = () => this.state;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    private publish(state: Chains<T>) {
        this.state = state;
        for (const listener of this.listeners) listener();
        this.changed();
    }
    connect(load: CollectionLoader<T>, initialKey: string, revisions?: Readonly<Record<string, string>>, automatic = true) {
        const first = !this.active, id = Symbol();
        this.disposed = false;
        this.consumers.set(id, load);
        this.initialKey = initialKey; this.automatic = automatic;
        this.revisions = revisions;
        this.lastUsed = Date.now(); this.order = ++accessOrder;
        // Revalidate on every activation, without clearing the last usable rows.
        // A second simultaneous view joins the existing work instead of restarting it.
        if (first && automatic) this.refresh();
        else if (automatic && !this.state[initialKey]) void this.fetchPage(initialKey, null, false);
        return () => {
            this.consumers.delete(id);
            this.lastUsed = Date.now(); this.order = ++accessOrder;
            if (!this.spec && !this.active) this.clear();
            this.changed();
        };
    }
    setRevisions(revisions?: Readonly<Record<string, string>>) {
        this.revisions = revisions;
        if (!revisions) return;
        for (const [key, chain] of Object.entries(this.state)) {
            if (key in revisions && chain.revision !== revisions[key])
                void this.fetchPage(key, null, false, true);
        }
    }
    refresh = () => {
        if (!this.active || this.disposed) return;
        this.dirty = false;
        const keys = new Set([...(this.automatic ? [this.initialKey] : []), ...Object.keys(this.state)]);
        for (const key of keys) void this.fetchPage(key, null, false);
    };
    private scheduleRefresh() {
        if (this.queued) return;
        this.queued = true;
        queueMicrotask(() => {
            this.queued = false;
            if (this.dirty) this.refresh();
        });
    }
    invalidate() {
        this.abort();
        this.dirty = true;
        if (!this.active) this.publish({});
        else {
            this.publish(Object.fromEntries(Object.entries(this.state).map(([key, chain]) =>
                [key, { ...chain, loading: false }])));
            this.scheduleRefresh();
        }
    }
    private abort(key?: string) {
        for (const [name, request] of this.requests) {
            if (key !== undefined && name !== key) continue;
            request.controller.abort(); this.requests.delete(name);
        }
    }
    clear() {
        this.abort();
        this.dirty = false;
        this.publish({});
    }
    dispose() { this.disposed = true; this.clear(); }
    rejectAccess(error: unknown) {
        this.abort(); this.dirty = false;
        this.publish({ [this.initialKey]: { items: [], nextCursor: null, loading: false, loaded: false, error } });
    }
    setChains = (update: Update<T>) => {
        if (this.disposed) return;
        let next = typeof update === "function" ? update(this.state) : update;
        let interrupted = false;
        for (const [key, chain] of Object.entries(next)) {
            if (chain === this.state[key]) continue;
            if (this.requests.has(key)) { this.abort(key); interrupted = true; }
            next = { ...next, [key]: { ...chain, loading: false, refreshing: false, loaded: true } };
        }
        for (const key of Object.keys(this.state)) if (!(key in next)) this.abort(key);
        this.publish(next);
        if (interrupted) { this.dirty = true; this.scheduleRefresh(); }
    };
    fetchPage = (key: string, cursor: string | null, append: boolean, force = false): Promise<void> => {
        const load = [...this.consumers.values()].at(-1);
        if (!load || this.disposed) return Promise.resolve();
        const pending = this.requests.get(key);
        if (pending && !force) return !append && pending.append
            ? pending.promise.then(() => this.fetchPage(key, null, false)) : pending.promise;
        if (pending) this.abort(key);
        const controller = new AbortController();
        const revision = this.revisions?.[key];
        const old = this.state[key];
        const retainCount = !append && (this.spec || this.revisions) ? old?.items.length ?? 0 : 0;
        this.publish({ ...this.state, [key]: {
            items: old?.items ?? [], nextCursor: old?.nextCursor ?? null,
            loaded: old?.loaded ?? false, loading: true, refreshing: !!old?.loaded && !append, error: null, revision,
        } });
        const request = { controller, append, promise: Promise.resolve() };
        this.requests.set(key, request);
        request.promise = (async () => {
            try {
                let page = await load(key, cursor, controller.signal);
                const items = [...page.items], seen = new Set<string>();
                while (!controller.signal.aborted && page.next_cursor && items.length < retainCount) {
                    if (seen.has(page.next_cursor)) throw new Error("Collection cursor did not advance");
                    seen.add(page.next_cursor);
                    page = await load(key, page.next_cursor, controller.signal);
                    items.push(...page.items);
                }
                if (controller.signal.aborted || this.disposed) return;
                this.publish({ ...this.state, [key]: {
                    items: append ? [...(this.state[key]?.items ?? []), ...items] : items,
                    nextCursor: page.next_cursor, loaded: true, loading: false, error: null, revision,
                } });
            } catch (error) {
                if (controller.signal.aborted || this.disposed) return;
                const status = (error as { status?: number } | null)?.status;
                // Never retain inaccessible rows after an authorization/not-found response.
                const inaccessible = status === 401 || status === 403 || status === 404;
                if (inaccessible && this.denied) { this.rejectAccess(error); this.denied(error, status!); return; }
                if (inaccessible) this.abort();
                this.publish({ ...(inaccessible ? {} : this.state), [key]: {
                    ...(this.state[key] ?? { items: [], nextCursor: null }),
                    ...(inaccessible ? { items: [], nextCursor: null, loaded: false } : {}),
                    loading: false, refreshing: false, error,
                } });
            } finally {
                if (this.requests.get(key) === request) this.requests.delete(key);
                this.changed();
            }
        })();
        return request.promise;
    };
}

export class CollectionCache {
    private entries = new Map<string, PagedCollection<unknown>>();
    private trimming = false;
    constructor(private limits = { entries: 32, items: 8_000, bytes: 8 * 1024 * 1024, idleMs: 5 * 60_000 }) {}
    get<T>(spec: CollectionSpec): PagedCollection<T> {
        const [resource, query = ""] = spec.key.split("?");
        const parameters = new URLSearchParams(query); parameters.sort();
        spec = { ...spec, key: `${resource}${parameters.size ? `?${parameters}` : ""}` };
        let entry = this.entries.get(spec.key);
        if (entry && !entry.active && Date.now() - entry.lastUsed > this.limits.idleMs) {
            const expired = entry;
            this.entries.delete(spec.key); entry = undefined;
            queueMicrotask(() => { if (!expired.active) expired.dispose(); });
        }
        if (!entry) {
            const scopeTags = spec.tags.filter(tag => tag !== "directories");
            entry = new PagedCollection(spec, () => this.trim(), (error, status) => {
                for (const other of [...this.entries.values()])
                    if (other !== entry && (status === 401 || other.spec?.tags.some(tag => scopeTags.includes(tag)))) other.rejectAccess(error);
            });
            this.entries.set(spec.key, entry);
            queueMicrotask(() => this.trim());
        }
        return entry as PagedCollection<T>;
    }
    private trim() {
        if (this.trimming) return;
        this.trimming = true;
        try {
        const inactive = [...this.entries.entries()].filter(([, entry]) => !entry.active)
            .sort((a, b) => b[1].order - a[1].order);
        let items = 0, bytes = 0;
        for (const [index, [key, entry]] of inactive.entries()) {
            items += entry.itemCount; bytes += entry.weight;
            if (index < this.limits.entries && items <= this.limits.items && bytes <= this.limits.bytes &&
                Date.now() - entry.lastUsed <= this.limits.idleMs) continue;
            this.entries.delete(key); entry.dispose();
        }
        } finally { this.trimming = false; }
    }
    invalidate(tags: readonly string[]) {
        for (const entry of [...this.entries.values()])
            if (entry.spec?.tags.some(tag => tags.includes(tag))) entry.invalidate();
    }
    refreshActive = () => { for (const entry of this.entries.values()) entry.refresh(); };
    clear = () => {
        // Keep entry identities for React StrictMode's effect replay. The entire
        // cache instance is discarded on a real account-boundary unmount.
        for (const entry of [...this.entries.values()]) entry.dispose();
    };
}
