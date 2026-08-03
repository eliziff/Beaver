/**
 * Generalization scan for the H1 derived-value omission organ.
 *
 * Anti-overfit validation (repo doctrine, CLAUDE.md): the detector must
 * generalize to a *kind of legal task*, not to the change-of-control task it
 * was first measured on. This script asks, over the whole vendored LAB corpus:
 *
 *   Phase 1 — source-side pattern presence: does the source stack of OTHER
 *   tasks (tax, banking, indenture, antitrust, healthcare, …) state closed
 *   percent-of-base identities at all? If the pattern is CoC-only, the organ
 *   is a benchmark artifact; if it recurs across families, it is a legal-kind
 *   mechanism. This phase reuses the closure logic of the probe (identity
 *   closure, never proximity) and does NOT engage a draft.
 *
 *   Phase 2 — engagement behavior: for each task that has a run draft in
 *   results/, call the PRODUCTION `derivedValueScan(sources, draft)` exactly
 *   as the audit organ would, and print every finding. Each firing is then
 *   judged by hand against the task's gold criteria (task.json) for true
 *   omission vs false positive.
 *
 * Run: npx tsx scripts/dv-generalization-scan.ts (from backend/)
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadZip } from "../src/lib/zip";
import { extractAnchors } from "../src/lib/legalTextAnchors";
import {
  derivedValueScan,
  type DerivedValueDocument,
} from "../src/lib/legalDerivedValueScan";

const REPO = "C:/Users/elias/Desktop/MikeOSS Fork";
const LAB = path.join(REPO, "benchmarks/harvey-labs");
const TASKS = path.join(LAB, "tasks");
const RESULTS = path.join(LAB, "results");

const VALUE_TOL = 0.02;
const PCT_TOL = 0.55;
const OF_REACH = 16;
const PART_REACH = 220;
const THRESHOLD_RE =
  /\b(?:more than|less than|at least|not less than|at most|no more than|exceeding|equal to|up to|at or above|at or below|in excess of)\b/iu;
const BASE_RE =
  /\b(?:revenue|sales|income|earnings|ebitda?|value|net worth|assets?|capital|equity|interest|shares?|fees?|cost|price|expenses?|revenue share)\b/iu;
const BASE_NORM_RE = /\b(?:total|annual|net|gross|adjusted|consolidated|fiscal|202[0-9]|the|company['’]?s|its)\b/giu;

interface MoneyAnchor {
  value: number;
  raw: string;
  index: number;
  end: number;
}
interface PctAnchor {
  value: number;
  raw: string;
  index: number;
  end: number;
}

const moneyAnchors = (text: string): MoneyAnchor[] => {
  const out: MoneyAnchor[] = [];
  for (const hit of extractAnchors(text)) {
    if (hit.cls !== "money") continue;
    const [, , value] = hit.norm.split(":");
    const v = Number(value);
    if (Number.isFinite(v)) {
      out.push({ value: v, raw: hit.raw, index: hit.index, end: hit.index + hit.raw.length });
    }
  }
  return out;
};

const pctAnchors = (text: string): PctAnchor[] => {
  const out: PctAnchor[] = [];
  for (const hit of extractAnchors(text)) {
    if (hit.cls !== "percent") continue;
    const [, value] = hit.norm.split(":");
    const v = Number(value);
    if (Number.isFinite(v)) {
      out.push({ value: v, raw: hit.raw, index: hit.index, end: hit.index + hit.raw.length });
    }
  }
  return out;
};

function ofBase(text: string, pct: PctAnchor): string | null {
  const lead = text.slice(pct.end, pct.end + OF_REACH);
  const of = /\bof\b/iu.exec(lead);
  if (!of) return null;
  const rest = text.slice(pct.end + of.index + of[0].length, pct.end + OF_REACH + 80);
  const base = BASE_RE.exec(rest);
  if (!base) return null;
  return (base[0].toLowerCase().replace(BASE_NORM_RE, "").trim() || base[0]).toLowerCase();
}

/**
 * Source-side only: count percent-of-base claims and closed identities
 * (part/whole closes within precision, whole labeled with the base noun).
 * Mirrors the production organ's source loop; used only to measure where the
 * pattern exists before any draft is consulted.
 */
