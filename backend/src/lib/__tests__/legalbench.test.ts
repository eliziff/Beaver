import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEGALBENCH_TASKS,
  MANIFEST_PATH,
  SCORING_VERSION,
  dataFilePath,
  extractLabel,
  fetchTaskRows,
  fillPromptTemplate,
  legalBenchTask,
  normalizeLegalBench,
  promptFilePath,
  scoreTask,
  selectStratifiedRows,
  taskDataBytes,
  validateLegalBenchManifest,
  verifyAgainstManifest,
  verifyManifestMatchesRegistry,
  type LegalBenchManifest,
} from "../legalbench";
import { sha256Hex, validateRunTrace } from "../runTrace";

const YES_NO = ["Yes", "No"] as const;

describe("task registry", () => {
  it("holds nine tasks with defensible licenses and published baselines", () => {
    expect(LEGALBENCH_TASKS).toHaveLength(9);
    expect(new Set(LEGALBENCH_TASKS.map((task) => task.task)).size).toBe(9);
    for (const task of LEGALBENCH_TASKS) {
      expect(task.license).toBe("CC BY 4.0");
      expect(task.gpt4_balanced_accuracy).toBeGreaterThan(0);
      expect(task.gpt4_balanced_accuracy).toBeLessThanOrEqual(100);
      expect(task.gpt4_source).toContain("arXiv:2308.11462");
      expect(task.labels.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("resolves tasks by name and rejects unknown names", () => {
    expect(legalBenchTask("hearsay").labels).toEqual(["Yes", "No"]);
    expect(() => legalBenchTask("rule_qa")).toThrow(/unknown LegalBench task/);
  });
});

describe("committed manifest", () => {
  const manifest = validateLegalBenchManifest(
    JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
  );

  it("agrees with the registry and pins every derived file", () => {
    expect(verifyManifestMatchesRegistry(manifest)).toEqual([]);
    expect(manifest.scoring.version).toBe(SCORING_VERSION);
    expect(manifest.upstream.hf_dataset).toBe("nguha/legalbench");
    for (const task of manifest.tasks) {
      expect(task.prompt.path).toBe(promptFilePath(task.task));
      expect(task.data.path).toBe(dataFilePath(task.task));
      expect(task.test_rows).toBeGreaterThan(0);
    }
  });

  it("rejects manifests with unknown keys", () => {
    expect(() =>
      validateLegalBenchManifest({ ...manifest, surprise: true }),
    ).toThrow();
  });
});

describe("verifyAgainstManifest", () => {
  const bytes = taskDataBytes("hearsay", [{ index: 0, answer: "Yes" }]);
  const prompt = Buffer.from("Q: {{text}}\nA:");
  const manifest = {
    schema_version: "1",
    name: "legalbench",
    upstream: {
      repository: "https://github.com/HazyResearch/legalbench",
      prompts_commit: "b".repeat(40),
      hf_dataset: "nguha/legalbench",
      hf_rows_api: "https://datasets-server.huggingface.co/rows",
      paper: "https://arxiv.org/abs/2308.11462",
      license_note: "fixture",
    },
    scoring: { version: SCORING_VERSION, normalization: "fixture" },
    tasks: [
      {
        task: "hearsay",
        capability: "rule application (hearsay determination)",
        labels: ["Yes", "No"],
        license: "CC BY 4.0",
        gpt4_balanced_accuracy: 83.8,
        gpt4_source: "arXiv:2308.11462 Table 63",
        test_rows: 1,
        prompt: {
          path: "prompts/hearsay.base_prompt.txt",
          sha256: sha256Hex(prompt),
          bytes: prompt.length,
        },
        data: {
          path: "tasks/hearsay.json",
          sha256: sha256Hex(bytes),
          bytes: bytes.length,
        },
      },
    ],
  } satisfies LegalBenchManifest;

  it("verifies byte-identical files", () => {
    expect(
      verifyAgainstManifest(manifest, [
        { path: "prompts/hearsay.base_prompt.txt", bytes: prompt },
        { path: "tasks/hearsay.json", bytes },
      ]),
    ).toEqual([]);
  });

  it("aggregates corrupted, missing, and unpinned files into one problem list", () => {
    const problems = verifyAgainstManifest(manifest, [
      { path: "tasks/hearsay.json", bytes: Buffer.from("tampered") },
      { path: "tasks/extra.json", bytes: Buffer.from("x") },
    ]);
    expect(problems.some((p) => p.startsWith("hash mismatch"))).toBe(true);
    expect(problems).toContain("unpinned derived file: tasks/extra.json");
    expect(problems).toContain(
      "pinned file missing: prompts/hearsay.base_prompt.txt",
    );
  });
});

describe("normalizeLegalBench (port of evaluation.py normalize)", () => {
  // Reference behavior: https://github.com/HazyResearch/legalbench
  // evaluation.py normalize(text, stem=False) — remove Python
  // string.punctuation, strip, lowercase, in that order.
  it("removes punctuation, strips, and lowercases", () => {
    expect(normalizeLegalBench("Answer: Yes.")).toBe("answer yes");
    expect(normalizeLegalBench("  Common Law  ")).toBe("common law");
    expect(normalizeLegalBench("(A)")).toBe("a");
    expect(normalizeLegalBench("YES!")).toBe("yes");
  });

  it("removes punctuation without inserting spaces, exactly like Python", () => {
    // str.translate deletes characters in-place: "Common-Law" -> "CommonLaw".
    expect(normalizeLegalBench("Common-Law.")).toBe("commonlaw");
  });
});

describe("extractLabel", () => {
  it("accepts a bare label in any casing or punctuation", () => {
    expect(extractLabel("Yes", YES_NO)).toBe("Yes");
    expect(extractLabel("no.", YES_NO)).toBe("No");
    expect(extractLabel(" YES! ", YES_NO)).toBe("Yes");
  });

  it('scores "Answer: Yes." against gold "Yes"', () => {
    expect(extractLabel("Answer: Yes.", YES_NO)).toBe("Yes");
  });

  it("reads the label after the last answer cue used by the base prompts", () => {
    expect(extractLabel("A: No", YES_NO)).toBe("No");
    expect(extractLabel("Label: Yes", YES_NO)).toBe("Yes");
    expect(extractLabel("FINAL ANSWER: YES", YES_NO)).toBe("Yes");
    expect(
      extractLabel("Governed by: Common Law.", ["UCC", "Common Law"]),
    ).toBe("Common Law");
    expect(
      extractLabel(
        "The statement is offered for its truth.\n\nAnswer: Yes\nBecause it is an out-of-court statement.",
        YES_NO,
      ),
    ).toBe("Yes");
  });

  it("honours an unambiguous bolded verdict inside a verbose analysis", () => {
    expect(
      extractLabel(
        "I'll verify whether Huff supports that proposition.Supportive? **Yes.**\nThere is no conflicting authority.",
        YES_NO,
      ),
    ).toBe("Yes");
    // Two different bolded labels stay ambiguous.
    expect(
      extractLabel("**Yes** at first glance, but ultimately **No**.", YES_NO),
    ).toBeNull();
  });

  it("falls back to a unique whole-word label match", () => {
    expect(extractLabel("The answer is Yes", YES_NO)).toBe("Yes");
    expect(
      extractLabel("I believe the mark is suggestive here", [
        "generic",
        "descriptive",
        "suggestive",
        "arbitrary",
        "fanciful",
      ]),
    ).toBe("suggestive");
    expect(extractLabel("Option B", ["A", "B"])).toBe("B");
  });

  it("returns null on ties and format mismatches instead of guessing", () => {
    expect(extractLabel("Yes and No are both plausible", YES_NO)).toBeNull();
    expect(extractLabel("Maybe", YES_NO)).toBeNull();
    expect(extractLabel("a is stronger than b", ["A", "B"])).toBeNull();
    expect(extractLabel("", YES_NO)).toBeNull();
  });

  it("does not let a whole-word match shadow substrings", () => {
    // "no" must not match inside "not"; with no unambiguous label -> null.
    expect(extractLabel("It is not certain", YES_NO)).toBeNull();
  });
});

describe("scoreTask", () => {
  const hearsay = legalBenchTask("hearsay");

  it("computes exact-match accuracy and sklearn-style balanced accuracy", () => {
    const score = scoreTask(hearsay, [
      { index: 0, gold: "Yes", generation: "Answer: Yes." },
      { index: 1, gold: "Yes", generation: "No" },
      { index: 2, gold: "No", generation: "No" },
      { index: 3, gold: "No", generation: "complete garbage" },
    ]);
    expect(score.scoring_version).toBe(SCORING_VERSION);
    expect(score.n).toBe(4);
    expect(score.correct).toBe(2);
    expect(score.accuracy).toBeCloseTo(0.5, 10);
    // recalls: Yes 1/2, No 1/2 -> balanced 0.5
    expect(score.balanced_accuracy).toBeCloseTo(0.5, 10);
    expect(score.unparsed).toBe(1);
    expect(score.per_label).toEqual({
      yes: { gold: 2, correct: 1 },
      no: { gold: 2, correct: 1 },
    });
    expect(score.examples[3]).toMatchObject({ extracted: null, correct: false });
  });

  it("weights classes equally regardless of class imbalance", () => {
    const score = scoreTask(hearsay, [
      { index: 0, gold: "Yes", generation: "Yes" },
      { index: 1, gold: "Yes", generation: "Yes" },
      { index: 2, gold: "Yes", generation: "Yes" },
      { index: 3, gold: "No", generation: "Yes" },
    ]);
    expect(score.accuracy).toBeCloseTo(0.75, 10);
    expect(score.balanced_accuracy).toBeCloseTo(0.5, 10);
  });

  it("returns zeros for an empty run", () => {
    const score = scoreTask(hearsay, []);
    expect(score).toMatchObject({
      n: 0,
      accuracy: 0,
      balanced_accuracy: 0,
      unparsed: 0,
    });
  });
});

describe("selectStratifiedRows", () => {
  const row = (index: number, answer: string) => ({ index, answer });

  it("returns the full split when limit is 0 or covers everything", () => {
    const rows = [row(0, "Yes"), row(1, "No")];
    expect(selectStratifiedRows(rows, 0)).toBe(rows);
    expect(selectStratifiedRows(rows, 2)).toBe(rows);
  });

  it("takes the earliest rows per gold class, preserving official order", () => {
    const rows = [
      row(0, "Yes"),
      row(1, "Yes"),
      row(2, "Yes"),
      row(3, "Yes"),
      row(4, "No"),
      row(5, "No"),
    ];
    expect(selectStratifiedRows(rows, 4).map((r) => r.index)).toEqual([
      0, 1, 4, 5,
    ]);
  });

  it("fills a class shortfall with the earliest unselected rows", () => {
    const rows = [
      row(0, "Yes"),
      row(1, "Yes"),
      row(2, "Yes"),
      row(3, "Yes"),
      row(4, "No"),
    ];
    expect(selectStratifiedRows(rows, 4).map((r) => r.index)).toEqual([
      0, 1, 2, 4,
    ]);
  });

  it("is deterministic across calls", () => {
    const rows = [row(0, "Yes"), row(1, "No"), row(2, "Yes"), row(3, "No")];
    expect(selectStratifiedRows(rows, 3)).toEqual(
      selectStratifiedRows([...rows], 3),
    );
  });
});

describe("fillPromptTemplate (port of utils.py generate_prompts)", () => {
  it("fills every occurrence of every field", () => {
    expect(
      fillPromptTemplate("Q: {{text}} / again {{text}} ({{n}})", {
        text: "hi",
        n: 2,
      }),
    ).toBe("Q: hi / again hi (2)");
  });

  it("throws on unfilled fields and field-free templates", () => {
    expect(() => fillPromptTemplate("Q: {{missing}}", { text: "x" })).toThrow(
      /unfilled prompt field/,
    );
    expect(() => fillPromptTemplate("no fields", {})).toThrow(
      /no fields to fill/,
    );
  });
});

describe("fixture end-to-end scoring (captured official prompts + test rows)", () => {
  type Fixture = {
    task: string;
    prompt_template: string;
    rows: { index: number; answer: string; text: string }[];
  };
  const fixture = (name: string): Fixture =>
    JSON.parse(
      readFileSync(
        path.join(__dirname, "fixtures", "legalbench", `${name}-mini.json`),
        "utf8",
      ),
    );

  it("scores an abercrombie sample with mixed answer formats", () => {
    const { task, prompt_template, rows } = fixture("abercrombie");
    // One row per class: generic, descriptive, suggestive, arbitrary, fanciful.
    expect(rows.map((row) => row.answer)).toEqual(
      legalBenchTask(task).labels.slice(),
    );
    const prompts = rows.map((row) => fillPromptTemplate(prompt_template, row));
    expect(prompts[0]).toContain(rows[0].text);
    expect(prompts[0].endsWith("What is the type of mark?\nA:")).toBe(true);
    const generations = [
      "generic",
      "Answer: descriptive.",
      "A: suggestive",
      "The mark is arbitrary because it is unrelated to the product.",
      "no idea",
    ];
    const score = scoreTask(
      legalBenchTask(task),
      rows.map((row, index) => ({
        index: row.index,
        gold: row.answer,
        generation: generations[index],
      })),
    );
    expect(score.correct).toBe(4);
    expect(score.accuracy).toBeCloseTo(0.8, 10);
    expect(score.balanced_accuracy).toBeCloseTo(0.8, 10);
    expect(score.unparsed).toBe(1);
  });

  it("scores a cuad_anti-assignment sample including a tie", () => {
    const { task, prompt_template, rows } = fixture("cuad_anti-assignment");
    expect(rows.map((row) => row.answer)).toEqual([
      "Yes",
      "Yes",
      "Yes",
      "No",
      "No",
      "No",
    ]);
    const prompts = rows.map((row) => fillPromptTemplate(prompt_template, row));
    expect(prompts[3].endsWith("Label:")).toBe(true);
    const generations = ["Yes", "Label: Yes", "No", "No", "no.", "Yes or No"];
    const score = scoreTask(
      legalBenchTask(task),
      rows.map((row, index) => ({
        index: row.index,
        gold: row.answer,
        generation: generations[index],
      })),
    );
    expect(score.correct).toBe(4);
    expect(score.accuracy).toBeCloseTo(4 / 6, 10);
    expect(score.balanced_accuracy).toBeCloseTo(2 / 3, 10);
    expect(score.unparsed).toBe(1);
  });
});

describe("fetchTaskRows", () => {
  const page = (total: number, offset: number, length: number) => ({
    ok: true,
    json: async () => ({
      num_rows_total: total,
      rows: Array.from({ length: Math.min(length, total - offset) }, (_, i) => ({
        row: { index: offset + i, answer: "Yes" },
      })),
    }),
  });

  it("pages through the datasets-server rows API in order", async () => {
    const urls: string[] = [];
    const rows = await fetchTaskRows("hearsay", (async (url: string) => {
      urls.push(url);
      const offset = Number(new URL(url).searchParams.get("offset"));
      return page(150, offset, 100);
    }) as unknown as typeof fetch);
    expect(rows).toHaveLength(150);
    expect(rows[149]).toEqual({ index: 149, answer: "Yes" });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("dataset=nguha%2Flegalbench");
    expect(urls[0]).toContain("config=hearsay");
    expect(urls[0]).toContain("split=test");
  });

  it("fails loudly on HTTP errors", async () => {
    await expect(
      fetchTaskRows("hearsay", (async () => ({
        ok: false,
        status: 500,
      })) as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("run-trace contract", () => {
  it("accepts the numeric score map the runner writes", () => {
    const trace = validateRunTrace({
      schema_version: "1",
      run_id: randomUUID(),
      task_id: "LEGALBENCH-hearsay",
      arm: "bare_model",
      started_at: new Date().toISOString(),
      git_commit: "a".repeat(40),
      dirty_worktree: false,
      provider: "openai",
      model: "gpt-5-mini",
      effort: null,
      context_strategy: "official_base_prompt",
      cache_strategy: "none",
      prompt_hash: sha256Hex("template"),
      source_manifest_hash: sha256Hex("manifest"),
      input_tokens: 100,
      output_tokens: 10,
      cached_input_tokens: null,
      cache_write_tokens: null,
      latency_ms: 5,
      estimated_cost: 0.0001,
      retrieved_source_ids: [],
      artifact_paths: ["benchmarks/legalbench/results/x/generations.jsonl"],
      artifact_hashes: [sha256Hex("{}")],
      fatal_errors: [],
      all_pass: null,
      score: {
        n: 25,
        correct: 20,
        accuracy: 0.8,
        balanced_accuracy: 0.79,
        unparsed: 0,
        gpt4_balanced_accuracy: 83.8,
      },
      scoring_version: SCORING_VERSION,
      manual_review_minutes: null,
    });
    expect(trace.task_id).toBe("LEGALBENCH-hearsay");
  });
});
