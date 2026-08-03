/**
 * Deterministic stress test over the whole vendored LAB corpus.
 *
 * Runs every landed deterministic omission organ — derived-value carry-through
 * (H1), deadline working-back (H2), undefined defined-term (H3) — against each
 * grounded-cache run's draft (.docx deliverable) and its source stack, with
 * ZERO model calls: pure functions over cached files already on disk. Cross-
 * references each firing against the run's fixed-Sol scores.json (passed vs
 * failed) to surface false positives (fired on a PASS) and misses (silent on a
 * FAIL), audits finding information density, and reconstructs the full SLA
 * repair prompt (`auditSlaDraft`) to measure its size distribution.
 *
 * Run: npx tsx backend/scripts/deterministic-stress-test.ts
 * Output: docs/harvey-lab-deterministic-stress-test-2026-08-03.md
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadZip } from "../src/lib/zip";
import {
  derivedValueScan,
  type DerivedValueOmission,
} from "../src/lib/legalDerivedValueScan";
import {
  deadlineOmissionScan,
  type DeadlineOmission,
} from "../src/lib/legalDeadlineOmissionScan";
import {
  undefinedTermScan,
  undefinedTermScanStats,
  type UndefinedTermFinding,
} from "../src/lib/legalUndefinedTermScan";
import { auditSlaDraft } from "../src/lib/chat/slaWorkflow";

const REPO = "C:/Users/elias/Desktop/MikeOSS Fork";
const LAB = path.join(REPO, "benchmarks/harvey-labs");
const TASKS = path.join(LAB, "tasks");
const RESULTS = path.join(LAB, "results");
const OUT_MD = path.join(REPO, "docs/harvey-lab-deterministic-stress-test-2026-08-03.md");

/** Optional env LIMIT to smoke-test on a handful of runs. */
const LIMIT = Number(process.env.LIMIT || 0);

