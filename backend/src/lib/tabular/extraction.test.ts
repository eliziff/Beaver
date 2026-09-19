import { afterEach, expect, it, vi } from "vitest";
import { extractTabularAnswers } from "./extraction";
import type { DocumentStore } from "../documentStore";
import type { ChatToolContext, runChatTurn } from "../chat/turnEngine";
import type { ResearchObserver } from "../researchReader";
import type { TabularCellContent } from "../tabularStore";
import { sha256 } from "../hash";
import { JEV_MODEL } from "./jev";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

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

it.each(["direct", "mixed", "unsupported", "outage", "last-page"])("Jev %s preserves grounded cells and skips only completed work", async (ending) => {
  vi.stubEnv("TYPESAFE_API_KEY", "fixture-only"); vi.stubEnv("BEAVER_JEV_TABULAR_MODE", "auto");
  vi.stubEnv("TYPESAFE_JEV_MODEL", JEV_MODEL);
  const source = (ending === "last-page" ? Array.from({ length: 100 }, (_, i) => `Background item ${i + 1}.`) : [])
    .concat("Alpha and Beta both owe confidentiality obligations to each other.").join("\n"),
    bytes = Buffer.from(source), sourceSha256 = sha256(bytes), signal = new AbortController();
  const documents = { metadata: async () => ({ filename: "NDA.txt" }),
    versions: async () => ({ versions: [{ id: "v1", size_bytes: bytes.length }] }),
    projectionSource: async () => ({ documentId: "document", versionId: "v1", fileType: "txt", sourceSha256, readBytes: () => bytes }),
  } as unknown as DocumentStore;
  const columns = [{ index: 0, name: "Direction", format: "tag", tags: ["Mutual", "Unilateral"],
    prompt: "Classify the NDA as Mutual or Unilateral." }, ...(ending === "mixed" ? [{ index: 1, name: "Parties and direction", format: "text",
    prompt: "State the direction and identify both parties." }] : [])];
  let normalCalls = 0; const accepted = new Map<number, TabularCellContent>(), observations: Parameters<ResearchObserver>[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    if (ending === "outage") return new Response("", { status: 503 });
    const request = JSON.parse(String(init.body)), answers = Object.fromEntries(Object.entries(request.questions).map(([id, raw]) => {
      const question = raw as { type: string; criteria: Record<string, string> };
      if (question.type === "choice") return [id, { type: "choice", choice: "v0", confidence: .99,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === "v0" ? .99 : .005])) }];
      const relevant = id.startsWith("s") ? ending !== "unsupported" :
        request.state.passages[Number(id.split("_")[1])].text.includes("both owe");
      return [id, { type: "noul", noul: relevant ? .99 : .01 }];
    }));
    return new Response(JSON.stringify({ model: JEV_MODEL, answers, usage: { input_tokens: 100, output_tokens: 10 } }));
  });
  const runTurn: typeof runChatTurn = async (options) => {
    if (options.grounded === false) return { status: "complete", fullText: '{"routes":[{"index":0,"kind":"choice"}]}',
      citations: [], events: [], evidence: { queries: new Map() } as never };
    normalCalls++;
    if (ending === "last-page") expect(options.messages[0].content).toContain("both owe");
    const context: ChatToolContext = { evidence: options.evidenceState!, operation: options.operation!, research: options.researchContext, addEvent() {} },
      submit = options.createTools(context.evidence, "main", context).find(t => t.name === "submit_extraction")!,
      ids = (submit.inputSchema.properties!.column_index as { enum: number[] }).enum,
      receipt = [...context.evidence.evidence.values()].find(e => e.receipt.span_text?.includes("both owe"))!.receipt;
    expect(ids).toEqual(ending === "mixed" ? [1] : [0]);
    for (const index of ids) {
      const input = { column_index: index, value: index === 0 ? "Mutual" : "Alpha and Beta; mutual obligations.",
        outcome: "answered", flag: "grey", claims: [{ text: "Alpha and Beta owe reciprocal confidentiality obligations.", evidence_ids: [receipt.evidence_id] }] };
      const result = await submit.execute(input, context, signal.signal, { id: "answer", name: "submit_extraction", input });
      expect(result.result.isError).not.toBe(true);
    }
    return { status: "complete", fullText: "", citations: [], events: [], evidence: context.evidence };
  };
  await extractTabularAnswers({ documents, scope: { userId: `jev-${ending}` },
    subject: { sourceId: "saved", resource: "document://document/version/v1", sourceSha256,
      reference: { provider: "library", kind: "document", id: "document", versionId: "v1" } },
    model: "codex:reader", apiKeys: {}, columns, signal: signal.signal, runTurn,
    onResearchObserved: (...args) => { observations.push(args); }, accept: async (index, cell) => { accepted.set(index, cell); } });
  expect(normalCalls).toBe(["direct", "last-page"].includes(ending) ? 0 : 1);
  expect(accepted.size).toBe(columns.length);
  expect(accepted.get(0)).toMatchObject({ value: "Mutual", coverage: "complete", outcome: "answered" });
  expect(accepted.get(0)!.evidence[0].span_text).toContain("both owe");
  if (normalCalls === 0) expect(observations.flatMap(([event]) => event.queries).some(q => q.model === JEV_MODEL)).toBe(true);
});
