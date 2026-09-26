import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { inspectPdf } from "@/app/lib/inspectPdf";
import { authorityName } from "./authorityPresentation";
import type { AuthoritiesHost } from "./host";
import type { AuthoritiesProduct } from "./types";

export type ScannedPdf = { role: string; name: string; sourceSha256: string; textlessPages: number[] };
/** `pages` is the pass being read now (empty for the whole PDF); `recognized` is what it has finished. */
export type SourceOcrStatus = ScannedPdf & { documentId?: string; pages?: number[]; recognized: number;
  error?: string; state: "running" | "paused" | "cancelled" | "done" | "failed" };

/** What a step needs to watch and steer recognition, without owning it. */
export type SourceOcrPanel = Pick<ReturnType<typeof useSourceOcr>, "tracked" | "begin" | "stop">;

export function useSourceOcr(host: AuthoritiesHost, draftId?: string) {
  const [tracked, setTracked] = useState<Record<string, SourceOcrStatus>>({});
  const pending = useRef(Promise.resolve());
  const port = host.sourceOcr;
  const merge = useCallback((updates: Record<string, Partial<SourceOcrStatus>>) =>
    setTracked((current) => Object.fromEntries(Object.entries(current).map(([role, item]) =>
      [role, updates[role] ? { ...item, ...updates[role] } : item]))), []);

  const begin = useCallback(async (files: ScannedPdf[], pages?: number[]) => {
    if (!port || !draftId || !files.length) return;
    setTracked((current) => ({ ...current, ...Object.fromEntries(files.map((file) =>
      [file.role, { ...current[file.role], ...file, recognized: current[file.role]?.recognized ?? 0,
        state: "running" as const, pages: pages ?? [], error: undefined }])) }));
    await (pending.current = pending.current.then(() => port.start(draftId, files.map(({ role }) => role), pages))
      .then((started) => merge(Object.fromEntries(started.map((item) => [item.role,
        { documentId: item.documentId, ...(item.done ? { state: "done" as const } : {}) }]))))
      .catch((error: Error) => merge(Object.fromEntries(files.map(({ role }) =>
        [role, { state: "failed" as const, error: error.message }])))));
  }, [draftId, merge, port]);

  const stop = useCallback(async (roles: string[], paused: boolean) => {
    if (!port || !draftId || !roles.length) return;
    const stopped = Object.fromEntries(roles.map((role) => [role,
      { state: paused ? "paused" as const : "cancelled" as const }]));
    merge(stopped);
    await (pending.current = pending.current.then(() => port.cancel(draftId, roles)).then(() => merge(stopped))
      .catch((error: Error) => merge(Object.fromEntries(
        roles.map((role) => [role, { state: "failed" as const, error: error.message }])))));
  }, [draftId, merge, port]);

  const watching = Object.values(tracked)
    .flatMap(({ state, documentId }) => state === "running" && documentId ? [documentId] : [])
    .sort().join(",");
  useEffect(() => {
    if (!port || !watching) return;
    let polling = false, disposed = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const states = new Map((await port.progress(watching.split(",")).catch(() => []))
        .map((state) => [state.id, state]));
      polling = false;
      if (disposed) return;
      setTracked((current) => {
        let changed = false;
        const next = Object.fromEntries(Object.entries(current).map(([role, item]) => {
          const state = item.state === "running" && item.documentId
            ? states.get(item.documentId) : undefined;
          if (!state) return [role, item];
          // A pass is opaque while it runs, so pages count as recognized only once it ends:
          // the cited pages when the whole-PDF pass takes over, the whole PDF when it finishes.
          const updated: SourceOcrStatus = { ...item, pages: state.pages ?? [], error: state.error,
            recognized: state.done ? state.pages?.length
              ? Math.max(item.recognized, item.textlessPages.filter(page => state.pages!.includes(page)).length)
              : item.textlessPages.length
              : state.pages?.length ? item.recognized
                : Math.max(item.recognized, item.pages?.length ?? 0),
            state: state.done ? "done" : state.error ? "failed" : "running" };
          const same = updated.state === item.state && updated.error === item.error &&
            updated.recognized === item.recognized && updated.pages!.join() === (item.pages ?? []).join();
          if (!same) changed = true;
          return [role, same ? item : updated];
        }));
        // An unchanged poll keeps the same state object, so the workspace does not re-render.
        return changed ? next : current;
      });
    };
    const timer = setInterval(() => void poll(), 1_200);
    return () => { disposed = true; clearInterval(timer); };
  }, [port, watching]);

  return { tracked: port ? tracked : {}, begin, stop,
    reset: useCallback(() => setTracked({}), []) };
}

