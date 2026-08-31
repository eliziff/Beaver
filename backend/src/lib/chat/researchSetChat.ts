import { z } from "zod";
import { ApplicationError, type ApplicationScope } from "../applicationError";
import type { ChatStore } from "../chatStore";
import { decodeResearchSetState, researchQueryReceipt, researchSetSummary } from "../researchSet";
import type { WorkProductApplication } from "../workProductApplication";
import { priorLegalEvidenceReceipts, priorLegalResearchQueryReceipts } from "./legalEvidence";

export const researchSetPromotionBodySchema = z.object({
  revision: z.number().int().positive(), includeQueries: z.boolean().default(false),
}).strict();
export type ResearchSetPromotionInput = { chatId: string; researchSetId: string;
  revision: number; includeQueries: boolean };

type ResearchProducts = Pick<WorkProductApplication,
  "get" | "applyResearchSetAction">;
const requireSet = async (products: ResearchProducts, scope: ApplicationScope,
  selected: { id: string; revision: number }, projectId: string | null) => {
  const product = await products.get(scope, selected.id);
  if (product.kind !== "research-set" || product.revision !== selected.revision ||
      product.projectId !== null && product.projectId !== projectId) {
    throw new ApplicationError(409, "This research set is unavailable or changed");
  }
  const state = decodeResearchSetState(product.state);
  if (!state) throw new ApplicationError(409, "Research set state is invalid");
  return { product, state };
};

export async function resolveResearchSetChatContext(products: ResearchProducts,
  scope: ApplicationScope, selected: { id: string; revision: number }, projectId: string | null) {
  const { product, state } = await requireSet(products, scope, selected, projectId);
  const evidence = [];
  let chars = 0;
  for (const { receipt } of Object.values(state.evidence).slice(-100)) {
    const size = receipt.span_text?.length ?? 0;
    if (chars + size > 64_000) continue;
    evidence.push(receipt); chars += size;
  }
  return { product, evidence,
    prompt: `SAVED RESEARCH SET:\n${JSON.stringify(researchSetSummary(state))}` };
}

export async function promoteChatResearchSet(chats: ChatStore, products: ResearchProducts,
  scope: ApplicationScope, input: ResearchSetPromotionInput) {
  const chat = await chats.get(scope, input.chatId);
  const rows = await chats.transcript(scope, input.chatId);
  if (!chat || !rows) throw new ApplicationError(404, "Chat not found");
  const { product } = await requireSet(products, scope,
    { id: input.researchSetId, revision: input.revision }, chat.project_id);
  const assistant = rows.filter(({ role }) => role === "assistant").map(({ id, content }) =>
    ({ id, events: Array.isArray(content) ? content : [] })).filter(({ events }) =>
      priorLegalEvidenceReceipts(events).length || input.includeQueries &&
      priorLegalResearchQueryReceipts(events).length);
  const events = assistant.flatMap(({ events }) => events);
  const evidence = priorLegalEvidenceReceipts(events);
  const queries = input.includeQueries
    ? priorLegalResearchQueryReceipts(events).map(researchQueryReceipt) : [];
  if (!evidence.length && !queries.length) return product;
  return products.applyResearchSetAction(scope, product.id, {
    revision: product.revision, action: { type: "merge", evidence, queries },
  }, { kind: "model", id: chat.model ?? "assistant",
    origin: { type: "chat", chatId: chat.id, messageIds: assistant.map(({ id }) => id) } });
}
