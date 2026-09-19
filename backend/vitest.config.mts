import { defineConfig } from "vitest/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

// Dependencies first loaded under fake clocks must not retain those clocks in another file.
const timerSuites = ["src/**/{jobNotifications,httpStreaming,providerLoop,chatCancellation,chatCommands,jobScheduling,jobEventBatching,localChatStore,memoryApplication}.test.ts"];

export default defineConfig({
    resolve: { alias: [{ find: /^.*\/sqliteWorker$/, replacement: fileURLToPath(new URL("sqliteWorker.js", workerDirectory)) }] },
    test: {
        environment: "node",
        isolate: false,
        projects: [
            { extends: true, test: { name: "application", include: ["src/**/*.test.ts"], exclude: timerSuites } },
            { extends: true, test: { name: "timers", isolate: true, include: timerSuites } },
        ],
        setupFiles: ["./vitest.setup.ts"],
        pool: "forks",
        execArgv: ["--max-old-space-size=256"],
        env: {
            AUTH_MODE: "cloud",
            MIKE_PDF_LAYOUT_PROVIDER: "none",
            MIKE_PDF_OCR_PROVIDER: "none",
        },
        exclude: ["dist/**", "node_modules/**"],
        maxWorkers: 4,
        silent: "passed-only",
        testTimeout: 20000,
        hookTimeout: 20000,
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
