import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    getEnvironmentApiKeyStatus,
    hasEnvApiKey,
} from "../userApiKeys";
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
