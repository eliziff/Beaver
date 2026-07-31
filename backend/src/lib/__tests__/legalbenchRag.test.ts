import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  charPrecisionRecall,
  deriveMiniTests,
  deriveSplitTests,
  evaluateMiniRetrieval,
  miniDocumentPaths,
  normalizeCorpusText,
  reportScoreMap,
  sanitizeCorpusPath,
  upstreamBenchmarkSchema,
  validateMiniManifest,
  verifyAgainstManifest,
  type MiniManifest,
  type UpstreamTest,
} from "../legalbenchRag";
import { sha256Hex, validateRunTrace } from "../runTrace";

const test = (doc: string, tag: string): UpstreamTest => ({
  query: `query ${tag}`,
  snippets: [{ file_path: doc, span: [0, 5] }],
});

describe("deterministic mini derivation", () => {
  const tests = [
    test("b.txt", "b1"),
    test("a.txt", "a1"),
    test("c.txt", "c1"),
    test("b.txt", "b2"),
    test("a.txt", "a2"),
  ];

  it("groups by document, walks documents lexicographically, truncates at cap", () => {
    const mini = deriveMiniTests(tests, 3);
    expect(mini.map((t) => t.query)).toEqual([
      "query a1",
      "query a2",
      "query b1",
    ]);
    expect(miniDocumentPaths(mini)).toEqual(["a.txt", "b.txt"]);
  });

  // Stage 19: the hold-out continues the same walk. These pin the only
  // leakage property the hold-out actually establishes — document blocking.
  it("hold-out resumes after every document the mini walk touched", () => {
    // cap 3 truncates mid-b.txt, so b.txt belongs to mini alone.
    expect(deriveMiniTests(tests, 3).map((t) => t.query)).toEqual([
      "query a1",
      "query a2",
      "query b1",
    ]);
    const holdout = deriveSplitTests(tests, "holdout", 3);
    expect(holdout.map((t) => t.query)).toEqual(["query c1"]);
    expect(miniDocumentPaths(holdout)).toEqual(["c.txt"]);
  });

  it("hold-out shares no document with mini at any cap", () => {
    for (const cap of [1, 2, 3, 4, 5]) {
      const dev = new Set(miniDocumentPaths(deriveMiniTests(tests, cap)));
      for (const document of miniDocumentPaths(
        deriveSplitTests(tests, "holdout", cap),
      ))
        expect(dev.has(document)).toBe(false);
    }
  });

  it("hold-out is empty when mini exhausts the upstream benchmark", () => {
    expect(deriveSplitTests(tests, "holdout", 99)).toEqual([]);
  });

  it("is byte-identical across repeated derivations", () => {
    const first = JSON.stringify({ tests: deriveMiniTests(tests, 3) });
    const second = JSON.stringify({ tests: deriveMiniTests([...tests], 3) });
    expect(second).toBe(first);
  });

  it("keeps upstream test objects verbatim (extra keys survive)", () => {
    const upstream = upstreamBenchmarkSchema.parse({
      tests: [
        {
          query: "q",
          snippets: [{ file_path: "a.txt", span: [1, 2], answer: "x" }],
          tags: ["cuad"],
        },
      ],
    });
    expect(upstream.tests[0]).toMatchObject({ tags: ["cuad"] });
    expect(upstream.tests[0].snippets[0]).toMatchObject({ answer: "x" });
  });
});

describe("sanitizeCorpusPath", () => {
  it("replaces Windows-illegal characters and keeps directory structure", () => {
    expect(
      sanitizeCorpusPath("privacy_qa/TickTick: To Do List with Reminder.txt"),
    ).toBe("privacy_qa/TickTick_ To Do List with Reminder.txt");
    expect(sanitizeCorpusPath('m/a"b?c*d|e<f>g.txt')).toBe("m/a_b_c_d_e_f_g.txt");
    expect(sanitizeCorpusPath("cuad/plain-name~1.txt")).toBe(
      "cuad/plain-name~1.txt",
    );
  });
});

