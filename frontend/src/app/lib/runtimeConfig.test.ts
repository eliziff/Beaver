import { describe, expect, it, vi } from "vitest";
import { getRuntimeConfig, initializeRuntimeConfig } from "./runtimeConfig";

describe("runtime configuration", () => {
    it("loads the strict same-origin local contract", async () => {
        const request = vi.fn(async () =>
            new Response(JSON.stringify({ mode: "local" })),
        );

        await expect(initializeRuntimeConfig(request)).resolves.toEqual({
            mode: "local",
        });
        expect(request).toHaveBeenCalledWith("/api/config", {
            cache: "no-store",
            headers: { Accept: "application/json" },
        });
        expect(getRuntimeConfig()).toEqual({ mode: "local" });
    });

    it.each([
        { mode: "cloud", supabaseUrl: "not-a-url", supabasePublishableKey: "key" },
        { mode: "local", unexpected: true },
        { mode: "anonymous" },
    ])("rejects invalid or extra configuration fields", async (config) => {
        await expect(
            initializeRuntimeConfig(async () =>
                new Response(JSON.stringify(config)),
            ),
        ).rejects.toThrow("does not match the runtime contract");
    });
});
