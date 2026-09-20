import path from "node:path";
import { Worker } from "node:worker_threads";

/** QuickJS runs on an expendable thread: CPU-bound guest code cannot block the
 * application event loop or prevent Stop. Only JSON document calls cross it. */
export function executeWordProgram(program: string,
  rpc: (command: Record<string, unknown>) => Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (!program.trim() || Buffer.byteLength(program) > 100_000)
    return Promise.reject(new Error("Word program must contain 1-100000 bytes"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.resolve(__dirname, "../../scripts/word_console.cjs"), {
      workerData: { program }, resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 },
    });
    let settled = false, calls = 0;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      void worker.terminate().then(() => error ? reject(error) : resolve(value));
    };
    const abort = () => finish(new Error("Word program cancelled"));
    const timer = setTimeout(() => finish(new Error("Word program timed out")), 90_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    worker.on("message", async (message) => {
      if (settled) return;
      if (message.type === "result") return finish(undefined, message.value);
      if (message.type === "error") return finish(new Error(String(message.error).slice(0, 1000)));
      if (message.type !== "rpc" || ++calls > 4000) return finish(new Error("Invalid or excessive console calls"));
      try {
        const value = await rpc(message.command);
        if (!settled) worker.postMessage({ id: message.id, value });
      } catch (error) { finish(error instanceof Error ? error : new Error("Native call failed")); }
    });
    worker.on("error", error => finish(error));
    worker.on("exit", () => { if (!settled) finish(new Error("Word program exited without a result")); });
  });
}
