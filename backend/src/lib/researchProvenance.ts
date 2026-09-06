import type { AuditStore } from "./audit";
import type { ApplicationScope } from "./applicationError";
import type { ResearchEvidence, ResearchFile, ResearchFileAction } from "./researchFile";
import { legalSourceResource, resourceReference } from "./resourceReferences";
import { legalEvidenceResourceReference } from "./chat/legalEvidence";

export type ResearchOperationContext = {
  audit?: AuditStore["record"]; executor: "human" | "assistant"; model?: string;
  turnId?: string; callId?: string; jobId?: string; chatId?: string; reviewId?: string;
};
export const researchEvidenceSnapshot = (item: ResearchEvidence) => ({
  sourceId: item.sourceId, sourceVersion: item.receipt.version,
  sourceSha256: item.receipt.source_sha256, labelIds: [...item.labelIds],
});
type EvidenceSnapshot = Record<string, ReturnType<typeof researchEvidenceSnapshot>>;
const changes = <T>(before: Record<string, T>, after: Record<string, T>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((id) =>
    JSON.stringify(before[id]) === JSON.stringify(after[id]) ? [] : [{ id,
      before: before[id] ?? null, after: after[id] ?? null }]);

export async function recordResearchOperation(context: ResearchOperationContext,
  scope: ApplicationScope, before: ResearchFile, after: ResearchFile,
  action: ResearchFileAction, evidenceBefore: EvidenceSnapshot, evidenceAfter: EvidenceSnapshot) {
  const sources = (file: ResearchFile) => Object.fromEntries(Object.values(file.state.sources).map(({ id,
    reference, labelIds }) => [id, { resource: reference.kind === "document"
      ? resourceReference.document(reference.id, reference.versionId) : legalSourceResource(reference), labelIds }]));
  try {
    await context.audit?.({ userId: scope.userId, userEmail: scope.userEmail,
      action: `research.${action.type}`, surface: "research", documentId: after.document.id,
      projectId: after.document.project_id, title: after.document.filename, model: context.model,
      chatId: context.chatId, reviewId: context.reviewId, detail: {
        initiator_user_id: scope.userId, executor: context.executor,
        ...(context.turnId ? { turn_id: context.turnId } : {}),
        ...(context.callId ? { call_id: context.callId } : {}),
        ...(context.jobId ? { job_id: context.jobId } : {}),
        before: { version_id: before.versionId, working_revision: before.workingRevision },
        after: { version_id: after.versionId, working_revision: after.workingRevision },
        ...(action.type === "merge" && action.evidence?.length ? { observed_passages:
          action.evidence.map((receipt) => ({ evidence_id: receipt.evidence_id,
            resource: legalEvidenceResourceReference(receipt), source_sha256: receipt.source_sha256 })) } : {}),
        sources: changes(sources(before), sources(after)),
        labels: changes(before.state.labels, after.state.labels),
        passages: changes(evidenceBefore, evidenceAfter),
        ...(action.type === "merge" && action.queries?.length
          ? { query_ids: action.queries.map(({ query_id }) => query_id) } : {}),
      } });
  } catch { /* Audit availability must not turn a committed edit into a reported failure. */ }
}
