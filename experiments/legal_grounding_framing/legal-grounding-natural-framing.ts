/** Generate natural affirmative framings of frozen, exact case quotations. */
import "../../backend/src/lib/loadEnv";

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { fetchLocalA2AJDocument } from "../../backend/src/lib/a2ajLocalBulk";
import { structureNative } from "../../backend/src/lib/structureNative";
import { contentWordCount, lintLegalClaim } from "./legalClaimLint";
import {
  streamChatWithTools,
  type NormalizedLlmUsage,
} from "../../backend/src/lib/llm";

const { hasCitationInText } = structureNative();

type Condition = "quote_only" | "source_context";
type FrozenRow = {
  groupId: string;
  split: "dev" | "test";
  condition: "attested" | "mutated";
  cited: {
    provider: string;
    stableSourceId: string;
    citation: string;
    dataset: string;
    sourceSha256: string;
    normalizedQuoteOffset: number;
  };
  quote: { text: string; sha256: string; exactQuoteVerified: true };
};
type SourceContext = {
  text: string;
  sha256: string;
  documentSha256: string;
  quoteOffset: number;
};
type GeneratedRow = {
  id: string;
  record_type: "claim";
  cell_id: string;
  claim_id: string;
  case_id: string;
  suite: "natural_quote_framing";
  split: "dev" | "test";
  arm: Condition;
  claim_kind: "conclusion";
  claim_text: string;
  evidence_ids: string[];
  route: "semantic_check";
  route_reason: "generated_affirmative_quote_framing";
  deterministic_support: false;
  cell_proxy_label: null;
  values: Record<string, number | null>;
  source: "natural-exact-quote-framing-live-v1";
  source_class: "case";
  doc_id: string;
  response_id: string;
  claim: string;
  citation: string;
  evidence_texts: string[];
  label: "unlabelled";
  label_provenance: "independent_semantic_checker_pending_not_gold";
  request_context: string;
  exact_quote: string;
  exact_quote_sha256: string;
  source_context_sha256: string;
  source_document_sha256: string;
  frozen_benchmark_sha256: string;
  generation_condition: Condition;
  generation_model: string;
  generation_effort: string;
  generation_attempt: number;
  generation_latency_ms: number;
  usage: NormalizedLlmUsage | null;
};

const SOURCE = "natural-exact-quote-framing-live-v1" as const;
const REQUEST =
  "What does the exact quotation mean or establish in the cited decision?";
const SYSTEM_PROMPT =
  "Write one affirmative legal proposition explaining what an exact judicial quotation means or establishes in its cited decision. Do not copy the quotation, cite the case, refer to a quote, passage, context, or evidence, hedge about missing information, or discuss whether support is sufficient. Return only the proposition, with no label or preface.";
const STRONG_MODALS = new Set([
  "must",
  "shall",
  "required",
  "requires",
  "mandatory",
]);
const ABSOLUTE_SCOPE = new Set([
  "all",
  "always",
  "every",
  "never",
  "only",
  "solely",
  "exclusively",
  "automatically",
]);
const NEGATIONS = new Set(["not", "no", "never", "without", "unless"]);

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeQuote(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/[\u2018\u2019\u201a\u2032]/gu, "'")
      .replace(/[\u201c\u201d\u201e\u2033]/gu, '"')
      .replace(/[\u2013\u2014\u2212]/gu, "-")
      .replace(/\u00a0/gu, " ")
      .replace(/\u2026/gu, "..."),
  );
}

function words(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}

function quoteOperatorRisk(frame: string, quote: string): number {
  const frameWords = words(frame);
  const quoteWords = words(quote);
  const added = (tokens: Set<string>) =>
    [...tokens].some((token) => frameWords.has(token) && !quoteWords.has(token));
  const negationParity = (tokens: Set<string>) =>
    [...NEGATIONS].reduce(
      (count, token) => count + (tokens.has(token) ? 1 : 0),
      0,
    ) % 2;
  return Number(
    added(STRONG_MODALS) ||
      added(ABSOLUTE_SCOPE) ||
      negationParity(frameWords) !== negationParity(quoteWords),
  );
}

