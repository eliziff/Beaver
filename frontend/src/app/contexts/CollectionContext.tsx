import { createContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { CollectionCache } from "@/app/lib/collections";
import { onCollectionChange } from "@/app/lib/collectionEvents";

export const CollectionContext = createContext<CollectionCache | null>(null);

// AuthProvider keys this boundary by account identity. No collection data is
// persisted to storage, broadcast to other tabs, or shared between accounts.
export function CollectionProvider({ owner, children }: { owner: string | null; children: ReactNode }) {
    return <CollectionSession key={owner ?? "anonymous"} owner={owner}>{children}</CollectionSession>;
}
function CollectionSession({ owner, children }: { owner: string | null; children: ReactNode }) {
    const [cache] = useState(() => new CollectionCache());
    useLayoutEffect(() => () => cache.clear(), [cache]);
    useEffect(() => {
        if (!owner) return;
        let channel: BroadcastChannel | null = null;
        try { if (typeof BroadcastChannel !== "undefined") channel = new BroadcastChannel("beaver-collection-changes"); }
        catch { /* Restricted browsers still revalidate on activation/focus/online. */ }
        const off = onCollectionChange(({ tags }) => {
            cache.invalidate(tags);
            channel?.postMessage({ owner, tags });
        });
        if (channel) channel.onmessage = ({ data }: MessageEvent<unknown>) => {
            const message = data as { owner?: unknown; tags?: unknown } | null;
            if (message?.owner !== owner || !Array.isArray(message.tags) || message.tags.length > 32 ||
                !message.tags.every(tag => typeof tag === "string" && tag.length < 512)) return;
            cache.invalidate(message.tags);
        };
        const visible = () => { if (document.visibilityState === "visible") cache.refreshActive(); };
        window.addEventListener("focus", visible);
        document.addEventListener("visibilitychange", visible);
        window.addEventListener("online", cache.refreshActive);
        return () => {
            off(); channel?.close();
            window.removeEventListener("focus", visible);
            document.removeEventListener("visibilitychange", visible);
            window.removeEventListener("online", cache.refreshActive);
        };
    }, [cache, owner]);
    return <CollectionContext.Provider value={owner ? cache : null}>{children}</CollectionContext.Provider>;
}
