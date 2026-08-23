/** Cold production-path guard for 37,000 US citation inputs. */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { citationsInTextNative as citationsInText } from "../../backend/src/lib/structureNative";

const count = 37_000;
const maxSeconds = 15;
const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(here, "results", "performance-production-latest.json");
const cases = [
  (index: number) => `Roe v Wade, 410 U.S. ${100 + index}.`,
  (index: number) => `See 410 U.S. at ${100 + index}.`,
  (index: number) => `Claim under 42 U.S.C. § ${1000 + index}.`,
  (index: number) => `Article at 123 Harv. L. Rev. ${100 + index}.`,
];

function checkpoint(payload: object): void {
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temporary, output);
}

const started = performance.now();
const interval = count / 10;
const failures: Array<{ index: number; input: string }> = [];
let payload = {};
for (let index = 0; index < count; index += 1) {
  const input = cases[index % cases.length](index);
  if (citationsInText(input).length === 0 && failures.length < 20) {
    failures.push({ index, input });
  }
  const completed = index + 1;
  if (completed % interval === 0 || completed === count) {
    const elapsedSeconds = (performance.now() - started) / 1000;
    payload = {
      format: "beaver.eyecite-us-production-performance.v1",
      completed,
      count,
      elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
      failures,
    };
    checkpoint(payload);
    console.log(`${completed.toLocaleString()}/${count.toLocaleString()}; ${elapsedSeconds.toFixed(3)}s`);
  }
}

const elapsedSeconds = (performance.now() - started) / 1000;
const passed = failures.length === 0 && elapsedSeconds <= maxSeconds;
payload = { ...payload, maxSeconds, passed };
checkpoint(payload);
console.log(JSON.stringify(payload, null, 2));
process.exitCode = passed ? 0 : 1;
