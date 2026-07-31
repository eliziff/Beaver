import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  legacyPerDocCap,
  legalGroundingCellKey,
  legalbenchRagCellKey,
  receiptPath,
} from "../experimentReceipts";

const dir = mkdtempSync(path.join(os.tmpdir(), "receipt-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fresh = path.join(dir, "fresh.jsonl");
const pinned = path.join(dir, "stage18-retrieval-arms.jsonl");
writeFileSync(pinned, '{"arm":"chars"}\n', "utf8");

describe("receiptPath", () => {
  it("returns the default when nothing exists there", () => {
    expect(receiptPath(fresh, { argv: ["node", "harness"] })).toBe(fresh);
  });

  it("honours --output in every mode", () => {
    expect(
      receiptPath(pinned, { argv: ["node", "harness", "--output", fresh] }),
    ).toBe(fresh);
  });

  it("refuses to clobber an existing receipt", () => {
    expect(() => receiptPath(pinned, { argv: ["node", "harness"] })).toThrow(
      /refusing to overwrite an existing receipt/u,
    );
    // Also when the collision arrives through --output.
    expect(() =>
      receiptPath(fresh, { argv: ["node", "harness", "--output", pinned] }),
    ).toThrow(/refusing to overwrite/u);
  });

  it("allows --force and --resume", () => {
    expect(
      receiptPath(pinned, { argv: ["node", "harness", "--force"] }),
    ).toBe(pinned);
    // resume APPENDS and skips done cells; it never truncates.
    expect(receiptPath(pinned, { argv: ["node", "harness"], resume: true })).toBe(
      pinned,
    );
  });

  it("rejects --output without a path instead of silently defaulting", () => {
    expect(() => receiptPath(fresh, { argv: ["node", "harness", "--output"] }))
      .toThrow(/--output needs a path/u);
    expect(() =>
      receiptPath(fresh, { argv: ["node", "harness", "--output", "--force"] }),
    ).toThrow(/--output needs a path/u);
  });
});

describe("legalbenchRagCellKey", () => {
  const cell = {
    coords: "lf",
    model: "codex:gpt-5.6-sol",
    effort: "medium",
    arm: "required_slot",
    k: 6,
    retriever: "passage:t1600/o120/w16",
    per_doc_cap: 24,
    test_id: "maud:003",
  };

  it("separates every arm the prompt flags produce", () => {
    // --coverage, --spec, --plain and --exclude-gold each change the arm
    // label; before the fix they changed nothing the key could see, so a
    // resume would have read the other arm's rows as this arm's work.
    const keys = [
      "required_slot",
      "required_slot+coverage",
      "required_slot+spec",
      "required_slot+coverage+spec",
      "required_slot+nogold",
      "plain",
    ].map((arm) => legalbenchRagCellKey({ ...cell, arm }));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("separates every other dimension that changes a cell's meaning", () => {
    const variants = [
      cell,
      { ...cell, coords: undefined },
      { ...cell, model: "codex:gpt-5.6-luna" },
      { ...cell, effort: "low" },
      { ...cell, k: 4 },
      { ...cell, retriever: "passage:pool(67958d5292d2)" },
      { ...cell, per_doc_cap: 2 },
      { ...cell, per_doc_cap: null },
      { ...cell, test_id: "maud:004" },
    ];
    const keys = variants.map(legalbenchRagCellKey);
    expect(new Set(keys).size).toBe(variants.length);
  });

  it("keeps identical cells identical", () => {
    expect(legalbenchRagCellKey({ ...cell })).toBe(legalbenchRagCellKey(cell));
  });

  it("backfills pre-fix rows from what their labels prove they ran", () => {
    // The cap a pre-fix row ran at is fully determined by its retriever,
    // so old receipts stay resumable rather than being re-run wholesale.
    expect(legacyPerDocCap("product")).toBe("n/a");
    expect(legacyPerDocCap("passage:t1600/o120/w16")).toBe("2");
    expect(
      legacyPerDocCap("passage:t1600/o120/w16+rerank(codex:gpt-5.6-luna)@p1600"),
    ).toBe("24");
    expect(legacyPerDocCap("passage:pool(67958d5292d2)+stitch200")).toBe(
      "uncapped",
    );
    // A stage16/17 row (reranked, no per_doc_cap field) matches a new run
    // at the shipped default of 24 — same instrument, same cell.
    const legacy = {
      model: "codex:gpt-5.6-sol",
      effort: "medium",
      arm: "required_slot",
      k: 4,
      retriever: "passage:t1600/o120/w16+rerank(codex:gpt-5.6-luna)",
      test_id: "cuad:000",
    };
    expect(legalbenchRagCellKey({ ...legacy, coords: "lf" })).toBe(
      legalbenchRagCellKey({ ...legacy, coords: "lf", per_doc_cap: 24 }),
    );
    // ... and a raw-CRLF row never satisfies an LF cell.
    expect(legalbenchRagCellKey(legacy)).not.toBe(
      legalbenchRagCellKey({ ...legacy, coords: "lf" }),
    );
    // A pre-fix stage14 product row matches a new product row (cap null).
    const product = {
      model: "codex:gpt-5.6-luna",
      effort: "medium",
      arm: "required_slot",
      k: 4,
      test_id: "cuad:000",
    };
    expect(legalbenchRagCellKey(product)).toBe(
      legalbenchRagCellKey({ ...product, per_doc_cap: null }),
    );
  });
});

describe("legalGroundingCellKey", () => {
  const cell = {
    model: "codex:gpt-5.6-sol",
    effort: "low",
    arm: "required_slot",
    checker_model: null,
    case_id: "clerc:1234",
    rank_policy: "authority",
  };

  it("separates efforts, which the key used to ignore", () => {
    expect(legalGroundingCellKey({ ...cell, effort: "medium" })).not.toBe(
      legalGroundingCellKey(cell),
    );
  });

  it("separates every other dimension and keeps identical cells identical", () => {
    const variants = [
      cell,
      { ...cell, model: "claude-p:claude-sonnet-4-6" },
      { ...cell, arm: "control" },
      { ...cell, checker_model: "codex:gpt-5.6-luna" },
      { ...cell, case_id: "cslb:7" },
      { ...cell, rank_policy: "flat_recency" },
      { ...cell, rank_policy: null },
    ];
    expect(new Set(variants.map(legalGroundingCellKey)).size).toBe(
      variants.length,
    );
    expect(legalGroundingCellKey({ ...cell })).toBe(legalGroundingCellKey(cell));
    // A null checker is the same cell as the "same" default it stands for.
    expect(legalGroundingCellKey({ ...cell, checker_model: "same" })).toBe(
      legalGroundingCellKey(cell),
    );
  });
});
