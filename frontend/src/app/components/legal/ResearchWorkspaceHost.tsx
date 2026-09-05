import { useEffect, useState } from "react";
import { AssistantDock } from "@/app/components/assistant/AssistantDock";
import { getResearchFile } from "@/app/lib/beaverApi";
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
  useEffect(() => {
    const key = `beaver.research.current:${projectId ?? "personal"}`;
    if (file) { localStorage.setItem(key, file.document.id); return; }
    if (!restoreLast) return;
    const id = localStorage.getItem(key); if (!id) return;
    let live = true; void getResearchFile(id).then((saved) => { if (live) onChange(saved); })
      .catch(() => { if (localStorage.getItem(key) === id) localStorage.removeItem(key); });
    return () => { live = false; };
  }, [file, onChange, projectId, restoreLast]);
  const body = <ResearchFileBar file={file} projectId={projectId}
    onChange={onChange} mutations={mutations} rail={inline || embedded ? titleRail : rail}
    sourceDropNonce={sourceDropNonce} onReadSource={onReadSource} selectedSourceId={selectedSourceId} />;
  if (inline || embedded) return <section aria-label="Research collection" hidden={!open}
    className={`${open ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-3 sm:px-6 sm:pb-5`}>
    {body}
  </section>;
  return <AssistantDock
    tabs={[{ id: "research", label: "Workspace", actions: <div ref={setRail} className="min-w-0" />,
      content: <div className="h-full min-h-0 overflow-hidden px-3 pb-3">{body}</div> }]}
    activeTabId="research" onActivateTab={() => undefined} expanded={open}
    onExpandedChange={onOpenChange} showCollapsedButton={false} defaultWidth={400} minWidth={300} maxWidth="40%" />;
}
