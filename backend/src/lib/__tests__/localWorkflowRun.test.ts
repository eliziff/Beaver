import { describe, expect, it } from "vitest";
import {
  workProductEvent,
} from "../chat/localWorkflowRun";

describe("localWorkflowRun", () => {
  it("preserves the typed work-product destination", () => {
    expect(workProductEvent({
      ok: true,
      work_product: { id: "draft-1", kind: "authorities", revision: 3 },
      requested_action: "open",
    }, "call-2")).toMatchObject({
      type: "workflow_run",
      id: "call-2",
      status: "complete",
      stage: "Update work product",
      work_product: { id: "draft-1", kind: "authorities", revision: 3 },
      requested_action: "open",
    });
  });
});
