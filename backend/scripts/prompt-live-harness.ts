/**
 * Live-call harness for the trimmed system prompt.
 *
 * Sends real provider calls (Claude, Gemini, OpenAI) through the repo's own
 * completeText adapters with the production-assembled system prompt, then
 * validates the returned <CITATIONS> discipline with the repo's own parser.
 *
 * Arms:
 *   new — the current working-tree prompt (trimmed, conditional spreadsheet)
 *   old — the HEAD prompt (pre-trim), for regression comparison
 *
 * Run from backend/:  npx tsx scripts/prompt-live-harness.ts
 * Requires ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY in .env.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { completeText } from "../src/lib/llm";
import { buildMessages } from "../src/lib/chat/contextBuilders";
import { CITATIONS_BLOCK_RE } from "../src/lib/chat/citations";

const REPS = 2;
const MAX_TOKENS = 4000;
const CALL_TIMEOUT_MS = 120_000;
// Only the OpenAI key in backend/.env is real (Anthropic/Gemini are
// placeholders), so diversity comes from model tiers on one provider. The
// nano tier is the stress test: if the trimmed prompt holds on the weakest
// model, instruction clarity survived the trim.
const MODELS = ["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5"];

// ---------------------------------------------------------------------------
// Fixtures — page markers and spreadsheet markdown match production renderers.
// ---------------------------------------------------------------------------

const LEASE_TEXT = `[Page 1]
COMMERCIAL LEASE AGREEMENT dated March 1, 2024 between Grandview Properties Ltd. (the "Landlord") and Maple Analytics Inc. (the "Tenant"). The initial annual rent is $84,000, payable in equal monthly instalments of $7,000 in advance on the first day of each month.
[Page 2]
The term of this lease is five (5) years commencing April 1, 2024 and expiring March 31, 2029. The Tenant shall pay a security deposit of $14,000 upon execution. The permitted use is general office use only.
[Page 3]
The Tenant may terminate this lease after the second anniversary of the commencement date on six (6) months' prior written notice, subject to a termination fee equal to three (3) months' rent.`;

const SHEET_TEXT = `## Sheet: Rent Roll

| Row | A | B | C |
| --- | --- | --- | --- |
| 1 | Building A Rent Summary ⟨merged A1:C1⟩ |  |  |
| 2 | Unit | Tenant | Monthly Rent |
| 3 | 101 | Maple Analytics Inc. | 7000 |
| 4 | 102 | Birch Legal LLP | 5250 |
| 5 | 103 | Vacant | 0 |`;

const BRACKET_TEXT = `[Page 1]
MEMORANDUM. In Sevilleja v Marex Financial Ltd [2020] UKSC 31, the Supreme Court restricted the reflective loss principle to claims by shareholders. At paragraph [12] of the judgment, Lord Reed described the rule in Prudential as a rule of law rather than a discretionary matter. Our client's claim is a creditor claim, not a shareholder claim, and therefore falls outside the rule as restated.`;

type Scenario = {
  key: string;
  docAvailability: { doc_id: string; filename: string }[];
  user: string;
  validate: (text: string) => string[];
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function relaxed(value: string) {
  return value
    .toLowerCase()
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function rawEntries(text: string): Record<string, unknown>[] | null {
  const match = text.match(CITATIONS_BLOCK_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1] ?? "");
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function proseBeforeBlock(text: string) {
  return text.split("<CITATIONS>")[0] ?? text;
}

/** Common citation-discipline checks; returns failure strings. */
function checkDiscipline(
  text: string,
  sourceText: string,
  options: { docId: string },
): string[] {
  const failures: string[] = [];
  const entries = rawEntries(text);
  if (!entries) {
    return ["no parseable <CITATIONS> block"];
  }
  const refs = entries
    .map((entry) => entry.ref)
    .filter((ref): ref is number => typeof ref === "number")
    .sort((left, right) => left - right);
  if (refs.length !== entries.length) failures.push("entry missing numeric ref");
  const contiguous = refs.every((ref, index) => ref === index + 1);
  if (!contiguous) failures.push(`refs not contiguous 1..N: [${refs.join(",")}]`);

  const prose = proseBeforeBlock(text);
  for (const ref of refs) {
    if (!prose.includes(`[${ref}]`)) {
      failures.push(`entry ref ${ref} has no [${ref}] marker in prose`);
    }
  }
  // First-appearance order.
  const positions = refs.map((ref) => prose.indexOf(`[${ref}]`));
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] >= 0 && positions[index - 1] > positions[index]) {
      failures.push("refs not in first-appearance order");
      break;
    }
  }

  const source = relaxed(sourceText);
  for (const entry of entries) {
    if (entry.doc_id !== options.docId) {
      failures.push(`doc_id "${String(entry.doc_id)}" != "${options.docId}"`);
    }
    const quotes = Array.isArray(entry.quotes) ? entry.quotes : [];
    if (!quotes.length) failures.push(`ref ${String(entry.ref)} has no quotes`);
    if (quotes.length > 3) failures.push(`ref ${String(entry.ref)} has >3 quotes`);
    for (const quote of quotes) {
      const value = (quote as Record<string, unknown>).quote;
      if (typeof value !== "string" || !value.trim()) {
        failures.push(`ref ${String(entry.ref)} quote not a string`);
        continue;
      }
      const needle = relaxed(value.replace(/\s*\[\[PAGE_BREAK\]\]\s*/gu, " "));
      if (!source.includes(needle)) {
        failures.push(
          `ref ${String(entry.ref)} quote not verbatim: "${value.slice(0, 60)}"`,
        );
      }
    }
  }
  return failures;
}

