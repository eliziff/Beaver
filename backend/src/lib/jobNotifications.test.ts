import { afterEach, expect, it, vi } from "vitest";
import { createJobNotifications, createJobNotificationSender, watchJobChanges } from "./jobNotifications";

afterEach(() => vi.useRealTimers());

it("does not lose a change between a database read and its subsequent wait", async () => {
  vi.useFakeTimers();
  const notifications = createJobNotifications();
  const watch = watchJobChanges(notifications, ["events:one"]);
  const version = watch.version;
  notifications.publish("events:one");
  await watch.wait(version, new AbortController().signal);
  expect(vi.getTimerCount()).toBe(0);
  watch.close();
});

it("wakes only the affected job and tears down waiters on abort/close", async () => {
  vi.useFakeTimers();
  const notifications = createJobNotifications();
  const watch = watchJobChanges(notifications, ["control:one"]);
  const abort = new AbortController(), resolved = vi.fn();
  const waiting = watch.wait(watch.version, abort.signal).then(resolved);
  notifications.publish("control:two");
  await Promise.resolve();
  expect(resolved).not.toHaveBeenCalled();
  abort.abort(); await waiting;
  expect(vi.getTimerCount()).toBe(0);
  const closed = watch.wait(watch.version, new AbortController().signal);
  watch.close(); await closed;
  expect(vi.getTimerCount()).toBe(0);
});

it("retains a one-second recovery read when a notification is lost", async () => {
  vi.useFakeTimers();
  const watch = watchJobChanges(undefined, ["events:one"]), resolved = vi.fn();
  const waiting = watch.wait(watch.version, new AbortController().signal).then(resolved);
  await vi.advanceTimersByTimeAsync(999);
  expect(resolved).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await waiting;
  expect(resolved).toHaveBeenCalledOnce();
  watch.close();
});

it("ignores malformed messages and never rebroadcasts received hints", () => {
  const send = vi.fn(), notifications = createJobNotifications(send), wake = vi.fn();
  const off = notifications.subscribe(["events:one"], wake);
  notifications.receiveMessage({ type: "beaver.jobs.changed", topics: ["private-document-content"] });
  notifications.receiveMessage({ type: "other", topics: null });
  expect(wake).not.toHaveBeenCalled();
  notifications.receiveMessage({ type: "beaver.jobs.changed", topics: ["events:one"] });
  expect(wake).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
  off(); notifications.receive(null);
  expect(wake).toHaveBeenCalledOnce();
});

it("coalesces hint storms and bounds the transport backlog while a send is blocked", async () => {
  vi.useFakeTimers();
  const sent: unknown[] = [], callbacks: (() => void)[] = [];
  const channel = createJobNotificationSender((message, done) => { sent.push(message); callbacks.push(done); });
  channel.send(["events:first"]); await vi.runOnlyPendingTimersAsync();
  for (let index = 0; index < 10_000; index++) channel.send([`events:${index}`]);
  await vi.runOnlyPendingTimersAsync();
  expect(sent).toHaveLength(1);
  callbacks[0](); await vi.runOnlyPendingTimersAsync();
  expect(sent).toEqual([
    { type: "beaver.jobs.changed", topics: ["events:first"] },
    { type: "beaver.jobs.changed", topics: null },
  ]);
  channel.close(); callbacks[1]();
  expect(vi.getTimerCount()).toBe(0);
});
