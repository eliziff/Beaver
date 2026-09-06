import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { CollectionContext } from "@/app/contexts/CollectionContext";
import { PagedCollection, type Chains, type CollectionLoader, type CollectionSpec } from "@/app/lib/collections";

const EMPTY: Chains<never> = {};
export function usePagedChains<T>(
    load: CollectionLoader<T>,
    dependencies: readonly unknown[],
    initialKey: string,
    enabled: boolean,
    revisions?: Readonly<Record<string, string>>,
    collection?: CollectionSpec,
) {
    const cache = useContext(CollectionContext);
    const loader = useCallback(load, dependencies); // eslint-disable-line react-hooks/exhaustive-deps
    const key = collection?.key;
    // Only explicit resource identities are reusable. Never infer cache keys from
    // callback names or dependency arrays; unrelated collections can share both.
    const entry = useMemo(() => cache && collection
        ? cache.get<T>(collection) : new PagedCollection<T>(),
    [cache, key, enabled, cache && key ? null : loader]); // eslint-disable-line react-hooks/exhaustive-deps
    const chains = useSyncExternalStore(entry.subscribe, entry.snapshot, entry.snapshot);
    useLayoutEffect(() => {
        if (!enabled && cache && collection) return;
        // The existing private hook also supports imperative fetching with its
        // automatic first load disabled (Sources uses this for per-source chains).
        return entry.connect(loader, initialKey, revisions, enabled);
    }, [enabled, entry, loader, initialKey]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { if (enabled || !collection || !cache) entry.setRevisions(revisions); }, [enabled, entry, revisions]);
    return { chains: enabled || !collection || !cache ? chains : EMPTY, setChains: entry.setChains, fetchPage: entry.fetchPage };
}
