import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeEach, expect, vi } from "vitest";

vi.resetModules();
vi.useRealTimers();
// The application entry loads backend/.env; tests must never inherit a developer's library
// directory or provider credentials from it.
process.loadEnvFile = () => {};
// Nor may they reach a live model unless a run opts in with LIVE_E2E=1: a developer shell's
// provider keys and installed Codex CLI otherwise turn table routing and agent tests into real,
// slow provider runs. This matches CI, which has neither.
if (process.env.LIVE_E2E !== "1") {
    for (const name of Object.keys(process.env)) {
        if (/(?:_API_KEY|_TOKEN|_SECRET|_SECRET_KEY)$/iu.test(name)) delete process.env[name];
    }
    process.env.CODEX_COMMAND = "beaver-test-codex-unavailable";
}
const environment = { ...process.env };
const dataHome = mkdtempSync(join(tmpdir(), "beaver-test-"));
process.env.OPEN_LEGAL_DATA_HOME = dataHome;
delete process.env.MIKE_LOCAL_DATA_DIR;
process.env.BEAVER_TEST_RUN_ID ??= `vitest-${randomUUID()}`;
beforeEach(() => { process.env.BEAVER_TEST_SCENARIO = expect.getState().currentTestName?.slice(0, 300); });
afterAll(async () => {
    // Module isolation does not close the process-wide SQLite worker.
    await (await vi.importActual<typeof import("./src/lib/relationalDatabase")>(
        "./src/lib/relationalDatabase")).closeRelationalDatabase();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    if (dirname(resolve(dataHome)) !== resolve(tmpdir())) throw new Error("Unexpected test data path");
    rmSync(dataHome, { recursive: true, force: true });
});
