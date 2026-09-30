import { citedSourcePages } from "../../../../shared/cited-source-pages.mjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { inspectPdf, type PdfInspection } from "@/app/lib/inspectPdf";
import { authorityName } from "./authorityPresentation";
import type { AuthoritiesHost } from "./host";
import type { AuthoritiesProduct } from "./types";
import { canonicalJson } from "../../../../shared/canonical-json.mjs";

export type ScannedPdf = { role: string; name: string; sourceSha256: string; textlessPages: number[]; priorityPages?: number[]; demand?: string };
/** `pages` is the pass being read now (empty for the whole PDF); `recognized` is what it has finished. */
export type SourceOcrStatus = ScannedPdf & { documentId?: string; pages?: number[]; recognized: number;
  error?: string; state: "running" | "paused" | "cancelled" | "done" | "failed" };

/** What a step needs to watch and steer recognition, without owning it. */
export type SourceOcrPanel = Pick<ReturnType<typeof useSourceOcr>, "tracked" | "begin" | "stop">;

export function useSourceOcr(host: AuthoritiesHost, draftId?: string) {
  const [tracked, setTracked] = useState<Record<string, SourceOcrStatus>>({});
  const pending = useRef(Promise.resolve());
  const operations = useRef(new Map<string, object>());
  const port = host.sourceOcr;
  const merge = useCallback((updates: Record<string, Partial<SourceOcrStatus>>) =>
    setTracked((current) => Object.fromEntries(Object.entries(current).map(([role, item]) =>
      [role, updates[role] ? { ...item, ...updates[role] } : item]))), []);

  const begin = useCallback(async (files: ScannedPdf[], pages?: number[]) => {
    if (!port || !draftId || !files.length) return;
    const operation = {};
    files.forEach(file => operations.current.set(file.role, operation));
    const update = (updates: Record<string, Partial<SourceOcrStatus>>) =>
      merge(Object.fromEntries(Object.entries(updates).filter(([role]) => operations.current.get(role) === operation)));
    setTracked((current) => ({ ...current, ...Object.fromEntries(files.map((file) =>
      [file.role, { ...current[file.role], ...file, recognized: current[file.role]?.sourceSha256 === file.sourceSha256
        ? current[file.role].recognized : 0,
        state: "running" as const, pages: pages ?? [], error: undefined }])) }));
    await (pending.current = pending.current.then(async () => (await Promise.all(files.filter(file => operations.current.get(file.role) === operation).map(file => {
      const selection = pages ?? file.priorityPages;
      return port.start(draftId, [file.role], selection?.length ? selection : undefined, {[file.role]:file.textlessPages});
    }))).flat())
      .then((started) => update(Object.fromEntries(started.map((item) => [item.role,
        { documentId: item.documentId, ...(item.done ? { state: "done" as const } : {}) }]))))
      .catch((error: Error) => update(Object.fromEntries(files.map(({ role }) =>
        [role, { state: "failed" as const, error: error.message }])))));
  }, [draftId, merge, port]);

  const stop = useCallback(async (roles: string[], paused: boolean) => {
    if (!port || !draftId || !roles.length) return;
    const operation = {};
    roles.forEach(role => operations.current.set(role, operation));
    const stopped = Object.fromEntries(roles.map((role) => [role,
      { state: paused ? "paused" as const : "cancelled" as const }]));
    merge(stopped);
    await (pending.current = pending.current.then(async () => { await port.cancel(draftId, roles); })
      .catch((error: Error) => merge(Object.fromEntries(
        roles.filter(role => operations.current.get(role) === operation)
          .map((role) => [role, { state: "failed" as const, error: error.message }])))));
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
      const requested = new Map(operations.current);
      const states = new Map((await port.progress(watching.split(",")).catch(() => []))
        .map((state) => [state.id, state]));
      polling = false;
      if (disposed) return;
      setTracked((current) => {
        let changed = false;
        const next = Object.fromEntries(Object.entries(current).map(([role, item]) => {
          const state = requested.get(role) === operations.current.get(role) && item.state === "running" && item.documentId
            ? states.get(item.documentId) : undefined;
          if (!state) return [role, item];
          // A pass is opaque while it runs, so pages count as recognized only once it ends:
          // the cited pages when the whole-PDF pass takes over, the whole PDF when it finishes.
          const updated: SourceOcrStatus = { ...item, pages: state.pages ?? [], error: state.error,
            recognized: state.recognized ?? (state.done ? state.pages?.length
              ? Math.max(item.recognized, item.textlessPages.filter(page => state.pages!.includes(page)).length)
              : item.textlessPages.length
              : state.pages?.length ? item.recognized
                : Math.max(item.recognized, item.pages?.length ?? 0)),
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
    reset: useCallback(() => { operations.current.clear(); setTracked({}); }, []) };
}

/** Reuse native text and page labels when deriving each source's priority pages. */
type ScanCache = Map<string, Pick<PdfInspection, "textlessPages" | "pageTexts" | "pageLabels" | "pageCount">>;

async function inspectSources(host: AuthoritiesHost, draft: AuthoritiesProduct, cache: ScanCache,
  report: (message: string) => void, signal: AbortSignal) {
  const files: ScannedPdf[] = [], errors: string[] = [];
  for (const id of draft.state.authorityOrder) {
    const authority = draft.state.authorities[id];
    if (authority.excluded || authority.source.kind !== "attached") continue;
    for (const source of authority.source.sources) {
      signal.throwIfAborted();
      if (source.origin === "reconstructed" || !host.readSource) continue;
      // A PDF is read once per content: binding another source does not rescan the book.
      const cacheKey = `${source.bindingRole}:${source.sourceSha256}`;
      let inspected = cache.get(cacheKey);
      if (inspected === undefined) {
        report(`Checking pages in ${authorityName(authority)}`);
        try {
          const blob = await host.readSource(draft, source.bindingRole, signal);
          inspected = await inspectPdf(new File([blob], source.filename,
            { type: "application/pdf" }), undefined, signal);
          if (!inspected.pageCount) throw new Error(`Unlock the PDF for ${authorityName(authority)} before continuing.`);
          cache.set(cacheKey, inspected);
        } catch (error) {
          // One unreadable source is reported without hiding the scans after it.
          signal.throwIfAborted();
          errors.push(error instanceof Error ? error.message : String(error));
          continue;
        }
      }
      const textlessPages = inspected.textlessPages;
      if (textlessPages.length) {
        const labels = inspected.pageLabels ? new Map<string, number[]>() : undefined;
        inspected.pageLabels?.forEach((label,index) => labels!.set(label,[...(labels!.get(label) ?? []),index]));
        const priorityPages = [...citedSourcePages(draft.state, id, inspected.pageTexts, labels, inspected.pageCount)]
          .map(index => index + 1).filter(page => textlessPages.includes(page));
        const file = { role: source.bindingRole, sourceSha256: source.sourceSha256,
          name: authorityName(authority), textlessPages, priorityPages,
          demand: canonicalJson([authority.locators, Object.values(draft.state.occurrences)
            .filter(item => item.authorityId === id).map(item => [item.citation, item.pinpoints]),
          draft.state.settings.scannedPdfPolicy]) };
        files.push(file);
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
  key: string) {
  const [stored, setStatus] = useState<ScanStatus>();
  const cache = useRef<ScanCache>(new Map());
  useEffect(() => {
    const abort = new AbortController();
    // Every update starts from this scan's own status, never a previous key's.
    const update = (patch: Partial<ScanStatus>) => setStatus((current) =>
      ({ ...(current?.key === key && current.host === host ? current : scanStart(key, host)), ...patch }));
    void (draft && host.readSource ? inspectSources(host, draft, cache.current,
      (progress) => { if (!abort.signal.aborted) update({ progress }); },
      abort.signal)
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
