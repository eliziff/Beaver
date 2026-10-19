// Three-arm A/B of how a read numbers a source and a citation names a passage (BEAVER_CITATION_UNITS): "json"
// (paragraph objects with digest ids), "lines" (numbered lines) and "sentences" (numbered sentences). Every arm is the
// one built backend (backend/dist) in its own process and data directory, asked the same questions over its chat API
// as the app asks them. Claims and the passages they cite come from the arm's own database, tokens from its LLM
// metrics file, and a judge model reads each claim against the text it cites.
//
//   node experiments/citation_units_ab/run.mjs [--arms json,lines,sentences] [--model codex:gpt-6-luna]
//     [--effort max] [--judge-model codex:gpt-6.1-sol] [--judge-effort medium] [--repeat 1] [--only jordan,bhasin]
//   node experiments/citation_units_ab/run.mjs --judge receipts/<run>   (judge and summarize a run's turns again)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const here = import.meta.dirname, backend = path.resolve(here, "../../backend");
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const rejudge = option("judge", "") && path.resolve(option("judge"));
// The judge's model calls run as the backend runs them: from its folder, with its environment.
process.chdir(backend);
try { process.loadEnvFile(path.join(backend, ".env")); } catch { /* the shell provides it */ }
const run = rejudge || path.join(here, "receipts", new Date().toISOString().replace(/[:.]/gu, "-"));
const config = rejudge ? JSON.parse(readFileSync(path.join(run, "config.json"), "utf8")) : {
  arms: option("arms", "json,lines,sentences").split(","), model: option("model", "codex:gpt-6-luna"),
  effort: option("effort", "max"), judgeModel: option("judge-model", "codex:gpt-6.1-sol"),
  judgeEffort: option("judge-effort", "medium"), repeat: Number(option("repeat", "1")),
  questions: option("only", "")?.split(",").filter(Boolean) ?? [] };
const { arms, model, effort, judgeModel, judgeEffort, repeat } = config;
const questions = JSON.parse(readFileSync(path.join(here, "questions.json"), "utf8"))
  .filter(({ id }) => !config.questions.length || config.questions.includes(id));
mkdirSync(run, { recursive: true });
if (!rejudge) writeFileSync(path.join(run, "config.json"), JSON.stringify({ ...config,
  questions: questions.map(({ id }) => id) }, null, 2));

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
    const { port } = server.address(); server.close(() => resolve(port));
  });
});
const lines = (file) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];

