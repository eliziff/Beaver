import { app } from "./app";
import { resumeLocalPdfParses } from "./lib/localPdfIngestion";

const PORT = process.env.PORT ?? 3001;

void resumeLocalPdfParses().catch((error) => {
  console.error(
    "[local-library] PDF parse recovery failed",
    error instanceof Error ? error.message : String(error),
  );
});

app.listen(PORT, () => {
  console.log(`Mike backend running on port ${PORT}`);
});
