import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ResearchViews } from "../shared/ResearchViews";
import { useSourcesWorkspace } from "../legal/SourcesWorkspace";
import { ImportResearchSet } from "../tabular/ImportResearchSet";

export function ChatResearchSave({ chatId, projectId, question }: { chatId: string; projectId?: string; question?: string }) {
  const workspace = useSourcesWorkspace(), navigate = useNavigate();
  const [importing, setImporting] = useState<{ id: string; mode: "table" | "labels"; title: string } | null>(null);
  async function open(mode: "table" | "labels") {
    const file = await workspace.ensure({ chatId, projectId });
    setImporting({ id: file.document.id, mode,
      title: (file.document.filename ?? "").replace(/\.research\.md$/iu, "") });
  }
  return <><ResearchViews workspace={() => open("labels")} table={() => open("table")} />
    <ImportResearchSet open={!!importing} onClose={() => setImporting(null)} fileId={importing?.id}
      mode={importing?.mode} defaultRequest={question?.trim() || importing?.title} chatId={chatId} projectId={projectId} onOpen={navigate} /></>;
}
