import { assertFrontendBuild, server } from "./server";
import { acquireLocalRuntimeLock } from "./lib/localRuntimeLock";
import { runtime } from "./runtime";
import { safeErrorLog } from "./lib/safeError";

process.umask(0o077);
const PORT = Number.parseInt(process.env.PORT ?? (
  process.env.NODE_ENV === "production" ? "3000" : "3001"
), 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error("PORT must be an integer from 1 to 65535");
}
const releaseRuntimeLock = runtime.mode === "local"
  ? acquireLocalRuntimeLock()
  : () => undefined;

async function start() {
  if (process.env.NODE_ENV === "production") assertFrontendBuild();
  await runtime.initialize();
  const host = runtime.mode === "local" ? "127.0.0.1" : "0.0.0.0";
  const listener = server.listen(PORT, host, () => {
    console.log(`Beaver running on port ${PORT}`);
  });
  listener.maxHeadersCount = 100;
  listener.headersTimeout = 15_000;
  listener.requestTimeout = 5 * 60_000;
  listener.keepAliveTimeout = 5_000;
  listener.maxRequestsPerSocket = 1_000;
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (() => {
    const forceClose = setTimeout(() => listener.closeAllConnections(), 10_000);
    forceClose.unref();
    const closed = new Promise<void>((resolve, reject) => {
      listener.close((error) => error ? reject(error) : resolve());
    });
    return Promise.allSettled([closed, runtime.shutdown()])
      .then((results) => {
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })
      .finally(() => { clearTimeout(forceClose); releaseRuntimeLock(); });
  })();
  const stopOn = (signal: "SIGINT" | "SIGTERM") => process.once(signal, () => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    void stop().catch((error) => console.error(
      "Beaver backend failed to stop", safeErrorLog(error),
    ));
  });
  stopOn("SIGINT");
  stopOn("SIGTERM");
}
void start().catch((error) => {
  releaseRuntimeLock();
  console.error("Beaver backend failed to start", safeErrorLog(error));
  process.exitCode = 1;
});