/** One arm: the built backend with the arm's switch, its own data, metrics and log. */
async function startArm(arm) {
  const directory = path.join(run, arm), port = await freePort();
  mkdirSync(path.join(directory, "data"), { recursive: true });
  const log = path.join(directory, "server.log"), metrics = path.join(directory, "llm-metrics.jsonl");
  const env = { ...process.env, PORT: String(port), MIKE_LOCAL_DATA_DIR: path.join(directory, "data"),
    BEAVER_CITATION_UNITS: arm, MIKE_LLM_METRICS_PATH: metrics };
  delete env.NODE_ENV; // the arm runs its own chat workers
  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "dist/index.js"], { cwd: backend, env });
  child.stdout.on("data", (chunk) => appendFileSync(log, chunk));
  child.stderr.on("data", (chunk) => appendFileSync(log, chunk));
  const origin = `http://127.0.0.1:${port}`;
  for (let tries = 0; ; tries++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* starting */ }
    if (tries > 240 || child.exitCode !== null) throw new Error(`${arm} did not start; see ${log}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { arm, directory, origin, child, log, metrics };
}

const api = async (origin, route, body) => {
  const response = await fetch(`${origin}/api${route}`, body === undefined ? undefined
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response;
};

/** One question, asked in a fresh chat as the app asks it; the stream ends when the turn does. */
async function ask(server, question) {
  const { id: chatId } = await (await api(server.origin, "/chat/create", {})).json();
  const before = { metrics: lines(server.metrics).length, log: lines(server.log).length }, started = Date.now();
  const response = await api(server.origin, "/chat", { chat_id: chatId, expected_version: 0, model,
    reasoning_effort: effort, current_turn: { kind: "message", content: question.question } });
  await response.text();
  for (let tries = 0; tries < 600; tries++) {
    const detail = await (await api(server.origin, `/chat/${chatId}?limit=20`)).json();
    if (!detail.chat.turn_in_progress) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const elapsed = Date.now() - started;
  const usage = lines(server.metrics).slice(before.metrics).map((line) => JSON.parse(line).usage ?? {});
  const total = (key) => usage.reduce((sum, item) => sum + (item[key] ?? 0), 0);
  const input = total("inputTokens"), cached = total("cacheReadInputTokens"), output = total("outputTokens");
  const logged = lines(server.log).slice(before.log);
  return { chatId, elapsedMs: elapsed, tokens: { input, cached, output,
    cacheAdjusted: Math.round(input - cached + 0.1 * cached + output) },
    toolFailures: logged.filter((line) => line.includes("[assistant-tool] failed")).length,
    groundingRejections: logged.filter((line) => line.includes("[assistant-tool] failed") && line.includes("claims[")).length };
}

/** The turn's answer, claims and cited passages, from the arm's own database. */
function answerOf(server, chatId) {
  const db = new DatabaseSync(path.join(server.directory, "data", "application.sqlite"), { readOnly: true });
  try {
    const events = db.prepare(`select e.event from chat_message_events e join chat_messages m on m.id = e.message_id
      where m.chat_id = ? and m.role = 'assistant' order by m.created_at, e.ordinal`).all(chatId)
      .map(({ event }) => JSON.parse(event));
    const grounding = events.filter((event) => event.type === "legal_evidence_receipt").at(-1);
    const text = events.filter((event) => event.type === "content").map((event) => event.text).join("\n");
    const evidence = new Map((grounding?.evidence ?? []).map((receipt) => [receipt.evidence_id, receipt]));
    return { status: grounding?.status ?? "none", text, claims: (grounding?.claims ?? []).map((claim) => ({
      text: claim.text, evidence: claim.evidence_ids.map((id) => evidence.get(id)).filter(Boolean)
        .map((receipt) => ({ id: receipt.evidence_id, locator: receipt.locator, text: receipt.span_text ?? "" })) })) };
  } finally { db.close(); }
}

const words = (text) => text.match(/\S+/gu)?.length ?? 0;
const require = createRequire(path.join(backend, "package.json"));
let llm;
/** Whether the cited text alone supports the claim: full, partial or none. */
async function judge(claim) {
  llm ??= require("./dist/lib/llm/index.js");
  const prompt = `Claim: ${claim.text}\n\nCited source text:\n${claim.evidence.map(({ text }) => text).join("\n---\n")}` +
    "\n\nDoes the cited text alone support everything the claim asserts? Answer one word: full, partial, or none.";
  const answer = await Promise.race([
    llm.completeText({ model: judgeModel, reasoningEffort: judgeEffort, user: prompt, maxTokens: 16 }),
    new Promise((resolve) => setTimeout(() => resolve("timed out"), 180_000))]);
  return ["full", "partial", "none"].find((word) => answer.trim().toLowerCase().startsWith(word)) ?? "unreadable";
}

const results = rejudge ? readFileSync(path.join(run, "turns.jsonl"), "utf8").split("\n").filter(Boolean)
  .map((line) => JSON.parse(line)) : [];
if (!rejudge) await Promise.all(arms.map(async (arm) => {
  const server = await startArm(arm);
  try {
    for (let round = 1; round <= repeat; round++) for (const question of questions) {
      const asked = await ask(server, question).catch((error) => ({ error: String(error) }));
      const answer = asked.chatId ? answerOf(server, asked.chatId) : { status: "error", text: "", claims: [] };
      const row = { arm, question: question.id, round, ...asked, ...answer };
      results.push(row);
      appendFileSync(path.join(run, "turns.jsonl"), JSON.stringify(row) + "\n");
      console.log(arm, question.id, round, answer.status, `${answer.claims.length} claims`,
        `${Math.round((asked.elapsedMs ?? 0) / 1000)} s`, asked.tokens?.cacheAdjusted ?? "", asked.error ?? "");
    }
  } finally { server.child.kill(); }
}));

for (const row of results) for (const [index, claim] of row.claims.entries()) {
  claim.verdict = claim.evidence.length ? await judge(claim) : "none";
  console.log("judged", row.arm, row.question, row.round, `claim ${index + 1}/${row.claims.length}:`, claim.verdict);
}
writeFileSync(path.join(run, "results.json"), JSON.stringify(results, null, 1));

const table = arms.map((arm) => {
  const rows = results.filter((row) => row.arm === arm), claims = rows.flatMap((row) => row.claims),
    cited = claims.flatMap((claim) => claim.evidence), count = (verdict) => claims.filter((claim) => claim.verdict === verdict).length,
    mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return `| ${arm} | ${rows.filter((row) => row.status === "passed").length}/${rows.length} | ${claims.length} | ` +
    `${count("full")} / ${count("partial")} / ${count("none")} | ${mean(cited.map(({ text }) => words(text))).toFixed(0)} | ` +
    `${mean(claims.map((claim) => claim.evidence.reduce((sum, { text }) => sum + words(text), 0))).toFixed(0)} | ` +
    `${Math.round(mean(rows.map((row) => row.tokens?.cacheAdjusted ?? 0)))} | ${(mean(rows.map((row) => row.elapsedMs ?? 0)) / 1000).toFixed(0)} s | ` +
    `${rows.reduce((sum, row) => sum + (row.groundingRejections ?? 0), 0)} / ${rows.reduce((sum, row) => sum + (row.toolFailures ?? 0), 0)} |`;
});
const summary = [`Model ${model} (${effort}); judge ${judgeModel} (${judgeEffort}); ${questions.length} questions × ${repeat}.`, "",
  "| arm | grounded turns | claims | judge full / partial / none | words per citation | words cited per claim | cache-adj tokens per turn | wall clock per turn | grounding rejections / tool failures |",
  "|---|---|---|---|---|---|---|---|---|", ...table].join("\n");
writeFileSync(path.join(run, "summary.md"), summary + "\n");
console.log(`\n${summary}\n\n${run}`);
