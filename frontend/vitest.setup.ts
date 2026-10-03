import { afterEach, vi } from "vitest";

if (typeof window !== "undefined") {
    await import("./vitest.dom.setup");
} else {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
}
