import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { getResearchCitation, getResearchFile } from "@/app/lib/api/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { BeaverApiError } from "@/app/lib/api/client";
import { Button } from "@/app/components/ui/button";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { researchSourceKey, type ResearchFile } from "@/app/lib/researchFiles";
import { isResearchConnectionError, type ResearchFileMutations } from "./useResearchFileMutations";
import ResearchMemoEditor from "./ResearchMemoEditor";
import { type MemoSourceReference } from "./researchMemo";
import { toValue, useMachine } from "@/app/lib/useMachine";

type Draft = { markdown: string; base: string; submitted?: string };
/** Why a save did not land, and how long until a lost connection is tried again. */
type SaveFailure = { error: string; conflict: boolean; retryIn: number };
/** The memo's save. An edit clears a failure but not its retry. The saved memo loads over a conflict, which stays on screen. */
type Saving = { kind: "idle"; retryIn: number } | { kind: "saving"; failure?: SaveFailure } | ({ kind: "failed" } & SaveFailure);
const NOT_SAVING: Saving = { kind: "idle", retryIn: 0 };
function readDraft(key: string, markdown: string): Draft {
  try {
    const draft = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (typeof draft?.markdown === "string" && typeof draft.base === "string" &&
      (draft.submitted === undefined || typeof draft.submitted === "string")) return draft;
  } catch { /* A saved server memo remains available if browser storage is unavailable. */ }
  return { markdown, base: markdown };
}