function featureValues(claim: string, quote: string, context: string) {
  const quoteLint = Object.fromEntries(
    lintLegalClaim({ claim, spans: [quote] }).receipts.map((receipt) => [
      receipt.feature,
      receipt.value,
    ]),
  );
  const contextLint = Object.fromEntries(
    lintLegalClaim({ claim, spans: [context] }).receipts.map((receipt) => [
      receipt.feature,
      receipt.value,
    ]),
  );
  const contentWords = contentWordCount(claim);
  const operator = quoteOperatorRisk(claim, quote);
  return {
    word_count: claim.match(/[\p{L}\p{N}]+/gu)?.length ?? 0,
    content_words: contentWords,
    frame_chars: claim.length,
    novel_content_fraction: quoteLint.novel_content_fraction ?? null,
    novel_abstraction_terms: quoteLint.novel_abstraction_terms ?? null,
    novel_absolutes: quoteLint.novel_absolutes ?? null,
    modality_upgrade: quoteLint.modality_upgrade ?? null,
    entity_count: quoteLint.entity_count ?? null,
    evidence_overlap:
      typeof contextLint.novel_content_fraction === "number"
        ? 1 - contextLint.novel_content_fraction
        : null,
    frame_quote_ratio:
      contentWords / Math.max(1, contentWordCount(quote)),
    quote_operator_risk: operator,
    length_or_operator: operator ? 1_000_000 : contentWords,
  };
}

function claimContractError(claim: string, quote: string): string | null {
  if (contentWordCount(claim) < 4) return "claim_too_short";
  if (
    contentWordCount(quote) >= 6 &&
    normalizeQuote(claim)
      .toLocaleLowerCase()
      .includes(normalizeQuote(quote).toLocaleLowerCase())
  ) return "copied_exact_quote";
  if (hasCitationInText(claim)) return "claim_contains_citation";
  if (
    /^(?:the|this)\s+(?:quote|quotation|passage|statement)\b/iu.test(claim) ||
    /\b(?:supplied|provided)\s+(?:quote|quotation|passage|context|evidence)\b/iu.test(
      claim,
    ) ||
    /\b(?:insufficient|not enough|without more)\s+(?:context|evidence|information)\b/iu.test(
      claim,
    )
  ) return "meta_or_refusal_claim";
  return null;
}

function localAppData(): string {
  return (
    process.env.LOCALAPPDATA?.trim() ||
    path.join(os.homedir(), "AppData", "Local")
  );
}

function defaultBenchmark(): string {
  return path.join(
    localAppData(),
    "OpenLegalData",
    "experiments",
    "legal-grounding",
    "quote-framing-v1",
    "rows.jsonl",
  );
}

function sourceContext(row: FrozenRow, windowChars: number): SourceContext {
  if (row.cited.provider !== "a2aj") {
    throw new Error(`unsupported source provider: ${row.cited.provider}`);
  }
  const document = fetchLocalA2AJDocument({
    citation: row.cited.citation,
    docType: "cases",
    dataset: row.cited.dataset,
    maxChars: Number.MAX_SAFE_INTEGER,
  });
  if (!document) throw new Error(`local source missing: ${row.cited.citation}`);
  const documentSha256 = sha256(document.text);
  if (documentSha256 !== row.cited.sourceSha256) {
    throw new Error(`source hash changed: ${row.cited.stableSourceId}`);
  }
  const source = normalizeQuote(document.text);
  const quote = normalizeQuote(row.quote.text);
  if (sha256(quote) !== row.quote.sha256) {
    throw new Error(`quote hash changed: ${row.groupId}`);
  }
  let quoteOffset = row.cited.normalizedQuoteOffset;
  if (source.slice(quoteOffset, quoteOffset + quote.length) !== quote) {
    quoteOffset = source.indexOf(quote);
  }
  if (quoteOffset < 0) throw new Error(`exact quote missing: ${row.groupId}`);
  const text = source.slice(
    Math.max(0, quoteOffset - windowChars),
    Math.min(source.length, quoteOffset + quote.length + windowChars),
  );
  if (!text.includes(quote)) throw new Error(`context lost quote: ${row.groupId}`);
  return {
    text,
    sha256: sha256(text),
    documentSha256,
    quoteOffset,
  };
}

