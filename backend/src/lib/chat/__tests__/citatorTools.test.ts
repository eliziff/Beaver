import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeCitatorTool } from "../tools/citatorTools";

afterEach(() => {
  delete process.env.MIKE_CITATOR_DB;
});

describe("executeCitatorTool", () => {
  it("ignores foreign tool names", () => {
    expect(executeCitatorTool("library_read", {})).toBeNull();
  });

  it("refuses an empty citation", () => {
    const reply = executeCitatorTool("caselaw_note_up", { citation: "  " });
    expect(reply?.payload).toMatchObject({ ok: false, error: "citation is required" });
  });

  it("reports citator_not_installed when no graph exists", () => {
    process.env.MIKE_CITATOR_DB = path.join(
      __dirname,
      "does-not-exist",
      "noteup.sqlite",
    );
    const reply = executeCitatorTool("caselaw_note_up", {
      citation: "2019 SCC 65",
    });
    expect(reply?.payload).toMatchObject({ ok: false, error: "citator_not_installed" });
  });

  it("rejects conflicting court scopes before opening the graph", () => {
    const reply = executeCitatorTool("caselaw_note_up", {
      citation: "2019 SCC 65",
      court_scope: "appellate",
      court_code: "ONCA",
    });
    expect(reply?.payload).toMatchObject({
      ok: false,
      error: "court_code cannot be combined with a non-all court_scope",
    });
  });
});
