/**
 * LegalBench-RAG-mini over the grounding harness (Stage 14 bed): the
 * program's first real-world test with fully deterministic scoring —
 * gold is HUMAN-annotated char spans, our claims are verbatim char
 * spans, so no stochastic checker touches the score.
 *
 * Pipeline per test: product lexical retrieval (the SAME FTS5 bm25 +
 * snippet window as the 2026-07-28 retrieval baseline) → top-k snippets
 * registered as evidence receipts → the grounding contract composes a
 * claims-typed answer (quote contract + verbatim gate; the citator
 * stands-for machinery is a structural no-op on contracts) → quotation
 * claims located back to original char coordinates → upstream
 * charPrecisionRecall against gold. Each row also scores the RAW
 * retrieval spans at the same k, so harness-vs-baseline is paired per
 * test. Typed abstention (no grounded submission) is a first-class
 * outcome, never an answer.
 *
 * The harness's LegalSourceClass has no contract member; cells run as
 * "legislation" (non-case), which is exactly the class that keeps every
 * case-law-only module off. Rows record source benchmark names for
 * honesty. Receipts are private (LOCALAPPDATA experiments dir).
 *
 * Requires the pinned mini data AND the FTS db built by
 * scripts/legalbench-rag-run.ts. Usage (from backend/):
 *   npx tsx scripts/legalbench-rag-grounding.ts --model codex:gpt-5.6-luna `
 *     --effort medium --per-source 8 --k 4 [--resume 1] [--cases cuad:003,...]
 */
import "../src/lib/loadEnv";

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  createBenchmarkEvidence,
  createLegalEvidenceTurnState,
  finalizeLegalEvidenceExperiment,
  legalEvidenceExperimentTools,
  legalEvidenceReceiptEvent,
  planLegalEvidence,
  registerLegalEvidence,
  renderLegalEvidenceAnswer,
  submitLegalEvidenceAnswer,
  LEGAL_EVIDENCE_PLAN_TOOL_NAME,
  LEGAL_EVIDENCE_TOOL_NAME,
} from "../src/lib/chat/legalEvidenceExperiment";
import {
  LEGALBENCH_RAG_DATA_DIR,
  MANIFEST_PATH,
  SOURCE_BENCHMARKS,
  charPrecisionRecall,
  upstreamBenchmarkSchema,
  validateMiniManifest,
  verifyAgainstManifest,
  type SourceBenchmark,
  type Span,
} from "../src/lib/legalbenchRag";
import {
  streamChatWithTools,
  type NormalizedLlmUsage,
  type NormalizedToolCall,
  type NormalizedToolResult,
} from "../src/lib/llm";

const NO_SUB = "The model did not submit a grounded answer.";

// The EXACT prompt modules the registered stages assemble for the
// required_slot arm on non-case cells (legal-grounding-experiment.ts).
// Held verbatim so this bed tests the same contract the stages measured.
const PROMPT_MODULES: Array<[name: string, text: string]> = [
  [
    "base",
    "Answer only from the supplied exact passages. Finish through the available grounded-answer tool without a prose copy or citation text; Beaver places citations from the evidence receipts.",
  ],
  [
    "roles",
    'Type every claim with its kind. "quotation": a supplied span\'s words copied EXACTLY — no edits, no elisions, no framing around them. "conclusion": the direct answer to the question in your own words. "premise_correction": the question (or a prior assistant answer) asserts something the passages contradict — set premise_source, copy the contested words verbatim into premise_text, and state the correction from the passages. Set premise_source and premise_text to null on every other kind.',
  ],
  [
    "quote_contract",
    "Prefer quotation claims. At most ONE conclusion claim, stating only what the quoted text establishes; never characterize the law beyond the quoted words (never assert a statute 'regulates', 'has a framework', or 'governs' unless those words are quoted). If the passages cannot support a direct answer, say exactly that in the conclusion claim. The submission tool rejects violations with the compliant path restated; follow it and resubmit.",
  ],
];

type MiniTestCell = {
  id: string;
  source: SourceBenchmark;
  query: string;
  gold: Span[];
};

type RowSpanScore = {
  precision: number;
  recall: number;
  doc_hit: boolean;
  chars: number;
};

