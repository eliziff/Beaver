import { z } from "zod";

const capabilities = { capabilities: z.object({ connectors: z.boolean() }).strict() };
const runtimeConfigSchema = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("local"), ...capabilities }).strict(),
    z
        .object({
            mode: z.literal("cloud"),
            ...capabilities,
            supabaseUrl: z.url().max(2_048),
            supabasePublishableKey: z.string().min(1).max(4_096),
        })
        .strict(),
]);

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

const state = globalThis as typeof globalThis & {
    __beaverRuntimeConfig?: RuntimeConfig;
};

export function getRuntimeConfig(): RuntimeConfig {
    if (!state.__beaverRuntimeConfig) {
        throw new Error("Beaver runtime configuration is not initialized");
    }
    return state.__beaverRuntimeConfig;
}

export async function initializeRuntimeConfig(
    request: typeof fetch = fetch,
): Promise<RuntimeConfig> {
    const response = await request("/api/config", {
        cache: "no-store",
        headers: { Accept: "application/json" },
    });
    if (!response.ok) {
        throw new Error(`Could not load Beaver configuration (${response.status})`);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 16_384) {
        throw new Error("Beaver configuration response is too large");
    }
    const body = await response.text();
    if (body.length > 16_384) {
        throw new Error("Beaver configuration response is too large");
    }
    let json: unknown;
    try {
        json = JSON.parse(body);
    } catch {
        throw new Error("Beaver configuration is not valid JSON");
    }
    const parsed = runtimeConfigSchema.safeParse(json);
    if (!parsed.success) {
        throw new Error("Beaver configuration does not match the runtime contract");
    }
    state.__beaverRuntimeConfig = parsed.data;
    return parsed.data;
}