function closureScan(text: string): { claims: number; closed: number } {
  const money = moneyAnchors(text);
  const pct = pctAnchors(text);
  let claims = 0;
  let closed = 0;
  for (const p of pct) {
    const before = text.slice(Math.max(0, p.index - 40), p.index);
    if (THRESHOLD_RE.test(before)) continue;
    const base = ofBase(text, p);
    if (!base) continue;
    claims += 1;
    let part: MoneyAnchor | null = null;
    let bestGap = Infinity;
    for (const m of money) {
      const g = Math.min(Math.abs(m.index - p.end), Math.abs(p.index - m.index));
      if (g <= PART_REACH && g < bestGap) {
        part = m;
        bestGap = g;
      }
    }
    if (!part) continue;
    for (const m of money) {
      if (m === part) continue;
      const label = text.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
      if (!label.includes(base)) continue;
      if (Math.abs((part.value / m.value) * 100 - p.value) > PCT_TOL) continue;
      closed += 1;
      break;
    }
  }
  return { claims, closed };
}

/** Minimal docx body → plain text (paragraphs + table cells on lines). */
async function docxToText(bytes: Buffer): Promise<string> {
  const zip = await loadZip(bytes);
  const entry = zip.file("word/document.xml");
  if (!entry) return "";
  const xml = await entry.async("text");
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, " | ")
    .replace(/<w:tab[^>]*\/>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ");
}

async function loadTaskDocs(taskDir: string): Promise<DerivedValueDocument[]> {
  const docsDir = path.join(taskDir, "documents");
  let files: string[];
  try {
    files = readdirSync(docsDir);
  } catch {
    return [];
  }
  const docs: DerivedValueDocument[] = [];
  for (const f of files.filter((f) => f.endsWith(".docx")).sort()) {
    try {
      const bytes = readFileSync(path.join(docsDir, f));
      const text = await docxToText(bytes);
      if (text.trim().length > 0) docs.push({ name: f, text });
    } catch {
      /* unreadable docx — skip */
    }
  }
  return docs;
}

/** Find the grounded-cache grounded_structure_v1 draft for a task, if any. */
function findDraft(family: string, task: string): { run: string; path: string } | null {
  for (const v of ["v3", "v2", "v1"]) {
    const dir = path.join(
      RESULTS,
      `2026-08-03-grounded-cache-${v}--${family}--${task}--grounded_structure_v1`,
      "output",
    );
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".docx")) return { run: v, path: path.join(dir, f) };
      }
    } catch {
      /* no such run */
    }
  }
  return null;
}

async function main(): Promise<void> {
  const families = readdirSync(TASKS).sort();
  const phase1: { family: string; task: string; claims: number; closed: number }[] = [];
  let withClosed = 0;

  for (const family of families) {
    const famDir = path.join(TASKS, family);
    for (const task of readdirSync(famDir).sort()) {
      const taskDir = path.join(famDir, task);
      if (!readdirSync(taskDir).includes("task.json")) continue;
      const docs = await loadTaskDocs(taskDir);
      if (docs.length === 0) continue;
      let claims = 0;
      let closed = 0;
      for (const d of docs) {
        const c = closureScan(d.text);
        claims += c.claims;
        closed += c.closed;
      }
      if (claims > 0 || closed > 0) {
        phase1.push({ family, task, claims, closed });
      }
      if (closed > 0) withClosed += 1;
    }
  }

  console.log("=== PHASE 1: source-side closed percent-of-base identities (whole corpus) ===");
  phase1.sort((a, b) => b.closed - a.closed);
  console.log(`tasks with >=1 claim or closed identity: ${phase1.length} (${withClosed} with >=1 closed)`);
  console.log(`${"family".padEnd(42)} ${"claims".padStart(6)} ${"closed".padStart(6)}`);
  for (const r of phase1) {
    console.log(`${(r.family + "/" + r.task).padEnd(42)} ${String(r.claims).padStart(6)} ${String(r.closed).padStart(6)}`);
  }

  console.log("\n=== PHASE 2: production derivedValueScan on grounded-cache drafts ===");
  for (const r of phase1) {
    if (r.closed === 0) continue;
    const draftHit = findDraft(r.family, r.task);
    if (!draftHit) continue;
    const taskDir = path.join(TASKS, r.family, r.task);
    const sources = await loadTaskDocs(taskDir);
    const bytes = readFileSync(draftHit.path);
    const draftText = await docxToText(bytes);
    const draft: DerivedValueDocument = { name: "draft.docx", text: draftText };
    const findings = derivedValueScan(sources, draft);
    console.log(`\n--- ${r.family}/${r.task}  [${r.claims} claims, ${r.closed} closed, run ${draftHit.run}] ---`);
    if (findings.length === 0) {
      console.log("  (no omission findings)");
    }
    for (const f of findings) {
      console.log(`  ${f.direction}  base=${f.base}`);
      console.log(`    ${f.detail}`);
      console.log(`    part:    ${f.part.display}  (${f.part.document})`);
      console.log(`    percent: ${f.percent.display}  (${f.percent.document})`);
      console.log(`    whole:   ${f.whole.display}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
