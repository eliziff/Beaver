/**
 * Child-process driver for the beaver_baseline / beaver_candidate arms
 * (docs/beaver-evaluation-context-plan.md §7, Issue 3). Spawned once per arm
 * by scripts/eval-run.ts with an isolated environment:
 *
 *   AUTH_MODE=anonymous            (account-free local transport)
 *   OPEN_LEGAL_DATA_HOME           per-arm temp data home
 *   MIKE_LOCAL_DATA_DIR            per-arm library dir
 *   SUPABASE_URL/SUPABASE_SECRET_KEY empty
 *   MIKE_LLM_CONTEXT_MANIFEST_PATH per-arm jsonl (token/latency receipts)
 *
 * It drives the real /chat route in-process (express + supertest, the same
 * way src/__tests__/integration/liveToolLoop.test.ts does), uploading
 * task_local matter documents as DOCX at the scripted turn that introduces
 * them, then writes a result JSON for the parent. Runs in its own process so
 * every arm gets a fresh app/store bound to its own data home.
 */
import { writeFileSync } from "node:fs";

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

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

async function main() {
  const taskDir = argument("task-dir");
  const model = argument("model");
  const out = argument("out");
  if (process.env.AUTH_MODE !== "anonymous" || !process.env.OPEN_LEGAL_DATA_HOME)
    throw new Error("expected the isolated environment from scripts/eval-run.ts");

  const { loadBeaverCanTaskDir } = await import("../src/lib/beaverCan");
  const { beaverTurnScript } = await import("../src/lib/evalRunner");
  const { app } = await import("../src/app");
  const request = (await import("supertest")).default;
  const { Document, Packer, Paragraph, TextRun } = await import("docx");

  const loaded = loadBeaverCanTaskDir(taskDir);
  const bySourceId = new Map(
    loaded.sources.map((source) => [source.source_id, source]),
  );
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

  let chatId: string | null = null;
  let version = 0;
  const turns: {
    user_text: string;
    uploaded_source_ids: string[];
    assistant_text: string;
    tool_calls: string[];
  }[] = [];
  for (const turn of beaverTurnScript(loaded)) {
    for (const sourceId of turn.uploadSourceIds) {
      const source = bySourceId.get(sourceId);
      if (!source) throw new Error(`unknown upload source ${sourceId}`);
      const upload = await request(app)
        .post("/single-documents")
        .attach("file", await textToDocx(source.text), `${sourceId}.docx`);
      if (upload.status !== 201)
        throw new Error(`upload ${sourceId}: ${upload.status} ${upload.text}`);
    }
    const streamed = await request(app)
      .post("/chat")
      .send({
        model,
        expected_version: version,
        ...(chatId ? { chat_id: chatId } : {}),
        current_turn: { kind: "message", content: turn.text },
      });
    if (streamed.status !== 200)
      throw new Error(`/chat turn ${turns.length + 1}: ${streamed.status} ${streamed.text}`);
    const events = sseEvents(streamed.text);
    chatId =
      events
        .map((event) =>
          event.type === "chat_id" ? String(event.chatId ?? "") : "",
        )
        .find(Boolean) ?? chatId;
    const versions = events
      .filter((event) => event.type === "transcript_version")
      .map((event) => Number(event.transcriptVersion));
    if (versions.length) version = versions[versions.length - 1];
    turns.push({
      user_text: turn.text,
      uploaded_source_ids: turn.uploadSourceIds,
      assistant_text: visibleText(events),
      tool_calls: toolCalls(events),
    });
  }

  writeFileSync(
    out,
    `${JSON.stringify(
      {
        // The deliverable is the final turn's answer; earlier turns are receipts.
        output_text: turns.at(-1)?.assistant_text ?? "",
        uploaded_source_ids: turns.flatMap((turn) => turn.uploaded_source_ids),
        chat_id: chatId,
        transcript_version: version,
        turns,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("[eval-beaver-arm]", error);
  process.exit(1);
});