type Row = {
  schema_version: "lbrag-grounding-1";
  test_id: string;
  source: SourceBenchmark;
  model: string;
  effort: string;
  arm: "required_slot";
  k: number;
  query: string;
  status: "passed" | "failed" | "error";
  /** answered: passed with ≥1 located verbatim quote (score precision
   * here); declined: passed but quoteless — an honest typed
   * insufficiency statement; rejected: gates refused the submission;
   * abstained: typed no-submission. */
  outcome: "answered" | "declined" | "rejected" | "abstained" | "error";
  abstained: boolean;
  failure: string | null;
  answer: string;
  /** Located quoted-claim spans in original doc coordinates. */
  quoted_spans: Span[];
  /** Quotation claims whose text could not be located (soundness alarm
   * if ever nonzero — the verbatim gate proved membership). */
  unlocated_quotes: number;
  grounded: RowSpanScore;
  /** The raw top-k retrieval spans scored the baseline way, same test,
   * same k — the paired comparison column. */
  retrieval_baseline: RowSpanScore;
  latency_ms: number;
  usage: NormalizedLlmUsage | null;
  legal_evidence_receipt: ReturnType<typeof legalEvidenceReceiptEvent> | null;
  error: string | null;
};

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && index + 1 < process.argv.length)
    return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

function runTool(
  call: NormalizedToolCall,
  state: ReturnType<typeof createLegalEvidenceTurnState>,
): NormalizedToolResult {
  const result =
    call.name === LEGAL_EVIDENCE_PLAN_TOOL_NAME
      ? planLegalEvidence(call.input, state)
      : call.name === LEGAL_EVIDENCE_TOOL_NAME
        ? submitLegalEvidenceAnswer(call.input, state)
        : { ok: false, errors: [`Unexpected tool: ${call.name}`] };
  return {
    tool_use_id: call.id,
    content: JSON.stringify(result),
    terminal: "terminal" in result && result.terminal === true,
  };
}

function scoreSpans(spans: Span[], gold: Span[]): RowSpanScore {
  const { precision, recall } = charPrecisionRecall(spans, gold);
  const goldDocs = new Set(gold.map((span) => span.filePath));
  return {
    precision,
    recall,
    doc_hit: spans.some((span) => goldDocs.has(span.filePath)),
    chars: spans.reduce((n, span) => n + (span.end - span.start), 0),
  };
}

