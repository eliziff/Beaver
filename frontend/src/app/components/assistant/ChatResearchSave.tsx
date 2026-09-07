import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ResearchViews } from "../shared/ResearchViews";
import { useSourcesWorkspace } from "../legal/SourcesWorkspace";
import { ImportResearchSet } from "../tabular/ImportResearchSet";

export function ChatResearchSave({ chatId, projectId }: { chatId: string; projectId?: string }) {
  const workspace = useSourcesWorkspace(), navigate = useNavigate();
  const [importing, setImporting] = useState<string | null>(null);
  async function open(view: "workspace" | "table") {
    const file = await workspace.ensure({ chatId, projectId });
    if (view === "workspace") navigate(`/sources?research_file=${encodeURIComponent(file.document.id)}`);
    else setImporting(file.document.id);
  }
  return <><ResearchViews workspace={() => open("workspace")} table={() => open("table")} />
    <ImportResearchSet open={!!importing} onClose={() => setImporting(null)} fileId={importing ?? undefined}
      chatId={chatId} projectId={projectId} onOpen={navigate} /></>;
}
