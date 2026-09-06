import { useCallback, useEffect, useRef, useState } from "react";
import { getResearchCitation, getResearchFile } from "@/app/lib/api/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { BeaverApiError } from "@/app/lib/api/client";
import { Button } from "@/app/components/ui/button";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { researchSourceKey, type ResearchFile } from "@/app/lib/researchFiles";
import { isResearchConnectionError, type ResearchFileMutations } from "./useResearchFileMutations";
import ResearchMemoEditor from "./ResearchMemoEditor";
import { type MemoSourceReference } from "./researchMemo";

type Draft = { markdown: string; base: string; submitted?: string };
function readDraft(key: string, markdown: string): Draft {
  try {
    const draft = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (typeof draft?.markdown === "string" && typeof draft.base === "string" &&
      (draft.submitted === undefined || typeof draft.submitted === "string")) return draft;
  } catch { /* A saved server memo remains available if browser storage is unavailable. */ }
  return { markdown, base: markdown };
}

export default function ResearchMemoPane({ file, mutations, onOpenCitation, citation }: {
  file: ResearchFile; mutations: ResearchFileMutations; onOpenCitation: (href: string) => void;
  citation?: { href: string; sequence: number };
}) {
  const key = `beaver.research.memo-draft:${file.document.id}`;
  const [draft, setDraft] = useState(() => readDraft(key, file.state.note));
  const latest = useRef(draft); latest.current = draft;
  const [saving, setSaving] = useState(false), pending = useRef(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false), [confirmReload, setConfirmReload] = useState(false);
  const [retry, setRetry] = useState(0), retryCount = useRef(0);
  const [addingCitation, setAddingCitation] = useState(false), [citationError, setCitationError] = useState("");
  const dirty = draft.markdown !== draft.base || draft.submitted !== undefined;
  const updateDraft = useCallback((next: Draft) => {
    latest.current = next; setDraft(next);
    try { if (next.markdown === next.base && next.submitted === undefined) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* beforeunload still protects unsaved edits. */ }
  }, [key]);
  const change = useCallback((markdown: string) => updateDraft({ ...latest.current, markdown }), [updateDraft]);
  const save = useCallback(async () => {
    if (pending.current) return false;
    const submitted = { ...latest.current, markdown: latest.current.submitted ?? latest.current.markdown };
    if (submitted.markdown === submitted.base) return true;
    pending.current = true; setSaving(true); setError(""); setConflict(false); setRetry(0);
    updateDraft({ ...latest.current, submitted: submitted.markdown });
    try {
      await mutations.act({ type: "note", markdown: submitted.markdown, expectedMarkdown: submitted.base });
      const next = { ...latest.current, base: submitted.markdown, submitted: undefined }; updateDraft(next);
      retryCount.current = 0;
      return next.markdown === next.base;
    } catch (reason) {
      const connection = isResearchConnectionError(reason);
      if (!connection) updateDraft({ ...latest.current, submitted: undefined });
      const conflict = reason instanceof BeaverApiError && reason.code === "memo_conflict";
      setConflict(conflict);
      setError(connection ? "Could not connect to save. Your draft is still here."
        : conflict ? "The saved memo changed elsewhere. Your draft is still here."
          : errorMessage(reason, "Could not save memo. Your draft is still here."));
      if (connection && retryCount.current < 2) setRetry(++retryCount.current * 2000);
      return false;
    }
    finally { pending.current = false; setSaving(false); }
  }, [updateDraft, mutations.act]);
  useEffect(() => {
    if (!retry) return;
    const timer = window.setTimeout(() => { void save(); }, retry);
    return () => window.clearTimeout(timer);
  }, [retry, save]);
  useEffect(() => {
    if (!error || conflict) return;
    const reconnect = () => { retryCount.current = 0; void save(); };
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [error, conflict, save]);
  useEffect(() => {
    if (!dirty || saving || error) return;
    const timer = window.setTimeout(() => { void save(); }, 1000);
    return () => window.clearTimeout(timer);
  }, [dirty, draft.markdown, draft.base, draft.submitted, saving, error, save]);
  useEffect(() => {
    if (latest.current.markdown !== latest.current.base || pending.current || latest.current.submitted !== undefined) return;
    updateDraft({ markdown: file.state.note, base: file.state.note });
  }, [file.state.note, updateDraft]);
  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty]);
  const reload = async () => {
    if (pending.current) return;
    pending.current = true; setSaving(true);
    const discarded = latest.current.markdown;
    try { const saved = await getResearchFile(file.document.id);
      if (latest.current.markdown !== discarded) throw new Error("The draft changed while loading.");
      updateDraft({ markdown: saved.state.note, base: saved.state.note });
      setError(""); setConflict(false); setRetry(0); retryCount.current = 0;
    } catch { setError("Could not load the saved memo. Your draft is still here."); }
    finally { pending.current = false; setSaving(false); setConfirmReload(false); }
  };
  const resolveReference = async ({ reference, locator, quote }: MemoSourceReference) => {
    setAddingCitation(true); setCitationError("");
    try {
      let current = file, source = Object.values(current.state.sources).find((source) =>
        researchSourceKey(source.reference) === researchSourceKey(reference));
      if (!source) {
        const next = await mutations.act({ type: "source", reference }); current = next;
        source = next.sourceId ? next.state.sources[next.sourceId] : undefined;
      }
      if (!source) throw new Error("Could not save the source for this citation.");
      if (!locator) return (await getResearchCitation(current.document.id, source.id)).href;
      const saved = await mutations.act({ type: "passage", sourceId: source.id, locator, quote: quote ?? "" });
      if (!saved.receipt) throw new Error("Could not verify the selected passage.");
      return (await getResearchCitation(saved.document.id, source.id, saved.receipt.evidence_id)).href;
    } catch (reason) { setCitationError(errorMessage(reason, "Could not add citation")); return null; }
    finally { setAddingCitation(false); }
  };
  return <section aria-label="Workspace memo" className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
    <div className="flex shrink-0 items-center justify-end gap-2 py-1">
      <span role="status" className="text-xs text-gray-500">{addingCitation ? "Adding citation…" : saving ? "Saving…" : retry ? "Retrying…" : dirty ? "Unsaved" : "Saved"}</span>
      <Button variant="outline" size="compact" disabled={saving || !dirty} onClick={() => { retryCount.current = 0; void save(); }}>
        {error && !conflict ? "Retry save" : "Save"}</Button>
    </div>
    {error && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900">
      <span className="min-w-0 flex-1">{error}</span>
      {conflict && <Button variant="outline" size="compact" disabled={saving} onClick={() => setConfirmReload(true)}>Load saved memo</Button>}
    </div>}
    {citationError && <p role="alert" className="border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">{citationError}</p>}
    <ResearchMemoEditor file={file} value={draft.markdown} onChange={change} onOpenCitation={onOpenCitation} citation={citation}
      onResolveReference={resolveReference} onCitationError={setCitationError} />
    <ConfirmPopup open={confirmReload} onCancel={() => setConfirmReload(false)} onConfirm={() => { void reload(); }}
      confirmStatus={saving ? "loading" : "idle"}
      title="Discard this draft?" message="Loading the saved memo replaces your unsaved edits. Copy anything you want to keep first."
      confirmLabel="Discard draft and load" />
  </section>;
}