async function main() {
  const model = flag("model");
  const effort = flag("effort", "medium");
  const perSource = Number(flag("per-source", "8"));
  const k = Number(flag("k", "4"));
  const timeoutMs = Number(flag("timeout-ms", "300000"));
  const concurrency = Number(flag("concurrency", "3"));
  const experimentsDir = path.join(
    process.env.LOCALAPPDATA ?? "",
    "OpenLegalData/experiments/legal-grounding/2026-07-30",
  );
  const output = flag("output", path.join(experimentsDir, "stage14-lbrag.jsonl"));
  const resume = flag("resume", "0") !== "0";

  // Pinned data, verified before trusting (same discipline as the
  // retrieval baseline runner).
  const manifest = validateMiniManifest(
    JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
  );
  const onDisk = [...manifest.benchmarks, ...manifest.corpus].map((entry) => ({
    path: entry.path,
    bytes: readFileSync(path.join(LEGALBENCH_RAG_DATA_DIR, entry.path)),
  }));
  const problems = verifyAgainstManifest(manifest, onDisk);
  if (problems.length)
    throw new Error(`data does not match manifest:\n${problems.join("\n")}`);
  const disk = new Map(onDisk.map((file) => [file.path, file.bytes]));
  const corpusText = new Map(
    manifest.corpus.map((entry) => [
      entry.upstream_path,
      disk.get(entry.path)!.toString("utf8"),
    ]),
  );

  const database = path.join(LEGALBENCH_RAG_DATA_DIR, "db", "a2aj-mini.sqlite");
  if (!existsSync(database))
    throw new Error(
      `FTS db missing (${database}); run scripts/legalbench-rag-run.ts once first`,
    );
  process.env.MIKE_A2AJ_BULK_DB = database;
  const { searchLocalA2AJ } = await import("../src/lib/a2ajLocalBulk");

  const tests: MiniTestCell[] = SOURCE_BENCHMARKS.flatMap((source) => {
    const parsed = upstreamBenchmarkSchema.parse(
      JSON.parse(disk.get(`mini/benchmarks/${source}.json`)!.toString("utf8")),
    );
    return parsed.tests.slice(0, perSource).map((test, index) => ({
      id: `${source}:${String(index).padStart(3, "0")}`,
      source,
      query: test.query,
      gold: test.snippets.map((snippet) => ({
        filePath: snippet.file_path,
        start: snippet.span[0],
        end: snippet.span[1],
      })),
    }));
  });
  const onlyCases = flag("cases", "");
  const selected = onlyCases
    ? tests.filter((test) =>
        onlyCases.split(",").map((s) => s.trim()).includes(test.id),
      )
    : tests;
  if (!selected.length) throw new Error("no tests selected");
  console.log(`selected ${selected.length} tests (k=${k}, model=${model})`);
  if (process.argv.includes("--dry-run")) return;

  mkdirSync(path.dirname(output), { recursive: true });
  const done = new Set<string>();
  if (resume && existsSync(output)) {
    for (const line of readFileSync(output, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as Row;
      if (!row.error) done.add(`${row.model}|${row.effort}|${row.k}|${row.test_id}`);
    }
  } else {
    writeFileSync(output, "", "utf8");
  }

  async function runTest(test: MiniTestCell): Promise<Row> {
    const started = Date.now();
    // Retrieval: top-k product snippets, located to doc coordinates.
    const results = (
      searchLocalA2AJ({ query: test.query, docType: "laws", size: k }) ?? []
    ).slice(0, k);
    const retrieved: Array<Span & { snippet: string }> = [];
    for (const result of results) {
      if (!result.snippet) continue;
      const text = corpusText.get(result.citation);
      const start = text ? text.indexOf(result.snippet) : -1;
      if (start < 0) continue;
      retrieved.push({
        filePath: result.citation,
        start,
        end: start + result.snippet.length,
        snippet: result.snippet,
      });
    }
    const baseline = scoreSpans(retrieved, test.gold);

    const state = createLegalEvidenceTurnState("required_slot");
    state.premiseContext = { question: test.query, priorAnswer: null };
    state.lintContext = {
      question: test.query,
      alienessIndexPath: path.join(
        process.env.LOCALAPPDATA ?? "",
        "ALR Quote Verifier",
        "alienness",
        "trigrams-en-us.sqlite",
      ),
    };
    const bySnippetId = new Map<string, Span & { snippet: string }>();
    const receipts = retrieved.map((span, index) => {
      const receipt = createBenchmarkEvidence({
        jurisdiction: "US",
        sourceClass: "legislation",
        stableSourceId: `lbrag:${test.id}:${index}`,
        sourceText: span.snippet,
        spanText: span.snippet,
        citation: span.filePath,
        dataset: `LegalBench-RAG-mini/${test.source}`,
        locatorKind: "paragraph",
        locatorLabel: `retrieved passage ${index + 1}`,
      });
      registerLegalEvidence(state, receipt);
      bySnippetId.set(receipt.evidence_id, span);
      return receipt;
    });

    let usage: NormalizedLlmUsage | null = null;
    let answer = "";
    const abortSignal = AbortSignal.timeout(timeoutMs);
    const primary = await streamChatWithTools({
      model,
      reasoningEffort: effort,
      enableThinking: false,
      systemPrompt: PROMPT_MODULES.map(([, text]) => text).join(" "),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            question: test.query,
            evidence: receipts.map((receipt) => ({
              evidence_id: receipt.evidence_id,
              citation: receipt.citation,
              locator: receipt.locator.label,
              span_text: receipt.span_text,
            })),
            attested_characterizations: [],
          }),
        },
      ],
      tools: legalEvidenceExperimentTools("required_slot"),
      maxIterations: 3,
      abortSignal,
      runTools: async (calls) => calls.map((call) => runTool(call, state)),
    });
    usage = primary.usage;
    const finalized = await finalizeLegalEvidenceExperiment({
      state,
      model,
      draft: primary.fullText,
      requestContext: test.query,
      reasoningEffort: effort,
      abortSignal,
    });
    if (finalized.usage) {
      usage = {
        inputTokens:
          (usage.inputTokens ?? 0) + (finalized.usage.inputTokens ?? 0),
        outputTokens:
          (usage.outputTokens ?? 0) + (finalized.usage.outputTokens ?? 0),
        reasoningTokens:
          usage.reasoningTokens === null &&
          finalized.usage.reasoningTokens == null
            ? null
            : (usage.reasoningTokens ?? 0) +
              (finalized.usage.reasoningTokens ?? 0),
        cacheReadInputTokens:
          (usage.cacheReadInputTokens ?? 0) +
          (finalized.usage.cacheReadInputTokens ?? 0),
        cacheWriteInputTokens:
          (usage.cacheWriteInputTokens ?? 0) +
          (finalized.usage.cacheWriteInputTokens ?? 0),
      };
    }
    answer = renderLegalEvidenceAnswer(state) ?? "";
    const receipt = legalEvidenceReceiptEvent(state);

    // Locate final quotation claims back to original coordinates: first
    // inside the snippet the claim's evidence id names, then (fallback)
    // anywhere in that snippet's document.
    const quoted: Span[] = [];
    let unlocated = 0;
    for (const claim of receipt?.claims ?? []) {
      if (claim.kind !== "quotation" || !claim.deterministic_support) continue;
      let located = false;
      for (const evidenceId of claim.evidence_ids) {
        const span = bySnippetId.get(evidenceId);
        if (!span) continue;
        const inSnippet = span.snippet.indexOf(claim.text);
        if (inSnippet >= 0) {
          quoted.push({
            filePath: span.filePath,
            start: span.start + inSnippet,
            end: span.start + inSnippet + claim.text.length,
          });
          located = true;
          break;
        }
        const doc = corpusText.get(span.filePath) ?? "";
        const inDoc = doc.indexOf(claim.text);
        if (inDoc >= 0) {
          quoted.push({
            filePath: span.filePath,
            start: inDoc,
            end: inDoc + claim.text.length,
          });
          located = true;
          break;
        }
      }
      if (!located) unlocated += 1;
    }

    const passed = receipt?.status === "passed";
    const abstained = receipt?.failure === NO_SUB;
    return {
      schema_version: "lbrag-grounding-1",
      test_id: test.id,
      source: test.source,
      model,
      effort,
      arm: "required_slot",
      k,
      query: test.query,
      status: passed ? "passed" : "failed",
      outcome: passed
        ? quoted.length
          ? "answered"
          : "declined"
        : abstained
          ? "abstained"
          : "rejected",
      abstained,
      failure: receipt?.failure ?? null,
      answer,
      quoted_spans: quoted,
      unlocated_quotes: unlocated,
      grounded: scoreSpans(quoted, test.gold),
      retrieval_baseline: baseline,
      latency_ms: Date.now() - started,
      usage,
      legal_evidence_receipt: receipt,
      error: null,
    };
  }

  const queue = selected.filter(
    (test) => !done.has(`${model}|${effort}|${k}|${test.id}`),
  );
  console.log(`running ${queue.length} tests (${done.size} resumed)`);
  let index = 0;
  const rows: Row[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (index < queue.length) {
        const test = queue[index++];
        let row: Row;
        try {
          row = await runTest(test);
        } catch (error) {
          row = {
            schema_version: "lbrag-grounding-1",
            test_id: test.id,
            source: test.source,
            model,
            effort,
            arm: "required_slot",
            k,
            query: test.query,
            status: "error",
            outcome: "error",
            abstained: false,
            failure: null,
            answer: "",
            quoted_spans: [],
            unlocated_quotes: 0,
            grounded: { precision: 0, recall: 0, doc_hit: false, chars: 0 },
            retrieval_baseline: {
              precision: 0,
              recall: 0,
              doc_hit: false,
              chars: 0,
            },
            latency_ms: 0,
            usage: null,
            legal_evidence_receipt: null,
            error: String(error).slice(0, 500),
          };
        }
        appendFileSync(output, `${JSON.stringify(row)}\n`, "utf8");
        rows.push(row);
        console.log(
          `${row.test_id}: ${row.status}${row.abstained ? " (abstained)" : ""} ` +
            `groundedP=${row.grounded.precision.toFixed(3)} ` +
            `groundedR=${row.grounded.recall.toFixed(3)} ` +
            `baseP=${row.retrieval_baseline.precision.toFixed(3)}` +
            `${row.unlocated_quotes ? ` UNLOCATED=${row.unlocated_quotes}` : ""}` +
            `${row.error ? ` ERROR=${row.error.slice(0, 80)}` : ""}`,
        );
      }
    }),
  );

  const mean = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const summarize = (label: string, subset: Row[]) => {
    const ok = subset.filter((row) => !row.error);
    const answered = ok.filter((row) => row.outcome === "answered");
    const count = (outcome: Row["outcome"]) =>
      ok.filter((row) => row.outcome === outcome).length;
    console.log(
      `${label}: n=${subset.length} errors=${subset.length - ok.length} ` +
        `answered=${answered.length} declined=${count("declined")} ` +
        `rejected=${count("rejected")} abstained=${count("abstained")} ` +
        `unlocated=${ok.reduce((n, r) => n + r.unlocated_quotes, 0)} | ` +
        `answered-only grounded P=${mean(answered.map((r) => r.grounded.precision)).toFixed(4)} ` +
        `R=${mean(answered.map((r) => r.grounded.recall)).toFixed(4)} ` +
        `doc=${mean(answered.map((r) => (r.grounded.doc_hit ? 1 : 0))).toFixed(2)} ` +
        `answered∩doc-miss=${
          answered.filter((r) => !r.retrieval_baseline.doc_hit).length
        } | ` +
        `baseline P=${mean(ok.map((r) => r.retrieval_baseline.precision)).toFixed(4)} ` +
        `R=${mean(ok.map((r) => r.retrieval_baseline.recall)).toFixed(4)} ` +
        `doc=${mean(ok.map((r) => (r.retrieval_baseline.doc_hit ? 1 : 0))).toFixed(2)}`,
    );
  };
  console.log("");
  summarize("overall", rows);
  for (const source of SOURCE_BENCHMARKS)
    summarize(source, rows.filter((row) => row.source === source));
  console.log(`\nReceipts: ${output}`);
}

main().catch((error) => {
  console.error("[legalbench-rag-grounding]", error);
  process.exit(1);
});
