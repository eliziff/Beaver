import { useCallback, useEffect, useRef, useState } from "react";
import { inspectPdf } from "@/app/lib/inspectPdf";
import { authorityName } from "./authorityPresentation";
import type { AuthoritiesHost } from "./host";
import type { ScannedAuthorityPdf } from "./SourceOcrModal";
import type { AuthoritiesProduct } from "./types";

export type SourceOcrStatus = ScannedAuthorityPdf & {
  documentId?: string; state: "running" | "paused" | "done" | "failed";
  page?: number; error?: string;
};

/**
 * Scanned source PDFs are recognized by the durable PDF queue, cited pages first.
 * The workspace watches that queue rather than holding recognition in a request.
 */
export function useSourceOcr(host: AuthoritiesHost, draftId?: string) {
  const [tracked, setTracked] = useState<Record<string, SourceOcrStatus>>({});
  const port = host.sourceOcr;
  const patch = useCallback((role: string, update: Partial<SourceOcrStatus>) =>
    setTracked((current) => current[role]
      ? { ...current, [role]: { ...current[role], ...update } } : current), []);

  const begin = useCallback(async (files: ScannedAuthorityPdf[]) => {
    if (!port || !draftId || !files.length) return;
    setTracked((current) => ({ ...current,
      ...Object.fromEntries(files.map((file) => [file.role,
        { ...file, ...current[file.role], state: "running" as const, error: undefined }])) }));
    try {
      for (const started of await port.start(draftId, files.map(({ role }) => role)))
        patch(started.role, { documentId: started.documentId });
    } catch (error) {
      for (const { role } of files)
        patch(role, { state: "failed", error: (error as Error).message });
    }
  }, [draftId, patch, port]);

  const stop = useCallback(async (roles: string[], paused: boolean) => {
    if (!port || !draftId || !roles.length) return;
    if (paused) for (const role of roles) patch(role, { state: "paused" });
    else setTracked((current) => Object.fromEntries(
      Object.entries(current).filter(([role]) => !roles.includes(role))));
    await port.cancel(draftId, roles).catch(() => undefined);
  }, [draftId, patch, port]);

  const watching = Object.values(tracked)
    .filter(({ state, documentId }) => state === "running" && documentId)
    .map(({ documentId }) => documentId).sort().join(",");
  useEffect(() => {
    if (!port || !watching) return;
    let live = true;
    const poll = async () => {
      const states = await port.progress(watching.split(",")).catch(() => []);
      if (!live) return;
      setTracked((current) => {
        const byDocument = new Map(states.map((state) => [state.id, state]));
        return Object.fromEntries(Object.entries(current).map(([role, item]) => {
          const state = item.documentId && item.state === "running"
            ? byDocument.get(item.documentId) : undefined;
          if (!state) return [role, item];
          return [role, { ...item, page: state.page,
            state: state.done ? "done" : state.error ? "failed" : "running",
            ...(state.error ? { error: state.error } : {}) }];
        }));
      });
    };
    const timer = setInterval(() => void poll(), 1_200);
    void poll();
    return () => { live = false; clearInterval(timer); };
  }, [port, watching]);

  return { tracked: port ? tracked : {}, begin, stop,
    reset: useCallback(() => setTracked({}), []) };
}

async function inspectSources(host: AuthoritiesHost, draft: AuthoritiesProduct,
  report: (message: string) => void, signal: AbortSignal) {
  const files: ScannedAuthorityPdf[] = [];
  for (const id of draft.state.authorityOrder) {
    const authority = draft.state.authorities[id];
    if (authority.excluded || authority.source.kind !== "attached") continue;
    for (const source of authority.source.sources) {
      if (source.origin === "reconstructed" || !host.readSource) continue;
      signal.throwIfAborted();
      report(`Checking pages in ${authorityName(authority)}`);
      const blob = await host.readSource(draft, source.bindingRole);
      const inspected = await inspectPdf(new File([blob], source.filename,
        { type: "application/pdf" }), undefined, signal);
      if (!inspected.pageCount) throw new Error(`Unlock the PDF for ${authorityName(authority)} before continuing.`);
      if (inspected.textlessPages.length) files.push({ role: source.bindingRole,
        name: authorityName(authority), pageCount: inspected.pageCount,
        textlessPages: inspected.textlessPages });
    }
  }
  return files;
}

/**
 * Which source PDFs are scans is settled in the background while the Sources list
 * is already on screen, so continuing does not pay for the whole check at once.
 */
export function useScannedSources(host: AuthoritiesHost, draft: AuthoritiesProduct | undefined,
  key: string, active: boolean) {
  const cached = useRef<{ key: string; result: Promise<ScannedAuthorityPdf[]> }>(undefined);
  const ensure = useCallback((current: AuthoritiesProduct,
    report: (message: string) => void, signal: AbortSignal) => {
    if (cached.current?.key !== key) {
      cached.current = { key, result: inspectSources(host, current, report,
        new AbortController().signal) };
      cached.current.result.catch(() => undefined);
    }
    signal.throwIfAborted();
    return cached.current.result;
  }, [host, key]);
  useEffect(() => {
    if (!active || !draft || !host.readSource) return;
    // Defer past the first paint of the Sources list.
    const timer = setTimeout(() => {
      void ensure(draft, () => undefined, new AbortController().signal).catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  }, [active, draft, ensure, host]);
  return ensure;
}
