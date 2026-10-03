import assert from "node:assert/strict";
import test from "node:test";
import { pairedScore } from "./court-pdf-score.mjs";
const cells = rows => Object.fromEntries(["medium/cold", "medium/warm", "large/cold", "large/warm"].map(key => [key, rows]));
test("small consistent improvements are kept without a 15% floor", () => {
  const result = pairedScore(cells(Array(10).fill(0.999)));
  assert.equal(result.repeatablyBetter, true);
  assert.ok(Math.abs(result.normalizedRatio - 0.999) < 1e-12);
});
test("equality and losses are discarded", () => {
  assert.equal(pairedScore(cells(Array(10).fill(1))).repeatablyBetter, false);
  assert.equal(pairedScore(cells(Array(10).fill(1.01))).repeatablyBetter, false);
});
test("noise does not become an accepted improvement", () => {
  const result = pairedScore(cells([0.8, 0.81, 0.82, 0.83, 0.84, 1.1, 1.11, 1.12, 1.13, 1.14]));
  assert.equal(result.repeatablyBetter, false);
  assert.ok(result.upper95 > 1);
});
test("score uses all four cells with equal geometric weight", () => {
  const result = pairedScore({ ...cells(Array(10).fill(1)), "large/warm": Array(10).fill(0.8) });
  assert.ok(Math.abs(result.normalizedRatio - 0.8 ** 0.25) < 1e-12);
});
test("invalid or incomplete timing data fails closed", () => {
  assert.throws(() => pairedScore(cells([NaN])));
  assert.throws(() => pairedScore({ a: [1] }));
});
