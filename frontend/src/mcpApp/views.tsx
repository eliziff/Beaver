import { useEffect, useState } from "react";
import { Maximize2 } from "lucide-react";
import { MemoryRouter } from "react-router-dom";
import { app } from "@/mcpApp/host";
import { AssistantMessage } from "@/app/components/assistant/AssistantMessage";
import { Button } from "@/app/components/ui/button";
import { Providers } from "@/app/components/providers";
import { AuthoritiesWorkspace } from "@/app/authorities/AuthoritiesWorkspace";
import { beaverAuthoritiesHost } from "@/app/authorities/beaverHost";
import { AuthoritiesDocumentPicker } from "@/app/(pages)/table-of-authorities/page";
import type { AuthoritiesProduct } from "@/app/authorities/types";
import type { Citation } from "@/app/lib/citations";

export type View =
  | { view: "answer"; text: string; citations: Citation[] }
  | { view: "authorities"; draftId: string | null; title: string | null; stage?: string | null; authorities?: number };

/** The grounded answer as Beaver chat shows it: each citation pill opens the publisher's pinpoint. */
function Answer({ view }: { view: Extract<View, { view: "answer" }> }) {
  return <div className="px-4 py-2"><AssistantMessage message={{ id: "answer", role: "assistant",
    blocks: [{ id: "answer", role: "assistant", text: view.text }], activities: [], workflowRuns: [], artifacts: [],
    citations: view.citations, contextCompacted: false, contentFinal: true }} /></div>;
}

const fullscreen = () => void app.requestDisplayMode({ mode: "fullscreen" });
// What the user has open, so a request in the chat ("build it") names the right draft.
const tellModel = (draft: AuthoritiesProduct | undefined) => void app.updateModelContext({ content: [{ type: "text",
  text: draft ? `Open in Beaver Authorities: "${draft.title}" (draft_id ${draft.id}, revision ${draft.revision}, `
    + `${draft.state.stage ?? "citations"} stage, ${draft.state.authorityOrder.length} authorities).`
    : "Beaver Authorities is open with no draft selected." }] }).catch(() => undefined);

/** Authorities needs the whole window: inline it is a card that opens the workspace there. */
function Authorities({ view }: { view: Extract<View, { view: "authorities" }> }) {
  const context = app.getHostContext();
  const [mode, setMode] = useState(context?.displayMode);
  useEffect(() => {
    const changed = (next: { displayMode?: string }) => { if (next.displayMode) setMode(next.displayMode as typeof mode); };
    app.addEventListener("hostcontextchanged", changed);
    return () => app.removeEventListener("hostcontextchanged", changed);
  }, []);
  const expandable = context?.availableDisplayModes?.includes("fullscreen");
  if (mode !== "fullscreen" && expandable) return <div className="p-3">
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-gray-900">{view.title ?? "Authorities"}</p>
        <p className="text-xs text-gray-600">{view.draftId
          ? `${view.authorities ?? 0} authorities · ${view.stage ?? "citations"}`
          : "Import a factum or brief and build its Book of Authorities."}</p>
      </div>
      <Button onClick={fullscreen}><Maximize2 aria-hidden className="size-4" />Open</Button>
    </div>
  </div>;
  return <div className={mode === "fullscreen" ? "h-dvh" : "relative h-[720px]"}>
    <AuthoritiesWorkspace host={beaverAuthoritiesHost} LibraryPicker={AuthoritiesDocumentPicker}
      initialDraftId={view.draftId ?? undefined} initialNewDraft={!view.draftId} onDraftChange={tellModel} />
  </div>;
}

/** What a tool result asked to show: a grounded answer, or Authorities. */
export function BeaverView({ view }: { view: View }) {
  return <Providers><MemoryRouter>
    {view.view === "answer" ? <Answer view={view} /> : <Authorities view={view} />}
  </MemoryRouter></Providers>;
}
