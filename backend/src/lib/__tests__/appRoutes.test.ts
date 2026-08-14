import { describe, expect, it } from "vitest";
import { appUrl } from "../appRoutes";
import { createLegalEvidenceTurnState } from "../chat/legalEvidence";
import { runToolCalls } from "../chat/tools/toolDispatcher";

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
      "/library/legal/source-1",
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

  it("attaches routes to existing Assistant entity results", async () => {
    const output = await runToolCalls(
      [
        {
          id: "documents",
          name: "list_documents",
          input: {},
        },
        {
          id: "workflows",
          name: "list_workflows",
          input: {},
        },
        {
          id: "review",
          name: "read_table_cells",
          input: {},
        },
      ],
      new Map([
        [
          "doc-0",
          {
            filename: "Agreement.docx",
            file_type: "docx",
            storage_path: "unused",
          },
        ],
      ]),
      "user-1",
      null as never,
      () => undefined,
      new Map([
        [
          "workflow-1",
          { title: "Proofread", skill_md: "# Proofread" },
        ],
      ]),
      {
        app_url: "/tabular-reviews/review-1",
        columns: [],
        documents: [],
        cells: new Map(),
      },
      {},
      undefined,
      undefined,
      "matter-1",
      undefined,
      undefined,
      undefined,
      createLegalEvidenceTurnState(),
    );
    const results = output.toolResults;

    expect(JSON.parse(results[0].content)[0].app_url).toBe(
      "/projects/matter-1",
    );
    expect(JSON.parse(results[1].content)[0].app_url).toBe(
      "/workflows/assistant/workflow-1",
    );
    expect(results[2].content).toContain(
      "Review app_url: /tabular-reviews/review-1",
    );
  });
});
