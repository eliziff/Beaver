import { useState } from "react";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
import { getWorkspaceFindings, saveWorkspaceFindings } from "@/app/lib/api/researchFiles";
import { researchLabelPath, type ResearchFile } from "@/app/lib/researchFiles";

export function ChatFindingActions({ file, chatId, messageId, onFiled }: {
  file: ResearchFile; chatId: string; messageId: string; onFiled(file: ResearchFile): void;
}) {
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), findings = usePagedQuery(async (cursor, signal) => {
    const page = await getWorkspaceFindings(file.document.id, { chatId, messageId, offset: Number(cursor ?? 0) }, signal);
    return { items: page.items, next_cursor: page.next_offset === null ? null : String(page.next_offset) };
  }, [file.document.id, chatId, messageId]);
  const labels = Object.values(file.state.labels).filter(({ scope }) => scope === "source"),
    choices = labels.length ? labels : Object.values(file.state.labels);
  if (!findings.items.length && !error && !findings.error) return null;
  return <details className="my-2 text-sm">
    <summary className="w-fit cursor-pointer rounded px-2 py-1 focus-visible:outline">File under…</summary>
    <div className="max-h-64 space-y-3 overflow-auto p-2">
      {findings.items.map((finding) => <label key={JSON.stringify(finding.reference)} className="block space-y-1">
        <span className="block line-clamp-3">{finding.answer.claims.map(({ text }) => text).join(" ")}</span>
        <select aria-label="File finding under" value="" disabled={busy || !choices.length}
          className="w-full rounded border bg-transparent px-2 py-1" onChange={async (event) => {
            const typeId = event.target.value; if (!typeId) return; setBusy(true); setError("");
            try { const result = await saveWorkspaceFindings(file.document.id, { references: [finding.reference], typeId,
              versionId: file.versionId, workingRevision: file.workingRevision }); onFiled(result.file); }
            catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
            finally { setBusy(false); }
          }}><option value="">{choices.length ? "Choose a label…" : "Add a label in Workspace first"}</option>
          {choices.map((label) => <option key={label.id} value={label.id}>{researchLabelPath(file.state.labels, label.id).map(({ name }) => name).join(" / ")}</option>)}
        </select>
      </label>)}
      {findings.hasMore && <button type="button" disabled={findings.loading} onClick={() => void findings.loadMore()}>More findings</button>}
      {!!(error || findings.error) && <p role="alert">{String(error || findings.error)}</p>}
    </div>
  </details>;
}
