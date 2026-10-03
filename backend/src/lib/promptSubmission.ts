import { promptSubmissionSchema, type PromptSubmission } from "mike/shared/runtime/promptSubmission.mjs";

export function resolvePromptSubmission(declared?: PromptSubmission): PromptSubmission {
  if (declared?.origin === "machine_test") return declared;
  const runId = process.env.BEAVER_TEST_RUN_ID?.trim();
  return runId ? promptSubmissionSchema.parse({ origin: "machine_test", run_id: runId,
    ...(process.env.BEAVER_TEST_SCENARIO?.trim() && { scenario: process.env.BEAVER_TEST_SCENARIO.trim() }) })
    : declared ?? { origin: "unknown" };
}
