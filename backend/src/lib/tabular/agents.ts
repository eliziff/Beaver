import { randomUUID } from "node:crypto";
import { ApplicationError, type ApplicationScope } from "../applicationError";
import { activeJobForGroup, enqueueJob, jsonValue, PermanentJobError,
  requestGroupCancellation, type JobHandler } from "../jobQueue";
import { jsonRecord, trimmedText } from "../value";
import type { TabularApplication } from "./application";
import { parseResourceReference } from "../resourceReferences";

export const TABULAR_AGENT_JOB = "tabular.agent";
const group = (reviewId: string) => `tabular:${reviewId}`;

export type TabularAgents = {
  active(reviewId: string, ownerId: string): Promise<boolean>;
  enqueue(scope: ApplicationScope, input: {
    reviewId: string; ownerId: string;
    assignments: { documentId: string; columnIndex?: number; sourceDocumentId?: string | null }[];
    model: string; reasoningEffort?: string;
  }): Promise<{ id: string; created: boolean }[]>;
  cancel(reviewId: string, ownerId: string): Promise<boolean>;
};

export const durableTabularAgents: TabularAgents = {
  async active(reviewId, ownerId) {
    return !!await activeJobForGroup(group(reviewId), ownerId);
  },
  async enqueue(scope, input) {
    const requestId = randomUUID();
    return Promise.all(input.assignments.map(async ({ documentId, columnIndex, sourceDocumentId }) => {
      const queued = await enqueueJob({
        kind: TABULAR_AGENT_JOB,
        dedupeKey: `${input.reviewId}:${documentId}`,
        groupKey: group(input.reviewId),
        userId: input.ownerId,
        documentId: sourceDocumentId === undefined
          ? parseResourceReference(documentId)?.kind === "source" ? null : documentId : sourceDocumentId,
        payload: jsonValue({
          request_id: requestId,
          actor_user_id: scope.userId,
          ...(scope.userEmail ? { actor_user_email: scope.userEmail } : {}),
          review_id: input.reviewId,
          document_id: documentId,
          ...(columnIndex === undefined ? {} : { column_index: columnIndex }),
          model: input.model,
          ...(input.reasoningEffort
            ? { reasoning_effort: input.reasoningEffort }
            : {}),
        }),
      });
      return {
        id: queued.id,
        created: jsonRecord(queued.payload)?.request_id === requestId,
      };
    }));
  },
  async cancel(reviewId, ownerId) {
    return await requestGroupCancellation(group(reviewId), ownerId) > 0;
  },
};

export function tabularAgentJobHandler(application: TabularApplication): JobHandler {
  return async (job, context) => {
    const payload = jsonRecord(job.payload);
    const actorId = trimmedText(payload?.actor_user_id);
    const reviewId = trimmedText(payload?.review_id);
    const documentId = trimmedText(payload?.document_id);
    const model = trimmedText(payload?.model);
    const reasoningEffort = trimmedText(payload?.reasoning_effort) || undefined;
    const columnIndex = typeof payload?.column_index === "number" &&
      Number.isSafeInteger(payload.column_index) && payload.column_index >= 0
      ? payload.column_index : undefined;
    if (!actorId || !reviewId || !documentId || !model) {
      throw new PermanentJobError("TabularAgentRequestUnavailable");
    }
    try {
      await application.runAgent({
        userId: actorId,
        ...(trimmedText(payload?.actor_user_email)
          ? { userEmail: trimmedText(payload?.actor_user_email) }
          : {}),
      }, { reviewId, documentId, model, reasoningEffort, columnIndex, jobId: job.id }, context.signal);
      return { review_id: reviewId, document_id: documentId };
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw new PermanentJobError(error.details?.code ?? error.message);
      }
      throw error;
    }
  };
}
