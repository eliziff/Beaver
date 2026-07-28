import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The unit tests never touch the network: the model layer is mocked and the
// beaver arms use injected fake transport executors.
vi.mock("../llm", () => ({
  streamChatWithTools: vi.fn(),
  providerForModel: vi.fn(() => "openai"),
}));

import {
  beaverCanGoldSchema,
  beaverCanTaskSchema,
  loadBeaverCanTaskDir,
  type LoadedBeaverCanTask,
} from "../beaverCan";
import {
  beaverCanTaskDir,
  beaverTurnScript,
  estimateCostUsd,
  modelArmPrompt,
  runEval,
  scoreBeaverCanOutput,
  type ArmExecutor,
  type EvalComparisonReport,
} from "../evalRunner";
import { streamChatWithTools } from "../llm";
import { validateRunTrace, type RunTrace } from "../runTrace";

const MODEL = "gpt-5-mini";
const retrievalDir = beaverCanTaskDir("CAN-RETRIEVAL-001");
const contextDir = beaverCanTaskDir("CAN-CONTEXT-001");

const mockedStream = vi.mocked(streamChatWithTools);
const usage = {
  inputTokens: 1000,
  outputTokens: 200,
  reasoningTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: null,
};

let resultsRoot: string;
beforeEach(() => {
  resultsRoot = mkdtempSync(path.join(os.tmpdir(), "beaver-eval-run-"));
  mockedStream.mockReset();
  mockedStream.mockResolvedValue({
    fullText: "Rank 1: SRC-001 at s 231(5) governs the classification.",
    usage,
  });
});
afterEach(() => {
  rmSync(resultsRoot, { recursive: true, force: true });
});

function armTrace(runDir: string, arm: string): RunTrace {
  const armDir = path.join(runDir, arm);
  const traceFile = readdirSync(armDir).find(
    (name) => name.endsWith(".json") && name.startsWith("CAN-"),
  );
  expect(traceFile, `${arm} trace file`).toBeTruthy();
  return validateRunTrace(
    JSON.parse(readFileSync(path.join(armDir, traceFile as string), "utf8")),
  );
}

const readReport = (reportPath: string) =>
  JSON.parse(readFileSync(reportPath, "utf8")) as EvalComparisonReport;

describe("arm input assembly", () => {
  it("bare_model gets ONLY the task prompt; oracle_sources inlines the packet", () => {
    const loaded = loadBeaverCanTaskDir(retrievalDir);
    const bare = modelArmPrompt(loaded, "bare_model");
    expect(bare).toBe(loaded.prompt);
    expect(bare).not.toContain("SOURCE PACKET (full text)");

    const oracle = modelArmPrompt(loaded, "oracle_sources");
    expect(oracle.startsWith(loaded.prompt)).toBe(true);
    expect(oracle).toContain("SOURCE PACKET (full text)");
    for (const source of loaded.sources) {
      expect(oracle).toContain(`## ${source.source_id} — ${source.citation}`);
      expect(oracle).toContain(source.text.slice(0, 60));
    }
    // Scoring metadata never reaches the model.
    expect(oracle).not.toContain("distractor");
    expect(oracle).not.toContain("superseded_by");
  });

  it("scripts long-thread turns and uploads matter documents at first mention", () => {
    const turns = beaverTurnScript(loadBeaverCanTaskDir(contextDir));
    expect(turns.length).toBe(7);
    expect(turns[0].text).toContain("MEMORANDUM OF LAW");
    expect(turns[0].text).not.toContain("## TURN-01");
    expect(turns.map((turn) => turn.uploadSourceIds)).toEqual([
      [],
      ["SRC-002"],
      [],
      [],
      [],
      ["SRC-003"],
      [],
    ]);

    const single = beaverTurnScript(loadBeaverCanTaskDir(retrievalDir));
    expect(single.length).toBe(1);
    expect(single[0].uploadSourceIds).toEqual([]);
  });
});

