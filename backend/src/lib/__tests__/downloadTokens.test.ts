import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    buildDownloadUrl,
    signDownload,
    verifyDownload,
} from "../downloadTokens";

const SECRET = "test-secret-32-bytes-long-enough!!";

beforeAll(() => {
    process.env.DOWNLOAD_SIGNING_SECRET = SECRET;
});

afterAll(() => {
    delete process.env.DOWNLOAD_SIGNING_SECRET;
});

describe("download tokens", () => {
    it("signs paths into URL-safe, verifiable tokens and URLs", () => {
        const path = "documents/user123/doc456/source.pdf";
        const filename = "Contract Final v2.pdf";
        const token = signDownload(path, filename);
        const parts = token.split(".");
        const url = buildDownloadUrl(path, filename);

        expect({
            parts: parts.length,
            payloadPresent: parts[0].length > 0,
            signaturePresent: parts[1].length > 0,
            urlSafe: !/[+/=]/u.test(token),
            pathSpecific:
                token !== signDownload("documents/other/file.pdf", "b.pdf"),
            verified: verifyDownload(token),
            urlPrefix: url.startsWith("/download/"),
            urlVerified: verifyDownload(url.replace("/download/", "")),
        }).toEqual({
            parts: 2,
            payloadPresent: true,
            signaturePresent: true,
            urlSafe: true,
            pathSpecific: true,
            verified: { path, filename },
            urlPrefix: true,
            urlVerified: { path, filename },
        });
    });

    it("rejects malformed, tampered, and differently signed tokens", () => {
        const token = signDownload(
            "documents/user/file.pdf",
            "file.pdf",
        );
        const [payload, signature] = token.split(".");
        const tamperedPayload = Buffer.from(
            JSON.stringify({
                p: "documents/attacker/file.pdf",
                f: "file.pdf",
            }),
        )
            .toString("base64")
            .replace(/\+/gu, "-")
            .replace(/\//gu, "_")
            .replace(/=+$/gu, "");
        const fakeSignature =
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

        let wrongSecret;
        try {
            process.env.DOWNLOAD_SIGNING_SECRET =
                "different-secret-value-!!";
            wrongSecret = verifyDownload(token);
        } finally {
            process.env.DOWNLOAD_SIGNING_SECRET = SECRET;
        }

        expect({
            tooManyParts: verifyDownload("a.b.c"),
            tooFewParts: verifyDownload("onlyonepart"),
            tamperedPayload: verifyDownload(
                `${tamperedPayload}.${signature}`,
            ),
            tamperedSignature: verifyDownload(
                `${payload}.${fakeSignature}`,
            ),
            wrongSecret,
        }).toEqual({
            tooManyParts: null,
            tooFewParts: null,
            tamperedPayload: null,
            tamperedSignature: null,
            wrongSecret: null,
        });
    });
});
