import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Citation } from "@/app/lib/citations";
import { errorMessage } from "@/app/lib/utils";
import { ResearchViews } from "../shared/ResearchViews";
import { SearchableChoiceModal } from "../modals/ModalSelect";
import { GroundedAnswerContent } from "../shared/GroundedAnswerContent";
import { Button } from "../ui/button";
import { ImportResearchSet } from "../tabular/ImportResearchSet";
import { useSourcesWorkspace } from "./SourcesWorkspace";

export function ResearchWorkspaceViews() {
  const workspace = useSourcesWorkspace(), navigate = useNavigate();
  const [choices, setChoices] = useState<{ items: { value: string; label: string }[] } | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  async function choose(kind: "Table" | "Chat") {
    if (kind === "Table") { setImporting(true); return; }
    const views = await workspace.views();
    if (!views.chats.length) return navigate((await workspace.chat()).path);
    setError("");
    setChoices({ items: views.chats.map(({ id, title }) => ({ value: id, label: title || "Untitled chat" })) });
  }
  return <>
    <ResearchViews table={() => choose("Table")} chat={() => choose("Chat")} />
    <ImportResearchSet open={importing} onClose={() => setImporting(false)} fileId={workspace.file?.document.id}
      projectId={workspace.file?.document.project_id} onOpen={navigate} />
    <SearchableChoiceModal open={!!choices} onClose={() => setChoices(null)} title="Open chat"
      value={null} options={[...(choices?.items ?? []), { value: "new", label: "New chat" }]}
      footer={error && <p role="alert" className="text-sm text-red-700">{error}</p>} closeOnSelect={false}
      onChange={(id) => { if (!id) return;
        void workspace.chat(id === "new" ? undefined : id).then(({ path }) => { navigate(path); setChoices(null); })
          .catch((reason) => setError(errorMessage(reason, "Could not open chat"))); }} />
  </>;
}

export function ResearchSourceAnswers({ sourceId, onCitation }: { sourceId: string; onCitation: (citation: Citation) => void }) {
  const { findings } = useSourcesWorkspace(), page = findings.chains[sourceId];
  useEffect(() => { if (!page) void findings.fetchPage(sourceId, null, false); }, [page, sourceId, findings.fetchPage]);
  return <>
    {page?.items.map(({ reference, question, answer, evidence }) => <details key={JSON.stringify(reference)} className="border-s-2 border-gray-200 ps-3">
      <summary className="cursor-pointer text-sm font-medium text-gray-900">{question.title}</summary>
      <div className="pt-2"><GroundedAnswerContent answer={{ ...answer, evidence }} column={question} onCitation={onCitation} /></div>
    </details>)}
    {page?.loading && !page.items.length && <p role="status" className="text-sm text-gray-500">Loading answers…</p>}
    {!!page?.error && <Button size="compact" variant="outline" onClick={() => void findings.fetchPage(sourceId, null, false)}>Retry answers</Button>}
    {page?.nextCursor && <Button size="compact" variant="outline" disabled={page.loading}
      onClick={() => void findings.fetchPage(sourceId, page.nextCursor, true)}>More answers</Button>}
  </>;
}
