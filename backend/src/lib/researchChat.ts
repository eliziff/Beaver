import { ApplicationError } from "./applicationError";
import type { ResearchFindingReference } from "./researchFindingReference";
import type { ChatMessageRecord } from "./chatStore";
import type { GroundedAnswer, GroundedResult } from "./groundedAnswer";
import { legalEvidenceResourceReference, priorLegalEvidenceReceipts,
  type LegalEvidenceReceipt } from "./chat/legalEvidence";
import { type ResearchFile, researchSourceResource } from "./researchFile";

export type ResearchFinding = { reference: ResearchFindingReference; kind: "answer" | "result";
  sourceId: string; resource: string; question: { id: string; title: string; prompt: string; format?: string; tags?: string[] };
  answer: GroundedResult; evidence: LegalEvidenceReceipt[];
  origin: { chatId?: string; messageId?: string; subagentId?: string; reviewId?: string; rowId?: string; columnIndex?: number } };

/** Narrow a captured answer by its original claim indices without rereading changing output. */
export function selectFindingClaims(finding: ResearchFinding, ref: ResearchFindingReference): ResearchFinding {
  if (ref.kind !== "answer" || !ref.claimIndices) return finding;
  const available = finding.reference.kind === "answer" ? finding.reference.claimIndices : undefined;
  const indices = [...new Set(ref.claimIndices)].sort((a, b) => a - b);
  const claims = indices.map((index) => finding.answer.claims[available ? available.indexOf(index) : index]);
  if (claims.some((claim) => !claim)) throw new ApplicationError(409, "The selected Chat claim is unavailable");
  const ids = new Set(claims.flatMap(({ evidence_ids }) => evidence_ids));
  return { ...finding, reference: ref, answer: { claims, coverage: "partial" },
    evidence: finding.evidence.filter(({ evidence_id }) => ids.has(evidence_id)) };
}

/** Interpret an authorized transcript against the operation's already-loaded workspace. */
export function resolveChatFindings(file: ResearchFile, chatId: string, rows: ChatMessageRecord[]) {
  const sources = new Map(Object.values(file.state.sources).map((source) => [researchSourceResource(source.reference), source.id])),
    findings: ResearchFinding[] = [];
  // A committed turn may store its user and assistant messages at the same timestamp.
  // Tie ordering must not attach an answer to the previous question.
  const userPrompts = rows.filter((row) => row.role === "user" && typeof row.content === "string"),
    byTurn = new Map(userPrompts.filter((row) => row.turn_id).map((row) => [row.turn_id!, row.content as string]));
  const byId = new Map<string, LegalEvidenceReceipt>();
  let prompt = "Recorded answer";
  for (const row of rows) {
    if (row.role === "user") { if (typeof row.content === "string") prompt = row.content; continue; }
    if (!Array.isArray(row.content)) continue;
    // Earlier reads are reusable support, never findings in their own right.
    for (const receipt of priorLegalEvidenceReceipts(row.content)) byId.set(receipt.evidence_id, receipt);
    const simultaneous = row.created_at ? userPrompts.filter((user) => user.created_at === row.created_at) : [];
    const questionPrompt = (row.turn_id ? byTurn.get(row.turn_id) : undefined) ??
      (simultaneous.length === 1 ? simultaneous[0].content as string : prompt);
    let ordinal = 0;
    const append = (kind: "answer", answerId: string, question: string,
      claims: GroundedAnswer["claims"], subagentId?: string) => {
      const ids = [...new Set(claims.flatMap(({ evidence_ids }) => evidence_ids))],
        supporting = ids.map((id) => byId.get(id));
      if (supporting.some((value) => !value)) throw new ApplicationError(409, "An original supporting passage is unavailable");
      for (const resource of new Set(supporting.flatMap((item) => item && legalEvidenceResourceReference(item) || []))) {
        const sourceId = sources.get(resource); if (!sourceId) continue;
        const selected = claims.filter((claim) => claim.evidence_ids.some((id) =>
          legalEvidenceResourceReference(byId.get(id)!) === resource)),
          selectedIds = [...new Set(selected.flatMap(({ evidence_ids }) => evidence_ids))];
        findings.push({ reference: { kind: "answer", chatId, answerId, resource },
          kind, sourceId, resource, question: { id: answerId,
          title: question.slice(0, 100), prompt: question },
          answer: { claims: selected.map(({ text, evidence_ids }) => ({ text, evidence_ids })) },
          evidence: selectedIds.map((id) => byId.get(id)!), origin: { chatId, messageId: row.id,
            ...(subagentId && { subagentId }) } });
      }
    };
    for (const event of row.content) {
      if (event.type === "legal_evidence_receipt" && event.status === "passed" && event.claims.length)
        append("answer", `${row.id}:answer:${ordinal++}`, questionPrompt, event.claims);
      else if (event.type === "subagent_run" && event.status === "completed" &&
          event.grounding?.status === "passed" && event.grounding.claims.length)
        append("answer", `${row.id}:reader:${event.id}`, event.task, event.grounding.claims, event.id);
    }
  }
  return findings;
}
