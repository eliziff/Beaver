import { app } from "./app";
import { isAnonymousLocalMode } from "./lib/localMode";
import { acquireAnonymousRuntimeLock } from "./lib/anonymousRuntimeLock";

const PORT = process.env.PORT ?? 3001;
const releaseRuntimeLock = isAnonymousLocalMode()
  ? acquireAnonymousRuntimeLock()
  : () => undefined;

async function warmLocalRoutes() {
  const base = `http://127.0.0.1:${PORT}`;
  await Promise.allSettled(
    ["/library/files", "/projects", "/chat", "/models"].map(
      async (route) => {
        try {
          const response = await fetch(`${base}${route}`, {
            signal: AbortSignal.timeout(2_000),
          });
          await response.arrayBuffer();
        } catch {
          // The server is still usable if one optional warmup request fails.
        }
      },
    ),
  );
}

async function start() {
  app.locals.localReady = !isAnonymousLocalMode();
  if (isAnonymousLocalMode()) {
    await Promise.all([
      import("./routes/chat"),
      import("./routes/projects"),
      import("./routes/localDocuments"),
      import("./routes/localLibrary"),
      import("./routes/localUser"),
      import("./routes/models"),
      import("./routes/tableOfAuthorities"),
    ]);
    const [
      { warmLocalDocumentStore },
      { legalKnowledgeGraphStore },
      { localTabularStore },
      { warmSourceSearchIndexes },
    ] = await Promise.all([
      import("./lib/localDocumentStore"),
      import("./lib/legalKnowledgeGraphStore"),
      import("./lib/localTabularStore"),
      import("./lib/chat/tools/sourceSearchTools"),
    ]);
    await Promise.all([
      warmLocalDocumentStore(),
      Promise.resolve(legalKnowledgeGraphStore()),
      Promise.resolve(localTabularStore()),
      Promise.resolve(warmSourceSearchIndexes()),
    ]);
    void import("./lib/codexCatalog")
      .then(({ getCodexModelCatalog }) => getCodexModelCatalog())
      .catch(() => {});
    void import("./lib/localPdfIngestion")
      .then(({ resumeLocalPdfParses }) => resumeLocalPdfParses())
      .catch((error) => {
        console.error(
          "[local-library] PDF parse recovery failed",
          error instanceof Error ? error.message : String(error),
        );
      });
  }
  const server = app.listen(PORT, () => {
    console.log(`Beaver backend running on port ${PORT}`);
  });
  if (isAnonymousLocalMode()) await warmLocalRoutes();
  app.locals.localReady = true;
  server.on("close", releaseRuntimeLock);
}
void start().catch((error) => {
  releaseRuntimeLock();
  console.error("Beaver backend failed to start", error);
  process.exitCode = 1;
});
