// Unit tests prove each tool executor works. This proves the executors are
// actually REACHABLE: present in the advertised tool list, in the right
// research gate, and routed by the dispatcher rather than falling through to
// an unknown-tool reply. The sealed smoke run cannot cover this, because it
// runs with the research tools disabled.
import { afterEach, describe, expect, it, vi } from "vitest";

const userId = "00000000-0000-0000-0000-000000000001";

afterEach(() => {
  delete process.env.MIKE_DISABLE_RESEARCH_TOOLS;
  delete process.env.MIKE_CITATOR_DB;
  vi.resetModules();
});

const loadTools = async () => {
  vi.resetModules();
  return import("../localAssistantTools");
};

const names = (schemas: { function: { name: string } }[]) =>
  schemas.map((schema) => schema.function.name);

describe("local assistant tool wiring", () => {
  it("advertises the always-on document tools", async () => {
    delete process.env.MIKE_DISABLE_RESEARCH_TOOLS;
    const { LOCAL_ASSISTANT_TOOLS } = await loadTools();
    const advertised = names(LOCAL_ASSISTANT_TOOLS);
    expect(advertised).toContain("library_compare_versions");
    expect(advertised).toContain("library_find");
    expect(advertised).toContain("library_read");
  });

  it("offers grep mode and windowed reads as real parameters", async () => {
    const { LOCAL_ASSISTANT_TOOLS } = await loadTools();
    const params = (name: string) =>
      Object.keys(
        (
          LOCAL_ASSISTANT_TOOLS.find((s) => s.function.name === name)?.function
            .parameters as { properties?: Record<string, unknown> }
        )?.properties ?? {},
      );
    expect(params("library_find")).toEqual(
      expect.arrayContaining(["regex", "case_insensitive"]),
    );
    expect(params("library_read")).toEqual(
      expect.arrayContaining(["offset", "max_chars"]),
    );
  });

  it("gates the citator behind the research switch", async () => {
    delete process.env.MIKE_DISABLE_RESEARCH_TOOLS;
    const open = await loadTools();
    expect(names(open.LOCAL_ASSISTANT_TOOLS)).toContain("caselaw_note_up");

    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    const sealed = await loadTools();
    const sealedNames = names(sealed.LOCAL_ASSISTANT_TOOLS);
    expect(sealedNames).not.toContain("caselaw_note_up");
    // Document tools survive the gate; only information sources are removed.
    expect(sealedNames).toContain("library_compare_versions");
  });

  it("routes the new tool names to their executors, not to unknown-tool", async () => {
    // Point the citator at a path with no graph so the reply is the executor's
    // own typed refusal — proof the dispatcher reached it.
    process.env.MIKE_CITATOR_DB = "C:/nonexistent-citator/noteup.sqlite";
    const { runLocalAssistantTools } = await loadTools();

    const [noteUp, compare] = await runLocalAssistantTools(userId, [
      { id: "1", name: "caselaw_note_up", input: { citation: "2019 SCC 65" } },
      { id: "2", name: "library_compare_versions", input: { document_id: "" } },
    ]);

    expect(JSON.parse(noteUp.content)).toMatchObject({
      ok: false,
      error: "citator_not_installed",
    });
    expect(JSON.parse(compare.content)).toMatchObject({
      ok: false,
      error: "document_id is required",
    });
  });
});