/** Textless pages per source role and content hash; null when every page has text. */
type ScanCache = Map<string, number[] | null>;

async function inspectSources(host: AuthoritiesHost, draft: AuthoritiesProduct, cache: ScanCache,
  report: (message: string) => void, found: (file: ScannedPdf) => void, signal: AbortSignal) {
  const files: ScannedPdf[] = [], errors: string[] = [];
  for (const id of draft.state.authorityOrder) {
    const authority = draft.state.authorities[id];
    if (authority.excluded || authority.source.kind !== "attached") continue;
    for (const source of authority.source.sources) {
      signal.throwIfAborted();
      if (source.origin === "reconstructed" || !host.readSource) continue;
      // A PDF is read once per content: binding another source does not rescan the book.
      const cacheKey = `${source.bindingRole}:${source.sourceSha256}`;
      let textlessPages = cache.get(cacheKey);
      if (textlessPages === undefined) {
        report(`Checking pages in ${authorityName(authority)}`);
        try {
          const blob = await host.readSource(draft, source.bindingRole, signal);
          const inspected = await inspectPdf(new File([blob], source.filename,
            { type: "application/pdf" }), undefined, signal);
          if (!inspected.pageCount) throw new Error(`Unlock the PDF for ${authorityName(authority)} before continuing.`);
          textlessPages = inspected.textlessPages.length ? inspected.textlessPages : null;
          cache.set(cacheKey, textlessPages);
        } catch (error) {
          // One unreadable source is reported without hiding the scans after it.
          signal.throwIfAborted();
          errors.push(error instanceof Error ? error.message : String(error));
          continue;
        }
      }
      if (textlessPages) {
        const file = { role: source.bindingRole, sourceSha256: source.sourceSha256,
          name: authorityName(authority), textlessPages };
        files.push(file); found(file);
      }
    }
  }
  return { files, error: errors[0] ?? "" };
}

type ScanStatus = { key: string; host: AuthoritiesHost; files: ScannedPdf[]; checking: boolean;
  progress: string; error: string };
const scanStart = (key: string, host: AuthoritiesHost): ScanStatus =>
  ({ key, host, files: [], checking: true, progress: "Checking PDFs", error: "" });

export function useScannedSources(host: AuthoritiesHost, draft: AuthoritiesProduct | undefined,
  key: string, found: (file: ScannedPdf) => void) {
  const [stored, setStatus] = useState<ScanStatus>();
  const onFound = useEffectEvent(found);
  const cache = useRef<ScanCache>(new Map());
  useEffect(() => {
    const abort = new AbortController();
    // Every update starts from this scan's own status, never a previous key's.
    const update = (patch: Partial<ScanStatus>) => setStatus((current) =>
      ({ ...(current?.key === key && current.host === host ? current : scanStart(key, host)), ...patch }));
    void (draft && host.readSource ? inspectSources(host, draft, cache.current,
      (progress) => { if (!abort.signal.aborted) update({ progress }); },
      (file) => { if (!abort.signal.aborted) onFound(file); }, abort.signal)
      : Promise.resolve({ files: [], error: "" }))
      .then(({ files, error }) => { if (!abort.signal.aborted) update({ files, checking: false, progress: "", error }); })
      .catch((error: Error) => { if (!abort.signal.aborted) update({ checking: false, progress: "", error: error.message }); });
    return () => abort.abort();
  }, [host, key]);
  // A scan that has not reported yet reads as just started.
  const { files, checking, progress, error } =
    stored?.key === key && stored.host === host ? stored : scanStart(key, host);
  return { key, files, checking, progress, error };
}
