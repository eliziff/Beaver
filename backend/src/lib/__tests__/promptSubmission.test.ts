import { afterEach, expect, it, vi } from "vitest";
import { promptSubmissionSchema, resolvePromptSubmission } from "../promptSubmission";

afterEach(() => vi.unstubAllEnvs());

it("keeps unlabelled callers unknown and records an explicit human declaration", () => {
  vi.stubEnv("BEAVER_TEST_RUN_ID", "");
  expect(resolvePromptSubmission()).toEqual({ origin: "unknown" });
  expect(resolvePromptSubmission({ origin: "human" })).toEqual({ origin: "human" });
});

it("labels isolated tests and preserves their original run across worker contexts", () => {
  vi.stubEnv("BEAVER_TEST_RUN_ID", "run-one");
  vi.stubEnv("BEAVER_TEST_SCENARIO", "Organize synthetic folder");
  const original = resolvePromptSubmission({ origin: "human" });
  expect(original).toEqual({ origin: "machine_test", run_id: "run-one", scenario: "Organize synthetic folder" });
  vi.stubEnv("BEAVER_TEST_RUN_ID", "run-two");
  expect(resolvePromptSubmission(original)).toEqual(original);
});

it.each([
  { origin: "machine_test" }, { origin: "machine_test", run_id: " " },
  { origin: "human", run_id: "incorrect" }, { origin: "guessed_human" },
])("rejects incomplete or contradictory provenance: %j", submission => {
  expect(promptSubmissionSchema.safeParse(submission).success).toBe(false);
});
