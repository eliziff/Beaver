import type { AuditStore } from "./audit";
import type { ApplicationScope } from "./applicationError";
import type { ResearchEvidence, ResearchFile, ResearchFileAction } from "./researchFile";
import { researchSourceResource } from "./researchFile";
import { legalEvidenceResourceReference } from "./chat/legalEvidence";
import type { ResearchChangeField } from "./researchHistory";

export type ResearchOperationContext = {
  audit?: AuditStore["record"]; executor: "human" | "assistant"; model?: string;
  turnId?: string; callId?: string; jobId?: string; chatId?: string; reviewId?: string; subagentId?: string;
};
export async function recordResearchOperation(context: ResearchOperationContext,
  scope: ApplicationScope, before: ResearchFile, after: ResearchFile,
  action: ResearchFileAction, changes: ResearchChangeField[], evidence: (id: string) => ResearchEvidence | undefined) {
  const passage = ({ receipt, sourceId, ...annotations }: ResearchEvidence) => ({ ...annotations,
    evidence_id: receipt.evidence_id, source_id: sourceId, resource: legalEvidenceResourceReference(receipt),
    source_version: receipt.version, source_sha256: receipt.source_sha256 });
  const sourceIds = new Set([...changes.flatMap((change) => change.target === "source" ? [change.id]
    : change.sourceId ? [change.sourceId] : []), ...Object.keys(after.state.sources).filter((id) => !before.state.sources[id])]);
  try {
    await context.audit?.({ userId: scope.userId, userEmail: scope.userEmail,
      action: `research.${action.type}`, surface: "research", documentId: after.document.id,
      projectId: after.document.project_id, title: after.document.filename, model: context.model,
      chatId: context.chatId, reviewId: context.reviewId, detail: {
        initiator_user_id: scope.userId, executor: context.executor,
        ...(context.turnId ? { turn_id: context.turnId } : {}),
        ...(context.callId ? { call_id: context.callId } : {}),
        ...(context.jobId ? { job_id: context.jobId } : {}),
        ...(context.subagentId ? { subagent_id: context.subagentId } : {}),
        before: { version_id: before.versionId, working_revision: before.workingRevision },
        after: { version_id: after.versionId, working_revision: after.workingRevision },
        ...(action.type === "merge" && action.evidence?.length ? { observed_passages:
          action.evidence.map((receipt) => passage(evidence(receipt.evidence_id)!)) } : {}),
        changes: changes.map((change) => change.target === "passage" && change.field === "$"
          ? { ...change, before: change.before && passage(change.before as ResearchEvidence),
            after: change.after && passage(change.after as ResearchEvidence) } : change),
        sources: [...sourceIds].map((id) => ({ id,
          resource: researchSourceResource((after.state.sources[id] ?? before.state.sources[id]).reference),
          created: !before.state.sources[id], removed: !after.state.sources[id] })),
        passages: [...new Set(changes.filter(({ target }) => target === "passage").map(({ id }) => id))]
          .flatMap((id) => { const item = evidence(id); return item ? [passage(item)] : []; }),
        ...(action.type === "merge" && action.queries?.length
          ? { query_ids: action.queries.map(({ query_id }) => query_id) } : {}),
      } });
  } catch { /* Audit availability must not turn a committed edit into a reported failure. */ }
}
