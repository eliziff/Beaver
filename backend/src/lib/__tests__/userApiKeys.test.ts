import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    getEnvironmentApiKeyStatus,
    normalizeApiKeyProvider,
    hasEnvApiKey,
} from "../userApiKeys";

describe("normalizeApiKeyProvider", () => {
    it("returns each supported provider unchanged", () => {
        for (const provider of ["claude", "openai", "gemini", "deepseek"]) {
            expect(normalizeApiKeyProvider(provider)).toBe(provider);
        }
    });

    it("returns null for unknown provider strings", () => {
        expect(normalizeApiKeyProvider("unknown")).toBeNull();
        expect(normalizeApiKeyProvider("")).toBeNull();
        expect(normalizeApiKeyProvider("Claude")).toBeNull();
        expect(normalizeApiKeyProvider("OPENAI")).toBeNull();
    });
});

describe("hasEnvApiKey", () => {
    const envVars = [
        "ANTHROPIC_API_KEY",
        "CLAUDE_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_OCR_KEY",
        "OPENROUTER_API_KEY",
        "COURTLISTENER_API_TOKEN",
    ];

    // Clear before AND after each test so keys exported in the developer's
    // shell (or CI) can't leak into assertions.
    beforeEach(() => {
        for (const v of envVars) delete process.env[v];
    });

    afterEach(() => {
        for (const v of envVars) delete process.env[v];
    });

    it("returns true for claude when ANTHROPIC_API_KEY is set", () => {
        process.env.ANTHROPIC_API_KEY = "sk-ant-test";
        expect(hasEnvApiKey("claude")).toBe(true);
    });

    it("returns true for claude when CLAUDE_API_KEY is set as fallback", () => {
        process.env.CLAUDE_API_KEY = "sk-claude-test";
        expect(hasEnvApiKey("claude")).toBe(true);
    });

    it("returns true for openai when OPENAI_API_KEY is set", () => {
        process.env.OPENAI_API_KEY = "sk-openai-test";
        expect(hasEnvApiKey("openai")).toBe(true);
    });

    it("returns true for gemini when GEMINI_API_KEY is set", () => {
        process.env.GEMINI_API_KEY = "gemini-key-test";
        expect(hasEnvApiKey("gemini")).toBe(true);
    });

    it("uses the canonical DeepSeek key and the local compatibility fallback", () => {
        process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";
        expect(hasEnvApiKey("deepseek")).toBe(true);
        delete process.env.DEEPSEEK_API_KEY;
        process.env.DEEPSEEK_OCR_KEY = "sk-deepseek-local-test";
        expect(hasEnvApiKey("deepseek")).toBe(true);
    });

    it("returns false when no env key is set for the provider", () => {
        expect(hasEnvApiKey("claude")).toBe(false);
        expect(hasEnvApiKey("openai")).toBe(false);
        expect(hasEnvApiKey("gemini")).toBe(false);
        expect(hasEnvApiKey("deepseek")).toBe(false);
    });

    it("ignores whitespace-only env values", () => {
        process.env.ANTHROPIC_API_KEY = "   ";
        expect(hasEnvApiKey("claude")).toBe(false);
    });

    it("returns an environment-only status map without a database", () => {
        process.env.DEEPSEEK_API_KEY = "configured";
        expect(getEnvironmentApiKeyStatus()).toEqual({
            claude: false,
            gemini: false,
            openai: false,
            deepseek: true,
            openrouter: false,
            meta: false,
            courtlistener: false,
            sources: {
                claude: null,
                gemini: null,
                openai: null,
                deepseek: "env",
                openrouter: null,
                meta: null,
                courtlistener: null,
            },
        });
    });
});
