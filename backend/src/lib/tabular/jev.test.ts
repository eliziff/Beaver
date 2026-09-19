import { expect, it } from "vitest";
import { isJevProbeColumn } from "./jev";

it("limits the Jev evidence probe to bounded review columns", () => {
  expect(isJevProbeColumn({
    index: 0,
    name: "Force Majeure",
    format: "yes_no",
    prompt: "Does this agreement contain a force majeure clause?",
  })).toBe(true);

  expect(isJevProbeColumn({
    index: 1,
    name: "Risk",
    format: "tag",
    tags: ["Low", "Medium", "High"],
    prompt: "Classify the risk.",
  })).toBe(true);

  expect(isJevProbeColumn({
    index: 2,
    name: "Termination",
    format: "text",
    prompt: "Summarize all termination rights, notice periods and cure periods.",
  })).toBe(false);
});
