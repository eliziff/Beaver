import { useState } from "react";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
import { getWorkspaceFindings } from "@/app/lib/api/researchFiles";
import type { ResearchFile } from "@/app/lib/researchFiles";

export function ChatFindingActions({ file, chatId, messageId, onUseAnswer }: {
  file: ResearchFile; chatId: string; messageId: string; onUseAnswer(): Promise<void>;
}) {
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), findings = usePagedQuery(async (cursor, signal) => {
    const page = await getWorkspaceFindings(file.document.id, { chatId, messageId, offset: Number(cursor ?? 0) }, signal);
    return { items: page.items, next_cursor: page.next_offset === null ? null : String(page.next_offset) };
  }, [file.document.id, chatId, messageId]);
  async function run() {
    setBusy(true); setError("");
    try { await onUseAnswer(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  if (!findings.items.length && !error && !findings.error) return null;
  return <div className="my-2 text-sm">
    {!!findings.items.length && <button type="button" disabled={busy}
      className="rounded border px-2 py-1" onClick={() => void run()}>Use as answer</button>}
    {!!(error || findings.error) && <p role="alert">{String(error || findings.error)}</p>}
  </div>;
}
