import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
  for (let index = 0; index < 500; index += 1) {
    writer.append({ type: "tool_activity", id: `read-${index}`, index });
  }
  await writer.flush();
  const events = await transport.readJobEvents("owner", job.id, 0);
  expect(events).toHaveLength(500);
  expect(events.map(({ sequence }) => sequence)).toEqual(
    Array.from({ length: 500 }, (_, index) => index + 1),
  );
  expect(events.at(-1)?.event).toMatchObject({ id: "read-499", index: 499 });
  await expect(transport.readJobEvents("other", job.id, 0))
    .resolves.toEqual([]);
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
