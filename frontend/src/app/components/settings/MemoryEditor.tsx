import { useEffect, useId, useState } from "react";
import { clearMemory, getMemory, saveMemory, type MemoryFile } from "@/app/lib/api/memory";
import { errorMessage } from "@/app/lib/utils";
import { Button } from "../ui/button";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { useMfaAction } from "../account/useMfaAction";
import { AccountSection } from "@/app/(pages)/account/AccountSection";
import { ModalTextarea } from "../modals/ModalTextarea";
import { Switch } from "../ui/switch";

export function MemoryEditor({ projectId }: { projectId?: string }) {
  return <MemoryEditorContent key={projectId ?? "app"} projectId={projectId} />;
}
function MemoryEditorContent({ projectId }: { projectId?: string }) {
  const sizeId = useId();
  const [current, setCurrent] = useState<MemoryFile | null>(null), [content, setContent] = useState("");
  const [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [revision, reload] = useState(0), [clearing, setClearing] = useState(false), [saved, setSaved] = useState(false);
  const { runMfa, mfaPopup } = useMfaAction();
  const adopt = (value: MemoryFile) => { setCurrent(value); setContent(value.content); setEnabled(value.enabled); };
  useEffect(() => {
    let cancelled = false; setCurrent(null); setError(""); setSaved(false);
    getMemory(projectId).then((value) => { if (!cancelled) adopt(value); })
      .catch((error) => { if (!cancelled) setError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [projectId, revision]);
  const mutate = (work: () => Promise<MemoryFile>) => void runMfa(async () => {
    setBusy(true); setError(""); setSaved(false);
    try { adopt(await work()); setClearing(false); setSaved(true); }
    finally { setBusy(false); }
  }, { onError: (error) => { setError(errorMessage(error)); setClearing(false); } });
  const bytes = new TextEncoder().encode(content).length;
  const dirty = current && (current.content !== content || current.enabled !== enabled);
  return <div className="space-y-4">
    <p className="text-sm leading-6 text-gray-600">{projectId
      ? "Shared with everyone who can view this project. Editors can update it."
      : "Private to you and excluded from shared conversations."}</p>
    {error && <div role="alert" className="space-y-2 text-sm text-red-700 dark:text-red-400"><p>{error}</p>
      <Button variant="outline" disabled={busy} onClick={() => reload((value) => value + 1)}>Reload saved memory</Button></div>}
    {!current && !error && <p role="status">Loading memory...</p>}
    {current && <form onSubmit={(event) => {
      event.preventDefault(); mutate(() => saveMemory(projectId, { revision: current.revision, content, enabled }));
    }}>
      <AccountSection className="space-y-5 p-4">
      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-gray-900">Use and learn memory</span>
          <span className="mt-1 block text-xs leading-5 text-gray-500">Learn lasting details after five minutes of inactivity. Earlier chats are not scanned.</span>
        </span>
        <span className="grid size-11 shrink-0 place-items-center"><Switch checked={enabled} size="md"
          ariaLabel="Use and learn memory" disabled={busy || !current.canEdit}
          onChange={(value) => { setEnabled(value); setSaved(false); }} /></span>
      </label>
      <div className="space-y-2">
      <label className="grid gap-2 text-sm font-medium text-gray-900">Memory text<ModalTextarea value={content} rows={8} readOnly={!current.canEdit}
        disabled={busy} onChange={(event) => { setContent(event.target.value); setSaved(false); }}
        aria-describedby={sizeId} spellCheck className="min-h-48 font-normal" /></label>
      <p id={sizeId} className={`text-right text-xs tabular-nums ${bytes > 16384 ? "text-red-700 dark:text-red-400" : "text-gray-500"}`}>{bytes.toLocaleString()} / 16,384 bytes</p>
      </div>
      <p className="text-xs leading-5 text-gray-500">Changes take effect when saved. Pausing keeps the text.</p>
      {current.canEdit && <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" className="px-0 text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300" disabled={busy} onClick={() => setClearing(true)}>Delete memory</Button>
        <div className="flex items-center gap-3">{saved && <p role="status" className="text-sm text-gray-600">Saved.</p>}
          <Button type="submit" disabled={busy || !dirty || bytes > 16384}>Save</Button></div>
      </div>}
      {!current.canEdit && <p className="text-sm text-gray-600">You have viewer access.</p>}
      </AccountSection>
    </form>}
    <ConfirmPopup open={clearing} title="Delete memory?" message="This clears the saved text and cancels pending learning. The enabled setting stays as it is."
      confirmLabel="Delete memory" confirmStatus={busy ? "loading" : "idle"} onCancel={() => setClearing(false)}
      onConfirm={() => current && mutate(() => clearMemory(projectId, current.revision))} />
    {mfaPopup}
  </div>;
}
