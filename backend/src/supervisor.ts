import "./lib/loadEnv";
import { sizeNativeThreadPool } from "./lib/nativeThreadPool";
import { fork, type ChildProcess } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createJobNotificationRelay } from "./lib/jobNotifications";

// The size only counts in the environment a process is spawned with (on Windows
// libuv reads the C runtime's copy, which process.env writes never reach), so
// the supervisor sets it and both services inherit it.
sizeNativeThreadPool();

const services = ["index", "worker"] as const;
const children = new Map<string, ChildProcess>();
const notifications = createJobNotificationRelay();
let stopping = false;

function publishListener(child: ChildProcess) {
  const target = process.env.MIKE_SUPERVISOR_STATE_FILE;
  if (!target || !child.pid) return;
  const temporary = `${target}.${process.pid}.new`;
  writeFileSync(temporary, JSON.stringify({ rootPid: process.pid,
    listenerPid: child.pid }), { mode: 0o600 });
  renameSync(temporary, target);
}

function launch(service: typeof services[number]) {
  const child = fork(path.join(__dirname, `${service}.js`), [], {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  children.set(service, child);
  const detachNotifications = notifications.attach(child);
  child.on("message", (message) => {
    if (service === "index" &&
        (message as { type?: unknown })?.type === "ready") {
      publishListener(child);
      if (!children.has("worker")) launch("worker");
    }
  });
  child.once("error", (error) => console.error(
    `[supervisor] ${service} process error`, error,
  ));
  child.once("close", (code, signal) => {
    detachNotifications();
    if (children.get(service) === child) children.delete(service);
    if (stopping) return;
    console.error(`[supervisor] ${service} exited; restarting`, {
      code, signal,
    });
    setTimeout(() => launch(service), 500);
  });
}

async function stop() {
  if (stopping) return;
  stopping = true;
  const active = [...children.values()];
  active.forEach((child) => child.connected ? child.disconnect() : child.kill());
  await Promise.race([
    Promise.all(active.map((child) => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("close", () => resolve())))),
    new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
  ]);
  active.forEach((child) => { if (child.exitCode === null) child.kill(); });
}

launch("index");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void stop().then(() => process.exit(0)));
}