describe("charPrecisionRecall (upstream formulas)", () => {
  it("computes character overlap precision and recall", () => {
    const gold = [{ filePath: "a", start: 10, end: 30 }];
    const retrieved = [
      { filePath: "a", start: 0, end: 20 }, // 10 overlapping chars
      { filePath: "b", start: 0, end: 10 }, // wrong document
    ];
    const { precision, recall } = charPrecisionRecall(retrieved, gold);
    expect(precision).toBeCloseTo(10 / 30, 10);
    expect(recall).toBeCloseTo(10 / 20, 10);
  });

  it("returns zeros for empty retrieval", () => {
    expect(
      charPrecisionRecall([], [{ filePath: "a", start: 0, end: 5 }]),
    ).toEqual({ precision: 0, recall: 0 });
  });

  // Stage 18 defect D2: overlapping retrieved spans used to credit the
  // same gold characters once per span, so recall ran past 1.0.
  it("credits each gold character once across overlapping retrieved spans", () => {
    const gold = [{ filePath: "a", start: 0, end: 100 }];
    const retrieved = [
      { filePath: "a", start: 0, end: 100 },
      { filePath: "a", start: 0, end: 100 },
    ];
    const { precision, recall } = charPrecisionRecall(retrieved, gold);
    expect(recall).toBe(1);
    expect(precision).toBeCloseTo(100 / 200, 10);
  });

  it("union-merges partially overlapping credited spans", () => {
    const gold = [{ filePath: "a", start: 0, end: 100 }];
    const retrieved = [
      { filePath: "a", start: 0, end: 60 },
      { filePath: "a", start: 40, end: 100 },
      { filePath: "b", start: 0, end: 10 },
    ];
    const { precision, recall } = charPrecisionRecall(retrieved, gold);
    expect(recall).toBe(1); // 0..100 covered once, not 120/100
    expect(precision).toBeCloseTo(100 / 130, 10);
  });

  it("never exceeds 1.0 when gold spans themselves overlap", () => {
    const gold = [
      { filePath: "a", start: 0, end: 50 },
      { filePath: "a", start: 25, end: 75 },
    ];
    const { precision, recall } = charPrecisionRecall(
      [{ filePath: "a", start: 0, end: 75 }],
      gold,
    );
    expect(recall).toBeLessThanOrEqual(1);
    expect(precision).toBeLessThanOrEqual(1);
  });
});

describe("normalizeCorpusText", () => {
  it("converts CRLF to LF and keeps a leading BOM (gold counts it)", () => {
    expect(normalizeCorpusText("﻿a\r\nb\r\n")).toBe("﻿a\nb\n");
    expect(normalizeCorpusText("a\nb")).toBe("a\nb");
    expect(normalizeCorpusText("a\rb")).toBe("a\rb");
  });
});

function fixtureManifest(): {
  manifest: MiniManifest;
  files: { path: string; bytes: Buffer }[];
} {
  const benchmark = Buffer.from('{"tests":[]}\n');
  const corpus = Buffer.from("corpus text");
  const manifest = validateMiniManifest({
    schema_version: "1",
    name: "legalbench-rag-mini",
    upstream: {
      repository: "https://github.com/ZeroEntropy-AI/legalbenchrag",
      paper: "https://arxiv.org/abs/2408.10343",
      download_url: "https://example.test/archive.zip",
      download_zip_bytes_observed: 1,
      license: "MIT",
      license_note: "fixture",
    },
    derivation: { rule: "fixture", max_tests_per_source: 194 },
    benchmarks: [
      {
        source: "cuad",
        path: "mini/benchmarks/cuad.json",
        sha256: sha256Hex(benchmark),
        bytes: benchmark.length,
        tests: 1,
        documents: 1,
      },
    ],
    corpus: [
      {
        upstream_path: "cuad/a.txt",
        path: "mini/corpus/cuad/a.txt",
        sha256: sha256Hex(corpus),
        bytes: corpus.length,
      },
    ],
  });
  return {
    manifest,
    files: [
      { path: "mini/benchmarks/cuad.json", bytes: benchmark },
      { path: "mini/corpus/cuad/a.txt", bytes: corpus },
    ],
  };
}

describe("manifest pinning", () => {
  it("verifies byte-identical derivations", () => {
    const { manifest, files } = fixtureManifest();
    expect(verifyAgainstManifest(manifest, files)).toEqual([]);
  });

  it("fails on corrupted bytes, missing files, and unpinned files", () => {
    const { manifest, files } = fixtureManifest();
    const corrupted = [
      { path: files[0].path, bytes: Buffer.from('{"tests":[{}]}\n') },
      { path: "mini/corpus/cuad/extra.txt", bytes: Buffer.from("x") },
    ];
    const problems = verifyAgainstManifest(manifest, corrupted);
    expect(problems.some((p) => p.startsWith("hash mismatch"))).toBe(true);
    expect(problems).toContain("unpinned derived file: mini/corpus/cuad/extra.txt");
    expect(problems).toContain("pinned file missing: mini/corpus/cuad/a.txt");
  });

  it("rejects manifests with unknown keys", () => {
    const { manifest } = fixtureManifest();
    expect(() =>
      validateMiniManifest({ ...manifest, surprise: true }),
    ).toThrow();
  });
});

