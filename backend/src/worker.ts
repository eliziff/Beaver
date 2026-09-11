import "./lib/loadEnv";
import { sizeNativeThreadPool } from "./lib/nativeThreadPool";
import { runtime } from "./runtime";
import { safeErrorLog } from "./lib/safeError";

sizeNativeThreadPool();
process.umask(0o077);
let stopping: Promise<void> | undefined;

async function start() {
  await runtime.initialize({ cleanup: false });
  const workers = await runtime.startWorkers();
  const stop = () => stopping ??= workers.stop().then(() => runtime.shutdown())
    .then(() => undefined);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void stop().then(() => process.exit(0)));
  }
  process.once("disconnect", () => void stop().then(() => process.exit(0)));
  process.send?.({ type: "ready" });
}

void start().catch((error) => {
  console.error("Beaver worker failed to start", safeErrorLog(error));
  process.exitCode = 1;
});