const SCENARIOS: Scenario[] = [
  {
    key: "pdf-citations",
    docAvailability: [{ doc_id: "doc-0", filename: "lease.pdf" }],
    user: `Document doc-0 (lease.pdf) full text:\n\n${LEASE_TEXT}\n\nWhat is the annual rent, the term, and the early termination right under this lease? Cite each fact to the document.`,
    validate: (text) => {
      const failures = checkDiscipline(text, LEASE_TEXT, { docId: "doc-0" });
      const entries = rawEntries(text) ?? [];
      if (entries.length < 2) failures.push(`only ${entries.length} citations`);
      for (const entry of entries) {
        for (const quote of (entry.quotes as Record<string, unknown>[]) ?? []) {
          const page = quote.page;
          const okPage =
            (typeof page === "number" && page >= 1 && page <= 3) ||
            (typeof page === "string" && /^\d+\s*-\s*\d+$/u.test(page));
          if (!okPage) {
            failures.push(`bad page ${JSON.stringify(page)} on ref ${String(entry.ref)}`);
          }
        }
      }
      return failures;
    },
  },
  {
    key: "spreadsheet-cells",
    docAvailability: [{ doc_id: "doc-0", filename: "rent-roll.xlsx" }],
    user: `Document doc-0 (rent-roll.xlsx) content:\n\n${SHEET_TEXT}\n\nWhat is the monthly rent for Unit 102, and what is the title of this summary sheet? Cite both to the spreadsheet.`,
    validate: (text) => {
      const failures: string[] = [];
      const entries = rawEntries(text);
      if (!entries) return ["no parseable <CITATIONS> block"];
      if (entries.length < 2) failures.push(`only ${entries.length} citations`);
      const cellForm = /^[A-Z]{1,2}\d+(?::[A-Z]{1,2}\d+)?$/u;
      for (const entry of entries) {
        const quotes = ((entry.quotes as Record<string, unknown>[]) ?? []).length
          ? (entry.quotes as Record<string, unknown>[])
          : [entry];
        for (const quote of quotes) {
          const cell =
            (quote.cell as string | undefined) ?? (entry.cell as string | undefined);
          const sheet =
            (quote.sheet as string | undefined) ?? (entry.sheet as string | undefined);
          if (!cell || !cellForm.test(cell)) {
            failures.push(`ref ${String(entry.ref)} missing/bad cell "${String(cell)}"`);
          }
          if (sheet !== "Rent Roll") {
            failures.push(`ref ${String(entry.ref)} sheet "${String(sheet)}"`);
          }
          if ("page" in quote && quote.page !== undefined) {
            failures.push(`ref ${String(entry.ref)} has page on spreadsheet citation`);
          }
          const value = quote.quote;
          if (typeof value === "string") {
            if (value.includes("⟨merged")) {
              failures.push(`ref ${String(entry.ref)} quote includes merged tag`);
            }
            if (relaxed(value).includes("building a rent summary") && cell !== "A1:C1") {
              failures.push(`merged title cited as "${String(cell)}" not "A1:C1"`);
            }
          }
        }
      }
      return failures;
    },
  },
  {
    key: "no-citations",
    docAvailability: [],
    user: "In two sentences, what is consideration in contract law?",
    validate: (text) =>
      text.includes("<CITATIONS>")
        ? ["emitted a CITATIONS block with no documents in context"]
        : [],
  },
  {
    key: "bracket-trap",
    docAvailability: [{ doc_id: "doc-0", filename: "memo.pdf" }],
    user: `Document doc-0 (memo.pdf) full text:\n\n${BRACKET_TEXT}\n\nAccording to this memo, does the reflective loss rule bar our client's creditor claim? Cite the memo, and name the case it relies on.`,
    validate: (text) => checkDiscipline(text, BRACKET_TEXT, { docId: "doc-0" }),
  },
];

// ---------------------------------------------------------------------------
// Prompt arms
// ---------------------------------------------------------------------------

function assembleSystem(
  build: typeof buildMessages,
  scenario: Scenario,
): string {
  const messages = build(
    [{ role: "user", content: scenario.user }],
    scenario.docAvailability,
  );
  return (messages[0] as { content: string }).content;
}

