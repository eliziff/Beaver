import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeOpenCodeGoCatalog, openCodeGoConnection } from "../openCodeGo";

describe("OpenCode Go catalog", () => {
    it("exposes every published slug, including newly released models", () => {
        const models = normalizeOpenCodeGoCatalog({ data: [
            { id: "deepseek-v4.1-flash", object: "model", created: 1, owned_by: "opencode" },
            { id: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
            { id: "glm-5.3", name: "GLM-5.3" },
        ] });
        expect(models).toHaveLength(3);
        expect(Object.fromEntries(models.map((model) => [model.id, model.displayName]))).toEqual({
            "deepseek-v4.1-flash": "deepseek-v4.1-flash",
            "deepseek-flash": "DeepSeek V4.1 Flash",
            "glm-5.3": "GLM-5.3",
        });
    });

    it.each([
        undefined, null, {}, { data: "nope" },
        { data: [{}, null, 7, { id: "" }, { id: " " }, { id: "vendor/model" }] },
    ])("ignores malformed or namespaced entries: %j", (value) => {
        expect(normalizeOpenCodeGoCatalog(value)).toEqual([]);
    });
});

afterEach(() => vi.unstubAllEnvs());
it("rereads CLI sign-in and rotated credentials without restarting, with explicit overrides first", () => {
    const directory = mkdtempSync(join(tmpdir(), "beaver-go-auth-")), auth = join(directory, "auth.json");
    vi.stubEnv("OPENCODE_AUTH_PATH", auth); vi.stubEnv("OPENCODE_GO_API_KEY", "");
    const params = { model: "opencode-go:deepseek-v4.1-flash", systemPrompt: "", messages: [], promptCacheKey: "same-chat" };
    try {
        expect(() => openCodeGoConnection(params)).toThrow(/not configured/u);
        for (const key of ["first-test-key", "rotated-test-key"]) {
            writeFileSync(auth, JSON.stringify({ "opencode-go": { type: "api", key } }));
            expect(openCodeGoConnection(params)).toMatchObject({ apiKey: key, protocol: "chat",
                model: "deepseek-v4.1-flash", headers: { "User-Agent": "beaver/1.0", "x-opencode-session": "same-chat" } });
        }
        vi.stubEnv("OPENCODE_GO_API_KEY", "environment-test-key");
        expect(openCodeGoConnection(params).apiKey).toBe("environment-test-key");
        expect(openCodeGoConnection({ ...params, apiKeys: { "opencode-go": "user-test-key" } }).apiKey).toBe("user-test-key");
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
