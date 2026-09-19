import { expect, it } from "vitest";
import { extractTabularAnswers } from "./extraction";
import type { DocumentStore } from "../documentStore";
import type { ChatToolContext, runChatTurn } from "../chat/turnEngine";
import type { ResearchObserver } from "../researchReader";
import type { TabularCellContent } from "../tabularStore";
import { sha256 } from "../hash";

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
