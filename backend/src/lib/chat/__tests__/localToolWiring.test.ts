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
  delete process.env.MIKE_DISABLE_ASK_INPUTS;
  delete process.env.MIKE_CITATOR_DB;
  delete process.env.MIKE_NAV_SHAPE;
  delete process.env.MIKE_TOOL_SHAPE;
  delete process.env.MIKE_RETRIEVAL_EXPERIMENT;
  delete process.env.MIKE_PROGRESSIVE_DISCLOSURE;
  delete process.env.MIKE_CONTEXT_HANDOFF;
  delete process.env.MIKE_RESEARCH_CONTEXT_REFRESH;
  delete process.env.MIKE_FULL_HANDOFF_PROMPT_VARIANT;
  delete process.env.MIKE_CONTINUOUS_EVIDENCE;
  delete process.env.MIKE_DRAFT_HANDOFF_MODE;
  delete process.env.MIKE_DRAFT_HOT_EVIDENCE_MAX_CHARS;
  delete process.env.MIKE_EVIDENCE_PAGE_MAX_CHARS;
  delete process.env.MIKE_MODEL_COVERAGE_ROUTING;
  delete process.env.MIKE_WHOLE_READ_MAX_CHARS;
  delete process.env.MIKE_TOOL_RESULT_CAP;
  delete process.env.MIKE_SUPPRESS_DUPLICATE_WHOLE_READS;
  delete process.env.MIKE_RESIDENT_AUTHORING;
  delete process.env.MIKE_TERMINAL_AUTHORING;
  delete process.env.MIKE_SLA_WORKFLOW;
  delete process.env.MIKE_SLA_STRATEGY;
  delete process.env.MIKE_CONSULT_ATTESTATIONS;
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
    process.env.MIKE_CONSULT_ATTESTATIONS = "1";
    const { runLocalAssistantTools } = await loadTools();

    const [noteUp, consult, compare] = await runLocalAssistantTools(userId, [
      { id: "1", name: "caselaw_note_up", input: { citation: "2019 SCC 65" } },
      {
        id: "2",
        name: "consult_attested_characterization",
        input: { citation: "2016 SCC 27" },
      },
      { id: "3", name: "library_compare_versions", input: { document_id: "" } },
    ]);

    expect(JSON.parse(noteUp.content)).toMatchObject({
      ok: false,
      error: "citator_not_installed",
    });
    expect(JSON.parse(consult.content)).toMatchObject({
      ok: false,
      error: "citator_not_installed",
    });
    expect(JSON.parse(compare.content)).toMatchObject({
      ok: false,
      error: "document_id is required",
    });
  });

  it("gates consult_attested_characterization behind its experiment flag", async () => {
    delete process.env.MIKE_CONSULT_ATTESTATIONS;
    delete process.env.MIKE_DISABLE_RESEARCH_TOOLS;
    const off = await loadTools();
    expect(names(off.LOCAL_ASSISTANT_TOOLS)).not.toContain(
      "consult_attested_characterization",
    );
    // The citator tool itself is unaffected by the new flag.
    expect(names(off.LOCAL_ASSISTANT_TOOLS)).toContain("caselaw_note_up");

    process.env.MIKE_CONSULT_ATTESTATIONS = "1";
    const on = await loadTools();
    expect(names(on.LOCAL_ASSISTANT_TOOLS)).toContain(
      "consult_attested_characterization",
    );

    // The research-tools gate still overrides the experiment flag.
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    const sealed = await loadTools();
    expect(names(sealed.LOCAL_ASSISTANT_TOOLS)).not.toContain(
      "consult_attested_characterization",
    );
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

  it("keeps ordinary authoring resident without advertising an empty output domain", async () => {
    process.env.MIKE_NAV_SHAPE = "legacy";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "1";
    process.env.MIKE_RESIDENT_AUTHORING = "1";
    process.env.MIKE_TERMINAL_AUTHORING = "1";
    const tools = await loadTools();
    const partition = tools.partitionTools(tools.LOCAL_ASSISTANT_TOOLS);
    const resident = names(partition.resident);
    const deferred = names(partition.deferred);

    expect(resident).toContain("library_create_docx");
    expect(deferred).not.toContain("library_create_docx");
    expect(tools.TERMINAL_AUTHORING_ENABLED).toBe(true);
    expect(
      partition.resident.find(
        (entry) => entry.function.name === "library_create_docx",
      )?.function.description,
    ).toContain("turn ends without another model round");
    const describe = partition.resident.find(
      (entry) => entry.function.name === "describe_tools",
    )!;
    const domains = (
      describe.function.parameters.properties as {
        domains: { items: { enum: string[] } };
      }
    ).domains.items.enum;
    expect(domains).not.toContain("output_document");

    const [response] = await tools.runLocalAssistantTools(userId, [
      {
        id: "describe-output",
        name: "describe_tools",
        input: { domains: ["output_document"] },
      },
    ]);
    expect(response.status).toBe("error");
    expect(response.content).not.toContain("library_create_docx");
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

  it("keeps the upstream-terminal prompt and tool schema byte-equal to upstream", async () => {
    process.env.MIKE_TOOL_SHAPE = "upstream-mike";
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "0";
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    process.env.MIKE_DISABLE_ASK_INPUTS = "1";
    process.env.MIKE_TERMINAL_AUTHORING = "0";
    const upstream = await loadTools();
    const schema = JSON.stringify(upstream.LOCAL_ASSISTANT_TOOLS);
    const surface = await import("../upstreamMikeBenchmarkSurface");

    process.env.MIKE_TERMINAL_AUTHORING = "1";
    const terminal = await loadTools();
    const terminalSurface = await import("../upstreamMikeBenchmarkSurface");

    expect(JSON.stringify(terminal.LOCAL_ASSISTANT_TOOLS)).toBe(schema);
    expect(terminal.TERMINAL_AUTHORING_ENABLED).toBe(true);
    expect(terminal.UPSTREAM_MIKE_TOOL_SHAPE).toBe(true);
    expect(terminalSurface.UPSTREAM_MIKE_LAB_SYSTEM_PROMPT).toBe(
      surface.UPSTREAM_MIKE_LAB_SYSTEM_PROMPT,
    );
    expect(terminalSurface.UPSTREAM_TERMINAL_DELTA).toBe(
      "terminal-successful-generate-v1",
    );
  });

  it("changes only upstream authoring to compact Markdown", async () => {
    process.env.MIKE_TOOL_SHAPE = "mike-compact-author-v1";
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "0";
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    process.env.MIKE_DISABLE_ASK_INPUTS = "1";
    const tools = await loadTools();
    const surface = await import("../upstreamMikeBenchmarkSurface");

    expect(names(tools.LOCAL_ASSISTANT_TOOLS)).toEqual([
      "read_document",
      "find_in_document",
      "list_documents",
      "fetch_documents",
      "generate_docx",
    ]);
    expect(
      JSON.stringify(tools.LOCAL_ASSISTANT_TOOLS.slice(0, 4)),
    ).toBe(JSON.stringify(surface.UPSTREAM_MIKE_RETRIEVAL_TOOLS));
    const generate = tools.LOCAL_ASSISTANT_TOOLS.at(-1)!;
    expect(generate.function.parameters.required).toEqual([
      "title",
      "markdown",
    ]);
    expect(generate.function.parameters.properties).toHaveProperty("markdown");
    expect(generate.function.parameters.properties).not.toHaveProperty("sections");
    expect(surface.COMPACT_AUTHOR_MIKE_LAB_SYSTEM_PROMPT).not.toMatch(
      /pageBreak|sections/iu,
    );
  });

  it("keeps lean and hard-reference model surfaces byte-identical", async () => {
    process.env.MIKE_TOOL_SHAPE = "lean-batch-v1";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "p0-pure-coding";
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "0";
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    process.env.MIKE_DISABLE_ASK_INPUTS = "1";
    const lean = await loadTools();
    const leanSchema = JSON.stringify(lean.LOCAL_ASSISTANT_TOOLS);

    process.env.MIKE_TOOL_SHAPE = "lean-batch-hardrefs-v1";
    const hardrefs = await loadTools();
    const surface = await import("../upstreamMikeBenchmarkSurface");

    expect(names(lean.LOCAL_ASSISTANT_TOOLS)).toEqual([
      "list_documents",
      "Grep",
      "Read",
      "generate_docx",
    ]);
    expect(JSON.stringify(hardrefs.LOCAL_ASSISTANT_TOOLS)).toBe(leanSchema);
    expect(JSON.stringify(surface.LEAN_BATCH_LAB_TOOLS)).toBe(leanSchema);
    const schemas = JSON.stringify(lean.LOCAL_ASSISTANT_TOOLS);
    expect(schemas).not.toMatch(/\.mike\/structure|"section"|"pages"/u);
    const read = lean.LOCAL_ASSISTANT_TOOLS.find(
      (entry) => entry.function.name === "Read",
    )!;
    expect(read.function.parameters.required).toEqual(["paths"]);
    expect(read.function.parameters.properties).toHaveProperty("offset");
    expect(read.function.parameters.properties).toHaveProperty("limit");
    expect(surface.LEAN_BATCH_LAB_SYSTEM_PROMPT).not.toMatch(
      /change.of.control|transfer.pric|indenture/iu,
    );
  });

  it.each([
    ["mike-grep-v1", "p0-pure-coding", false],
    ["mike-legal-v1", "h4-legal-grep", true],
    ["mike-legal-guided-v1", "h4-legal-grep", true],
    ["mike-structure-paths-v1", "s1-structure-paths", false],
  ])("keeps the %s arm to Mike plus Grep and Read", async (shape, experiment, legal) => {
    process.env.MIKE_TOOL_SHAPE = shape;
    process.env.MIKE_RETRIEVAL_EXPERIMENT = experiment;
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "0";
    process.env.MIKE_TERMINAL_AUTHORING = "1";
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    process.env.MIKE_DISABLE_ASK_INPUTS = "1";
    const tools = await loadTools();
    expect(names(tools.LOCAL_ASSISTANT_TOOLS)).toEqual([
      "read_document",
      "find_in_document",
      "list_documents",
      "fetch_documents",
      "Grep",
      "Read",
      "generate_docx",
    ]);
    const properties = (name: string) =>
      Object.keys(
        (
          tools.LOCAL_ASSISTANT_TOOLS.find(
            (entry) => entry.function.name === name,
          )?.function.parameters as { properties: Record<string, unknown> }
        ).properties,
      );
    expect(properties("Grep").includes("section")).toBe(legal);
    expect(properties("Grep").includes("pages")).toBe(legal);
    expect(properties("Read").includes("section")).toBe(legal);
    expect(properties("Read").includes("pages")).toBe(legal);
    expect(properties("Read").includes("start_char")).toBe(!legal);
    expect(tools.ORIGIN_MIKE_TOOL_SHAPE).toBe(true);
    expect(tools.CODING_TOOL_SHAPE).toBe(true);
  });

  it("keeps structure paths inside ordinary Grep and Read schemas", async () => {
    process.env.MIKE_TOOL_SHAPE = "mike-structure-paths-v1";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "s1-structure-paths";
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "0";
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    process.env.MIKE_DISABLE_ASK_INPUTS = "1";
    const tools = await loadTools();
    const surface = await import("../upstreamMikeBenchmarkSurface");
    const schemas = JSON.stringify(tools.LOCAL_ASSISTANT_TOOLS);

    expect(schemas).toContain(".mike/structure/");
    expect(schemas).not.toContain('"section"');
    expect(schemas).not.toContain('"pages"');
    expect(surface.MIKE_STRUCTURE_PATHS_LAB_SYSTEM_PROMPT).toContain(
      "never invent one",
    );
    expect(surface.MIKE_STRUCTURE_PATHS_LAB_SYSTEM_PROMPT).not.toMatch(
      /change.of.control|transfer.pric|indenture/iu,
    );
  });

  it("changes only guidance between the two legal Mike candidates", async () => {
    process.env.MIKE_TOOL_SHAPE = "mike-legal-v1";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "h4-legal-grep";
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "0";
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    process.env.MIKE_DISABLE_ASK_INPUTS = "1";
    const unguided = await loadTools();
    const unguidedSchema = JSON.stringify(unguided.LOCAL_ASSISTANT_TOOLS);
    process.env.MIKE_TOOL_SHAPE = "mike-legal-guided-v1";
    const guided = await loadTools();
    const surface = await import("../upstreamMikeBenchmarkSurface");
    expect(JSON.stringify(guided.LOCAL_ASSISTANT_TOOLS)).toBe(unguidedSchema);
    expect(surface.MIKE_LEGAL_GUIDED_LAB_SYSTEM_PROMPT).toContain(
      "SCOPED READING GUIDANCE",
    );
    expect(surface.MIKE_GREP_LAB_SYSTEM_PROMPT).not.toContain(
      "SCOPED READING GUIDANCE",
    );
    expect(surface.MIKE_LEGAL_GUIDED_LAB_SYSTEM_PROMPT).not.toMatch(
      /change.of.control|transfer.pric|indenture/iu,
    );
  });

  it("reconstructs v5's four-tool resident research surface", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "h4-legal-grep";
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "1";
    process.env.MIKE_MODEL_COVERAGE_ROUTING = "0";
    process.env.MIKE_CONTEXT_HANDOFF = "1";
    process.env.MIKE_RESEARCH_CONTEXT_REFRESH = "0";
    process.env.MIKE_FULL_HANDOFF_PROMPT_VARIANT = "legacy-v5";
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    process.env.MIKE_DISABLE_ASK_INPUTS = "1";
    const tools = await loadTools();
    const partition = tools.partitionTools(tools.LOCAL_ASSISTANT_TOOLS);
    expect(names(partition.resident)).toEqual([
      "Glob",
      "Grep",
      "Read",
      "describe_tools",
    ]);
  });

  it("serves the frozen v13 resident surface without a context-memory layer", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "p0-pure-coding";
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "1";
    process.env.MIKE_MODEL_COVERAGE_ROUTING = "1";
    process.env.MIKE_WHOLE_READ_MAX_CHARS = "800000";
    process.env.MIKE_TOOL_RESULT_CAP = "51200";
    process.env.MIKE_SUPPRESS_DUPLICATE_WHOLE_READS = "0";
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    process.env.MIKE_DISABLE_ASK_INPUTS = "1";
    const tools = await loadTools();
    const partition = tools.partitionTools(tools.LOCAL_ASSISTANT_TOOLS);

    expect(names(partition.resident)).toEqual([
      "Glob",
      "fetch_documents",
      "Grep",
      "Read",
      "describe_tools",
    ]);
    expect(tools.WHOLE_READ_MAX_CHARS).toBe(800_000);
    expect(tools.MAX_TOOL_RESULT_CHARS).toBe(51_200);
    expect(tools.SUPPRESS_DUPLICATE_WHOLE_READS).toBe(false);
    expect(
      partition.resident.find(
        (entry) => entry.function.name === "fetch_documents",
      )?.function.description,
    ).toContain("repeated file/version read returns its exact text again");
    expect(names(partition.resident)).not.toEqual(
      expect.arrayContaining([
        "checkpoint_research",
        "library_evidence",
        "library_revise_docx",
      ]),
    );
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

  it("keeps the reviewed drafting checkpoint host-side in paged handoff mode", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_PROGRESSIVE_DISCLOSURE = "1";
    process.env.MIKE_CONTEXT_HANDOFF = "1";
    process.env.MIKE_DRAFT_HANDOFF_MODE = "paged";
    const tools = await loadTools();
    const partition = tools.partitionTools(tools.LOCAL_ASSISTANT_TOOLS);
    const describe = partition.resident.find(
      (entry) => entry.function.name === "describe_tools",
    )!;
    const properties = describe.function.parameters.properties as Record<
      string,
      unknown
    >;
    const retryProperties = tools.describeToolsTool(
      partition.deferred,
      true,
    ).function.parameters.properties as Record<string, unknown>;

    expect(describe.function.description).toContain("demand-paged exact evidence");
    expect(properties).not.toHaveProperty("drafting_brief");
    expect(properties).not.toHaveProperty("carry_evidence");
    expect(retryProperties).not.toHaveProperty("drafting_brief");
    expect(retryProperties).not.toHaveProperty("carry_evidence");
    const readProperties = (
      tools.LOCAL_ASSISTANT_TOOLS.find(
        (entry) => entry.function.name === "Read",
      )!.function.parameters as { properties: Record<string, unknown> }
    ).properties;
    expect(readProperties).toHaveProperty("start_char");
    expect(tools.WORKING_SET_PAGE_MAX_CHARS).toBe(24_000);
  });

  it("exposes bounded evidence recovery without enabling a context handoff", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_CONTINUOUS_EVIDENCE = "1";
    const tools = await loadTools();
    const grep = tools.LOCAL_ASSISTANT_TOOLS.find(
      (entry) => entry.function.name === "Grep",
    )!;
    const read = tools.LOCAL_ASSISTANT_TOOLS.find(
      (entry) => entry.function.name === "Read",
    )!;
    const readProperties = (read.function.parameters as {
      properties: Record<string, unknown>;
    }).properties;

    expect(tools.DEMAND_PAGED_EVIDENCE_ENABLED).toBe(true);
    expect(grep.function.description).toContain(tools.WORKING_SET_PATH);
    expect(readProperties).toHaveProperty("start_char");
    expect(tools.WORKING_SET_PAGE_MAX_CHARS).toBe(24_000);
    expect(process.env.MIKE_CONTEXT_HANDOFF).toBeUndefined();
  });
});

