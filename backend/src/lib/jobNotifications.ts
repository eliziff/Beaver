import type { ChildProcess } from "node:child_process";

// Hints contain only job IDs/kinds, never events, commands, or document content.
// The durable tables remain authoritative; losing a hint only delays a re-read.
export type JobNotifications = {
  publish(topic: string): void;
  subscribe(topics: readonly string[], wake: () => void): () => void;
};
type Message = { type: "beaver.jobs.changed"; topics: string[] | null };
const validTopic = (topic: unknown): topic is string => typeof topic === "string" &&
  /^(?:queue|events|control):[^\u0000-\u001f\u007f]{1,100}$/u.test(topic);
const isMessage = (value: unknown): value is Message => {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<Message>;
  return message.type === "beaver.jobs.changed" && (message.topics === null ||
    Array.isArray(message.topics) && message.topics.length <= 256 && message.topics.every(validTopic));
};

export function createJobNotifications(send?: (topics: string[] | null) => void) {
  const listeners = new Map<string, Set<() => void>>();
  const receive = (topics: string[] | null) => {
    const callbacks = new Set(topics === null ? [...listeners.values()].flatMap((set) => [...set])
      : topics.flatMap((topic) => [...listeners.get(topic) ?? []]));
    callbacks.forEach((wake) => wake());
  };
  return {
    publish(topic: string) {
      if (!validTopic(topic)) throw new Error("Invalid job notification topic");
      receive([topic]); send?.([topic]);
    },
    subscribe(topics: readonly string[], wake: () => void) {
      for (const topic of topics) {
        if (!validTopic(topic)) throw new Error("Invalid job notification topic");
        if (!listeners.has(topic)) listeners.set(topic, new Set());
        listeners.get(topic)!.add(wake);
      }
      return () => {
        for (const topic of topics) {
          const set = listeners.get(topic);
          set?.delete(wake);
          if (!set?.size) listeners.delete(topic);
        }
      };
    },
    receive,
    receiveMessage(value: unknown) { if (isMessage(value)) receive(value.topics); },
  };
}

// Bound IPC backlog to one in-flight batch and one coalesced pending batch.
// An overflow is one global wake, not an unbounded queue of messages.
export function createJobNotificationSender(send: (message: Message, done: () => void) => void) {
  let pending = new Set<string>(), all = false, busy = false, closed = false;
  let scheduled: NodeJS.Immediate | undefined;
  const flush = () => {
    scheduled = undefined;
    if (closed || busy || !all && !pending.size) return;
    const topics = all ? null : [...pending];
    pending = new Set(); all = false; busy = true;
    const done = () => { busy = false; schedule(); };
    try { send({ type: "beaver.jobs.changed", topics }, done); } catch { done(); }
  };
  const schedule = () => {
    if (!closed && !busy && !scheduled && (all || pending.size)) {
      scheduled = setImmediate(flush);
      scheduled.unref();
    }
  };
  return {
    send(topics: string[] | null) {
      if (closed) return;
      if (topics === null) all = true;
      else if (!all) for (const topic of topics) pending.add(topic);
      if (pending.size > 256 || Buffer.byteLength(JSON.stringify([...pending])) > 6_000) all = true;
      if (all) pending.clear();
      schedule();
    },
    close() { closed = true; if (scheduled) clearImmediate(scheduled); pending.clear(); },
  };
}

export function localJobNotifications() {
  const outgoing = createJobNotificationSender((message, done) => {
    if (!process.connected || !process.send) return done();
    process.send(message, () => done());
  });
  const notifications = createJobNotifications(outgoing.send);
  const receive = (message: unknown) => { if (isMessage(message)) notifications.receive(message.topics); };
  process.on("message", receive);
  return { ...notifications, close() {
    process.off("message", receive); outgoing.close();
  } };
}

// Only the supervisor's own children may send hints; receiving never re-publishes.
export function createJobNotificationRelay() {
  const peers = new Map<ChildProcess, ReturnType<typeof createJobNotificationSender>>();
  return {
    attach(child: ChildProcess) {
      const outgoing = createJobNotificationSender((message, done) => {
        if (!child.connected) return done();
        child.send(message, () => done());
      });
      peers.set(child, outgoing);
      const receive = (message: unknown) => {
        if (!isMessage(message)) return;
        for (const [peer, channel] of peers) if (peer !== child) channel.send(message.topics);
      };
      child.on("message", receive);
      return () => { child.off("message", receive); peers.delete(child); outgoing.close(); };
    },
  };
}

// Subscribe BEFORE taking the snapshot and reading the database. A change during
// that read increments the version, so the subsequent wait cannot lose its wake.
export function watchJobChanges(notifications: JobNotifications | undefined, topics: string[]) {
  let version = 0, closed = false;
  const waiting = new Set<() => void>();
  const wake = () => { version += 1; waiting.forEach((wake) => wake()); };
  const unsubscribe = notifications?.subscribe(topics, wake);
  return {
    get version() { return version; },
    wake,
    wait(after: number, signal: AbortSignal, milliseconds = 1_000) {
      if (closed || signal.aborted || version !== after) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer); waiting.delete(wake); signal.removeEventListener("abort", wake); resolve();
        };
        const timer = setTimeout(wake, milliseconds);
        timer.unref();
        waiting.add(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    },
    close() { closed = true; unsubscribe?.(); waiting.forEach((wake) => wake()); },
  };
}