describe("runEval isolation, traces, and report", () => {
  it("produces isolated outputs and a validated trace per arm", async () => {
    const { runDir, report } = await runEval({
      taskDir: retrievalDir,
      arms: ["bare_model", "oracle_sources"],
      model: MODEL,
      resultsRoot,
    });

    // Arm isolation: two independent model calls with different inputs.
    expect(mockedStream).toHaveBeenCalledTimes(2);
    const [bareCall, oracleCall] = mockedStream.mock.calls.map(
      (call) => call[0],
    );
    expect(bareCall.systemPrompt).toBe("");
    expect(bareCall.messages).toHaveLength(1);
    expect(bareCall.messages[0].content).not.toContain("SOURCE PACKET");
    expect(oracleCall.messages[0].content).toContain("SOURCE PACKET");

    for (const arm of ["bare_model", "oracle_sources"] as const) {
      const output = readFileSync(
        path.join(runDir, arm, "output.md"),
        "utf8",
      );
      expect(output).toContain("SRC-001");
      const trace = armTrace(runDir, arm);
      expect(trace.arm).toBe(arm);
      expect(trace.task_id).toBe("CAN-RETRIEVAL-001");
      expect(trace.provider).toBe("openai");
      expect(trace.model).toBe(MODEL);
      expect(trace.input_tokens).toBe(1000);
      expect(trace.output_tokens).toBe(200);
      expect(trace.estimated_cost).toBeCloseTo(0.00065, 10);
      expect(trace.git_commit).toMatch(/^[0-9a-f]{40}$/u);
    }
    const [bareTrace, oracleTrace] = [
      armTrace(runDir, "bare_model"),
      armTrace(runDir, "oracle_sources"),
    ];
    expect(bareTrace.prompt_hash).not.toBe(oracleTrace.prompt_hash);
    expect(bareTrace.retrieved_source_ids).toEqual([]);
    expect(oracleTrace.retrieved_source_ids).toHaveLength(7);
    expect(report.arms).toHaveLength(2);
  });

  it("writes a comparison report with all-pass, fatal, diagnostics, cost, latency", async () => {
    const { runDir, reportPath } = await runEval({
      taskDir: retrievalDir,
      arms: ["bare_model", "oracle_sources"],
      model: MODEL,
      resultsRoot,
    });
    const report = readReport(reportPath);
    expect(report.task_id).toBe("CAN-RETRIEVAL-001");
    expect(report.scoring_version).toBe("beaver-can-arm-scoring-1");
    for (const arm of report.arms) {
      expect(arm.criteria.packet_sources_only?.pass).toBe(true);
      // Unscored gold fields are explicit nulls, never faked.
      expect(arm.criteria.required_authorities).toBeNull();
      expect(arm.all_pass).toBeNull();
      expect(arm.fatal_errors.outside_source_packet).toBe(false);
      expect(arm.fatal_errors.fabricated_authority).toBeNull();
      expect(arm.diagnostics.estimated_cost_usd).toBeCloseTo(0.00065, 10);
      expect(arm.diagnostics.latency_ms).toBeGreaterThanOrEqual(0);
    }
    expect(report.totals.estimated_cost_usd).toBeCloseTo(0.0013, 10);
    expect(report.totals.cost_per_passing_task_usd).toBeNull();
    expect(report.baseline).toBeNull();

    const markdown = readFileSync(path.join(runDir, "comparison.md"), "utf8");
    expect(markdown).toContain("| bare_model |");
    expect(markdown).toContain("| oracle_sources |");
    expect(markdown).toContain("no deterministic validator");
  });

  it("freezes baseline commit/config metadata and flags candidate == current tree", async () => {
    const fakeTransport: ArmExecutor = async ({ loaded }) => ({
      outputText: "Memo relying on SRC-001.",
      provider: "openai",
      model: MODEL,
      usage: null,
      retrievedSourceIds: [],
      promptHashInput: loaded.prompt,
      receipts: { turns: [] },
    });
    const { runDir, reportPath } = await runEval({
      taskDir: retrievalDir,
      arms: ["beaver_baseline", "beaver_candidate"],
      model: MODEL,
      resultsRoot,
      executors: {
        beaver_baseline: fakeTransport,
        beaver_candidate: fakeTransport,
      },
    });
    expect(mockedStream).not.toHaveBeenCalled();
    const report = readReport(reportPath);
    expect(report.baseline?.git_commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(report.baseline?.config.model).toBe(MODEL);
    expect(report.baseline?.config.auth_mode).toBe("anonymous");
    expect(report.baseline?.candidate_config_delta).toBeNull();
    expect(report.notes.join(" ")).toContain(
      "no configuration delta was supplied",
    );
    for (const arm of ["beaver_baseline", "beaver_candidate"] as const) {
      const trace = armTrace(runDir, arm);
      expect(trace.input_tokens).toBeNull();
      expect(trace.estimated_cost).toBeNull();
      expect(trace.context_strategy).toBe("product_default_full_history");
      expect(
        JSON.parse(
          readFileSync(path.join(runDir, arm, "receipts.json"), "utf8"),
        ),
      ).toEqual({ turns: [] });
    }
  });

  it("refuses beaver arms without a supplied transport executor", async () => {
    await expect(
      runEval({
        taskDir: retrievalDir,
        arms: ["beaver_baseline"],
        model: MODEL,
        resultsRoot,
      }),
    ).rejects.toThrow(/no executor supplied/u);
  });

  it("surfaces a validator failure as a fatal error in report and trace", async () => {
    const outsidePacket: ArmExecutor = async ({ loaded }) => ({
      outputText: "The governing authority is SRC-099, supported by SRC-001.",
      provider: "openai",
      model: MODEL,
      usage: null,
      retrievedSourceIds: [],
      promptHashInput: loaded.prompt,
    });
    const { runDir, reportPath } = await runEval({
      taskDir: retrievalDir,
      arms: ["beaver_baseline"],
      model: MODEL,
      resultsRoot,
      executors: { beaver_baseline: outsidePacket },
    });
    const report = readReport(reportPath);
    const arm = report.arms[0];
    expect(arm.fatal_errors.outside_source_packet).toBe(true);
    expect(arm.fired_fatal_errors).toEqual(["outside_source_packet"]);
    expect(arm.all_pass).toBe(false);
    expect(arm.criteria.packet_sources_only?.evidence.outside_packet).toEqual([
      "SRC-099",
    ]);
    const trace = armTrace(runDir, "beaver_baseline");
    expect(trace.fatal_errors).toEqual(["outside_source_packet"]);
    expect(trace.all_pass).toBe(false);
  });

  it("flags a seeded-identifier leak and a lost required quotation on the long-thread task", async () => {
    const leaky: ArmExecutor = async ({ loaded }) => ({
      outputText:
        "MEMORANDUM OF LAW\n\nReserve estimate SEED-CAN-CONTEXT-001-RESERVE " +
        "per SRC-001 s 3(1).",
      provider: "openai",
      model: MODEL,
      usage: null,
      retrievedSourceIds: [],
      promptHashInput: loaded.prompt,
    });
    const { reportPath } = await runEval({
      taskDir: contextDir,
      arms: ["beaver_baseline"],
      model: MODEL,
      resultsRoot,
      executors: { beaver_baseline: leaky },
    });
    const arm = readReport(reportPath).arms[0];
    expect(arm.fatal_errors.seeded_identifier_leak).toBe(true);
    expect(arm.criteria.no_seeded_identifier_leak?.pass).toBe(false);
    expect(arm.criteria.required_quotations?.pass).toBe(false);
    expect(arm.all_pass).toBe(false);
    // Fatal names with no validator stay null even while others fire.
    expect(arm.fatal_errors.superseded_instruction).toBeNull();
  });
});

describe("scoring bindings", () => {
  const syntheticLoaded = (): LoadedBeaverCanTask => ({
    task: beaverCanTaskSchema.parse({
      id: "CAN-TEST-001",
      jurisdiction: "CA-ON",
      law_as_of: "2026-06-30",
      task_type: "closed_source_research",
      deliverable: { type: "memorandum", required_filename: "answer.docx" },
      source_ids: ["SRC-001"],
      fatal_errors: ["outside_source_packet"],
    }),
    gold: beaverCanGoldSchema.parse({
      required_issues: ["ISSUE-01"],
      required_authorities: [
        {
          source_id: "SRC-001",
          proposition_id: "PROP-01",
          acceptable_pinpoints: [1],
        },
      ],
      acceptable_alternative_authorities: [],
      required_conclusions: [{ id: "CONCLUSION-01", acceptable: ["yes"] }],
      forbidden_claims: [],
      required_headings: ["MEMORANDUM OF LAW"],
      definitions: {
        "ISSUE-01": "issue",
        "PROP-01": "proposition",
        "CONCLUSION-01": "conclusion",
      },
    }),
    prompt: "prompt",
    sources: [],
  });

  it("binds missingHeadings when gold defines required_headings", () => {
    const loaded = syntheticLoaded();
    const missing = scoreBeaverCanOutput(loaded, "No heading here. SRC-001.");
    expect(missing.criteria.required_headings?.pass).toBe(false);
    expect(missing.criteria.required_headings?.evidence.missing).toEqual([
      "MEMORANDUM OF LAW",
    ]);
    const present = scoreBeaverCanOutput(
      loaded,
      "# MEMORANDUM OF LAW\n\nAnalysis citing SRC-001.",
    );
    expect(present.criteria.required_headings?.pass).toBe(true);
    // Unscored gold fields keep all_pass null even when every binding passes.
    expect(present.all_pass).toBeNull();
  });

  it("finds a surviving required quotation via exact or normalized match", () => {
    const loaded = loadBeaverCanTaskDir(contextDir);
    const quote = loaded.gold.required_quotations?.[0]?.quote as string;
    const score = scoreBeaverCanOutput(
      loaded,
      `MEMORANDUM OF LAW\n\n"${quote}" (OLA s 3(1), SRC-001)`,
    );
    expect(score.criteria.required_quotations?.pass).toBe(true);
    expect(score.numeric.required_quotations_found).toBe(1);
    expect(score.fatal_errors.seeded_identifier_leak).toBe(false);
  });

  it("estimates cost only for known models with reported usage", () => {
    expect(estimateCostUsd(MODEL, usage)).toBeCloseTo(0.00065, 10);
    expect(
      estimateCostUsd(MODEL, { ...usage, cacheReadInputTokens: 400 }),
    ).toBeCloseTo((600 * 0.25 + 400 * 0.025 + 200 * 2) / 1e6, 10);
    expect(estimateCostUsd("unknown-model", usage)).toBeNull();
    expect(estimateCostUsd(MODEL, null)).toBeNull();
  });
});