describe("tool-result transport ceiling", () => {
  it("centres paged working-set hits and continues oversized exact lines", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_CONTEXT_HANDOFF = "1";
    process.env.MIKE_DRAFT_HANDOFF_MODE = "paged";
    process.env.MIKE_DRAFT_HOT_EVIDENCE_MAX_CHARS = "24000";
    const tools = await loadTools();
    const header = "=== long-contract.docx | section 9.2 ===\n";
    const target = "TARGET_NEAR_TAIL";
    const passage = `${"A".repeat(30_000)}${target}${"B".repeat(60_000)}`;
    const text = `${header}${passage}\n`;
    const workingSets = new Map([
      [
        tools.WORKING_SET_PATH,
        {
          path: tools.WORKING_SET_PATH,
          text,
          sourceChars: passage.length,
          matchedSourceChars: passage.length,
          immutableSourceChars: passage.length,
          mapChars: header.length + 1,
          budgetChars: 0,
          mappedVersions: ["d1:v1"],
          segments: [
            {
              virtualStart: header.length,
              virtualEnd: header.length + passage.length,
              documentId: "d1",
              versionId: "v1",
              sourceStart: 0,
              sourceEnd: passage.length,
              durableUnionBacked: true,
            },
          ],
          refs: [],
          demandPaged: true,
          readGrants: new Set<string>(),
        },
      ],
    ]);
    const run = (calls: Array<{ id: string; name: string; input: any }>) =>
      tools.runLocalAssistantTools(
        userId,
        calls,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        workingSets,
      );

    const [grep] = await run([
      {
        id: "g-long",
        name: "Grep",
        input: {
          pattern: target,
          path: tools.WORKING_SET_PATH,
          output_mode: "content",
        },
      },
    ]);
    expect(grep.content).toContain(target);
    expect(grep.content.length).toBeLessThanOrEqual(24_000);
    expect(grep.evidenceSegments?.[0]).toEqual(
      expect.objectContaining({
        documentId: "d1",
        versionId: "v1",
        durableUnionBacked: true,
      }),
    );
    expect(grep.evidenceSegments?.[0].start).toBeGreaterThan(28_000);
    expect(grep.content).toContain("exact Read recipe");
    const targetStart = Number(/start_char=(\d+)/u.exec(grep.content)?.[1]);
    expect(targetStart).toBeGreaterThan(28_000);

    const [unlocated] = await run([
      {
        id: "r-long-unlocated",
        name: "Read",
        input: { file_path: tools.WORKING_SET_PATH, offset: 2, limit: 1 },
      },
    ]);
    expect(unlocated.status).toBe("selection_required");
    expect(unlocated.content).toContain("Use Grep");

    const [first] = await run([
      {
        id: "r-long-1",
        name: "Read",
        input: {
          file_path: tools.WORKING_SET_PATH,
          offset: 2,
          limit: 1,
          start_char: targetStart,
        },
      },
    ]);
    expect(first.content.length).toBeLessThanOrEqual(24_000);
    expect(first.content).toContain(target);
    expect(first.content).toContain("start_char=");
    const nextChar = Number(/start_char=(\d+)/u.exec(first.content)?.[1]);
    expect(nextChar).toBeGreaterThan(targetStart);

    const [second] = await run([
      {
        id: "r-long-2",
        name: "Read",
        input: {
          file_path: tools.WORKING_SET_PATH,
          offset: 2,
          limit: 1,
          start_char: nextChar,
        },
      },
    ]);
    expect(second.content.length).toBeLessThanOrEqual(24_000);
    expect(second.content).toContain("B".repeat(1_000));
  });

  it("preserves provider evidence receipts through virtual working-set Grep", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    const tools = await loadTools();
    const header = "=== provider.html | para 12 ===\n";
    const passage = "The exact provider passage controls.";
    const text = `${header}${passage}\n`;
    const workingSets = new Map([
      [
        tools.WORKING_SET_PATH,
        {
          path: tools.WORKING_SET_PATH,
          text,
          sourceChars: passage.length,
          matchedSourceChars: passage.length,
          mapChars: header.length + 1,
          budgetChars: passage.length,
          mappedVersions: [],
          segments: [],
          refs: [
            {
              virtualStart: header.length,
              virtualEnd: header.length + passage.length,
              handle: "provider:12",
              filename: "provider.html",
              locator: "para 12",
              exactSha256: "original-hash",
              durableUnionBacked: true,
            },
          ],
        },
      ],
    ]);

    const [grep] = await tools.runLocalAssistantTools(
      userId,
      [
        {
          id: "g1",
          name: "Grep",
          input: {
            pattern: "provider passage",
            path: tools.WORKING_SET_PATH,
            output_mode: "content",
          },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workingSets,
    );

    expect(grep.content).toContain(passage);
    expect(grep.evidenceRefs).toEqual([
      expect.objectContaining({
        handle: `provider:12#chars=0-${passage.length}`,
        filename: "provider.html",
        locator: "para 12",
        text: passage,
        durableUnionBacked: true,
      }),
    ]);
  });

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
