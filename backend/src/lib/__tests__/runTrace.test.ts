import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitRunState,
  sha256Hex,
  validateRunTrace,
  writeRunTrace,
  type RunTrace,
} from "../runTrace";

/** Stand-in for privileged matter text that must never reach a trace file. */
const CLIENT_TEXT = "Privileged: the agreement was signed on 2024-03-01.";

function validTrace(): RunTrace {
  return {
    schema_version: "1",
    run_id: "5f0f0f5e-9b1a-4c1d-8e2f-3a4b5c6d7e8f",
    task_id: "bench-pinpoint",
    arm: "beaver_candidate",
    started_at: "2026-07-27T12:00:00.000Z",
    git_commit: "deadbeef".repeat(5),
    dirty_worktree: true,
    provider: null,
    model: null,
    effort: null,
    context_strategy: null,
    cache_strategy: null,
    prompt_hash: null,
    source_manifest_hash: sha256Hex(CLIENT_TEXT),
    input_tokens: null,
    output_tokens: null,
    cached_input_tokens: null,
    cache_write_tokens: null,
    latency_ms: 1234.5,
    estimated_cost: null,
    retrieved_source_ids: [],
    artifact_paths: ["benchmarks/sourcedoc/bench-pinpoint-current.json"],
    artifact_hashes: [sha256Hex("artifact")],
    fatal_errors: [],
    all_pass: null,
    score: { "A1 buildDirective/case-41kb": 0.021 },
    scoring_version: "bench-pinpoint-median-ms-per-unit/1",
    manual_review_minutes: null,
  };
}

describe("runTraceSchema", () => {
  it("accepts a valid record with explicit nulls for unavailable fields", () => {
    expect(validateRunTrace(validTrace())).toEqual(validTrace());
  });

  it("accepts a fully populated model-run record", () => {
    expect(() =>
      validateRunTrace({
        ...validTrace(),
        task_id: "CAN-RESEARCH-001",
        arm: "bare_model",
        provider: "openai",
        model: "gpt-5.2",
        effort: "high",
        context_strategy: "legal_state",
        cache_strategy: "local_and_provider",
        prompt_hash: sha256Hex("prompt"),
        input_tokens: 12000,
        output_tokens: 900,
        cached_input_tokens: 8000,
        cache_write_tokens: 4000,
        estimated_cost: 0.42,
        retrieved_source_ids: ["SRC-001"],
        all_pass: false,
        fatal_errors: ["fabricated_authority"],
        manual_review_minutes: 12,
      }),
    ).not.toThrow();
  });

  it("rejects a record missing a required field", () => {
    const { git_commit: _omitted, ...rest } = validTrace();
    expect(() => validateRunTrace(rest)).toThrow(/git_commit/);
  });

  for (const [field, value] of [
    ["schema_version", "2"],
    ["run_id", "not-a-uuid"],
    ["task_id", ""],
    ["arm", "production"],
    ["started_at", "yesterday"],
    ["git_commit", "abc123"],
    ["prompt_hash", "UPPERCASE-not-a-hash"],
    ["source_manifest_hash", sha256Hex("x").slice(0, 63)],
    ["input_tokens", 1.5],
    ["output_tokens", -1],
    ["latency_ms", "fast"],
    ["estimated_cost", -0.01],
    ["artifact_hashes", ["not-a-hash"]],
    ["all_pass", "yes"],
    ["score", { case: "fast" }],
    ["manual_review_minutes", -5],
  ] as const) {
    it(`rejects malformed ${field}`, () => {
      expect(() =>
        validateRunTrace({ ...validTrace(), [field]: value }),
      ).toThrow();
    });
  }

  it("rejects unknown keys so prompt/client text cannot ride along", () => {
    expect(() =>
      validateRunTrace({ ...validTrace(), prompt_text: CLIENT_TEXT }),
    ).toThrow(/prompt_text/);
    expect(() =>
      validateRunTrace({ ...validTrace(), retrieved_passages: [CLIENT_TEXT] }),
    ).toThrow(/retrieved_passages/);
  });
});

describe("writeRunTrace", () => {
  const directories: string[] = [];
  const tempDirectory = () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "run-trace-"));
    directories.push(directory);
    return directory;
  };
  afterEach(() => {
    while (directories.length) {
      rmSync(directories.pop()!, { recursive: true, force: true });
    }
  });

  it("writes a record that re-validates, holding hashes but never content", () => {
    const directory = tempDirectory();
    const file = writeRunTrace(validTrace(), directory);
    const written = readFileSync(file, "utf8");
    expect(validateRunTrace(JSON.parse(written))).toEqual(validTrace());
    // The trace refers to client material only through its hash.
    expect(written).not.toContain(CLIENT_TEXT);
    expect(written).toContain(sha256Hex(CLIENT_TEXT));
  });

  it("throws on a malformed record and writes nothing", () => {
    const directory = tempDirectory();
    expect(() =>
      writeRunTrace({ ...validTrace(), latency_ms: "fast" }, directory),
    ).toThrow();
    expect(readdirSync(directory)).toEqual([]);
  });
});

describe("gitRunState", () => {
  it("reports a full commit sha and a dirty flag", () => {
    const state = gitRunState();
    expect(state.git_commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(typeof state.dirty_worktree).toBe("boolean");
  });
});

describe("sha256Hex", () => {
  it("matches the known empty-input digest", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
