import { useEffect, useId, useState } from "react";
import { clearMemory, getMemory, saveMemory, type MemoryFile } from "@/app/lib/api/memory";
import { errorMessage } from "@/app/lib/utils";
import { Button } from "../ui/button";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { useMfaAction } from "../account/useMfaAction";

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
    <p className="text-sm text-gray-600">{projectId
      ? "Project memory is shared with everyone who can view this project. Editors can update it."
      : "App memory is private to you. It is excluded from shared conversations."} Memory starts off.
      When enabled, completed conversations can add lasting facts after five minutes of inactivity.</p>
    {error && <div role="alert" className="space-y-2 text-sm text-red-700"><p>{error}</p>
      <Button variant="outline" disabled={busy} onClick={() => reload((value) => value + 1)}>Reload saved memory</Button></div>}
    {!current && !error && <p role="status">Loading memory...</p>}
    {current && <form className="space-y-3" onSubmit={(event) => {
      event.preventDefault(); mutate(() => saveMemory(projectId, { revision: current.revision, content, enabled }));
    }}>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled}
        disabled={busy || !current.canEdit} onChange={(event) => { setEnabled(event.target.checked); setSaved(false); }} />Use and learn memory</label>
      <p className="text-xs text-gray-600">Pausing keeps the saved text. Changes take effect when you save. Earlier conversations are not scanned.</p>
      <label className="grid gap-2 text-sm">Memory text<textarea value={content} rows={12} readOnly={!current.canEdit}
        disabled={busy} onChange={(event) => { setContent(event.target.value); setSaved(false); }}
        aria-describedby={sizeId} spellCheck className="min-h-48 w-full resize-y rounded-lg border border-gray-300 bg-white p-3 text-sm text-gray-900" /></label>
      <p id={sizeId} className={`text-xs ${bytes > 16384 ? "text-red-700" : "text-gray-500"}`}>{bytes.toLocaleString()} / 16,384 bytes</p>
      {current.canEdit && <div className="flex gap-2"><Button type="submit" disabled={busy || !dirty || bytes > 16384}>Save</Button>
        <Button variant="outline" disabled={busy} onClick={() => setClearing(true)}>Delete memory</Button></div>}
      {saved && <p role="status" className="text-sm text-gray-600">Saved.</p>}
      {!current.canEdit && <p className="text-sm text-gray-600">You have viewer access.</p>}
    </form>}
    <ConfirmPopup open={clearing} title="Delete memory?" message="This clears the saved text and cancels pending learning. The enabled setting stays as it is."
      confirmLabel="Delete memory" confirmStatus={busy ? "loading" : "idle"} onCancel={() => setClearing(false)}
      onConfirm={() => current && mutate(() => clearMemory(projectId, current.revision))} />
    {mfaPopup}
  </div>;
}
