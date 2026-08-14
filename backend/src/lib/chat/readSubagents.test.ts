import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("../codexCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../codexCatalog")>()),
  getCodexModelCatalog: mocks.catalog,
}));
vi.mock("../llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm")>()),
  streamChatWithTools: mocks.stream,
}));

import {
  allowedReadSubagentRegions,
  createReadSubagentAdmission,
  getReadSubagentCapability,
  readSubagentTools,
  resumableReadSubagents,
  runReadSubagent,
  runReadSubagentRound,
  type ReadSubagentCheckpoint,
} from "./readSubagents";
import type { OpenAIToolSchema } from "../llm";
import {
  createLegalEvidenceTurnState,
  LEGAL_EVIDENCE_SUBMIT_TOOL,
  registerLegalEvidence,
  submitLegalEvidenceAnswer,
} from "./legalEvidence";

const catalog = {
  source: "live" as const,
  models: [
    {
      slug: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna",
      supportedReasoningLevels: [{ effort: "high" }],
      serviceTiers: [],
      additionalSpeedTiers: [],
    },
  ],
};
const schema = (name: string): OpenAIToolSchema => ({
  type: "function",
  function: {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
  },
});

function leaseEvidenceState() {
  const state = createLegalEvidenceTurnState("citation_structure");
  registerLegalEvidence(state, {
    evidence_id: "e_lease",
    provider: "library",
    jurisdiction: "CA",
    source_class: "commentary",
    stable_source_id: "library:lease:v1",
    source_sha256: "sha256:source",
    scope: "passage",
    block_id: "page:4",
    exact_span_sha256: "sha256:exact",
    span_sha256: "sha256:normalized",
    span_text: "The lease renews automatically for successive one-year terms.",
    citation: "Lease.pdf",
    name: null,
    dataset: "library",
    language: "en",
    version: "v1",
    external_url: null,
    locator: { kind: "page", label: "4" },
    resolver_version: "library-read-v1",
  });
  return state;
}

