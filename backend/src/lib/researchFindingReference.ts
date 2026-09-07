import { z } from "zod";

const findingId = z.string().min(1).max(200);
export const researchFindingReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer"), chatId: findingId, answerId: findingId,
    resource: z.string().min(1).max(4_000), claimIndices: z.array(z.number().int().min(0)).min(1).max(500).optional() }).strict(),
  z.object({ kind: z.literal("cell"), reviewId: findingId, rowId: z.string().min(1).max(4_000),
    columnIndex: z.number().int().min(0).max(10_000) }).strict(),
]);
export type ResearchFindingReference = z.infer<typeof researchFindingReferenceSchema>;
