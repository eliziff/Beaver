import { useState } from "react";
import { getWorkspaceFindings, type ResearchFinding } from "@/app/lib/api/researchFiles";
import { useSourcesWorkspace } from "../legal/SourcesWorkspace";
import { ResearchReuseActions } from "../shared/ResearchReuseActions";
import { Button } from "../ui/button";

export function ChatFindingActions({ chatId, messageId, onUseAnswer }: {
  chatId: string; messageId: string; onUseAnswer?(): Promise<void>;
}) {
  const workspace = useSourcesWorkspace(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function prepare() {
    // No per-message background lookup. Capture only the answer the user chose, on demand.
    const file = await workspace.ensure({ chatId }), findings: ResearchFinding[] = [];
    let offset: number | null = 0;
    do {
      const page = await getWorkspaceFindings(file.document.id, { chatId, messageId, offset, limit: 50 });
      findings.push(...page.items.filter(item => !item.origin?.subagentId)); offset = page.next_offset;
      if (findings.length > 500) throw new Error("This answer has more than 500 findings; select a smaller result in Sources.");
    } while (offset !== null);
    return { file, title: findings[0]?.question.title || "Selected research", references: findings.map(item => item.reference),
      selection: { target: "sources" as const, sourceIds: [...new Set(findings.map(item => item.sourceId))] } };
  }
  async function applyAnswer() {
    setBusy(true); setError("");
    try { await onUseAnswer?.(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <div className="flex flex-wrap items-center gap-1 text-sm">
    <ResearchReuseActions prepare={prepare} disabled={busy} compose={false} variant="ghost" />
    {onUseAnswer && <Button variant="ghost" size="compact" disabled={busy} onClick={() => void applyAnswer()}>Use as answer</Button>}
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
  </div>;
}
