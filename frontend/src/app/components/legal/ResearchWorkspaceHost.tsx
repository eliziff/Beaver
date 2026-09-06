import { useState } from "react";
import { AssistantDock } from "@/app/components/assistant/AssistantDock";
import { Button } from "@/app/components/ui/button";
import type { ResearchSource } from "@/app/lib/researchFiles";
import { ResearchFileBar } from "./ResearchFileBar";
import { useSourcesWorkspace } from "./SourcesWorkspace";

export function ResearchWorkspaceHost({ embedded, open, onOpenChange, projectId,
  sourceDropNonce, inline = false, rail: titleRail, onReadSource, selectedSourceId }: {
  embedded: boolean; open: boolean; onOpenChange: (open: boolean) => void;
  projectId?: string; sourceDropNonce?: number;
  inline?: boolean; rail?: HTMLElement | null;
  onReadSource?: (source: ResearchSource, locator?: string) => void;
  selectedSourceId?: string;
}) {
  const [rail, setRail] = useState<HTMLElement | null>(null);
  const { loading: restoring, error: restoreError, retry } = useSourcesWorkspace();
  const body = restoring ? <p role="status" className="py-4 text-sm text-gray-600">Opening workspace…</p>
    : restoreError ? <div className="space-y-3 py-4">
      <p role="alert" className="text-sm text-red-700">{restoreError}</p>
      <Button variant="outline" onClick={() => void retry()}>Retry</Button>
    </div> : <ResearchFileBar projectId={projectId} rail={inline || embedded ? titleRail : rail}
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
