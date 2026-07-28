/**
 * Arm B driver for the Harvey LAB harness-comparison experiment
 * (benchmarks/lab/PROTOCOL.md). Drives Beaver's real /chat route in-process
 * (express + supertest — the same transport as scripts/eval-beaver-arm.ts)
 * on one LAB task: uploads the task documents through /single-documents,
 * plays the task instructions as a single chat turn, and writes LAB-layout
 * results (config.json / metrics.json / transcript.jsonl / output/) so
 * harvey-labs' evaluation.run_eval judges this run exactly like a
 * reference-harness run.
 *
 * Deviations, recorded in beaver-receipts.json per run:
 *  - Documents outside ALLOWED_DOCUMENT_TYPES (e.g. .eml) are wrapped as
 *    .docx before upload — content unchanged, Beaver has no ingester for them.
 *  - Deliverables prefer documents Beaver authored itself via its
 *    library_create_docx tool (harvested from doc_created SSE events and
 *    downloaded through the real /single-documents API); when the turn
 *    creates none, the answer text is exported to the required filename
 *    (.docx via the docx package, .md/.txt verbatim). Tasks needing
 *    spreadsheet/slide deliverables are out of scope for this arm.
 *  - Token counts are context-manifest estimates (bytes/4), not API usage —
 *    the chat SSE stream does not report usage.
 *
 * Usage (spawns itself into the isolated anonymous-mode environment):
 *   npx tsx scripts/lab-beaver-arm.ts \
 *     --task trusts-estates-private-client/extract-client-intake-facts/scenario-01 \
 *     --model codex:gpt-5.6-sol [--lab-root <dir>] [--run-id <id>]
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return value;
}

const DEFAULT_LAB_ROOT = "C:/Users/elias/Desktop/harvey-labs";

// Mirror of ALLOWED_DOCUMENT_TYPES (src/lib/documentTypes.ts) minus images —
// images can't carry LAB document content.
const UPLOADABLE = new Set(["pdf", "docx", "doc", "xlsx", "xlsm", "xls", "pptx", "ppt"]);

type SseEvent = { type?: string; [key: string]: unknown };

function sseEvents(body: string): SseEvent[] {
  return body
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as SseEvent);
}

const visibleText = (events: SseEvent[]) =>
  events
    .filter((event) => event.type === "content_delta")
    .map((event) => String(event.text ?? ""))
    .join("");

const toolCalls = (events: SseEvent[]) =>
  events
    .filter((event) => event.type === "tool_call_start")
    .map((event) => String(event.name ?? ""));

const docsCreated = (events: SseEvent[]) =>
  events
    .filter((event) => event.type === "doc_created" && event.download_url)
    .map((event) => ({
      filename: String(event.filename ?? ""),
      downloadUrl: String(event.download_url),
    }));

async function main() {
  const task = argument("task");
  const model = argument("model", "codex:gpt-5.6-sol");
  const effort = argument("effort", "medium");
  const labRoot = argument("lab-root", DEFAULT_LAB_ROOT);
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/gu, "-")
    .slice(0, 19);
  const runId = argument(
    "run-id",
    `${task}/beaver-${model.replace(/[:./]/gu, "-")}/${timestamp}`,
  );

  // Re-spawn into the isolated anonymous-mode environment (same recipe as
  // scripts/eval-run.ts) so the in-process app binds to a fresh data home.
  if (!process.env.LAB_BEAVER_ARM_CHILD) {
    const dataHome = mkdtempSync(path.join(os.tmpdir(), "lab-beaver-arm-"));
    const child = spawnSync(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        __filename,
        ...process.argv.slice(2),
        "--run-id",
        runId,
      ],
      {
        env: {
          ...process.env,
          LAB_BEAVER_ARM_CHILD: "1",
          NODE_ENV: "",
          AUTH_MODE: "anonymous",
          OPEN_LEGAL_DATA_HOME: dataHome,
          MIKE_LOCAL_DATA_DIR: path.join(dataHome, "apps", "mike", "library"),
          SUPABASE_URL: "",
          SUPABASE_SECRET_KEY: "",
          MIKE_LLM_CONTEXT_MANIFEST_PATH: path.join(dataHome, "manifest.jsonl"),
        },
        stdio: "inherit",
        timeout: 30 * 60_000,
      },
    );
    process.exit(child.status ?? 1);
  }

  const taskDir = path.join(labRoot, "tasks", ...task.split("/"));
  const config = JSON.parse(
    readFileSync(path.join(taskDir, "task.json"), "utf8"),
  ) as {
    title: string;
    instructions?: string;
    criteria: { deliverables?: string[] }[];
  };
  const instructions =
    config.instructions ??
    readFileSync(path.join(taskDir, "instructions.md"), "utf8");
  const docsDir = path.join(taskDir, "documents");
  const documents = readdirSync(docsDir, { recursive: true, encoding: "utf8" })
    .map((rel) => rel.replace(/\\/gu, "/"))
    .filter((rel) => !rel.endsWith("/"))
    .filter((rel) => existsSync(path.join(docsDir, rel)));

  const deliverables = [
    ...new Set(config.criteria.flatMap((c) => c.deliverables ?? [])),
  ];
  const unsupported = deliverables.filter(
    (name) => !/\.(docx|md|txt)$/iu.test(name),
  );
  if (unsupported.length)
    throw new Error(
      `deliverables out of scope for the beaver arm: ${unsupported.join(", ")}`,
    );

  const { app } = await import("../src/app");
  const request = (await import("supertest")).default;

  // Hold information access constant with Arm A's sealed (--network=none)
  // sandbox: remove the online legal-research tools from the advertised
  // list, in place — the chat route reads this array by reference at
  // request time. Beaver's library/docx/text orchestration stays; that is
  // the harness under test.
  const { LOCAL_ASSISTANT_TOOLS } = await import(
    "../src/lib/chat/localAssistantTools"
  );
  const { COURTLISTENER_TOOLS } = await import(
    "../src/lib/chat/tools/courtlistenerTools"
  );
  const { A2AJ_TOOLS } = await import("../src/lib/chat/tools/a2ajTools");
  const { PUBLIC_LEGAL_SOURCE_TOOLS } = await import(
    "../src/lib/chat/tools/publicLegalSourceTools"
  );
  const researchToolNames = new Set(
    [...COURTLISTENER_TOOLS, ...A2AJ_TOOLS, ...PUBLIC_LEGAL_SOURCE_TOOLS].map(
      (schema: { function: { name: string } }) => schema.function.name,
    ),
  );
  for (let i = LOCAL_ASSISTANT_TOOLS.length - 1; i >= 0; i -= 1) {
    if (researchToolNames.has(LOCAL_ASSISTANT_TOOLS[i].function.name))
      LOCAL_ASSISTANT_TOOLS.splice(i, 1);
  }
  const { Document, Packer, Paragraph, TextRun } = await import("docx");
  const textToDocx = (text: string) =>
    Packer.toBuffer(
      new Document({
        sections: [
          {
            children: text
              .split(/\r?\n/u)
              .map((line) => new Paragraph({ children: [new TextRun(line)] })),
          },
        ],
      }),
    );

  const started = Date.now();
  const wrappedUploads: string[] = [];
  for (const rel of documents) {
    const bytes = readFileSync(path.join(docsDir, rel));
    const base = path.basename(rel);
    const extension = path.extname(base).slice(1).toLowerCase();
    let uploadName = base;
    let uploadBytes: Buffer = bytes;
    if (!UPLOADABLE.has(extension)) {
      uploadName = `${path.basename(base, path.extname(base))}.docx`;
      uploadBytes = await textToDocx(bytes.toString("utf8"));
      wrappedUploads.push(base);
    }
    const upload = await request(app)
      .post("/single-documents")
      .attach("file", uploadBytes, uploadName);
    if (upload.status !== 201)
      throw new Error(`upload ${base}: ${upload.status} ${upload.text}`);
  }

  const streamed = await request(app).post("/chat").send({
    model,
    reasoning_effort: effort,
    expected_version: 0,
    current_turn: { kind: "message", content: instructions },
  });
  if (streamed.status !== 200)
    throw new Error(`/chat: ${streamed.status} ${streamed.text}`);
  const events = sseEvents(streamed.text);
  const answer = visibleText(events);
  const calls = toolCalls(events);
  const created = docsCreated(events);
  if (!answer.trim()) throw new Error("empty assistant answer");
  const wallClock = (Date.now() - started) / 1000;

  const runDir = path.join(labRoot, "results", ...runId.split("/"));
  const outputDir = path.join(runDir, "output");
  mkdirSync(outputDir, { recursive: true });

  // Prefer documents Beaver authored itself: exact filename match, then a
  // same-extension 1:1 pairing (a user renaming on export), then the answer
  // text as last resort.
  const unclaimed = [...created];
  const deliverableSources: Record<string, string> = {};
  for (const name of deliverables) {
    const extension = path.extname(name).toLowerCase();
    const exact = unclaimed.findIndex((doc) => doc.filename === name);
    const sameExt = unclaimed.filter(
      (doc) => path.extname(doc.filename).toLowerCase() === extension,
    );
    const pick =
      exact >= 0 ? exact : sameExt.length === 1 ? unclaimed.indexOf(sameExt[0]) : -1;
    const target = path.join(outputDir, name);
    if (pick >= 0) {
      const doc = unclaimed.splice(pick, 1)[0];
      const download = await request(app)
        .get(doc.downloadUrl)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        });
      if (download.status !== 200)
        throw new Error(`download ${doc.filename}: ${download.status}`);
      writeFileSync(target, download.body as Buffer);
      deliverableSources[name] = `library:${doc.filename}`;
    } else if (/\.docx$/iu.test(name)) {
      writeFileSync(target, await textToDocx(answer));
      deliverableSources[name] = "answer_text";
    } else {
      writeFileSync(target, answer, "utf8");
      deliverableSources[name] = "answer_text";
    }
  }

  // Real usage from the context-manifest receipts (each streamChatWithTools
  // call appends one entry with provider-reported usage); the byte-based
  // inputEstimate is the fallback for entries that died before usage.
  let inputTokens = 0;
  let outputTokens = 0;
  let tokenSource = "context_manifest_usage";
  const manifestPath = process.env.MIKE_LLM_CONTEXT_MANIFEST_PATH ?? "";
  if (manifestPath && existsSync(manifestPath)) {
    for (const line of readFileSync(manifestPath, "utf8").split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as {
        usage?: { inputTokens?: number; outputTokens?: number } | null;
        inputEstimate?: { tokens?: number };
      };
      if (entry.usage?.inputTokens != null) {
        inputTokens += entry.usage.inputTokens;
        outputTokens += entry.usage.outputTokens ?? 0;
      } else {
        inputTokens += entry.inputEstimate?.tokens ?? 0;
        tokenSource = "context_manifest_mixed_estimate";
      }
    }
  }

  writeFileSync(
    path.join(runDir, "config.json"),
    JSON.stringify(
      {
        model,
        task,
        run_id: runId,
        harness: "beaver-chat",
        reasoning_effort: effort,
        max_turns: 1,
        started_at: new Date(started).toISOString(),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(runDir, "metrics.json"),
    JSON.stringify(
      {
        model,
        task,
        run_id: runId,
        turn_count: 1,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        token_source: tokenSource,
        wall_clock_seconds: Math.round(wallClock * 100) / 100,
        finished_cleanly: true,
        completed_at: new Date().toISOString(),
        documents_read: documents.length,
        total_documents: documents.length,
        documents_skipped: 0,
        documents_read_list: documents,
        documents_skipped_list: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(runDir, "transcript.jsonl"),
    `${JSON.stringify({
      turn: 1,
      role: "assistant",
      text: answer.slice(0, 500),
      tool_calls: calls.length ? calls.map((name) => ({ name })) : null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    })}\n`,
  );
  writeFileSync(
    path.join(runDir, "beaver-receipts.json"),
    JSON.stringify(
      {
        answer,
        tool_calls: calls,
        wrapped_uploads: wrappedUploads,
        deliverables,
        docs_created: created.map((doc) => doc.filename),
        deliverable_sources: deliverableSources,
        research_tools_removed: [...researchToolNames].sort(),
        deviations: {
          uploads_wrapped_as_docx: wrappedUploads,
        },
      },
      null,
      2,
    ),
  );

  console.log(`beaver arm complete: ${runId}`);
  console.log(`  tool calls: ${calls.join(", ") || "(none)"}`);
  console.log(`  answer chars: ${answer.length}, ~${outputTokens} tokens out`);
  console.log(`  results: ${runDir}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[lab-beaver-arm]", error);
  process.exit(1);
});
