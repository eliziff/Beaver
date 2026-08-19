import { describe, expect, it } from "vitest";
import { appUrl } from "../appRoutes";

describe("appUrl", () => {
  it("builds the real Beaver content routes and encodes ids", () => {
    expect(appUrl({ kind: "project", id: "matter/1" })).toBe(
      "/projects/matter%2F1",
    );
    expect(appUrl({ kind: "library-document" })).toBe("/library");
    expect(
      appUrl({ kind: "library-document", libraryKind: "template" }),
    ).toBe("/library/templates");
    expect(
      appUrl({ kind: "library-document", projectId: "matter-1" }),
    ).toBe("/projects/matter-1");
    expect(appUrl({ kind: "legal-source", id: "source-1" })).toBe(
      "/sources/source-1",
    );
    expect(appUrl({ kind: "authorities", jobId: "job-1" })).toBe(
      "/table-of-authorities?job=job-1",
    );
    expect(
      appUrl({
        kind: "authorities",
        jobId: "job-1",
        projectId: "matter-1",
      }),
    ).toBe("/table-of-authorities?job=job-1&project=matter-1");
    expect(appUrl({ kind: "tabular-review", id: "review-1" })).toBe(
      "/tabular-reviews/review-1",
    );
    expect(
      appUrl({
        kind: "tabular-review",
        id: "review-1",
        projectId: "matter-1",
      }),
    ).toBe("/projects/matter-1/tabular-reviews/review-1");
    expect(
      appUrl({
        kind: "workflow",
        id: "workflow-1",
        workflowType: "assistant",
      }),
    ).toBe("/workflows/assistant/workflow-1");
    expect(
      appUrl({
        kind: "workflow",
        id: "workflow-1",
        workflowType: "tabular",
      }),
    ).toBe("/workflows/tabular-review/workflow-1");
    expect(appUrl({ kind: "chat", id: "chat-1" })).toBe(
      "/assistant/chat/chat-1",
    );
    expect(
      appUrl({ kind: "chat", id: "chat-1", projectId: "matter-1" }),
    ).toBe("/projects/matter-1/assistant/chat/chat-1");
    expect(() => appUrl({ kind: "project", id: " " })).toThrow(
      "requires an id",
    );
  });
});
