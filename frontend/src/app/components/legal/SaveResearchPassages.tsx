import { useEffect, useState, type ReactNode } from "react";
import { actOnResearchFile, getResearchFile, queryWorkspaceFindings, saveFindingHighlights,
  type ResearchFindingReference, type ResearchFinding } from "@/app/lib/api/researchFiles";
import { researchLabelPath, type ResearchFile, type ResearchSelection } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { Modal } from "../modals/Modal";
import { Button } from "../ui/button";

type Props = { fileId: string; references?: ResearchFindingReference[]; chatId?: string; messageIds?: string[];
  scopeControl?: ReactNode; selection?: ResearchSelection; collect?: boolean; onClose: () => void; onDone: (file: ResearchFile, selection: ResearchSelection) => void };
/** Explicit promotion of canonical claim support. Simply opening the dialog does not save a mark. */
export function SaveResearchPassages({ fileId, references, chatId, messageIds, selection, scopeControl, collect = false, onClose, onDone }: Props) {
  const [file, setFile] = useState<ResearchFile | null>(null), [findings, setFindings] = useState<ResearchFinding[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set()), [save, setSave] = useState(!collect);
  const [typeId, setTypeId] = useState(""), [name, setName] = useState("");
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [retry, setRetry] = useState(0), key = JSON.stringify({ references, chatId, messageIds, selection });
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    void (async () => {
      const file = await getResearchFile(fileId), found: ResearchFinding[] = [];
      let offset: number | null = 0;
      do {
        const page = await queryWorkspaceFindings(fileId, { ...JSON.parse(key), offset, limit: 200 }, controller.signal);
        found.push(...page.items); offset = page.next_offset;
        if (found.length > 500 || offset !== null && found.length === 500) throw new Error("Select at most 500 results to collect at once.");
      } while (offset !== null);
      if (controller.signal.aborted) return;
      setFile(file); setFindings(found);
      setPicked(new Set(found.flatMap(({ answer, evidence }) => {
        const ids = new Set(answer.claims.flatMap(({ evidence_ids }) => evidence_ids));
        return evidence.filter((receipt) => ids.has(receipt.evidence_id) && receipt.scope !== "document" && !!receipt.span_text).map(({ evidence_id }) => evidence_id);
      })));
    })().catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason, "Could not load supporting passages")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [fileId, key, retry]);
  const support = [...new Map(findings.flatMap(({ answer, evidence }) => {
    const ids = new Set(answer.claims.flatMap(({ evidence_ids }) => evidence_ids));
    return evidence.filter((receipt) => ids.has(receipt.evidence_id) && receipt.scope !== "document" && !!receipt.span_text);
  }).map((receipt) => [receipt.evidence_id, receipt])).values()];
  const sourceIds = [...new Set(findings.map(({ sourceId }) => sourceId))];
  async function apply() {
    if (!file || loading || busy) return; setBusy(true); setError("");
    try {
      let updated = file, chosen = typeId;
      if (save && chosen === "new") {
        chosen = crypto.randomUUID();
        updated = await actOnResearchFile(fileId, updated.versionId, updated.workingRevision,
          { type: "label", id: chosen, name: name.trim(), scope: "highlight" });
        setFile(updated); setTypeId(chosen);
      }
      if (save) updated = await saveFindingHighlights(updated, { references: findings.map(({ reference }) => reference),
        evidenceIds: [...picked], ...(chosen ? { typeId: chosen } : {}) });
      onDone(updated, { target: "sources", sourceIds, findingRefs: findings.map(({ reference }) => reference) });
    } catch (reason) { setError(errorMessage(reason, "Could not save these passages. Reload and try again.")); }
    finally { setBusy(false); }
  }
  return <Modal open onClose={onClose} size="lg" breadcrumbs={[collect ? "Collect chat research" : "Save supporting passages"]}
    primaryAction={{ label: collect ? "Open research" : "Save highlights", onClick: () => void apply(), disabled: loading || busy || !file || !sourceIds.length ||
      save && (!picked.size || typeId === "new" && !name.trim()) }}
    footerStatus={error && <p role="alert" className="text-sm text-red-700">{error}</p>}>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-3">
      {scopeControl}
      {loading ? <p role="status">Loading grounded findings…</p> : <>
        <p className="text-sm">{sourceIds.length} sources · {findings.length} findings · {support.length} supporting passages</p>
        {collect && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={save} onChange={(event) => setSave(event.target.checked)} />Save selected supporting passages as highlights</label>}
        {save && <div className="flex flex-wrap gap-2">
          <select aria-label="Save as highlight type" value={typeId} onChange={(event) => setTypeId(event.target.value)} className="max-w-full rounded border border-gray-300 px-2 py-1 text-sm">
            <option value="">Highlight</option>{Object.values(file?.state.labels ?? {}).filter(({ scope }) => scope === "highlight").map(({ id }) =>
              <option key={id} value={id}>{researchLabelPath(file!.state.labels, id).map(({ name }) => name).join(" › ")}</option>)}<option value="new">New highlight type…</option>
          </select>{typeId === "new" && <input aria-label="New highlight type name" placeholder="Type name" maxLength={200} value={name} onChange={(event) => setName(event.target.value)} className="rounded border border-gray-300 px-2 py-1 text-sm" />}
        </div>}
        {support.map((receipt) => <label key={receipt.evidence_id} className="flex gap-2 border-t border-gray-200 py-2 text-sm">
          {save && <input type="checkbox" aria-label={`Save ${receipt.name || receipt.citation} ${receipt.locator.label}`} checked={picked.has(receipt.evidence_id)} onChange={(event) => setPicked((current) => {
            const next = new Set(current); if (event.target.checked) next.add(receipt.evidence_id); else next.delete(receipt.evidence_id); return next;
          })} />}
          <span><span className="mb-1 block text-xs text-gray-500">{receipt.name || receipt.citation} · {receipt.locator.label}</span>{receipt.span_text}</span>
        </label>)}
        {!findings.length && <p className="text-sm text-gray-500">No grounded findings in this selection. Reads remain in history; they are not saved research.</p>}
      </>}
      {error && <Button variant="outline" size="compact" disabled={loading || busy} onClick={() => setRetry((value) => value + 1)}>Reload</Button>}
    </div>
  </Modal>;
}
