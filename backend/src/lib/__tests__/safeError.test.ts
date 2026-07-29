import { describe, expect, it } from "vitest";
import {
    redactSensitiveText,
    safeErrorLog,
    safeErrorMessage,
} from "../safeError";

describe("safe errors", () => {
    it("redacts labelled and provider-shaped secrets", () => {
        const inputs = {
            incorrectKey:
                "Incorrect API key provided: sk-proj-abc123def456ghi789.",
            incorrectKeyNoPeriod:
                "Incorrect API key provided: badkey123",
            apiUnderscore: "api_key: mysecret123",
            apiSpace: "api key = mysecret123",
            token: "token: abcdef123456",
            secret: "secret is abcdef123456",
            authorization: "authorization: abcdef123456",
            shortValue: "token: abc",
            openai: "request failed for sk-abc123def456ghi789 today",
            anthropic: "used sk-ant-api03-abc123def456",
            google: `key ${"AIza" + "Sy" + "A".repeat(24)} failed`,
            multiple:
                `first ${"sk-" + "a".repeat(24)} then ${"AIza" + "Sy" + "B".repeat(24)}`,
            ordinary: "Document not found",
        };

        expect(
            Object.fromEntries(
                Object.entries(inputs).map(([name, input]) => [
                    name,
                    redactSensitiveText(input),
                ]),
            ),
        ).toEqual({
            incorrectKey: "Incorrect API key provided: [redacted].",
            incorrectKeyNoPeriod: "Incorrect API key provided: [redacted]",
            apiUnderscore: "api_key: [redacted]",
            apiSpace: "api key = [redacted]",
            token: "token: [redacted]",
            secret: "secret is [redacted]",
            authorization: "authorization: [redacted]",
            shortValue: "token: abc",
            openai: "request failed for [redacted] today",
            anthropic: "used [redacted]",
            google: "key [redacted] failed",
            multiple: "first [redacted] then [redacted]",
            ordinary: "Document not found",
        });
    });

    it("turns thrown and unknown values into safe messages", () => {
        expect({
            error: safeErrorMessage(new Error("boom")),
            secret: safeErrorMessage(
                new Error("bad key sk-abc123def456ghi789"),
            ),
            string: safeErrorMessage("token: abcdef123456"),
            number: safeErrorMessage(42),
            nullValue: safeErrorMessage(null),
            object: safeErrorMessage({ message: "obj" }),
            emptyError: safeErrorMessage(new Error("")),
            fallback: safeErrorMessage(undefined, "Chat failed"),
        }).toEqual({
            error: "boom",
            secret: "bad key [redacted]",
            string: "token: [redacted]",
            number: "Unexpected error",
            nullValue: "Unexpected error",
            object: "Unexpected error",
            emptyError: "Unexpected error",
            fallback: "Chat failed",
        });
    });

    it("logs useful error metadata without leaking secrets", () => {
        const normal = safeErrorLog(new Error("boom"));
        const secretValue = "sk-abc123def456ghi789";
        const redacted = safeErrorLog(new Error(`bad key ${secretValue}`));
        const withoutStack = new Error("boom");
        withoutStack.stack = undefined;

        expect({
            normal: {
                name: normal.name,
                message: normal.message,
                stackContainsMessage: normal.stack?.includes("boom"),
            },
            redacted: {
                message: redacted.message,
                stackLeaksSecret: redacted.stack?.includes(secretValue),
            },
            empty: safeErrorLog(new Error("")).message,
            missingStack: safeErrorLog(withoutStack).stack,
            plain: safeErrorLog("plain failure"),
        }).toEqual({
            normal: {
                name: "Error",
                message: "boom",
                stackContainsMessage: true,
            },
            redacted: {
                message: "bad key [redacted]",
                stackLeaksSecret: false,
            },
            empty: "Unexpected error",
            missingStack: undefined,
            plain: { name: null, message: "plain failure" },
        });
    });
});
