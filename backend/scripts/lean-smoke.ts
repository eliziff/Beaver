/**
 * Lean smoke: one real model turn, over the real /chat route, against a
 * matter small enough to finish in about a minute.
 *
 * The question is not whether the thrift mechanisms work — unit tests cover
 * that — but whether a model REACHES for them: does it locate a clause with
 * find/outline and read a window, or does it pull whole documents into
 * context? Does it trust a decoded email? Does it note up a citation instead
 * of guessing? So this reports the tool sequence the model actually chose and
 * what the turn cost, not just whether an answer came back.
 *
 * Flat-rate surfaces only (claude -p / codex / ollama); never a metered key.
 *
 *   npx tsx scripts/lean-smoke.ts [--model codex:gpt-5.6-luna]
 *                                 [--effort low]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const EML_FIXTURE = path.join(
  __dirname,
  "../../benchmarks/harvey-labs/tasks/trusts-estates-private-client/extract-client-intake-facts/scenario-01/documents/client-email-financial-notes.eml",
);

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return (index >= 0 ? process.argv[index + 1] : undefined) ?? fallback;
}

type SseEvent = { type?: string; [key: string]: unknown };

const sseEvents = (body: string): SseEvent[] =>
  body
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as SseEvent);

/** A lease long enough that reading it whole is a real cost. */
function leaseText(): string {
  const parts = [
    "COMMERCIAL LEASE AGREEMENT",
    "",
    "1. Definitions",
    '1.1 "Rent" means the annual basic rent payable under Section 3.',
    '1.2 "Business Day" means a day other than a Saturday, Sunday or statutory holiday in Ontario.',
    "",
    "2. Demise",
    "2.1 The Landlord leases the Premises to the Tenant for the Term.",
    "",
    "3. Rent",
    "3.1 The Tenant shall pay Rent of $117,000 per annum, in equal monthly instalments of $9,750, on the first day of each month.",
    "3.2 The Landlord may increase the Rent once in any twelve-month period.",
    "3.3 Rent is payable without deduction, abatement or set-off.",
    "",
  ];
  for (let i = 4; i <= 40; i++) {
    parts.push(`${i}. Covenant ${i}`);
    for (let j = 1; j <= 4; j++) {
      parts.push(
        `${i}.${j} The Tenant shall observe covenant ${i}.${j} and shall not permit any act or omission that would render the Premises liable to forfeiture, and shall indemnify the Landlord against all claims arising from any such act or omission, whether by the Tenant, its employees, agents, invitees or licensees.`,
      );
    }
    parts.push("");
  }
  return parts.join("\n");
}

// Phrased the way a client would actually ask, with no hint about which tool
// to use — naming the tools would prove nothing. Each ask still has a thrifty
// path and a wasteful one: (1) is answerable from a search hit or by hauling
// in the whole lease; (2) only works if the email was decoded; (3) targets
// wording that appears in several clauses, so a first edit attempt should
// miss and come back with the real surrounding text, and the question is
// whether one more try fixes it.
const PROMPT = [
  "A few quick questions, short answers are fine.",
  "",
  "1. What rent does the lease require, and what is the monthly payment? Quote the clause word for word.",
  "2. My client's parents gave her money toward the down payment on the house. How much was it?",
  "3. We are renaming Rent to Base Rent in the lease, but only in the clause that sets out the payment — nowhere else. Please make that change with track changes turned on.",
].join("\n");

