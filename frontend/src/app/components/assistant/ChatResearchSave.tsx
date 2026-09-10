import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ResearchViews } from "../shared/ResearchViews";
import { useSourcesWorkspace } from "../legal/SourcesWorkspace";
import { ImportResearchSet } from "../tabular/ImportResearchSet";
import { getChat } from "@/app/lib/api/chat";

export function ChatResearchSave({ chatId, projectId, question }: { chatId: string; projectId?: string; question?: string }) {
  const workspace = useSourcesWorkspace(), navigate = useNavigate();
  const [importing, setImporting] = useState<{ id: string; mode: "table" | "labels"; title: string;
    model?: string | null; reasoningEffort?: string | null } | null>(null);
  async function open(mode: "table" | "labels") {
    // The step runs on the chat's own model, the one that did the research.
    const [file, detail] = await Promise.all([workspace.ensure({ chatId, projectId }), getChat(chatId)]);
    setImporting({ id: file.document.id, mode, model: detail.chat.model, reasoningEffort: detail.chat.reasoning_effort,
      title: (file.document.filename ?? "").replace(/\.research\.md$/iu, "") });
  }
  return <><ResearchViews workspace={() => open("labels")} table={() => open("table")} />
    <ImportResearchSet open={!!importing} onClose={() => setImporting(null)} fileId={importing?.id}
      mode={importing?.mode} defaultRequest={question?.trim() || importing?.title} chatId={chatId} projectId={projectId} onOpen={navigate}
      model={importing?.model} reasoningEffort={importing?.reasoningEffort} /></>;
}
