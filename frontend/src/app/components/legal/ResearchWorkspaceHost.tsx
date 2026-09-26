import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { AssistantDock } from "@/app/components/assistant/AssistantDock";
import { Button } from "@/app/components/ui/button";
import type { ResearchSource } from "@/app/lib/researchFiles";
import { ResearchFileBar } from "./ResearchFileBar";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import { ResearchChatPanel } from "./ResearchChatPanel";

export function ResearchWorkspaceHost({ embedded, open, onOpenChange, projectId,
  sourceDropNonce, inline = false, floating = false, rail: titleRail, onReadSource, selectedSourceId }: {
  embedded: boolean; open: boolean; onOpenChange: (open: boolean) => void;
  projectId?: string; sourceDropNonce?: number;
  inline?: boolean; floating?: boolean; rail?: HTMLElement | null;
  onReadSource?: (source: ResearchSource, locator?: string, evidenceId?: string) => void;
  selectedSourceId?: string;
}) {
  /** Opened from inside a dock there is no room to nest in: the workspace floats beside it instead,
   *  tracking the dock's edge so the reader it was opened from stays whole. */
  const [beside, setBeside] = useState<DOMRect | null>(null);
  // Measured before paint, so the panel never renders a frame without its position.
  useLayoutEffect(() => {
    const dock = floating && open ? document.querySelector<HTMLElement>("[data-assistant-dock]") : null;
    if (!dock) return setBeside(null);
    const measure = () => setBeside(dock.getBoundingClientRect());
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onOpenChange(false); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(dock);
    window.addEventListener("resize", measure); window.addEventListener("keydown", escape);
    return () => { observer.disconnect();
      window.removeEventListener("resize", measure); window.removeEventListener("keydown", escape); };
  }, [floating, open, onOpenChange]);
  const [rail, setRail] = useState<HTMLElement | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [activePanel, setActivePanel] = useState("research");
  const [wide, setWide] = useState(() => window.matchMedia?.("(min-width: 1600px)").matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.("(min-width: 1600px)");
    if (!media) return;
    const change = () => setWide(media.matches);
    media.addEventListener?.("change", change);
    return () => media.removeEventListener?.("change", change);
  }, []);
  const { loading: restoring, error: restoreError, retry } = useSourcesWorkspace();
  const body = restoring ? <p role="status" className="beaver-loading-indicator py-4 text-sm text-gray-600">Opening workspace…</p>
    : restoreError ? <div className="space-y-3 py-4">
      <p role="alert" className="text-sm text-red-700">{restoreError}</p>
      <Button variant="outline" onClick={() => void retry()}>Retry</Button>
    </div> : <ResearchFileBar projectId={projectId} rail={!floating && (inline || embedded) ? titleRail : rail}
    sourceDropNonce={sourceDropNonce} onReadSource={onReadSource} selectedSourceId={selectedSourceId} />;
  if (floating) return open && beside ? createPortal(
    <section aria-label="Research collection" className="fixed z-[210] flex flex-col overflow-hidden rounded-lg border border-gray-300 bg-app-surface px-3 pb-3 shadow-xl"
      style={{ top: beside.top, height: beside.height, width: Math.min(400, beside.left - 16),
        insetInlineEnd: window.innerWidth - beside.left + 8 }}>
      <div className="flex shrink-0 items-center justify-between py-2">
        <span ref={setRail} className="block min-w-0 flex-1" />
        <button type="button" aria-label="Close workspace" onClick={() => onOpenChange(false)}
          className="grid size-7 shrink-0 place-items-center rounded text-gray-500 hover:bg-gray-100">
          <X aria-hidden className="size-4" /></button>
      </div>
      {body}
    </section>, document.body) : null;
  if (inline || embedded) return <section aria-label="Research collection" hidden={!open}
    className={`${open ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 pb-3`}>
    {body}
  </section>;
  const researchTab = { id: "research", label: "Workspace", title: restoring || restoreError ? "Workspaces"
      : <span ref={setRail} className="block min-w-0 flex-1" />,
      actions: <Button variant="outline" onClick={() => { setChatOpen(true); setActivePanel("chat"); }}>Chat</Button>,
      content: <section aria-label="Research collection" className="h-full min-h-0 overflow-hidden px-3 pb-3">{body}</section> };
  const chatTab = { id: "chat", label: "Chat", content: <ResearchChatPanel /> };
  return <><AssistantDock
    tabs={!wide && chatOpen ? [researchTab, chatTab] : [researchTab]}
    activeTabId={!wide && chatOpen ? activePanel : "research"} onActivateTab={setActivePanel} expanded={open || !wide && chatOpen}
    onExpandedChange={(next) => { onOpenChange(next); if (!next) setChatOpen(false); }}
    showCollapsedButton={false} defaultWidth={400} minWidth={300} maxWidth="40%" />
    {wide && <AssistantDock tabs={[chatTab]} activeTabId="chat" onActivateTab={() => undefined}
      expanded={chatOpen} onExpandedChange={setChatOpen} showCollapsedButton={false}
      defaultWidth={440} minWidth={320} maxWidth="40%" />}</>;
}
