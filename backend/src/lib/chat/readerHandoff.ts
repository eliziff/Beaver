import type { ReadSubagentEvent } from "./assistantEvents";
import { modelEvidencePassage, type LegalEvidenceTurnState } from "./legalEvidence";

/** Findings are paged whole; their original receipts stay in the existing evidence store. */
export function readerHandoff(event: ReadSubagentEvent, state: LegalEvidenceTurnState,
  offset = 0, limit = 64, budget = 60_000) {
  const claims = event.grounding?.claims ?? [],
    findings: Array<{ text: string; evidence_ids: string[] }> = [],
    evidence: ReturnType<typeof modelEvidencePassage>[] = [],
    omitted: string[] = [],
    read = { file_path: "readers", section: event.id },
    payload = { reader_id: event.id, task: event.task.slice(0, 240), status: event.status,
      ...(event.error ? { error: event.error.slice(0, 500) } : {}),
      findings, evidence, total_findings: claims.length,
      next_read: null as (typeof read & { offset: number }) | null,
      omitted_evidence: omitted,
      history: { file_path: "queries", section: event.id } };
  // Reserve the continuation before packing so it can never push a full packet over budget.
  payload.next_read = { ...read, offset: claims.length + 1 };
  for (const { text, evidence_ids } of claims.slice(offset, offset + limit)) {
    const added = [...new Set(evidence_ids)].filter(id => !omitted.includes(id));
    findings.push({ text, evidence_ids }); omitted.push(...added);
    if (JSON.stringify(payload).length > budget) {
      findings.pop(); omitted.splice(omitted.length - added.length, added.length); break;
    }
  }
  if (!findings.length && offset < claims.length) throw new Error("Reader finding exceeds the result budget");
  const next = offset + findings.length;
  payload.next_read = next < claims.length ? { ...read, offset: next + 1 } : null;
  const receipts = new Map(event.grounding?.evidence.map(receipt => [receipt.evidence_id, receipt]));
  // Claim IDs already identify every deferred passage. Never substitute a partial quotation.
  for (const id of [...omitted]) {
    const receipt = receipts.get(id);
    if (!receipt) continue;
    const passage = modelEvidencePassage(receipt);
    evidence.push(passage);
    const at = omitted.indexOf(id); omitted.splice(at, 1);
    if (JSON.stringify(payload).length > budget) {
      evidence.pop(); omitted.splice(at, 0, id);
    } else state.presentedEvidenceIds.add(id);
  }
  return payload;
}
