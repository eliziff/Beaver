import { ApplicationError, type ApplicationScope } from "./applicationError";
import type { ChatStore } from "./chatStore";
import type { DocumentStore } from "./documentStore";
import type { GroundedAnswer } from "./groundedAnswer";
import type { AssistantEvent } from "./chat/assistantEvents";
import type { ResearchOperationContext } from "./researchProvenance";
import { legalEvidenceResourceReference, priorLegalEvidenceReceipts, priorLegalResearchQueryReceipts,
  type LegalEvidenceReceipt } from "./chat/legalEvidence";
import { commitResearchFile, readResearchFile, researchQueryReceipt, researchQuerySources,
  researchSourceResource, type ResearchFile } from "./researchFile";

/** Reuse durable transcript receipts; retries add references by identity. */
export async function collectChatResearch(documents: DocumentStore, scope: ApplicationScope,
  researchFileId: string, chatId: string, events: AssistantEvent[], current?: ResearchFile,
  operation?: ResearchOperationContext) {
  const evidence = priorLegalEvidenceReceipts(events), queries = priorLegalResearchQueryReceipts(events);
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = attempt === 0 && current ? current : await readResearchFile(documents, scope, researchFileId);
    if (!file) throw new ApplicationError(404, "Research workspace not found");
    const saved = await commitResearchFile(documents, scope, file, { type: "merge", evidence,
      queries: queries.map(researchQueryReceipt), sources: researchQuerySources(queries), chats: [chatId] }, undefined, operation);
    if (saved) return saved;
  }
  throw new ApplicationError(409, "The workspace changed. Reopen it to collect the saved chat results.");
}

export async function resolveChatFindings(chats: ChatStore, documents: DocumentStore, scope: ApplicationScope,
  input: { researchFileId: string; chatId: string; messageIds?: string[]; readOnly?: boolean }) {
  const [chat, rows, current] = await Promise.all([chats.get(scope, input.chatId),
    chats.transcript(scope, input.chatId), readResearchFile(documents, scope, input.researchFileId)]);
  if (!chat || !rows) throw new ApplicationError(404, "Chat not found");
  if (!current || chat.research_file_id !== current.document.id)
    throw new ApplicationError(400, "Open this chat in the workspace first");
  const file = input.readOnly ? current : await collectChatResearch(documents, scope, input.researchFileId, chat.id,
    rows.flatMap(({ content }) => Array.isArray(content) ? content : []), current),
    sources = new Map(Object.values(file.state.sources).map((source) => [researchSourceResource(source.reference), source.id])),
    requested = input.messageIds && new Set(input.messageIds), found = new Set<string>(),
    findings: Array<{ kind: "answer" | "passages"; sourceId: string; resource: string; question: { id: string; title: string; prompt: string };
      answer: GroundedAnswer; evidence: LegalEvidenceReceipt[]; origin: { chatId: string; messageId: string; subagentId?: string } }> = [];
  let prompt = "Recorded answer";
  for (const row of rows) {
    if (row.role === "user") { if (typeof row.content === "string") prompt = row.content; continue; }
    if (requested && !requested.has(row.id) || !Array.isArray(row.content)) continue;
    const evidence = priorLegalEvidenceReceipts(row.content), byId = new Map(evidence.map((item) => [item.evidence_id, item]));
    if (!evidence.length) continue;
    found.add(row.id);
    const claimed = new Set<string>(); let ordinal = 0;
    const append = (kind: "answer" | "passages", answerId: string, question: string,
      claims: GroundedAnswer["claims"], subagentId?: string) => {
      const ids = [...new Set(claims.flatMap(({ evidence_ids }) => evidence_ids))],
        supporting = ids.map((id) => byId.get(id));
      if (supporting.some((value) => !value)) throw new ApplicationError(409, "An original supporting passage is unavailable");
      for (const resource of new Set(supporting.flatMap((item) => item && legalEvidenceResourceReference(item) || []))) {
        const sourceId = sources.get(resource); if (!sourceId) continue;
        const selected = claims.filter((claim) => claim.evidence_ids.some((id) =>
          legalEvidenceResourceReference(byId.get(id)!) === resource)),
          selectedIds = [...new Set(selected.flatMap(({ evidence_ids }) => evidence_ids))];
        findings.push({ kind, sourceId, resource, question: { id: answerId,
          title: kind === "passages" ? "Collected passages" : question.slice(0, 100), prompt: question },
          answer: { claims: selected.map(({ text, evidence_ids }) => ({ text, evidence_ids })) },
          evidence: selectedIds.map((id) => byId.get(id)!), origin: { chatId: chat.id, messageId: row.id,
            ...(subagentId && { subagentId }) } });
      }
      if (kind === "answer") ids.forEach((id) => claimed.add(id));
    };
    for (const event of row.content) {
      if (event.type === "legal_evidence_receipt" && event.status === "passed" && event.claims.length)
        append("answer", `${row.id}:answer:${ordinal++}`, prompt, event.claims);
      else if (event.type === "subagent_run" && event.status === "completed" &&
          event.grounding?.status === "passed" && event.grounding.claims.length)
        append("answer", `${row.id}:reader:${event.id}`, event.task, event.grounding.claims, event.id);
    }
    append("passages", `${row.id}:passages`, "Collected source passages", evidence.filter((item) =>
      !claimed.has(item.evidence_id) && item.span_text).map((item) => ({ text: item.span_text!, evidence_ids: [item.evidence_id] })));
  }
  if (requested && [...requested].some((id) => !found.has(id)))
    throw new ApplicationError(400, "A selected message has no recorded grounded answer");
  if (!findings.length && !input.readOnly) throw new ApplicationError(400, "This chat has no collected passages or grounded answers to open as a table");
  return { file, findings };
}
