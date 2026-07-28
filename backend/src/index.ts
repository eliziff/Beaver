import { app } from "./app";
import { isAnonymousLocalMode } from "./lib/localMode";
import { acquireAnonymousRuntimeLock } from "./lib/anonymousRuntimeLock";

const PORT = process.env.PORT ?? 3001;
const releaseRuntimeLock = isAnonymousLocalMode()
  ? acquireAnonymousRuntimeLock()
  : () => undefined;

if (isAnonymousLocalMode()) {
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
server.on("close", releaseRuntimeLock);
