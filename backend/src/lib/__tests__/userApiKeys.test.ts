import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    createUserCredentials,
    getEnvironmentApiKeyStatus,
    hasEnvApiKey,
} from "../userApiKeys";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { LocalDatabase } from "../localDatabase";
import { sql } from "../relational";

it("keeps encrypted personal keys isolated, overrides the server and restores it on removal", async () => {
    vi.stubEnv("OPENAI_API_KEY", "shared");
    vi.stubEnv("USER_API_KEYS_ENCRYPTION_SECRET", "test-secret-".repeat(6));
    const native = new DatabaseSync(":memory:");
    native.exec(/-- BEAVER_CORE_BEGIN\s*([\s\S]*?)\s*-- BEAVER_CORE_END/u
        .exec(readFileSync("schema.sql", "utf8"))![1]);
    const database = new LocalDatabase(native), credentials = createUserCredentials(database);
    try {
        await credentials.save!("alice", "openai", "private-value");
        expect((await credentials.keys("alice")).openai).toBe("private-value");
        expect((await credentials.keys("bob")).openai).toBe("shared");
        expect((await credentials.status("alice")).sources.openai).toBe("user");
        const rows = await database.query(sql`SELECT * FROM user_api_keys`);
        expect(JSON.stringify(rows)).not.toContain("private-value");
        // Authentication binds ciphertext to both its owner and provider.
        await database.query(sql`UPDATE user_api_keys SET user_id=${"bob"}`);
        await expect(credentials.keys("bob")).rejects.toThrow("could not be read");
        await credentials.save!("bob", "openai", null);
        expect((await credentials.keys("bob")).openai).toBe("shared");
        expect((await credentials.status("bob")).sources.openai).toBe("env");
    } finally {
        await database.close();
        vi.unstubAllEnvs();
    }
});
describe("hasEnvApiKey", () => {
    const envVars = [
        "ANTHROPIC_API_KEY",
        "CLAUDE_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "META_API_KEY",
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_OCR_KEY",
        "OPENROUTER_API_KEY",
        "OPENCODE_GO_API_KEY",
        "COURTLISTENER_API_TOKEN",
    ];

    beforeEach(() => {
        for (const key of envVars) vi.stubEnv(key, undefined);
    });
    afterEach(() => vi.unstubAllEnvs());

    it("returns true for claude when ANTHROPIC_API_KEY is set", () => {
        vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
        expect(hasEnvApiKey("claude")).toBe(true);
    });

    it("ignores noncanonical Claude environment aliases", () => {
        vi.stubEnv("CLAUDE_API_KEY", "sk-claude-test");
        expect(hasEnvApiKey("claude")).toBe(false);
    });

    it("uses only the canonical DeepSeek key", () => {
        vi.stubEnv("DEEPSEEK_API_KEY", "sk-deepseek-test");
        expect(hasEnvApiKey("deepseek")).toBe(true);
        vi.stubEnv("DEEPSEEK_API_KEY", undefined);
        vi.stubEnv("DEEPSEEK_OCR_KEY", "sk-deepseek-local-test");
        expect(hasEnvApiKey("deepseek")).toBe(false);
    });

    it("ignores whitespace-only env values", () => {
        vi.stubEnv("ANTHROPIC_API_KEY", "   ");
        expect(hasEnvApiKey("claude")).toBe(false);
    });

    it("returns an environment-only status map without a database", () => {
        vi.stubEnv("DEEPSEEK_API_KEY", "configured");
        expect(getEnvironmentApiKeyStatus()).toEqual({
            claude: false,
            gemini: false,
            openai: false,
            deepseek: true,
            openrouter: false,
            "opencode-go": false,
            meta: false,
            courtlistener: false,
            sources: {
                claude: null,
                gemini: null,
                openai: null,
                deepseek: "env",
                openrouter: null,
                "opencode-go": null,
                meta: null,
                courtlistener: null,
            },
        });
    });
});
