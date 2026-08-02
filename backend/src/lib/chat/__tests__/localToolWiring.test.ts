// Unit tests prove each tool executor works. This proves the executors are
// actually REACHABLE: present in the advertised tool list, in the right
// research gate, and routed by the dispatcher rather than falling through to
// an unknown-tool reply. The sealed smoke run cannot cover this, because it
// runs with the research tools disabled.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const userId = "00000000-0000-0000-0000-000000000001";

afterEach(() => {
  delete process.env.MIKE_DISABLE_RESEARCH_TOOLS;
  delete process.env.MIKE_CITATOR_DB;
  delete process.env.MIKE_NAV_SHAPE;
  delete process.env.MIKE_TOOL_SHAPE;
  delete process.env.MIKE_PROGRESSIVE_DISCLOSURE;
  delete process.env.MIKE_CONTEXT_HANDOFF;
  delete process.env.MIKE_MODEL_COVERAGE_ROUTING;
  delete process.env.MIKE_WHOLE_READ_MAX_CHARS;
  delete process.env.MIKE_SLA_WORKFLOW;
  delete process.env.MIKE_SLA_STRATEGY;
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
    expect(names(open.LOCAL_ASSISTANT_TOOLS)).toContain(
      "submit_grounded_answer",
    );

    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    const sealed = await loadTools();
    const sealedNames = names(sealed.LOCAL_ASSISTANT_TOOLS);
    expect(sealedNames).not.toContain("caselaw_note_up");
    expect(sealedNames).not.toContain("submit_grounded_answer");
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

  it("opens deferred domains from trusted schemas without echoing schemas", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    const tools = await loadTools();
    const partition = tools.partitionTools(tools.LOCAL_ASSISTANT_TOOLS);
    expect(names(partition.resident)).toContain("describe_tools");
    expect(names(partition.resident)).not.toContain("library_revise_docx");
    expect(names(partition.deferred)).toContain("library_revise_docx");

    const describe = partition.resident.find(
      (entry) => entry.function.name === "describe_tools",
    )!;
    expect(describe.function.description).not.toContain("[object Object]");
    const domains = (
      describe.function.parameters.properties as {
        domains: { items: { enum: string[] } };
      }
    ).domains.items.enum;
    expect(domains).toEqual(
      expect.arrayContaining([
        "cases",
        "citations",
        "output_document",
        "drafting",
        "document_quality",
      ]),
    );
    expect(domains).not.toContain("research");

    const [response] = await tools.runLocalAssistantTools(userId, [
      {
        id: "describe",
        name: "describe_tools",
        input: { domains: ["citations"] },
      },
    ]);
    const payload = JSON.parse(response.content);
    expect(payload.ok).toBe(true);
    expect(payload).not.toHaveProperty("tools");
    expect(payload.opened).toEqual(
      names(tools.toolsForDomains(partition.deferred, ["citations"])),
    );
    expect(payload.opened).toEqual(
      expect.arrayContaining([
        "courtlistener_verify_citations",
        "library_link_docx_citations",
        "library_fix_docx_supras",
        "toa_submit_library_document",
      ]),
    );
  });

  it("can hold progressive disclosure constant for a coding surface", async () => {
    process.env.MIKE_NAV_SHAPE = "legacy";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "1";
    const tools = await loadTools();
    const partition = tools.partitionTools(tools.LOCAL_ASSISTANT_TOOLS);
    expect(names(partition.resident)).toEqual(
      expect.arrayContaining(["Glob", "Grep", "Read", "describe_tools"]),
    );
    expect(names(partition.resident)).not.toContain("Edit");
    expect(names(partition.deferred)).toEqual(
      expect.arrayContaining(["Edit", "library_create_docx"]),
    );
    expect(names(tools.toolsForDomains(partition.deferred, ["output_document"])))
      .toEqual(["library_create_docx"]);
    const create = tools
      .toolsForDomains(partition.deferred, ["output_document"])
      .find((schema) => schema.function.name === "library_create_docx");
    const createProperties = create?.function.parameters.properties as Record<
      string,
      { description?: string }
    >;
    expect(createProperties.filename.description).toContain("exact output filename");
    expect(createProperties.title.description).not.toContain("filename");
    expect(names(tools.toolsForDomains(partition.deferred, ["drafting"])))
      .not.toContain("library_create_docx");
    expect(names(tools.toolsForDomains(partition.deferred, ["document_quality"])))
      .toEqual(
        expect.arrayContaining([
          "library_lint_docx_structure",
          "library_anchor_coverage",
          "library_conflict_scan",
          "library_term_drift",
          "library_drafting_lint",
        ]),
      );
    const withoutOutput = partition.deferred.filter(
      (schema) => schema.function.name !== "library_create_docx",
    );
    const refreshed = tools.describeToolsTool(withoutOutput);
    const refreshedDomains = (
      refreshed.function.parameters.properties as {
        domains: { items: { enum: string[] } };
      }
    ).domains.items.enum;
    expect(refreshedDomains).not.toContain("output_document");
  });

  it("offers the same neutral coverage choices without classifying task wording", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "1";
    process.env.MIKE_MODEL_COVERAGE_ROUTING = "1";
    process.env.MIKE_WHOLE_READ_MAX_CHARS = "800000";
    const tools = await loadTools();
    expect(tools.WHOLE_READ_MAX_CHARS).toBe(800000);
    const partition = tools.partitionTools(tools.LOCAL_ASSISTANT_TOOLS);
    expect(names(partition.resident)).toEqual(
      expect.arrayContaining(["Glob", "Grep", "Read", "fetch_documents"]),
    );
    const batch = partition.resident.find(
      (entry) => entry.function.name === "fetch_documents",
    )!;
    expect(batch.function.description).toContain("bounded source set");
    expect(batch.function.description).toContain("localized evidence");
    expect(batch.function.description).toContain("cumulative for this turn");
    expect(batch.function.description).not.toMatch(
      /change.of.control|clinical.trial|indenture/iu,
    );

    const prompts = await import("../prompts");
    const guidance = prompts.buildLeanLibraryBlock({
      connectedIntro: "The matter is connected",
      codingShape: true,
      readToolName: "Read",
      editToolName: "Edit",
      progressiveDisclosure: true,
    });
    expect(guidance).toContain("choose coverage from the evidence need");
    expect(guidance).toContain("primary instrument should stay whole");
    expect(guidance).not.toMatch(/change.of.control|clinical.trial|indenture/iu);
  });

  it("does not leak the coverage experiment into the frozen coding baseline", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "1";
    delete process.env.MIKE_MODEL_COVERAGE_ROUTING;
    const tools = await loadTools();
    expect(names(tools.LOCAL_ASSISTANT_TOOLS)).not.toContain(
      "fetch_documents",
    );
  });

  it("keeps the soft coverage lane free of a host whole-read cutoff", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "1";
    process.env.MIKE_MODEL_COVERAGE_ROUTING = "1";
    const tools = await loadTools();
    expect(tools.WHOLE_READ_MAX_CHARS).toBe(0);
    const batch = tools.LOCAL_ASSISTANT_TOOLS.find(
      (entry) => entry.function.name === "fetch_documents",
    )!;
    expect(batch.function.description).toContain("complete text");
    expect(batch.function.description).not.toContain("whole-read budget");
  });

  it("hides model-callable quality tools when the SLA compiler runs them", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_SLA_WORKFLOW = "1";
    const tools = await loadTools();
    const partition = tools.partitionTools(tools.LOCAL_ASSISTANT_TOOLS);
    const all = names([...partition.resident, ...partition.deferred]);
    expect(all).not.toEqual(
      expect.arrayContaining([
        "library_lint_docx_structure",
        "library_anchor_coverage",
        "library_conflict_scan",
        "library_term_drift",
        "library_drafting_lint",
        "library_bilingual_concordance",
      ]),
    );
    const describe = partition.resident.find(
      (entry) => entry.function.name === "describe_tools",
    )!;
    const domains = (
      describe.function.parameters.properties as {
        domains: { items: { enum: string[] } };
      }
    ).domains.items.enum;
    expect(domains).not.toContain("document_quality");
  });

  it("reveals evidence selection only after the host returns a manifest", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "1";
    process.env.MIKE_CONTEXT_HANDOFF = "1";
    const tools = await loadTools();
    const partition = tools.partitionTools(tools.LOCAL_ASSISTANT_TOOLS);
    const initial = partition.resident.find(
      (entry) => entry.function.name === "describe_tools",
    )!;
    const initialProperties = initial.function.parameters.properties as Record<
      string,
      unknown
    >;
    const selectionProperties = tools.describeToolsTool(
      partition.deferred,
      true,
    ).function.parameters.properties as Record<string, unknown>;

    expect(initialProperties).not.toHaveProperty("carry_evidence");
    expect(selectionProperties).toHaveProperty("carry_evidence");
  });
});