describe("reading agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.catalog.mockResolvedValue(catalog);
    mocks.stream.mockResolvedValue({ fullText: "Finding: Lease.pdf, p. 4 — excerpt." });
    delete process.env.MIKE_READ_SUBAGENTS;
    delete process.env.MIKE_READ_SUBAGENT_MODEL;
    delete process.env.MIKE_READ_SUBAGENT_EFFORT;
  });

  it("advertises only a model and effort present in the capability catalog", async () => {
    await expect(getReadSubagentCapability(catalog)).resolves.toMatchObject({
      available: true,
      model: "gpt-5.6-luna",
      effort: "high",
    });
    await expect(
      getReadSubagentCapability({ ...catalog, models: [] }),
    ).resolves.toMatchObject({ available: false });
    await expect(
      getReadSubagentCapability(
        {
          ...catalog,
          models: [
            ...catalog.models,
            {
              ...catalog.models[0],
              slug: "gpt-5.6-terra",
              displayName: "GPT-5.6 Terra",
              supportedReasoningLevels: [{ effort: "medium" }],
            },
          ],
        },
        { model: "codex:gpt-5.6-terra", effort: "medium" },
      ),
    ).resolves.toMatchObject({
      available: true,
      model: "gpt-5.6-terra",
      effort: "medium",
    });
  });

  it("exposes only legal research tools inside the assigned country boundary", () => {
    const tools = [
      schema("Read"),
      schema("library_find"),
      schema("SearchSources"),
      schema("courtlistener_find_in_case"),
      schema("public_legal_source_lookup"),
      schema("Edit"),
      schema("generate_docx"),
      schema("submit_grounded_answer"),
    ];
    expect(readSubagentTools(tools).map((tool) => tool.function.name)).toEqual([
      "SearchSources",
      "public_legal_source_lookup",
    ]);
    expect(readSubagentTools(tools, "US").map((tool) => tool.function.name)).toEqual([
      "SearchSources",
      "courtlistener_find_in_case",
      "public_legal_source_lookup",
    ]);
  });

  it("admits multiple rounds of two to four distinct reading scopes", () => {
    const admit = createReadSubagentAdmission();
    const calls = ["Supreme Court", "appellate courts", "commentary", "trial courts", "citator", "journals"].map(
      (scope, index) => ({
        id: `read-${index}`,
        name: "delegate_read",
        input: { task: "Find responsive authorities.", scope },
      }),
    );
    const first = admit(calls.slice(0, 4));
    expect(first.accepted.map((call) => call.input.scope)).toEqual([
      "Supreme Court",
      "appellate courts",
      "commentary",
      "trial courts",
    ]);
    expect(first.rejected).toEqual([]);
    expect(
      createReadSubagentAdmission()(calls).rejected[0]?.content,
    ).toContain("at most 4");
    const later = admit([
      {
        id: "later-1",
        name: "delegate_read",
        input: { task: "Try the exact phrase.", scope: "phrase search" },
      },
      {
        id: "later-2",
        name: "delegate_read",
        input: { task: "Check citing cases.", scope: "citator search" },
      },
    ]);
    expect(later.accepted).toHaveLength(2);
    expect(admit([
      { ...calls[0], id: "later-duplicate" },
      {
        id: "later-new",
        name: "delegate_read",
        input: { task: "Inspect dockets.", scope: "docket search" },
      },
    ]).rejected.map((result) => result.content).join("\n")).toContain(
      "duplicates",
    );
    expect(
      createReadSubagentAdmission()([
        calls[0],
        { ...calls[0], id: "duplicate" },
      ]).rejected[0]?.content,
    ).toContain("duplicates");
    expect(createReadSubagentAdmission()([calls[0]])).toMatchObject({
      accepted: [calls[0]],
      rejected: [],
    });
  });

  it("keeps delegated reading in Canada unless the user or settings select a foreign region", () => {
    const calls = [
      {
        id: "ca",
        name: "delegate_read",
        input: { task: "Find responsive authorities.", scope: "Ontario courts" },
      },
      {
        id: "ca-2",
        name: "delegate_read",
        input: { task: "Find responsive authorities.", scope: "Quebec courts" },
      },
      {
        id: "us",
        name: "delegate_read",
        input: { task: "Find US decisions.", scope: "United States courts", jurisdiction: "US" },
      },
      {
        id: "uk",
        name: "delegate_read",
        input: { task: "Find UK decisions.", scope: "English law", jurisdiction: "UK" },
      },
    ];

    const canadian = createReadSubagentAdmission()(calls);
    expect(canadian.accepted.map((call) => call.id)).toEqual(["ca", "ca-2"]);
    expect(canadian.rejected.map((result) => result.content)).toEqual([
      expect.stringContaining("US law is outside"),
      expect.stringContaining("UK law is outside"),
    ]);

    const request = "Compare Canadian, US and UK decisions.";
    const selected = allowedReadSubagentRegions(
      { mode: "ask", jurisdictions: ["Canada"] },
      request,
    );
    expect(
      createReadSubagentAdmission(3, selected)(
        calls.slice(0, 1).concat(calls.slice(2)),
      ).accepted,
    ).toHaveLength(3);
    expect(
      allowedReadSubagentRegions(
        { mode: "ask", jurisdictions: ["Canada"] },
        "Survey the relevant jurisdictions.",
      ),
    ).toEqual(new Set(["CA"]));
  });

  it("returns only the receipt-backed grounded submission", async () => {
    const events: unknown[] = [];
    const evidenceState = leaseEvidenceState();
    const parentEvidenceState = createLegalEvidenceTurnState(null);
    mocks.stream.mockImplementationOnce(async (params) => {
      await params.runTools?.([
        {
          id: "submit-1",
          name: "submit_grounded_answer",
          input: {
            claims: [
              {
                text: "The lease renews for successive one-year terms.",
                evidence_ids: ["e_lease"],
              },
            ],
          },
        },
      ]);
      return { fullText: "This ungrounded prose must be ignored." };
    });
    const result = await runReadSubagent({
      call: {
        id: "read-1",
        name: "delegate_read",
        input: {
          task: "Find the renewal clause.",
          scope: "The attached lease",
        },
      },
      tools: [schema("a2aj_search"), LEGAL_EVIDENCE_SUBMIT_TOOL],
      evidenceState,
      publishEvidenceTo: parentEvidenceState,
      runTools: async (calls) =>
        calls.map((call) => {
          const submitted = submitLegalEvidenceAnswer(
            call.input,
            evidenceState,
          );
          return {
            tool_use_id: call.id,
            status: submitted.ok ? ("ok" as const) : ("error" as const),
            content: JSON.stringify(submitted),
            terminal: submitted.terminal,
          };
        }),
      onEvent: (event) => events.push(event),
    });

    expect(result.status, result.content).toBe("ok");
    expect(mocks.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "codex:gpt-5.6-luna",
        reasoningEffort: "high",
        systemPrompt: expect.stringContaining("submit_grounded_answer"),
      }),
    );
    expect(mocks.stream.mock.calls[0]?.[0].maxIterations).toBeUndefined();
    expect(events[0]).toEqual(
      expect.objectContaining({ id: "read-1", status: "running" }),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        id: "read-1",
        status: "completed",
        activities: [
          expect.objectContaining({
            label: "Grounding findings",
            status: "completed",
          }),
        ],
        grounding: expect.objectContaining({ status: "passed" }),
      }),
    );
    expect(result.content).toContain("successive one-year terms");
    expect(result.content).not.toContain("ungrounded prose");
    expect(parentEvidenceState.evidence.has("e_lease")).toBe(true);
  });

  it("carries discovered case metadata into the later read activity", async () => {
    const evidenceState = leaseEvidenceState();
    const events: unknown[] = [];
    mocks.stream.mockImplementationOnce(async (params) => {
      await params.runTools?.([{
        id: "search-1",
        name: "SearchSources",
        input: { query: "fentanyl contact", source_types: ["case"] },
      }]);
      await params.runTools?.([{
        id: "fetch-1",
        name: "a2aj_fetch",
        input: { citation: "2020 BCSC 1122", doc_type: "cases" },
      }]);
      await params.runTools?.([3, 5, 7, 9].map((locator) => ({
        id: `lookup-${locator}`,
        name: "a2aj_lookup",
        input: {
          citation: "2020 BCSC 1122",
          doc_type: "cases",
          locator_type: "paragraph",
          locator: String(locator),
        },
      })));
      await params.runTools?.([{
        id: "submit-1",
        name: "submit_grounded_answer",
        input: {
          claims: [{
            text: "The lease renews for successive one-year terms.",
            evidence_ids: ["e_lease"],
          }],
        },
      }]);
      return { fullText: "" };
    });
    const result = await runReadSubagent({
      call: {
        id: "read-case",
        name: "delegate_read",
        input: { task: "Find the case.", scope: "British Columbia" },
      },
      tools: [
        schema("SearchSources"),
        schema("a2aj_fetch"),
        schema("a2aj_lookup"),
        LEGAL_EVIDENCE_SUBMIT_TOOL,
      ],
      evidenceState,
      runTools: async (calls) => calls.map((call) => {
        if (call.name === "SearchSources") {
          return {
            tool_use_id: call.id,
            status: "ok" as const,
            content: JSON.stringify({
              results: [{
                provider: "a2aj",
                source_type: "case",
                identifier: "2020 BCSC 1122",
                title: "Royal Bank of Canada v. Mysak",
                citation: "2020 BCSC 1122",
                collection: "BCSC",
                url: "https://example.test/2020BCSC1122",
              }],
            }),
          };
        }
        if (call.name === "submit_grounded_answer") {
          const submitted = submitLegalEvidenceAnswer(call.input, evidenceState);
          return {
            tool_use_id: call.id,
            status: submitted.ok ? ("ok" as const) : ("error" as const),
            content: JSON.stringify(submitted),
          };
        }
        return { tool_use_id: call.id, status: "ok" as const, content: "{}" };
      }),
      onEvent: (event) => events.push(event),
    });

    expect(events.at(-1)).toMatchObject({
      sources: [{
        citation: "2020 BCSC 1122",
        name: "Royal Bank of Canada v. Mysak",
      }],
      activities: expect.arrayContaining([
        expect.objectContaining({
          id: "fetch-1",
          label: "Reading Royal Bank of Canada v. Mysak, 2020 BCSC 1122",
          source: expect.objectContaining({ citation: "2020 BCSC 1122" }),
        }),
      ]),
    });
    const sourceReads = (
      events.at(-1) as { activities?: Array<{ source?: { citation: string }; paragraphs?: string[] }> }
    ).activities?.filter((activity) => activity.source?.citation === "2020 BCSC 1122");
    expect(sourceReads).toHaveLength(1);
    expect(sourceReads?.[0]?.paragraphs).toEqual(["3", "5", "7", "9"]);
    expect(JSON.parse(result.content)).toMatchObject({
      evidence: [expect.objectContaining({
        evidence_id: "e_lease",
        exact_passage: expect.stringContaining("successive one-year terms"),
      })],
      searches: [expect.objectContaining({
        tool: "SearchSources",
        query: expect.stringContaining("fentanyl contact"),
        summary: expect.stringContaining("2020 BCSC 1122"),
      })],
    });
  });

  it("keeps revising until a grounded submission passes", async () => {
    const evidenceState = leaseEvidenceState();
    mocks.stream.mockImplementation(async (params) => {
      if (mocks.stream.mock.calls.length === 3) {
        await params.runTools?.([
          {
            id: "submit-3",
            name: "submit_grounded_answer",
            input: {
              claims: [
                {
                  text: "The lease renews for successive one-year terms.",
                  evidence_ids: ["e_lease"],
                },
              ],
            },
          },
        ]);
      }
      return { fullText: "" };
    });
    const result = await runReadSubagent({
      call: {
        id: "read-2",
        name: "delegate_read",
        input: {
          task: "Review the authorities.",
          scope: "Canadian appellate cases",
        },
      },
      tools: [LEGAL_EVIDENCE_SUBMIT_TOOL],
      evidenceState,
      runTools: async (calls) =>
        calls.map((call) => {
          const submitted = submitLegalEvidenceAnswer(call.input, evidenceState);
          return {
            tool_use_id: call.id,
            status: submitted.ok ? ("ok" as const) : ("error" as const),
            content: JSON.stringify(submitted),
            terminal: submitted.terminal,
          };
        }),
    });

    expect(result.status, result.content).toBe("ok");
    expect(mocks.stream).toHaveBeenCalledTimes(3);
    expect(mocks.stream.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining(
              "Your previous attempt did not pass the grounding gate",
            ),
          }),
        ],
        systemPrompt: expect.stringContaining("text and evidence_ids"),
      }),
    );
    expect(mocks.stream.mock.calls[2]?.[0].messages[0].content).toContain(
      "Continue revising",
    );
  });

  it("accepts a tool-only Codex ending after grounding passes", async () => {
    const evidenceState = leaseEvidenceState();
    mocks.stream.mockImplementationOnce(async (params) => {
      await params.runTools?.([{
        id: "submit-only",
        name: "submit_grounded_answer",
        input: {
          claims: [{
            text: "The lease renews for successive one-year terms.",
            evidence_ids: ["e_lease"],
          }],
        },
      }]);
      throw new Error("Codex exec returned no response.");
    });

    const result = await runReadSubagent({
      call: {
        id: "read-tool-only",
        name: "delegate_read",
        input: { task: "Find the renewal clause.", scope: "The lease" },
      },
      tools: [LEGAL_EVIDENCE_SUBMIT_TOOL],
      evidenceState,
      runTools: async (calls) => calls.map((call) => {
        const submitted = submitLegalEvidenceAnswer(call.input, evidenceState);
        return {
          tool_use_id: call.id,
          status: submitted.ok ? ("ok" as const) : ("error" as const),
          content: JSON.stringify(submitted),
          terminal: submitted.terminal,
        };
      }),
    });

    expect(result.status, result.content).toBe("ok");
    expect(result.content).toContain("e_lease");
  });

  it("continues an interrupted reader in its original Codex session", async () => {
    const controller = new AbortController();
    const events: unknown[] = [];
    mocks.stream.mockImplementationOnce(async (params) => {
      params.providerSession?.onContinuationId?.(
        "00000000-0000-4000-8000-000000000123",
      );
      const error = new Error("Stream aborted.");
      error.name = "AbortError";
      throw error;
    });
    const interrupted = await runReadSubagent({
      call: {
        id: "read-interrupted",
        name: "delegate_read",
        input: {
          task: "Find the renewal clause.",
          scope: "The attached lease",
        },
      },
      tools: [LEGAL_EVIDENCE_SUBMIT_TOOL],
      evidenceState: leaseEvidenceState(),
      runTools: async () => [],
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });

    expect(interrupted.status).toBe("error");
    expect(events.at(-1)).toMatchObject({
      id: "read-interrupted",
      status: "interrupted",
      resume: {
        continuation_id: "00000000-0000-4000-8000-000000000123",
        model: "gpt-5.6-luna",
        effort: "high",
        assignment: {
          task: "Find the renewal clause.",
          scope: "The attached lease",
          jurisdiction: "CA",
        },
        evidence: [expect.objectContaining({ evidence_id: "e_lease" })],
      },
    });

    const checkpoint = resumableReadSubagents(events).get("read-interrupted")!;
    const resumedEvidence = createLegalEvidenceTurnState("citation_structure");
    mocks.stream.mockImplementationOnce(async (params) => {
      expect(params.providerSession?.continuationId).toBe(
        checkpoint.continuation_id,
      );
      expect(params.systemPrompt).toBe("");
      expect(params.messages).toEqual([
        expect.objectContaining({
          content: expect.stringContaining("Continue the assigned task"),
        }),
      ]);
      await params.runTools?.([{
        id: "submit-resumed",
        name: "submit_grounded_answer",
        input: {
          claims: [{
            text: "The lease renews for successive one-year terms.",
            evidence_ids: ["e_lease"],
          }],
        },
      }]);
      return {
        fullText: "",
        continuationId: checkpoint.continuation_id,
      };
    });
    const resumed = await runReadSubagent({
      call: { id: "resume:1", name: "resume_read", input: {} },
      tools: [LEGAL_EVIDENCE_SUBMIT_TOOL],
      evidenceState: resumedEvidence,
      resume: checkpoint,
      runTools: async (calls) => calls.map((call) => {
        const submitted = submitLegalEvidenceAnswer(call.input, resumedEvidence);
        return {
          tool_use_id: call.id,
          status: submitted.ok ? ("ok" as const) : ("error" as const),
          content: JSON.stringify(submitted),
        };
      }),
    });

    expect(resumed.status, resumed.content).toBe("ok");
    expect(resumedEvidence.evidence.has("e_lease")).toBe(true);
  });

  it("resumes stored run IDs without accepting replacement assignments", async () => {
    const checkpoint: ReadSubagentCheckpoint = {
      id: "read-1",
      continuation_id: "00000000-0000-4000-8000-000000000123",
      model: "gpt-5.6-luna",
      effort: "high",
      assignment: {
        task: "Find the renewal clause.",
        scope: "The attached lease",
        jurisdiction: "CA",
      },
      evidence: [],
    };
    const runResume = vi.fn(async (_call, selected) => ({
      tool_use_id: "resume-parent:1",
      status: "ok" as const,
      content: JSON.stringify({ task: selected.assignment.task }),
    }));
    const results = await runReadSubagentRound({
      calls: [{
        id: "resume-parent",
        name: "resume_read",
        input: { ids: ["read-1"] },
      }],
      admit: createReadSubagentAdmission(),
      runDirect: async () => [],
      runReader: async () => {
        throw new Error("A new reader must not be created.");
      },
      resumable: new Map([[checkpoint.id, checkpoint]]),
      runResume,
    });

    expect(runResume).toHaveBeenCalledWith(
      expect.objectContaining({ input: checkpoint.assignment }),
      checkpoint,
    );
    expect(results[0]).toMatchObject({
      tool_use_id: "resume-parent",
      status: "ok",
    });
  });
});
