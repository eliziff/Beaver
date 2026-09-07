import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ResearchViews } from "../shared/ResearchViews";
import { useSourcesWorkspace } from "../legal/SourcesWorkspace";
import { SaveResearchPassages } from "../legal/SaveResearchPassages";
import { ImportResearchSet } from "../tabular/ImportResearchSet";

export function ChatResearchSave({ chatId, projectId, messageIds, latestMessageId }: { chatId: string; projectId?: string; messageIds?: string[]; latestMessageId?: string }) {
  const workspace = useSourcesWorkspace(), navigate = useNavigate();
  const [conversion, setConversion] = useState<{ fileId: string; view: "workspace" | "table" } | null>(null);
  const [latest, setLatest] = useState(false);
  const selectedMessages = latest && latestMessageId ? [latestMessageId] : messageIds;
  const scopeControl = latestMessageId && !messageIds ? <label className="flex items-center gap-2 text-sm">From<select aria-label="Chat conversion scope" value={latest ? "latest" : "all"} onChange={(event) => setLatest(event.target.value === "latest")} className="rounded border border-gray-300 p-1"><option value="all">Entire conversation</option><option value="latest">Latest answer</option></select></label> : undefined;
  async function open(view: "workspace" | "table") {
    const file = await workspace.ensure({ chatId, projectId });
    setConversion({ fileId: file.document.id, view });
  }
  return <>
    <ResearchViews workspace={() => open("workspace")} table={() => open("table")} />
    <ImportResearchSet open={conversion?.view === "table"} fileId={conversion?.fileId} projectId={projectId}
      chatId={chatId} messageIds={selectedMessages} scopeControl={scopeControl} onClose={() => setConversion(null)} onOpen={navigate} />
    {conversion?.view === "workspace" && <SaveResearchPassages fileId={conversion.fileId} chatId={chatId} messageIds={selectedMessages} scopeControl={scopeControl} collect
      onClose={() => setConversion(null)} onDone={(file, selection) => {
        workspace.accept(file); navigate(`/sources?research_file=${encodeURIComponent(file.document.id)}`, { state: { researchSelection: selection } }); setConversion(null);
      }} />}
  </>;
}
