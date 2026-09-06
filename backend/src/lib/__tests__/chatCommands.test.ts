import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatApplication } from "../chat/chatApplication";
import type { ChatStore } from "../chatStore";

let directory = "";
const workers: Array<{ stop(): Promise<void> }> = [];
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-commands-"));
  vi.stubEnv("AUTH_MODE", "local"); vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.stop()));
  await (await import("../relationalDatabase")).closeRelationalDatabase();
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const input = () => ({ expected_version: 0,
  current_turn: { kind: "message", content: "fixture", turn_id: randomUUID() } });
const chats = { get: async () => null } as unknown as ChatStore;

it("delivers pending steering as soon as the provider becomes ready, and resumes a client tool", async () => {
  const queue = await import("../jobQueue"), { chatTurnJobHandler } = await import("../chatTurnWorker");
  const { durableChatTurns } = await import("../chatTurnQueue");
  const accepted = deferred(), enableControl = deferred(), steered = deferred<string>();
  const clientCall = deferred<string>(), result = deferred<unknown>(), chatId = randomUUID();
  // The only double is the model turn. Real persistence, worker, control loop,
  // event parser, and observer deliver the steering and client result.
  const application = { turn: async (_scope, _input, sink, signal, execution) => {
    expect(sink.claim(chatId)).toBe(true);
    await execution?.onAccepted?.(chatId); accepted.resolve();
    await enableControl.promise;
    sink.setControl({ steer: async message => { steered.resolve(message.text); } });
    result.resolve(await execution!.clientTool!("word.read", {}, signal));
    return { chatId, transcriptVersion: 1 };
  } } as ChatApplication;
  const job = await queue.enqueueJob({ kind: "chat.turn", dedupeKey: "commands", userId: "owner", payload: { input: input() } });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  workers.push(queue.startJobWorker({ "chat.turn": chatTurnJobHandler(application, chats) }));
  const observing = durableChatTurns.observe({ userId: "owner" }, job.id, new AbortController().signal,
    event => { if (event.type === "client_tool_call") clientCall.resolve(event.callId); });
  await accepted.promise;
  await queue.enqueueJobCommand("owner", job.id, "steer", { id: "steer-1", text: "Use the new instructions" });
  enableControl.resolve();
  expect(await steered.promise).toBe("Use the new instructions");
  const callId = await clientCall.promise;
  expect(await queue.enqueueJobCommand("other", job.id, "client_tool_result", { callId, result: "wrong user" })).toBe(false);
  expect(await queue.enqueueJobCommand("owner", job.id, "client_tool_result", { callId, result: "paragraph text" })).toBe(true);
  expect(await result.promise).toBe("paragraph text");
  expect((await observing).status).toBe("succeeded");
  expect(await queue.pendingJobCommands(job.id)).toEqual([]);
});

it("cancels a turn waiting for a client tool without waiting for the tool timeout or heartbeat", async () => {
  const queue = await import("../jobQueue"), { chatTurnJobHandler } = await import("../chatTurnWorker");
  const { durableChatTurns } = await import("../chatTurnQueue");
  const clientCall = deferred(), aborted = deferred(), chatId = randomUUID();
  const application = { turn: async (_scope, _input, sink, signal, execution) => {
    expect(sink.claim(chatId)).toBe(true);
    try { await execution!.clientTool!("word.read", {}, signal); }
    finally { aborted.resolve(); }
    return { chatId, transcriptVersion: 1 };
  } } as ChatApplication;
  const job = await queue.enqueueJob({ kind: "chat.turn", dedupeKey: "cancel", userId: "owner", payload: { input: input() } });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  workers.push(queue.startJobWorker({ "chat.turn": chatTurnJobHandler(application, chats) }));
  const observing = durableChatTurns.observe({ userId: "owner" }, job.id, new AbortController().signal,
    event => { if (event.type === "client_tool_call") clientCall.resolve(); });
  await clientCall.promise;
  await queue.requestJobCancellation(job.id, "owner");
  await aborted.promise;
  expect((await observing).status).toBe("cancelled");
});
