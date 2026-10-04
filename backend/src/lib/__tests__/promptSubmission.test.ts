import { afterEach, expect, it, vi } from "vitest";
import { resolvePromptSubmission } from "../promptSubmission";
import { promptSubmissionSchema } from "mike/shared/runtime/promptSubmission.mjs";

afterEach(() => vi.unstubAllEnvs());





it.each([
  { origin: "machine_test" }, { origin: "machine_test", run_id: " " },
  { origin: "human", run_id: "incorrect" }, { origin: "guessed_human" },
])("rejects incomplete or contradictory provenance: %j", submission => {
  expect(promptSubmissionSchema.safeParse(submission).success).toBe(false);
});
