import { afterEach, beforeEach, expect, it, vi } from "vitest";
const stream = vi.hoisted(() => vi.fn());
vi.mock("../llm", async (original) => ({ ...(await original<typeof import("../llm")>()), streamChatWithTools: stream }));
import { extractTabularAnswers } from "./extraction";
import type { DocumentStore } from "../documentStore";
import { runChatTurn, type ChatToolContext } from "../chat/turnEngine";
import type { ResearchObserver } from "../researchReader";
import type { TabularCellContent } from "../tabularStore";
import { sha256 } from "../hash";
beforeEach(() => { vi.stubEnv("BEAVER_JEV_TABULAR_MODE", "off"); stream.mockReset(); });
afterEach(() => vi.unstubAllEnvs());

it.each([true, false])("repairs only the invalid cell and preserves accepted siblings (repair succeeds: %s)", async (succeeds) => {
  const bytes = Buffer.from("The fee is CAD 1000.\nEffective date: 2026-01-15."), sourceSha256 = sha256(bytes),
    accepted: { index: number; cell: TabularCellContent }[] = [], measurements: import("./extraction").TabularMeasurement[] = [],
    documents = { metadata: async () => ({ filename: "terms.txt" }), versions: async () => ({ versions: [{ id: "v1", size_bytes: bytes.length }] }),
      projectionSource: async () => ({ documentId: "repair", versionId: "v1", fileType: "txt", sourceSha256, readBytes: () => bytes }) } as unknown as DocumentStore;
  let evidenceIds: string[] = [], call = 0;
  const payload = (index: number, value: unknown) => ({ column_index: index, value, flag: "grey", outcome: "answered",
    claims: [{ text: index ? "Start: 15 January 2026." : "Annual charge: CAD 1000.", evidence_ids: evidenceIds }] });
  stream.mockImplementation(async (params) => {
    call++;
    const tools = params.tools, schema = tools.find((tool: { name: string }) => tool.name === "submit_extraction").inputSchema;
    if (call === 1) {
      const results = await params.runTools([
        { id: "good", name: "submit_extraction", input: payload(0, "CAD 1000") },
        { id: "bad", name: "submit_extraction", input: payload(1, "15 January 2026") },
      ]);
      expect(results.every((result: { terminal: boolean }) => result.terminal)).toBe(true);
      // Even an unwanted duplicate from a provider cannot rewrite a saved sibling.
      await params.runTools([{ id: "duplicate", name: "submit_extraction", input: payload(0, "CAD 9999") }]);
    } else {
      expect(schema.properties.column_index.enum).toEqual([1]);
      expect(params.messages[0].content).not.toContain("Fee question only");
      expect(params.messages[0].content).toContain("15 January 2026");
      await params.runTools([{ id: "repair", name: "submit_extraction", input: payload(1, succeeds ? "2026-01-15" : "still invalid") }]);
    }
    // Tabular completion must not trigger generic chat repair of this unused prose.
    params.callbacks.onContentDelta("See Example v Example, 2024 SCC 1.");
    return { fullText: "See Example v Example, 2024 SCC 1." };
  });
  const result = await extractTabularAnswers({ documents, scope: { userId: "owner" },
    subject: { sourceId: "repair", resource: "document://repair/version/v1", sourceSha256,
      reference: { provider: "library", kind: "document", id: "repair", versionId: "v1" } },
    model: "codex:gpt-5.6-luna", apiKeys: {}, columns: [
      { index: 0, name: "Fee", prompt: "Fee question only", format: "monetary_amount" },
      { index: 1, name: "Date", prompt: "Effective date?", format: "date" }],
    runTurn: async (options) => { evidenceIds = [...options.evidenceState!.evidence.keys()]; return runChatTurn(options); },
    onMeasurement: event => measurements.push(event), accept: async (index, cell) => { accepted.push({ index, cell }); },
  });
  expect(accepted.map(({ index, cell }) => [index, cell.value])).toEqual(succeeds ? [[0, "CAD 1000"], [1, "2026-01-15"]] : [[0, "CAD 1000"]]);
  expect(result).toEqual(new Set(succeeds ? [0, 1] : [0]));
  expect(measurements.filter(event => event.phase === "repair").map(event => event.columns)).toEqual([[1]]);
  expect(measurements.filter(event => event.status === "failed").map(event => event.index)).toEqual(succeeds ? [] : [1]);
});

