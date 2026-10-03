import { constants, setPriority } from "node:os";
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
import { defineConfig } from "vitest/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// These use the real Python/LibreOffice runtime, owned by word-python.yml.
const wordRuntimeTests = [
    "wordAnnotatedDrawingEdits", "wordControlVerification", "wordFieldRefresh",
    "wordImagePreservation", "wordImageRelationships", "wordInlineControls",
    "wordListSelection", "wordMixedRunComments", "wordMixedRunVerification",
    "wordNumberingCreation", "wordPython", "wordTableCellInsertion",
    "wordTableGridComposition", "wordTextReplacement", "wordUntouchedDrawingRevisions",
].map(name => `src/lib/__tests__/${name}.test.ts`);
const wordIntegration = process.env.BEAVER_WORD_INTEGRATION === "1";

// Compile the real SQLite worker once instead of loading tsx for every database fixture.
const workerDirectory = new URL("./.tmp/lib/", import.meta.url);
mkdirSync(workerDirectory, { recursive: true });
for (const name of ["sqliteWorker", "localDatabase", "relational", "jobNotifications"]) {
    const source = readFileSync(new URL(`./src/lib/${name}.ts`, import.meta.url), "utf8");
    writeFileSync(new URL(`${name}.js`, workerDirectory), ts.transpileModule(source, {
        fileName: `${name}.ts`,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
            inlineSourceMap: true, inlineSources: true, sourceRoot: new URL("./src/lib/", import.meta.url).href },
    }).outputText);
}

export default defineConfig({
    resolve: { alias: [{ find: /^.*\/sqliteWorker$/, replacement: fileURLToPath(new URL("sqliteWorker.js", workerDirectory)) }] },
    test: {
        environment: "node",
        isolate: true,
        include: wordIntegration ? wordRuntimeTests : ["src/**/*.test.ts"],
        setupFiles: ["./vitest.setup.ts"],
        pool: "forks",
        execArgv: ["--max-old-space-size=512"],
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
            include: ["src/lib/**", ".tmp/lib/*.js"],
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
