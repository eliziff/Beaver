import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@/app/lib/runtimeConfig";

const runtime = globalThis as typeof globalThis & {
    __beaverRuntimeConfig?: RuntimeConfig;
};
const configured = runtime.__beaverRuntimeConfig;

afterEach(() => {
    runtime.__beaverRuntimeConfig = configured;
    vi.restoreAllMocks();
});

it("can evaluate route definitions before configuration without starting application requests", async () => {
    vi.resetModules();
    delete runtime.__beaverRuntimeConfig;
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("Application requests must wait for runtime configuration"),
    );
    const { Router } = await import("./router");
    expect(typeof Router).toBe("function");
    expect(request).not.toHaveBeenCalled();
    expect(runtime.__beaverRuntimeConfig).toBeUndefined();
});
