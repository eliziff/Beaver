import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { receiptPath } from "../experimentReceipts";

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
