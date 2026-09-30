import { z } from "zod";

/** Declared submission origin, not an authorization or identity claim. */
export const promptSubmissionSchema = z.discriminatedUnion("origin", [
  z.object({ origin: z.literal("human") }).strict(),
  z.object({ origin: z.literal("unknown") }).strict(),
  z.object({ origin: z.literal("machine_test"),
    run_id: z.string().trim().min(1).max(200),
    scenario: z.string().trim().min(1).max(300).optional() }).strict(),
]);
export type PromptSubmission = z.infer<typeof promptSubmissionSchema>;

export function resolvePromptSubmission(declared?: PromptSubmission): PromptSubmission {
  if (declared?.origin === "machine_test") return declared;
  const runId = process.env.BEAVER_TEST_RUN_ID?.trim();
  return runId ? promptSubmissionSchema.parse({ origin: "machine_test", run_id: runId,
    ...(process.env.BEAVER_TEST_SCENARIO?.trim() && { scenario: process.env.BEAVER_TEST_SCENARIO.trim() }) })
    : declared ?? { origin: "unknown" };
}
