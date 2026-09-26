import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, vi } from "vitest";

vi.resetModules();
vi.useRealTimers();
const environment = { ...process.env };
const dataHome = mkdtempSync(join(tmpdir(), "beaver-test-"));
process.env.OPEN_LEGAL_DATA_HOME = dataHome;
afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    if (dirname(resolve(dataHome)) !== resolve(tmpdir())) throw new Error("Unexpected test data path");
    rmSync(dataHome, { recursive: true, force: true });
});
