import { describe, expect, it } from "vitest";
import {
  supraFixEvent,
  workProductEvent,
} from "../chat/localWorkflowRun";

describe("localWorkflowRun", () => {
  it("preserves the visible workflow result", () => {
    expect(supraFixEvent({
      ok: true,
      document_id: "document-1",
      version_id: "version-2",
      filename: "Brief - supras fixed.docx",
      detected: 4,
      converted: 3,
      already_linked: 1,
      review_required: 0,
    }, "call-1")).toMatchObject({
      type: "workflow_run",
      id: "call-1",
      status: "complete",
      counts: expect.arrayContaining([
        { label: "Found", value: 4 },
        { label: "Fixed", value: 3 },
      ]),
    });
  });

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
