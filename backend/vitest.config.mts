import { selectedTests } from "../scripts/focused-tests.mjs";
import { constants, setPriority } from "node:os";
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// These use the real Python/LibreOffice runtime, owned by word-python.yml.
const wordRuntimeTests = [
    "wordAnnotatedDrawingEdits", "wordControlVerification", "wordFieldRefresh",
    "wordImagePreservation", "wordImageRelationships", "wordInlineControls",
    "wordListSelection", "wordMixedRunComments", "wordMixedRunVerification",
    "wordNumberingCreation", "wordPython", "wordTableCellInsertion",
    "wordTableGridComposition", "wordTextReplacement", "wordUntouchedDrawingRevisions",
].map(name => `src/lib/__tests__/${name}.test.ts`);
const wordIntegration = process.env.BEAVER_WORD_INTEGRATION === "1";

export default defineConfig({
    resolve: { alias: [
        { find: /^(?:mike\/|.*\/)shared\/runtime\/(.*)\.mjs$/,
            replacement: fileURLToPath(new URL("../shared/contracts/$1.mts", import.meta.url)) },
    ] },
    test: {
        environment: "node",
        include: wordIntegration ? wordRuntimeTests : selectedTests(),
        setupFiles: ["./vitest.setup.ts"],
        pool: "threads",
        env: {
            AUTH_MODE: "cloud",
            MIKE_PDF_LAYOUT_PROVIDER: "none",
            MIKE_PDF_OCR_PROVIDER: "none",
        },
        exclude: ["dist/**", "node_modules/**", ...wordIntegration ? [] : wordRuntimeTests],
        maxWorkers: 1,
        silent: "passed-only",
        testTimeout: process.env.CI ? 20000 : 60000,
        hookTimeout: process.env.CI ? 20000 : 60000,
    },
});
