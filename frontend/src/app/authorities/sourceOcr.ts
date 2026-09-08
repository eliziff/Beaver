import { useCallback, useEffect, useRef, useState } from "react";
import { inspectPdf } from "@/app/lib/inspectPdf";
import { authorityName } from "./authorityPresentation";
import type { AuthoritiesHost } from "./host";
import type { AuthoritiesProduct } from "./types";

export type ScannedPdf = { role: string; name: string; sourceSha256: string; textlessPages: number[] };
export type SourceOcrStatus = ScannedPdf & { documentId?: string; page?: number;
  error?: string; state: "running" | "paused" | "cancelled" | "done" | "failed" };

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
      [file.role, { ...file, state: "running" as const, error: undefined }])) }));
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
    const poll = async () => {
      const states = new Map((await port.progress(watching.split(",")).catch(() => []))
        .map((state) => [state.id, state]));
      setTracked((current) => Object.fromEntries(Object.entries(current).map(([role, item]) => {
        const state = item.state === "running" && item.documentId
          ? states.get(item.documentId) : undefined;
        return [role, state ? { ...item, page: state.page, error: state.error,
          state: state.done ? "done" : state.error ? "failed" : "running" } : item];
      })));
    };
    const timer = setInterval(() => void poll(), 1_200);
    return () => clearInterval(timer);
  }, [port, watching]);

  return { tracked: port ? tracked : {}, begin, stop,
    reset: useCallback(() => setTracked({}), []) };
}

async function inspectSources(host: AuthoritiesHost, draft: AuthoritiesProduct,
  report: (message: string) => void, found: (file: ScannedPdf) => void, signal: AbortSignal) {
  const files: ScannedPdf[] = [];
  for (const id of draft.state.authorityOrder) {
    const authority = draft.state.authorities[id];
    if (authority.excluded || authority.source.kind !== "attached") continue;
    for (const source of authority.source.sources) {
      signal.throwIfAborted();
      if (source.origin === "reconstructed" || !host.readSource) continue;
      report(`Checking pages in ${authorityName(authority)}`);
      const blob = await host.readSource(draft, source.bindingRole);
      const inspected = await inspectPdf(new File([blob], source.filename,
        { type: "application/pdf" }), undefined, signal);
      if (!inspected.pageCount) throw new Error(`Unlock the PDF for ${authorityName(authority)} before continuing.`);
      if (inspected.textlessPages.length) {
        const file = { role: source.bindingRole, sourceSha256: source.sourceSha256,
          name: authorityName(authority), textlessPages: inspected.textlessPages };
        files.push(file); found(file);
      }
    }
  }
  return files;
}

export function useScannedSources(host: AuthoritiesHost, draft: AuthoritiesProduct | undefined,
  key: string, found: (file: ScannedPdf) => void) {
  const [status, setStatus] = useState({ key: "", files: [] as ScannedPdf[], checking: true, progress: "", error: "" });
  const onFound = useRef(found); onFound.current = found;
  useEffect(() => {
    const abort = new AbortController();
    setStatus({ key, files: [], checking: true, progress: "Checking PDFs", error: "" });
    void (draft && host.readSource ? inspectSources(host, draft,
      (progress) => { if (!abort.signal.aborted) setStatus(current => ({ ...current, progress })); },
      (file) => { if (!abort.signal.aborted) onFound.current(file); }, abort.signal) : Promise.resolve([]))
      .then(files => { if (!abort.signal.aborted) setStatus({ key, files, checking: false, progress: "", error: "" }); })
      .catch((error: Error) => { if (!abort.signal.aborted) setStatus(current =>
        ({ ...current, checking: false, progress: "", error: error.message })); });
    return () => abort.abort();
  }, [host, key]);
  return { ...status, checking: status.key !== key || status.checking };
}
