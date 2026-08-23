import fs from "node:fs";
import path from "node:path";
import { readLines, parse, pageTextOf, tolerantPattern, resultsDir } from "./gap-lib.mjs";

const rows = readLines(path.join(resultsDir, "scorecard.jsonl")).map(parse).filter(Boolean);
const seeds = new Map(readLines(path.join(resultsDir, "seeds.jsonl")).map(parse).filter(Boolean).map((s) => [s.label, s]));
const gateRows = new Map(readLines(path.join(resultsDir, "gate-final5.jsonl")).map(parse).filter(Boolean).map((r) => [r.label, r]));
const gap = rows.filter((r) => r.truth === "quote-present-unpainted");
const groupA = gap.filter((r) => r.signals.includes("cross-block-seam"));

for (const r of groupA.slice(0, 20)) {
  const seed = seeds.get(r.label);
  const quote = seed?.quotes?.[0] ?? "";
  const gate = gateRows.get(r.label);
  const page = pageTextOf(gate);
  if (!page || page.cacheMiss || page.isPdf) continue;
  const pat = tolerantPattern(quote);
  pat.lastIndex = 0;
  const m = pat.exec(page.blocked);
  console.log("=".repeat(110));
  console.log("LABEL:", r.label, "| host:", r.host);
  console.log("QUOTE:", JSON.stringify(quote));
  if (m) {
    const start = Math.max(0, m.index - 30);
    const end = Math.min(page.blocked.length, m.index + m[0].length + 80);
    const ctx = page.blocked.slice(start, end).replace(/[ \t]+/gu, " ").replace(/\u00A0/gu, "<NBSP>");
    console.log("BLOCKED-MATCH (\\n shown as ⏎):");
    console.log(JSON.stringify(ctx));
  } else {
    console.log("NO blocked match found");
  }
}