async function main() {
  const model = argument("model", "codex:gpt-5.6-luna");
  const effort = argument("effort", "low");
  if (!process.env.LEAN_SMOKE_CHILD) {
    const dataHome = mkdtempSync(path.join(os.tmpdir(), "beaver-lean-smoke-"));
    const child = spawnSync(
      process.execPath,
      [require.resolve("tsx/cli"), __filename, ...process.argv.slice(2)],
      {
        env: {
          ...process.env,
          LEAN_SMOKE_CHILD: "1",
          NODE_ENV: "",
          AUTH_MODE: "local",
          OPEN_LEGAL_DATA_HOME: dataHome,
          MIKE_LOCAL_DATA_DIR: path.join(dataHome, "apps", "mike", "library"),
          SUPABASE_URL: "",
          SUPABASE_SECRET_KEY: "",
          MIKE_LLM_METRICS_PATH: path.join(dataHome, "llm-metrics.jsonl"),
        },
        stdio: "inherit",
        timeout: 10 * 60_000,
      },
    );
    process.exit(child.status ?? 1);
  }

  const { api } = await import("../src/api");
  const request = (await import("supertest")).default;
  const { Document, Packer, Paragraph, TextRun } = await import("docx");

  const lease = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: leaseText()
            .split("\n")
            .map((line) => new Paragraph({ children: [new TextRun(line)] })),
        },
      ],
    }),
  );

  console.log("uploading commercial-lease.docx + client-email.eml …");
  for (const [name, bytes] of [
    ["commercial-lease.docx", lease],
    ["client-email.eml", readFileSync(EML_FIXTURE)],
  ] as [string, Buffer][]) {
    const upload = await request(api)
      .post("/single-documents")
      .attach("file", bytes, name);
    if (upload.status !== 201)
      throw new Error(`upload ${name}: ${upload.status} ${upload.text}`);
  }

  console.log(
    `asking ${model} (effort ${effort}) …\n`,
  );
  const started = Date.now();
  const streamed = await request(api).post("/chat").send({
    model,
    reasoning_effort: effort,
    expected_version: 0,
    current_turn: { kind: "message", content: PROMPT },
  });
  const seconds = (Date.now() - started) / 1000;
  if (streamed.status !== 200)
    throw new Error(`/chat: ${streamed.status} ${streamed.text}`);

  const events = sseEvents(streamed.text);
  const calls = events
    .filter((e) => e.type === "tool_activity" && e.status === "running")
    .map((e) => String(e.tool ?? ""));
  const answer = events
    .filter((e) => e.type === "content_final")
    .map((e) => String(e.text ?? ""))
    .join("");

  console.log("=".repeat(66));
  console.log(`tool calls (${calls.length}):`);
  calls.forEach((name, i) => console.log(`  ${i + 1}. ${name}`));

  const used = new Set(calls);
  const editTool = "Edit";
  const editCalls = calls.filter((n) => n === editTool).length;
  const locateTools = ["Grep", "Glob"];
  const readTool = "Read";
  const wanted: [string, boolean, string][] = [
    [
      "located the clause instead of reading the lease whole",
      locateTools.some((name) => used.has(name)),
      locateTools.join(" / "),
    ],
    ["scoped or windowed its read", used.has(readTool), readTool],
    ["edited by anchor", used.has(editTool), editTool],
    [
      "recovered from the ambiguous anchor without re-reading",
      editCalls > 0 && editCalls <= 2 && !calls.slice(calls.lastIndexOf(editTool)).includes(readTool),
      `${editCalls} edit call(s)`,
    ],
  ];
  console.log("\nlean behaviours:");
  for (const [label, hit, how] of wanted)
    console.log(`  ${hit ? "YES" : "no "}  ${label}  (${how})`);

  const metricsPath = process.env.MIKE_LLM_METRICS_PATH ?? "";
  if (metricsPath && existsSync(metricsPath)) {
    const rows = readFileSync(metricsPath, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const est = rows.map((row) => Math.ceil((row.rounds ?? []).reduce(
      (sum: number, round: Record<string, number>) => sum +
        (round.instructionsBytes ?? 0) + (round.inputBytes ?? 0) +
        (round.toolBytes ?? 0) + (round.toolResultBytes ?? 0), 0) / 4));
    const out = rows.reduce((s, r) => s + (r.usage?.outputTokens ?? 0), 0);
    const cacheRead = rows.reduce(
      (s, r) => s + (r.usage?.cacheReadInputTokens ?? 0),
      0,
    );
    console.log(
      `\ncontext: ${rows.length} invocation(s), first input ${est[0] ?? "?"} tok, ` +
        `max ${Math.max(...est, 0)} tok, output ${out} tok, cache reads ${cacheRead} tok`,
    );
  }
  console.log(`wall clock: ${seconds.toFixed(1)}s`);
  console.log("=".repeat(66));
  console.log(`\n${answer.trim()}\n`);
}

void main();
