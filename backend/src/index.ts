import { app } from "./app";
import { acquireAnonymousRuntimeLock } from "./lib/anonymousRuntimeLock";
import { runtime } from "./runtime";

const PORT = process.env.PORT ?? 3001;
const releaseRuntimeLock = runtime.mode === "anonymous-local"
  ? acquireAnonymousRuntimeLock()
  : () => undefined;

function warmLocalStores() {
  if (runtime.mode !== "anonymous-local") return;
  void Promise.all([
    import("./lib/localApplicationDatabase")
      .then(({ warmLocalApplicationDatabase }) => warmLocalApplicationDatabase()),
    import("./lib/localTabularStore").then(({ localTabularStore }) => localTabularStore()),
    import("./lib/chat/tools/sourceSearchTools").then(({ warmSourceSearchIndexes }) => warmSourceSearchIndexes()),
  ]).catch((error) => console.error("[local] background warmup failed", error));
  void import("./lib/codexCatalog")
    .then(({ getCodexModelCatalog }) => getCodexModelCatalog())
    .catch(() => {});
  void import("./lib/documentProjectionService")
    .then(({ documentProjectionService }) => documentProjectionService.resume())
    .catch((error) => {
      console.error(
        "[local-library] PDF parse recovery failed",
        error instanceof Error ? error.message : String(error),
      );
    });
}

async function start() {
  await runtime.initialize();
  const server = app.listen(PORT, () => {
    console.log(`Beaver backend running on port ${PORT}`);
  });
  server.on("close", releaseRuntimeLock);
  warmLocalStores();
}
void start().catch((error) => {
  releaseRuntimeLock();
  console.error("Beaver backend failed to start", error);
  process.exitCode = 1;
});
