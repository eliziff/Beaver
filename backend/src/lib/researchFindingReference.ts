import { z } from "zod";

const claimIndices = z.array(z.number().int().min(0).max(100_000)).min(1).max(1_000)
  .refine((values) => new Set(values).size === values.length, "Claim indices must be unique").optional();
const findingId = z.string().min(1).max(200);
export const researchFindingReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer"), chatId: findingId, answerId: findingId,
    resource: z.string().min(1).max(4_000), claimIndices }).strict(),
  z.object({ kind: z.literal("cell"), reviewId: findingId, rowId: z.string().min(1).max(4_000),
    columnIndex: z.number().int().min(0).max(10_000), claimIndices }).strict(),
]);
export type ResearchFindingReference = z.infer<typeof researchFindingReferenceSchema>;
const identity = (ref: ResearchFindingReference) => ref.kind === "answer"
  ? [ref.kind, ref.chatId, ref.answerId, ref.resource] : [ref.kind, ref.reviewId, ref.rowId, ref.columnIndex];
export const researchFindingKey = (ref: ResearchFindingReference) => JSON.stringify([
  ...identity(ref), ...(ref.claimIndices ? [[...ref.claimIndices].sort((a, b) => a - b)] : []),
]);
export const researchFindingWithin = (ref: ResearchFindingReference, allowed: ResearchFindingReference) =>
  JSON.stringify(identity(ref)) === JSON.stringify(identity(allowed)) &&
  (!allowed.claimIndices || !!ref.claimIndices && ref.claimIndices.every((index) => allowed.claimIndices!.includes(index)));
