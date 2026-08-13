import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

import { receiptPath } from "./receipt";

const dir = mkdtempSync(path.join(os.tmpdir(), "beaver-receipt-"));
const used = path.join(dir, "used.jsonl");
writeFileSync(used, "{}\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("refuses clobbering while allowing resume or an explicit new path", () => {
  expect(() => receiptPath(used, { argv: [] })).toThrow(/refusing to overwrite/u);
  expect(receiptPath(used, { argv: [], resume: true })).toBe(used);
  expect(receiptPath(used, { argv: ["--output", path.join(dir, "new.jsonl")] }))
    .toBe(path.join(dir, "new.jsonl"));
});