async function runPool<T>(
  rows: T[],
  workers: number,
  work: (row: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, rows.length) }, async () => {
      while (next < rows.length) {
        const index = next;
        next += 1;
        await work(rows[index]);
      }
    }),
  );
}

function selectedRows(rows: FrozenRow[], limit: number, seed: string) {
  const attested = rows.filter((row) => row.condition === "attested");
  if (new Set(attested.map((row) => row.groupId)).size !== attested.length) {
    throw new Error("frozen benchmark repeats an attested group");
  }
  return [...attested]
    .sort((left, right) =>
      sha256(`${seed}:${left.groupId}`).localeCompare(
        sha256(`${seed}:${right.groupId}`),
      ),
    )
    .slice(0, limit > 0 ? Math.min(limit, attested.length) : attested.length);
}

async function run() {
  if (flag("below-normal", "1") !== "0") {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  }
  const benchmark = path.resolve(flag("benchmark", defaultBenchmark()));
  const output = path.resolve(
    flag(
      "output",
      path.join(
        os.tmpdir(),
        "beaver-legal-grounding",
        `natural-framing-${new Date().toISOString().replace(/[:.]/gu, "-")}.jsonl`,
      ),
    ),
  );
  const errorOutput = `${output}.errors.jsonl`;
  const model = flag("model", "codex:gpt-5.6-luna");
  const effort = flag("effort", "low");
  const workers = Number(flag("workers", "8"));
  const attempts = Number(flag("attempts", "2"));
  const timeoutMs = Number(flag("timeout-ms", "180000"));
  const limit = Number(flag("limit", "0"));
  const seed = flag("seed", "20260801");
  const windowChars = Number(flag("window-chars", "3000"));
  const resume = flag("resume", "0") !== "0";
  const conditions = flag("conditions", "quote_only,source_context")
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is Condition =>
      value === "quote_only" || value === "source_context",
    );
  if (!Number.isInteger(workers) || workers < 1) throw new Error("--workers must be >= 1");
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("--attempts must be >= 1");
  if (!conditions.length) throw new Error("no valid --conditions");
  const benchmarkBytes = readFileSync(benchmark);
  const frozenSha256 = sha256(benchmarkBytes);
  const selected = selectedRows(readJsonl<FrozenRow>(benchmark), limit, seed);
  const contexts = new Map<string, SourceContext>();
  for (const row of selected) {
    contexts.set(row.groupId, sourceContext(row, windowChars));
  }
  const cells = selected.flatMap((row) =>
    conditions.map((condition) => ({ row, condition })),
  );
  console.log(
    JSON.stringify({
      frozen_rows: selected.length,
      calls: cells.length,
      splits: Object.fromEntries(
        [...new Set(selected.map((row) => row.split))].map((split) => [
          split,
          selected.filter((row) => row.split === split).length,
        ]),
      ),
      conditions,
      model,
      effort,
      workers,
      priority: os.getPriority(),
      frozen_sha256: frozenSha256,
    }),
  );
  if (process.argv.includes("--dry-run")) return;
  mkdirSync(path.dirname(output), { recursive: true });
  if (!resume) {
    writeFileSync(output, "", "utf8");
    writeFileSync(errorOutput, "", "utf8");
  }
  const existing = resume && existsSync(output) ? readJsonl<GeneratedRow>(output) : [];
  if (
    existing.some(
      (row) => row.generation_model !== model || row.generation_effort !== effort,
    )
  ) throw new Error("resume output contains a different model or effort");
  const done = new Set(existing.map((row) => row.id));
  const pending = cells.filter(
    ({ row, condition }) => !done.has(`${row.groupId}:${condition}`),
  );
  let completed = 0;
  let failures = 0;
  let rateLimitUntil = 0;
  let announcedRateLimitUntil = 0;
  const waitForRateLimit = async () => {
    const waitMs = rateLimitUntil - Date.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  };
  await runPool(pending, workers, async ({ row, condition }) => {
    const id = `${row.groupId}:${condition}`;
    const context = contexts.get(row.groupId)!;
    let finalError = "generation_failed";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await waitForRateLimit();
      const started = Date.now();
      try {
        const prompt = {
          task: REQUEST,
          citation: row.cited.citation,
          exact_quotation: row.quote.text,
          ...(condition === "source_context"
            ? { exact_source_context: context.text }
            : {}),
        };
        const result = await streamChatWithTools({
          model,
          reasoningEffort: effort,
          enableThinking: false,
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: "user", content: JSON.stringify(prompt) }],
          tools: [],
          maxIterations: 1,
          abortSignal: AbortSignal.timeout(timeoutMs),
        });
        const claim = normalizeWhitespace(result.fullText);
        const contractError = claimContractError(claim, row.quote.text);
        if (contractError) throw new Error(contractError);
        const generated: GeneratedRow = {
          id,
          record_type: "claim",
          cell_id: id,
          claim_id: id,
          case_id: row.cited.stableSourceId,
          suite: "natural_quote_framing",
          split: row.split,
          arm: condition,
          claim_kind: "conclusion",
          claim_text: claim,
          evidence_ids: [`context:${context.sha256}`],
          route: "semantic_check",
          route_reason: "generated_affirmative_quote_framing",
          deterministic_support: false,
          cell_proxy_label: null,
          values: featureValues(claim, row.quote.text, context.text),
          source: SOURCE,
          source_class: "case",
          doc_id: row.cited.stableSourceId,
          response_id: row.groupId,
          claim,
          citation: row.cited.citation,
          evidence_texts: [context.text],
          label: "unlabelled",
          label_provenance: "independent_semantic_checker_pending_not_gold",
          request_context: REQUEST,
          exact_quote: row.quote.text,
          exact_quote_sha256: row.quote.sha256,
          source_context_sha256: context.sha256,
          source_document_sha256: context.documentSha256,
          frozen_benchmark_sha256: frozenSha256,
          generation_condition: condition,
          generation_model: model,
          generation_effort: effort,
          generation_attempt: attempt,
          generation_latency_ms: Date.now() - started,
          usage: result.usage ?? null,
        };
        appendFileSync(output, `${JSON.stringify(generated)}\n`, "utf8");
        finalError = "";
        break;
      } catch (error) {
        finalError = error instanceof Error ? error.message : String(error);
        if (/\b429\b|rate limit/iu.test(finalError)) {
          rateLimitUntil = Math.max(rateLimitUntil, Date.now() + 45_000);
          if (Date.now() >= announcedRateLimitUntil) {
            announcedRateLimitUntil = rateLimitUntil;
            console.log("rate limited | shared 45s cooldown");
          }
        }
      }
    }
    if (finalError) {
      failures += 1;
      appendFileSync(
        errorOutput,
        `${JSON.stringify({ id, model, effort, error: finalError })}\n`,
        "utf8",
      );
    }
    completed += 1;
    if (completed % 10 === 0 || finalError) {
      console.log(`${completed}/${pending.length} | ${id} | ${finalError || "ok"}`);
    }
  });
  console.log(
    JSON.stringify(
      {
        output,
        output_sha256: sha256(readFileSync(output)),
        completed,
        failures,
        rows: readJsonl<GeneratedRow>(output).length,
      },
      null,
      2,
    ),
  );
  if (failures) process.exitCode = 2;
}

function selfTest() {
  const quote = "A tribunal may grant relief in this case.";
  const claim = "Relief must always follow whenever an applicant asks.";
  if (quoteOperatorRisk(claim, quote) !== 1) throw new Error("operator self-test failed");
  const values = featureValues(claim, quote, `${quote} The remedy remains discretionary.`);
  if (values.word_count !== 8 || values.content_words < 4) {
    throw new Error("length self-test failed");
  }
  if (claimContractError("The supplied passage is insufficient context.", quote) !== "meta_or_refusal_claim") {
    throw new Error("claim contract self-test failed");
  }
  console.log("ok");
}

if (process.argv.includes("--self-test")) selfTest();
else void run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