it("saves cited source wording immediately and repairs only a mismatched explicit quotation", async () => {
  const source = "The Customer shall obtain the Supplier's prior written consent before any change of control.",
    bytes = Buffer.from(source), sourceSha256 = sha256(bytes), accepted: { index: number; cell: TabularCellContent }[] = [],
    measurements: import("./extraction").TabularMeasurement[] = [],
    documents = { metadata: async () => ({ filename: "consent.txt" }), versions: async () => ({ versions: [{ id: "v1", size_bytes: bytes.length }] }),
      projectionSource: async () => ({ documentId: "consent", versionId: "v1", fileType: "txt", sourceSha256, readBytes: () => bytes }) } as unknown as DocumentStore;
  let evidenceIds: string[] = [], call = 0;
  const submit = (index: number, text: string) => ({ id: `cell-${index}`, name: "submit_extraction",
    input: { column_index: index, value: true, flag: "grey", outcome: "answered", claims: [{ text, evidence_ids: evidenceIds }] } });
  stream.mockImplementation(async (params) => {
    if (++call === 1) {
      await params.runTools([submit(0, source), submit(1, `${source} "Consent is never required for a change of control."`)]);
      expect(accepted.map(({ index }) => index)).toEqual([0]);
    } else {
      await params.runTools([submit(1, `"${source}"`)]);
    }
    return { fullText: "" };
  });
  const result = await extractTabularAnswers({ documents, scope: { userId: "owner" },
    subject: { sourceId: "consent", resource: "document://consent/version/v1", sourceSha256,
      reference: { provider: "library", kind: "document", id: "consent", versionId: "v1" } },
    model: "codex:gpt-5.6-luna", apiKeys: {}, columns: [0, 1].map(index => ({ index, name: "Consent", prompt: "Is consent required?", format: "yes_no" })),
    runTurn: async options => { evidenceIds = [...options.evidenceState!.evidence.keys()]; return runChatTurn(options); },
    onMeasurement: event => measurements.push(event), accept: async (index, cell) => { accepted.push({ index, cell }); },
  });
  expect(result).toEqual(new Set([0, 1]));
  expect(accepted.map(({ cell }) => cell.claims[0].text)).toEqual([source, `"${source}"`]);
  expect(measurements.filter(event => event.phase === "repair").map(event => event.columns)).toEqual([[1]]);
  expect(measurements.filter(event => event.status === "rejected")).toEqual([
    expect.objectContaining({ index: 1, error: expect.stringContaining("does not match its cited evidence") }),
  ]);
});

it.each(["not_found", "failure", "cancellation"])("retains every original extraction read after %s", async (ending) => {
  const text = Array.from({ length: 101 }, (_, index) => `Unrelated source sentence ${index + 1}.`).join("\n"),
    bytes = Buffer.from(text), sourceSha256 = sha256(bytes), signal = new AbortController(),
    documents = { metadata: async () => ({ filename: "Notes.txt" }),
      versions: async () => ({ versions: [{ id: "v1", size_bytes: bytes.length }] }),
      projectionSource: async () => ({ documentId: "document", versionId: "v1", fileType: "txt",
        sourceSha256, readBytes: () => bytes }),
    } as unknown as DocumentStore, observations: Parameters<ResearchObserver>[] = [], accepted: TabularCellContent[] = [],
    runTurn: typeof runChatTurn = async (options) => {
      expect(observations.flatMap(([event]) => event.evidence)).toHaveLength(100);
      const context: ChatToolContext = { evidence: options.evidenceState!, operation: options.operation!,
        research: options.researchContext, addEvent() {} }, tools = options.createTools(context.evidence, "main", context),
        read = tools.find(({ name }) => name === "Read")!;
      await read.execute({ offset: 101 }, context, signal.signal,
        { id: "last-page", name: "Read", input: { offset: 101 } });
      expect(observations.flatMap(([event]) => event.evidence)).toHaveLength(101);
      if (ending === "failure") throw new Error("Provider disconnected");
      if (ending === "cancellation") { signal.abort(new DOMException("Cancelled", "AbortError")); throw signal.signal.reason; }
      const input = { column_index: 0, value: null, outcome: "not_found", flag: "grey", claims: [] },
        result = await tools.find(({ name }) => name === "submit_extraction")!.execute(input, context, signal.signal,
          { id: "answer", name: "submit_extraction", input });
      expect(result.result.isError).not.toBe(true);
      return { status: "complete", fullText: "", citations: [], events: [], evidence: context.evidence };
    };
  const run = extractTabularAnswers({ documents, scope: { userId: "owner" },
    subject: { sourceId: "saved", resource: "document://document/version/v1", sourceSha256,
      reference: { provider: "library", kind: "document", id: "document", versionId: "v1" } },
    model: "codex:reader", apiKeys: {}, columns: [{ index: 0, name: "Term", prompt: "Find the contract term" }],
    signal: signal.signal, runTurn, operation: { executor: "assistant", jobId: "job", reviewId: "table" },
    async onResearchObserved(...args) { await Promise.resolve(); observations.push(args); },
    async accept(_index, result) { accepted.push(result); },
  });
  if (ending === "not_found") expect(await run).toEqual(new Set([0]));
  else await expect(run).rejects.toThrow(ending === "failure" ? "disconnected" : "Cancelled");
  const receipts = observations.flatMap(([event]) => event.evidence);
  expect(receipts.map(({ span_text }) => span_text).join("\n")).toBe(text);
  expect(new Set(receipts.map(({ evidence_id }) => evidence_id)).size).toBe(101);
  expect(observations.map(([, operation]) => operation)).toEqual([
    { executor: "assistant", model: "codex:reader", jobId: "job", reviewId: "table" },
    { executor: "assistant", model: "codex:reader", jobId: "job", reviewId: "table", callId: "last-page" },
    { executor: "assistant", model: "codex:reader", jobId: "job", reviewId: "table" },
  ]);
  expect(observations.flatMap(([event]) => event.queries)).toMatchObject([{ tool: "Read",
    input: { resource: "document://document/version/v1", columns: ["Term"] },
    results: Array.from({ length: 100 }, (_value, index) => ({ rank: index + 1 })) }]);
  expect(accepted).toEqual(ending === "not_found" ? [expect.objectContaining({ outcome: "not_found",
    coverage: "complete", value: null, claims: [], evidence: [] })] : []);
});
