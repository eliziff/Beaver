import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import publicEvents from "../../../../shared/test-fixtures/assistant-events.json";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-turn-events-"));
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
});
afterEach(async () => {
  await (await import("../relationalDatabase")).closeRelationalDatabase();
  vi.unstubAllEnvs(); vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});

it("durably replays a busy turn event stream in exact order", async () => {
  const queue = await import("../jobQueue");
  const transport = await import("../jobQueue");
  const job = await queue.enqueueJob({
    kind: "chat.turn", dedupeKey: "events", userId: "owner", payload: {},
  });
  const writer = await transport.createJobEventWriter(job.id);
  const expected = [...publicEvents, ...Array.from({ length: 1100 }, (_, index) => ({
    type: "tool_activity", id: `read-${index}`, tool: "Read",
    label: `Read ${index}`, status: "completed",
  }))];
  for (const event of expected) writer.append(event);
  await writer.flush();
  await queue.requestJobCancellation(job.id, "owner");
  const events = await transport.readJobEvents("owner", job.id, 0);
  expect(events).toHaveLength(500);
  expect(events.map(({ sequence }) => sequence)).toEqual(
    Array.from({ length: events.length }, (_, index) => index + 1),
  );
  const { durableChatTurns } = await import("../chatTurnQueue");
  const replayed: unknown[] = [];
  await durableChatTurns.observe({ userId: "owner" }, job.id,
    new AbortController().signal, (event) => replayed.push(event));
  expect(replayed).toEqual(expected);
  await expect(transport.readJobEvents("other", job.id, 0))
    .resolves.toEqual([]);
});

it.each([
  { type: "content_final", text: "Missing citations" },
  { type: "subagent_run", id: "reader", task: "Read", status: "completed", resume: { continuation_id: "secret" } },
  { type: "context_checkpoint", schema_version: 1, keep_current: true, summary: "private" },
])("rejects malformed or private events before replay: $type", async (event) => {
  const { enqueueJob, createJobEventWriter, requestJobCancellation } = await import("../jobQueue");
  const { durableChatTurns } = await import("../chatTurnQueue");
  const job = await enqueueJob({ kind: "chat.turn", dedupeKey: "invalid", userId: "owner", payload: {} });
  const writer = await createJobEventWriter(job.id);
  writer.append(event);
  await writer.flush();
  await requestJobCancellation(job.id, "owner");
  const replayed: unknown[] = [];
  await expect(durableChatTurns.observe({ userId: "owner" }, job.id,
    new AbortController().signal, (item) => replayed.push(item))).rejects.toThrow();
  expect(replayed).toEqual([]);
});

it("reattaches a retried send to the job identified by its turn id", async () => {
  const { durableChatTurns } = await import("../chatTurnQueue");
  const scope = { userId: "owner" };
  const input = {
    expected_version: 0,
    current_turn: { kind: "message" as const, content: "hello",
      turn_id: "10000000-0000-4000-8000-000000000001" },
    edit_mode: "manual" as const,
    subagent_mode: "none" as const,
    activity_detail: "auto" as const,
  };
  const first = await durableChatTurns.enqueue(scope, input);
  const retry = await durableChatTurns.enqueue(scope, input);
  expect(retry).toMatchObject({ created: true, job: { id: first.job.id } });
});
