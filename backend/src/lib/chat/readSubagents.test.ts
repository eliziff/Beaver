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
  getReadSubagentCapability,
  readSubagentTools,
  runReadSubagent,
} from "./readSubagents";
import type { OpenAIToolSchema } from "../llm";
import {
  createLegalEvidenceTurnState,
  LEGAL_EVIDENCE_SUBMIT_TOOL,
  registerLegalEvidence,
  submitLegalEvidenceAnswer,
} from "./legalEvidenceExperiment";

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

  it("allows document and legal research tools but excludes mutations", () => {
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
      "Read",
      "library_find",
      "SearchSources",
      "courtlistener_find_in_case",
      "public_legal_source_lookup",
    ]);
  });

  it("returns only the receipt-backed grounded submission", async () => {
    const events: unknown[] = [];
    const evidenceState = createLegalEvidenceTurnState("citation_structure");
    registerLegalEvidence(evidenceState, {
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
                kind: "conclusion",
                premise_source: null,
                premise_text: null,
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
        input: { task: "Find the renewal clause." },
      },
      tools: [schema("a2aj_search"), LEGAL_EVIDENCE_SUBMIT_TOOL],
      evidenceState,
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

    expect(result.status).toBe("ok");
    expect(mocks.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "codex:gpt-5.6-luna",
        reasoningEffort: "high",
        maxIterations: 8,
        systemPrompt: expect.stringContaining("submit_grounded_answer"),
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({ id: "read-1", status: "running" }),
      expect.objectContaining({
        id: "read-1",
        status: "completed",
        grounding: expect.objectContaining({ status: "passed" }),
      }),
    ]);
    expect(result.content).toContain("successive one-year terms");
    expect(result.content).not.toContain("ungrounded prose");
  });

  it("fails closed when the agent emits prose without a grounded submission", async () => {
    const result = await runReadSubagent({
      call: {
        id: "read-2",
        name: "delegate_read",
        input: { task: "Review the authorities." },
      },
      tools: [LEGAL_EVIDENCE_SUBMIT_TOOL],
      evidenceState: createLegalEvidenceTurnState("citation_structure"),
      runTools: vi.fn(),
    });

    expect(result.status).toBe("error");
    expect(result.content).toContain("did not submit");
    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect(mocks.stream.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining(
              "Your previous attempt did not pass the grounding gate",
            ),
          }),
        ],
        systemPrompt: expect.stringContaining("premise_source"),
      }),
    );
  });
});
