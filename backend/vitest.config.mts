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
        isolate: true,
        include: wordIntegration ? wordRuntimeTests : ["src/**/*.test.ts"],
        setupFiles: ["./vitest.setup.ts"],
        pool: "threads",
        env: {
            AUTH_MODE: "cloud",
            MIKE_PDF_LAYOUT_PROVIDER: "none",
            MIKE_PDF_OCR_PROVIDER: "none",
        },
        exclude: ["dist/**", "node_modules/**", ...wordIntegration ? [] : wordRuntimeTests],
        maxWorkers: process.env.CI ? 4 : 1,
        silent: "passed-only",
        testTimeout: process.env.CI ? 20000 : 60000,
        hookTimeout: process.env.CI ? 20000 : 60000,
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov"],
            include: ["src/lib/**"],
            // No-regression RATCHET floor, not a target. src/lib/** spans the
            // tested libs (access, storage keys/dispositions, downloadTokens,
            // userApiKeys provider/env checks, chat doc resolution, safeError,
            // llm model resolution, chat citations, userLookup,
            // documentVersions, userDataCleanup) AND the large, still-untested
            // feature libs (courtlistener, mcp, chat tool dispatch, llm
            // providers, spreadsheet/docx handling), so the global number is
            // still low. Measured on this tree: 11.18% statements, 10.98%
            // branches, 14.43% functions, 10.91% lines. These floors sit just
            // below that (rounded down to whole percents) so CI fails on a
            // *drop*. Floors only go up: when you add tests, raise them in the
            // same PR. Backlog + per-area status: docs/testing-coverage.md.
            thresholds: {
                statements: 11,
                branches: 10,
                functions: 14,
                lines: 10,
            },
        },
    },
});