describe("evaluateMiniRetrieval", () => {
  const docA = "alpha bravo charlie delta echo foxtrot golf hotel india";
  const docB = "one two three four five six seven eight nine ten eleven";
  const corpusText = new Map([
    ["cuad/a.txt", docA],
    ["cuad/b.txt", docB],
  ]);
  // Gold: "charlie delta echo" inside docA.
  const gold = {
    filePath: "cuad/a.txt",
    start: docA.indexOf("charlie"),
    end: docA.indexOf("echo") + "echo".length,
  };
  const tests = [
    { source: "cuad" as const, query: "charlie delta", gold: [gold] },
  ];

  it("maps product snippets back to char spans and scores top-k prefixes", () => {
    const snippetA = docA.slice(6, 24); // "bravo charlie delt" — 18 chars
    const sizes: number[] = [];
    const report = evaluateMiniRetrieval({
      tests,
      corpusText,
      ks: [1, 2],
      search: (query, size) => {
        sizes.push(size);
        expect(query).toBe("charlie delta");
        return [
          { filePath: "cuad/b.txt", snippet: docB.slice(0, 10) }, // rank 0: wrong doc
          { filePath: "cuad/a.txt", snippet: snippetA }, // rank 1: right doc
        ];
      },
    });
    expect(sizes).toEqual([2]); // one search per query at max k
    expect(report.queries).toBe(1);
    expect(report.unmapped_snippets).toBe(0);

    const overlapChars = 24 - gold.start; // snippetA ∩ gold
    const [at1, at2] = report.overall;
    // k=1: only the wrong-document snippet.
    expect(at1).toMatchObject({ k: 1, precision: 0, recall: 0, doc_recall: 0 });
    expect(at1.retrieved_chars_mean).toBe(10);
    // k=2: wrong-doc 10 chars + right-doc 18 chars, overlap chars relevant.
    expect(at2.precision).toBeCloseTo(overlapChars / 28, 10);
    expect(at2.recall).toBeCloseTo(overlapChars / (gold.end - gold.start), 10);
    expect(at2.doc_recall).toBe(1);
    expect(at2.retrieved_chars_mean).toBe(28);
    expect(at2.retrieved_word_tokens_mean).toBeGreaterThan(0);
    expect(report.per_source.cuad[1].recall).toBeCloseTo(at2.recall, 10);
  });

  it("counts snippets that cannot be located and scores them as misses", () => {
    const report = evaluateMiniRetrieval({
      tests,
      corpusText,
      ks: [1],
      search: () => [
        { filePath: "cuad/a.txt", snippet: "NOT IN THE DOCUMENT" },
      ],
    });
    expect(report.unmapped_snippets).toBe(1);
    expect(report.overall[0]).toMatchObject({
      precision: 0,
      recall: 0,
      doc_recall: 1, // ranking found the right document even if unmapped
      retrieved_chars_mean: 0,
    });
  });

  it("produces a numeric score map that fits the run-trace contract", () => {
    const report = evaluateMiniRetrieval({
      tests,
      corpusText,
      ks: [1],
      search: () => [],
    });
    const trace = validateRunTrace({
      schema_version: "1",
      run_id: randomUUID(),
      task_id: "LEGALBENCH-RAG-MINI",
      arm: "beaver_baseline",
      started_at: new Date().toISOString(),
      git_commit: "a".repeat(40),
      dirty_worktree: false,
      provider: null,
      model: null,
      effort: null,
      context_strategy: null,
      cache_strategy: null,
      prompt_hash: null,
      source_manifest_hash: sha256Hex("manifest"),
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      cache_write_tokens: null,
      latency_ms: 12.5,
      estimated_cost: null,
      retrieved_source_ids: ["contractnli", "cuad", "maud", "privacy_qa"],
      artifact_paths: ["benchmarks/legalbench_rag/results/x/report.json"],
      artifact_hashes: [sha256Hex("{}")],
      fatal_errors: [],
      all_pass: null,
      score: reportScoreMap(report),
      scoring_version: report.scoring_version,
      manual_review_minutes: null,
    });
    expect(trace.score).toMatchObject({
      queries: 1,
      unmapped_snippets: 0,
      precision_at_1: 0,
      recall_at_1: 0,
      doc_recall_at_1: 0,
    });
  });
});
