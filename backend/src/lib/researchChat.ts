import { ApplicationError, type ApplicationScope } from "./applicationError";
import type { ResearchFindingReference } from "./researchFindingReference";
import type { ChatStore } from "./chatStore";
import type { DocumentStore } from "./documentStore";
import type { GroundedAnswer, GroundedResult } from "./groundedAnswer";
import { legalEvidenceResourceReference, priorLegalEvidenceReceipts,
  type LegalEvidenceReceipt } from "./chat/legalEvidence";
import { readResearchFile, researchSourceResource } from "./researchFile";

export type ResearchFinding = { reference: ResearchFindingReference; kind: "answer" | "result";
  sourceId: string; resource: string; question: { id: string; title: string; prompt: string; format?: string; tags?: string[] };
  answer: GroundedResult; evidence: LegalEvidenceReceipt[];
  origin: { chatId?: string; messageId?: string; subagentId?: string; reviewId?: string; rowId?: string; columnIndex?: number } };

/** Select original claim indices without rewriting their wording or manufacturing support. */
export function selectFindingClaims(finding: ResearchFinding, reference: ResearchFindingReference): ResearchFinding {
  if (!reference.claimIndices) return finding;
  const claims = reference.claimIndices.map((index) => {
    const at = finding.reference.claimIndices ? finding.reference.claimIndices.indexOf(index) : index;
    const claim = finding.answer.claims[at];
    if (!claim) throw new ApplicationError(400, "A selected claim is outside this finding");
    return claim;
  }), ids = new Set(claims.flatMap(({ evidence_ids }) => evidence_ids));
  return { ...finding, reference, question: { ...finding.question, format: "text", tags: undefined },
    answer: { claims, summary: claims.map(({ text }) => text).join("\n\n"),
      coverage: finding.answer.coverage }, evidence: finding.evidence.filter(({ evidence_id }) => ids.has(evidence_id)) };
}

export async function resolveChatFindings(chats: ChatStore, documents: DocumentStore, scope: ApplicationScope,
  input: { researchFileId: string; chatId: string; messageIds?: string[] }) {
  const [chat, rows, current] = await Promise.all([chats.get(scope, input.chatId),
    chats.transcript(scope, input.chatId), readResearchFile(documents, scope, input.researchFileId)]);
  if (!chat || !rows) throw new ApplicationError(404, "Chat not found");
  if (!current || !current.state.chats?.includes(chat.id))
    throw new ApplicationError(400, "This chat has not been saved in the workspace");
  const file = current,
    sources = new Map(Object.values(file.state.sources).map((source) => [researchSourceResource(source.reference), source.id])),
    requested = input.messageIds && new Set(input.messageIds), found = new Set<string>(),
    findings: Array<{ reference: Extract<ResearchFindingReference, { kind: "answer" }>; kind: "answer";
      sourceId: string; resource: string; question: { id: string; title: string; prompt: string };
      answer: GroundedAnswer; evidence: LegalEvidenceReceipt[]; origin: { chatId: string; messageId: string; subagentId?: string } }> = [];
  const byId = new Map<string, LegalEvidenceReceipt>();
  let prompt = "Recorded answer";
  for (const row of rows) {
    if (row.role === "user") { if (typeof row.content === "string") prompt = row.content; continue; }
    if (!Array.isArray(row.content)) continue;
    // A later answer may cite an earlier read. Selection limits answers, not their
    // original supporting receipts; future messages must never repair past claims.
    for (const receipt of priorLegalEvidenceReceipts(row.content)) byId.set(receipt.evidence_id, receipt);
    if (requested && !requested.has(row.id)) continue;
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
        findings.push({ reference: { kind: "answer", chatId: chat.id, answerId, resource },
          kind, sourceId, resource, question: { id: answerId,
          title: question.slice(0, 100), prompt: question },
          answer: { claims: selected.map(({ text, evidence_ids }) => ({ text, evidence_ids })) },
          evidence: selectedIds.map((id) => byId.get(id)!), origin: { chatId: chat.id, messageId: row.id,
            ...(subagentId && { subagentId }) } });
      }
      found.add(row.id);
    };
    for (const event of row.content) {
      if (event.type === "legal_evidence_receipt" && event.status === "passed" && event.claims.length)
        append("answer", `${row.id}:answer:${ordinal++}`, prompt, event.claims);
      else if (event.type === "subagent_run" && event.status === "completed" &&
          event.grounding?.status === "passed" && event.grounding.claims.length)
        append("answer", `${row.id}:reader:${event.id}`, event.task, event.grounding.claims, event.id);
    }
  }
  if (requested && [...requested].some((id) => !found.has(id)))
    throw new ApplicationError(400, "A selected message has no recorded grounded answer");
  return { file, findings };
}
