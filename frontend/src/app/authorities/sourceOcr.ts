import { useCallback, useEffect, useRef, useState } from "react";
import { inspectPdf } from "@/app/lib/inspectPdf";
import { authorityName } from "./authorityPresentation";
import type { AuthoritiesHost } from "./host";
import type { AuthoritiesProduct } from "./types";

type ScannedPdf = { role: string; name: string; textlessPages: number[] };
export type SourceOcrStatus = ScannedPdf & { documentId?: string; page?: number;
  error?: string; state: "running" | "paused" | "done" | "failed" };

/**
 * Scanned source PDFs are recognized by the durable PDF queue, cited pages first,
 * and the workspace watches that queue instead of holding recognition in a request.
 */
export function useSourceOcr(host: AuthoritiesHost, draftId?: string) {
  const [tracked, setTracked] = useState<Record<string, SourceOcrStatus>>({});
  const port = host.sourceOcr;
  const merge = useCallback((updates: Record<string, Partial<SourceOcrStatus>>) =>
    setTracked((current) => Object.fromEntries(Object.entries(current).map(([role, item]) =>
      [role, updates[role] ? { ...item, ...updates[role] } : item]))), []);

  const begin = useCallback(async (files: ScannedPdf[]) => {
    if (!port || !draftId || !files.length) return;
    setTracked((current) => ({ ...current, ...Object.fromEntries(files.map((file) =>
      [file.role, { ...file, state: "running" as const, error: undefined }])) }));
    await port.start(draftId, files.map(({ role }) => role))
      .then((started) => merge(Object.fromEntries(started.map((item) => [item.role, item]))))
      .catch((error: Error) => merge(Object.fromEntries(files.map(({ role }) =>
        [role, { state: "failed" as const, error: error.message }]))));
  }, [draftId, merge, port]);

  const stop = useCallback(async (roles: string[], paused: boolean) => {
    if (!port || !draftId || !roles.length) return;
    if (paused) merge(Object.fromEntries(roles.map((role) => [role, { state: "paused" as const }])));
    else setTracked((current) => Object.fromEntries(
      Object.entries(current).filter(([role]) => !roles.includes(role))));
    await port.cancel(draftId, roles).catch(() => undefined);
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
  report: (message: string) => void) {
  const files: ScannedPdf[] = [];
  for (const id of draft.state.authorityOrder) {
    const authority = draft.state.authorities[id];
    if (authority.excluded || authority.source.kind !== "attached") continue;
    for (const source of authority.source.sources) {
      if (source.origin === "reconstructed" || !host.readSource) continue;
      report(`Checking pages in ${authorityName(authority)}`);
      const blob = await host.readSource(draft, source.bindingRole);
      const inspected = await inspectPdf(new File([blob], source.filename,
        { type: "application/pdf" }));
      if (!inspected.pageCount) throw new Error(`Unlock the PDF for ${authorityName(authority)} before continuing.`);
      if (inspected.textlessPages.length) files.push({ role: source.bindingRole,
        name: authorityName(authority), textlessPages: inspected.textlessPages });
    }
  }
  return files;
}

/**
 * Which sources are scans is settled in the background while the Sources list is
 * already on screen, so continuing does not pay for the whole check at once.
 */
export function useScannedSources(host: AuthoritiesHost, draft: AuthoritiesProduct | undefined,
  key: string, active: boolean) {
  const cached = useRef<{ key: string; report: (message: string) => void;
    result: Promise<ScannedPdf[]> }>(undefined);
  const ensure = useCallback((current: AuthoritiesProduct, report: (message: string) => void) => {
    const running = cached.current;
    // The check reports to whoever is waiting on it now, so continuing while the
    // background pass is still going shows that pass's progress.
    if (running?.key === key) { running.report = report; return running.result; }
    const entry = { key, report, result: undefined as unknown as Promise<ScannedPdf[]> };
    entry.result = inspectSources(host, current, (message) => entry.report(message));
    cached.current = entry;
    // A failed check is never remembered: the next attempt runs again and reports
    // its own reason instead of replaying a stale rejection for ever.
    entry.result.catch(() => { if (cached.current === entry) cached.current = undefined; });
    return entry.result;
  }, [host, key]);
  useEffect(() => {
    if (!active || !draft || !host.readSource) return;
    const timer = setTimeout(() => void ensure(draft, () => undefined)
      .catch(() => undefined), 400);
    return () => clearTimeout(timer);
  }, [active, draft, ensure, host]);
  return ensure;
}
