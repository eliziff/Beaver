import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { errorMessage } from "@/app/lib/utils";
import { ResearchViews } from "../shared/ResearchViews";
import { SearchableChoiceModal } from "../modals/ModalSelect";
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
      selection={workspace.selection} projectId={workspace.file?.document.project_id} onOpen={navigate} />
    <SearchableChoiceModal open={!!choices} onClose={() => setChoices(null)} title="Open chat"
      value={null} options={[...(choices?.items ?? []), { value: "new", label: "New chat" }]}
      footer={error && <p role="alert" className="text-sm text-red-700">{error}</p>} closeOnSelect={false}
      onChange={(id) => { if (!id) return;
        void workspace.chat(id === "new" ? undefined : id).then(({ path }) => { navigate(path); setChoices(null); })
          .catch((reason) => setError(errorMessage(reason, "Could not open chat"))); }} />
  </>;
}
