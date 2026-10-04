import { useEffect, useMemo, useState } from "react";
import { attachedAuthoritySources, statuteExcerpt } from "../../../../shared/authorities-sources.mjs";
import { oneAtATime } from "../../../../shared/one-at-a-time.mjs";
import { getPdfJs, openPdfDocument, PDF_DOCUMENT_OPTIONS } from "@/app/lib/pdfJs";
import type { AuthoritiesHost } from "./host";
import type { AuthoritiesProduct } from "./types";

/** A statute row's book copy: whether it can be chosen, and excerpt or whole (unknown until the
 *  statute's length is). */
export type StatuteCopy = { choosable: boolean; excerpt?: boolean };

type Read = { key: string; role: string };

async function pageCount(file: Blob) {
  const task = openPdfDocument(await getPdfJs(), { data: new Uint8Array(await file.arrayBuffer()) }, PDF_DOCUMENT_OPTIONS);
  try { return (await task.promise).numPages; } finally { await task.destroy(); }
}

/** Lengths read for one draft, kept while it is open. A read that fails is not asked again. */
type Store = { draftId: string; stop: AbortController; read: Map<string, number | null>; asked: Set<string> };
const stores = new WeakMap<AuthoritiesHost, Store>();
const queue = oneAtATime();
function storeFor(host: AuthoritiesHost, draftId: string) {
  const held = stores.get(host);
  if (held?.draftId === draftId) return held;
  held?.stop.abort();
  const store: Store = { draftId, stop: new AbortController(), read: new Map(), asked: new Set() };
  stores.set(host, store);
  return store;
}

/**
 * The book copy of each statute the book reproduces, by authority: as chosen in `shown`, else by
 * its length, recorded when its PDF was attached or read here, one PDF at a time while `active`, the
 * first time it is wanted.
 */
export function useStatuteCopies(host: AuthoritiesHost, product: AuthoritiesProduct | undefined,
  shown: AuthoritiesProduct | undefined, active: boolean) {
  const [version, setVersion] = useState(0);
  const { rows, wanted } = useMemo(() => {
    const rows = new Map<string, StatuteCopy>(), wanted: Read[] = [];
    const state = shown?.state, held = product && stores.get(host);
    const read = held?.draftId === product?.id ? held?.read : undefined;
    if (!product || !state || state.import.kind !== "document" || state.outputMode === "table" && !state.settings.finalPdf)
      return { rows, wanted };
    for (const id of state.authorityOrder) {
      const authority = state.authorities[id];
      if (authority?.kind !== "legislation") continue;
      const sources = attachedAuthoritySources(authority.source);
      if (!sources.length || authority.excluded) { rows.set(id, { choosable: false }); continue; }
      const counts = sources.map(({ bindingRole, sourceSha256, pageCount }) => {
        const key = `count\0${sourceSha256}`, value = pageCount ?? read?.get(key);
        if (value === undefined && host.readSource) wanted.push({ key, role: bindingRole });
        return typeof value === "number" ? value : undefined;
      });
      rows.set(id, { choosable: true, excerpt: statuteExcerpt(authority, counts) });
    }
    return { rows, wanted };
  // What has been read is kept outside React; `version` moves on as each read lands.
  }, [host, product, shown, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const reads = wanted.map(({ key }) => key).join("\n");
  useEffect(() => {
    if (!active || !product || !reads) return;
    const store = storeFor(host, product.id), { signal } = store.stop;
    for (const { key, role } of wanted) {
      if (store.asked.has(key)) continue;
      store.asked.add(key);
      void queue(async () => store.read.set(key, await pageCount(await host.readSource!(product, role, signal))), signal)
        .catch(() => { if (!signal.aborted) store.read.set(key, null); })
        .finally(() => { if (!signal.aborted) setVersion((value) => value + 1); });
    }
  }, [host, product?.id, reads, active]); // eslint-disable-line react-hooks/exhaustive-deps
  return rows;
}
