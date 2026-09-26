import { useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createChat, saveChatDraft } from "@/app/lib/api/chat";
import { copyFindingsToMemo, type ResearchFindingReference } from "@/app/lib/api/researchFiles";
import type { ResearchFile, ResearchSelection } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { useSourcesWorkspace } from "../legal/SourcesWorkspace";
import { Button } from "../ui/button";

export type SelectedResearch = { file: ResearchFile; title: string;
  references: ResearchFindingReference[]; selection: ResearchSelection };

/** Explicit copy and composition actions share the current workspace; neither reruns research. */
export function ResearchReuseActions({ prepare, disabled = false }: {
  prepare(): Promise<SelectedResearch>; disabled?: boolean;
}) {
  const workspace = useSourcesWorkspace(), navigate = useNavigate(), busyRef = useRef(false),
    currentWorkspace = useRef(workspace);
  useLayoutEffect(() => { currentWorkspace.current = workspace; }, [workspace]);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(""), [error, setError] = useState("");
  async function run(action: "copy" | "write") {
    if (busyRef.current || disabled) return;
    busyRef.current = true; setBusy(true); setStatus(""); setError("");
    try {
      const { file, title, references, selection } = await prepare();
      if (!references.length) throw new Error("Select completed findings first.");
      if (references.length > 500) throw new Error("Select at most 500 findings at a time.");
      if (action === "copy") {
        const next = await copyFindingsToMemo(file, { title: title.slice(0, 200), references });
        if (currentWorkspace.current.file?.document.id === file.document.id) currentWorkspace.current.accept(next);
        setStatus("Added to memo");
      } else {
        const selected = { ...selection, findingRefs: references }, { id } = await createChat({
          research_file_id: file.document.id, research_selection: selected,
          ...(file.document.project_id ? { project_id: file.document.project_id } : {}),
        });
        await saveChatDraft(id, { role: "user", research_file_id: file.document.id, research_selection: selected,
          content: "Write a synthesis of the selected research. Preserve material qualifications and cite the original sources." });
        navigate(`${file.document.project_id ? `/projects/${file.document.project_id}` : ""}/assistant/chat/${id}`);
      }
    } catch (reason) { setError(errorMessage(reason, "Could not reuse the selected research")); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <div className="flex flex-wrap items-center gap-2 text-sm">
    <Button variant="outline" size="compact" disabled={disabled || busy} onClick={() => void run("copy")}>Add to memo</Button>
    <Button variant="outline" size="compact" disabled={disabled || busy} onClick={() => void run("write")}>Write from selection</Button>
    {status && <span role="status" className="text-xs text-gray-600">{status}</span>}
    {error && <span role="alert" className="text-xs text-red-700">{error}</span>}
  </div>;
}
