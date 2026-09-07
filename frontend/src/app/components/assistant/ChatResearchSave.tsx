import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ResearchViews } from "../shared/ResearchViews";
import { useSourcesWorkspace } from "../legal/SourcesWorkspace";
import { ImportResearchSet } from "../tabular/ImportResearchSet";

export function ChatResearchSave({ chatId, projectId }: { chatId: string; projectId?: string }) {
  const workspace = useSourcesWorkspace(), navigate = useNavigate();
  const [importing, setImporting] = useState<{ id: string; mode: "table" | "labels"; title: string } | null>(null);
  async function open(mode: "table" | "labels" | "plain") {
    const file = await workspace.ensure({ chatId, projectId });
    if (mode === "plain") navigate(`/sources?research_file=${encodeURIComponent(file.document.id)}`);
    else setImporting({ id: file.document.id, mode,
      title: (file.document.filename ?? "").replace(/\.research\.md$/iu, "") });
  }
  return <><ResearchViews workspace={() => open("labels")} table={() => open("table")} plain={() => open("plain")} />
    <ImportResearchSet open={!!importing} onClose={() => setImporting(null)} fileId={importing?.id}
      mode={importing?.mode} defaultRequest={importing?.title} chatId={chatId} projectId={projectId} onOpen={navigate} /></>;
}
