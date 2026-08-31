export type RuntimeConfig = {
    mode: "local" | "cloud";
    capabilities: { connectors: boolean };
};

function parseRuntimeConfig(value: unknown): RuntimeConfig | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const config = value as Record<string, unknown>;
    const capabilities = config.capabilities;
    if (
        Object.keys(config).length !== 2 ||
        !["local", "cloud"].includes(String(config.mode)) ||
        !capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)
    ) return null;
    const flags = capabilities as Record<string, unknown>;
    if (Object.keys(flags).length !== 1 || typeof flags.connectors !== "boolean") return null;
    return {
        mode: config.mode as RuntimeConfig["mode"],
        capabilities: { connectors: flags.connectors },
    };
}

const state = globalThis as typeof globalThis & {
    __beaverRuntimeConfig?: RuntimeConfig;
};

const EMBEDDED_CONFIG = "__BEAVER_RUNTIME_CONFIG__";

function accept(body: string): RuntimeConfig {
    if (body.length > 16_384) {
        throw new Error("Beaver configuration response is too large");
    }
    let json: unknown;
    try {
        json = JSON.parse(body);
    } catch {
        throw new Error("Beaver configuration is not valid JSON");
    }
    const parsed = parseRuntimeConfig(json);
    if (!parsed) {
        throw new Error("Beaver configuration does not match the runtime contract");
    }
    state.__beaverRuntimeConfig = parsed;
    return parsed;
}

export function getRuntimeConfig(): RuntimeConfig {
    if (!state.__beaverRuntimeConfig) {
        throw new Error("Beaver runtime configuration is not initialized");
    }
    return state.__beaverRuntimeConfig;
}

export async function initializeRuntimeConfig(
    request: typeof fetch = fetch,
): Promise<RuntimeConfig> {
    const embedded = typeof document === "undefined" ? null
        : document.querySelector<HTMLMetaElement>('meta[name="beaver-runtime-config"]')?.content;
    if (embedded && embedded !== EMBEDDED_CONFIG) {
        try {
            return accept(decodeURIComponent(embedded));
        } catch (error) {
            if (error instanceof URIError) {
                throw new Error("Beaver configuration is not valid JSON", { cause: error });
            }
            throw error;
        }
    }
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
    return accept(await response.text());
}
