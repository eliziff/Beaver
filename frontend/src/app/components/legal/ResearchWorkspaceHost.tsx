import { useEffect, useEffectEvent, useState } from "react";
import { AssistantDock } from "@/app/components/assistant/AssistantDock";
import { getResearchFile } from "@/app/lib/api/researchFiles";
import { BeaverApiError } from "@/app/lib/api/client";
import { Button } from "@/app/components/ui/button";
import type { ResearchFile, ResearchSource } from "@/app/lib/researchFiles";
import { ResearchFileBar } from "./ResearchFileBar";
import type { ResearchFileMutations } from "./useResearchFileMutations";

export function ResearchWorkspaceHost({ embedded, open, onOpenChange, file, projectId, onChange,
  mutations, restoreLast = true, sourceDropNonce, inline = false, rail: titleRail, onReadSource, selectedSourceId }: {
  embedded: boolean; open: boolean; onOpenChange: (open: boolean) => void;
  file: ResearchFile | null; projectId?: string; onChange: (file: ResearchFile) => void;
  mutations?: ResearchFileMutations; restoreLast?: boolean; sourceDropNonce?: number;
  inline?: boolean; rail?: HTMLElement | null;
  onReadSource?: (source: ResearchSource, locator?: string) => void;
  selectedSourceId?: string;
}) {
  const [rail, setRail] = useState<HTMLElement | null>(null);
  const [restoring, setRestoring] = useState(() => !file && restoreLast &&
    !!localStorage.getItem(`beaver.research.current:${projectId ?? "personal"}`));
  const [restoreError, setRestoreError] = useState(false), [attempt, setAttempt] = useState(0);
  const publish = useEffectEvent(onChange);
  const acceptRefresh = useEffectEvent((saved: ResearchFile, previous: ResearchFile) => {
    if (file?.document.id === previous.document.id && file.versionId === previous.versionId &&
      file.workingRevision === previous.workingRevision) onChange(saved);
  });
  const refresh = useEffectEvent(() => { if (file) { const previous = file;
    void getResearchFile(file.document.id).then((saved) => acceptRefresh(saved, previous)).catch(() => undefined); } });
  useEffect(() => { const focused = () => refresh(); window.addEventListener("focus", focused);
    return () => window.removeEventListener("focus", focused); }, []);
  useEffect(() => {
    const key = `beaver.research.current:${projectId ?? "personal"}`;
    setRestoreError(false);
    if (file) { localStorage.setItem(key, file.document.id); setRestoring(false); return; }
    const id = restoreLast ? localStorage.getItem(key) : null;
    if (!id) { setRestoring(false); return; }
    setRestoring(true);
    let live = true; void getResearchFile(id).then((saved) => { if (live) publish(saved); })
      .catch((error) => {
        if (!live) return;
        if (error instanceof BeaverApiError && error.status === 404) {
          if (localStorage.getItem(key) === id) localStorage.removeItem(key);
        } else setRestoreError(true);
      }).finally(() => { if (live) setRestoring(false); });
    return () => { live = false; };
  }, [file, projectId, restoreLast, attempt]);
  const body = restoring ? <p role="status" className="py-4 text-sm text-gray-600">Opening workspace…</p>
    : restoreError ? <div className="space-y-3 py-4">
      <p role="alert" className="text-sm text-red-700">Could not open the saved workspace. Try again.</p>
      <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
    </div> : <ResearchFileBar file={file} projectId={projectId}
    onChange={onChange} mutations={mutations} rail={inline || embedded ? titleRail : rail}
    sourceDropNonce={sourceDropNonce} onReadSource={onReadSource} selectedSourceId={selectedSourceId} />;
  if (inline || embedded) return <section aria-label="Research collection" hidden={!open}
    className={`${open ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 pb-3`}>
    {body}
  </section>;
  return <AssistantDock
    tabs={[{ id: "research", label: "Workspace", title: restoring || restoreError ? "Workspaces"
      : <span ref={setRail} className="block min-w-0 flex-1" />,
      content: <section aria-label="Research collection" className="h-full min-h-0 overflow-hidden px-3 pb-3">{body}</section> }]}
    activeTabId="research" onActivateTab={() => undefined} expanded={open}
    onExpandedChange={onOpenChange} showCollapsedButton={false} defaultWidth={400} minWidth={300} maxWidth="40%" />;
}