export default function ResearchMemoPane({ file, mutations, onOpenCitation }: {
  file: ResearchFile; mutations: ResearchFileMutations; onOpenCitation: (href: string) => void;
}) {
  const key = `beaver.research.memo-draft:${file.document.id}`;
  const [draft, setDraft] = useState(() => readDraft(key, file.state.note));
  const latest = useRef(draft);
  const [saveState, setSaveState, latestSave] = useMachine(toValue<Saving>, NOT_SAVING);
  const failure = saveState.kind === "failed" ? saveState : saveState.kind === "saving" ? saveState.failure : undefined;
  const saving = saveState.kind === "saving", error = failure?.error ?? "", conflict = !!failure?.conflict;
  const retry = saveState.kind === "idle" ? saveState.retryIn : failure?.retryIn ?? 0;
  const [confirmReload, setConfirmReload] = useState(false);
  const retryCount = useRef(0);
  const [addingCitation, setAddingCitation] = useState(false), [citationError, setCitationError] = useState("");
  const dirty = draft.markdown !== draft.base || draft.submitted !== undefined;
  const updateDraft = useCallback((next: Draft) => {
    latest.current = next; setDraft(next);
    try { if (next.markdown === next.base && next.submitted === undefined) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* The in-memory draft still holds the edit. */ }
  }, [key]);
  const change = useCallback((markdown: string) => { updateDraft({ ...latest.current, markdown });
    retryCount.current = 0;
    const now = latestSave.current;
    if (now.kind === "failed") setSaveState({ kind: "idle", retryIn: now.retryIn });
    else if (now.kind === "saving") setSaveState({ kind: "saving" }); }, [updateDraft, latestSave, setSaveState]);
  const save = useCallback(async () => {
    // A conflict stands until the draft changes or the saved memo loads: saving the same text again can only fail.
    const now = latestSave.current;
    if (now.kind === "saving" || now.kind === "failed" && now.conflict) return false;
    const submitted = { ...latest.current, markdown: latest.current.submitted ?? latest.current.markdown };
    if (submitted.markdown === submitted.base) return true;
    setSaveState({ kind: "saving" });
    updateDraft({ ...latest.current, submitted: submitted.markdown });
    try {
      await mutations.act({ type: "note", markdown: submitted.markdown, expectedMarkdown: submitted.base });
      const next = { ...latest.current, base: submitted.markdown, submitted: undefined }; updateDraft(next);
      retryCount.current = 0; setSaveState(NOT_SAVING);
      return next.markdown === next.base;
    } catch (reason) {
      const connection = isResearchConnectionError(reason);
      if (!connection) updateDraft({ ...latest.current, submitted: undefined });
      const conflict = reason instanceof BeaverApiError && reason.code === "memo_conflict";
      setSaveState({ kind: "failed", conflict, retryIn: connection && retryCount.current < 2 ? ++retryCount.current * 2000 : 0,
        error: connection ? "Could not connect to save. Your draft is still here."
          : conflict ? "The saved memo changed elsewhere. Your draft is still here."
            : errorMessage(reason, "Could not save memo. Your draft is still here.") });
      return false;
    }
  }, [updateDraft, mutations.act, latestSave, setSaveState]);
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
    const timer = window.setTimeout(() => { void save(); }, 700);
    return () => window.clearTimeout(timer);
  }, [dirty, draft.markdown, draft.base, draft.submitted, saving, error, save]);
  const flush = useEffectEvent(() => { void save(); });
  useEffect(() => () => flush(), []);
  useEffect(() => {
    if (latest.current.markdown !== latest.current.base || latestSave.current.kind === "saving" || latest.current.submitted !== undefined) return;
    updateDraft({ markdown: file.state.note, base: file.state.note });
  }, [file.state.note, updateDraft, latestSave]);
  const reload = async () => {
    if (latestSave.current.kind === "saving") return;
    setSaveState({ kind: "saving", failure });
    const discarded = latest.current.markdown;
    try { const saved = await getResearchFile(file.document.id);
      if (latest.current.markdown !== discarded) throw new Error("The draft changed while loading.");
      updateDraft({ markdown: saved.state.note, base: saved.state.note });
      setSaveState(NOT_SAVING); retryCount.current = 0;
    } catch { setSaveState({ kind: "failed", conflict, retryIn: retry, error: "Could not load the saved memo. Your draft is still here." }); }
    finally { setConfirmReload(false); }
  };
  const resolveReference = async ({ reference, span }: MemoSourceReference) => {
    setAddingCitation(true); setCitationError("");
    try {
      let current = file, source = Object.values(current.state.sources).find((source) =>
        researchSourceKey(source.reference) === researchSourceKey(reference));
      if (!source) {
        const next = await mutations.act({ type: "source", reference }); current = next;
        source = next.sourceId ? next.state.sources[next.sourceId] : undefined;
      }
      if (!source) throw new Error("Could not save the source for this citation.");
      if (!span) return [(await getResearchCitation(current.document.id, source.id)).href];
      const saved = await mutations.act({ type: "passage", sourceId: source.id, ...span });
      if (!saved.receipts?.length) throw new Error("Could not verify the selected passage.");
      return await Promise.all(saved.receipts.map(async (receipt) =>
        (await getResearchCitation(saved.document.id, source.id, receipt.evidence_id)).href));
    } catch (reason) { setCitationError(errorMessage(reason, "Could not add citation")); return null; }
    finally { setAddingCitation(false); }
  };
  const status = addingCitation ? "Adding citation…" : saving ? "Saving…" : retry ? "Retrying…" : error ? "Not saved"
    : dirty ? "Saving…" : "Saved";
  return <section aria-label="Workspace memo" onBlur={() => { void save(); }} className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
    <div className="flex shrink-0 items-center justify-end py-1">
      <span role="status" className="text-xs text-gray-500">{status}</span>
    </div>
    {error && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900">
      <span className="min-w-0 flex-1">{error}</span>
      {conflict && <Button variant="outline" size="compact" disabled={saving} onClick={() => setConfirmReload(true)}>Load saved memo</Button>}
    </div>}
    {citationError && <p role="alert" className="border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">{citationError}</p>}
    <ResearchMemoEditor file={file} value={draft.markdown} onChange={change} onOpenCitation={onOpenCitation}
      onResolveReference={resolveReference} onCitationError={setCitationError} />
    <ConfirmPopup open={confirmReload} onCancel={() => setConfirmReload(false)} onConfirm={() => { void reload(); }}
      confirmStatus={saving ? "loading" : "idle"}
      title="Discard this draft?" message="Loading the saved memo replaces your unsaved edits. Copy anything you want to keep first."
      confirmLabel="Discard draft and load" />
  </section>;
}
