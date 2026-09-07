import { useEffect, useState } from "react";
import { previewColumnLabels, applyColumnLabels, type ColumnLabelInput, type ColumnLabelPlan } from "@/app/lib/api/researchFiles";
import { researchLabelPath } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { Modal } from "../modals/Modal";
import { Button } from "../ui/button";
import { useSourcesWorkspace } from "../legal/SourcesWorkspace";

export function ColumnLabelsDialog({ input, onClose, onApplied }: { input: ColumnLabelInput; onClose: () => void; onApplied: () => void }) {
  const { file, accept } = useSourcesWorkspace();
  const [plan, setPlan] = useState<ColumnLabelPlan | null>(null), [request, setRequest] = useState("");
  const [parentId, setParentId] = useState(input.parentId ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const key = JSON.stringify(input);
  useEffect(() => {
    if (!file) return;
    const controller = new AbortController(); setBusy(true);
    void previewColumnLabels(file.document.id, JSON.parse(key), controller.signal).then((next) => { if (!controller.signal.aborted) setPlan(next); })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason, "Could not read this column")); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [file?.document.id, key]);
  async function suggest() {
    if (!file || !request.trim()) return; setBusy(true); setError("");
    try { setPlan(await previewColumnLabels(file.document.id, { ...input, request })); }
    catch (reason) { setError(errorMessage(reason, "Could not suggest labels")); } finally { setBusy(false); }
  }
  async function apply() {
    if (!file || !plan) return; setBusy(true); setError("");
    try { accept(await applyColumnLabels(file.document.id, { ...input, parentId: parentId || undefined, basis: plan.basis,
      mapping: plan.mapping.map(({ value, label }) => ({ value, label: label?.trim() || null })) })); onApplied(); onClose(); }
    catch (reason) { setError(errorMessage(reason, "Could not propose these labels")); } finally { setBusy(false); }
  }
  return <Modal open onClose={onClose} size="lg" breadcrumbs={["Labels from column"]}
    primaryAction={{ label: "Propose labels", onClick: () => void apply(), disabled: busy || !plan?.mapping.some(({ label }) => label?.trim()) }}
    footerStatus={error && <p role="alert" className="text-sm text-red-700">{error}</p>}>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-3">
      {plan && <><p className="text-sm font-medium">{plan.title}</p>
        <label className="block text-sm">Under
          <select aria-label="Parent source label" value={parentId} onChange={(event) => setParentId(event.target.value)} className="ms-2 max-w-full rounded border border-gray-300 p-1">
            <option value="">New group: {plan.title}</option>
            {Object.values(file?.state.labels ?? {}).filter(({ scope }) => scope === "source").map((label) =>
              <option key={label.id} value={label.id}>{researchLabelPath(file!.state.labels, label.id).map(({ name }) => name).join(" › ")}</option>)}
          </select></label>
        <div className="space-y-2">{plan.mapping.map((item, index) => <div key={item.value} className="grid grid-cols-2 items-start gap-3 border-t border-gray-200 pt-2 text-sm">
          <span className="whitespace-pre-wrap break-words">{item.value}<span className="block text-xs text-gray-500">{item.sources} sources</span></span>
          <input aria-label={`Label for value ${index + 1}`} value={item.label ?? ""} placeholder="Skip this value" maxLength={200}
            onChange={(event) => setPlan({ ...plan, mapping: plan.mapping.map((row, at) => at === index ? { ...row, label: event.target.value || null } : row) })}
            className="min-w-0 rounded border border-gray-300 px-2 py-1" />
        </div>)}</div><p className="text-xs text-gray-500">Matching names combine sources. Blank entries are skipped. The proposed labels can be reviewed and undone in Changes.</p></>}
      <details><summary className="cursor-pointer text-sm">Consolidate with the assistant</summary>
        <textarea aria-label="Label mapping request" value={request} onChange={(event) => setRequest(event.target.value)}
          placeholder="Combine these into four useful categories without losing meaningful distinctions." className="mt-2 w-full rounded border border-gray-300 p-2 text-sm" rows={2} />
        <Button variant="outline" size="compact" disabled={busy || !request.trim()} onClick={() => void suggest()}>Suggest mapping</Button>
      </details>
      {busy && <p role="status" className="text-sm text-gray-500">Preparing labels…</p>}
    </div>
  </Modal>;
}
