import { useCallback, useEffect, useRef, useState } from "react";
import { inspectPdf } from "@/app/lib/inspectPdf";
import { authorityName } from "./authorityPresentation";
import type { AuthoritiesHost } from "./host";
import type { AuthoritiesProduct } from "./types";

type ScannedPdf = { role: string; name: string; sourceSha256: string; textlessPages: number[] };
export type SourceOcrStatus = ScannedPdf & { documentId?: string; page?: number;
  error?: string; state: "running" | "paused" | "cancelled" | "done" | "failed" };

/**
 * Scanned source PDFs are recognized by the durable PDF queue, cited pages first,
 * and the workspace watches that queue instead of holding recognition in a request.
 */
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

/**
 * Which sources are scans is settled in the background while the Sources list is
 * already on screen, so continuing does not pay for the whole check at once.
 */
export function useScannedSources(host: AuthoritiesHost, draft: AuthoritiesProduct | undefined,
  key: string, found: (file: ScannedPdf) => void) {
  const [status, setStatus] = useState({ progress: "", error: "" });
  const onFound = useRef(found); onFound.current = found;
  const cached = useRef<{ key: string; report: (message: string) => void;
    abort: AbortController; result: Promise<ScannedPdf[]> }>(undefined);
  const ensure = useCallback((current: AuthoritiesProduct, report: (message: string) => void) => {
    const running = cached.current;
    if (running?.key === key) { running.report = report; return running.result; }
    running?.abort.abort();
    const entry = { key, report, abort: new AbortController(), result: undefined as unknown as Promise<ScannedPdf[]> };
    entry.result = inspectSources(host, current, (message) => {
      setStatus({ progress: message, error: "" }); entry.report(message);
    }, (file) => onFound.current(file), entry.abort.signal).then((files) => {
      if (!entry.abort.signal.aborted) setStatus({ progress: "", error: "" });
      return files;
    });
    cached.current = entry;
    entry.result.catch((error: Error) => {
      if (cached.current === entry) cached.current = undefined;
      if (!entry.abort.signal.aborted) setStatus({ progress: "", error: error.message });
    });
    return entry.result;
  }, [host, key]);
  useEffect(() => {
    if (draft && host.readSource) void ensure(draft, () => undefined).catch(() => undefined);
    return () => { cached.current?.abort.abort(); cached.current = undefined; };
  }, [ensure]);
  return { ensure, ...status };
}
