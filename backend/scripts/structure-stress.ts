/**
 * Hardcase stress harness: how much structure and anchor signal survives
 * typos, OCR-class character confusions, whitespace damage, and misplaced
 * blocks? Fully deterministic (seeded PRNG), zero model calls.
 *
 * Usage:
 *   npx tsx scripts/structure-stress.ts <file.docx|.txt> [seed]
 *
 * Metrics per corruption level, all against the CLEAN parse of the same
 * document (self-relative, so no external gold is needed):
 *   - skeleton label recall (structure salvage)
 *   - distinct anchor-norm recall (anchor salvage)
 *   - ladder diagnostics (violations/restarts should light up under
 *     block misplacement — that is the disorder signal working)
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { extractDocxBodyText } from "../src/lib/docxTrackedChanges";
import { extractAnchors } from "../src/lib/legalTextAnchors";
import { compileAgreementSkeleton } from "../src/lib/legalTextSkeleton";

// mulberry32: tiny seeded PRNG, stable across runs/platforms.
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** OCR-class confusions observed across scanned legal corpora. */
const CONFUSIONS: Array<[string, string]> = [
  ["l", "1"], ["1", "l"], ["I", "l"], ["O", "0"], ["0", "O"],
  ["S", "5"], ["5", "S"], ["B", "8"], ["rn", "m"], ["m", "rn"],
  ["§", "S"], [".", ","], [",", "."], ["e", "c"], ["c", "e"],
];

function corrupt(text: string, rate: number, random: () => number): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (random() < rate) {
      const two = text.slice(i, i + 2);
      const candidates = CONFUSIONS.filter(
        ([from]) => from === ch || from === two,
      );
      const roll = random();
      if (candidates.length && roll < 0.6) {
        const [from, to] = candidates[Math.floor(random() * candidates.length)];
        out.push(to);
        i += from.length;
        continue;
      }
      if (roll < 0.75) {
        i += 1; // dropped character
        continue;
      }
      if (roll < 0.9) {
        out.push(ch, ch); // duplicated character
        i += 1;
        continue;
      }
      // whitespace damage: join lines or split words
      if (ch === "\n") out.push(" ");
      else out.push(ch, "\n");
      i += 1;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

/** Misplaced stuff: swap `swaps` random 3-line blocks (collation errors). */
function misplaceBlocks(
  text: string,
  swaps: number,
  random: () => number,
): string {
  const lines = text.split("\n");
  if (lines.length < 12) return text;
  for (let s = 0; s < swaps; s += 1) {
    const a = 1 + Math.floor(random() * (lines.length - 8));
    const b = 1 + Math.floor(random() * (lines.length - 8));
    if (Math.abs(a - b) < 3) continue;
    const blockA = lines.slice(a, a + 3);
    const blockB = lines.slice(b, b + 3);
    lines.splice(a, 3, ...blockB);
    lines.splice(b, 3, ...blockA);
  }
  return lines.join("\n");
}

function labelSet(text: string) {
  const skeleton = compileAgreementSkeleton(text);
  return {
    labels: new Set(skeleton.nodes.map((node) => node.label)),
    ladder: skeleton.ladder,
  };
}

const anchorSet = (text: string) =>
  new Set(extractAnchors(text).map((hit) => hit.norm));

function recall(clean: Set<string>, dirty: Set<string>): number {
  if (!clean.size) return 1;
  let hits = 0;
  for (const item of clean) if (dirty.has(item)) hits += 1;
  return hits / clean.size;
}

async function main() {
  const [path, seedArg] = process.argv.slice(2);
  if (!path) {
    console.error("Usage: structure-stress.ts <file.docx|.txt> [seed]");
    process.exit(2);
  }
  const seed = Number(seedArg ?? 20260728);
  const bytes = readFileSync(path);
  const text =
    extname(path).toLowerCase() === ".docx"
      ? ((await extractDocxBodyText(bytes)) ?? "")
      : bytes.toString("utf-8");

  const clean = labelSet(text);
  const cleanAnchors = anchorSet(text);
  console.log(
    `clean: ${text.length} chars, ${clean.labels.size} structural labels, ` +
      `${cleanAnchors.size} distinct anchors (seed ${seed})`,
  );
  console.log(
    "\ncorruption  label-recall  anchor-recall  violations  restarts",
  );
  for (const rate of [0.002, 0.005, 0.01, 0.02, 0.05]) {
    const dirty = corrupt(text, rate, prng(seed));
    const dirtyLabels = labelSet(dirty);
    const dirtyAnchors = anchorSet(dirty);
    console.log(
      `${(rate * 100).toFixed(1).padStart(9)}%  ` +
        `${(100 * recall(clean.labels, dirtyLabels.labels)).toFixed(1).padStart(11)}%  ` +
        `${(100 * recall(cleanAnchors, dirtyAnchors)).toFixed(1).padStart(12)}%  ` +
        `${String(dirtyLabels.ladder.violations).padStart(10)}  ` +
        `${String(dirtyLabels.ladder.restarts).padStart(8)}`,
    );
  }

  const misplaced = misplaceBlocks(text, 8, prng(seed + 1));
  const misplacedLabels = labelSet(misplaced);
  console.log(
    `\nmisplaced (8 block swaps): label-recall ` +
      `${(100 * recall(clean.labels, misplacedLabels.labels)).toFixed(1)}%, ` +
      `violations ${misplacedLabels.ladder.violations} ` +
      `(clean had ${clean.ladder.violations}), ` +
      `restarts ${misplacedLabels.ladder.restarts} ` +
      `(clean had ${clean.ladder.restarts}) — disorder should be visible here`,
  );

  const worst = misplaceBlocks(
    corrupt(text, 0.02, prng(seed + 2)),
    8,
    prng(seed + 3),
  );
  const worstLabels = labelSet(worst);
  const worstAnchors = anchorSet(worst);
  console.log(
    `worst case (2% + swaps): label-recall ` +
      `${(100 * recall(clean.labels, worstLabels.labels)).toFixed(1)}%, ` +
      `anchor-recall ${(100 * recall(cleanAnchors, worstAnchors)).toFixed(1)}%`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
