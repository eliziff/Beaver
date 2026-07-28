import { describe, expect, it } from "vitest";
import {
    buildContentDisposition,
    encodeRFC5987,
    generatedDocKey,
    normalizeDownloadFilename,
    pdfStorageKey,
    sanitizeDispositionFilename,
    storageKey,
    versionStorageKey,
} from "../storage";

describe("storage helpers", () => {
    it("normalizes and encodes untrusted filenames", () => {
        expect([
            normalizeDownloadFilename("  file.pdf  "),
            normalizeDownloadFilename(""),
            normalizeDownloadFilename("   "),
            normalizeDownloadFilename("file\x00name.pdf"),
            normalizeDownloadFilename("file\x1fname.pdf"),
            normalizeDownloadFilename("dir/file.pdf"),
            normalizeDownloadFilename("dir\\file.pdf"),
            normalizeDownloadFilename("Contract v2 (Final).pdf"),
            sanitizeDispositionFilename('file"name.pdf'),
            sanitizeDispositionFilename("file\\name.pdf"),
            sanitizeDispositionFilename("filéname.pdf"),
            sanitizeDispositionFilename("  "),
            encodeRFC5987("hello world"),
            encodeRFC5987("it's"),
            encodeRFC5987("a(b)c"),
            encodeRFC5987("a*b"),
            encodeRFC5987("file.pdf"),
        ]).toEqual([
            "file.pdf",
            "download",
            "download",
            "file_name.pdf",
            "file_name.pdf",
            "dir_file.pdf",
            "dir_file.pdf",
            "Contract v2 (Final).pdf",
            "file_name.pdf",
            "file_name.pdf",
            "fil_name.pdf",
            "download",
            "hello%20world",
            "it%27s",
            "a%28b%29c",
            "a%2Ab",
            "file.pdf",
        ]);

        const attachment = buildContentDisposition(
            "attachment",
            "contract.pdf",
        );
        const unicode = buildContentDisposition(
            "attachment",
            "Ünïcödé.pdf",
        );
        expect([
            attachment.startsWith("attachment;"),
            attachment.includes('filename="contract.pdf"'),
            attachment.includes("filename*=UTF-8''contract.pdf"),
            buildContentDisposition("inline", "preview.pdf").startsWith(
                "inline;",
            ),
            unicode.includes("filename*=UTF-8''"),
            !unicode.includes("Ü"),
        ]).toEqual([true, true, true, true, true, true]);
    });

    it("builds deterministic user, document, and version paths", () => {
        expect([
            storageKey("user1", "doc1", "contract.pdf"),
            storageKey("user1", "doc1", "file.toolongextension1234"),
            storageKey("user1", "doc1", "noextension"),
            pdfStorageKey("user1", "doc1", "contract"),
            generatedDocKey("user1", "doc1", "output.docx"),
            generatedDocKey(
                "user1",
                "doc1",
                "output.toolongextension1234",
            ),
            versionStorageKey("user1", "doc1", "v2", "contract.pdf"),
            versionStorageKey("user1", "doc1", "v2", "file"),
        ]).toEqual([
            "documents/user1/doc1/source.pdf",
            "documents/user1/doc1/source.bin",
            "documents/user1/doc1/source.bin",
            "documents/user1/doc1/contract.pdf",
            "generated/user1/doc1/generated.docx",
            "generated/user1/doc1/generated.docx",
            "documents/user1/doc1/versions/v2.pdf",
            "documents/user1/doc1/versions/v2.bin",
        ]);
    });
});
