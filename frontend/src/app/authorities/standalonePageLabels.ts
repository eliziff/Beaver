import { attachedAuthoritySources } from "../../../../shared/authorities-sources.mjs";
import { oneAtATime } from "../../../../shared/one-at-a-time.mjs";
import { readSourceAnswer, rememberSourceAnswer } from "@/app/lib/standaloneWorkProducts";
import { authorityCitationForms } from "./authorityPresentation";
import type { AuthoritiesProduct } from "./types";

type Labels = Array<string | null>;
type Read = (draft: AuthoritiesProduct, role: string, signal?: AbortSignal) => Promise<Labels>;
// Kept a month, then read again, so a better reading of printed numbers reaches PDFs read before it.
const KEPT_FOR = 30 * 24 * 60 * 60 * 1000;

const abortable = <T>(result: Promise<T>, signal?: AbortSignal) => !signal ? result
  : new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    result.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });

/**
 * A source PDF's printed page numbers, read once and kept with the page by the PDF's hash (and, for
 * a reporter's original, the citations that give its first page), so a viewer opening it shows them
 * at once, in this visit and later ones. The runtime that reads them is busy for seconds at a time
 * with the quote check and other sources, so each source attached is read in the background, one at
 * a time, before anyone opens it.
 */
export function keptPageLabels(read: Read) {
  const held = new Map<string, Promise<Labels>>();
  const keyOf = (draft: AuthoritiesProduct, role: string) => {
    for (const authority of Object.values(draft.state.authorities)) {
      const source = attachedAuthoritySources(authority.source).find((item) => item.bindingRole === role);
      if (!source) continue;
      const forms = source.origin === "original"
        ? authorityCitationForms(authority, Object.values(draft.state.occurrences)).join("\n") : "";
      return `page-labels:${source.sourceSha256}\0${forms}`;
    }
    return null;
  };
  const labels = (draft: AuthoritiesProduct, role: string, signal?: AbortSignal) => {
    const key = keyOf(draft, role);
    if (!key) return read(draft, role, signal);
    let pending = held.get(key);
    if (!pending) {
      pending = (async () => {
        const stored = await readSourceAnswer(key).catch(() => null);
        if (stored) return JSON.parse(stored) as Labels;
        // Read for every viewer that asks, so one closing does not stop it for the others.
        const value = await read(draft, role);
        void rememberSourceAnswer(key, JSON.stringify(value), Date.now() + KEPT_FOR).catch(() => undefined);
        return value;
      })();
      held.set(key, pending);
      pending.catch(() => { if (held.get(key) === pending) held.delete(key); });
    }
    return abortable(pending, signal);
  };
  const turn = oneAtATime(), queued = new Set<string>();
  /** Reads, in the background and one at a time, every attached source not yet read. */
  const readAhead = (draft: AuthoritiesProduct) => {
    for (const id of draft.state.authorityOrder) {
      const authority = draft.state.authorities[id];
      if (!authority || authority.excluded) continue;
      for (const { bindingRole } of attachedAuthoritySources(authority.source)) {
        const key = keyOf(draft, bindingRole);
        if (!key || held.has(key) || queued.has(key)) continue;
        queued.add(key);
        void turn(() => labels(draft, bindingRole)).catch(() => undefined).finally(() => queued.delete(key));
      }
    }
  };
  return { labels, readAhead };
}