describe("tool-result transport ceiling", () => {
  it("bounds an untargeted read and names the calls that fetch the rest", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "beaver-cap-"));
    process.env.OPEN_LEGAL_DATA_HOME = home;
    try {
      vi.resetModules();
      const store = await import("../../localDocumentStore");
      const { runLocalAssistantTools: run } = await import(
        "../localAssistantTools"
      );
      const body =
        "The Tenant shall observe every covenant and shall indemnify the Landlord against all claims arising from any act or omission. ";
      const document = await store.createLocalDocument({
        userId,
        kind: "file",
        filename: "long-thread.eml",
        bytes: Buffer.from(
          `From: a@example.com
Subject: Long thread
Content-Type: text/plain; charset=utf-8

${body.repeat(4000)}`,
          "utf8",
        ),
      });

      const [read] = await run(userId, [
        { id: "r1", name: "library_read", input: { document_id: document.id } },
      ]);
      // Still well-formed JSON, and honest about being a window.
      const parsed = JSON.parse(read.content);
      expect(read.content.length).toBeLessThanOrEqual(64_000);
      expect(parsed.text.length).toBeLessThanOrEqual(24_000);
      expect(parsed.truncated).toBe(true);

      // An explicit larger span is still honoured, but the transport caps the
      // envelope and tells the model how to fetch the remainder.
      const [wide] = await run(userId, [
        {
          id: "r2",
          name: "library_read",
          input: { document_id: document.id, max_chars: 300000 },
        },
      ]);
      expect(wide.content.length).toBeLessThanOrEqual(64_000);
      const wideParsed = JSON.parse(wide.content);
      expect(wideParsed.truncated).toBe(true);
      expect(String(wideParsed.continuation)).toContain("library_outline");
      expect(String(wideParsed.continuation)).toContain(document.id);
    } finally {
      delete process.env.OPEN_LEGAL_DATA_HOME;
      await rm(home, { recursive: true, force: true });
    }
  });
});
