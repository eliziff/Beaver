import { describe, expect, it } from "vitest";
import {
  SYSTEM_ASSISTANT_WORKFLOWS,
  SYSTEM_WORKFLOWS,
} from "../systemWorkflows";

describe("system workflow projection", () => {
  it("reuses assistant workflow data without changing the public shape", () => {
    expect(SYSTEM_ASSISTANT_WORKFLOWS).toEqual(
      SYSTEM_WORKFLOWS.filter(
        (workflow) => workflow.metadata.type === "assistant",
      ).map((workflow) => ({
        id: workflow.id,
        title: workflow.metadata.title,
        skill_md: workflow.skill_md ?? "",
      })),
    );
  });
});
