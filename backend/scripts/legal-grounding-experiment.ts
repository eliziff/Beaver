/**
 * PROVISIONAL, BENCHMARK-TESTED ONLY.
 *
 * Holds the model and evidence constant while changing only when Beaver
 * structures and checks a legal answer:
 *   control        ordinary grounded answer
 *   compose_check  support-unit/evidence output, then contextual check
 *   evidence_first commit evidence first, compose, then semantic check
 *   holistic_check support-unit/evidence output, then one whole-answer check
 *
 * The runner reads public benchmark files in place and writes only private
 * receipts (default: the OS temp directory). It does not download or vendor
 * corpora. Example:
 *
 *   npx tsx scripts/legal-grounding-experiment.ts `
 *     --models codex:gpt-5.6-sol,claude-p:claude-sonnet-4-6 `
 *     --split validation --per-source 1 `
 *     --clerc C:\path\to\CLERC\generation\test.jsonl `
 *     --housing C:\path\to\housing_qa\data\questions.json.zip
 */
import "../src/lib/loadEnv";

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  standsForProfile,
  type StandsForRankPolicy,
} from "../src/lib/caselawCitator";
import { corpusAlienness } from "../src/lib/legalClaimLint";
import {
  LEGAL_EVIDENCE_EXPERIMENT_MODES,
  LEGAL_EVIDENCE_PLAN_TOOL_NAME,
  LEGAL_EVIDENCE_TOOL_NAME,
  attestedCharacterizationReceipt,
  createBenchmarkEvidence,
  createLegalEvidenceTurnState,
  finalizeLegalEvidenceExperiment,
  legalEvidenceExperimentTools,
  legalEvidenceReceiptEvent,
  planLegalEvidence,
  registerLegalEvidence,
  renderLegalEvidenceAnswer,
  submitLegalEvidenceAnswer,
  type LegalEvidenceExperimentMode,
  type LegalEvidenceReceipt,
  type LegalSourceClass,
} from "../src/lib/chat/legalEvidenceExperiment";
import {
  legalGroundingCellKey,
  receiptPath,
} from "../src/lib/experimentReceipts";
import {
  clercCases,
  cslbCases,
  housingCases,
  readJsonl,
  type BenchmarkCase,
  type Suite,
} from "../src/lib/legalGroundingBenchmarks";
import {
  streamChatWithTools,
  type NormalizedLlmUsage,
  type NormalizedToolCall,
  type NormalizedToolResult,
} from "../src/lib/llm";

type Arm = "control" | LegalEvidenceExperimentMode;
type RunReceipt = {
  schema_version: 3;
  case_id: string;
  suite: Suite;
  jurisdiction: "CA" | "US";
  source_class: LegalSourceClass;
  adversarial: boolean;
  gold_kind: BenchmarkCase["goldKind"];
  reference_expectation: BenchmarkCase["referenceExpectation"] | null;
  model: string;
  /** Checker model when crossed; null means same-model checking. */
  checker_model: string | null;
  effort: string;
  arm: Arm;
  status: "completed" | "error";
  /** H17: named prompt modules assembled for this cell (empty = control's
   * legacy prose prompt). Identical lists mean identical system prompts. */
  prompt_modules: string[];
  latency_ms: number;
  primary_tool_calls: string[];
  finalizer_model_calls: number;
  finalizer_diagnostic: string | null;
  answerability_decision: "sufficient" | "insufficient" | null;
  holistic_verdict:
    | "supported"
    | "partially_supported"
    | "unsupported"
    | null;
  usage: NormalizedLlmUsage;
  answer: string;
  target_token_f1: number;
  expected_answer_match: boolean | null;
  inline_citation_rate: number | null;
  support_expectation_match: boolean | null;
  /** Stage 8 coverage audit: attested characterizations registered per
   * cited neutral citation (empty object outside attested_framing). */
  attested_characterizations: Record<string, number>;
  /** Stage 9 H19: candidate ordering policy for this cell's attested
   * offer; null when the cell fed no candidates (non-attested arms and
   * non-case cells, where policy is a no-op). */
  rank_policy: StandsForRankPolicy | null;
  /** Stage 9 H19: offered candidate span hashes per citation, in rank
   * order, so analysis derives WHICH rank each quoted candidate held. */
  attested_offer: Record<string, string[]>;
  /** Stage 9 H19: best (lowest) offer rank quoted by a final claim,
   * 1-based; null when no attested candidate was quoted. */
  quoted_attested_rank: number | null;
  /** Stage 9 H13 receipt-only witness: alienness spectrum of the final
   * conclusion claim (C4 matrix growth); null when absent/no index. */
  conclusion_alienness: {
    unattested: number;
    boilerplate: number;
    attestedRare: number;
    trigrams: number;
  } | null;
  legal_evidence_receipt: ReturnType<typeof legalEvidenceReceiptEvent>;
  error: string | null;
};