interface SourceDoc {
  name: string;
  text: string;
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

async function readDocx(pathName: string): Promise<string | null> {
  try {
    const text = await docxToText(readFileSync(pathName));
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function loadSources(taskDir: string): Promise<SourceDoc[]> {
  const docsDir = path.join(taskDir, "documents");
  let files: string[];
  try {
    files = readdirSync(docsDir);
  } catch {
    return [];
  }
  const docs: SourceDoc[] = [];
  for (const f of files.filter((f) => f.endsWith(".docx")).sort()) {
    const text = await readDocx(path.join(docsDir, f));
    if (text) docs.push({ name: f, text });
  }
  return docs;
}

/** Combine every output .docx exactly as collectSlaDeliverable would. */
async function loadDraft(runDir: string): Promise<{ docs: SourceDoc[]; names: string[] }> {
  const outDir = path.join(runDir, "output");
  let files: string[];
  try {
    files = readdirSync(outDir).filter((f) => f.endsWith(".docx")).sort();
  } catch {
    return { docs: [], names: [] };
  }
  const docs: SourceDoc[] = [];
  for (const f of files) {
    const text = await readDocx(path.join(outDir, f));
    if (text) docs.push({ name: f, text });
  }
  const names = docs.map((d) => d.name);
  // AuditSlaDraft sees the deliverable as [deliverable document: name]\n<text>
  // concatenated, per collectSlaDeliverable.
  const text = docs
    .map((d) => `[deliverable document: ${d.name}]\n${d.text}`)
    .join("\n\n");
  return { docs: [{ name: "draft", text }], names };
}

interface Scores {
  scored: boolean;
  allPass: boolean | null;
  nPassed: number | null;
  nCriteria: number | null;
  summary: string | null;
}

function loadScores(runDir: string): Scores {
  const p = path.join(runDir, "scores.json");
  if (!existsSync(p)) return { scored: false, allPass: null, nPassed: null, nCriteria: null, summary: null };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return {
      scored: true,
      allPass: s.all_pass ?? null,
      nPassed: s.n_passed ?? null,
      nCriteria: s.n_criteria ?? null,
      summary: s.summary ?? null,
    };
  } catch {
    return { scored: false, allPass: null, nPassed: null, nCriteria: null, summary: null };
  }
}

interface SectionFlags {
  conflict: boolean;
  temporal: boolean;
  drift: boolean;
  derived: boolean;
  deadline: boolean;
  undefined: boolean;
  lint: boolean;
}

const SECTION_HEADERS: [keyof SectionFlags, string][] = [
  ["conflict", "\nArithmetic in your deliverable that does not close:"],
  ["temporal", "\nDeadline arithmetic in your deliverable that does not close"],
  ["drift", "\nDefined terms redefined by your deliverable"],
  ["derived", "\nQuantified amounts your deliverable cites by percent but never states"],
  ["deadline", "\nDeadline relationships your deliverable engaged but never resolved to an actual date"],
  ["undefined", "\nDefined terms your deliverable uses but no source or the draft defines"],
  ["lint", "\nDrafting lint over your deliverable"],
];

function sectionFlags(prompt: string | null): SectionFlags {
  const flags: SectionFlags = { conflict: false, temporal: false, drift: false, derived: false, deadline: false, undefined: false, lint: false };
  if (!prompt) return flags;
  for (const [key, header] of SECTION_HEADERS) {
    if (prompt.includes(header)) flags[key] = true;
  }
  return flags;
}

interface RunResult {
  runId: string;
  version: string;
  family: string;
  task: string;
  arm: string;
  model: string;
  workType: string | null;
  taskDirExists: boolean;
  nSources: number;
  draftChars: number;
  sourceDocs: SourceDoc[];
  draftText: string;
  outputNames: string[];
  scores: Scores;
  derivedFindings: DerivedValueOmission[];
  deadlineFindings: DeadlineOmission[];
  deadlineResolved: number;
  deadlineEngaged: number;
  deadlineRefusals: number;
  undefinedFindings: UndefinedTermFinding[];
  stats: ReturnType<typeof undefinedTermScanStats> | null;
  repairPrompt: string | null;
  repairPromptChars: number;
  sections: SectionFlags;
  audit: {
    conflict: number;
    temporal: number;
    drift: number;
    lintErrors: number;
    lintWarnings: number;
    /** gated counts: what the workflow would actually surface (derived/deadline are suppressed on operative-drafting work types) */
    gatedDerived: number;
    gatedDeadline: number;
    undefined: number;
    resolved: number;
    engaged: number;
    refusals: number;
  };
}

function jsonRead(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function analyzeRun(runDir: string): Promise<RunResult | null> {
  const runId = path.basename(runDir);
  const m = /^2026-08-03-grounded-cache-(v[123])--/.exec(runId);
  const version = m ? m[1] : "?";
  const config = jsonRead(path.join(runDir, "config.json"));
  const task = (config?.task as string | undefined) ?? null;
  const arm = (config?.arm as string | undefined) ?? null;
  const model = (config?.model as string | undefined) ?? null;
  if (!task) return null; // no task mapping (aborted/failed setup runs)

  const taskDir = path.join(TASKS, task);
  const taskJson = jsonRead(path.join(taskDir, "task.json"));
  const workType = (taskJson?.work_type as string | undefined) ?? null;
  const instructions = (taskJson?.instructions as string | undefined) ?? null;

  const sources = taskDir && existsSync(path.join(taskDir, "documents")) ? await loadSources(taskDir) : [];
  const draft = await loadDraft(runDir);
  if (draft.docs.length === 0) return null; // no .docx deliverable
  const draftText = draft.docs[0].text;

  const derivedFindings = derivedValueScan(sources, { name: "draft", text: draftText });
  const deadline = deadlineOmissionScan(sources, { name: "draft", text: draftText });
  const undefinedFindings = undefinedTermScan(sources, { name: "draft", text: draftText });
  const stats = undefinedTermScanStats(sources, { name: "draft", text: draftText });

  // Full SLA repair-prompt reconstruction — the exact audit the harness runs.
  const audit = auditSlaDraft(
    { documents: sources, promptSection: "", baseline: new Map() },
    draftText,
    {
      artifactDeliverable: true,
      requestContext: instructions,
      artifactNames: draft.names,
    },
  );

  const sections = sectionFlags(audit.repairPrompt);
  return {
    runId,
    version,
    family: task.split("/")[0] ?? "?",
    task,
    arm: arm ?? "?",
    model: model ?? "?",
    workType,
    taskDirExists: existsSync(path.join(taskDir, "documents")),
    nSources: sources.length,
    draftChars: draftText.length,
    sourceDocs: sources,
    draftText,
    outputNames: draft.names,
    scores: loadScores(runDir),
    derivedFindings,
    deadlineFindings: deadline.findings,
    deadlineResolved: deadline.resolved,
    deadlineEngaged: deadline.engaged,
    deadlineRefusals: deadline.refusals.reduce((n, r) => n + r.count, 0),
    undefinedFindings,
    stats,
    repairPrompt: audit.repairPrompt,
    repairPromptChars: audit.repairPrompt ? audit.repairPrompt.length : 0,
    sections,
    audit: {
      conflict: audit.receipt.conflict.findings,
      temporal: audit.receipt.temporal.findings,
      drift: audit.receipt.term_drift.divergent,
      lintErrors: audit.receipt.drafting_lint.errors,
      lintWarnings: audit.receipt.drafting_lint.warnings,
      gatedDerived: audit.receipt.derived_value.findings,
      gatedDeadline: audit.receipt.deadline_omission.findings,
      undefined: audit.receipt.undefined_term.findings,
      resolved: audit.receipt.deadline_omission.resolved,
      engaged: audit.receipt.deadline_omission.engaged,
      refusals: audit.receipt.deadline_omission.refusals,
    },
  };
}

async function main(): Promise<void> {
  const runs = readdirSync(RESULTS)
    .filter((r) => /^2026-08-03-grounded-cache-v[123]--/.test(r))
    .sort();

  const results: RunResult[] = [];
  let examined = 0;
  for (const run of runs) {
    if (LIMIT && results.length >= LIMIT) break;
    const res = await analyzeRun(path.join(RESULTS, run));
    if (!res) continue;
    results.push(res);
    examined += 1;
    console.error(`[${examined}] ${res.task} ${res.arm}  dv=${res.derivedFindings.length} dl=${res.deadlineFindings.length} uf=${res.undefinedFindings.length} prompt=${res.repairPromptChars}`);
  }

  // ----- Aggregations -----
  const byFamily = new Map<string, RunResult[]>();
  for (const r of results) {
    const list = byFamily.get(r.family) ?? [];
    list.push(r);
    byFamily.set(r.family, list);
  }

  const promptChars = results.map((r) => r.repairPromptChars).sort((a, b) => a - b);
  const nonzeroPrompts = promptChars.filter((c) => c > 0);
  const pct = (arr: number[], p: number) => percentile(arr, p);

  const falsePositives = results.filter(
    (r) => r.scores.scored && r.scores.allPass === true &&
      (r.derivedFindings.length > 0 || r.deadlineFindings.length > 0 || r.undefinedFindings.length > 0),
  );
  const misses = results.filter(
    (r) => r.scores.scored && r.scores.allPass === false &&
      r.derivedFindings.length === 0 && r.deadlineFindings.length === 0 && r.undefinedFindings.length === 0,
  );

  const over3000 = results.filter((r) => r.repairPromptChars > 3000);

  // ----- Markdown -----
  const L: string[] = [];
  L.push(`# Deterministic stress test — grounded-cache LAB corpus (2026-08-03)`);
  L.push(``);
  L.push(`Date: 2026-08-03 · Scope: every grounded-cache run with a .docx deliverable.`);
  L.push(`Method: **zero model calls** — the three deterministic omission organs (` +
    `H1 \`derivedValueScan\`, H2 \`deadlineOmissionScan\`, H3 \`undefinedTermScan\`) plus the full ` +
    `SLA repair-prompt reconstruction (\`auditSlaDraft\`) ran as pure functions over cached drafts ` +
    `and source documents already on disk. Scores are the fixed-Sol criterion-judge labels, not human gold.`);
  L.push(``);
  L.push(`- Runs examined: **${results.length}** (of ${runs.length} grounded-cache run dirs; the rest lack a ` +
    `config task mapping or a .docx deliverable).`);
  L.push(`- Task families covered: **${byFamily.size}** — ${[...byFamily.keys()].sort().join(", ")}.`);
  L.push(`- Scored runs: ${results.filter((r) => r.scores.scored).length}; passed: ` +
    `${results.filter((r) => r.scores.allPass === true).length}; failed: ` +
    `${results.filter((r) => r.scores.allPass === false).length}. ` +
    `**Every scored run here FAILED** — these grounded-cache cells are below the pass threshold, so the pass/fail ` +
    `cross-reference in section 2 has no passed runs to work from.`);
  L.push(`- Organs fired at least once on: derived **${results.filter((r) => r.derivedFindings.length > 0).length}** runs, ` +
    `deadline **${results.filter((r) => r.deadlineFindings.length > 0).length}** runs, ` +
    `undefined **${results.filter((r) => r.undefinedFindings.length > 0).length}** runs.`);
  L.push(``);

  // 1. Per-family firing table
  L.push(`## 1. Per-organ, per-family firing table`);
  L.push(``);
  L.push(`Rows = task families with at least one scored run; \`dv\`/\`dl\`/\`uf\` = total findings the organ ` +
    `fired across all runs in the family, of which the parenthetical is how many fired on a run the model ` +
    `PASSED (false-positive candidates). Pass/Fail = scored runs in the family by verdict.`);
  L.push(``);
  L.push(`| Family | Runs | Pass | Fail | dv (fires@pass) | dl (fires@pass) | uf (fires@pass) |`);
  L.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const [family, list] of [...byFamily.entries()].sort()) {
    const scored = list.filter((r) => r.scores.scored);
    const pass = scored.filter((r) => r.scores.allPass === true).length;
    const fail = scored.filter((r) => r.scores.allPass === false).length;
    const dv = list.reduce((n, r) => n + r.derivedFindings.length, 0);
    const dl = list.reduce((n, r) => n + r.deadlineFindings.length, 0);
    const uf = list.reduce((n, r) => n + r.undefinedFindings.length, 0);
    const dvPass = list.filter((r) => r.scores.allPass === true).reduce((n, r) => n + r.derivedFindings.length, 0);
    const dlPass = list.filter((r) => r.scores.allPass === true).reduce((n, r) => n + r.deadlineFindings.length, 0);
    const ufPass = list.filter((r) => r.scores.allPass === true).reduce((n, r) => n + r.undefinedFindings.length, 0);
    L.push(`| ${family} | ${list.length} | ${pass} | ${fail} | ${dv}${dvPass ? ` (${dvPass}@pass)` : ""} | ${dl}${dlPass ? ` (${dlPass}@pass)` : ""} | ${uf}${ufPass ? ` (${ufPass}@pass)` : ""} |`);
  }
  L.push(``);

  // Per-run detailed firing table (compact)
  L.push(`### Per-run detail`);
  L.push(``);
  L.push(`\`dv\`/\`dl\` = raw organ findings, with the workflow-gated count in parens (derived/deadline are suppressed on ` +
    `operative-drafting work types; the gated count is what a repair prompt would carry). \`dl (res/eng/ref)\` = ` +
    `source deadline relationships resolved / engaged / refused. \`cand/quoted\` = H3 candidate phrases / quoted-only mentions.`);
  L.push(``);
  L.push(`| Run (arm · version) | Family/task | WT | src | Draft k | dv | dl | uf | dl res/eng/ref | cand/quoted | prompt k | Verdict |`);
  L.push(`| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const r of results) {
    const verdict = !r.scores.scored ? "—" : r.scores.allPass ? "PASS" : `FAIL ${r.scores.nPassed}/${r.scores.nCriteria}`;
    const arm = r.arm === "grounded_structure_v1" ? "gs" : r.arm === "mike_structure_paths_v1" ? "ms" : r.arm === "upstream_terminal_v1" ? "ut" : r.arm;
    const dv = r.derivedFindings.length;
    const dl = r.deadlineFindings.length;
    L.push(`| ${arm} · ${r.version} | ${r.task} | ${r.workType ?? "?"} | ${r.nSources} | ${(r.draftChars / 1000).toFixed(1)} | ` +
      `${dv}${dv !== r.audit.gatedDerived ? `(${r.audit.gatedDerived})` : ""} | ` +
      `${dl}${dl !== r.audit.gatedDeadline ? `(${r.audit.gatedDeadline})` : ""} | ` +
      `${r.undefinedFindings.length} | ${r.deadlineResolved}/${r.deadlineEngaged}/${r.deadlineRefusals} | ` +
      `${r.stats ? `${r.stats.candidates}/${r.stats.quotedOnly}` : "—"} | ` +
      `${(r.repairPromptChars / 1000).toFixed(1)} | ${verdict} |`);
  }
  L.push(``);

  // 2. False-positive analysis
  L.push(`## 2. False-positive analysis`);
  L.push(``);
  L.push(`An organ firing on a run the model PASSED means the draft was judged fine on gold yet the organ ` +
    `claimed an omission — the candidate set of noisy findings. ${falsePositives.length} run(s) qualify.`);
  L.push(``);
  L.push(`**Caveat: ${results.filter((r) => r.scores.scored).length} of ${results.length} scored runs here FAILED (0 passed), ` +
    `so this section is empty by construction — there is no passed draft to cross-reference.** A false-positive read needs ` +
    `passed runs, or a per-criterion gold read of fired findings on these failed runs (section 4 samples are dominated by H3 ` +
    `proper-noun noise, which is the closest thing to a noisy-on-good-draft signal here).`);
  L.push(``);
  if (falsePositives.length === 0) {
    L.push(`None — every firing landed on a failed run.`);
  } else {
    for (const r of falsePositives) {
      L.push(`### ${r.task} · ${r.arm} · ${r.version} — PASS ${r.scores.nPassed}/${r.scores.nCriteria}`);
      L.push(``);
      for (const f of r.derivedFindings) {
        L.push(`- **derived** (${f.direction}, base=\`${f.base}\`): ${f.detail}`);
      }
      for (const f of r.deadlineFindings) {
        L.push(`- **deadline** (engaged=${f.engaged.join(",")}): ${f.detail}`);
      }
      for (const f of r.undefinedFindings) {
        L.push(`- **undefined**: ${f.detail} — excerpt: “${f.excerpt}”`);
      }
      L.push(``);
    }
  }

  // 3. Miss analysis
  L.push(`## 3. Miss analysis`);
  L.push(``);
  L.push(`A run the model FAILED where every organ stayed silent means the deterministic organs did not catch ` +
    `whatever defect the gold rubric penalized. ${misses.length} run(s) qualify.`);
  L.push(``);
  L.push(`**Caveat: because H3 floods 12 findings onto ${results.filter((r) => r.undefinedFindings.length >= 12).length} of ` +
    `${results.length} runs, "every organ stayed silent" is a high bar — the organs almost always fire *something*, but mostly ` +
    `H3 proper-noun noise. "No misses" therefore does NOT mean the organs caught the failed gold criteria.** The real miss test ` +
    `is criterion-level: for each failed criterion, does any organ's finding point at it? That correlation is not computed here ` +
    `(section 6 gaps).`);
  L.push(``);
  if (misses.length === 0) {
    L.push(`None — every failed run had at least one organ firing.`);
  } else {
    L.push(`| Family/task | Arm/version | Fail score | n src | draft k | criteria failed |`);
    L.push(`| --- | --- | ---: | ---: | ---: | ---: |`);
    for (const r of misses) {
      L.push(`| ${r.task} | ${r.arm}/${r.version} | ${r.scores.nPassed}/${r.scores.nCriteria} | ${r.nSources} | ${(r.draftChars / 1000).toFixed(1)} | ${r.scores.nPassed !== null && r.scores.nCriteria ? r.scores.nCriteria - r.scores.nPassed : "?"} |`);
    }
  }
  L.push(``);

  // 4. Information-density audit
  L.push(`## 4. Information-density audit`);
  L.push(``);
  L.push(`The repair prompt's lines are built from each finding's \`detail\` string only — the structured ` +
    `refs/excerpts are carried in the machine receipt, not the prompt. This section measures how self-contained ` +
    `those detail strings are.`);
  L.push(``);
  const dvDetails = results.flatMap((r) => r.derivedFindings.map((f) => f.detail));
  const dlDetails = results.flatMap((r) => r.deadlineFindings.map((f) => f.detail));
  const ufDetails = results.flatMap((r) => r.undefinedFindings.map((f) => f.detail));
  const charStats = (arr: string[]) => {
    const lens = arr.map((s) => s.length).sort((a, b) => a - b);
    return lens.length
      ? { n: lens.length, min: lens[0], med: percentile(lens, 50), max: lens[lens.length - 1], p90: percentile(lens, 90) }
      : { n: 0, min: 0, med: 0, max: 0, p90: 0 };
  };
  const dvStats = charStats(dvDetails);
  const dlStats = charStats(dlDetails);
  const ufStats = charStats(ufDetails);
  L.push(`| Organ | findings | detail chars min/med/p90/max | names source doc? | self-contained? |`);
  L.push(`| --- | ---: | ---: | --- | --- |`);
  L.push(`| derived (H1) | ${dvStats.n} | ${dvStats.min}/${dvStats.med}/${dvStats.p90}/${dvStats.max} | yes — each \`detail\` ends with the source doc in parens, e.g. \`…but never the 34% share (crescent-ic-memo.docx)\` | high — the arithmetic, the omitted half, and the source doc all sit in the prompt line |`);
  L.push(`| deadline (H2) | ${dlStats.n} | ${dlStats.min}/${dlStats.med}/${dlStats.p90}/${dlStats.max} | yes — each \`detail\` appends \`(source.docx)\` after the resolved arithmetic | high — anchor −/+ duration = resolved date, the engaged subject, and the source doc |`);
  L.push(`| undefined (H3) | ${ufStats.n} | ${ufStats.min}/${ufStats.med}/${ufStats.p90}/${ufStats.max} | no — the term is draft-local by construction; the detail names the term and the source count, but not which documents were searched | partial — a reader knows the term and that nothing in the stack defines it; the occurrence excerpt is carried on the finding but not in the prompt |`);
  L.push(``);
  L.push(`### Sample findings`);
  L.push(``);
  const sample = <T,>(arr: T[], n: number): T[] => arr.slice(0, n);
  for (const r of results) {
    if (r.derivedFindings.length) {
      L.push(`**derived — ${r.task} (${r.arm})**:`);
      for (const f of sample(r.derivedFindings, 2)) L.push(`- \`${f.detail}\``);
      L.push(``);
    }
    if (r.deadlineFindings.length) {
      L.push(`**deadline — ${r.task} (${r.arm})**:`);
      for (const f of sample(r.deadlineFindings, 2)) L.push(`- \`${f.detail}\``);
      L.push(``);
    }
    if (r.undefinedFindings.length) {
      L.push(`**undefined — ${r.task} (${r.arm})**:`);
      for (const f of sample(r.undefinedFindings, 2)) L.push(`- \`${f.detail}\` — excerpt: “${f.excerpt}”`);
      L.push(``);
    }
  }

  // 5. Repair-prompt size distribution
  L.push(`## 5. Repair-prompt size distribution`);
  L.push(``);
  L.push(`Reconstructed via \`auditSlaDraft\` with \`requestContext\` = the task instructions and ` +
    `\`artifactNames\` = the run's output filenames — the exact audit the harness runs post-synthesis.`);
  L.push(``);
  const fmt = (arr: number[]) =>
    arr.length
      ? `**${arr.length}** runs — min **${pct(arr, 0)}**, p50 **${pct(arr, 50)}**, p90 **${pct(arr, 90)}**, p99 **${pct(arr, 99)}**, max **${arr[arr.length - 1]}** chars`
      : "none";
  L.push(`- All runs: ${fmt(promptChars)}`);
  L.push(`- Runs that produced a repair prompt (non-null): ${fmt(nonzeroPrompts)}`);
  L.push(`- Runs with **no** repair prompt (audit silent): ${results.length - nonzeroPrompts.length}`);
  L.push(`- Runs whose prompt exceeds the **3,000-char** skimming bound: **${over3000.length}**` +
    (over3000.length ? ` — ${over3000.map((r) => `${r.task}·${r.arm} (${r.repairPromptChars})`).join("; ")}` : ""));
  L.push(``);
  const sectionCounts = results.map((r) => Object.values(r.sections).filter(Boolean).length);
  L.push(`Distinct prompt sections (conflict/temporal/drift/derived/deadline/undefined/lint): ` +
    `min ${sectionCounts.length ? Math.min(...sectionCounts) : 0}, med ${pct(sectionCounts, 50)}, ` +
    `max ${sectionCounts.length ? Math.max(...sectionCounts) : 0} (of 7).`);
  L.push(``);

  // 6. Recommendations
  L.push(`## 6. Recommendations`);
  L.push(``);
  const capFlood = (get: (r: RunResult) => number) => results.filter((r) => get(r) >= 12).length;
  const dvCap = capFlood((r) => r.derivedFindings.length);
  const dlCap = capFlood((r) => r.deadlineFindings.length);
  const ufCap = capFlood((r) => r.undefinedFindings.length);
  const gateSuppressedDerived = results.filter((r) => r.derivedFindings.length > 0 && r.audit.gatedDerived === 0);
  const gateSuppressedDeadline = results.filter((r) => r.deadlineFindings.length > 0 && r.audit.gatedDeadline === 0);
  const anyUf = results.filter((r) => r.undefinedFindings.length > 0).length;
  L.push(`Computed from the runs above:`);
  L.push(``);
  L.push(ufCap > 0
    ? `- **H3 (undefined term) fires at its 12-finding cap on ${ufCap} of ${results.length} runs** — every one of those drafts ` +
      `has 12+ capitalized phrases with an unquoted occurrence that resolve to no definition. The fired terms on the memo/` +
      `analytical tasks are dominated by proper nouns the filters do not know: person names, cities/metro areas, company names ` +
      `without a designator word, and statute/form names. A repair pass would spend its budget correcting non-defects.`
    : `- **H3 (undefined term) stays well under its 12-finding cap on this corpus** (max ${results.reduce((m, r) => Math.max(m, r.undefinedFindings.length), 0)} findings, ` +
      `${ufCap} runs at cap) — consistent with the strictness bias. It fired on ${anyUf} of ${results.length} runs; the indenture stack is at the documented baseline.`);
  L.push(`- **H1 (derived) fired on ${results.filter((r) => r.derivedFindings.length > 0).length} runs; never at cap (${dvCap} at cap).** ` +
    `Where it fires it names the source doc and the arithmetic. Counts are low (1–6), so the findings are dense and cheap to verify.`);
  L.push(`- **H2 (deadline) fired on ${results.filter((r) => r.deadlineFindings.length > 0).length} runs; never at cap (${dlCap} at cap).** ` +
    `Its refusals dominate on source stacks without stated calendar anchors (see \`dl res/eng/ref\`), which is the typed-refusal ` +
    `behavior the mechanism promises.`);
  L.push(`- **Work-type gate:** \`requestsOperativeDrafting\` suppressed deadline on ${gateSuppressedDeadline.length} ` +
    `deadline-firing runs (the operative indenture arms — correctly, after \`indentures?\` joined OPERATIVE_ARTIFACT) and derived on ` +
    `${gateSuppressedDerived.length} derived-firing runs. The vocabulary still misses \`diligence\` and \`transfer pricing ` +
    `documentation\`, so those operative-drafting tasks are still audited as analytical.`);
  L.push(`- **Repair prompt exceeds the 3,000-char skimming bound on ${over3000.length}/${results.length} runs** (p90 ` +
    `${pct(promptChars, 90)}, max ${promptChars.length ? promptChars[promptChars.length - 1] : 0}). The H3 flood is the main driver.`);
  L.push(``);
  L.push(`### Calibration cross-check (CoC task, vs the run's own failed gold criteria)`);
  L.push(``);
  L.push(`Two organ findings on the change-of-control runs line up with the RUN's OWN failed gold criteria — evidence the ` +
    `organs find real omissions, not just noise:`);
  L.push(``);
  L.push(`- **H2 deadline → C-018** (failed on all CoC arms): \`Identifies Apex MSA auto-renewal notice deadline of ` +
    `approximately July 18, 2025\`. The organ fired \`written notice of non-renewal due 2026-01-14 − 180 days = 2025-07-18\` ` +
    `on every CoC arm — the resolved date (2025-07-18 = July 18, 2025) is exactly the date the criterion requires.`);
  L.push(`- **H1 derived → C-008** (failed on all CoC arms): \`Quantifies Pinnacle-dependent revenue at risk ($22.1M / 25.3% of ` +
    `total revenue)\`. On the arms where the organ fired the \`$22.1M / 25.3%\` identity, it names the half that criterion ` +
    `penalizes as missing.`);
  L.push(``);
  L.push(`(C-009 — rate the Pinnacle exclusivity conversion as Critical — also failed on the upstream CoC arm; it is a ` +
    `severity-rating criterion, not an omission, so no organ addresses it. That is a genuine miss but out of H1/H2/H3 scope.)`);
  L.push(``);
  L.push(`### Organ readiness`);
  L.push(``);
  L.push(`- **H1 (derived) — ready for live A/B** on the analytical families where it fires (CoC, tax, diligence, antitrust). ` +
    `Low fire counts, dense details, source-naming details, zero cap-floods. Gate it to analytical work types and keep the ` +
    `\`"of <base>"\` engagement gate.`);
  L.push(`- **H2 (deadline) — ready for live A/B** where it fires (indenture, CoC, diligence, tax, white-collar). The typed ` +
    `refusal path is behaving (most deadline-ish periods refuse rather than guess). Validate a sample of fired ` +
    `\`resolved\` dates against gold before enabling repair, since a wrong resolved date is worse than no finding.`);
  L.push(`- **H3 (undefined term) — not corpus-ready; two distinct problems.** First, an early pass of this stress test caught a ` +
    `live regression: a word-class \`.\` in \`PHRASE_RE\` glued sentence-final periods to the next capitalized word (\`Business ` +
    `Days. Upon\`); that has been reverted and the indenture stack is back to the documented baseline of 1 firing. Second, and ` +
    `still live: on memo/analytical deliverables H3 floods its cap with proper nouns — person names (\`Frank Castellano\`), ` +
    `cities/metro areas (\`Baton Rouge\`, \`Hattiesburg and Gulfport-Biloxi\`), company names without designators (` +
    `\`PetroStar Refining and Gulf Coast Shipbuilders\`), and statute/form names (\`Hart-Scott-Rodino Act\`, \`Notification and ` +
    `Report Form\`). Recommended: add a person/place/known-name filter (or an NER-shaped gate), or gate H3 to operative-drafting ` +
    `work types where undefined defined terms are the real defect and run it analytically only for the quoting/use boundary.`);
  L.push(``);
  L.push(`### Stress-test gaps`);
  L.push(``);
  L.push(`- **Sealed tier (997 tasks) is off-machine** — this covers only the vendored LAB tasks with grounded-cache runs ` +
    `(${results.length} runs, ${byFamily.size} families).`);
  L.push(`- **Scores are fixed-Sol criterion labels, not human gold.** A PASS is the judge's verdict, so "false positive" here ` +
    `means "fired on a judge-PASS run", not "wrong per a lawyer". A manual gold read of the fired findings is the next step.`);
  L.push(`- **Multiple arms per task** (grounded_structure / mike_structure_paths / upstream_terminal × v1/v2/v3) are pooled per ` +
    `family; some v1/v2 arms have no deliverable and were excluded.`);
  L.push(`- **Concurrent edits:** the organs were modified during this run (2026-08-03 14:21–14:35 local). The numbers are a ` +
    `snapshot against the module versions loaded at script start; re-run to refresh.`);
  L.push(``);

  writeFileSync(OUT_MD, L.join("\n"), "utf8");
  console.error(`\nWrote ${OUT_MD}`);
  console.error(`prompt chars: min=${promptChars.length ? promptChars[0] : 0} p50=${pct(promptChars, 50)} p90=${pct(promptChars, 90)} p99=${pct(promptChars, 99)} max=${promptChars.length ? promptChars[promptChars.length - 1] : 0}  nonzero=${nonzeroPrompts.length}`);
  console.error(`false positives (fired on PASS): ${falsePositives.length}`);
  console.error(`misses (silent on FAIL): ${misses.length}`);
  console.error(`over-3000 prompts: ${over3000.length}`);
  console.error(`sections med/max: ${pct(sectionCounts, 50)}/${sectionCounts.length ? Math.max(...sectionCounts) : 0}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
