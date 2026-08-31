import { describe, expect, it, vi } from "vitest";
import { getRuntimeConfig, initializeRuntimeConfig } from "./runtimeConfig";

describe("runtime configuration", () => {
    it("uses the production HTML contract without a request", async () => {
        const meta = document.createElement("meta");
        meta.name = "beaver-runtime-config";
        meta.content = encodeURIComponent(JSON.stringify({
            mode: "local", capabilities: { connectors: false },
        }));
        document.head.append(meta);
        const request = vi.fn();

        await expect(initializeRuntimeConfig(request)).resolves.toEqual({
            mode: "local", capabilities: { connectors: false },
        });
        expect(request).not.toHaveBeenCalled();
        meta.remove();
    });

    it("loads the strict same-origin local contract", async () => {
        const request = vi.fn(async () =>
            new Response(JSON.stringify({
                mode: "local", capabilities: { connectors: false },
            })),
        );

        await expect(initializeRuntimeConfig(request)).resolves.toEqual({
            mode: "local", capabilities: { connectors: false },
        });
        expect(request).toHaveBeenCalledWith("/api/config", {
            cache: "no-store",
            headers: { Accept: "application/json" },
        });
        expect(getRuntimeConfig()).toEqual({
            mode: "local", capabilities: { connectors: false },
        });
    });

    it.each([
        { mode: "cloud", supabaseUrl: "not-a-url", supabasePublishableKey: "key" },
        { mode: "local", capabilities: { connectors: false }, unexpected: true },
        { mode: "anonymous" },
    ])("rejects invalid or extra configuration fields", async (config) => {
        await expect(
            initializeRuntimeConfig(async () =>
                new Response(JSON.stringify(config)),
            ),
        ).rejects.toThrow("does not match the runtime contract");
    });
});