const emptyUsage = (): NormalizedLlmUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: null,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
});

function mergeUsage(
  left: NormalizedLlmUsage,
  right?: NormalizedLlmUsage,
): NormalizedLlmUsage {
  const add = (
    a: number | null,
    b: number | null | undefined,
  ): number | null => (a === null && b == null ? null : (a ?? 0) + (b ?? 0));
  return {
    inputTokens: add(left.inputTokens, right?.inputTokens),
    outputTokens: add(left.outputTokens, right?.outputTokens),
    reasoningTokens: add(left.reasoningTokens, right?.reasoningTokens),
    cacheReadInputTokens: add(
      left.cacheReadInputTokens,
      right?.cacheReadInputTokens,
    ),
    cacheWriteInputTokens: add(
      left.cacheWriteInputTokens,
      right?.cacheWriteInputTokens,
    ),
  };
}

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

function listFlag(name: string, fallback: string): string[] {
  return flag(name, fallback)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function evidencePrompt(
  receipts: LegalEvidenceReceipt[],
): Array<Record<string, unknown>> {
  return receipts.map((receipt) => ({
    evidence_id: receipt.evidence_id,
    citation: receipt.citation,
    locator: receipt.locator.label,
    span_text: receipt.span_text,
  }));
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

function terms(text: string) {
  return text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function tokenF1(expected: string, actual: string) {
  const wanted = terms(expected);
  const got = terms(actual);
  if (!wanted.length || !got.length) return 0;
  const counts = new Map<string, number>();
  wanted.forEach((term) => counts.set(term, (counts.get(term) ?? 0) + 1));
  let overlap = 0;
  for (const term of got) {
    const available = counts.get(term) ?? 0;
    if (!available) continue;
    overlap += 1;
    counts.set(term, available - 1);
  }
  const precision = overlap / got.length;
  const recall = overlap / wanted.length;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function expectedAnswerMatch(
  expected: BenchmarkCase["expectedAnswer"],
  answer: string,
) {
  if (!expected) return null;
  const match = answer.trim().match(/\b(yes|no)\b/iu);
  return match ? match[1].toLowerCase() === expected : false;
}

function citationRate(
  state: ReturnType<typeof createLegalEvidenceTurnState>,
) {
  if (!state.answer?.length) return null;
  const cited = state.answer.filter((claim) =>
    claim.evidence_ids.every((id) => state.evidence.has(id)),
  ).length;
  return cited / state.answer.length;
}

async function runCase(
  item: BenchmarkCase,
  model: string,
  effort: string,
  arm: Arm,
  timeoutMs: number,
  checkerModel: string | null = null,
  rankPolicy: StandsForRankPolicy | null = null,
): Promise<RunReceipt> {
  const started = Date.now();
  const state = createLegalEvidenceTurnState(
    arm === "control" ? null : arm,
  );
  // Stage 8b: premise anchoring source for typed premise_correction
  // claims, every structured arm (shared contract infrastructure). The
  // benchmarks are single-turn, so prior_answer never exists here.
  if (arm !== "control")
    state.premiseContext = { question: item.prompt, priorAnswer: null };
  if (arm !== "control") {
    // Stage 7: the lint needs the question (H14) and the
    // jurisdiction-matched alienness index (H13). US cells use the
    // CAP-bulk index built beside the Canadian default. Stage 9 arms
    // this for EVERY structured arm: only lint_gated gates on it; the
    // others use just the index path for the bounce-time alienness
    // advisory (H13-advisory, advisory-only by registration).
    state.lintContext = {
      question: item.prompt,
      ...(item.jurisdiction === "US"
        ? {
            alienessIndexPath: path.join(
              process.env.LOCALAPPDATA ?? "",
              "ALR Quote Verifier",
              "alienness",
              "trigrams-en-us.sqlite",
            ),
          }
        : {}),
    };
  }
  const receipts = item.evidence.map((source) =>
    createBenchmarkEvidence({
      jurisdiction: item.jurisdiction,
      sourceClass: item.sourceClass,
      ...source,
    }),
  );
  receipts.forEach((receipt) => registerLegalEvidence(state, receipt));
  // H12 feed-forward (Stage 8): for case-law cells, register ranked
  // attested characterizations of each cited case so stands-for claims
  // can clear the widened tier by quoting them. A null profile (no
  // local citator) or tier "none" registers nothing — the composition
  // contract then forces passage quotes or the typed statement.
  const attested: LegalEvidenceReceipt[] = [];
  const attestedByCitation: Record<string, number> = {};
  // Stage 9 H19/H20: offered candidate evidence_ids per citation in rank
  // order (quoted-rank analysis), span hashes for the receipt, and the
  // newest candidate year per citation for the pre-declaration module.
  const attestedOffer: Record<string, string[]> = {};
  const offeredRankByEvidenceId = new Map<string, number>();
  const newestByCitation: Record<string, string | null> = {};
  const attestedArm =
    arm === "attested_framing" ||
    arm === "required_slot" ||
    arm === "witness_panel";
  const slotArm = arm === "required_slot" || arm === "witness_panel";
  // Stage 10 H18: per-citation profile facts for the witness panel,
  // built from the SAME standsForProfile call that supplies the offer.
  const panelFacts: string[] = [];
  if (attestedArm && item.sourceClass === "case") {
    // Benchmark citations carry style-of-cause and pinpoints
    // ("Daignault v. Gueldner, 2007 BCCA 40, para. 14"), but the citator
    // keys decisions by neutral citation. Extract them with the citator
    // builder's own NEUTRAL_RE (build_citator_graph.py).
    const neutralRe = /\b(?:17|18|19|20)\d{2}\s+[A-Z][A-Z0-9-]{1,15}\s+\d+\b/gu;
    for (const citation of new Set(
      item.evidence.flatMap(
        (source) => source.citation.match(neutralRe) ?? [source.citation],
      ),
    )) {
      attestedByCitation[citation] = 0;
      attestedOffer[citation] = [];
      newestByCitation[citation] = null;
      // H20 cheap selection: the offer is the TOP 3 ranked candidates
      // (Stage 8b offered up to 8 and models bailed on selection).
      const profile = standsForProfile({
        citation,
        size: 3,
        rankPolicy: rankPolicy ?? undefined,
      });
      if (arm === "witness_panel")
        panelFacts.push(
          profile
            ? `${citation}: profile ${profile.tier}, ${
                profile.totalCiters
              } citing case${
                profile.totalCiters === 1 ? "" : "s"
              } in the local graph${
                profile.candidates.length
                  ? `; supplied candidates ${profile.candidates
                      .map(
                        (candidate, index) =>
                          `#${index + 1} ${candidate.citingDate ?? "undated"} ${
                            candidate.sourceKind === "commentary"
                              ? (candidate.journalName ?? "journal commentary")
                              : (candidate.citingCourt ??
                                candidate.citingCitation ??
                                "citing case")
                          } (${candidate.sourceKind})`,
                      )
                      .join(", ")}`
                  : ""
              }`
            : `${citation}: no local citator profile`,
        );
      for (const candidate of profile?.candidates ?? []) {
        const receipt = attestedCharacterizationReceipt({
          citedCitation: citation,
          characterization: candidate,
          jurisdiction: item.jurisdiction,
        });
        registerLegalEvidence(state, receipt);
        attested.push(receipt);
        attestedByCitation[citation] += 1;
        attestedOffer[citation].push(candidate.spanSha256);
        offeredRankByEvidenceId.set(
          receipt.evidence_id,
          attestedOffer[citation].length,
        );
        if (
          candidate.citingDate &&
          (newestByCitation[citation] === null ||
            candidate.citingDate > newestByCitation[citation]!)
        )
          newestByCitation[citation] = candidate.citingDate;
      }
    }
    // H15: every cited case needs its characterization slot filled — by
    // an attested-verbatim quote or the exact typed refusal — including
    // zero-candidate citations (where only the refusal can fill it).
    if (slotArm)
      state.requiredCharacterizations = Object.keys(attestedByCitation);
  }
  const primaryToolCalls: string[] = [];
  let usage = emptyUsage();
  let finalizerModelCalls = 0;
  let finalizerDiagnostic: string | null = null;
  let answer = "";
  const abortSignal = AbortSignal.timeout(timeoutMs);
  // H17 (Stage 8b): ONE base composition prompt shared verbatim by every
  // structured arm; each mechanism travels as a named module appended
  // only where that mechanism can act on the cell. Arms therefore differ
  // on mechanism-no-op cells (e.g. attested arms on legislation) by
  // NOTHING, so cross-arm drift there falls to checker stochasticity.
  // Module names ride into the run receipt as prompt_modules.
  const promptModules: Array<[name: string, text: string]> = [
    [
      "base",
      "Answer only from the supplied exact passages. Finish through the available grounded-answer tool without a prose copy or citation text; Beaver places citations from the evidence receipts.",
    ],
    [
      "roles",
      'Type every claim with its kind. "quotation": a supplied span\'s words copied EXACTLY — no edits, no elisions, no framing around them. "conclusion": the direct answer to the question in your own words. "premise_correction": the question (or a prior assistant answer) asserts something the passages contradict — set premise_source, copy the contested words verbatim into premise_text, and state the correction from the passages. Set premise_source and premise_text to null on every other kind.',
    ],
  ];
  if (arm === "evidence_first")
    promptModules.push([
      "plan",
      "Before composing, call plan_grounded_evidence to decide whether the passages are sufficient. If insufficient, commit no evidence IDs and stop. If sufficient, commit the minimal evidence IDs before composing.",
    ]);
  if (arm === "quote_first" || attestedArm)
    promptModules.push([
      "quote_contract",
      "Prefer quotation claims. At most ONE conclusion claim, stating only what the quoted text establishes; never characterize the law beyond the quoted words (never assert a statute 'regulates', 'has a framework', or 'governs' unless those words are quoted). If the passages cannot support a direct answer, say exactly that in the conclusion claim. The submission tool rejects violations with the compliant path restated; follow it and resubmit.",
    ]);
  if (attestedArm && item.sourceClass === "case")
    promptModules.push([
      "attested",
      "Attested characterizations of the cited cases may be supplied as additional quotable evidence. Any claim saying what a case stands for, held, establishes, or governs must be a verbatim quote of the cited passage or of an attested characterization named in its evidence ids; if none is supplied for that case, either quote the passage itself or write exactly: No attested characterization of [neutral citation] is available. Never compose your own characterization; Beaver renders attribution from the evidence receipts.",
    ]);
  if (attestedArm && item.sourceClass === "case")
    // Stage 9 H20 thin-profile pre-declaration: state the selection
    // problem's size up front so refusal is a choice, not a bail.
    promptModules.push([
      "predeclare",
      `Attested characterization availability: ${Object.entries(
        attestedByCitation,
      )
        .map(([citation, count]) =>
          count
            ? `${citation}: ${count} supplied${
                newestByCitation[citation]
                  ? ` (newest ${newestByCitation[citation]!.slice(0, 4)})`
                  : ""
              }`
            : `${citation}: none are available`,
        )
        .join("; ")}.`,
    ]);
  if (slotArm && item.sourceClass === "case")
    promptModules.push([
      "slot",
      'For EACH cited case, your answer MUST fill its characterization slot: either a kind "quotation" claim copying one supplied attested characterization exactly (citing its evidence id), or a claim reading exactly: No attested characterization of [that case\'s neutral citation] is available.',
    ]);
  if (arm === "witness_panel" && item.sourceClass === "case")
    // Stage 10 H18: the same deterministic facts the gates compute,
    // surfaced BEFORE composition. Context only — the panel is never
    // registered as evidence, so quoting it cannot clear the verbatim
    // tier (attempted parroting surfaces as quotation rejections).
    promptModules.push([
      "panel",
      `Witness panel, deterministic facts about this question's evidence (context only — the panel is not quotable evidence): ${panelFacts.join(
        "; ",
      )}. Checks your submission faces: quotation claims must match a supplied span or attested characterization verbatim; each cited case's characterization slot must be filled by an attested quote or the exact unavailability sentence; a decision cannot be said to follow or apply a decision that postdates it; conclusion phrasing unattested in the legal corpus draws a style advisory. A first submission meeting these is accepted without bounces.`,
    ]);
  if (arm === "tiered_check" || arm === "lint_gated")
    promptModules.push([
      "verbatim_preference",
      "Where a passage's exact words answer the question, make that claim a verbatim quotation; paraphrase only where quotation cannot answer.",
    ]);
  if (arm === "lint_gated")
    promptModules.push([
      "lint",
      "The submission tool may return deterministic lint warnings naming a claim's feature values; revise that claim once to track the cited passage's own words, or replace it with a verbatim quotation.",
    ]);
  try {
    const structured = arm !== "control" && arm !== "posthoc";
    const primary = await streamChatWithTools({
      model,
      reasoningEffort: effort,
      enableThinking: false,
      systemPrompt: structured
        ? promptModules.map(([, text]) => text).join(" ")
        : "Answer only from the supplied exact passages. Correct any premise that conflicts with them. Put authority citations inline.",
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            question: item.prompt,
            evidence: evidencePrompt(receipts),
            ...(attestedArm
              ? { attested_characterizations: evidencePrompt(attested) }
              : {}),
          }),
        },
      ],
      tools: structured ? legalEvidenceExperimentTools(arm) : [],
      maxIterations:
        arm === "evidence_first" ||
        arm === "quote_first" ||
        attestedArm ||
        arm === "lint_gated"
          ? 3
          : structured
            ? 2
            : 1,
      abortSignal,
      callbacks: {
        onToolCallStart: (call) => primaryToolCalls.push(call.name),
      },
      runTools: structured
        ? async (calls) => calls.map((call) => runTool(call, state))
        : undefined,
    });
    usage = mergeUsage(usage, primary.usage);
    if (arm === "control") {
      answer = primary.fullText.trim();
    } else {
      const finalized = await finalizeLegalEvidenceExperiment({
        state,
        model,
        checkerModel: checkerModel ?? undefined,
        draft: primary.fullText,
        requestContext: item.prompt,
        reasoningEffort: effort,
        abortSignal,
      });
      finalizerModelCalls = finalized.modelCalls;
      finalizerDiagnostic = finalized.diagnostic;
      usage = mergeUsage(usage, finalized.usage);
      answer = renderLegalEvidenceAnswer(state) ?? "";
    }
    const legalReceipt =
      arm === "control" ? null : legalEvidenceReceiptEvent(state);
    // Stage 9 H19: which offered rank (1-based, best of any claim) did
    // the FINAL submission quote — computed from the receipt's claims
    // whether the cell passed or failed, so selection behavior is
    // visible on failures too.
    const quotedRanks = (legalReceipt?.claims ?? []).flatMap((claim) =>
      claim.evidence_ids.flatMap((id) => {
        const rank = offeredRankByEvidenceId.get(id);
        return rank === undefined ? [] : [rank];
      }),
    );
    // Stage 9 H13 receipt-only witness: the final conclusion claim's
    // alienness spectrum (index omitted from the row; the log records
    // the index build).
    const conclusionClaim = (legalReceipt?.claims ?? []).find(
      (claim) => claim.kind === "conclusion",
    );
    const conclusionSpectrum = conclusionClaim
      ? corpusAlienness(conclusionClaim.text, {
          indexPath: state.lintContext?.alienessIndexPath,
        })
      : null;
    return {
      schema_version: 3,
      case_id: item.id,
      suite: item.suite,
      jurisdiction: item.jurisdiction,
      source_class: item.sourceClass,
      adversarial: item.adversarial,
      gold_kind: item.goldKind,
      reference_expectation: item.referenceExpectation ?? null,
      model,
      checker_model: checkerModel,
      effort,
      arm,
      status: "completed",
      prompt_modules:
        arm === "control" ? [] : promptModules.map(([name]) => name),
      latency_ms: Date.now() - started,
      primary_tool_calls: primaryToolCalls,
      finalizer_model_calls: finalizerModelCalls,
      finalizer_diagnostic: finalizerDiagnostic,
      answerability_decision: state.answerability,
      holistic_verdict: state.holisticVerdict,
      usage,
      answer,
      target_token_f1: tokenF1(item.target, answer),
      expected_answer_match: expectedAnswerMatch(item.expectedAnswer, answer),
      inline_citation_rate: arm === "control" ? null : citationRate(state),
      support_expectation_match:
        arm === "control" || !item.referenceExpectation
          ? null
          : arm === "evidence_first"
            ? item.referenceExpectation === "insufficient"
              ? state.answerability === "insufficient"
              : state.answerability === "sufficient" &&
                legalReceipt?.status === "passed"
            : (legalReceipt?.status === "passed") ===
              (item.referenceExpectation === "sufficient"),
      attested_characterizations: attestedByCitation,
      rank_policy:
        attestedArm && item.sourceClass === "case"
          ? (rankPolicy ?? "authority")
          : null,
      attested_offer: attestedOffer,
      quoted_attested_rank: quotedRanks.length
        ? Math.min(...quotedRanks)
        : null,
      conclusion_alienness: conclusionSpectrum
        ? {
            unattested: conclusionSpectrum.unattested,
            boilerplate: conclusionSpectrum.boilerplate,
            attestedRare: conclusionSpectrum.attestedRare,
            trigrams: conclusionSpectrum.trigrams,
          }
        : null,
      legal_evidence_receipt: legalReceipt,
      error: null,
    };
  } catch (error) {
    return {
      schema_version: 3,
      case_id: item.id,
      suite: item.suite,
      jurisdiction: item.jurisdiction,
      source_class: item.sourceClass,
      adversarial: item.adversarial,
      gold_kind: item.goldKind,
      reference_expectation: item.referenceExpectation ?? null,
      model,
      checker_model: checkerModel,
      effort,
      arm,
      status: "error",
      prompt_modules:
        arm === "control" ? [] : promptModules.map(([name]) => name),
      latency_ms: Date.now() - started,
      primary_tool_calls: primaryToolCalls,
      finalizer_model_calls: finalizerModelCalls,
      finalizer_diagnostic: finalizerDiagnostic,
      answerability_decision: state.answerability,
      holistic_verdict: state.holisticVerdict,
      usage,
      answer,
      target_token_f1: 0,
      expected_answer_match: expectedAnswerMatch(item.expectedAnswer, answer),
      inline_citation_rate: null,
      support_expectation_match: null,
      attested_characterizations: attestedByCitation,
      rank_policy:
        attestedArm && item.sourceClass === "case"
          ? (rankPolicy ?? "authority")
          : null,
      attested_offer: attestedOffer,
      quoted_attested_rank: null,
      conclusion_alienness: null,
      legal_evidence_receipt:
        arm === "control" ? null : legalEvidenceReceiptEvent(state),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function average(values: number[]) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
}

/**
 * Bounded pool over independent cells with a per-model lane cap: parallel
 * Claude lanes are free throughput, while the overload-prone provider is
 * kept at a low cap so concurrency does not manufacture transport errors.
 * Cells stay independent — the pool changes wall-clock, never inputs.
 */
async function runPool<T extends { model: string }>(
  cells: T[],
  limit: number,
  perModel: number,
  worker: (cell: T) => Promise<void>,
): Promise<void> {
  const pending = [...cells];
  const active = new Map<string, number>();
  let running = 0;
  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (!pending.length && running === 0) return resolve();
      for (let index = 0; index < pending.length && running < limit; ) {
        const cell = pending[index];
        if ((active.get(cell.model) ?? 0) >= perModel) {
          index += 1;
          continue;
        }
        pending.splice(index, 1);
        active.set(cell.model, (active.get(cell.model) ?? 0) + 1);
        running += 1;
        worker(cell).then(
          () => {
            active.set(cell.model, active.get(cell.model)! - 1);
            running -= 1;
            pump();
          },
          (error) => {
            failed = true;
            reject(error);
          },
        );
      }
    };
    pump();
  });
}

