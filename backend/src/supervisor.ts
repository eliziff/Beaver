import "./lib/loadEnv";
import { sizeNativeThreadPool } from "./jobLanes";
import { fork, type ChildProcess } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createJobNotificationRelay } from "./lib/jobNotifications";

// The size only counts in the environment a process is spawned with (on Windows
// libuv reads the C runtime's copy, which process.env writes never reach), so
// the supervisor sets it and both services inherit it.
sizeNativeThreadPool();

const services = ["index", "worker"] as const;
type Service = typeof services[number];
// A service has one process, or a restart due, and never both: "waiting" until its
// first launch, "backoff" between an exit and the restart.
type ServiceState =
  | { phase: "waiting" }
  | { phase: "running"; child: ChildProcess }
  | { phase: "backoff"; timer: NodeJS.Timeout }
  | { phase: "stopped" };
const state: Record<Service, ServiceState> =
  { index: { phase: "waiting" }, worker: { phase: "waiting" } };
const notifications = createJobNotificationRelay();

function publishListener(child: ChildProcess) {
  const target = process.env.MIKE_SUPERVISOR_STATE_FILE;
  if (!target || !child.pid) return;
  const temporary = `${target}.${process.pid}.new`;
  writeFileSync(temporary, JSON.stringify({ rootPid: process.pid,
    listenerPid: child.pid }), { mode: 0o600 });
  renameSync(temporary, target);
}

function launch(service: Service) {
  const child = fork(path.join(__dirname, `${service}.js`), [], {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  state[service] = { phase: "running", child };
  const detachNotifications = notifications.attach(child);
  child.on("message", (message) => {
    if (service === "index" &&
        (message as { type?: unknown })?.type === "ready") {
      publishListener(child);
      if (state.worker.phase === "waiting") launch("worker");
    }
  });
  child.once("error", (error) => console.error(
    `[supervisor] ${service} process error`, error,
  ));
  child.once("close", (code, signal) => {
    detachNotifications();
    if (state[service].phase === "stopped") return;
    console.error(`[supervisor] ${service} exited; restarting`, {
      code, signal,
    });
    state[service] = { phase: "backoff", timer: setTimeout(() => launch(service), 500) };
  });
}

async function stop() {
  if (services.every((service) => state[service].phase === "stopped")) return;
  const active = services.flatMap((service) => {
    const current = state[service];
    if (current.phase === "backoff") clearTimeout(current.timer);
    state[service] = { phase: "stopped" };
    return current.phase === "running" ? [current.child] : [];
  });
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