async function loadOldBuildMessages(): Promise<typeof buildMessages | null> {
  // Reconstruct the pre-trim prompt from git HEAD. Files are written next to
  // the live modules so their relative imports resolve, then removed.
  const chatDir = path.resolve(__dirname, "../src/lib/chat");
  const oldPrompts = path.join(chatDir, "prompts.old.harness.ts");
  const oldBuilders = path.join(chatDir, "contextBuilders.old.harness.ts");
  try {
    const promptsSource = execFileSync(
      "git",
      ["show", "HEAD:backend/src/lib/chat/prompts.ts"],
      { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" },
    );
    const buildersSource = execFileSync(
      "git",
      ["show", "HEAD:backend/src/lib/chat/contextBuilders.ts"],
      { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" },
    );
    writeFileSync(oldPrompts, promptsSource);
    writeFileSync(
      oldBuilders,
      buildersSource.replace('from "./prompts"', 'from "./prompts.old.harness"'),
    );
    const mod = await import(pathToFileURL(oldBuilders).href);
    return mod.buildMessages as typeof buildMessages;
  } catch (error) {
    console.warn("old-arm unavailable:", (error as Error).message);
    return null;
  } finally {
    process.on("exit", () => {
      for (const file of [oldPrompts, oldBuilders]) {
        try {
          rmSync(file, { force: true });
        } catch {
          /* ignore */
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

type RunResult = {
  text?: string;
  arm: string;
  model: string;
  scenario: string;
  rep: number;
  ok: boolean;
  failures: string[];
  chars: number;
  ms: number;
};

async function callWithTimeout(params: Parameters<typeof completeText>[0]) {
  return Promise.race([
    completeText(params),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), CALL_TIMEOUT_MS),
    ),
  ]);
}

async function main() {
  const oldBuild = await loadOldBuildMessages();
  const jobs: (() => Promise<RunResult>)[] = [];

  for (const model of MODELS) {
    for (const scenario of SCENARIOS) {
      for (let rep = 1; rep <= REPS; rep += 1) {
        jobs.push(async () => {
          const started = Date.now();
          try {
            const text = await callWithTimeout({
              model,
              systemPrompt: assembleSystem(buildMessages, scenario),
              user: scenario.user,
              maxTokens: MAX_TOKENS,
            });
            const failures = scenario.validate(text);
            return {
              arm: "new",
              model,
              scenario: scenario.key,
              rep,
              ok: failures.length === 0,
              failures,
              text: failures.length ? text.slice(0, 2500) : undefined,
              chars: text.length,
              ms: Date.now() - started,
            };
          } catch (error) {
            return {
              arm: "new",
              model,
              scenario: scenario.key,
              rep,
              ok: false,
              failures: [`call failed: ${(error as Error).message}`],
              chars: 0,
              ms: Date.now() - started,
            };
          }
        });
        // Old arm only on the scenarios the trim touched.
        if (
          oldBuild &&
          (scenario.key === "pdf-citations" || scenario.key === "spreadsheet-cells")
        ) {
          jobs.push(async () => {
            const started = Date.now();
            try {
              const text = await callWithTimeout({
                model,
                systemPrompt: assembleSystem(oldBuild, scenario),
                user: scenario.user,
                maxTokens: MAX_TOKENS,
              });
              const failures = scenario.validate(text);
              return {
                arm: "old",
                model,
                scenario: scenario.key,
                rep,
                ok: failures.length === 0,
                failures,
                chars: text.length,
                ms: Date.now() - started,
              };
            } catch (error) {
              return {
                arm: "old",
                model,
                scenario: scenario.key,
                rep,
                ok: false,
                failures: [`call failed: ${(error as Error).message}`],
                chars: 0,
                ms: Date.now() - started,
              };
            }
          });
        }
      }
    }
  }

  console.log(`Running ${jobs.length} live calls across ${MODELS.length} models...`);
  const results: RunResult[] = [];
  const CHUNK = 6;
  for (let index = 0; index < jobs.length; index += CHUNK) {
    const chunk = jobs.slice(index, index + CHUNK);
    results.push(...(await Promise.all(chunk.map((job) => job()))));
    console.log(`  ${Math.min(index + CHUNK, jobs.length)}/${jobs.length} done`);
  }

  // Summary table.
  const byKey = new Map<string, { pass: number; total: number }>();
  for (const result of results) {
    const key = `${result.arm} | ${result.model} | ${result.scenario}`;
    const row = byKey.get(key) ?? { pass: 0, total: 0 };
    row.total += 1;
    if (result.ok) row.pass += 1;
    byKey.set(key, row);
  }
  console.log("\n=== RESULTS (pass/total) ===");
  for (const [key, row] of [...byKey.entries()].sort()) {
    console.log(`${row.pass}/${row.total}  ${key}`);
  }
  console.log("\n=== FAILURES ===");
  for (const result of results.filter((r) => !r.ok)) {
    console.log(
      `[${result.arm}|${result.model}|${result.scenario}#${result.rep}] ${result.failures.join("; ")}`,
    );
  }

  const outDir = path.resolve(__dirname, "../..", "benchmarks", "prompt_live");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `prompt-live-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`,
  );
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nSaved ${results.length} results to ${outPath}`);
  const newFailures = results.filter((r) => r.arm === "new" && !r.ok).length;
  process.exitCode = newFailures > 0 ? 1 : 0;
}

main();