function printSummary(rows: RunReceipt[]) {
  const groups = new Map<string, RunReceipt[]>();
  rows.forEach((row) => {
    const checker = row.checker_model
      ? ` | checker=${row.checker_model.split(":")[0]}`
      : "";
    const key = `${row.model} | ${row.arm}${checker}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  });
  console.log(
    "\nmodel | arm | n | errors | pass | support-gate | token-F1 | cites | seconds | input | output",
  );
  for (const [key, group] of groups) {
    const completed = group.filter((row) => row.status === "completed");
    const structured = completed.filter((row) => row.legal_evidence_receipt);
    const passed = structured.filter(
      (row) => row.legal_evidence_receipt?.status === "passed",
    ).length;
    const citationRows = completed
      .map((row) => row.inline_citation_rate)
      .filter((value): value is number => value !== null);
    const supportRows = completed
      .map((row) => row.support_expectation_match)
      .filter((value): value is boolean => value !== null);
    console.log(
      [
        key,
        group.length,
        group.length - completed.length,
        structured.length ? (passed / structured.length).toFixed(2) : "-",
        supportRows.length
          ? (
              supportRows.filter(Boolean).length / supportRows.length
            ).toFixed(2)
          : "-",
        average(completed.map((row) => row.target_token_f1)).toFixed(2),
        citationRows.length ? average(citationRows).toFixed(2) : "-",
        (average(group.map((row) => row.latency_ms)) / 1_000).toFixed(1),
        completed.reduce(
          (total, row) => total + (row.usage.inputTokens ?? 0),
          0,
        ),
        completed.reduce(
          (total, row) => total + (row.usage.outputTokens ?? 0),
          0,
        ),
      ].join(" | "),
    );
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, "../..");
  const split = flag("split", "validation");
  const perSource = Number(flag("per-source", "1"));
  if (!Number.isInteger(perSource) || perSource < 1)
    throw new Error("--per-source must be a positive integer");
  const models = listFlag(
    "models",
    "codex:gpt-5.6-sol,claude-p:claude-sonnet-4-6",
  );
  const arms = listFlag(
    "arms",
    `control,${LEGAL_EVIDENCE_EXPERIMENT_MODES.join(",")}`,
  ) as Arm[];
  if (
    arms.some(
      (arm) =>
        arm !== "control" &&
        !LEGAL_EVIDENCE_EXPERIMENT_MODES.includes(
          arm as LegalEvidenceExperimentMode,
        ),
    )
  ) {
    throw new Error(`unknown --arms value: ${arms.join(",")}`);
  }
  const suites = new Set(
    listFlag("suites", "cslb,clerc,housing") as Suite[],
  );
  const effort = flag("effort", "low");
  const timeoutMs = Number(flag("timeout-ms", "90000"));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000)
    throw new Error("--timeout-ms must be an integer of at least 1000");
  const tempRoot = path.join(os.tmpdir(), "beaver-legal-grounding");
  const cslbFile = flag(
    "cslb",
    path.join(
      repoRoot,
      "benchmarks/legal-generalization-corpus/cslb/repo/data/a2aj_benchmark.jsonl",
    ),
  );
  const clercFile = flag(
    "clerc",
    process.env.CLERC_GENERATION_TEST ??
      path.join(tempRoot, "clerc/generation/test.jsonl"),
  );
  const housingFile = flag(
    "housing",
    process.env.HOUSING_QA_QUESTIONS ??
      path.join(tempRoot, "housing_qa/data/questions.json.zip"),
  );
  const housingIds = listFlag("housing-ids", "163,0").map((value) => {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 0)
      throw new Error(`invalid --housing-ids value: ${value}`);
    return id;
  });
  const cases: BenchmarkCase[] = [];
  if (suites.has("cslb")) cases.push(...cslbCases(cslbFile, split, perSource));
  if (suites.has("clerc")) {
    if (!existsSync(clercFile))
      throw new Error(`CLERC file not found: ${clercFile}`);
    cases.push(...clercCases(clercFile, perSource));
  }
  if (suites.has("housing")) {
    if (!existsSync(housingFile))
      throw new Error(`HousingQA file not found: ${housingFile}`);
    cases.push(...(await housingCases(housingFile, housingIds)));
  }
  const onlyCases = flag("cases", "");
  if (onlyCases) {
    const wanted = new Set(onlyCases.split(",").map((value) => value.trim()));
    const kept = cases.filter((item) => wanted.has(item.id));
    const missing = [...wanted].filter(
      (id) => !cases.some((item) => item.id === id),
    );
    if (missing.length)
      throw new Error(`--cases ids not in selection: ${missing.join(",")}`);
    cases.length = 0;
    cases.push(...kept);
  }
  if (!cases.length) throw new Error("no benchmark cases selected");

  console.log(
    `selected ${cases.length} cases: ${cases.map((item) => item.id).join(", ")}`,
  );
  if (process.argv.includes("--dry-run")) return;

  const concurrency = Number(flag("concurrency", "4"));
  const perModel = Number(flag("per-model-concurrency", "2"));
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("--concurrency must be a positive integer");
  if (!Number.isInteger(perModel) || perModel < 1)
    throw new Error("--per-model-concurrency must be a positive integer");

  // Checker-model factor: "same" checks with the composer model; "cross"
  // checks with the OTHER model in --models (controls for the composing
  // model's inherent legal reliability); an explicit model id pins the
  // checker. Control cells have no checker and run once.
  const checkerSpecs = listFlag("checker-models", "same");
  // Stage 9 H19: rank policies over the attested candidate offer. A
  // policy-variant cell exists ONLY where the policy can act — case
  // cells of attested arms; everywhere else the cell runs once with a
  // null policy (the offer is empty and the prompt identical, so extra
  // variants would just resample checker noise).
  const rankPolicies = listFlag(
    "rank-policies",
    "authority",
  ) as StandsForRankPolicy[];
  for (const policy of rankPolicies)
    if (!["authority", "banded_recency", "flat_recency"].includes(policy))
      throw new Error(`unknown --rank-policies entry: ${policy}`);
  // --resume 1: keep the existing output file and skip cells it already
  // holds a non-error row for; errored cells get another attempt (the
  // file may then hold both rows — analysis dedupes keeping the last).
  const resume = flag("resume", "0") !== "0";
  // Receipt destination, resolved AFTER --dry-run so a dry run can never
  // be refused by the guard. Without --resume the branch below truncates
  // the file, so an existing receipt throws unless --force: receipts are
  // append-only evidence with shas pinned in the experiment log.
  const output = receiptPath(
    path.join(
      tempRoot,
      `results-${new Date().toISOString().replace(/[:.]/gu, "-")}.jsonl`,
    ),
    { resume },
  );
  mkdirSync(path.dirname(output), { recursive: true });
  const done = new Set<string>();
  if (resume && existsSync(output)) {
    for (const row of readJsonl<RunReceipt>(output))
      if (!row.error) done.add(legalGroundingCellKey(row));
  } else {
    writeFileSync(output, "", "utf8");
  }
  const rows: RunReceipt[] = [];
  const cells = models.flatMap((model) =>
    arms.flatMap((arm) =>
      (arm === "control" ? ["same"] : checkerSpecs).flatMap((spec) => {
        const checker =
          spec === "same"
            ? null
            : spec === "cross"
              ? (models.find((other) => other !== model) ?? null)
              : spec;
        if (spec === "cross" && !checker) return [];
        return cases.flatMap((item) => {
          const policyCell =
            (arm === "attested_framing" ||
              arm === "required_slot" ||
              arm === "witness_panel") &&
            item.sourceClass === "case";
          return (policyCell ? rankPolicies : [null]).map((policy) => ({
            model,
            arm,
            checker,
            item,
            policy,
          }));
        });
      }),
    ),
  );
  // Cell identity (src/lib/experimentReceipts) now carries `effort`: it
  // changes what the cell means and every row already records it, so a
  // ladder lane no longer needs its own output file to stay separable.
  const pendingCells = cells.filter(
    (cell) =>
      !done.has(
        legalGroundingCellKey({
          model: cell.model,
          effort,
          arm: cell.arm,
          checker_model: cell.checker,
          case_id: cell.item.id,
          rank_policy: cell.policy,
        }),
      ),
  );
  console.log(
    `cells: ${cells.length}` +
      (resume ? ` (${cells.length - pendingCells.length} already done)` : ""),
  );
  await runPool(pendingCells, concurrency, perModel, async (cell) => {
    const label =
      `${cell.model} | ${cell.arm}` +
      (cell.policy ? ` | ${cell.policy}` : "") +
      (cell.checker ? ` | checker=${cell.checker.split(":")[0]}` : "");
    console.log(`start | ${label} | ${cell.item.id}`);
    const row = await runCase(
      cell.item,
      cell.model,
      effort,
      cell.arm,
      timeoutMs,
      cell.checker,
      cell.policy,
    );
    rows.push(row);
    appendFileSync(output, `${JSON.stringify(row)}\n`, "utf8");
    console.log(
      `done  | ${label} | ${cell.item.id} | ` +
        `${row.status} ${(row.latency_ms / 1_000).toFixed(1)}s ` +
        `F1=${row.target_token_f1.toFixed(2)} ` +
        `${row.error ?? row.legal_evidence_receipt?.status ?? ""}`,
    );
  });
  printSummary(rows);
  console.log(`\nprivate receipts: ${output}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
